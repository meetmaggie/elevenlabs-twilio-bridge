// server.js – MeetMaggie Twilio <-> ElevenLabs bridge (v2.3)
// - FIX: Optimistic readiness if EL metadata doesn't arrive (EL_READY_FALLBACK_MS)
// - FIX: Don't block mic flushes on elReady; require only elOpen
// - Uses signed URL first, falls back to /convai/twilio
// - Sends caller mic as { user_audio_chunk: "<base64 μ-law 8k 20ms>" }
// - Forwards ONLY inbound audio from Twilio
// - Handles exact-id pong + barge-in clear
// - Supports discovery/daily agents via customParameters
//
// Env (Railway):
//   ELEVENLABS_API_KEY (required)
//   ELEVENLABS_DISCOVERY_AGENT_ID (required)
//   ELEVENLABS_DAILY_AGENT_ID (optional)
//   BRIDGE_AUTH_TOKEN (optional)  // recommended
//   NODE_ENV=production (recommended)
//   LOOPBACK_ONLY=0|1 (optional)
//   SILENCE_MS=800 EL_BUFFER_MS=200 UTTER_MAX_MS=3000 (optional tuning)
//   LOG_FRAMES_EVERY=20 LOG_MARK_ACKS=0 DEBUG_AUDIO=0 (optional)
//   EL_READY_FALLBACK_MS=1000 (optional; optimistic ready if metadata is late)

const http = require('http');
const url = require('url');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 8080;
const BRIDGE_AUTH_TOKEN = process.env.BRIDGE_AUTH_TOKEN || null;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || null;
const DISCOVERY_ID = process.env.ELEVENLABS_DISCOVERY_AGENT_ID || null;
const DAILY_ID = process.env.ELEVENLABS_DAILY_AGENT_ID || null;
const LOOPBACK_ONLY = (process.env.LOOPBACK_ONLY || '').trim() === '1';

// Tunables
const LOG_FRAMES_EVERY = parseInt(process.env.LOG_FRAMES_EVERY || '20', 10);
const LOG_MARK_ACKS = (process.env.LOG_MARK_ACKS || '0').trim() === '1';
const SILENCE_MS = parseInt(process.env.SILENCE_MS || '800', 10);
const EL_BUFFER_MS = parseInt(process.env.EL_BUFFER_MS || '200', 10);
const UTTER_MAX_MS = parseInt(process.env.UTTER_MAX_MS || '3000', 10);
const EL_READY_FALLBACK_MS = parseInt(process.env.EL_READY_FALLBACK_MS || '1000', 10);
const FRAMES_PER_PACKET = Math.max(1, Math.round(EL_BUFFER_MS / 20));

console.log(`[STARTUP] MeetMaggie Voice Bridge v2.3 starting...`);
console.log(`[CONFIG] SILENCE_MS=${SILENCE_MS}, EL_BUFFER_MS=${EL_BUFFER_MS}, UTTER_MAX_MS=${UTTER_MAX_MS}`);
console.log(`[CONFIG] EL_READY_FALLBACK_MS=${EL_READY_FALLBACK_MS}, FRAMES_PER_PACKET=${FRAMES_PER_PACKET}, LOOPBACK_ONLY=${LOOPBACK_ONLY}`);

