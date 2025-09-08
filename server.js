// server.js – MeetMaggie Twilio <-> ElevenLabs bridge
// Enhanced version with proper audio forwarding and debugging
// Env variables to set in Railway:
//   ELEVENLABS_API_KEY (required)
//   ELEVENLABS_DISCOVERY_AGENT_ID (required)
//   ELEVENLABS_DAILY_AGENT_ID (optional)
//   BRIDGE_AUTH_TOKEN (optional)
//   NODE_ENV=production (recommended)
//   SILENCE_MS=800  EL_BUFFER_MS=200  UTTER_MAX_MS=3000  (tunable)
//   LOG_FRAMES_EVERY=20  LOG_MARK_ACKS=1  (debugging)

const http = require('http');
const url = require('url');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 8080;
const BRIDGE_AUTH_TOKEN = process.env.BRIDGE_AUTH_TOKEN || null;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || null;
const DISCOVERY_ID = process.env.ELEVENLABS_DISCOVERY_AGENT_ID || null;
const DAILY_ID = process.env.ELEVENLABS_DAILY_AGENT_ID || null;
const LOOPBACK_ONLY = (process.env.LOOPBACK_ONLY || '').trim() === '1';

// Tunable parameters
const LOG_FRAMES_EVERY = parseInt(process.env.LOG_FRAMES_EVERY || '20', 10);
const LOG_MARK_ACKS = (process.env.LOG_MARK_ACKS || '1').trim() === '1';
const SILENCE_MS = parseInt(process.env.SILENCE_MS || '800', 10);
const EL_BUFFER_MS = parseInt(process.env.EL_BUFFER_MS || '200', 10);
const UTTER_MAX_MS = parseInt(process.env.UTTER_MAX_MS || '3000', 10);
const FRAMES_PER_PACKET = Math.max(1, Math.round(EL_BUFFER_MS / 20));

console.log(`[STARTUP] MeetMaggie Bridge starting...`);
console.log(`[CONFIG] SILENCE_MS=${SILENCE_MS}, EL_BUFFER_MS=${EL_BUFFER_MS}, UTTER_MAX_MS=${UTTER_MAX_MS}`);
console.log(`[CONFIG] FRAMES_PER_PACKET=${FRAMES_PER_PACKET}, LOOPBACK_ONLY=${LOOPBACK_ONLY}`);

