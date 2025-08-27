// server.js — Railway WebSocket bridge: Twilio Media Streams ⇄ ElevenLabs Conversational AI
'use strict';

const http = require('http');
const url = require('url');
const WebSocket = require('ws');

// ----- Env -----
const PORT = process.env.PORT || 8080;
const BRIDGE_AUTH_TOKEN = process.env.BRIDGE_AUTH_TOKEN || ''; // must match Replit TwiML <Parameter token>
const XI_API_KEY = process.env.ELEVENLABS_API_KEY || '';
// Default agent (Phase 1). You can also pass agent via customParameters (see below).
const AGENT_DEFAULT = process.env.ELEVENLABS_AGENT_ID || '';
// Optional: second agent. If provided, you can select via customParameters.agent = 'daily'.
const AGENT_DISCOVERY = process.env.ELEVENLABS_DISCOVERY_AGENT_ID || '';
const AGENT_DAILY = process.env.ELEVENLABS_DAILY_AGENT_ID || '';

if (!XI_API_KEY || !AGENT_DEFAULT) {
  console.error('[BOOT] Missing ELEVENLABS_API_KEY or ELEVENLABS_AGENT_ID');
}

function chooseAgent(agentParam) {
  const a = String(agentParam || '').toLowerCase();
  if (a === 'daily' && AGENT_DAILY) return AGENT_DAILY;
  if (a === 'discovery' && AGENT_DISCOVERY) return AGENT_DISCOVERY;
  // fall back to default
  return AGENT_DEFAULT;
}

// Fetch a signed ElevenLabs WS URL for a given agent_id
async function getSignedUrl(agentId) {
  const signedUrlEndpoint =
    `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`;
  const res = await fetch(signedUrlEndpoint, { headers: { 'xi-api-key': XI_API_KEY } });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`[EL] get-signed-url failed: ${res.status} ${txt}`);
  }
  const body = await res.json();
  if (!body?.signed_url) throw new Error('[EL] signed_url missing in response');
  return body.signed_url;
}

// ----- HTTP server -----
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

// ----- WS server -----
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const { pathname, query } = url.parse(req.url, true);
  console.log('[UPGRADE] path:', pathname);
  if (pathname !== '/ws' && pathname !== '/ws/') {
    console.log('[UPGRADE] rejected — wrong path');
    return socket.destroy();
  }

  // Optional early check if a token was sent in the URL
  const qToken = query?.token;
  if (qToken && BRIDGE_AUTH_TOKEN && qToken !== BRIDGE_AUTH_TOKEN) {
    console.log('[UPGRADE] rejected — BAD TOKEN in query');
    return socket.destroy();
  }

  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, qToken));
});

wss.on('connection', (twilioWs, req, tokenFromQuery) => {
  console.log('[WS] connected from', req.socket.remoteAddress);

  let authorized = !!tokenFromQuery || !BRIDGE_AUTH_TOKEN; // if no token configured, allow
  let elevenWs = null;
  let streamSid = null;
  let closed = false;

  function safeSend(ws, data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(data); } catch {}
    }
  }

  function closeBoth(code = 1000, reason = 'normal') {
    if (closed) return;
    closed = true;
    try { twilioWs.close(code, reason); } catch {}
    try { elevenWs && elevenWs.close(code, reason); } catch {}
  }

  // Twilio -> (start) -> open ElevenLabs WS using signed URL for proper agent
  async function handleStart(msg) {
    streamSid = msg?.start?.streamSid || null;

    // Auth: prefer customParameters.token (Twilio best-practice)
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

    const agentParam = msg?.start?.customParameters?.agent || ''; // 'discovery' | 'daily' | ''
    const agentId = chooseAgent(agentParam);
    console.log('[WS] start; streamSid =', streamSid, 'agent =', agentParam || '(default)', '→', agentId);

    try {
      const signedUrl = await getSignedUrl(agentId);
      console.log('[EL] got signed_url');

      elevenWs = new WebSocket(signedUrl);
      elevenWs.on('open', () => console.log('[EL] connected'));
      elevenWs.on('error', (e) => console.error('[EL] error:', e.message));
      elevenWs.on('close', (c, r) => { console.log('[EL] closed:', c, String(r || '')); closeBoth(c, r); });
      elevenWs.on('message', (buf) => {
        let emsg; try { emsg = JSON.parse(String(buf)); } catch { return; }
        // ElevenLabs -> Twilio mappings
        if (emsg.type === 'audio' && emsg.audio_event?.audio_base_64 && streamSid) {
          // Send μ-law 8000 base64 back to Twilio
          const out = { event: 'media', streamSid, media: { payload: emsg.audio_event.audio_base_64 } };
          safeSend(twilioWs, JSON.stringify(out));
          return;
        }
        if (emsg.type === 'interruption' && streamSid) {
          safeSend(twilioWs, JSON.stringify({ event: 'clear', streamSid }));
          return;
        }
        if (emsg.type === 'ping' && emsg.ping_event?.event_id) {
          // keepalive
          safeSend(elevenWs, JSON.stringify({ type: 'pong', event_id: emsg.ping_event.event_id }));
          return;
        }
        // Other events (ready/transcript/response metadata) — ignore or log lightly
        if (emsg.type && emsg.type !== 'pong') {
          // console.log('[EL] event:', emsg.type);
        }
      });
    } catch (e) {
      console.error(String(e));
      return closeBoth(1011, 'elevenlabs-connect-failed');
    }
  }

  // Twilio -> ElevenLabs
  twilioWs.on('message', (buf) => {
    let tmsg; try { tmsg = JSON.parse(String(buf)); } catch { return; }

    switch (tmsg.event) {
      case 'connected':
        // seen on some accounts; nothing to do
        // console.log('[WS] connected event');
        break;

      case 'start':
        handleStart(tmsg);
        break;

      case 'media':
        // only forward caller audio (inbound); Twilio sends mulaw/8000 in base64
        if (authorized && elevenWs && elevenWs.readyState === WebSocket.OPEN) {
          const p = tmsg?.media?.payload;
          const track = tmsg?.media?.track; // may be undefined
          if (p && (!track || track === 'inbound')) {
            safeSend(elevenWs, JSON.stringify({ user_audio_chunk: p }));
          }
        }
        break;

      case 'mark':
        // optional: could be used for barge-in timing — ignore
        break;

      case 'stop':
        console.log('[WS] stop');
        closeBoth(1000, 'stop');
        break;

      default:
        // console.log('[WS] event:', tmsg.event);
        break;
    }
  });

  // Close cascades
  twilioWs.on('close', (c, r) => { console.log('[WS] closed:', c, String(r || '')); closeBoth(c, r); });
  twilioWs.on('error', (e) => { console.error('[WS] error:', e.message); closeBoth(1011, e.message); });
});

// ----- Listen -----
server.listen(PORT, '0.0.0.0', () => console.log(`[HTTP] listening on :${PORT}`));




