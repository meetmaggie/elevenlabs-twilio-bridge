// server.js (CommonJS) — Twilio <-> ElevenLabs ConvAI bridge with ulaw_8000 pass-through
// If EL reports ulaw_8000 in metadata, we forward audio without transcoding.
// Otherwise we convert μ-law<->PCM16 and up/downsample as needed.
//
// Env (Railway -> Variables):
//   ELEVENLABS_API_KEY
//   ELEVENLABS_DISCOVERY_AGENT_ID  (optional fallback)
//   ELEVENLABS_DAILY_AGENT_ID      (optional fallback)
//   NODE_ENV=production (recommended)
//   BRIDGE_AUTH_TOKEN (optional)

const http = require('http');
const url = require('url');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 8080;
const BRIDGE_AUTH_TOKEN = process.env.BRIDGE_AUTH_TOKEN || null;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || null;
const DISCOVERY_ID = process.env.ELEVENLABS_DISCOVERY_AGENT_ID || null;
const DAILY_ID = process.env.ELEVENLABS_DAILY_AGENT_ID || null;

// ---------- HTTP ----------
const server = http.createServer((req, res) => {
  if (req.url === '/health') return res.writeHead(200, {'Content-Type':'text/plain'}).end('ok');
  if (req.url === '/' || req.url === '/status') return res.writeHead(200, {'Content-Type':'text/plain'}).end('voice-bridge: up');
  res.writeHead(404, {'Content-Type':'text/plain'}).end('not found');
});

// ---------- WS server ----------
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const { pathname, query } = url.parse(req.url, true);
  console.log('[UPGRADE] incoming', {
    url: req.url, pathname, hasToken: !!(query && query.token),
    ua: req.headers['user-agent'], xff: req.headers['x-forwarded-for'] || null
  });

  if (pathname !== '/ws' && pathname !== '/media-stream') {
    console.warn('[UPGRADE] rejecting — bad path', pathname);
    try { socket.destroy(); } catch {}
    return;
  }
  if (BRIDGE_AUTH_TOKEN && (!query || query.token !== BRIDGE_AUTH_TOKEN)) {
    console.warn('[UPGRADE] rejected — bad/missing token');
    try { socket.destroy(); } catch {}
    return;
  }

  req.__query = query || {};
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (twilioWs, req) => {
  console.log('[WS] CONNECTED via upgrade', req.url);
  const q = req.__query || {};
  console.log('[WS] query (debug)', {
    agentIdQ: q.agent_id || q.agent || null, modeQ: q.mode || null,
    phoneQ: q.phone || null, persistQ: q.persist || null
  });

  attachBridgeHandlers(twilioWs);

  twilioWs.on('error', e => console.error('[WS] Twilio socket error:', e?.message || e));
  twilioWs.on('close', (code, reasonBuf) => {
    const reason = reasonBuf ? reasonBuf.toString() : undefined;
    console.log('[WS] Twilio socket closed', { code, reason });
  });
  twilioWs.on('ping', data => { try { twilioWs.pong(data); } catch {} });
});

setInterval(() => console.log('[HEARTBEAT] alive', new Date().toISOString()), 60_000);
process.on('SIGTERM', () => { console.log('[LIFECYCLE] SIGTERM received — shutting down gracefully'); try { server.close(() => process.exit(0)); } catch { process.exit(0); }});
server.listen(PORT, () => console.log(`[HTTP] listening on :${PORT}`));

// ===================== BRIDGE CORE =====================