// HTTP server
const server = http.createServer((req, res) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(200, corsHeaders);
    return res.end();
  }

  if (req.url === '/health') {
    res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ 
      status: 'healthy', 
      service: 'MeetMaggie Voice Bridge',
      timestamp: new Date().toISOString()
    }));
  }

  if (req.url === '/' || req.url === '/status') {
    res.writeHead(200, { ...corsHeaders, 'Content-Type': 'text/plain' });
    return res.end('MeetMaggie Voice Bridge: Ready for calls');
  }

  res.writeHead(404, { ...corsHeaders, 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// WebSocket server for Twilio Media Streams
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const { pathname, query } = url.parse(req.url, true);
  
  if (pathname !== '/ws' && pathname !== '/media-stream') {
    console.warn('[WS] Invalid path attempted:', pathname);
    return socket.destroy();
  }

  if (BRIDGE_AUTH_TOKEN && (!query || query.token !== BRIDGE_AUTH_TOKEN)) {
    console.warn('[WS] Unauthorized connection attempt');
    return socket.destroy();
  }

  req.__query = query || {};
  wss.handleUpgrade(req, socket, head, ws => {
    console.log('[WS] Connection upgraded successfully');
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (twilioWs, req) => {
  console.log('[WS] New Twilio connection established');
  attachBridgeHandlers(twilioWs, req.__query || {});
});

// Health monitoring
setInterval(() => {
  const activeConnections = wss.clients.size;
  console.log(`[HEARTBEAT] MeetMaggie alive - Active connections: ${activeConnections}`, new Date().toISOString());
}, 60_000);

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[SHUTDOWN] Graceful shutdown initiated');
  try {
    server.close(() => {
      console.log('[SHUTDOWN] HTTP server closed');
      process.exit(0);
    });
  } catch {
    process.exit(0);
  }
});

server.listen(PORT, () => {
  console.log(`[STARTUP] MeetMaggie Voice Bridge listening on port ${PORT}`);
  console.log(`[STARTUP] WebSocket endpoint: /ws or /media-stream`);
});

// ================== Core Bridge Logic ==================

function attachBridgeHandlers(twilioWs, query = {}) {
  const sessionId = generateSessionId();
  console.log(`[SESSION:${sessionId}] New bridge session started`);

  // Session state
  let twilioStreamSid = null;
  let agentId = null, mode = 'discovery', phone = '';
  let callStartTime = Date.now();

  // ElevenLabs state
  let elWs = null, elOpen = false, elReady = false;
  let conversationStarted = false;
  let elInFormat = null, elOutFormat = null;

  // Audio state
  let seq = 0, chunk = 0, tsMs = 0;
  let elBuffer = [];
  let elBufferedFrames = 0;
  let totalFramesSent = 0;
  let totalAudioReceived = 0;

  // Voice activity detection
  let speaking = false;
  let silenceTimer = null;
  let utterCapTimer = null;
  let firstUserInput = true;
  let elHasSpoken = false;
  let userHasSpoken = false;

  // Nudge timers
  let nudge1 = null, nudge2 = null, nudge3 = null;

  const log = (category, message, data = {}) => {
    const timestamp = Date.now() - callStartTime;
    console.log(`[${category}:${sessionId}:${timestamp}ms] ${message}`, data);
  };

  const resetUtterance = () => {
    speaking = false;
    clearTimeout(silenceTimer);
    clearTimeout(utterCapTimer);
  };

  const flushElBuffer = (label = 'flush') => {
    if (!elBufferedFrames) return;

    const merged = Buffer.concat(elBuffer);
    const durationMs = elBufferedFrames * 20;

    if (!elOpen) {
      log('BUF', `${label} skipped - EL socket not open`, { durationMs, bytes: merged.length });
      return;
    }

    if (!elReady) {
      log('BUF', `${label} deferred - EL not ready`, { durationMs, bytes: merged.length });
      return;
    }

    try {
      // Send µ-law audio as configured in your ElevenLabs agent
      const audioMessage = {
        type: "audio",
        audio_event: {
          audio_base_64: merged.toString('base64')
        }
      };

      elWs.send(JSON.stringify(audioMessage));
      totalFramesSent += elBufferedFrames;

      log('EL_SEND', `Audio packet sent to ElevenLabs`, {
        label,
        durationMs,
        frames: elBufferedFrames,
        bytes: merged.length,
        totalFramesSent,
        format: 'ulaw'
      });

      // Trigger conversation start after first substantial audio
      if (firstUserInput && conversationStarted && elBufferedFrames > 5) {
        setTimeout(() => {
          if (elWs && elOpen) {
            try {
              elWs.send(JSON.stringify({ type: "conversation_start" }));
              log('EL_SEND', 'Conversation start signal sent');
            } catch (e) {
              log('ERROR', 'Failed to send conversation_start', { error: e.message });
            }
          }
        }, 100);
        firstUserInput = false;
      }

    } catch (e) {
      log('ERROR', 'Failed to send audio to ElevenLabs', { error: e.message });
    }

    // Reset buffer
    elBuffer = [];
    elBufferedFrames = 0;
  };

  // Periodic buffer flush
  const flushInterval = setInterval(() => {
    if (elBufferedFrames >= FRAMES_PER_PACKET) {
      flushElBuffer('periodic');
    }
  }, 50);

  // Cleanup function
  const cleanup = () => {
    log('SESSION', 'Cleaning up session resources');
    clearInterval(flushInterval);
    clearTimeout(silenceTimer);
    clearTimeout(utterCapTimer);
    clearTimeout(nudge1);
    clearTimeout(nudge2);
    clearTimeout(nudge3);
    
    if (elWs) {
      try { elWs.close(1000); } catch {}
    }
  };

  // Twilio WebSocket handlers
  twilioWs.on('close', (code, reason) => {
    const duration = Date.now() - callStartTime;
    log('TWILIO', 'Connection closed', { 
      code, 
      reason: reason?.toString(),
      durationMs: duration,
      totalAudioReceived,
      totalFramesSent
    });
    cleanup();
  });

  twilioWs.on('error', (err) => {
    log('ERROR', 'Twilio WebSocket error', { error: err.message });
    cleanup();
  });

  twilioWs.on('message', (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      log('ERROR', 'Invalid JSON from Twilio');
      return;
    }

    const event = msg?.event;

    if (event === 'connected') {
      log('TWILIO', 'Connected event received');
      return;
    }

    if (event === 'start') {
      const start = msg.start || {};
      twilioStreamSid = msg.streamSid || start.streamSid || null;

      const cp = start.customParameters || {};
      mode = (cp.mode || 'discovery').toLowerCase();
      agentId = cp.agent_id || (mode === 'daily' ? DAILY_ID : DISCOVERY_ID);
      phone = cp.caller_phone || start.from || cp.from || '';

      log('TWILIO', 'Stream started', {
        streamSid: twilioStreamSid,
        agentId: agentId ? agentId.substring(0, 8) + '...' : 'missing',
        phone,
        mode
      });

      // Reset session state
      seq = 0; chunk = 0; tsMs = 0;
      elBuffer = []; elBufferedFrames = 0; totalFramesSent = 0; totalAudioReceived = 0;
      elOpen = false; elReady = false; elHasSpoken = false; userHasSpoken = false;
      conversationStarted = false; firstUserInput = true;
      resetUtterance();

      if (LOOPBACK_ONLY) {
        log('MODE', 'Running in loopback mode - no ElevenLabs connection');
        return;
      }

      if (!ELEVENLABS_API_KEY) {
        log('ERROR', 'ELEVENLABS_API_KEY not configured');
        return;
      }

      if (!agentId) {
        log('ERROR', `No agent ID configured for mode: ${mode}`);
        return;
      }

      // Connect to ElevenLabs
      connectToElevenLabs(agentId, phone, sessionId);
      return;
    }

    if (event === 'media') {
      const muLawB64 = msg?.media?.payload;
      if (!muLawB64) return;

      totalAudioReceived++;

      // Voice Activity Detection
      if (!speaking) {
        speaking = true;
        userHasSpoken = true;
        log('VAD', 'User started speaking');

        // Send user audio start signal
        if (elWs && elOpen) {
          try {
            elWs.send(JSON.stringify({ type: "user_audio_start" }));
            log('EL_SEND', 'user_audio_start signal sent');
          } catch (e) {
            log('ERROR', 'Failed to send user_audio_start', { error: e.message });
          }
        }

        // Set hard cap timer
        clearTimeout(utterCapTimer);
        utterCapTimer = setTimeout(() => {
          log('VAD', 'Hard cap reached - ending user turn');
          endUserTurn('hard_cap');
        }, UTTER_MAX_MS);
      }

      // Buffer the audio
      try {
        const audioBytes = Buffer.from(muLawB64, 'base64');
        elBuffer.push(audioBytes);
        elBufferedFrames += 1;

        // Immediate flush if we have enough frames
        if (elBufferedFrames >= FRAMES_PER_PACKET && elOpen && elReady) {
          flushElBuffer('immediate');
        }
      } catch (e) {
        log('ERROR', 'Failed to buffer audio', { error: e.message });
      }

      // Loopback mode (for testing)
      if (LOOPBACK_ONLY) {
        sendAudioToTwilio(muLawB64);
      }

      // Reset silence timer
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        log('VAD', 'Silence detected - ending user turn');
        endUserTurn('silence');
      }, SILENCE_MS);

      return;
    }

    if (event === 'mark') {
      if (LOG_MARK_ACKS) {
        log('TWILIO', 'Mark acknowledgment received', { mark: msg.mark });
      }
      return;
    }

    if (event === 'stop') {
      log('TWILIO', 'Stream stop event received');
      
      // Final flush
      flushElBuffer('stop');
      
      // Send final signals to ElevenLabs
      if (elWs && elOpen) {
        try {
          elWs.send(JSON.stringify({ type: "user_audio_end" }));
          log('EL_SEND', 'Final user_audio_end sent');
        } catch {}

        try {
          elWs.send(JSON.stringify({
            type: "user_message",
            user_message: { message: "(Call ended)" }
          }));
          log('EL_SEND', 'Call end notification sent');
        } catch {}
      }

      cleanup();
      try { twilioWs.close(1000); } catch {}
      return;
    }

    log('TWILIO', 'Unhandled event', { event });
  });

  // Helper function to end user turns
  function endUserTurn(reason) {
    log('VAD', `Ending user turn: ${reason}`);

    // Flush any remaining audio
    flushElBuffer(`end_${reason}`);

    if (elWs && elOpen) {
      try {
        // Send end signal
        elWs.send(JSON.stringify({ type: "user_audio_end" }));
        log('EL_SEND', `user_audio_end sent (${reason})`);
      } catch (e) {
        log('ERROR', 'Failed to send user_audio_end', { error: e.message });
      }

      // Double end signal after delay
      setTimeout(() => {
        if (elWs && elOpen) {
          try {
            elWs.send(JSON.stringify({ type: "user_audio_end" }));
            log('EL_SEND', 'user_audio_end re-sent');
          } catch {}
        }
      }, 150);

      // Force processing nudge
      setTimeout(() => {
        if (elWs && elOpen) {
          try {
            elWs.send(JSON.stringify({
              type: "user_message",
              user_message: { message: "(User finished speaking - please respond)" }
            }));
            log('EL_SEND', 'Processing nudge sent');
          } catch {}
        }
      }, 250);
    }

    resetUtterance();
  }

  // Helper function to send audio to Twilio
  function sendAudioToTwilio(audioB64) {
    if (!twilioStreamSid) return;

    try {
      const mediaMessage = {
        event: 'media',
        streamSid: twilioStreamSid,
        sequenceNumber: String(++seq),
        media: {
          track: 'outbound',
          chunk: String(++chunk),
          timestamp: String(tsMs),
          payload: audioB64
        }
      };

      const markMessage = {
        event: 'mark',
        streamSid: twilioStreamSid,
        mark: { name: `maggie-chunk-${chunk}` }
      };

      twilioWs.send(JSON.stringify(mediaMessage));
      twilioWs.send(JSON.stringify(markMessage));

      tsMs += 20;

      if (LOG_FRAMES_EVERY > 0 && (seq % LOG_FRAMES_EVERY === 0)) {
        log('TWILIO_SEND', 'Audio frame sent', {
          seq, chunk, tsMs,
          bytes: Buffer.from(audioB64, 'base64').length
        });
      }
    } catch (e) {
      log('ERROR', 'Failed to send audio to Twilio', { error: e.message });
    }
  }

  // ElevenLabs connection function
  function connectToElevenLabs(agentId, phone, sessionId) {
    const endpoints = [
      `wss://api.elevenlabs.io/v1/convai/ws?agent_id=${encodeURIComponent(agentId)}`,
      `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${encodeURIComponent(agentId)}`
    ];

    const headers = { 'xi-api-key': ELEVENLABS_API_KEY };
    let endpointIndex = 0;

    const connect = () => {
      const endpoint = endpoints[endpointIndex];
      const endpointName = endpointIndex === 0 ? '/ws' : '/conversation';
      
      log('EL_CONNECT', `Connecting to ElevenLabs ${endpointName}`, { agentId: agentId.substring(0, 8) + '...' });

      elWs = new WebSocket(endpoint, { headers });

      elWs.on('error', (err) => {
        log('ERROR', `ElevenLabs connection error (${endpointName})`, { error: err.message });
        
        try { elWs.close(); } catch {}
        
        if (endpointIndex === 0) {
          endpointIndex = 1;
          log('EL_CONNECT', 'Falling back to /conversation endpoint');
          setTimeout(connect, 300);
        } else {
          log('ERROR', 'All ElevenLabs endpoints failed');
        }
      });

      elWs.on('open', () => {
        elOpen = true;
        log('EL_CONNECT', `Connected successfully via ${endpointName}`);

        // Send initialization
        const initMessage = {
          type: "conversation_initiation_client_data",
          conversation_initiation_client_data: {
            dynamic_variables: {
              caller_phone: phone || "",
              mode: mode,
              session_id: sessionId,
              timestamp: new Date().toISOString()
            }
          }
        };

        try {
          elWs.send(JSON.stringify(initMessage));
          log('EL_SEND', 'Initialization data sent', { phone, mode });
        } catch (e) {
          log('ERROR', 'Failed to send initialization', { error: e.message });
        }

        // Progressive nudging strategy
        nudge1 = setTimeout(() => {
          if (!elHasSpoken && elWs && elOpen) {
            try {
              elWs.send(JSON.stringify({
                type: "user_message",
                user_message: { message: "Hello" }
              }));
              log('EL_SEND', 'First nudge sent (Hello)');
            } catch {}
          }
        }, 2000);

        nudge2 = setTimeout(() => {
          if (!elHasSpoken && elWs && elOpen) {
            try {
              elWs.send(JSON.stringify({
                type: "user_message",
                user_message: { message: "Please start the conversation" }
              }));
              log('EL_SEND', 'Second nudge sent');
            } catch {}
          }
        }, 4000);

        nudge3 = setTimeout(() => {
          if (!elHasSpoken && elWs && elOpen) {
            try {
              elWs.send(JSON.stringify({ type: "conversation_start" }));
              log('EL_SEND', 'Conversation start nudge sent');
            } catch {}
          }
        }, 6000);
      });

      elWs.on('message', (data) => {
        let message;
        try {
          message = JSON.parse(data.toString());
        } catch {
          log('EL_RECV', 'Non-JSON message received', { data: String(data).slice(0, 200) });
          return;
        }

        // Handle errors
        if (message?.error || message?.type === 'error') {
          log('ERROR', 'ElevenLabs error message', { error: message });
          return;
        }

        // Handle metadata
        if (message?.type === 'conversation_initiation_metadata') {
          const metadata = message.conversation_initiation_metadata_event || {};
          elInFormat = metadata.user_input_audio_format;
          elOutFormat = metadata.agent_output_audio_format;
          elReady = true;
          conversationStarted = true;

          log('EL_RECV', 'Metadata received - ready for audio', {
            userFormat: elInFormat,
            agentFormat: elOutFormat
          });

          // Flush any buffered audio
          if (elBufferedFrames > 0) {
            log('EL_SEND', 'Flushing buffered audio after metadata');
            flushElBuffer('metadata_ready');
          }
          return;
        }

        // Handle audio responses
        if (message?.type === 'audio' && message.audio_event?.audio_base_64) {
          if (!elHasSpoken) {
            elHasSpoken = true;
            log('EL_RECV', 'First audio response received from ElevenLabs!');
            clearTimeout(nudge1);
            clearTimeout(nudge2);
            clearTimeout(nudge3);
          }

          // Track when agent finishes speaking for VAD
          lastAgentAudioTime = Date.now();
          resetUtterance();
          
          const audioB64 = message.audio_event.audio_base_64;
          const audioBytes = Buffer.from(audioB64, 'base64').length;
          
          log('EL_RECV', 'Audio chunk received', { bytes: audioBytes, format: elOutFormat });

          // Process audio based on format
          if (elOutFormat === 'ulaw_8000') {
            // Direct µ-law - send in 20ms chunks
            const ulawBuffer = Buffer.from(audioB64, 'base64');
            for (let offset = 0; offset < ulawBuffer.length; offset += 160) {
              const slice = ulawBuffer.subarray(offset, Math.min(offset + 160, ulawBuffer.length));
              sendAudioToTwilio(slice.toString('base64'));
            }
          } else {
            // Assume PCM16 and convert to µ-law
            const pcm16Buffer = Buffer.from(audioB64, 'base64');
            let processedBuffer = pcm16Buffer;
            
            // Downsample if needed (16kHz -> 8kHz)
            if (elOutFormat.includes('16000') || elOutFormat.includes('16k')) {
              processedBuffer = downsamplePcm16Mono16kTo8k(pcm16Buffer);
            }
            
            // Convert to µ-law
            const muLawBuffer = pcm16ToMuLaw(processedBuffer);
            
            // Send in 20ms chunks (160 bytes)
            for (let offset = 0; offset < muLawBuffer.length; offset += 160) {
              const slice = muLawBuffer.subarray(offset, Math.min(offset + 160, muLawBuffer.length));
              sendAudioToTwilio(slice.toString('base64'));
            }
          }
          return;
        }

        // Handle transcripts
        if (message?.type === 'user_transcript') {
          const transcript = message.user_transcription_event?.user_transcript;
          log('EL_RECV', 'User transcript received', { transcript });

          // If we get transcripts but no audio responses, nudge the agent
          if (transcript && transcript.length > 5) {
            setTimeout(() => {
              if (!elHasSpoken && elWs && elOpen) {
                try {
                  elWs.send(JSON.stringify({
                    type: "user_message",
                    user_message: { message: "Please respond to what I just said" }
                  }));
                  log('EL_SEND', 'Post-transcript nudge sent');
                } catch {}
              }
            }, 1000);
          }
          return;
        }

        // Handle agent text responses
        if (message?.type === 'agent_response') {
          const response = message.agent_response_event?.agent_response;
          log('EL_RECV', 'Agent text response', { response });

          // If we get text but no audio, there might be a voice configuration issue
          if (response && !elHasSpoken) {
            log('WARNING', 'Got text response but no audio - check agent voice settings');
          }
          return;
        }

        // Handle ping/pong
        if (message?.type === 'ping') {
          const eventId = message.ping_event?.event_id;
          try {
            elWs.send(JSON.stringify({
              type: 'pong',
              event_id: eventId
            }));
            log('EL_SEND', 'Pong sent', { eventId });
          } catch (e) {
            log('ERROR', 'Failed to send pong', { error: e.message });
          }
          return;
        }

        // Log unhandled events
        log('EL_RECV', 'Unhandled message type', {
          type: message?.type,
          keys: Object.keys(message || {})
        });
      });

      elWs.on('close', (code, reason) => {
        elOpen = false;
        elReady = false;
        const reasonStr = reason?.toString() || 'No reason';
        log('EL_CONNECT', 'Connection closed', { code, reason: reasonStr });

        // Retry on unexpected closure
        if (endpointIndex === 0 && code !== 1000) {
          endpointIndex = 1;
          log('EL_CONNECT', 'Retrying with /conversation endpoint');
          setTimeout(connect, 300);
        }
      });
    };

    connect();
  }
}

