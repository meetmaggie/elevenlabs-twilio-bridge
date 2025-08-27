// server.js — Twilio Media Streams ⇄ ElevenLabs Agent (with agent switching + robust connect)
'use strict';
const http = require('http');
const url = require('url');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const BRIDGE_AUTH_TOKEN = process.env.BRIDGE_AUTH_TOKEN || '';
const XI_API_KEY = process.env.ELEVENLABS_API_KEY || '';

// Agent envs — you can set any/all of these in Railway
const AGENT_DEFAULT   = process.env.ELEVENLABS_AGENT_ID || '';
const AGENT_DISCOVERY = process.env.ELEVENLABS_DISCOVERY_AGENT_ID || '';
const AGENT_DAILY     = process.env.ELEVENLABS_DAILY_AGENT_ID || '';

function pickAgent(agentParam) {
  const a = String(agentParam || '').toLowerCase();
  if (a === 'daily' && AGENT_DAILY) return AGENT_DAILY;
  if (a === 'discovery' && AGENT_DISCOVERY) return AGENT_DISCOVERY;
  // fallback order: default, discovery, daily
  return AGENT_DEFAULT || AGENT_DISCOVERY || AGENT_DAILY || '';
}

if (!XI_API_KEY) {
  console.error('[BOOT] Missing ELEVENLABS_API_KEY');
}

// -------- helpers --------
function safeSend(ws, data){ if (ws && ws.readyState === WebSocket.OPEN) { try{ ws.send(data);}catch{} } }
function errMsg(e){ return (e && e.message) ? e.message : String(e); }

async function getSignedUrl(agentId) {
  const endpoint = `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`;
  const res = await fetch(endpoint, { headers: { 'xi-api-key': XI_API_KEY } });
  const body = await res.text();
  if (!res.ok) throw new Error(`[EL] get-signed-url failed: ${res.status} ${body}`);
  const json = JSON.parse(body || '{}');
  if (!json.signed_url) throw new Error('[EL] signed_url missing');
  return json.signed_url;
}

function openDirect(agentId) {
  const direct = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${encodeURIComponent(agentId)}`;
  return new WebSocket(direct, { headers: { 'xi-api-key': XI_API_KEY } });
}

async function connectEleven(agentId) {
  try {
    const signed = await getSignedUrl(agentId);
    console.log('[EL] got signed_url');
    return await new Promise((resolve, reject) => {
      const ws = new WebSocket(signed);
      ws.on('open', () => { console.log('[EL] connected (signed)'); resolve(ws); });
      ws.on('error', e => { console.error('[EL] error (signed):', errMsg(e)); reject(e); });
    });
  } catch (e) {
    console.warn('[EL] signed-url failed; falling back to direct WSS');
    return await new Promise((resolve, reject) => {
      const ws = openDirect(agentId);
      ws.on('open', () => { console.log('[EL] connected (direct)'); resolve(ws); });
      ws.on('error', e => { console.error('[EL] error (direct):', errMsg(e)); reject(e); });
    });
  }
}

// -------- HTTP --------
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    res.writeHead(200, {'Content-Type':'text/plain'}); return res.end('ok');
  }
  if (req.method === 'GET' && req.url === '/test') {
    res.writeHead(200, {'Content-Type':'application/json'});
    return res.end(JSON.stringify({ok:true, ts:Date.now()}));
  }
  res.writeHead(404); res.end('not found');
});

// -------- WS --------
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const { pathname, query } = url.parse(req.url, true);
  console.log('[UPGRADE] path:', pathname);
  if (pathname !== '/ws' && pathname !== '/ws/') { console.log('[UPGRADE] rejected — wrong path'); return socket.destroy(); }
  const qToken = query?.token;
  if (qToken && BRIDGE_AUTH_TOKEN && qToken !== BRIDGE_AUTH_TOKEN) { console.log('[UPGRADE] rejected — BAD TOKEN (query)'); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req, qToken));
});

wss.on('connection', (twilioWs, req, tokenFromQuery) => {
  console.log('[WS] connected from', req.socket.remoteAddress);
  let authorized = !!tokenFromQuery || !BRIDGE_AUTH_TOKEN;
  let elevenWs = null;
  let streamSid = null;
  let closed = false;

  function closeBoth(code=1000, reason='normal'){
    if (closed) return; closed = true;
    try { twilioWs.close(code, reason); } catch {}
    try { elevenWs && elevenWs.close(code, reason); } catch {}
  }

  async function handleStart(msg){
    streamSid = msg?.start?.streamSid || null;

    const cp = msg?.start?.customParameters || {};
    const token = cp.token || '';
    const agentParam = cp.agent || '';

    if (!authorized) {
      if (BRIDGE_AUTH_TOKEN && token === BRIDGE_AUTH_TOKEN) {
        authorized = true; console.log('[WS] start: token accepted via customParameters');
      } else { console.log('[WS] start: BAD/MISSING token — closing'); return closeBoth(1008, 'unauthorized'); }
    }

    const agentId = pickAgent(agentParam);
    console.log('[WS] start; streamSid =', streamSid, 'agent =', agentParam || '(default)', '→', agentId || '(none)');

    if (!agentId) {
      console.error('[WS] no agent id available — set ELEVENLABS_AGENT_ID or DISCOVERY/DAILY vars in Railway');
      return closeBoth(1008, 'agent-id-missing');
    }

    try {
      elevenWs = await connectEleven(agentId);
    } catch (e) {
      console.error('[EL] connect failed:', errMsg(e));
      return closeBoth(1011, 'elevenlabs-connect-failed');
    }

    elevenWs.on('message', (buf) => {
      let emsg; try { emsg = JSON.parse(String(buf)); } catch { return; }
      if (emsg.type === 'audio' && emsg.audio_event?.audio_base_64 && streamSid) {
        safeSend(twilioWs, JSON.stringify({ event:'media', streamSid, media:{ payload: emsg.audio_event.audio_base_64 } }));
      } else if (emsg.type === 'interruption' && streamSid) {
        safeSend(twilioWs, JSON.stringify({ event:'clear', streamSid }));
      } else if (emsg.type === 'ping' && emsg.ping_event?.event_id) {
        safeSend(elevenWs, JSON.stringify({ type:'pong', event_id: emsg.ping_event.event_id }));
      }
    });

    elevenWs.on('close', (c,r)=>{ console.log('[EL] closed:', c, String(r||'')); closeBoth(c,r); });
    elevenWs.on('error', (e)=>{ console.error('[EL] error:', errMsg(e)); });
  }

  twilioWs.on('message', (buf) => {
    let tmsg; try { tmsg = JSON.parse(String(buf)); } catch { return; }
    switch (tmsg.event) {
      case 'start':    return handleStart(tmsg);
      case 'media': {
        const p = tmsg?.media?.payload;
        const track = tmsg?.media?.track;
        if (authorized && p && (!track || track === 'inbound') && elevenWs && elevenWs.readyState === WebSocket.OPEN) {
          safeSend(elevenWs, JSON.stringify({ user_audio_chunk: p }));
        }
        return;
      }
      case 'stop':     console.log('[WS] stop'); return closeBoth(1000, 'stop');
      case 'connected': return; // ignore
      default:          return; // ignore others
    }
  });

  twilioWs.on('close', (c,r)=>{ console.log('[WS] closed:', c, String(r||'')); closeBoth(c,r); });
  twilioWs.on('error', (e)=>{ console.error('[WS] error:', errMsg(e)); closeBoth(1011, e.message); });
});

server.listen(PORT, '0.0.0.0', ()=> console.log(`[HTTP] listening on :${PORT}`));
