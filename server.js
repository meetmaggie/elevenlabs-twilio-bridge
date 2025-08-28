// server.js — ElevenLabs <-> Twilio bridge (robust EL->Twilio audio handling)
const http = require('http');
const url = require('url');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const BRIDGE_AUTH_TOKEN   = process.env.BRIDGE_AUTH_TOKEN;       // must match the <Parameter token="..."> you send in TwiML
const ELEVENLABS_API_KEY  = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID || process.env.ELEVENLABS_DISCOVERY_AGENT_ID;

if (!BRIDGE_AUTH_TOKEN || !ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID) {
  console.error('[BOOT] Missing env BRIDGE_AUTH_TOKEN / ELEVENLABS_API_KEY / ELEVENLABS_AGENT_ID');
}

const server = http.createServer((req, res) => {
  const { pathname } = url.parse(req.url);
  if (pathname === '/' || pathname === '/health') {
    res.writeHead(200, {'content-type':'text/plain'}); res.end('ok');
  } else if (pathname === '/test') {
    res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({ok:true,ts:Date.now()}));
  } else {
    res.writeHead(404); res.end('not found');
  }
});

const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const { pathname, query } = url.parse(req.url, true);
  if (pathname !== '/ws') return socket.destroy();

  // optional early reject if a query token is present but wrong
  if (query?.token && query.token !== BRIDGE_AUTH_TOKEN) {
    console.warn('[UPGRADE] rejected — BAD TOKEN via query');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

// Helper: pull a base64 audio string from any EL message shape
function pickElAudioB64(msg) {
  const cands = [
    msg?.audio,                               // many SDKs
    msg?.audio_base64,
    msg?.audio_base_64,
    msg?.audio_event?.audio,                  // some convo SDKs
    msg?.audio_event?.audio_base64,
    msg?.audio_event?.audio_base_64,
    msg?.tts_event?.audio_base_64,
    msg?.response?.audio,
    msg?.chunk?.audio
  ];
  for (const s of cands) {
    if (typeof s === 'string' && s.length > 32) return s;
  }
  // last resort: walk one level deep and grab a long base64-ish string
  for (const [k, v] of Object.entries(msg || {})) {
    if (typeof v === 'string' && v.length > 128 && /^[A-Za-z0-9+/=]+$/.test(v)) return v;
    if (v && typeof v === 'object') {
      for (const [k2, v2] of Object.entries(v)) {
        if (typeof v2 === 'string' && v2.length > 128 && /^[A-Za-z0-9+/=]+$/.test(v2)) return v2;
      }
    }
  }
  return null;
}

async function connectEleven(agentId) {
  // Prefer signed URL; fall back to direct WSS if needed
  try {
    const signedResp = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${encodeURIComponent(agentId)}`,
      { headers: { 'xi-api-key': ELEVENLABS_API_KEY } }
    );
    if (!signedResp.ok) throw new Error(`[EL] get-signed-url failed: ${signedResp.status}`);
    const { signed_url } = await signedResp.json();
    const ws = new WebSocket(signed_url);
    return await new Promise((resolve, reject) => {
      ws.once('open', () => { console.log('[EL] connected (signed)'); resolve(ws); });
      ws.once('error', (e) => reject(e));
    });
  } catch (e) {
    console.warn('[EL] signed-url failed; falling back to direct WSS');
    const direct = new WebSocket(`wss://api.elevenlabs.io/v1/convai/twilio?agent_id=${encodeURIComponent(agentId)}`, {
      headers: { 'xi-api-key': ELEVENLABS_API_KEY }
    });
    return await new Promise((resolve, reject) => {
      direct.once('open', () => { console.log('[EL] connected (direct)'); resolve(direct); });
      direct.once('error', (err) => reject(err));
    });
  }
}

wss.on('connection', async (twilioWs, req) => {
  console.log('[WS] connected from', (req.socket && req.socket.remoteAddress) || 'client');

  let streamSid = null;
  let authed = false;
  let agentId = ELEVENLABS_AGENT_ID;
  let elWs = null;

  // Connect to EL as soon as we know the agent/token (after 'start')
  async function ensureEl() {
    if (elWs) return;
    try {
      elWs = await connectEleven(agentId);
    } catch (e) {
      console.error('[EL] connect failed:', e?.message || e);
      try { twilioWs.close(1011, 'elevenlabs-connect-failed'); } catch {}
    }
    if (!elWs) return;

    // EL -> Twilio
    elWs.on('message', (buf) => {
      let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }

      // 1) agent audio back to phone
      const b64 = pickElAudioB64(msg);
      if (b64 && streamSid) {
        twilioWs.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: b64 }              // Twilio expects PCMU μ-law 8k base64; you set this in EL agent (TTS output μ-law 8000 Hz)
        }));
        if (process.env.DEBUG_AUDIO === '1') {
          console.log(`[EL->TWILIO] ${Math.round(b64.length / 1024)}KB base64`);
        }
      }

      // 2) interruptions / barge-in
      if (msg.type === 'interruption' && streamSid) {
        twilioWs.send(JSON.stringify({ event: 'clear', streamSid }));
      }

      // 3) ping/pong keepalive
      if (msg.type === 'ping' && msg.ping_event?.event_id) {
        elWs.send(JSON.stringify({ type: 'pong', event_id: msg.ping_event.event_id }));
      }
    });

    elWs.on('close', (code, reason) => {
      console.log('[EL] closed:', code, reason?.toString() || '');
      try { twilioWs.close(code, reason); } catch {}
    });

    elWs.on('error', (e) => console.error('[EL] error:', e?.message || e));
  }

  // Twilio -> EL
  twilioWs.on('message', async (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }

    if (msg.event === 'start') {
      streamSid = msg.start?.streamSid || null;

      // auth from customParameters
      const token = msg.start?.customParameters?.token;
      const agentFromTwiML = msg.start?.customParameters?.agent_id;  // optional override
      if (agentFromTwiML) agentId = agentFromTwiML;

      if (token && token === BRIDGE_AUTH_TOKEN) {
        authed = true;
        console.log('[WS] start: token accepted via customParameters');
      } else {
        console.warn('[WS] start: missing/invalid token');
        try { return twilioWs.close(1008, 'bad-token'); } catch {}
      }

      console.log(`[WS] start; streamSid = ${streamSid} agent = (default) → ${agentId}`);
      await ensureEl();
      return;
    }

    if (msg.event === 'media') {
      // Only forward caller mic (inbound) to EL
      const isInbound = (msg.media?.track ? msg.media.track === 'inbound' : true);
      if (isInbound && msg.media?.payload && elWs && authed) {
        // Send Twilio μ-law 8k base64 chunk as user audio to EL
        elWs.send(JSON.stringify({ user_audio_chunk: msg.media.payload }));
      }
      return;
    }

    if (msg.event === 'stop') {
      console.log('[WS] stop');
      try { elWs?.close(1000, 'stop'); } catch {}
      try { twilioWs.close(1000, 'stop'); } catch {}
      return;
    }
  });

  twilioWs.on('close', (code, reason) => {
    console.log('[WS] closed:', code, reason?.toString() || '');
    try { elWs?.close(code, reason); } catch {}
  });

  twilioWs.on('error', (e) => console.error('[WS] error', e?.message || e));
});

server.listen(PORT, () => console.log(`[HTTP] listening on :${PORT}`));

