// server.js — Twilio <-> ElevenLabs bridge (bi-directional) with Supabase "Option A" memory
// Requires Node 18+ (global fetch).
//
// ENV you should set in Railway:
//  PORT (Railway sets automatically)
//  ELEVENLABS_API_KEY
//  ELEVENLABS_AGENT_ID              // default agent if none provided
//  ELEVENLABS_DISCOVERY_AGENT_ID    // optional; used by your Replit URL
//  BRIDGE_AUTH_TOKEN                // optional; if set, we enforce it
//  SUPABASE_URL
//  SUPABASE_SERVICE_ROLE_KEY
//  DAILY_MAX_SECONDS=300            // 5-min cutoff for daily (optional; defaults 300)
//  DISCOVERY_MAX_SECONDS=600        // optional; only used if you enable it below
//  HANGUP_DELAY_MS=1500             // buffer before closing Twilio after final EL audio
//  DEBUG_AUDIO=1                    // optional

const http = require('http');
const url = require('url');
const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 8080;
const BRIDGE_AUTH_TOKEN   = process.env.BRIDGE_AUTH_TOKEN || '';
const ELEVENLABS_API_KEY  = process.env.ELEVENLABS_API_KEY || '';
const DEFAULT_AGENT_ID    = process.env.ELEVENLABS_AGENT_ID
  || process.env.ELEVENLABS_DISCOVERY_AGENT_ID
  || '';
const HANGUP_DELAY_MS     = parseInt(process.env.HANGUP_DELAY_MS || '1500', 10);
const DAILY_MAX_SECONDS   = parseInt(process.env.DAILY_MAX_SECONDS || '300', 10);
const DISCOVERY_MAX_SECONDS = parseInt(process.env.DISCOVERY_MAX_SECONDS || '0', 10); // 0 = disabled

if (!ELEVENLABS_API_KEY) {
  console.error('[BOOT] Missing ELEVENLABS_API_KEY');
}
if (!DEFAULT_AGENT_ID) {
  console.warn('[BOOT] No ELEVENLABS_AGENT_ID/ELEVENLABS_DISCOVERY_AGENT_ID default set.');
}

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

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

