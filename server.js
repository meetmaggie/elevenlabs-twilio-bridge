// server.js — Twilio <-> ElevenLabs bridge (bi-directional)
// Requires Node 18+ (global fetch). Set env:
//  BRIDGE_AUTH_TOKEN, ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID (default)
//  (optional) DEBUG_AUDIO=1
//  (optional) INTRO_DELAY_MS=2000   // how long to mute EL→Twilio at start

const http = require('http');
const url = require('url');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const BRIDGE_AUTH_TOKEN   = process.env.BRIDGE_AUTH_TOKEN || '';
const ELEVENLABS_API_KEY  = process.env.ELEVENLABS_API_KEY || '';
const DEFAULT_AGENT_ID    = process.env.ELEVENLABS_AGENT_ID || process.env.ELEVENLABS_DISCOVERY_AGENT_ID || '';
const INTRO_DELAY_MS      = parseInt(process.env.INTRO_DELAY_MS || '2000', 10);

if (!BRIDGE_AUTH_TOKEN || !ELEVENLABS_API_KEY || !DEFAULT_AGENT_ID) {
  console.error('[BOOT] Missing env: BRIDGE_AUTH_TOKEN / ELEVENLABS_API_KEY / ELEVENLABS_AGENT_ID');
}

const server = http.createServer((req, res) => {
  const { pathname } = url.parse(req.url);
  if (pathname === '/' || pathname === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok');
  } else if (pathname === '/test') {
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, ts: Date.now() }));
  } else {
    res.writeHead(404); res.end('not found');
  }
});

const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const { pathname, query } = url.parse(req.url, true);
  if (pathname !== '/ws') return socket.destroy();

  // Optional early reject if a query token is present but wrong
  if (query?.token && query.token !== BRIDGE_AUTH_TOKEN) {
    console.warn('[UPGRADE] rejected — BAD TOKEN via query');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

// --- helpers -----------------------------------------------------------------

// Pull base64 audio from various EL message shapes
function pickElAudioB64(msg) {
  const cands = [
    msg?.audio,
    msg?.audio_base64,
    msg?.audio_base_64,
    msg?.audio_event?.audio,
    msg?.audio_event?.audio_base64,
    msg?.audio_event?.audio_base_64,
    msg?.tts_event?.audio_base_64,
    msg?.response?.audio,
    msg?.chunk?.audio
  ];
  for (const s of cands) if (typeof s === 'string' && s.length > 32) return s;

  // last resort: scan one level deep for long base64-ish strings
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

async function connectEleven(agentId) {
  // Prefer signed URL; fall back to direct WSS
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
    const direct = new WebSocket(
      `wss://api.elevenlabs.io/v1/convai/twilio?agent_id=${encodeURIComponent(agentId)}`,
      { headers: { 'xi-api-key': ELEVENLABS_API_KEY } }
    );
    return await new Promise((resolve, reject) => {
      direct.once('open', () => { console.log('[EL] connected (direct)'); resolve(direct); });
      direct.once('error', (err) => reject(err));
    });
  }
}

// --- bridge ------------------------------------------------------------------

wss.on('connection', async (twilioWs, req) => {
  console.log('[WS] connected from', req.socket?.remoteAddress || 'client');

  let streamSid = null;
  let authed = false;
  let agentId = DEFAULT_AGENT_ID;
  let elWs = null;

  // --- Option A: "initial mute" state ---------------------------------------
  let allowOutbound = false;           // gate for EL->Twilio audio
  let introTimer = null;               // timer handle
  let callActive = true;               // used to avoid talking after hangup

  function startIntroDelay() {
    if (introTimer) return; // already set
    console.log(`[DELAY] Muting EL→Twilio for ${INTRO_DELAY_MS}ms at call start`);
    allowOutbound = false;
    introTimer = setTimeout(() => {
      introTimer = null;
      if (!callActive) return;
      allowOutbound = true;
      console.log('[DELAY] Initial mute finished — allowing EL→Twilio audio');
      // Note: If EL already tried to greet during mute, that audio is dropped.
      // The next EL utterance will pass through normally.
    }, INTRO_DELAY_MS);
  }

  function clearIntroDelay() {
    if (introTimer) {
      clearTimeout(introTimer);
      introTimer = null;
    }
  }

  async function ensureEl() {
    if (elWs) return;
    try {
      elWs = await connectEleven(agentId);
    } catch (e) {
      console.error('[EL] connect failed:', e?.message || e);
      try { twilioWs.close(1011, 'elevenlabs-connect-failed'); } catch {}
      return;
    }

    // --- EL -> Twilio (agent speech to phone)
    elWs.on('message', (buf) => {
      let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }

      // audio back to Twilio phone (PCMU μ-law 8k base64 required)
      const b64 = pickElAudioB64(msg);
      if (b64 && streamSid) {
        // Gate outbound audio until initial delay finishes
        if (!allowOutbound) {
          if (process.env.DEBUG_AUDIO === '1') {
            console.log('[EL->TWILIO] (dropped due to initial mute window)');
          }
        } else {
          twilioWs.send(JSON.stringify({
            event: 'media',
            streamSid,
            media: { payload: b64 }
          }));
          if (process.env.DEBUG_AUDIO === '1') {
            console.log(`[EL->TWILIO] ${Math.round(b64.length / 1024)}KB base64`);
          }
        }
      }

      // barge-in
      if (msg.type === 'interruption' && streamSid && allowOutbound) {
        // Only clear if we are already allowing audio through
        twilioWs.send(JSON.stringify({ event: 'clear', streamSid }));
      }

      // keepalive
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

  // --- Twilio -> EL (caller mic to agent)
  twilioWs.on('message', async (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }

    if (msg.event === 'start') {
      streamSid = msg.start?.streamSid || null;

      // token & agent from customParameters (accept both agent and agent_id)
      const cp = msg.start?.customParameters || {};
      const token = cp.token;
      const agentFromTwiML = cp.agent || cp.agent_id;
      if (agentFromTwiML) agentId = agentFromTwiML;

      if (token === BRIDGE_AUTH_TOKEN) {
        authed = true;
        console.log('[WS] start: token accepted via customParameters');
      } else {
        console.warn('[WS] start: missing/invalid token');
        try { return twilioWs.close(1008, 'bad-token'); } catch {}
      }

      console.log(`[WS] start; streamSid = ${streamSid} agent = (default) → ${agentId}`);
      // Kick off initial mute window BEFORE connecting EL (so early audio is dropped)
      startIntroDelay();

      await ensureEl();
      return;
    }

    if (msg.event === 'media') {
      // Only forward caller inbound mic
      const inbound = (msg.media?.track ? msg.media.track === 'inbound' : true);
      if (inbound && msg.media?.payload && elWs && authed) {
        elWs.send(JSON.stringify({ user_audio_chunk: msg.media.payload }));
      }
      return;
    }

    if (msg.event === 'stop') {
      console.log('[WS] stop');
      callActive = false;
      clearIntroDelay();
      try { elWs?.close(1000, 'stop'); } catch {}
      try { twilioWs.close(1000, 'stop'); } catch {}
      return;
    }
  });

  twilioWs.on('close', (code, reason) => {
    console.log('[WS] closed:', code, reason?.toString() || '');
    callActive = false;
    clearIntroDelay();
    try { elWs?.close(code, reason); } catch {}
  });

  twilioWs.on('error', (e) => {
    console.error('[WS] error', e?.message || e);
    // On error, be safe and stop the timer
    callActive = false;
    clearIntroDelay();
  });
});

server.listen(PORT, () => console.log(`[HTTP] listening on :${PORT}`));



