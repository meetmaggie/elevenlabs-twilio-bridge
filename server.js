'use strict';
const http = require('http');
const url = require('url');
const { WebSocketServer } = require('ws');

const AUTH_TOKEN = process.env.BRIDGE_AUTH_TOKEN || '';

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws, req) => {
  console.log('[WS] connected from', req.socket.remoteAddress);
  ws.isAuthorized = !AUTH_TOKEN; // if no token set, allow by default

  ws.on('message', (buf) => {
    let msg;
    try { msg = JSON.parse(String(buf)); } catch { return; }

    // Twilio Media Streams messages
    // Typical shapes:
    // { event: 'start', start: { streamSid, customParameters: { token: '...' } } }
    // { event: 'media', media: { payload, ... } }
    // { event: 'stop',  stop:  { ... } }
    switch (msg.event) {
      case 'start': {
        const token =
          msg?.start?.customParameters?.token ??
          msg?.customParameters?.token ?? ''; // defensive
        console.log('[WS] start; token seen =', token ? token.slice(0, 6) + '…' : '(missing)');
        if (AUTH_TOKEN && token !== AUTH_TOKEN) {
          console.log('[WS] unauthorized start — closing (bad token)');
          ws.close(1008, 'unauthorized');
          return;
        }
        ws.isAuthorized = true;
        break;
      }
      case 'media':
        if (!ws.isAuthorized) return;
        console.log('[WS] media frame'); // you’ll see lots of these
        break;
      case 'stop':
        console.log('[WS] stop');
        break;
      default:
        console.log('[WS] event:', msg.event);
    }
  });

  ws.on('close', () => console.log('[WS] closed'));
  ws.on('error', (e) => console.error('[WS] error', e.message));
});

server.on('upgrade', (req, socket, head) => {
  const { pathname } = url.parse(req.url, true);
  console.log('[UPGRADE] path:', pathname);
  // accept both /ws and /ws/ just in case
  if (pathname !== '/ws' && pathname !== '/ws/') {
    console.log('[UPGRADE] rejected — wrong path');
    socket.destroy(); return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => console.log(`[HTTP] listening on :${PORT}`));

