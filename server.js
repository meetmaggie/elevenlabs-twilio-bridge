const { WebSocketServer } = require('ws')
const WebSocket = require('ws')
// Use dynamic import for node-fetch v3 compatibility
let fetch;
(async () => {
  fetch = (await import('node-fetch')).default;
})();
const http = require('http')

// Create HTTP server with TwiML endpoint
const server = http.createServer((req, res) => {
  if (req.url === '/twiml' && req.method === 'POST') {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://elevenlabs-twilio-bridge-production-95ab.up.railway.app" />
  </Connect>
</Response>`
    
    res.writeHead(200, { 'Content-Type': 'application/xml' })
    res.end(twiml)
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('ElevenLabs-Twilio WebSocket Bridge Running')
  }
})

// Create WebSocket server
const wss = new WebSocketServer({ server })

console.log('🚀 Starting ElevenLabs-Twilio bridge server...')

wss.on('connection', (twilioWs, request) => {
  console.log('📞 New Twilio WebSocket connection established!')
  console.log('🔗 Connection URL:', request.url)
  console.log('🌐 Client IP:', request.socket.remoteAddress)

  let elevenLabsWs = null
  let streamSid = null
  let conversationId = null

  const connectToElevenLabs = async () => {
  try {
    console.log('🔗 Connecting to ElevenLabs...')

    const agentId = process.env.ELEVENLABS_DISCOVERY_AGENT_ID || 'agent_01k0q3vpk7f8bsrq2aqk71v9j9'
    const apiKey = process.env.ELEVENLABS_API_KEY

    console.log('🔍 Debug - Agent ID:', agentId ? `${agentId.substring(0, 20)}...` : 'MISSING')
    console.log('🔍 Debug - API Key:', apiKey ? `${apiKey.substring(0, 10)}...` : 'MISSING')

    if (!agentId || !apiKey) {
      console.error('❌ Missing ElevenLabs credentials')
      console.error('❌ Agent ID:', agentId ? 'Present' : 'Missing') 
      console.error('❌ API Key:', apiKey ? 'Present' : 'Missing')
      return
    }

    console.log('🤖 Using agent:', agentId)
    
    const apiUrl = `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${agentId}`
    console.log('🔍 API URL:', apiUrl)

    // Get signed URL from ElevenLabs
    console.log('📡 Making API request to ElevenLabs...')
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json'
      }
    })

    console.log('📡 API Response status:', response.status)
    console.log('📡 API Response headers:', Object.fromEntries(response.headers.entries()))

    if (!response.ok) {
      const errorText = await response.text()
      console.error('❌ Failed to get ElevenLabs signed URL')
      console.error('❌ Status:', response.status)
      console.error('❌ Status Text:', response.statusText)
      console.error('❌ Error Body:', errorText)
      console.error('❌ Request Headers Used:', {
        'xi-api-key': apiKey ? `${apiKey.substring(0, 10)}...` : 'MISSING',
        'Content-Type': 'application/json'
      })
      return
    }

    const data = await response.json()
    console.log('✅ Got ElevenLabs signed URL')
    console.log('🔍 Response data keys:', Object.keys(data))
    
    if (!data.signed_url) {
      console.error('❌ No signed_url in response:', data)
      return
    }

    console.log('🔗 WebSocket URL:', data.signed_url.substring(0, 50) + '...')

    // Connect to ElevenLabs WebSocket
    console.log('🔌 Creating WebSocket connection...')
    elevenLabsWs = new WebSocket(data.signed_url)

    elevenLabsWs.on('open', () => {
      console.log('✅ Connected to ElevenLabs agent')
      console.log('🔌 WebSocket state:', elevenLabsWs.readyState)
    })

    // Rest of your existing WebSocket event handlers...
    elevenLabsWs.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString())
        console.log('📨 ElevenLabs message type:', message.type)
        console.log('📋 Full ElevenLabs message:', JSON.stringify(message, null, 2))

        switch (message.type) {
          case 'conversation_initiation_metadata':
            conversationId = message.conversation_initiation_metadata_event?.conversation_id
            console.log('✅ ElevenLabs conversation initiated:', conversationId)
            
            // Send initial greeting after conversation starts
            const greetingMessage = {
              user_audio_chunk: ""
            }
            elevenLabsWs.send(JSON.stringify(greetingMessage))
            console.log('👋 Sent greeting to start conversation')
            break

          case 'audio':
            console.log('🔊 Received audio from ElevenLabs')
            if (twilioWs.readyState === WebSocket.OPEN && streamSid && message.audio_event?.audio_base_64) {
              const audioMessage = {
                event: 'media',
                streamSid: streamSid,
                media: {
                  payload: message.audio_event.audio_base_64
                }
              }
              twilioWs.send(JSON.stringify(audioMessage))
              console.log('🔊 Sent audio to Twilio')
            } else {
              console.log('❌ Cannot send audio to Twilio - connection issue')
            }
            break

          case 'interruption':
            console.log('🛑 ElevenLabs interruption received')
            if (twilioWs.readyState === WebSocket.OPEN && streamSid) {
              const clearMessage = {
                event: 'clear',
                streamSid: streamSid
              }
              twilioWs.send(JSON.stringify(clearMessage))
              console.log('🛑 Cleared Twilio audio buffer')
            }
            break

          case 'ping':
            console.log('🏓 ElevenLabs ping received')
            if (elevenLabsWs.readyState === WebSocket.OPEN) {
              const eventId = message.event_id || `pong_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
              const pongMessage = {
                type: 'pong',
                event_id: eventId
              }
              elevenLabsWs.send(JSON.stringify(pongMessage))
              console.log('🏓 Sent pong with event_id:', eventId)
            }
            break

          case 'conversation_end':
            console.log('✅ ElevenLabs conversation ended')
            if (twilioWs.readyState === WebSocket.OPEN) {
              twilioWs.close()
            }
            break

          default:
            console.log('📋 Other ElevenLabs message type:', message.type)
            break
        }
      } catch (error) {
        console.error('❌ Error processing ElevenLabs message:', error)
        console.error('❌ Raw message data:', data.toString().substring(0, 200))
      }
    })

    elevenLabsWs.on('error', (error) => {
      console.error('❌ ElevenLabs WebSocket error:', error)
      console.error('❌ Error stack:', error.stack)
    })

    elevenLabsWs.on('close', (code, reason) => {
      console.log('🔌 ElevenLabs WebSocket closed:', code, reason.toString())
      const meanings = {
        1000: 'Normal closure',
        1001: 'Going away', 
        1002: 'Protocol error',
        1003: 'Unsupported data',
        1008: 'Policy violation',
        1011: 'Internal error'
      }
      console.log('📋 Close reason:', meanings[code] || `Unknown: ${code}`)
    })

  } catch (error) {
    console.error('❌ CRITICAL: Failed to connect to ElevenLabs:', error)
    console.error('❌ Error name:', error.name)
    console.error('❌ Error message:', error.message)
    console.error('❌ Error stack:', error.stack)
  }
}

      console.log('🤖 Using agent:', agentId)

      // Get signed URL from ElevenLabs
      const response = await fetch(`https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${agentId}`, {
        method: 'GET',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json'
        }
      })

      if (!response.ok) {
        const errorText = await response.text()
        console.error('❌ Failed to get ElevenLabs signed URL:', response.status, errorText)
        return
      }

      const data = await response.json()
      console.log('✅ Got ElevenLabs signed URL')

      // Connect to ElevenLabs WebSocket
      elevenLabsWs = new WebSocket(data.signed_url)

      elevenLabsWs.on('open', () => {
        console.log('✅ Connected to ElevenLabs agent')
      })

      elevenLabsWs.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString())
          console.log('📨 ElevenLabs message type:', message.type)
          console.log('📋 Full ElevenLabs message:', JSON.stringify(message, null, 2))

          switch (message.type) {
            case 'conversation_initiation_metadata':
              conversationId = message.conversation_initiation_metadata_event?.conversation_id
              console.log('✅ ElevenLabs conversation initiated:', conversationId)
              
              // Send initial greeting after conversation starts
              const greetingMessage = {
                user_audio_chunk: {
                  audio_base_64: "",
                  encoding: "mulaw", 
                  sample_rate: 8000
                }
              }
              elevenLabsWs.send(JSON.stringify(greetingMessage))
              console.log('👋 Sent greeting to start conversation')
              break

            case 'audio':
              console.log('🔊 Received audio from ElevenLabs')
              if (twilioWs.readyState === WebSocket.OPEN && streamSid && message.audio_event?.audio_base_64) {
                const audioMessage = {
                  event: 'media',
                  streamSid: streamSid,
                  media: {
                    payload: message.audio_event.audio_base_64
                  }
                }
                twilioWs.send(JSON.stringify(audioMessage))
                console.log('🔊 Sent audio to Twilio')
              } else {
                console.log('❌ Cannot send audio to Twilio - connection issue')
              }
              break

            case 'interruption':
              console.log('🛑 ElevenLabs interruption received')
              if (twilioWs.readyState === WebSocket.OPEN && streamSid) {
                const clearMessage = {
                  event: 'clear',
                  streamSid: streamSid
                }
                twilioWs.send(JSON.stringify(clearMessage))
                console.log('🛑 Cleared Twilio audio buffer')
              }
              break

            case 'ping':
              console.log('🏓 ElevenLabs ping received')
              if (elevenLabsWs.readyState === WebSocket.OPEN) {
                const eventId = message.event_id || `pong_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
                const pongMessage = {
                  type: 'pong',
                  event_id: eventId
                }
                elevenLabsWs.send(JSON.stringify(pongMessage))
                console.log('🏓 Sent pong with event_id:', eventId)
              }
              break

            case 'conversation_end':
              console.log('✅ ElevenLabs conversation ended')
              if (twilioWs.readyState === WebSocket.OPEN) {
                twilioWs.close()
              }
              break

            default:
              console.log('📋 Other ElevenLabs message type:', message.type)
              break
          }
        } catch (error) {
          console.error('❌ Error processing ElevenLabs message:', error)
          console.error('❌ Raw message data:', data.toString().substring(0, 200))
        }
      })

      elevenLabsWs.on('error', (error) => {
        console.error('❌ ElevenLabs WebSocket error:', error)
        console.error('❌ Error stack:', error.stack)
      })

      elevenLabsWs.on('close', (code, reason) => {
        console.log('🔌 ElevenLabs WebSocket closed:', code, reason.toString())
        const meanings = {
          1000: 'Normal closure',
          1001: 'Going away', 
          1002: 'Protocol error',
          1003: 'Unsupported data',
          1008: 'Policy violation',
          1011: 'Internal error'
        }
        console.log('📋 Close reason:', meanings[code] || `Unknown: ${code}`)
      })

    } catch (error) {
      console.error('❌ Failed to connect to ElevenLabs:', error)
      console.error('❌ Error stack:', error.stack)
    }
  }

  // Handle messages from Twilio
  twilioWs.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString())
      console.log('📨 Received Twilio message:', message.event)

      switch (message.event) {
        case 'start':
          streamSid = message.start.streamSid
          console.log('✅ Twilio stream started:', streamSid)
          console.log('📋 Media format:', JSON.stringify(message.start.mediaFormat))
          console.log('🚀 INITIATING ELEVENLABS CONNECTION NOW!')
          connectToElevenLabs()
          break

        case 'media':
  if (elevenLabsWs?.readyState === WebSocket.OPEN && message.media?.payload) {
    const audioMessage = {
      user_audio_chunk: message.media.payload
    }
    
    elevenLabsWs.send(JSON.stringify(audioMessage))
    // Only log every 10th audio message to reduce spam
    if (Math.random() < 0.1) {
      console.log('🎤 Sent audio chunk to ElevenLabs (payload length:', message.media.payload.length, ')')
    }
  } else if (!elevenLabsWs) {
    console.log('❌ ElevenLabs not connected yet - dropping audio')
  } else if (elevenLabsWs.readyState !== WebSocket.OPEN) {
    console.log('❌ ElevenLabs WebSocket not ready - state:', elevenLabsWs.readyState)
  }
  break

        case 'stop':
          console.log('🔌 Twilio stream stopped')
          if (elevenLabsWs?.readyState === WebSocket.OPEN) {
            elevenLabsWs.close()
          }
          break

        default:
          console.log('📋 Other Twilio message:', message.event)
          break
      }
    } catch (error) {
      console.error('❌ Error processing Twilio message:', error)
      console.error('❌ Raw message:', data.toString().substring(0, 200))
    }
  })

  twilioWs.on('close', (code, reason) => {
    console.log('🔌 Twilio WebSocket closed:', code, reason.toString())
    if (elevenLabsWs?.readyState === WebSocket.OPEN) {
      elevenLabsWs.close()
    }
  })

  twilioWs.on('error', (error) => {
    console.error('❌ Twilio WebSocket error:', error)
  })
})

const PORT = process.env.PORT || 5000
console.log(`🔍 Environment PORT: ${process.env.PORT}`)
console.log(`🔍 Using PORT: ${PORT}`)
console.log(`🔍 Starting server on 0.0.0.0:${PORT}...`)
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 WebSocket bridge server running on 0.0.0.0:${PORT}`)
  console.log(`📞 Ready to bridge Twilio ↔ ElevenLabs`)
  console.log(`✅ Server successfully bound to all interfaces`)
})
