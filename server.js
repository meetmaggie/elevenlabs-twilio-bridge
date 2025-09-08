// server.js — Twilio <-> ElevenLabs bridge (no overrides + barge-in hint + simple VAD)
// Env (Railway -> Variables):
//   ELEVENLABS_API_KEY          (required)
//   ELEVENLABS_DISCOVERY_AGENT_ID (required if not passed from Twilio)
//   ELEVENLABS_DAILY_AGENT_ID     (optional)
//   BRIDGE_AUTH_TOKEN             (optional)
//   NODE_ENV=production           (recommended)
//   LOOPBACK_ONLY=1               (optional echo test; remove for real calls)

const http = require('http');
const url = require('url');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 8080;
const BRIDGE_AUTH_TOKEN = process.env.BRIDGE_AUTH_TOKEN || null;

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || null;
const DISCOVERY_ID = process.env.ELEVENLABS_DISCOVERY_AGENT_ID || null;
const DAILY_ID = process.env.ELEVENLABS_DAILY_AGENT_ID || null;
const LOOPBACK_ONLY = (process.env.LOOPBACK_ONLY || '').trim() === '1';

// ---------------- HTTP (health) ----------------
const server = http.createServer((req, res) => {
  if (req.url === '/health') return res.writeHead(200, {'Content-Type':'text/plain'}).end('ok');
  if (req.url === '/' || req.url === '/status') return res.writeHead(200, {'Content-Type':'text/plain'}).end('voice-bridge: up');
  res.writeHead(404, {'Content-Type':'text/plain'}).end('not found');
});

// ---------------- WS endpoint for Twilio ----------------
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const { pathname, query } = url.parse(req.url, true);
  if (pathname !== '/ws' && pathname !== '/media-stream') return socket.destroy();
  if (BRIDGE_AUTH_TOKEN && (!query || query.token !== BRIDGE_AUTH_TOKEN)) return socket.destroy();
  req.__query = query || {};
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

wss.on('connection', (twilioWs) => attachBridgeHandlers(twilioWs));

setInterval(() => console.log('[HEARTBEAT] alive', new Date().toISOString()), 60_000);
process.on('SIGTERM', () => { try { server.close(() => process.exit(0)); } catch { process.exit(0); }});
server.listen(PORT, () => console.log(`[HTTP] listening on :${PORT}`));

