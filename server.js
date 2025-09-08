// server.js — Twilio <-> ElevenLabs bridge
// Buffered caller audio + guaranteed turn end + post-end "wake-up" user_message.
//
// What’s special here:
//  - Buffers μ-law 20ms frames into ~200ms packets and streams to EL
//  - Sends user_audio_start when caller begins talking
//  - Ends turn on silence OR a hard cap
//  - **NEW:** After user_audio_end, sends a small user_message ("(caller finished speaking)")
//             to reliably wake EL to transcribe/respond even if auto-listen is off
//  - No config overrides (avoids 1008), ws->conversation fallback, intro-turn reset, throttled logs

const http = require('http');
const url = require('url');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 8080;
const BRIDGE_AUTH_TOKEN = process.env.BRIDGE_AUTH_TOKEN || null;

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || null;
const DISCOVERY_ID = process.env.ELEVENLABS_DISCOVERY_AGENT_ID || null;
const DAILY_ID = process.env.ELEVENLABS_DAILY_AGENT_ID || null;

const LOOPBACK_ONLY = (process.env.LOOPBACK_ONLY || '').trim() === '1';

// Tuning (set these as Railway Variables to tweak without code changes)
const LOG_FRAMES_EVERY = parseInt(process.env.LOG_FRAMES_EVERY || '100', 10); // 0=off
const LOG_MARK_ACKS     = (process.env.LOG_MARK_ACKS || '0').trim() === '1';
const SILENCE_MS        = parseInt(process.env.SILENCE_MS || '400', 10); // end turn after this much silence
const EL_BUFFER_MS      = parseInt(process.env.EL_BUFFER_MS || '200', 10); // packet size we send to EL
const UTTER_MAX_MS      = parseInt(process.env.UTTER_MAX_MS || '1500', 10); // hard cap per user turn
const FRAMES_PER_PACKET = Math.max(1, Math.round(EL_BUFFER_MS / 20));       // 10 for 200ms

// ---------- HTTP ----------
const server = http.createServer((req, res) => {
  if (req.url === '/health') return res.writeHead(200, {'Content-Type':'text/plain'}).end('ok');
  if (req.url === '/' || req.url === '/status') return res.writeHead(200, {'Content-Type':'text/plain'}).end('voice-bridge: up');
  res.writeHead(404, {'Content-Type':'text/plain'}).end('not found');
});

// ---------- WS endpoint ----------
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const { pathname, query } = url.parse(req.url, true);
  if (pathname !== '/ws' && pathname !== '/media-stream') return socket.destroy();
  if (BRIDGE_AUTH_TOKEN && (!query || query.token !== BRIDGE_AUTH_TOKEN)) return socket.destroy();
  req.__query = query || {};
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});
wss.on('connection', (twilioWs) => attachBridgeHandlers(twilioWs));

// ---------- Lifecycle ----------
setInterval(() => console.log('[HEARTBEAT] alive', new Date().toISOString()), 60_000);
process.on('SIGTERM', () => { try { server.close(() => process.exit(0)); } catch { process.exit(0); }});
server.listen(PORT, () => console.log(`[HTTP] listening on :${PORT}`, { SILENCE_MS, EL_BUFFER_MS, UTTER_MAX_MS, FRAMES_PER_PACKET }));

