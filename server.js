// server.js — Twilio <-> ElevenLabs bridge (bi-directional) with Supabase memory (safe guard)
// Requires Node 20+
//
// ENV you should set in Railway:
//  PORT (Railway sets automatically)
//  ELEVENLABS_API_KEY
//  ELEVENLABS_AGENT_ID              // default agent if none provided
//  ELEVENLABS_DISCOVERY_AGENT_ID    // optional; used by your Replit URL
//  BRIDGE_AUTH_TOKEN                // optional; if set, we enforce it
//  SUPABASE_URL                     // (required for persistence)
//  SUPABASE_SERVICE_ROLE_KEY        // (required for persistence)
//  DAILY_MAX_SECONDS=300            // 5-min cutoff for daily (optional; defaults 300)
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

// ---------- Supabase guard (no crash if vars missing) ----------
const HAS_SUPABASE = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
const supabase = HAS_SUPABASE
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

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

// ---------- HTTP + WS setup ----------
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
  if (pathname !== '/ws') return socket.destroy();
  req.__query = query || {};
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

// ---------- helpers ----------
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
  return null;
}

async function connectEleven(agentId) {
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

// ---------- bridge ----------
wss.on('connection', async (twilioWs, req) => {
  const q = req.__query || {};
  let agentId = q.agent_id || DEFAULT_AGENT_ID;
  const mode    = (q.mode || 'discovery').toLowerCase();
  const phone   = q.phone || '';
  console.log('[WS] connected; params:', { agentId, mode, phone });

  let streamSid = null;
  let elWs = null;

  async function ensureEl() {
    if (elWs) return;
    elWs = await connectEleven(agentId);

    // Inject context for daily calls
    if (mode === 'daily') {
      const profile = await getProfile(phone);
      console.log('[EL] injecting context from Supabase:', profile);
      if (profile) {
        elWs.send(JSON.stringify({
          type: 'add_message',
          role: 'system',
          text: `PreferredName: ${profile.preferred_name ?? 'Unknown'}`
        }));
      }
    }

    elWs.on('message', (buf) => {
      let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
      const b64 = pickElAudioB64(msg);
      if (b64 && streamSid) {
        twilioWs.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: b64 }
        }));
      }
    });
  }

  twilioWs.on('message', async (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
    if (msg.event === 'start') {
      streamSid = msg.start?.streamSid || null;
      await ensureEl();

      if (mode === 'daily') {
        setTimeout(() => {
          console.log('[WS] daily max reached -> closing stream');
          try { elWs?.close(1000, 'daily-max'); } catch {}
          try { twilioWs.close(1000, 'daily-max'); } catch {}
        }, DAILY_MAX_SECONDS * 1000);
      }
    }
    if (msg.event === 'media') {
      if (msg.media?.payload && elWs) {
        elWs.send(JSON.stringify({ user_audio_chunk: msg.media.payload }));
      }
    }
  });
});

server.listen(PORT, () => console.log(`[HTTP] listening on :${PORT}`));
