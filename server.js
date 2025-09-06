// server.js (CommonJS) — Twilio <-> ElevenLabs ConvAI full bridge
// - Twilio inbound: base64 μ-law @ 8kHz mono
// - ElevenLabs: PCM16 (expects 16kHz; we upsample from 8kHz)
// - Outbound to Twilio: base64 μ-law @ 8kHz mono
//
// ENV (Railway -> Variables):
//   ELEVENLABS_API_KEY = <your key>
//   ELEVENLABS_DISCOVERY_AGENT_ID = agent_xxx   (optional fallback)
//   ELEVENLABS_DAILY_AGENT_ID     = agent_xxx   (optional fallback)
//   NODE_ENV=production (recommended)
//   BRIDGE_AUTH_TOKEN (optional; off by default)

const http = require('http');
const url = require('url');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 8080;
const BRIDGE_AUTH_TOKEN = process.env.BRIDGE_AUTH_TOKEN || null;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || null;
const DISCOVERY_ID = process.env.ELEVENLABS_DISCOVERY_AGENT_ID || null;
const DAILY_ID = process.env.ELEVENLABS_DAILY_AGENT_ID || null;

// ---------- HTTP SERVER (health + root) ----------
const server = http.createServer((req, res) => {
  if (req.url === '/health') return res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
  if (req.url === '/' || req.url === '/status') return res.writeHead(200, { 'Content-Type': 'text/plain' }).end('voice-bridge: up');
  res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
});

// ---------- WS SERVER ----------
const wss = new WebSocketServer({ noServer: true });