// ================== Bridge core ==================
function attachBridgeHandlers(twilioWs) {
  let twilioStreamSid = null;
  let agentId = null, mode = 'discovery', phone = '';

  // EL state
  let elWs = null, elOpen = false, elReady = false;
  let elInFormat = null, elOutFormat = null;

  // Outbound to Twilio
  let seq = 0, chunk = 0, tsMs = 0;

  // Buffering to EL
  let elBuffer = [];        // Array<Buffer> μ-law
  let elBufferedFrames = 0; // how many 20ms frames buffered
  let totalFramesSent = 0;

  // Utterance state
  let speaking = false;
  let silenceTimer = null;
  let utterCapTimer = null;     // hard cap timer
  let sentUserStart = false;
  let callerActiveNotified = false;
  let elHasSpoken = false;
  let nudge1 = null, nudge2 = null;

  const resetUtterance = () => {
    speaking = false;
    sentUserStart = false;
    callerActiveNotified = false;
    clearTimeout(silenceTimer);
    clearTimeout(utterCapTimer);
  };

  function flushElBuffer(label = 'flush') {
    if (!elBufferedFrames) return;
    const merged = Buffer.concat(elBuffer);
    const ms = elBufferedFrames * 20;

    if (!elOpen)  { console.log(`[BUF] ${label} skipped — EL socket not open`, { ms, bytes: merged.length }); return; }
    if (!elReady) { console.log(`[BUF] ${label} deferred — EL not ready`, { ms, bytes: merged.length }); return; }

    try {
      // Preferred schema for new tenants
      elWs.send(JSON.stringify({ type: "audio", audio_event: { audio_base_64: merged.toString('base64') }}));
      totalFramesSent += elBufferedFrames;
      console.log('[EL<-USER] sent packet', { label, ms, frames: elBufferedFrames, bytes: merged.length, totalFramesSent });
    } catch (e) {
      console.warn('[EL<-USER] send packet failed', e?.message || e);
    }
    elBuffer = [];
    elBufferedFrames = 0;
  }

  const periodicFlush = setInterval(() => {
    if (elBufferedFrames >= FRAMES_PER_PACKET) flushElBuffer('periodic');
  }, 60);
  twilioWs.on('close', () => clearInterval(periodicFlush));
  twilioWs.on('error', () => clearInterval(periodicFlush));

  twilioWs.on('message', (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
    const event = msg?.event;
    if (event === 'connected') return;

    if (event === 'start') {
      const start = msg.start || {};
      twilioStreamSid = msg.streamSid || start.streamSid || null;

      const cp = start.customParameters || {};
      mode   = (cp.mode || 'discovery').toLowerCase();
      agentId = cp.agent_id || (mode === 'daily' ? (process.env.ELEVENLABS_DAILY_AGENT_ID || null)
                                                  : (process.env.ELEVENLABS_DISCOVERY_AGENT_ID || null));
      phone  = cp.caller_phone || '';

      console.log('[TWILIO] start', { streamSid: twilioStreamSid, agentId, phone, LOOPBACK_ONLY, FRAMES_PER_PACKET });

      // reset per-call
      seq = 0; chunk = 0; tsMs = 0;
      elBuffer = []; elBufferedFrames = 0; totalFramesSent = 0;
      elOpen = false; elReady = false; elHasSpoken = false;
      resetUtterance();
      clearTimeout(nudge1); clearTimeout(nudge2);

      if (!LOOPBACK_ONLY) {
        if (!ELEVENLABS_API_KEY) { console.error('❌ Missing ELEVENLABS_API_KEY'); return; }
        if (!agentId)            { console.error('❌ Missing agentId'); return; }

        elWs = connectToELWithFallback({
          agentId, phone,
          onOpen: (ws) => {
            elOpen = true;
            const init = {
              type: "conversation_initiation_client_data",
              dynamic_variables: { caller_phone: phone || "" }
            };
            try { ws.send(JSON.stringify(init)); console.log('[EL] sent init (no overrides)'); }
            catch (e) { console.error('[EL] failed to send init', e?.message || e); }

            nudge1 = setTimeout(() => { try { ws.send(JSON.stringify({ type:"user_message", text:"Hello" })); } catch{}; console.warn('[EL] first nudge sent'); }, 1200);
            nudge2 = setTimeout(() => { try { ws.send(JSON.stringify({ type:"user_message", text:"Are you there?" })); } catch{}; console.warn('[EL] second nudge sent'); }, 2500);
          },
          onMetadata: ({ user_input_audio_format, agent_output_audio_format }) => {
            elInFormat  = user_input_audio_format;
            elOutFormat = agent_output_audio_format;
            elReady = true;
            console.log('[EL] formats', { elInFormat, elOutFormat, bufferedMs: FRAMES_PER_PACKET * 20 });
            if (elBufferedFrames) flushElBuffer('onMetadata');
          },
          onAudioFromEL: (audioB64) => {
            elHasSpoken = true;
            clearTimeout(nudge1); clearTimeout(nudge2);
            resetUtterance();
            console.log('[VAD] reset_for_agent_turn');

            const bytes = Buffer.from(audioB64, 'base64').length;
            if (LOG_FRAMES_EVERY !== 0) console.log('[EL->TWILIO] audio chunk', { len: bytes, format: elOutFormat });

            if (elOutFormat === 'ulaw_8000') {
              const u = Buffer.from(audioB64, 'base64');
              for (let off = 0; off < u.length; off += 160) {
                const slice = u.subarray(off, Math.min(off + 160, u.length));
                sendOutboundFrame(twilioWs, twilioStreamSid, slice.toString('base64'), ++seq, ++chunk, tsMs);
                tsMs += 20;
              }
            } else {
              const pcm16_16k = Buffer.from(audioB64, 'base64');
              const pcm16_8k  = downsamplePcm16Mono16kTo8k(pcm16_16k);
              const muLawBuf  = pcm16ToMuLaw(pcm16_8k);
              for (let off = 0; off < muLawBuf.length; off += 160) {
                const slice = muLawBuf.subarray(off, Math.min(off + 160, muLawBuf.length));
                sendOutboundFrame(twilioWs, twilioStreamSid, slice.toString('base64'), ++seq, ++chunk, tsMs);
                tsMs += 20;
              }
            }
          },
          onClose: () => { elOpen = false; }
        });
      }
      return;
    }

    if (event === 'media') {
      const muLawB64 = msg?.media?.payload; if (!muLawB64) return;

      if (!speaking) {
        speaking = true;
        console.log('[VAD] user_started_speaking');

        // Send start even if EL isn't open yet; EL will accept once ready.
        try { if (elWs) { elWs.send(JSON.stringify({ type: "user_audio_start" })); console.log('[VAD] user_audio_start sent'); } } catch {}

        if (elHasSpoken && !callerActiveNotified && elWs) {
          try { elWs.send(JSON.stringify({ type: "user_activity" })); console.log('[EL] user_activity sent (caller started talking)'); } catch {}
          callerActiveNotified = true;
        }

        // Hard cap: guarantee a turn end even if no silence detected
        clearTimeout(utterCapTimer);
        utterCapTimer = setTimeout(() => {
          console.warn('[VAD] hard_cap user_audio_end');
          endUserTurn('hardcap');
        }, UTTER_MAX_MS);
      }

      // ALWAYS buffer μ-law bytes
      try {
        const bytes = Buffer.from(muLawB64, 'base64');
        elBuffer.push(bytes);
        elBufferedFrames += 1;
        if (elBufferedFrames >= FRAMES_PER_PACKET && elOpen && elReady) flushElBuffer('instant');
      } catch (e) {
        console.warn('[BUF] push failed', e?.message || e);
      }

      // Loopback (echo) if enabled
      if (LOOPBACK_ONLY) {
        sendOutboundFrame(twilioWs, twilioStreamSid, muLawB64, ++seq, ++chunk, tsMs);
        tsMs += 20;
      }

      // Silence-based end
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => endUserTurn('silence-final'), SILENCE_MS);

      return;
    }

    if (event === 'mark') { if (LOG_MARK_ACKS) console.log('[IN ] Twilio mark ack', msg.mark); return; }

    if (event === 'stop') {
      clearTimeout(silenceTimer);
      clearTimeout(utterCapTimer);
      clearTimeout(nudge1); clearTimeout(nudge2);
      flushElBuffer('stop');
      try { elWs && elWs.send(JSON.stringify({ type: "user_audio_end" })); } catch {}
      // NEW: wake-up nudge on stop as well
      try { elWs && elWs.send(JSON.stringify({ type: "user_message", text: "(caller finished speaking)" })); console.log('[NUDGE] user_message sent (stop)'); } catch {}
      try { twilioWs.close(1000); } catch {}
      try { elWs && elWs.close(1000); } catch {}
      return;
    }
  });

  // ---- helpers ----
  function endUserTurn(label) {
    // Final flush BEFORE end
    flushElBuffer(label);
    // End signal
    try {
      elWs && elWs.send(JSON.stringify({ type: "user_audio_end" }));
      console.log(`[VAD] user_audio_end sent (${label.includes('hard') ? 'hard cap' : 'silence'})`);
    } catch {}
    // NEW: post-end wake-up nudge (forces EL to process what we just sent)
    try {
      elWs && elWs.send(JSON.stringify({ type: "user_message", text: "(caller finished speaking)" }));
      console.log('[NUDGE] user_message sent (post-end)');
    } catch {}
    resetUtterance();
  }
}