// ================== Bridge core ==================
function attachBridgeHandlers(twilioWs) {
  let twilioStreamSid = null;
  let agentId = null, mode = 'discovery', phone = '', persist = '0';

  // EL state
  let elWs = null, elReady = false;
  let elInFormat = null, elOutFormat = null;

  // Outbound frame sequencing
  let seq = 0, chunk = 0, tsMs = 0;

  // Buffer caller frames until EL metadata arrives
  const bufferedCaller = [];

  // Nudge state (to avoid double intros)
  let nudge1 = null, nudge2 = null, elSpoke = false;

  // Barge-in helpers
  let elHasSpoken = false;           // agent has produced audio this turn
  let callerActiveNotified = false;  // we sent user_activity once per utterance

  // Simple VAD: send user_audio_end after short silence
  const SILENCE_MS = 700;
  let silenceTimer = null;
  let speaking = false;

  const armSilenceTimer = () => {
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      if (speaking && elWs && elWs.readyState === WebSocket.OPEN) {
        try {
          elWs.send(JSON.stringify({ type: "user_audio_end" }));
          console.log('[VAD] user_audio_end sent (silence)');
        } catch (e) {
          console.warn('[VAD] failed to send user_audio_end', e?.message || e);
        }
        speaking = false;
        // allow sending user_activity again on next utterance
        callerActiveNotified = false;
      }
    }, SILENCE_MS);
  };

  twilioWs.on('message', (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
    const event = msg?.event;

    if (event === 'connected') return;

    if (event === 'start') {
      const start = msg.start || {};
      twilioStreamSid = msg.streamSid || start.streamSid || null;

      const cp = start.customParameters || {};
      mode    = (cp.mode || 'discovery').toLowerCase();
      agentId = cp.agent_id || (mode === 'daily' ? DAILY_ID : DISCOVERY_ID);
      phone   = cp.caller_phone || '';
      persist = cp.persist === '1' ? '1' : '0';

      console.log('[TWILIO] start', { streamSid: twilioStreamSid, agentId, phone, LOOPBACK_ONLY });

      // reset per call
      seq = 0; chunk = 0; tsMs = 0;
      speaking = false;
      callerActiveNotified = false;
      elHasSpoken = false;
      elSpoke = false;
      clearTimeout(silenceTimer);
      clearTimeout(nudge1);
      clearTimeout(nudge2);

      if (!LOOPBACK_ONLY) {
        if (!ELEVENLABS_API_KEY) { console.error('❌ Missing ELEVENLABS_API_KEY'); return; }
        if (!agentId)            { console.error('❌ Missing agentId'); return; }

        elWs = connectToELWithFallback({
          agentId, phone,
          onOpen: () => {
            // Init WITHOUT overrides (agent controls voice/greeting/policy)
            const init = {
              type: "conversation_initiation_client_data",
              dynamic_variables: { caller_phone: phone || "" }
            };
            try {
              elWs.send(JSON.stringify(init));
              console.log('[EL] sent init (no overrides)');
            } catch (e) {
              console.error('[EL] failed to send init', e?.message || e);
            }
            // Gentle nudges ONLY if EL hasn't spoken yet; cancel once audio arrives
            nudge1 = setTimeout(() => {
              if (!elSpoke) {
                try { elWs.send(JSON.stringify({ type:"user_message", text:"Hello" })); } catch {}
                console.warn('[EL] first nudge sent');
              }
            }, 1200);
            nudge2 = setTimeout(() => {
              if (!elSpoke) {
                try { elWs.send(JSON.stringify({ type:"user_message", text:"Are you there?" })); } catch {}
                console.warn('[EL] second nudge sent');
              }
            }, 2500);
          },
          onMetadata: ({ user_input_audio_format, agent_output_audio_format }) => {
            elInFormat  = user_input_audio_format;
            elOutFormat = agent_output_audio_format;
            elReady = true;
            console.log('[EL] formats', { elInFormat, elOutFormat });

            if (bufferedCaller.length) {
              console.log(`[EL] flushing ${bufferedCaller.length} buffered chunks`);
              for (const b64 of bufferedCaller) sendUserChunkToEL(elWs, elInFormat, b64);
              bufferedCaller.length = 0;
            }
          },
          onAudioFromEL: (audioB64) => {
            // EL started talking: stop any nudges, mark spoken (enables barge-in hint)
            elSpoke = true;
            elHasSpoken = true;
            clearTimeout(nudge1);
            clearTimeout(nudge2);

            const bytes = Buffer.from(audioB64, 'base64').length;
            console.log('[EL->TWILIO] audio chunk', { len: bytes, format: elOutFormat });

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
          }
        });
      }
      return;
    }

    if (event === 'media') {
      const muLawB64 = msg?.media?.payload; if (!muLawB64) return;

      // mark caller speaking + arm VAD
      if (!speaking) {
        speaking = true;
        console.log('[VAD] user_started_speaking');
      }
      armSilenceTimer();

      // If agent has spoken and we haven't hinted yet, send user_activity (barge-in hint)
      if (elHasSpoken && !callerActiveNotified && elWs && elWs.readyState === WebSocket.OPEN) {
        try {
          elWs.send(JSON.stringify({ type: "user_activity" }));
          callerActiveNotified = true;
          console.log('[EL] user_activity sent (caller started talking)');
        } catch {}
      }

      if (LOOPBACK_ONLY) {
        sendOutboundFrame(twilioWs, twilioStreamSid, muLawB64, ++seq, ++chunk, tsMs);
        tsMs += 20;
        return;
      }

      if (elWs && elWs.readyState === WebSocket.OPEN) {
        if (elReady) {
          sendUserChunkToEL(elWs, elInFormat, muLawB64);
        } else {
          bufferedCaller.push(muLawB64);
        }
      }
      return;
    }

    if (event === 'mark') { console.log('[IN ] Twilio mark ack', msg.mark); return; }
    if (event === 'stop') {
      clearTimeout(silenceTimer);
      clearTimeout(nudge1);
      clearTimeout(nudge2);
      try { twilioWs.close(1000); } catch {}
      try { elWs && elWs.close(1000); } catch {}
      return;
    }
  });
}

// -------------- Send one 20ms frame to Twilio --------------
function sendOutboundFrame(twilioWs, streamSid, payloadB64, seq, chunk, tsMs) {
  twilioWs.send(JSON.stringify({
    event: 'media',
    streamSid,
    sequenceNumber: String(seq),
    media: { track: 'outbound', chunk: String(chunk), timestamp: String(tsMs), payload: payloadB64 }
  }));
  twilioWs.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: `el-chunk-${chunk}` }}));
  console.log('[OUT] frame', { seq, chunk, tsMs, bytes: Buffer.from(payloadB64, 'base64').length });
}