// UPGRADE handler with loud diagnostics
server.on('upgrade', (req, socket, head) => {
  const { pathname, query } = url.parse(req.url, true);

  console.log('[UPGRADE] incoming', {
    url: req.url,
    pathname,
    hasToken: !!(query && query.token),
    ua: req.headers['user-agent'],
    xff: req.headers['x-forwarded-for'] || null,
  });

  if (pathname !== '/ws' && pathname !== '/media-stream') {
    console.warn('[UPGRADE] rejecting — bad path', pathname);
    try { socket.destroy(); } catch (e) {}
    return;
  }

  if (BRIDGE_AUTH_TOKEN && (!query || query.token !== BRIDGE_AUTH_TOKEN)) {
    console.warn('[UPGRADE] rejected — bad/missing token');
    try { socket.destroy(); } catch (e) {}
    return;
  }

  req.__query = query || {};
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

// CONNECTION: Twilio socket
wss.on('connection', (twilioWs, req) => {
  console.log('[WS] CONNECTED via upgrade', req.url);

  // Debug – legacy query params (we now use <Parameter/>)
  const q = req.__query || {};
  console.log('[WS] query (debug)', {
    agentIdQ: q.agent_id || q.agent || null,
    modeQ: q.mode || null, phoneQ: q.phone || null, persistQ: q.persist || null,
  });

  attachBridgeHandlers(twilioWs);

  twilioWs.on('error', (e) => console.error('[WS] Twilio socket error:', e?.message || e));
  twilioWs.on('close', (code, reasonBuf) => {
    const reason = reasonBuf ? reasonBuf.toString() : undefined;
    console.log('[WS] Twilio socket closed', { code, reason });
  });

  // Twilio pings occasionally
  twilioWs.on('ping', (data) => { try { twilioWs.pong(data); } catch (e) {} });
});

// ---------- KEEPALIVE / LIFECYCLE ----------
setInterval(() => console.log('[HEARTBEAT] alive', new Date().toISOString()), 60_000);
process.on('SIGTERM', () => {
  console.log('[LIFECYCLE] SIGTERM received — shutting down gracefully');
  try { server.close(() => process.exit(0)); } catch (e) { process.exit(0); }
});

// ---------- START ----------
server.listen(PORT, () => {
  console.log(`[HTTP] listening on :${PORT}`);
});

// ============================================================================
// =============== Twilio <-> ElevenLabs ConvAI BRIDGE ========================
// ============================================================================

function attachBridgeHandlers(twilioWs) {
  let sawFirstMedia = false;
  let mediaFrames = 0;

  // Populated on start
  let agentId = null;
  let mode = 'discovery';
  let phone = null;
  let persist = '0';

  // EL socket
  let elWs = null;
  let elReady = false;

  // Buffer some inbound caller audio until EL is ready
  const pendingCallerChunks = [];

  twilioWs.on('message', (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    const event = msg?.event;

    if (event === 'connected') {
      console.log('[TWILIO] event connected');
      return;
    }

    if (event === 'start') {
      const start = msg.start || {};
      const cp = start.customParameters || {};
      agentId = cp.agent_id || (( (cp.mode || 'discovery').toLowerCase() === 'daily' ? DAILY_ID : DISCOVERY_ID ));
      mode    = (cp.mode || mode || 'discovery').toLowerCase();
      phone   = cp.caller_phone || phone;
      persist = cp.persist === '1' ? '1' : '0';

      console.log('[TWILIO] start', {
        streamSid: msg.streamSid,
        tracks: start.tracks,
        mediaFormat: start.mediaFormat, // expect audio/x-mulaw, 8000, 1
        customParameters: { agentId, mode, phone, persist }
      });

      if (!ELEVENLABS_API_KEY) {
        console.error('❌ Missing ELEVENLABS_API_KEY in Railway Variables');
        return;
      }
      if (!agentId) {
        console.error('❌ Missing agentId (no <Parameter/> and no env fallback)');
        return;
      }

      elWs = connectToElevenLabs({ agentId, mode, phone, onAudioFromEL: (pcm16_16k_B64) => {
        // Downsample 16k -> 8k, μ-law encode, send to Twilio
        try {
          const pcm16_16k = Buffer.from(pcm16_16k_B64, 'base64');
          const pcm16_8k  = downsamplePcm16Mono16kTo8k(pcm16_16k);
          const muLawBuf  = pcm16ToMuLaw(pcm16_8k);
          const muLawB64  = muLawBuf.toString('base64');

          twilioWs.send(JSON.stringify({
            event: 'media',
            media: { payload: muLawB64 }
          }));
        } catch (e) {
          console.error('[PIPE OUT] error sending audio to Twilio', e?.message || e);
        }
      }, onReady: () => {
        elReady = true;
        // flush any buffered caller chunks
        if (pendingCallerChunks.length) {
          console.log(`[EL] flushing ${pendingCallerChunks.length} buffered chunks`);
          for (const chunk of pendingCallerChunks) {
            try { elWs.send(JSON.stringify({ user_audio_chunk: chunk })); } catch {}
          }
          pendingCallerChunks.length = 0;
        }
      }, onClose: () => {
        elReady = false;
      }});

      return;
    }

    if (event === 'media') {
      mediaFrames += 1;
      if (!sawFirstMedia) {
        sawFirstMedia = true;
        console.log('[TWILIO] first media frame received');
      }

      // Twilio payload: μ-law base64 @ 8kHz mono
      const muLawB64 = msg?.media?.payload;
      if (!muLawB64) return;

      // μ-law -> PCM16 (8k), upsample to 16k for EL, then base64
      const muLawBuf = Buffer.from(muLawB64, 'base64');
      const pcm16_8k = muLawToPcm16(muLawBuf);
      const pcm16_16k = upsamplePcm16Mono8kTo16k(pcm16_8k);
      const pcm16_16k_B64 = Buffer.from(pcm16_16k.buffer, pcm16_16k.byteOffset, pcm16_16k.byteLength).toString('base64');

      if (elWs && elWs.readyState === WebSocket.OPEN) {
        if (elReady) {
          elWs.send(JSON.stringify({ user_audio_chunk: pcm16_16k_B64 }));
        } else {
          // buffer until EL signals it's ready (after metadata)
          pendingCallerChunks.push(pcm16_16k_B64);
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

// ============================================================================
// ==================== ElevenLabs ConvAI connection ==========================
// ============================================================================
// Docs: wss://api.elevenlabs.io/v1/convai/conversation?agent_id=... (header 'xi-api-key')
// Sends: { user_audio_chunk: <base64 PCM16> }, etc.
// Receives: { type:"audio", audio_event:{ audio_base_64: <base64 PCM16> } }, etc.

function connectToElevenLabs({ agentId, mode, phone, onAudioFromEL, onReady, onClose }) {
  const elUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${encodeURIComponent(agentId)}`;
  const headers = { 'xi-api-key': ELEVENLABS_API_KEY };

  console.log('[EL] connecting', { elUrl: `...conversation?agent_id=${agentId}` });

  const elWs = new WebSocket(elUrl, { headers });

  elWs.on('open', () => {
    console.log('[EL] connected');
    // Optionally, send a conversation_initiation_client_data to set first message, vars, etc.
    // elWs.send(JSON.stringify({
    //   type: "conversation_initiation_client_data",
    //   conversation_config_override: {
    //     agent: { language: "en" }
    //   }
    // }));
  });

  elWs.on('message', (data) => {
    // Try parse JSON; if binary, ignore
    let obj;
    try { obj = JSON.parse(data.toString()); } catch { obj = null; }

    // EL sends conversation metadata early — treat that as "ready"
    if (obj && obj.type === 'conversation_initiation_metadata') {
      console.log('[EL] metadata', obj.conversation_initiation_metadata_event);
      try { onReady && onReady(); } catch {}
      return;
    }

    // Agent audio back
    if (obj && obj.type === 'audio' && obj.audio_event && obj.audio_event.audio_base_64) {
      try { onAudioFromEL && onAudioFromEL(obj.audio_event.audio_base_64); } catch {}
      return;
    }

    // Useful logs for transcripts / responses
    if (obj && obj.type === 'user_transcript') {
      console.log('[EL] user_transcript:', obj.user_transcription_event?.user_transcript);
      return;
    }
    if (obj && obj.type === 'agent_response') {
      console.log('[EL] agent_response:', obj.agent_response_event?.agent_response);
      return;
    }
    if (obj && obj.type === 'ping') {
      // Reply with pong if EL expects it
      try { elWs.send(JSON.stringify({ type: 'pong', event_id: obj.ping_event?.event_id })); } catch {}
      return;
    }

    // Other events
    if (obj) {
      // Uncomment to see all events
      // console.log('[EL] event', obj.type);
    }
  });

  elWs.on('close', (code, reason) => {
    console.log('[EL] closed', { code, reason: reason?.toString() });
    try { onClose && onClose(); } catch {}
  });

  elWs.on('error', (err) => {
    console.error('[EL] error', err?.message || err);
  });

  return elWs;
}

// ============================================================================
// ===================== Audio helpers (μ-law / PCM16) ========================
// ============================================================================

// μ-law (G.711) decode -> PCM16 Int16Array
function muLawToPcm16(muBuf) {
  const out = new Int16Array(muBuf.length);
  for (let i = 0; i < muBuf.length; i++) {
    const u = muBuf[i];
    // Decode μ-law byte to 16-bit PCM (algorithmic form)
    let x = ~u;
    let sign = (x & 0x80) ? -1 : 1;
    let exponent = (x >> 4) & 0x07;
    let mantissa = x & 0x0F;
    let magnitude = ((mantissa << 1) + 1) << (exponent + 2);
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
    for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
      exponent--;
    }
    const mantissa = (sample >> (exponent + 3)) & 0x0F;
    let ulaw = ~(sign | (exponent << 4) | mantissa);
    out[i] = ulaw & 0xFF;
  }
  return out;
}

// Naive upsample 8k -> 16k (repeat each sample once)
// Input: Int16Array mono 8k; Output: Int16Array mono 16k
function upsamplePcm16Mono8kTo16k(pcm8k) {
  const out = new Int16Array(pcm8k.length * 2);
  for (let i = 0, j = 0; i < pcm8k.length; i++, j += 2) {
    const s = pcm8k[i];
    out[j] = s;
    out[j + 1] = s; // duplicate
  }
  return out;
}

// Naive downsample 16k -> 8k (drop every other sample)
// Input: Buffer/Uint8Array of PCM16 mono 16k; Output: Int16Array mono 8k
function downsamplePcm16Mono16kTo8k(pcm16kBuf) {
  const in16 = new Int16Array(pcm16kBuf.buffer, pcm16kBuf.byteOffset, Math.floor(pcm16kBuf.byteLength / 2));
  const out = new Int16Array(Math.floor(in16.length / 2));
  for (let i = 0, j = 0; j < out.length; i += 2, j++) {
    out[j] = in16[i];
  }
  return out;
}

