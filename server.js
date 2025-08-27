// server.js — ElevenLabs <-> Twilio bridge
const http = require('http');
const url = require('url');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const BRIDGE_AUTH_TOKEN = process.env.BRIDGE_AUTH_TOKEN;             // same value you pass from Twilio <Parameter>
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID;         // pick ONE agent to start with

if (!BRIDGE_AUTH_TOKEN || !ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID) {
  console.error('[BOOT] Missing env: BRIDGE_AUTH_TOKEN / ELEVENLABS_API_KEY / ELEVENLABS_AGENT_ID');
}

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  } else if (req.url === '/test') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ts: Date.now() }));
  } else {
    res.writeHead(404);
    res.end('not found');
  }
});

const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const { pathname, query } = url.parse(req.url, true);
  if (pathname !== '/ws') return socket.destroy();

  // optional: allow token in query for early reject
  const qToken = query?.token;
  if (qToken && qToken !== BRIDGE_AUTH_TOKEN) {
    console.warn('[UPGRADE] bad token via query');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, qToken);
  });
});

wss.on('connection', async (twilioWs, req, tokenFromQuery) => {
  console.log('[WS] connected from Twilio');
  let streamSid = null;
  let elevenWs = null;
  let authed = !!tokenFromQuery;

  // Helper: connect to ElevenLabs via signed URL
  async function connectEleven() {
    const urlSigned = `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${encodeURIComponent(ELEVENLABS_AGENT_ID)}`;
    const resp = await fetch(urlSigned, { headers: { 'xi-api-key': ELEVENLABS_API_KEY } });
    if (!resp.ok) throw new Error(`[EL] signed_url fetch failed: ${resp.status}`);
    const { signed_url } = await resp.json();
    console.log('[EL] got signed_url');
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(signed_url);
      ws.on('open', () => { console.log('[EL] connected'); resolve(ws); });
      ws.on('error', (e) => { console.error('[EL] error', e); reject(e); });
    });
  }

  try {
    elevenWs = await connectEleven();
  } catch (e) {
    twilioWs.close();
    return;
  }

  // ElevenLabs -> Twilio
  elevenWs.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === 'audio' && msg.audio_event?.audio_base_64 && streamSid) {
      // Send μ-law 8000 base64 straight back to Twilio
      const out = { event: 'media', streamSid, media: { payload: msg.audio_event.audio_base_64 } };
      twilioWs.send(JSON.stringify(out));
    } else if (msg.type === 'interruption' && streamSid) {
      twilioWs.send(JSON.stringify({ event: 'clear', streamSid }));
    } else if (msg.type === 'ping' && msg.ping_event?.event_id) {
      elevenWs.send(JSON.stringify({ type: 'pong', event_id: msg.ping_event.event_id }));
    }
  });
  elevenWs.on('close', () => {
    console.log('[EL] closed');
    try { twilioWs.close(); } catch {}
  });

  // Twilio -> ElevenLabs
  twilioWs.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    if (msg.event === 'start') {
      streamSid = msg.start?.streamSid || null;

      // If token wasn’t on query, accept it from customParameters
      const token = msg.start?.customParameters?.token;
      if (!authed) {
        if (token && token === BRIDGE_AUTH_TOKEN) {
          authed = true;
          console.log('[WS] token accepted from start.customParameters');
        } else {
          console.warn('[WS] missing/invalid token in start');
          try { twilioWs.close(); } catch {}
        }
      }

      console.log('[WS] start; streamSid=', streamSid);
      return;
    }

    if (msg.event === 'media') {
      // Only forward caller audio (inbound)
      if (msg.media?.payload && (msg.media.track ? msg.media.track === 'inbound' : true)) {
        // Pass the Twilio base64 chunk directly as user audio
        elevenWs?.send(JSON.stringify({ user_audio_chunk: msg.media.payload }));
      }
      return;
    }

    if (msg.event === 'stop') {
      console.log('[WS] stop');
      try { elevenWs?.close(); } catch {}
      try { twilioWs.close(); } catch {}
      return;
    }
  });

  twilioWs.on('close', () => {
    console.log('[WS] closed by Twilio');
    try { elevenWs?.close(); } catch {}
  });

  twilioWs.on('error', (e) => console.error('[WS] error', e));
});

server.listen(PORT, () => {
  console.log(`[HTTP] listening on :${PORT}`);
});



