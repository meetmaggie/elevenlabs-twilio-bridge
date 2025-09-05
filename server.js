// server.js — Twilio <-> ElevenLabs bridge with Supabase memory + daily cutoff (Option A)
// Node 20+ recommended

const http = require('http');
const url = require('url');
const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');

// 🚀 Show Node version at boot
console.log('[BOOT] Node version:', process.version);

// ========== ENV ==========
const PORT = process.env.PORT || 8080;
const BRIDGE_AUTH_TOKEN   = process.env.BRIDGE_AUTH_TOKEN || ''; // optional
const ELEVENLABS_API_KEY  = process.env.ELEVENLABS_API_KEY || '';
const DEFAULT_AGENT_ID    = process.env.ELEVENLABS_AGENT_ID
  || process.env.ELEVENLABS_DISCOVERY_AGENT_ID
  || '';
const HANGUP_DELAY_MS     = parseInt(process.env.HANGUP_DELAY_MS || '1500', 10);
const DAILY_MAX_SECONDS   = parseInt(process.env.DAILY_MAX_SECONDS || '300', 10);

// Supabase (guarded so we don't crash if env is missing)
const HAS_SUPABASE = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
const supabase = HAS_SUPABASE
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

if (!ELEVENLABS_API_KEY) console.error('[BOOT] Missing ELEVENLABS_API_KEY');
if (!DEFAULT_AGENT_ID)   console.warn('[BOOT] No default agent id set (ELEVENLABS_AGENT_ID)');

// ========== HTTP + WS bootstrap ==========
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

server.on('upgrade', (req, socket, head) => {
  const { pathname, query } = url.parse(req.url, true);

  // DEBUG: log upgrades
  console.log('[UPGRADE] incoming', {
    url: req.url,
    pathname,
    hasToken: !!query?.token
  });

  if (pathname !== '/ws' && pathname !== '/media-stream') {
    console.warn('[UPGRADE] rejecting — bad path', pathname);
    return socket.destroy();
  }

  // If you *have* BRIDGE_AUTH_TOKEN set and you want to enforce it, uncomment:
  // if (BRIDGE_AUTH_TOKEN && query?.token !== BRIDGE_AUTH_TOKEN) {
  //   console.warn('[UPGRADE] rejected — bad/missing token');
  //   return socket.destroy();
  // }

  req.__query = query || {};
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

// ========== helpers ==========
function pickElAudioB64(msg) {
  const cands = [
    msg?.audio, msg?.audio_base64, msg?.audio_base_64,
    msg?.audio_event?.audio, msg?.audio_event?.audio_base64, msg?.audio_event?.audio_base_64,
    msg?.tts_event?.audio_base_64, msg?.response?.audio, msg?.chunk?.audio
  ];
  for (const s of cands) if (typeof s === 'string' && s.length > 32) return s;
  // very light fallback scan
  for (const v of Object.values(msg || {})) {
    if (typeof v === 'string' && v.length > 128 && /^[A-Za-z0-9+/=]+$/.test(v)) return v;
  }
  return null;
}

async function connectEleven(agentId) {
  // Prefer signed URL; fallback to direct
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
    console.error('[EL] connect failed:', e?.message || e);
    throw e;
  }
}

// Supabase fetch (guarded)
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

function buildContextNote(p) {
  if (!p) {
    return `No saved profile found.
Guidance: Keep the call warm and brief. Wrap up by 5 minutes with a friendly goodbye.`;
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

function injectContext(elWs, contextText) {
  if (!elWs || !contextText) return;
  try {
    // many runtimes accept this
    elWs.send(JSON.stringify({ type: 'session.update', instructions: contextText }));
  } catch {}
  try {
    // fallback as system message
    elWs.send(JSON.stringify({ type: 'add_message', role: 'system', text: contextText }));
  } catch {}
}

// ========== bridge ==========
wss.on('connection', async (twilioWs, req) => {
  const q = req.__query || {};
  let agentId = q.agent_id || DEFAULT_AGENT_ID;
  const mode    = (q.mode || 'discovery').toLowerCase();   // discovery | daily
  const phone   = q.phone || '';
  const queryToken = q.token || '';

  console.log('[WS] connected; params:', { agentId, mode, phone });

  // if auth enforced, allow token from Twilio customParameters or ?token
  function isAuthed(customToken) {
    if (!BRIDGE_AUTH_TOKEN) return true;
    return (customToken && customToken === BRIDGE_AUTH_TOKEN) || (queryToken && queryToken === BRIDGE_AUTH_TOKEN);
  }

  let streamSid = null;
  let authed = !BRIDGE_AUTH_TOKEN; // if no token set, allow by default
  let elWs = null;

  async function ensureEl() {
    if (elWs) return;
    elWs = await connectEleven(agentId);

    // EL -> Twilio (agent audio to phone)
    elWs.on('message', (buf) => {
      let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
      const b64 = pickElAudioB64(msg);
      if (b64 && streamSid) {
        twilioWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: b64 } }));
      }
      if (msg.type === 'interruption' && streamSid) {
        twilioWs.send(JSON.stringify({ event: 'clear', streamSid }));
      }
      if (msg.type === 'ping' && msg.ping_event?.event_id) {
        try { elWs.send(JSON.stringify({ type: 'pong', event_id: msg.ping_event.event_id })); } catch {}
      }
    });

    elWs.on('close', (code, reason) => {
      console.log('[EL] closed:', code, reason?.toString() || '');
      setTimeout(() => { try { twilioWs.close(code, reason); } catch {} }, HANGUP_DELAY_MS);
    });

    elWs.on('error', (e) => console.error('[EL] error:', e?.message || e));
  }

  // Twilio -> EL (caller mic to agent)
  twilioWs.on('message', async (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }

    // Twilio keepalive
    if (msg.event === 'ping' && msg.event_id) {
      try { twilioWs.send(JSON.stringify({ event: 'pong', event_id: msg.event_id })); } catch {}
      return;
    }

    if (msg.event === 'start') {
      streamSid = msg.start?.streamSid || null;

      // read token & agent from Twilio customParameters
      const cp = msg.start?.customParameters || {};
      const tokenFromCP = cp.token;
      const agentFromCP = cp.agent || cp.agent_id;
      if (agentFromCP) agentId = agentFromCP;

      authed = isAuthed(tokenFromCP);
      if (!authed) {
        console.warn('[WS] start: missing/invalid token (auth enforced)');
        try { return twilioWs.close(1008, 'bad-token'); } catch {}
      }

      console.log('[WS] start OK; streamSid:', streamSid, 'agent:', agentId);

      // open EL and (for daily) inject context
      await ensureEl();
      if (mode === 'daily') {
        const p = await getProfile(phone);
        const ctx = buildContextNote(p);
        console.log('[EL] injecting context:\n' + ctx);
        injectContext(elWs, ctx);
      }

      // 5-min cutoff for daily
      if (mode === 'daily' && DAILY_MAX_SECONDS > 0) {
        const t = setTimeout(() => {
          console.log('[WS] daily max reached -> closing stream');
          try { elWs?.close(1000, 'daily-max'); } catch {}
          try { twilioWs.close(1000, 'daily-max'); } catch {}
        }, DAILY_MAX_SECONDS * 1000);
        twilioWs.once('close', () => clearTimeout(t));
      }
      return;
    }

    if (msg.event === 'media') {
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