function attachBridgeHandlers(twilioWs) {
  let sawFirstMedia = false;
  let mediaFrames = 0;

  // Populated at start
  let agentId = null, mode = 'discovery', phone = null, persist = '0';

  // ElevenLabs WS + formats from metadata
  let elWs = null;
  let elReady = false;
  let elInFormat = null;   // what EL expects from us (e.g., 'ulaw_8000' or 'pcm_16000')
  let elOutFormat = null;  // what EL will send back

  // Buffer caller chunks until EL says it's ready
  const pendingCallerChunks = [];

  twilioWs.on('message', (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
    const event = msg?.event;

    if (event === 'connected') {
      console.log('[TWILIO] event connected');
      return;
    }

    if (event === 'start') {
      const start = msg.start || {};
      const cp = start.customParameters || {};
      agentId = cp.agent_id || (((cp.mode || 'discovery').toLowerCase() === 'daily') ? DAILY_ID : DISCOVERY_ID);
      mode    = (cp.mode || mode || 'discovery').toLowerCase();
      phone   = cp.caller_phone || phone;
      persist = cp.persist === '1' ? '1' : '0';

      console.log('[TWILIO] start', {
        streamSid: msg.streamSid,
        tracks: start.tracks,
        mediaFormat: start.mediaFormat, // audio/x-mulaw, 8000, 1
        customParameters: { agentId, mode, phone, persist }
      });

      if (!ELEVENLABS_API_KEY) {
        console.error('❌ Missing ELEVENLABS_API_KEY');
        return;
      }
      if (!agentId) {
        console.error('❌ Missing agentId (no <Parameter/> and no env fallback)');
        return;
      }

      elWs = connectToElevenLabs({
        agentId, mode, phone,
        onMetadata: ({ user_input_audio_format, agent_output_audio_format }) => {
          elInFormat = user_input_audio_format;
          elOutFormat = agent_output_audio_format;
          console.log('[EL] formats', { elInFormat, elOutFormat });
          elReady = true;
          // flush any buffered caller chunks (already in the correct format)
          if (pendingCallerChunks.length) {
            console.log(`[EL] flushing ${pendingCallerChunks.length} buffered chunks`);
            for (const chunk of pendingCallerChunks) {
              // chunk is already ulaw or pcm16 depending on our branch below
              try { elWs.send(JSON.stringify({ user_audio_chunk: chunk })); } catch {}
            }
            pendingCallerChunks.length = 0;
          }
        },
        onAudioFromEL: (audioB64 /* EL output format per elOutFormat */) => {
          try {
            if (elOutFormat === 'ulaw_8000') {
              // Direct pass-through to Twilio
              twilioWs.send(JSON.stringify({ event: 'media', media: { payload: audioB64 }}));
            } else {
              // Assume PCM16 @ 16k; convert to μ-law@8k for Twilio
              const pcm16_16k = Buffer.from(audioB64, 'base64');
              const pcm16_8k  = downsamplePcm16Mono16kTo8k(pcm16_16k);
              const muLawBuf  = pcm16ToMuLaw(pcm16_8k);
              const muLawB64  = muLawBuf.toString('base64');
              twilioWs.send(JSON.stringify({ event: 'media', media: { payload: muLawB64 }}));
            }
          } catch (e) {
            console.error('[PIPE OUT] error sending EL audio to Twilio', e?.message || e);
          }
        },
        onClose: () => { elReady = false; }
      });

      return;
    }

    if (event === 'media') {
      mediaFrames += 1;
      if (!sawFirstMedia) { sawFirstMedia = true; console.log('[TWILIO] first media frame received'); }

      const muLawB64 = msg?.media?.payload;
      if (!muLawB64) return;

      // Decide how to send to EL based on metadata
      if (elWs && elWs.readyState === WebSocket.OPEN) {
        if (elReady) {
          if (elInFormat === 'ulaw_8000') {
            // Direct pass-through (best)
            elWs.send(JSON.stringify({ user_audio_chunk: muLawB64 }));
          } else {
            // Convert μ-law@8k -> PCM16@16k for EL
            const muLawBuf  = Buffer.from(muLawB64, 'base64');
            const pcm16_8k  = muLawToPcm16(muLawBuf);
            const pcm16_16k = upsamplePcm16Mono8kTo16k(pcm16_8k);
            const pcm16_16k_B64 = Buffer
              .from(pcm16_16k.buffer, pcm16_16k.byteOffset, pcm16_16k.byteLength)
              .toString('base64');
            elWs.send(JSON.stringify({ user_audio_chunk: pcm16_16k_B64 }));
          }
        } else {
          // Buffer until metadata arrives
          pendingCallerChunks.push(muLawB64);
        }
      }
      return;
    }

    if (event === 'stop') {
      console.log('[TWILIO] stop', { totalMediaFrames: mediaFrames });
      try { twilioWs.close(1000, 'normal'); } catch {}
      try { elWs && elWs.close(1000); } catch {}
      return;
    }

    if (event === 'mark' || event === 'clear' || event === ' clear') {
      console.log('[TWILIO]', event);
      return;
    }

    console.log('[TWILIO] event', event || '(unknown)');
  });
}

