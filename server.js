// server.js — Twilio <-> ElevenLabs ConvAI bridge with proper 20ms outbound chunking
// Env (Railway):
//   ELEVENLABS_API_KEY, ELEVENLABS_DISCOVERY_AGENT_ID (opt), ELEVENLABS_DAILY_AGENT_ID (opt)
//   NODE_ENV=production, (opt) EL_WELCOME, (opt) BRIDGE_AUTH_TOKEN

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
  console.log('[UPGRADE] incoming', { url: req.url, pathname, hasToken: !!(query && query.token), ua: req.headers['user-agent'], xff: req.headers['x-forwarded-for'] || null });

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
  console.log('[WS] query (debug)', { agentIdQ: q.agent_id || q.agent || null, modeQ: q.mode || null, phoneQ: q.phone || null, persistQ: q.persist || null });

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

  // Populated at 'start'
  let agentId = null, mode = 'discovery', phone = null, persist = '0';
  let twilioStreamSid = null;

  // ElevenLabs state
  let elWs = null;
  let elReady = false;
  let elInFormat = null;   // 'ulaw_8000' | 'pcm_16000' | etc.
  let elOutFormat = null;

  // Outbound sequencing to Twilio
  let outboundSeq = 0;
  let outboundChunk = 0;
  let outboundTimestampMs = 0; // increase by 20 per frame

  const pendingCallerChunks = []; // μ-law base64 buffered until metadata

  twilioWs.on('message', (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
    const event = msg?.event;

    if (event === 'connected') { console.log('[TWILIO] event connected'); return; }

    if (event === 'start') {
      const start = msg.start || {};
      twilioStreamSid = msg.streamSid || start.streamSid || null;

      const cp = start.customParameters || {};
      agentId = cp.agent_id || (((cp.mode || 'discovery').toLowerCase() === 'daily') ? DAILY_ID : DISCOVERY_ID);
      mode    = (cp.mode || mode || 'discovery').toLowerCase();
      phone   = cp.caller_phone || phone;
      persist = cp.persist === '1' ? '1' : '0';

      console.log('[TWILIO] start', {
        streamSid: twilioStreamSid,
        tracks: start.tracks,
        mediaFormat: start.mediaFormat, // audio/x-mulaw, 8000, 1
        customParameters: { agentId, mode, phone, persist }
      });

      if (!ELEVENLABS_API_KEY) { console.error('❌ Missing ELEVENLABS_API_KEY'); return; }
      if (!agentId) { console.error('❌ Missing agentId (no <Parameter/> and no env fallback)'); return; }

      elWs = connectToElevenLabs({
        agentId, mode, phone,
        onMetadata: ({ user_input_audio_format, agent_output_audio_format }) => {
          elInFormat  = user_input_audio_format;
          elOutFormat = agent_output_audio_format;
          console.log('[EL] formats', { elInFormat, elOutFormat });
          elReady = true;

          // Reset outbound sequencing per new conversation
          outboundSeq = 0;
          outboundChunk = 0;
          outboundTimestampMs = 0;

          if (pendingCallerChunks.length) {
            console.log(`[EL] flushing ${pendingCallerChunks.length} buffered chunks`);
            for (const b64 of pendingCallerChunks) {
              try {
                if (elInFormat === 'ulaw_8000') {
                  elWs.send(JSON.stringify({ user_audio_chunk: b64 }));
                } else {
                  const muLawBuf  = Buffer.from(b64, 'base64');
                  const pcm16_8k  = muLawToPcm16(muLawBuf);
                  const pcm16_16k = upsamplePcm16Mono8kTo16k(pcm16_8k);
                  const b64_16k   = Buffer.from(pcm16_16k.buffer, pcm16_16k.byteOffset, pcm16_16k.byteLength).toString('base64');
                  elWs.send(JSON.stringify({ user_audio_chunk: b64_16k }));
                }
              } catch {}
            }
            pendingCallerChunks.length = 0;
          }
        },
        onAudioFromEL: (audioB64) => {
          try {
            if (elOutFormat === 'ulaw_8000') {
              // CHUNK μ-law bytes into 20ms frames (160 bytes per frame @8kHz)
              const u = Buffer.from(audioB64, 'base64');
              const FRAME = 160;
              for (let off = 0; off < u.length; off += FRAME) {
                const slice = u.subarray(off, Math.min(off + FRAME, u.length));
                const payloadB64 = slice.toString('base64');
                sendOutboundMediaFrame(twilioWs, twilioStreamSid, payloadB64, ++outboundSeq, ++outboundChunk, outboundTimestampMs);
                outboundTimestampMs += 20;
              }
            } else {
              // Convert PCM16@16k from EL -> μ-law@8k, then chunk to 20ms frames
              const pcm16_16k = Buffer.from(audioB64, 'base64');
              const pcm16_8k  = downsamplePcm16Mono16kTo8k(pcm16_16k);
              const muLawBuf  = pcm16ToMuLaw(pcm16_8k);
              const FRAME = 160;
              for (let off = 0; off < muLawBuf.length; off += FRAME) {
                const slice = muLawBuf.subarray(off, Math.min(off + FRAME, muLawBuf.length));
                const payloadB64 = slice.toString('base64');
                sendOutboundMediaFrame(twilioWs, twilioStreamSid, payloadB64, ++outboundSeq, ++outboundChunk, outboundTimestampMs);
                outboundTimestampMs += 20;
              }
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

      if (elWs && elWs.readyState === WebSocket.OPEN) {
        if (elReady) {
          if (elInFormat === 'ulaw_8000') {
            elWs.send(JSON.stringify({ user_audio_chunk: muLawB64 }));
          } else {
            const muLawBuf  = Buffer.from(muLawB64, 'base64');
            const pcm16_8k  = muLawToPcm16(muLawBuf);
            const pcm16_16k = upsamplePcm16Mono8kTo16k(pcm16_8k);
            const b64_16k   = Buffer.from(pcm16_16k.buffer, pcm16_16k.byteOffset, pcm16_16k.byteLength).toString('base64');
            elWs.send(JSON.stringify({ user_audio_chunk: b64_16k }));
          }
        } else {
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

    console.log('[TWILIO] event', event || '(unknown)');
  });
}

// Send one outbound media frame to Twilio (20ms, μ-law base64)
function sendOutboundMediaFrame(twilioWs, streamSid, payloadB64, seq, chunk, tsMs) {
  const msg = {
    event: 'media',
    streamSid: streamSid || undefined,
    sequenceNumber: String(seq),
    media: {
      track: 'outbound',
      chunk: String(chunk),
      timestamp: String(tsMs),
      payload: payloadB64
    }
  };
  twilioWs.send(JSON.stringify(msg));
  // Optional: request an acknowledgement mark
  twilioWs.send(JSON.stringify({
    event: 'mark',
    streamSid: streamSid || undefined,
    mark: { name: `el-chunk-${chunk}` }
  }));
}

// ===================== ElevenLabs ConvAI (robust connect) =====================

function connectToElevenLabs({ agentId, mode, phone, onMetadata, onAudioFromEL, onClose }) {
  const welcome = process.env.EL_WELCOME || "Hi there! I'm your assistant. How can I help today?";

  const endpoints = [
    `wss://api.elevenlabs.io/v1/convai/ws?agent_id=${encodeURIComponent(agentId)}`,
    `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${encodeURIComponent(agentId)}`
  ];

  let elWs = null;
  let connected = false;
  let metaTimer = null;
  let connectTimer = null;
  let which = 0;

  const headers = { 'xi-api-key': ELEVENLABS_API_KEY };

  function tryConnect() {
    const endpoint = endpoints[which];
    console.log('[EL] connecting', { endpoint: endpoint.replace(/^wss:\/\/api\.elevenlabs\.io/, '...') });

    elWs = new WebSocket(endpoint, { headers });

    connectTimer = setTimeout(() => {
      if (!connected) {
        console.error('[EL] connect timeout — switching endpoint');
        try { elWs.terminate(); } catch {}
      }
    }, 4000);

    elWs.on('open', () => {
      connected = true;
      clearTimeout(connectTimer);
      console.log('[EL] connected (endpoint', which === 0 ? 'ws' : 'conversation', ')');

      // Send greeting/init on open
      const init = {
        type: "conversation_initiation_client_data",
        conversation_config_override: {
          agent: { first_message: welcome, language: "en" }
        },
        dynamic_variables: { caller_phone: phone || "" }
      };
      try { elWs.send(JSON.stringify(init)); console.log('[EL] sent conversation_initiation_client_data'); }
      catch (e) { console.error('[EL] failed to send initiation data', e?.message || e); }

      // If no metadata within 2s, nudge & log
      metaTimer = setTimeout(() => {
        console.warn('[EL] metadata timeout — sending nudge user_message');
        try { elWs.send(JSON.stringify({ type: "user_message", text: "Hello" })); } catch {}
      }, 2000);
    });

    elWs.on('message', (data) => {
      let obj; try { obj = JSON.parse(data.toString()); } catch { obj = null; }

      if (obj && obj.type === 'conversation_initiation_metadata') {
        clearTimeout(metaTimer);
        const meta = obj.conversation_initiation_metadata_event || {};
        console.log('[EL] metadata', meta);
        try {
          onMetadata && onMetadata({
            user_input_audio_format: meta.user_input_audio_format,
            agent_output_audio_format: meta.agent_output_audio_format
          });
        } catch {}
        return;
      }

      if (obj && obj.type === 'audio' && obj.audio_event && obj.audio_event.audio_base_64) {
        try { onAudioFromEL && onAudioFromEL(obj.audio_event.audio_base_64); } catch {}
        return;
      }

      if (obj && obj.type === 'user_transcript') { console.log('[EL] user_transcript:', obj.user_transcription_event?.user_transcript); return; }
      if (obj && obj.type === 'agent_response') { console.log('[EL] agent_response:', obj.agent_response_event?.agent_response); return; }
      if (obj && obj.type === 'ping') { try { elWs.send(JSON.stringify({ type: 'pong', event_id: obj.ping_event?.event_id })); } catch {} return; }
    });

    elWs.on('close', (code, reason) => {
      clearTimeout(connectTimer); clearTimeout(metaTimer);
      console.log('[EL] closed', { code, reason: reason?.toString() });
      if (!connected && which === 0) { which = 1; setTimeout(tryConnect, 250); return; }
      try { onClose && onClose(); } catch {}
    });

    elWs.on('error', (err) => {
      console.error('[EL] error', err?.message || err);
      // close handler will decide fallback
    });
  }

  tryConnect();
  return elWs;
}

// ===================== Audio helpers (μ-law / PCM16) =====================

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

function upsamplePcm16Mono8kTo16k(pcm8k) {
  const out = new Int16Array(pcm8k.length * 2);
  for (let i = 0, j = 0; i < pcm8k.length; i++, j += 2) { const s = pcm8k[i]; out[j] = s; out[j + 1] = s; }
  return out;
}

function downsamplePcm16Mono16kTo8k(pcm16kBuf) {
  const in16 = new Int16Array(pcm16kBuf.buffer, pcm16kBuf.byteOffset, Math.floor(pcm16kBuf.byteLength / 2));
  const out = new Int16Array(Math.floor(in16.length / 2));
  for (let i = 0, j = 0; j < out.length; i += 2, j++) out[j] = in16[i];
  return out;
}
