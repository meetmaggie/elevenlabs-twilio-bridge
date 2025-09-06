// server.js (CommonJS)
// Railway WebSocket bridge scaffolding with robust logs & health endpoints.
// Now reads agent/mode from Twilio <Parameter/> via the 'start' event (customParameters).

const http = require('http');
const url = require('url');
const { WebSocketServer } = require('ws');

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
    hasToken: !!(query && query.token),
    ua: req.headers['user-agent'],
    xff: req.headers['x-forwarded-for'] || null,
  });

  // Only allow /ws (and /media-stream if you still use it)
  if (pathname !== '/ws' && pathname !== '/media-stream') {
    console.warn('[UPGRADE] rejecting — bad path', pathname);
    try { socket.destroy(); } catch (e) {}
    return;
  }

  // Optional bearer (off by default)
  if (BRIDGE_AUTH_TOKEN && (!query || query.token !== BRIDGE_AUTH_TOKEN)) {
    console.warn('[UPGRADE] rejected — bad/missing token');
    try { socket.destroy(); } catch (e) {}
    return;
  }

  // Stash query so we can read it in 'connection' (still logged for debugging)
  req.__query = query || {};
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

// CONNECTION log (Twilio should hit this right after upgrade)
wss.on('connection', (twilioWs, req) => {
  console.log('[WS] CONNECTED via upgrade', req.url);

  // For visibility only — real params now arrive via 'start'.customParameters.
  const q = req.__query || {};
  const agentIdQ = q.agent_id || q.agent || null;
  const modeQ = q.mode || null;
  const phoneQ = q.phone || null;
  const persistQ = q.persist || null;
  console.log('[WS] query (for debug only)', { agentIdQ, modeQ, phoneQ, persistQ });

  // ---- Twilio <-> ElevenLabs piping (stub with customParameters handling)
  attachTwilioHandlersWithParams(twilioWs);

  // Safety: basic error/close logs
  twilioWs.on('error', (e) => {
    console.error('[WS] Twilio socket error:', (e && e.message) || e);
  });
  twilioWs.on('close', (code, reasonBuf) => {
    const reason = reasonBuf ? reasonBuf.toString() : undefined;
    console.log('[WS] Twilio socket closed', { code, reason });
  });

  // Keep Twilio connection alive (respond to ping)
  twilioWs.on('ping', (data) => {
    try { twilioWs.pong(data); } catch (e) {}
  });
});

// ---------- KEEPALIVE / LIFECYCLE ----------
setInterval(() => console.log('[HEARTBEAT] alive', new Date().toISOString()), 60_000);

process.on('SIGTERM', () => {
  console.log('[LIFECYCLE] SIGTERM received — shutting down gracefully');
  try { server.close(() => process.exit(0)); } catch (e) { process.exit(0); }
});

// ---------- START ----------
server.listen(PORT, () => {
  console.log(`[HTTP] listening on :${PORT}`);
});

// ============================================================================
// === TWILIO HANDLERS (reads customParameters from 'start') ===================
// ============================================================================
function attachTwilioHandlersWithParams(twilioWs) {
  let sawFirstMedia = false;
  let mediaFrames = 0;

  // Populated when 'start' arrives
  let agentId = null;
  let mode = 'discovery';
  let phone = null;
  let persist = '0';

  twilioWs.on('message', (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch (e) {
      console.warn('[TWILIO] non-JSON message (ignored)');
      return;
    }

    const event = msg && msg.event;

    switch (event) {
      case 'connected':
        console.log('[TWILIO] event connected');
        return;

      case 'start': {
        const start = msg.start || {};
        const cp = start.customParameters || {};
        agentId = cp.agent_id || agentId;
        mode    = (cp.mode || mode || 'discovery').toLowerCase();
        phone   = cp.caller_phone || phone;
        persist = cp.persist === '1' ? '1' : '0';

        console.log('[TWILIO] start', {
          streamSid: msg.streamSid,
          tracks: start.tracks,
          mediaFormat: start.mediaFormat,
          customParameters: { agentId, mode, phone, persist }
        });

        // TODO: connect to ElevenLabs here using agentId/mode
        // connectToElevenLabs({ agentId, mode, phone, twilioWs });

        return;
      }

      case 'media':
        mediaFrames += 1;
        if (!sawFirstMedia) {
          sawFirstMedia = true;
          console.log('[TWILIO] first media frame received');
        }
        // In your real bridge, forward msg.media.payload (base64 mulaw/8k) to ElevenLabs WS.
        return;

      case 'mark':
        console.log('[TWILIO] mark', msg.mark);
        return;

      case 'stop':
        console.log('[TWILIO] stop', { totalMediaFrames: mediaFrames });
        try { twilioWs.close(1000, 'normal'); } catch (e) {}
        return;

      case 'clear':
      case ' clear':
        console.log('[TWILIO] clear');
        return;

      default:
        console.log('[TWILIO] event', event || '(unknown)');
        return;
    }
  });
}
