// server.js — Twilio <-> ElevenLabs ConvAI bridge with Clarice voice override
// --------------------------------------------------

const http = require('http');
const url = require('url');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 8080;
const BRIDGE_AUTH_TOKEN = process.env.BRIDGE_AUTH_TOKEN || null;

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || null;
const DISCOVERY_ID = process.env.ELEVENLABS_DISCOVERY_AGENT_ID || null;
const DAILY_ID = process.env.ELEVENLABS_DAILY_AGENT_ID || null;
const EL_VOICE_ID = process.env.EL_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'; // Rachel fallback
const EL_WELCOME = process.env.EL_WELCOME || "Hi there! I'm your assistant. How can I help today?";
const LOOPBACK_ONLY = (process.env.LOOPBACK_ONLY || '').trim() === '1';

// ---------- HTTP ----------
const server = http.createServer((req, res) => {
  if (req.url === '/health') return res.writeHead(200, {'Content-Type':'text/plain'}).end('ok');
  if (req.url === '/' || req.url === '/status') return res.writeHead(200, {'Content-Type':'text/plain'}).end('voice-bridge: up');
  res.writeHead(404, {'Content-Type':'text/plain'}).end('not found');
});

// ---------- WS ----------
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const { pathname, query } = url.parse(req.url, true);
  if (pathname !== '/ws') return socket.destroy();
  if (BRIDGE_AUTH_TOKEN && query.token !== BRIDGE_AUTH_TOKEN) return socket.destroy();
  req.__query = query || {};
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (twilioWs, req) => {
  console.log('[WS] CONNECTED via upgrade', req.url);
  attachBridgeHandlers(twilioWs);
});

// ---------- Lifecycle ----------
setInterval(() => console.log('[HEARTBEAT] alive', new Date().toISOString()), 60_000);
process.on('SIGTERM', () => { try { server.close(() => process.exit(0)); } catch { process.exit(0); }});
server.listen(PORT, () => console.log(`[HTTP] listening on :${PORT}`));

// ============================================================================
// BRIDGE HANDLERS
// ============================================================================

function attachBridgeHandlers(twilioWs) {
  let sawFirstMedia = false;
  let twilioStreamSid = null;
  let elWs = null, elReady = false;
  let elInFormat = null, elOutFormat = null;

  let outboundSeq = 0, outboundChunk = 0, outboundTimestampMs = 0;
  const pendingCallerChunks = [];

  twilioWs.on('message', (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
    const event = msg?.event;

    if (event === 'start') {
      twilioStreamSid = msg.streamSid;
      const cp = msg.start?.customParameters || {};
      const agentId = cp.agentId || DISCOVERY_ID;
      const phone = cp.caller_phone || '';
      console.log('[TWILIO] start', { streamSid: twilioStreamSid, agentId, phone });

      if (LOOPBACK_ONLY) return;

      elWs = connectToElevenLabs({
        agentId, phone,
        onMetadata: (m) => {
          elInFormat = m.user_input_audio_format;
          elOutFormat = m.agent_output_audio_format;
          console.log('[EL] metadata', m);
          elReady = true;
          outboundSeq = 0; outboundChunk = 0; outboundTimestampMs = 0;
          for (const b of pendingCallerChunks) elWs.send(JSON.stringify({ user_audio_chunk: b }));
        },
        onAudioFromEL: (audioB64) => {
          console.log('[EL->TWILIO] audio chunk', { len: Buffer.from(audioB64, 'base64').length, format: elOutFormat });
          const u = Buffer.from(audioB64, 'base64');
          const FRAME = 160;
          for (let off = 0; off < u.length; off += FRAME) {
            const slice = u.subarray(off, Math.min(off + FRAME, u.length));
            sendOutboundMediaFrame(twilioWs, twilioStreamSid, slice.toString('base64'), ++outboundSeq, ++outboundChunk, outboundTimestampMs);
            outboundTimestampMs += 20;
          }
        }
      });
      return;
    }

    if (event === 'media') {
      if (!sawFirstMedia) { sawFirstMedia = true; console.log('[TWILIO] first media frame received'); }
      const muLawB64 = msg?.media?.payload; if (!muLawB64) return;
      if (LOOPBACK_ONLY) {
        sendOutboundMediaFrame(twilioWs, twilioStreamSid, muLawB64, ++outboundSeq, ++outboundChunk, outboundTimestampMs);
        outboundTimestampMs += 20; return;
      }
      if (elWs && elWs.readyState === WebSocket.OPEN) {
        if (elReady) elWs.send(JSON.stringify({ user_audio_chunk: muLawB64 }));
        else pendingCallerChunks.push(muLawB64);
      }
      return;
    }
  });
}

