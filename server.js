const { WebSocketServer } = require('ws')
const WebSocket = require('ws')
let fetch;
(async () => {
  fetch = (await import('node-fetch')).default;
})();
const http = require('http')

// Create HTTP server with TwiML endpoint
const server = http.createServer((req, res) => {
  console.log(`🌐 HTTP Request: ${req.method} ${req.url} from ${req.socket.remoteAddress}`)

  if (req.url === '/twiml' && req.method === 'POST') {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://elevenlabs-twilio-bridge-production-95ab.up.railway.app" />
  </Connect>
</Response>`

    res.writeHead(200, { 'Content-Type': 'application/xml' })
    res.end(twiml)
  } else if (req.url === '/test') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: 'ok',
      timestamp: new Date().toISOString(),
      message: 'WebSocket bridge is running'
    }))
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('ElevenLabs-Twilio WebSocket Bridge Running\nTest endpoint: /test')
  }
})

// Create WebSocket server
const wss = new WebSocketServer({ server })

console.log('🚀 Starting ElevenLabs-Twilio bridge server...')

wss.on('connection', (twilioWs, request) => {
  console.log('📞 🚨 NEW TWILIO WEBSOCKET CONNECTION ESTABLISHED!')
  console.log('🔗 Connection URL:', request.url)
  console.log('🌐 Client IP:', request.socket.remoteAddress)
  console.log('🕒 Connection time:', new Date().toISOString())
  console.log('🔍 Headers:', JSON.stringify(request.headers, null, 2))

  let elevenLabsWs = null
  let streamSid = null
  let conversationId = null
  let agentReady = false
  let conversationStarted = false
  let initializationComplete = false
  let connectionAttempts = 0
  const MAX_RETRIES = 3

  const connectToElevenLabs = async () => {
    try {
      connectionAttempts++
      console.log(`🔗 Connecting to ElevenLabs (attempt ${connectionAttempts}/${MAX_RETRIES})...`)

      const agentId = process.env.ELEVENLABS_DISCOVERY_AGENT_ID || 'agent_01k0q3vpk7f8bsrq2aqk71v9j9'
      const apiKey = process.env.ELEVENLABS_API_KEY

      console.log('🔍 Debug - Agent ID:', agentId ? `${agentId.substring(0, 20)}...` : 'MISSING')
      console.log('🔍 Debug - API Key:', apiKey ? `${apiKey.substring(0, 10)}...` : 'MISSING')

      if (!agentId || !apiKey) {
        console.error('❌ Missing ElevenLabs credentials')
        return false
      }

      const apiUrl = `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${agentId}`
      console.log('📡 Making API request to ElevenLabs...')
      
      const response = await fetch(apiUrl, {
        method: 'GET',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json'
        },
        timeout: 10000 // 10 second timeout
      })

      console.log('📡 API Response status:', response.status)

      if (!response.ok) {
        const errorText = await response.text()
        console.error('❌ Failed to get ElevenLabs signed URL:', response.status, errorText)
        return false
      }

      const data = await response.json()
      console.log('✅ Got ElevenLabs signed URL')
      
      if (!data.signed_url) {
        console.error('❌ No signed_url in response:', data)
        return false
      }

      console.log('🔗 WebSocket URL:', data.signed_url.substring(0, 50) + '...')
      
      // ✅ Test agent configuration first
      console.log('🔍 Testing agent configuration...')
      const agentResponse = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${agentId}`, {
        headers: { 'xi-api-key': apiKey }
      })
      
      if (agentResponse.ok) {
        const agentData = await agentResponse.json()
        console.log('✅ Agent config verified:', {
          name: agentData.name,
          language: agentData.language,
          conversation_config: agentData.conversation_config
        })
      } else {
        console.warn('⚠️ Could not verify agent config:', agentResponse.status)
      }

      // Connect to ElevenLabs WebSocket
      console.log('🔌 Creating WebSocket connection...')
      elevenLabsWs = new WebSocket(data.signed_url)

      return new Promise((resolve) => {
        const connectionTimeout = setTimeout(() => {
          console.error('❌ ElevenLabs WebSocket connection timeout')
          if (elevenLabsWs.readyState === WebSocket.CONNECTING) {
            elevenLabsWs.close()
          }
          resolve(false)
        }, 10000) // 10 second timeout

        elevenLabsWs.on('open', () => {
          clearTimeout(connectionTimeout)
          console.log('✅ Connected to ElevenLabs agent')
          console.log('🔌 WebSocket state:', elevenLabsWs.readyState)
          agentReady = true
          
          // ✅ SUPER AGGRESSIVE: Send multiple types of initialization messages
          const initSequence = [
            { user_audio_chunk: "" },
            { type: "conversation_initiation", user_audio_chunk: "" },
            { user_audio_chunk: "AAAA" }, // Some actual audio data
            { user_audio_chunk: "" }
          ]
          
          initSequence.forEach((msg, index) => {
            setTimeout(() => {
              if (elevenLabsWs.readyState === WebSocket.OPEN) {
                elevenLabsWs.send(JSON.stringify(msg))
                console.log(`🎬 INIT ${index + 1}: Sent initialization message:`, JSON.stringify(msg).substring(0, 50))
              }
            }, index * 200)
          })

          resolve(true)
        })

        elevenLabsWs.on('message', (data) => {
          try {
            const message = JSON.parse(data.toString())
            console.log('📨 🔍 FULL ElevenLabs message:', JSON.stringify(message, null, 2))

            switch (message.type) {
              case 'conversation_initiation_metadata':
                conversationId = message.conversation_initiation_metadata_event?.conversation_id
                console.log('✅ ElevenLabs conversation initiated:', conversationId)
                conversationStarted = true
                
                // ✅ EXTREME: Send a greeting message to force the agent to respond
                const greetingSequence = [
                  { user_audio_chunk: "" },
                  { user_audio_chunk: "" },
                  { user_audio_chunk: "" },
                  // Try sending some silence audio to trigger speech
                  { user_audio_chunk: "UklGRigAAABXQVZFZm10IBAAAAABAAEA22UAAABhBAAACAAIAGRhdGEEAAAAAA==" }
                ]
                
                greetingSequence.forEach((msg, index) => {
                  setTimeout(() => {
                    if (elevenLabsWs.readyState === WebSocket.OPEN) {
                      elevenLabsWs.send(JSON.stringify(msg))
                      console.log(`🎬 GREETING ${index + 1}: Sent to initiate conversation`)
                    }
                  }, index * 150)
                })
                
                // Send buffered audio after conversation starts
                if (audioBuffer.length > 0) {
                  console.log(`🔄 Processing ${audioBuffer.length} buffered audio chunks`)
                  setTimeout(() => {
                    audioBuffer.forEach(audioChunk => {
                      if (elevenLabsWs.readyState === WebSocket.OPEN) {
                        elevenLabsWs.send(audioChunk)
                      }
                    })
                    audioBuffer = []
                  }, 500) // Delay to let conversation initialize
                }
                break

              case 'audio':
                if (twilioWs.readyState === WebSocket.OPEN && streamSid && message.audio_event?.audio_base_64) {
                  const audioMessage = {
                    event: 'media',
                    streamSid: streamSid,
                    media: {
                      payload: message.audio_event.audio_base_64
                    }
                  }
                  twilioWs.send(JSON.stringify(audioMessage))
                  console.log('🔊 ✅ Sent audio to Twilio (length:', message.audio_event.audio_base_64.length, ')')
                } else {
                  console.log('❌ Cannot send audio to Twilio')
                  console.log('  Twilio ready:', twilioWs.readyState === WebSocket.OPEN)
                  console.log('  StreamSid:', !!streamSid)
                  console.log('  Has audio:', !!message.audio_event?.audio_base_64)
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

              case 'user_transcript':
                console.log('📝 User said:', message.user_transcript_event?.text || 'unclear')
                break

              case 'agent_response':
                console.log('🤖 Agent responding:', message.agent_response_event?.text || 'unclear')
                break

              case 'agent_response_start':
                console.log('🎯 Agent is starting to respond!')
                break

              case 'agent_response_end':
                console.log('🎯 Agent finished responding')
                break

              case 'conversation_end':
                console.log('👋 Conversation ended')
                break

              case 'error':
                console.error('❌ ElevenLabs error:', message)
                break

              default:
                console.log('📋 Other ElevenLabs message type:', message.type, 'Full message:', JSON.stringify(message))
                break
            }
          } catch (error) {
            console.error('❌ Error processing ElevenLabs message:', error)
            console.error('❌ Raw message data:', data.toString().substring(0, 200))
          }
        })

        elevenLabsWs.on('error', (error) => {
          clearTimeout(connectionTimeout)
          console.error('❌ ElevenLabs WebSocket error:', error)
          agentReady = false
          resolve(false)
        })

        elevenLabsWs.on('close', (code, reason) => {
          clearTimeout(connectionTimeout)
          console.log('🔌 ElevenLabs WebSocket closed:', code, reason.toString())
          agentReady = false
          
          // Attempt retry if not a normal closure and we have retries left
          if (code !== 1000 && connectionAttempts < MAX_RETRIES) {
            console.log(`🔄 Retrying ElevenLabs connection in 2 seconds...`)
            setTimeout(() => {
              connectToElevenLabs()
            }, 2000)
          }
          
          resolve(false)
        })
      })

    } catch (error) {
      console.error('❌ CRITICAL: Failed to connect to ElevenLabs:', error)
      return false
    }
  }

  // ✅ CRITICAL FIX: Pre-connect to ElevenLabs immediately when Twilio connects
  console.log('🚀 PRE-CONNECTING to ElevenLabs before stream starts...')
  connectToElevenLabs().then(success => {
    if (success) {
      console.log('✅ ElevenLabs PRE-CONNECTION successful')
    } else {
      console.error('❌ Failed to establish ElevenLabs PRE-CONNECTION')
    }
  })

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
          
          // If ElevenLabs isn't ready yet, try connecting again
          if (!agentReady || !elevenLabsWs || elevenLabsWs.readyState !== WebSocket.OPEN) {
            console.log('🔄 ElevenLabs not ready, attempting connection...')
            connectToElevenLabs()
          } else {
            console.log('✅ ElevenLabs already connected and ready!')
            // Send initial audio chunk to wake up the agent
            setTimeout(() => {
              if (elevenLabsWs.readyState === WebSocket.OPEN) {
                const wakeUpMessage = { user_audio_chunk: "" }
                elevenLabsWs.send(JSON.stringify(wakeUpMessage))
                console.log('👋 Sent wake-up message to ElevenLabs agent')
              }
            }, 100)
          }
          break

        case 'media':
          if (message.media?.payload) {
            const audioMessage = {
              user_audio_chunk: message.media.payload
            }
            const audioMessageStr = JSON.stringify(audioMessage)
            
            if (elevenLabsWs?.readyState === WebSocket.OPEN && agentReady && conversationId) {
              elevenLabsWs.send(audioMessageStr)
              // Only log every 30th audio message to reduce spam
              if (Math.random() < 0.03) {
                console.log('🎤 ✅ Sent audio chunk to ElevenLabs (payload length:', message.media.payload.length, ')')
              }
            } else {
              // Buffer audio until ElevenLabs is ready
              audioBuffer.push(audioMessageStr)
              if (audioBuffer.length % 15 === 0) {
                console.log(`📦 Buffering audio - ${audioBuffer.length} chunks waiting`)
                console.log(`   ElevenLabs ready: ${agentReady}, conversation: ${!!conversationId}`)
              }
              
              // Keep buffer size manageable but larger for better audio continuity
              if (audioBuffer.length > 150) {
                audioBuffer.shift() // Remove oldest chunk
              }
            }
          }
          break

        case 'stop':
          console.log('🔌 Twilio stream stopped')
          if (elevenLabsWs?.readyState === WebSocket.OPEN) {
            elevenLabsWs.close()
          }
          audioBuffer = []
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
    audioBuffer = []
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