const server = http.createServer((req, res) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
  if (req.method === 'OPTIONS') { res.writeHead(200, corsHeaders); return res.end(); }
  if (req.url === '/health') {
    res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'healthy',
      service: 'MeetMaggie Voice Bridge v2.3',
      timestamp: new Date().toISOString(),
      activeConnections: wss ? wss.clients.size : 0
    }));
  }
  if (req.url === '/' || req.url === '/status') {
    res.writeHead(200, { ...corsHeaders, 'Content-Type': 'text/plain' });
    return res.end('MeetMaggie Voice Bridge v2.3: Ready for calls');
  }
  res.writeHead(404, { ...corsHeaders, 'Content-Type': 'text/plain' });
  res.end('Not found');
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const { pathname, query } = url.parse(req.url, true);
  console.log(`[WS] Upgrade request: ${pathname}`);
  if (pathname !== '/ws' && pathname !== '/media-stream') {
    console.warn('[WS] Invalid path attempted:', pathname);
    return socket.destroy();
  }
  if (BRIDGE_AUTH_TOKEN && query && query.token && query.token !== BRIDGE_AUTH_TOKEN) {
    console.warn('[WS] Rejected: bad token in URL query');
    return socket.destroy();
  }
  req.__query = query || {};
  wss.handleUpgrade(req, socket, head, ws => {
    console.log('[WS] Connection upgraded');
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (twilioWs, req) => {
  attachBridgeHandlers(twilioWs, req.__query || {});
});

setInterval(() => {
  console.log(`[HEARTBEAT] Active connections: ${wss.clients.size} @ ${new Date().toISOString()}`);
}, 60_000);

process.on('SIGTERM', () => {
  console.log('[SHUTDOWN] Graceful shutdown');
  try { server.close(() => process.exit(0)); } catch { process.exit(0); }
});

server.listen(PORT, () => {
  console.log(`[STARTUP] Listening on :${PORT}`);
  console.log(`[STARTUP] WebSocket endpoint: /ws`);
});

// ================== Core Bridge ==================

function attachBridgeHandlers(twilioWs, query = {}) {
  const sessionId = generateSessionId();
  const startedAt = Date.now();
  let twilioStreamSid = null;
  let agentId = null, mode = 'discovery', phone = '';
  let authed = !BRIDGE_AUTH_TOKEN;

  // EL state
  let elWs = null, elOpen = false, elReady = false, conversationStarted = false;
  let elInFormat = null, elOutFormat = null;
  let mdTimer = null; // metadata fallback timer

  // Audio/VAD state
  let seq = 0, chunk = 0, tsMs = 0;
  let elBuffer = [];
  let elBufferedFrames = 0;
  let totalFramesSent = 0;
  let totalAudioReceived = 0;
  let speaking = false;
  let silenceTimer = null;
  let utterCapTimer = null;
  let firstUserInput = true;
  let elHasSpoken = false;
  let userHasSpoken = false;
  let lastAgentAudioTime = 0;

  // Nudges
  let nudge1 = null, nudge2 = null, nudge3 = null;

  const log = (cat, msg, data = {}) => {
    const t = Date.now() - startedAt;
    console.log(`[${cat}:${sessionId}:${t}ms] ${msg}`, data);
  };

  const resetUtterance = () => {
    speaking = false;
    clearTimeout(silenceTimer);
    clearTimeout(utterCapTimer);
  };

  // --------- FLUSH: now requires elOpen only (not elReady) ----------
  const flushElBuffer = (label = 'flush') => {
    if (!elBufferedFrames) return;
    const merged = Buffer.concat(elBuffer); // μ-law 8k bytes
    const durationMs = elBufferedFrames * 20;

    if (!elOpen) {
      log('BUF', `${label} deferred - EL not open`, { durationMs, bytes: merged.length, elOpen, elReady });
      return;
    }

    try {
      for (let o = 0; o < merged.length; o += 160) {
        const slice = merged.subarray(o, Math.min(o + 160, merged.length));
        elWs.send(JSON.stringify({ user_audio_chunk: slice.toString('base64') }));
      }
      totalFramesSent += elBufferedFrames;
      log('EL_SEND', `Audio -> EL`, { label, durationMs, frames: elBufferedFrames, bytes: merged.length, totalFramesSent });

      if (firstUserInput && conversationStarted && elBufferedFrames > 5) {
        setTimeout(() => {
          if (elWs && elOpen) {
            try { elWs.send(JSON.stringify({ type: "conversation_start" })); } catch {}
            log('EL_SEND', 'conversation_start nudged');
          }
        }, 100);
        firstUserInput = false;
      }
    } catch (e) {
      log('ERROR', 'Send to EL failed', { error: e.message });
    }

    elBuffer = [];
    elBufferedFrames = 0;
  };

  const flushInterval = setInterval(() => {
    if (elBufferedFrames >= Math.max(1, Math.round(EL_BUFFER_MS / 20))) {
      flushElBuffer('periodic');
    }
  }, 50);

  const cleanup = () => {
    log('SESSION', 'Cleanup');
    clearInterval(flushInterval);
    clearTimeout(silenceTimer);
    clearTimeout(utterCapTimer);
    clearTimeout(nudge1);
    clearTimeout(nudge2);
    clearTimeout(nudge3);
    clearTimeout(mdTimer);
    if (elWs) { try { elWs.close(1000); } catch {} }
  };

  twilioWs.on('close', (code, reason) => {
    const dur = Date.now() - startedAt;
    log('TWILIO', 'Closed', { code, reason: reason?.toString(), durMs: dur, totalAudioReceived, totalFramesSent, userHasSpoken });
    cleanup();
  });

  twilioWs.on('error', (err) => { log('ERROR', 'Twilio WS error', { error: err.message }); cleanup(); });

  twilioWs.on('message', (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { log('ERROR','Invalid JSON from Twilio'); return; }
    const event = msg?.event;
    if (event !== 'mark') {
      log('TWILIO_RAW', `Event: ${event}`, {
        hasPayload: !!(msg?.media?.payload),
        streamSid: msg?.streamSid || msg?.start?.streamSid,
        payloadLength: msg?.media?.payload?.length || 0
      });
    }

    if (event === 'connected') return;

    if (event === 'start') {
      const start = msg.start || {};
      twilioStreamSid = msg.streamSid || start.streamSid || null;
      const cp = start.customParameters || {};
      const token = cp.token;
      mode = (cp.mode || 'discovery').toLowerCase();
      agentId = cp.agent_id || (mode === 'daily' ? DAILY_ID : DISCOVERY_ID);
      phone = cp.caller_phone || start.from || cp.from || '';

      // --- NEW: parse profile_b64 into JSON (safe, metadata only)
      const profile_b64 = cp.profile_b64 || '';
      let profile_json = null;
      if (profile_b64 && typeof profile_b64 === 'string') {
        try {
          profile_json = JSON.parse(Buffer.from(profile_b64, 'base64').toString('utf8'));
        } catch (e) {
          log('WARN', 'profile_b64 parse failed', { error: e.message });
        }
      }

      if (BRIDGE_AUTH_TOKEN) {
        if (token && token === BRIDGE_AUTH_TOKEN) { authed = true; }
        else { log('ERROR', 'Bad/missing token in customParameters'); try { twilioWs.close(1008, 'bad-token'); } catch {} return; }
      }

      log('TWILIO', 'Stream started', {
        streamSid: twilioStreamSid,
        agentId: agentId ? agentId.slice(0,8)+'...' : 'missing',
        phone, mode, authed,
        hasProfile: !!profile_json
      });

      // Reset session state
      seq = 0; chunk = 0; tsMs = 0;
      elBuffer = []; elBufferedFrames = 0; totalFramesSent = 0; totalAudioReceived = 0;
      elOpen = false; elReady = false; elHasSpoken = false; userHasSpoken = false;
      conversationStarted = false; firstUserInput = true; lastAgentAudioTime = 0;
      resetUtterance();

      if (LOOPBACK_ONLY) { log('MODE','Loopback mode – no EL connection'); return; }
      if (!ELEVENLABS_API_KEY) { log('ERROR','ELEVENLABS_API_KEY not set'); return; }
      if (!agentId) { log('ERROR', `No agent ID for mode=${mode}`); return; }

      connectToElevenLabs(agentId, phone, sessionId, profile_json);
      return;
    }

    if (event === 'media') {
      const track = msg?.media?.track;
      if (track && track !== 'inbound') return;
      const muLawB64 = msg?.media?.payload;
      if (!muLawB64) { log('ERROR','Media missing payload'); return; }
      if (!authed) return;

      totalAudioReceived++;

      const now = Date.now();
      const sinceAgent = now - (lastAgentAudioTime || 0);
      if (!speaking && (sinceAgent > 500 || !elHasSpoken || !elOpen)) {
        speaking = true; userHasSpoken = true;
        log('VAD', 'User started speaking', { totalFrames: totalAudioReceived, sinceAgent, elHasSpoken, elOpen });

        if (elWs && elOpen) {
          try { elWs.send(JSON.stringify({ type: "user_audio_start" })); log('EL_SEND','user_audio_start'); }
          catch (e) { log('ERROR','user_audio_start failed',{ error:e.message }); }
        }
        clearTimeout(utterCapTimer);
        utterCapTimer = setTimeout(() => { log('VAD','Hard cap -> end'); endUserTurn('hard_cap'); }, UTTER_MAX_MS);
      }

      try {
        const audioBytes = Buffer.from(muLawB64, 'base64');
        elBuffer.push(audioBytes);
        elBufferedFrames += 1;

        if (totalAudioReceived <= 10) {
          log('AUDIO', `Buffered frame ${totalAudioReceived}`, { bytes: audioBytes.length, speaking, elReady, bufferFrames: elBufferedFrames });
        }
        if (elBufferedFrames >= Math.max(1, Math.round(EL_BUFFER_MS / 20)) && elOpen) {
          flushElBuffer('immediate');
        }
      } catch (e) { log('ERROR','Failed to buffer audio', { error:e.message }); }

      if (LOOPBACK_ONLY) sendAudioToTwilio(muLawB64);

      if (speaking) {
        clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => { log('VAD','Silence -> end'); endUserTurn('silence'); }, SILENCE_MS);
      }
      return;
    }

    if (event === 'mark') {
      if (LOG_MARK_ACKS) log('TWILIO','Mark ack',{ mark: msg.mark });
      return;
    }

    if (event === 'stop') {
      log('TWILIO','Stop received');
      flushElBuffer('stop');
      if (elWs && elOpen) {
        try { elWs.send(JSON.stringify({ type: "user_audio_end" })); log('EL_SEND','Final user_audio_end'); } catch {}
        try {
          elWs.send(JSON.stringify({ type:"user_message", user_message:{ message:"(Call ended)" } }));
          log('EL_SEND','Call end msg');
        } catch {}
      }
      cleanup(); try { twilioWs.close(1000); } catch {}
      return;
    }

    log('TWILIO','Unhandled event',{ event });
  });

  function endUserTurn(reason) {
    log('VAD', `End user turn: ${reason}`);
    flushElBuffer(`end_${reason}`);

    if (elWs && elOpen) {
      try { elWs.send(JSON.stringify({ type:"user_audio_end" })); log('EL_SEND',`user_audio_end (${reason})`); } catch (e){}
      setTimeout(() => { if (elWs && elOpen) { try { elWs.send(JSON.stringify({ type:"user_audio_end" })); log('EL_SEND','user_audio_end re-sent'); } catch {} } }, 150);
      setTimeout(() => { if (elWs && elOpen) { try {
        elWs.send(JSON.stringify({ type:"user_message", user_message:{ message:"(User finished speaking - please respond)" } }));
        log('EL_SEND','Processing nudge');
      } catch {} } }, 250);
    }
    resetUtterance();
  }

  function sendAudioToTwilio(audioB64) {
    if (!twilioStreamSid) return;
    try {
      const mediaMessage = {
        event: 'media',
        streamSid: twilioStreamSid,
        sequenceNumber: String(++seq),
        media: { track:'outbound', chunk:String(++chunk), timestamp:String(tsMs), payload: audioB64 }
      };
      const markMessage = { event:'mark', streamSid: twilioStreamSid, mark:{ name:`maggie-chunk-${chunk}` } };
      twilioWs.send(JSON.stringify(mediaMessage));
      twilioWs.send(JSON.stringify(markMessage));
      tsMs += 20;
      if (LOG_FRAMES_EVERY > 0 && (seq % LOG_FRAMES_EVERY === 0)) {
        log('TWILIO_SEND','Audio frame sent',{ seq, chunk, tsMs, bytes: Buffer.from(audioB64,'base64').length });
      }
    } catch (e) { log('ERROR','Send audio to Twilio failed',{ error:e.message }); }
  }

  // ---------- ElevenLabs connection (signed URL -> /convai/twilio fallback)

  function pickElAudioB64(msg) {
    const cands = [
      msg?.audio, msg?.audio_base64, msg?.audio_base_64,
      msg?.audio_event?.audio, msg?.audio_event?.audio_base64, msg?.audio_event?.audio_base_64,
      msg?.tts_event?.audio_base_64, msg?.response?.audio, msg?.chunk?.audio
    ];
    for (const s of cands) if (typeof s === 'string' && s.length > 32) return s;
    for (const v of Object.values(msg || {})) {
      if (typeof v === 'string' && v.length > 128 && /^[A-Za-z0-9+/=]+$/.test(v)) return v;
      if (v && typeof v === 'object') {
        for (const v2 of Object.values(v)) {
          if (typeof v2 === 'string' && v2.length > 128 && /^[A-Za-z0-9+/=]+$/.test(v2)) return v2;
        }
      }
    }
    return null;
  }

  async function connectToElevenLabs(agentId, phone, sessionId, profile_json) {
    const headers = { 'xi-api-key': ELEVENLABS_API_KEY };

    async function getSignedUrl() {
      const r = await fetch(
        `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${encodeURIComponent(agentId)}`,
        { headers }
      );
      if (!r.ok) throw new Error(`get_signed_url ${r.status}`);
      const { signed_url } = await r.json();
      return signed_url;
    }

    function openWs(endpoint) {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(endpoint, { headers });
        ws.once('open', () => resolve(ws));
        ws.once('error', reject);
      });
    }

    try {
      const signedUrl = await getSignedUrl();
      elWs = await openWs(signedUrl);
      elOpen = true;
      log('EL_CONNECT','Connected via signed URL');
    } catch (e) {
      log('EL_CONNECT', `Signed URL failed (${e.message}), fallback to /convai/twilio`);
      try {
        elWs = await openWs(`wss://api.elevenlabs.io/v1/convai/twilio?agent_id=${encodeURIComponent(agentId)}`);
        elOpen = true;
        log('EL_CONNECT','Connected via /convai/twilio');
      } catch (e2) {
        log('ERROR', `EL connect failed: ${e2.message}`);
        return;
      }
    }

    // ---- NEW: optimistic readiness if metadata is late
    clearTimeout(mdTimer);
    mdTimer = setTimeout(() => {
      if (!elReady) {
        elReady = true; // optimistic
        log('EL_CONNECT','No metadata; proceeding optimistically',{ EL_READY_FALLBACK_MS });
        try { elWs.send(JSON.stringify({ type: "conversation_start" })); } catch {}
        if (elBufferedFrames > 0) flushElBuffer('md-timeout');
      }
    }, Math.max(200, EL_READY_FALLBACK_MS));

    // --- INIT: include dynamic_variables.profile when provided
    const dynamicVars = {
      caller_phone: phone || "",
      mode,
      session_id: sessionId,
      timestamp: new Date().toISOString()
    };
    if (profile_json) dynamicVars.profile = profile_json;

    try {
      elWs.send(JSON.stringify({
        type: "conversation_initiation_client_data",
        conversation_initiation_client_data: { dynamic_variables: dynamicVars }
      }));
      log('EL_SEND','Init data sent', { phone, mode, hasProfile: !!profile_json });
    } catch (e) { log('ERROR','Init send failed', { error:e.message }); }

    elWs.on('message', (data) => {
      let message; try { message = JSON.parse(data.toString()); }
      catch { log('EL_RECV','Non-JSON msg',{ sample: String(data).slice(0,120)}); return; }

      if (message?.type === 'ping' && message.ping_event?.event_id) {
        try { elWs.send(JSON.stringify({ type:'pong', event_id: message.ping_event.event_id })); log('EL_SEND','Pong',{ eventId: message.ping_event.event_id }); } catch (e) { log('ERROR','Pong failed',{ error:e.message }); }
        return;
      }

      if (message?.type === 'interruption' && twilioStreamSid) {
        try { twilioWs.send(JSON.stringify({ event:'clear', streamSid: twilioStreamSid })); log('EL_RECV','Interruption -> clear'); } catch {}
      }

      if (message?.type === 'conversation_initiation_metadata') {
        clearTimeout(mdTimer);
        const md = message.conversation_initiation_metadata_event || {};
        elInFormat = md.user_input_audio_format;
        elOutFormat = md.agent_output_audio_format;
        elReady = true; conversationStarted = true;
        log('EL_RECV','Metadata',{ elInFormat, elOutFormat });
        if (elBufferedFrames > 0) flushElBuffer('metadata_ready');
        return;
      }

      const b64 = pickElAudioB64(message);
      if (b64) {
        if (!elHasSpoken) {
          elHasSpoken = true;
          clearTimeout(nudge1); clearTimeout(nudge2); clearTimeout(nudge3);
          log('EL_RECV','First audio from agent');
        }
        lastAgentAudioTime = Date.now();
        resetUtterance();

        let outBuf = Buffer.from(b64, 'base64');
        if (elOutFormat && /ulaw_?8000/i.test(elOutFormat)) {
          for (let o = 0; o < outBuf.length; o += 160) {
            const slice = outBuf.subarray(o, Math.min(o + 160, outBuf.length));
            sendAudioToTwilio(slice.toString('base64'));
          }
        } else {
          if (elOutFormat && /16k|16000/i.test(elOutFormat)) outBuf = downsamplePcm16Mono16kTo8k(outBuf);
          const mu = pcm16ToMuLaw(outBuf);
          for (let o = 0; o < mu.length; o += 160) {
            const slice = mu.subarray(o, Math.min(o + 160, mu.length));
            sendAudioToTwilio(slice.toString('base64'));
          }
        }
        return;
      }

      if (message?.type === 'user_transcript') {
        log('EL_RECV','User transcript',{ t: message.user_transcription_event?.user_transcript });
        return;
      }
      if (message?.type === 'agent_response') {
        log('EL_RECV','Agent text',{ r: message.agent_response_event?.agent_response });
        return;
      }

      if (message?.error || message?.type === 'error') {
        log('ERROR','ElevenLabs error message',{ error: message });
        return;
      }

      log('EL_RECV','Unhandled',{ type: message?.type, keys: Object.keys(message || {}) });
    });

    elWs.on('close', (code, reason) => {
      elOpen = false; elReady = false;
      clearTimeout(mdTimer);
      log('EL_CONNECT','Closed',{ code, reason: reason?.toString() || '' });
    });

    elWs.on('error', (e) => log('ERROR','EL socket error',{ err: e.message }));

    // Existing "start talking" nudges (kept)
    nudge1 = setTimeout(() => {
      if (!elHasSpoken && elWs && elOpen) {
        try { elWs.send(JSON.stringify({ type:"user_message", user_message:{ message:"Hello" } })); log('EL_SEND','Nudge1'); } catch {}
      }
    }, 2000);
    nudge2 = setTimeout(() => {
      if (!elHasSpoken && elWs && elOpen) {
        try { elWs.send(JSON.stringify({ type:"user_message", user_message:{ message:"Please start the conversation" } })); log('EL_SEND','Nudge2'); } catch {}
      }
    }, 4000);
    nudge3 = setTimeout(() => {
      if (!elHasSpoken && elWs && elOpen) {
        try { elWs.send(JSON.stringify({ type:"conversation_start" })); log('EL_SEND','Nudge3 conversation_start'); } catch {}
      }
    }, 6000);
  }
}