// ===================== ElevenLabs ConvAI =====================

function connectToElevenLabs({ agentId, mode, phone, onMetadata, onAudioFromEL, onClose }) {
  const elUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${encodeURIComponent(agentId)}`;
  const headers = { 'xi-api-key': ELEVENLABS_API_KEY };

  console.log('[EL] connecting', { elUrl: `...conversation?agent_id=${agentId}` });

  const elWs = new WebSocket(elUrl, { headers });

  elWs.on('open', () => {
    console.log('[EL] connected');
    // Optional: seed conversation
    // elWs.send(JSON.stringify({ type: 'conversation_initiation_client_data', conversation_config_override: { agent: { language: 'en' }}}));
  });

  elWs.on('message', (data) => {
    let obj; try { obj = JSON.parse(data.toString()); } catch { obj = null; }

    // Formats arrive in the metadata event
    if (obj && obj.type === 'conversation_initiation_metadata') {
      const meta = obj.conversation_initiation_metadata_event || {};
      console.log('[EL] metadata', meta);
      try { onMetadata && onMetadata({
        user_input_audio_format: meta.user_input_audio_format,
        agent_output_audio_format: meta.agent_output_audio_format
      }); } catch {}
      return;
    }

    // Agent audio
    if (obj && obj.type === 'audio' && obj.audio_event && obj.audio_event.audio_base_64) {
      try { onAudioFromEL && onAudioFromEL(obj.audio_event.audio_base_64); } catch {}
      return;
    }

    // Nice-to-have logs
    if (obj && obj.type === 'user_transcript') {
      console.log('[EL] user_transcript:', obj.user_transcription_event?.user_transcript);
      return;
    }
    if (obj && obj.type === 'agent_response') {
      console.log('[EL] agent_response:', obj.agent_response_event?.agent_response);
      return;
    }
    if (obj && obj.type === 'ping') {
      // Optionally reply
      try { elWs.send(JSON.stringify({ type: 'pong', event_id: obj.ping_event?.event_id })); } catch {}
      return;
    }
  });

  elWs.on('close', (code, reason) => { console.log('[EL] closed', { code, reason: reason?.toString() }); try { onClose && onClose(); } catch {} });
  elWs.on('error', (err) => { console.error('[EL] error', err?.message || err); });

  return elWs;
}

// ===================== Audio helpers (μ-law / PCM16) =====================

// μ-law (G.711) decode -> PCM16 Int16Array
function muLawToPcm16(muBuf) {
  const out = new Int16Array(muBuf.length);
  for (let i = 0; i < muBuf.length; i++) {
    const u = muBuf[i];
    let x = ~u;
    const sign = (x & 0x80) ? -1 : 1;
    const exponent = (x >> 4) & 0x07;
    const mantissa = x & 0x0F;
    const magnitude = ((mantissa << 1) + 1) << (exponent + 2);
    out[i] = sign * (magnitude - 132);
  }
  return out;
}

// PCM16 Int16Array -> μ-law Buffer
function pcm16ToMuLaw(pcm) {
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    let sample = pcm[i];
    let sign = (sample < 0) ? 0x80 : 0x00;
    if (sample < 0) sample = -sample;
    if (sample > 32635) sample = 32635;
    sample += 132;
    let exponent = 7;
    for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) exponent--;
    const mantissa = (sample >> (exponent + 3)) & 0x0F;
    const ulaw = ~(sign | (exponent << 4) | mantissa);
    out[i] = ulaw & 0xFF;
  }
  return out;
}

// 8k -> 16k naive upsample (duplicate samples)
function upsamplePcm16Mono8kTo16k(pcm8k) {
  const out = new Int16Array(pcm8k.length * 2);
  for (let i = 0, j = 0; i < pcm8k.length; i++, j += 2) {
    const s = pcm8k[i]; out[j] = s; out[j + 1] = s;
  }
  return out;
}

// 16k -> 8k naive downsample (drop every other sample)
function downsamplePcm16Mono16kTo8k(pcm16kBuf) {
  const in16 = new Int16Array(pcm16kBuf.buffer, pcm16kBuf.byteOffset, Math.floor(pcm16kBuf.byteLength / 2));
  const out = new Int16Array(Math.floor(in16.length / 2));
  for (let i = 0, j = 0; j < out.length; i += 2, j++) out[j] = in16[i];
  return out;
}
