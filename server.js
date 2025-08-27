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

wss.on('connection', (ws) => {
  console.log('[WS] connected');
  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.event === 'start') console.log('[WS] start');
      else if (data.event === 'media') console.log('[WS] media frame');
      else if (data.event === 'stop') console.log('[WS] stop');
      else console.log('[WS] event:', data.event);
    } catch {
      console.log('[WS] non-JSON');
    }
  });
  ws.on('close', () => console.log('[WS] closed'));
  ws.on('error', (e) => console.error('[WS] error', e.message));
});

server.on('upgrade', (req, socket, head) => {
  const { pathname, query } = url.parse(req.url, true);
  if (pathname !== '/ws') return socket.destroy();
  if (AUTH_TOKEN && query.token !== AUTH_TOKEN) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => console.log(`[HTTP] listening on :${PORT}`));