// ============================================================================
// OUTBOUND HELPERS
// ============================================================================
function sendOutboundMediaFrame(twilioWs, streamSid, payloadB64, seq, chunk, tsMs) {
  twilioWs.send(JSON.stringify({
    event: 'media', streamSid,
    sequenceNumber: String(seq),
    media: { track: 'outbound', chunk: String(chunk), timestamp: String(tsMs), payload: payloadB64 }
  }));
  twilioWs.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: `el-chunk-${chunk}` }}));
  console.log('[OUT] frame', { seq, chunk, tsMs, bytes: Buffer.from(payloadB64, 'base64').length });
}

// ============================================================================
// ELEVENLABS CONNECT
// ============================================================================
function connectToElevenLabs({ agentId, phone, onMetadata, onAudioFromEL }) {
  const endpoints = [
    `wss://api.elevenlabs.io/v1/convai/ws?agent_id=${encodeURIComponent(agentId)}`,
    `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${encodeURIComponent(agentId)}`
  ];
  let which = 0;
  const headers = { 'xi-api-key': ELEVENLABS_API_KEY };
  let elWs = null;

  function tryConnect() {
    const endpoint = endpoints[which];
    console.log('[EL] connecting', { endpoint: endpoint.replace(/^wss:\/\/api\.elevenlabs\.io/, '...') });
    elWs = new WebSocket(endpoint, { headers });

    elWs.on('open', () => {
      console.log('[EL] connected (endpoint', which === 0 ? 'ws' : 'conversation', ')');
      const init = {
        type: "conversation_initiation_client_data",
        conversation_config_override: {
          agent: { first_message: EL_WELCOME, language: "en" },
          tts: { voice_id: EL_VOICE_ID }
        },
        dynamic_variables: { caller_phone: phone }
      };
      elWs.send(JSON.stringify(init));
      console.log('[EL] sent init with explicit tts.voice_id:', EL_VOICE_ID);

      // nudge timers
      setTimeout(() => { elWs.send(JSON.stringify({ type:"user_message", text:"Hello" })); console.warn('[EL] first nudge sent'); }, 2000);
      setTimeout(() => { elWs.send(JSON.stringify({ type:"user_message", text:"Are you there?" })); console.warn('[EL] second nudge sent'); }, 3000);
    });

    elWs.on('message', (data) => {
      let obj; try { obj = JSON.parse(data.toString()); } catch { console.log('[EL] non-JSON', String(data)); return; }
      if (obj.error || obj.type === 'error') console.error('[EL] ERROR payload', obj);
      if (obj.type === 'conversation_initiation_metadata') { onMetadata(obj.conversation_initiation_metadata_event || {}); return; }
      if (obj.type === 'audio' && obj.audio_event?.audio_base_64) { onAudioFromEL(obj.audio_event.audio_base_64); return; }
      console.log('[EL] event', obj.type, obj);
    });

    elWs.on('close', (c, r) => {
      console.log('[EL] closed', { code: c, reason: r?.toString() });
      if (which === 0) { which = 1; setTimeout(tryConnect, 250); }
    });
  }
  tryConnect();
  return elWs;
}
