'use strict';
const http = require('http');
const url = require('url');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const AUTH_TOKEN = process.env.BRIDGE_AUTH_TOKEN || '';
const XI_KEY = process.env.ELEVENLABS_API_KEY || '';
const AGENT_ID = process.env.ELEVENLABS_AGENT_ID || process.env.ELEVENLABS_DISCOVERY_AGENT_ID || process.env.ELEVENLABS_DAILY_AGENT_ID;

// ElevenLabs Twilio-compatible WS endpoint (leave as-is unless your docs show a different path)
const ELEVEN_TWILIO_WSS = `wss://api.elevenlabs.io/v1/convai/twilio?agent_id=${encodeURIComponent(AGENT_ID)}`;

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  res.writeHead(404); res.end();
});

const wss = new WebSocket.Server({ noServer: true });

function safeSend(ws, data) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(data); } catch {}
}

wss.on('connection', (twilioWs, req) => {
  console.log('[WS] connected from', req.socket.remoteAddress);

  let authorized = !AUTH_TOKEN;      // if no token configured, allow
  let elevenWs = null;
  let closed = false;

  function closeBoth(code = 1000, reason = 'normal') {
    if (closed) return;
    closed = true;
    try { twilioWs.close(code, reason); } catch {}
    try { elevenWs && elevenWs.close(code, reason); } catch {}
  }

  // 1) When Twilio sends messages, inspect start -> validate token; pipe to Eleven
  twilioWs.on('message', (buf) => {
    const txt = String(buf);
    let msg; try { msg = JSON.parse(txt); } catch { return; }

    if (msg.event === 'start') {
      const token = msg?.start?.customParameters?.token || '';
      console.log('[WS] start; token seen =', token ? token.slice(0, 6) + '…' : '(missing)');
      if (AUTH_TOKEN && token !== AUTH_TOKEN) {
        console.log('[WS] unauthorized start — closing');
        return closeBoth(1008, 'unauthorized');
      }
      authorized = true;

      // Open ElevenLabs Twilio bridge once authorized
      if (!XI_KEY || !AGENT_ID) {
        console.error('[WS] missing ELEVENLABS_API_KEY or ELEVENLABS_AGENT_ID');
        return closeBoth(1011, 'missing-elevenlabs-config');
      }

      console.log('[EL] dialing', ELEVEN_TWILIO_WSS);
      elevenWs = new WebSocket(ELEVEN_TWILIO_WSS, {
        headers: { 'xi-api-key': XI_KEY, 'User-Agent': 'maggie-bridge/1.0' }
      });

      elevenWs.on('open', () => console.log('[EL] connected'));
      elevenWs.on('message', (data) => {
        // forward ElevenLabs → Twilio verbatim
        safeSend(twilioWs, data);
      });
      elevenWs.on('error', (e) => console.error('[EL] error:', e.message));
      elevenWs.on('close', (code, reason) => {
        console.log('[EL] closed:', code, String(reason || ''));
        closeBoth(code, reason);
      });
    }

    if (!authorized) return;

    // Pipe Twilio → ElevenLabs verbatim (media, mark, stop, keepalive, etc.)
    if (elevenWs && elevenWs.readyState === WebSocket.OPEN) {
      safeSend(elevenWs, txt);
    }
  });

  twilioWs.on('close', (code, reason) => {
    console.log('[WS] closed:', code, String(reason || ''));
    closeBoth(code, reason);
  });
  twilioWs.on('error', (e) => {
    console.error('[WS] error:', e.message);
    closeBoth(1011, e.message);
  });
});

server.on('upgrade', (req, socket, head) => {
  const { pathname } = url.parse(req.url, true);
  console.log('[UPGRADE] path:', pathname);
  if (pathname !== '/ws' && pathname !== '/ws/') {
    console.log('[UPGRADE] rejected — wrong path');
    socket.destroy(); return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

server.listen(PORT, '0.0.0.0', () => console.log(`[HTTP] listening on :${PORT}`));