// ================== Audio utils ==================

function pcm16ToMuLaw(pcmBuffer) {
  const view = new DataView(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.byteLength);
  const out = Buffer.alloc(Math.floor(pcmBuffer.byteLength / 2));
  for (let i = 0, j = 0; i < pcmBuffer.byteLength; i += 2, j++) {
    const s = view.getInt16(i, true);
    out[j] = linear2ulaw(s);
  }
  return out;
}
function linear2ulaw(sample) {
  const MULAW_MAX = 0x1FFF, MULAW_BIAS = 0x84;
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > MULAW_MAX) sample = MULAW_MAX;
  sample = sample + MULAW_BIAS;
  const exponent = ulawExp(sample);
  const mantissa = (sample >> (exponent + 3)) & 0x0F;
  let ulawbyte = ~(sign | (exponent << 4) | mantissa);
  return ulawbyte & 0xFF;
}
function ulawExp(sample) {
  if (sample >= 256) { if (sample >= 512) { if (sample >= 1024) { if (sample >= 2048) return 7; return 6; } return 5; } if (sample >= 128) return 4; return 3; }
  if (sample >= 64) return 2; if (sample >= 32) return 1; return 0;
}
function downsamplePcm16Mono16kTo8k(pcm16Buffer) {
  const input16 = new Int16Array(pcm16Buffer.buffer, pcm16Buffer.byteOffset, Math.floor(pcm16Buffer.byteLength / 2));
  const outputLength = Math.floor(input16.length / 2);
  const output16 = new Int16Array(outputLength);
  for (let i = 0, j = 0; j < outputLength; i += 2, j++) output16[j] = input16[i];
  return Buffer.from(output16.buffer);
}

// ================== Misc ==================

function generateSessionId() { return Math.random().toString(36).slice(2, 10); }

console.log('[STARTUP] MeetMaggie Voice Bridge ready');
