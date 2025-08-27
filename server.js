// server.js — Twilio Media Streams ⇄ ElevenLabs Agent (robust: signed-url with fallback)
'use strict';
const http = require('http');
const url = require('url');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const BRIDGE_AUTH_TOKEN = process.env.BRIDGE_AUTH_TOKEN || '';
const XI_API_KEY = process.env.ELEVENLABS_API_KEY || '';
// Default agent; you can also add ELEVENLABS_DISCOVERY_AGENT_ID / ELEVENLABS_DAILY_AGENT_ID later
const AGENT_DEFAULT = process.env.ELEVENLABS_AGENT_ID || '';

if (!XI_API_KEY || !AGENT_DEFAULT) {
  console.error('[BOOT] Missing ELEVENLABS_API_KEY or ELEVENLABS_AGENT_ID');
}

// ---------- utils ----------
function chooseAgent(agentParam) {
  return AGENT_DEFAULT; // simple for now; add switching later if you want
}

function safeSend(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(data); } catch {}
  }
}

function logErrPrefix(e) {
  return (e && e.message) ? e.message : String(e);
}

// Signed URL (first choice)
async function getSignedUrl(agentId) {
  const endpoint = `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`;
  const res = await fetch(endpoint, { headers: { 'xi-api-key': XI_API_KEY } });
  const body = await res.text();
  if (!res.ok) throw new Error(`[EL] get-signed-url failed: ${res.status} ${body}`);
  const json = JSON.parse(body);
  if (!json?.signed_url) throw new Error('[EL] signed_url missing');
  return json.signed_url;
}

// Direct WSS (fallback)
function openDirectWss(agentId) {
  const directUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${encodeURIComponent(agentId)}`;
  return new WebSocket(directUrl, { headers: { 'xi-api-key': XI_API_KEY } });
}

// Open ElevenLabs connection with fallback
async function connectEleven(agentId) {
  try {
    const signedUrl = await getSignedUrl(agentId);           // 1) try signed URL
    console.log('[EL] got signed_url');
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(signedUrl);
      ws.on('open', () => { console.log('[EL] connected (signed)'); resolve(ws); });
      ws.on('error', (e) => { console.error('[EL] error (signed):', logErrPrefix(e)); reject(e); });
    });
  } catch (e) {
    console.warn('[EL] signed-url failed; falling back to direct WSS');
    return new Promise((resolve, reject) => {
      const ws = openDirectWss(agentId);                     // 2) fallback to direct WSS
      ws.on('open', () => { console.log('[EL] connected (direct)'); resolve(ws); });
      ws.on('error', (err) => { console.error('[EL] error (direct):', logErrPrefix(err)); reject(err); });
    });
  }
}

// ---------- HTTP ----------
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok');
  }
  if (req.method === 'GET' && req.url === '/test') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, ts: Date.now() }));
  }
  res.writeHead(404); res.end('not found');
});

// ---------- WebSocket bridge ----------
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const { pathname, query } = url.parse(req.url, true);
  console.log('[UPGRADE] path:', pathname);
  if (pathname !== '/ws' && pathname !== '/ws/') {
    console.log('[UPGRADE] rejected — wrong path');
    return socket.destroy();
  }
  // optional early token check if provided in query
  const qToken = query?.token;
  if (qToken && BRIDGE_AUTH_TOKEN && qToken !== BRIDGE_AUTH_TOKEN) {
    console.log('[UPGRADE] rejected — BAD TOKEN (query)');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, qToken));
});

wss.on('connection', (twilioWs, req, tokenFromQuery) => {
  console.log('[WS] connected from', req.socket.remoteAddress);

  let authorized = !!tokenFromQuery || !BRIDGE_AUTH_TOKEN;
  let elevenWs = null;
  let streamSid = null;
  let closed = false;

  function closeBoth(code = 1000, reason = 'normal') {
    if (closed) return; closed = true;
    try { twilioWs.close(code, reason); } catch {}
    try { elevenWs && elevenWs.close(code, reason); } catch {}
  }

  async function handleStart(msg) {
    streamSid = msg?.start?.streamSid || null;

    // Prefer Twilio customParameters for token
    const token = msg?.start?.customParameters?.token || '';
    if (!authorized) {
      if (BRIDGE_AUTH_TOKEN && token === BRIDGE_AUTH_TOKEN) {
        authorized = true;
        console.log('[WS] start: token accepted via customParameters');
      } else {
        console.log('[WS] start: BAD/MISSING token — closing');
        return closeBoth(1008, 'unauthorized');
      }
    }

    const agentParam = msg?.start?.customParameters?.agent || '';
    const agentId = chooseAgent(agentParam);
    console.log('[WS] start; streamSid =', streamSid, 'agent =', agentParam || '(default)', '→', agentId);

    try {
      elevenWs = await connectEleven(agentId);
    } catch (e) {
      console.error('[EL] connect failed:', logErrPrefix(e));
      return closeBoth(1011, 'elevenlabs-connect-failed');
    }

    // ElevenLabs -> Twilio
    elevenWs.on('message', (buf) => {
      let emsg; try { emsg = JSON.parse(String(buf)); } catch { return; }
      if (emsg.type === 'audio' && emsg.audio_event?.audio_base_64 && streamSid) {
        const out = { event: 'media', streamSid, media: { payload: emsg.audio_event.audio_base_64 } };
        safeSend(twilioWs, JSON.stringify(out));
        return;
      }
      if (emsg.type === 'interruption' && streamSid) {
        safeSend(twilioWs, JSON.stringify({ event: 'clear', streamSid }));
        return;
      }
      if (emsg.type === 'ping' && emsg.ping_event?.event_id) {
        safeSend(elevenWs, JSON.stringify({ type: 'pong', event_id: emsg.ping_event.event_id }));
        return;
      }
      // other events (transcripts, responses) — ignore/log if needed
    });

    elevenWs.on('close', (c, r) => { console.log('[EL] closed:', c, String(r || '')); closeBoth(c, r); });
    elevenWs.on('error', (e) => { console.error('[EL] error:', logErrPrefix(e)); });
  }

  // Twilio -> ElevenLabs
  twilioWs.on('message', (buf) => {
    let tmsg; try { tmsg = JSON.parse(String(buf)); } catch { return; }

    switch (tmsg.event) {
      case 'connected':
        // some accounts send this first — nothing to do
        break;

      case 'start':
        handleStart(tmsg);
        break;

      case 'media':
        if (authorized && elevenWs && elevenWs.readyState === WebSocket.OPEN) {
          const p = tmsg?.media?.payload;
          const track = tmsg?.media?.track;
          if (p && (!track || track === 'inbound')) {
            // Twilio sends μ-law 8000 base64; forward as user_audio_chunk
            safeSend(elevenWs, JSON.stringify({ user_audio_chunk: p }));
          }
        }
        break;

      case 'stop':
        console.log('[WS] stop'); closeBoth(1000, 'stop'); break;

      default:
        break;
    }
  });

  twilioWs.on('close', (c, r) => { console.log('[WS] closed:', c, String(r || '')); closeBoth(c, r); });
  twilioWs.on('error', (e) => { console.error('[WS] error:', logErrPrefix(e)); closeBoth(1011, e.message); });
});

// ---------- listen ----------
server.listen(PORT, '0.0.0.0', () => console.log(`[HTTP] listening on :${PORT}`));