// -------------- Forward caller audio to EL in correct format --------------
function sendUserChunkToEL(elWs, elInFormat, muLawB64) {
  if (elInFormat === 'ulaw_8000') {
    elWs.send(JSON.stringify({ user_audio_chunk: muLawB64 }));
  } else {
    const muLawBuf  = Buffer.from(muLawB64, 'base64');
    const pcm16_8k  = muLawToPcm16(muLawBuf);
    const pcm16_16k = upsamplePcm16Mono8kTo16k(pcm16_8k);
    const b64_16k   = Buffer.from(pcm16_16k.buffer, pcm16_16k.byteOffset, pcm16_16k.byteLength).toString('base64');
    elWs.send(JSON.stringify({ user_audio_chunk: b64_16k }));
  }
}

// -------------- Robust EL connect with fallback; no overrides --------------
function connectToELWithFallback({ agentId, phone, onOpen, onMetadata, onAudioFromEL }) {
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

    // Attach error FIRST so 403 never crashes
    elWs.on('error', (err) => {
      const msg = err?.message || String(err);
      console.error('[EL] error', msg);
      try { elWs.close(); } catch {}
      if (which === 0) { which = 1; console.log('[EL] falling back to /conversation'); setTimeout(connect, 150); }
    });

    elWs.on('open', () => {
      console.log('[EL] connected (endpoint', which === 0 ? 'ws' : 'conversation', ')');
      try { onOpen && onOpen(); } catch {}
      // Send init with ONLY dynamic variables (no overrides)
      const init = {
        type: "conversation_initiation_client_data",
        dynamic_variables: { caller_phone: phone || "" }
      };
      try { elWs.send(JSON.stringify(init)); console.log('[EL] sent init (no overrides)'); }
      catch (e) { console.error('[EL] failed to send init', e?.message || e); }
    });

    elWs.on('message', (data) => {
      let obj; try { obj = JSON.parse(data.toString()); } catch { console.log('[EL] non-JSON message', String(data).slice(0,300)); return; }
      if (obj && (obj.error || obj.type === 'error')) { console.error('[EL] ERROR payload', obj); return; }

      if (obj?.type === 'conversation_initiation_metadata') {
        const meta = obj.conversation_initiation_metadata_event || {};
        console.log('[EL] metadata', meta);
        try { onMetadata && onMetadata({ user_input_audio_format: meta.user_input_audio_format, agent_output_audio_format: meta.agent_output_audio_format }); } catch {}
        return;
      }
      if (obj?.type === 'audio' && obj.audio_event?.audio_base_64) {
        try { onAudioFromEL && onAudioFromEL(obj.audio_event.audio_base_64); } catch {}
        return;
      }
      if (obj?.type === 'user_transcript') { console.log('[EL] user_transcript:', obj.user_transcription_event?.user_transcript); return; }
      if (obj?.type === 'agent_response') { console.log('[EL] agent_response:', obj.agent_response_event?.agent_response); return; }
      if (obj?.type === 'ping') { try { elWs.send(JSON.stringify({ type:'pong', event_id: obj.ping_event?.event_id })); } catch {} return; }

      console.log('[EL] event (unhandled)', obj);
    });

    elWs.on('close', (code, reason) => {
      console.log('[EL] closed', { code, reason: reason?.toString() });
      if (which === 0 && code !== 1000) { which = 1; console.log('[EL] closed on /ws — retrying /conversation'); setTimeout(connect, 150); }
    });
  };

  connect();
  return elWs;
}

// ================== Audio helpers ==================
function muLawToPcm16(muBuf) {
  const out = new Int16Array(muBuf.length);
  for (let i = 0; i < muBuf.length; i++) {
    const u = muBuf[i]; let x = ~u;
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
    let sample = pcm[i]; let sign = (sample < 0) ? 0x80 : 0;
    if (sample < 0) sample = -sample; if (sample > 32635) sample = 32635;
    sample += 132; let exponent = 7;
    for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) exponent--;
    const mantissa = (sample >> (exponent + 3)) & 0x0F;
    out[i] = ~(sign | (exponent << 4) | mantissa) & 0xFF;
  }
  return out;
}
function upsamplePcm16Mono8kTo16k(pcm8k) {
  const out = new Int16Array(pcm8k.length * 2);
  for (let i = 0, j = 0; i < pcm8k.length; i++, j += 2) { const s = pcm8k[i]; out[j] = s; out[j+1] = s; }
  return out;
}
function downsamplePcm16Mono16kTo8k(pcm16kBuf) {
  const in16 = new Int16Array(pcm16kBuf.buffer, pcm16kBuf.byteOffset, Math.floor(pcm16kBuf.byteLength / 2));
  const out = new Int16Array(Math.floor(in16.length / 2));
  for (let i = 0, j = 0; j < out.length; i += 2, j++) out[j] = in16[i];
  return out;
}

