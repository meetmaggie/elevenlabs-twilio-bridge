// server.js
// Railway WebSocket bridge scaffolding with robust logs & health endpoints.
// Keep your existing Twilio <-> ElevenLabs piping logic inside the HOOK section below.

import http from 'http';
import url from 'url';
import { WebSocketServer } from 'ws';

const PORT = process.env.PORT || 8080;
const BRIDGE_AUTH_TOKEN = process.env.BRIDGE_AUTH_TOKEN || null;

// ---------- HTTP SERVER (health + root) ----------
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  if (req.url === '/' || req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('voice-bridge: up');
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

// ---------- WS SERVER ----------
const wss = new WebSocketServer({ noServer: true });

// UPGRADE handler with loud diagnostics
server.on('upgrade', (req, socket, head) => {
  const { pathname, query } = url.parse(req.url, true);

  console.log('[UPGRADE] incoming', {
    url: req.url,
    pathname,
    hasToken: !!query?.token,
    ua: req.headers['user-agent'],
    xff: req.headers['x-forwarded-for'] || null,
  });

  // Only allow /ws (and /media-stream if you still use it)
  if (pathname !== '/ws' && pathname !== '/media-stream') {
    console.warn('[UPGRADE] rejecting — bad path', pathname);
    return socket.destroy();
  }

  // Optional bearer (off by default)
  if (BRIDGE_AUTH_TOKEN && query?.token !== BRIDGE_AUTH_TOKEN) {
    console.warn('[UPGRADE] rejected — bad/missing token');
    return socket.destroy();
  }

  // Stash query so we can read it in 'connection'
  req.__query = query || {};
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

// CONNECTION log (Twilio should hit this right after upgrade)
wss.on('connection', async (twilioWs, req) => {
  console.log('[WS] CONNECTED via upgrade', req.url);

  // Helpful: show key query params passed from your TwiML Stream URL
  const q = req.__query || {};
  const agentId = q.agent_id || q.agent || null;
  const mode = q.mode || null;
  const phone = q.phone || null;
  const persist = q.persist || null;

  console.log('[WS] query', { agentId, mode, phone, persist });

  // ---- HOOK: Twilio <-> ElevenLabs piping
  // If you already have this in your old server.js, paste it HERE and remove the stub below.
  attachTwilioHandlersStub(twilioWs);

  // Safety: basic error/close logs
  twilioWs.on('error', (e) => {
    console.error('[WS] Twilio socket error:', e?.message || e);
  });
  twilioWs.on('close', (code, reason) => {
    console.log('[WS] Twilio socket closed', { code, reason: reason?.toString() });
  });

  // Keep Twilio connection alive (respond to ping)
  twilioWs.on('ping', (data) => {
    try { twilioWs.pong(data); } catch {}
  });
});

// ---------- KEEPALIVE / LIFECYCLE ----------
setInterval(() => console.log('[HEARTBEAT] alive', new Date().toISOString()), 60_000);

process.on('SIGTERM', () => {
  console.log('[LIFECYCLE] SIGTERM received — shutting down gracefully');
  try { server.close(() => process.exit(0)); } catch { process.exit(0); }
});

// ---------- START ----------
server.listen(PORT, () => {
  console.log(`[HTTP] listening on :${PORT}`);
});

// ============================================================================
// === STUB HANDLERS (SAFE DEFAULTS) ==========================================
// ============================================================================
// This stub *only* logs Twilio messages so we can debug upgrade/connect issues.
// Replace this function with your existing Twilio <-> ElevenLabs bridge code.

function attachTwilioHandlersStub(twilioWs) {
  let sawFirstMedia = false;
  let mediaFrames = 0;

  twilioWs.on('message', (buf) => {
    // Twilio sends JSON per line
    let msg;
    try