// ---------- Outbound frame to Twilio (20ms) ----------
function sendOutboundFrame(twilioWs, streamSid, payloadB64, seq, chunk, tsMs) {
  twilioWs.send(JSON.stringify({
    event: 'media',
    streamSid,
    sequenceNumber: String(seq),
    media: { track: 'outbound', chunk: String(chunk), timestamp: String(tsMs), payload: payloadB64 }
  }));
  twilioWs.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: `el-chunk-${chunk}` }}));
  if (LOG_FRAMES_EVERY > 0 && (seq % LOG_FRAMES_EVERY === 0)) {
    console.log('[OUT] frame', { seq, chunk, tsMs, bytes: Buffer.from(payloadB64, 'base64').length });
  }
}

// ---------- EL connect (ws -> conversation fallback) ----------
function connectToELWithFallback({ agentId, phone, onOpen, onMetadata, onAudioFromEL, onClose }) {
  const endpoints = [
    `wss://api.elevenlabs.io/v1/convai/ws?agent_id=${encodeURIComponent(agentId)}`,
    `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${encodeURIComponent(agentId)}`
  ];
  const headers = { 'xi-api-key': ELEVENLABS_API_KEY };
  let which = 0;
  let elWs;

  const connect = () => {
    const ep = endpoints[which];
    console.log('[EL] connecting', { endpoint: ep.replace(/^wss:\/\/api\.elevenlabs\.io/, '...') });

    elWs = new WebSocket(ep, { headers });

    elWs.on('error', (err) => {
      const msg = err?.message || String(err);
      console.error('[EL] error', msg);
      try { elWs.close(); } catch {}
      if (which === 0) { which = 1; console.log('[EL] falling back to /conversation'); setTimeout(connect, 150); }
    });

    elWs.on('open', () => { console.log('[EL] connected (endpoint', which === 0 ? 'ws' : 'conversation', ')'); try { onOpen && onOpen(elWs); } catch {} });

    elWs.on('message', (data) => {
      let obj; try { obj = JSON.parse(data.toString()); } catch { console.log('[EL] non-JSON message', String(data).slice(0,300)); return; }
      if (obj && (obj.error || obj.type === 'error')) { console.error('[EL] ERROR payload', obj); return; }

      if (obj?.type === 'conversation_initiation_metadata') {
        const meta = obj.conversation_initiation_metadata_event || {};
        console.log('[EL] metadata', meta);
        try { onMetadata && onMetadata({
          user_input_audio_format: meta.user_input_audio_format,
          agent_output_audio_format: meta.agent_output_audio_format
        }); } catch {}
        return;
      }
      if (obj?.type === 'audio' && obj.audio_event?.audio_base_64) { try { onAudioFromEL && onAudioFromEL(obj.audio_event.audio_base_64); } catch {} return; }
      if (obj?.type === 'user_transcript') { console.log('[EL] user_transcript:', obj.user_transcription_event?.user_transcript); return; }
      if (obj?.type === 'agent_response') { console.log('[EL] agent_response:', obj.agent_response_event?.agent_response); return; }
      if (obj?.type === 'ping') { try { elWs.send(JSON.stringify({ type:'pong', event_id: obj.ping_event?.event_id })); } catch {} return; }

      console.log('[EL] event (unhandled)', obj);
    });

    elWs.on('close', (code, reason) => {
      console.log('[EL] closed', { code, reason: reason?.toString() });
      try { onClose && onClose(); } catch {}
      if (which === 0 && code !== 1000) { which = 1; console.log('[EL] closed on /ws — retrying /conversation'); setTimeout(connect, 150); }
    });
  };

  connect();
  return elWs;
}

// ================== Audio helpers ==================
function pcm16ToMuLaw(pcm) {
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    let sample = pcm[i]; let sign = (sample < 0) ? 0x80 : 0;
    if (sample < 0) sample = -sample; if (sample > 32635) sample = 32635;
    sample += 132; let exponent = 7;
    for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) exponent--;
    const mantissa = (sample >> (exponent + 3)) & 0x0F;
    out[i] = ~(sign | (exponent << 4) | mantissa) & 0xFF;
  }
  return out;
}
function downsamplePcm16Mono16kTo8k(pcm16kBuf) {
  const in16 = new Int16Array(pcm16kBuf.buffer, pcm16kBuf.byteOffset, Math.floor(pcm16kBuf.byteLength / 2));
  const out = new Int16Array(Math.floor(in16.length / 2));
  for (let i = 0, j = 0; j < out.length; i += 2, j++) out[j] = in16[i];
  return out;
}