// Accept /ws or /media-stream for compatibility
server.on('upgrade', (req, socket, head) => {
  const { pathname, query } = url.parse(req.url, true);
  if (pathname !== '/ws' && pathname !== '/media-stream') return socket.destroy();

  // Optional early reject if a query token is present but wrong
  if (query?.token && BRIDGE_AUTH_TOKEN && query.token !== BRIDGE_AUTH_TOKEN) {
    console.warn('[UPGRADE] rejected — BAD query token');
    return socket.destroy();
  }

  // attach parsed query to req so we can read it later
  req.__query = query || {};

  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

// ---------- helpers -----------------------------------------------------------

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

// Supabase: fetch saved profile row
async function getProfile(phone) {
  if (!phone || !supabase) return null;
  try {
    const { data } = await supabase
      .from('elder_profiles')
      .select('*')
      .eq('phone', phone)
      .maybeSingle();
    return data || null;
  } catch {
    return null;
  }
}

// Build short context for Daily calls
function buildContextNote(p) {
  if (!p) {
    return `No saved profile found.
Guidance: Keep call warm and brief. Wrap up by 5 minutes with a friendly goodbye.`;
  }
  return `Profile:
PreferredName: ${p.preferred_name ?? 'Unknown'}
Hobbies: ${p.hobbies ?? 'Unknown'}
HealthNotes: ${p.health_notes ?? 'None'}
LastDaily: ${p.last_daily_at ?? 'None'}
LastDailyMood: ${p.last_daily_mood ?? 'Unknown'}
LastDailyTopics: ${p.last_daily_topics ?? 'None'}
LastDailyHealth: ${p.last_daily_health_note ?? 'None'}
Guidance: Keep the call friendly and concise. Aim to wrap up by 5 minutes with a warm goodbye.`;
}

// Try to inject context/instructions to EL session (works on current APIs; ignored if unsupported)
function tryInjectContext(elWs, contextText) {
  if (!elWs || !contextText) return;

  // 1) session/update style (some EL runtimes accept this)
  try {
    elWs.send(JSON.stringify({
      type: 'session.update',
      instructions: contextText
    }));
  } catch {}

  // 2) Fallback: send a system note (many runtimes accept an initial system message)
  try {
    elWs.send(JSON.stringify({
      type: 'add_message',
      role: 'system',
      text: contextText
    }));
  } catch {}
}

// ---------- bridge ------------------------------------------------------------

wss.on('connection', async (twilioWs, req) => {
  // Query params passed from your TwiML <Stream url="...?...">
  const q = req.__query || {};
  let agentId = q.agent_id || DEFAULT_AGENT_ID;
  const mode    = (q.mode || 'discovery').toLowerCase();   // 'discovery' | 'daily'
  const persist = q.persist === '1';                        // '1' or '0'
  const phone   = q.phone || '';                            // international number
  const queryToken = q.token || '';                         // optional token via query

  console.log('[WS] connected; params:', { agentId, mode, persist, phone });

  let streamSid = null;
  let authed = false;
  let elWs = null;

  // If you set BRIDGE_AUTH_TOKEN, require either Twilio customParameters token OR ?token= query
  function checkAuth(customToken) {
    if (!BRIDGE_AUTH_TOKEN) return true; // auth not enforced
    return (customToken && customToken === BRIDGE_AUTH_TOKEN) || (queryToken && queryToken === BRIDGE_AUTH_TOKEN);
  }

  async function ensureElAndMaybeInject() {
    if (elWs) return;
    try {
      elWs = await connectEleven(agentId);
      // Inject context for daily calls (Discovery remains fresh)
      if (mode === 'daily') {
        const profile = await getProfile(phone);
        const contextNote = buildContextNote(profile);
        console.log('[EL] injecting context note:\n' + contextNote);
        tryInjectContext(elWs, contextNote);
      }
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
        twilioWs.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: b64 }
        }));
        if (process.env.DEBUG_AUDIO === '1') {
          console.log(`[EL->TWILIO] ${Math.round(b64.length / 1024)}KB base64`);
        }
      }

      // barge-in
      if (msg.type === 'interruption' && streamSid) {
        twilioWs.send(JSON.stringify({ event: 'clear', streamSid }));
      }

      // EL keepalive
      if (msg.type === 'ping' && msg.ping_event?.event_id) {
        elWs.send(JSON.stringify({ type: 'pong', event_id: msg.ping_event.event_id }));
      }
    });

    elWs.on('close', (code, reason) => {
      console.log('[EL] closed:', code, reason?.toString() || '');
      setTimeout(() => {
        try { twilioWs.close(code, reason); } catch {}
      }, HANGUP_DELAY_MS);
    });

    elWs.on('error', (e) => console.error('[EL] error:', e?.message || e));
  }

  // --- Twilio -> EL (caller mic to agent)
  twilioWs.on('message', async (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }

    // Twilio ping keepalive (respond to avoid idle timeouts)
    if (msg.event === 'ping' && msg.event_id) {
      try { twilioWs.send(JSON.stringify({ event: 'pong', event_id: msg.event_id })); } catch {}
      return;
    }

    if (msg.event === 'start') {
      streamSid = msg.start?.streamSid || null;

      // token & agent from customParameters (accept both "agent" and "agent_id")
      const cp = msg.start?.customParameters || {};
      const tokenFromCP = cp.token;
      const agentFromCP = cp.agent || cp.agent_id;

      if (agentFromCP) agentId = agentFromCP;

      authed = checkAuth(tokenFromCP);
      if (!authed) {
        console.warn('[WS] start: missing/invalid token (auth enforced)');
        try { return twilioWs.close(1008, 'bad-token'); } catch {}
      } else {
        console.log('[WS] start: auth OK; streamSid:', streamSid, 'agent:', agentId);
      }

      await ensureElAndMaybeInject();

      // Set server-side cutoff timers
      if (mode === 'daily' && DAILY_MAX_SECONDS > 0) {
        const t = setTimeout(() => {
          console.log('[WS] daily max reached -> closing stream');
          try { elWs?.close(1000, 'daily-max'); } catch {}
          try { twilioWs.close(1000, 'daily-max'); } catch {}
        }, DAILY_MAX_SECONDS * 1000);
        twilioWs.once('close', () => clearTimeout(t));
      } else if (mode === 'discovery' && DISCOVERY_MAX_SECONDS > 0) {
        const t2 = setTimeout(() => {
          console.log('[WS] discovery max reached -> closing stream');
          try { elWs?.close(1000, 'discovery-max'); } catch {}
          try { twilioWs.close(1000, 'discovery-max'); } catch {}
        }, DISCOVERY_MAX_SECONDS * 1000);
        twilioWs.once('close', () => clearTimeout(t2));
      }

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
      console.log('[WS] stop — graceful hangup');
      setTimeout(() => {
        try { elWs?.close(1000, 'stop'); } catch {}
        try { twilioWs.close(1000, 'stop'); } catch {}
      }, HANGUP_DELAY_MS);
      return;
    }
  });

  twilioWs.on('close', (code, reason) => {
    console.log('[WS] closed:', code, reason?.toString() || '');
    try { elWs?.close(code, reason); } catch {}
  });

  twilioWs.on('error', (e) => console.error('[WS] error', e?.message || e));
});

server.listen(PORT, () => console.log(`[HTTP] listening on :${PORT}`));