// ================== Audio Conversion Utilities ==================

function pcm16ToMuLaw(pcmBuffer) {
  const muLawBuffer = Buffer.alloc(pcmBuffer.length);
  
  for (let i = 0; i < pcmBuffer.length; i++) {
    let sample = pcmBuffer[i];
    let sign = (sample < 0) ? 0x80 : 0;
    
    if (sample < 0) sample = -sample;
    if (sample > 32635) sample = 32635;
    
    sample += 132;
    let exponent = 7;
    
    for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
      exponent--;
    }
    
    const mantissa = (sample >> (exponent + 3)) & 0x0F;
    muLawBuffer[i] = ~(sign | (exponent << 4) | mantissa) & 0xFF;
  }
  
  return muLawBuffer;
}

function downsamplePcm16Mono16kTo8k(pcm16Buffer) {
  const input16 = new Int16Array(
    pcm16Buffer.buffer,
    pcm16Buffer.byteOffset,
    Math.floor(pcm16Buffer.byteLength / 2)
  );
  
  const outputLength = Math.floor(input16.length / 2);
  const output16 = new Int16Array(outputLength);
  
  for (let i = 0, j = 0; j < outputLength; i += 2, j++) {
    output16[j] = input16[i];
  }
  
  return Buffer.from(output16.buffer);
}

// ================== Utilities ==================

function generateSessionId() {
  return Math.random().toString(36).substring(2, 10);
}

console.log('[STARTUP] MeetMaggie Voice Bridge ready for connections');
