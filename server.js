
// server.js - Create this file in your project root
const { WebSocketServer } = require('ws')
const WebSocket = require('ws')
const http = require('http')

// Create HTTP server
const server = http.createServer()

// Create WebSocket server
const wss = new WebSocketServer({ server })

console.log('🚀 Starting ElevenLabs-Twilio bridge server...')

wss.on('connection', (twilioWs, request) => {
  console.log('📞 New Twilio WebSocket connection')
  
  let elevenLabsWs = null
  let streamSid = null
  let conversationId = null
  
  // Function to connect to ElevenLabs
  const connectToElevenLabs = async () => {
    try {
      console.log('🔗 Connecting to ElevenLabs...')
      
      const agentId = process.env.ELEVENLABS_DISCOVERY_AGENT_ID
      const apiKey = process.env.ELEVENLABS_API_KEY
      
      if (!agentId || !apiKey) {
        console.error('❌ Missing ElevenLabs credentials')
        return
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
        
        // Send conversation initiation with user context
        const initMessage = {
          type: 'conversation_initiation_client_data',
          conversation_initiation_client_data: {
            user_name: 'James',
            is_first_call: true,
            conversation_type: 'discovery'
          }
        }
        elevenLabsWs.send(JSON.stringify(initMessage))
      })
      
      elevenLabsWs.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString())
          console.log('📨 ElevenLabs message:', message.type)
          
          switch (message.type) {
            case 'conversation_initiation_metadata':
              conversationId = message.conversation_initiation_metadata_event?.conversation_id
              console.log('✅ ElevenLabs conversation initiated:', conversationId)
              break
              
            case 'audio':
              // Forward AI audio to Twilio
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
              }
              break
              
            case 'interruption':
              // Clear Twilio audio buffer when AI is interrupted
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
              // Respond to ping with pong to keep connection alive
              if (elevenLabsWs.readyState === WebSocket.OPEN) {
                elevenLabsWs.send(JSON.stringify({ type: 'pong' }))
              }
              break
              
            case 'conversation_end':
              console.log('✅ ElevenLabs conversation ended')
              if (twilioWs.readyState === WebSocket.OPEN) {
                twilioWs.close()
              }
              break
              
            default:
              console.log('📋 Other ElevenLabs message:', message.type)
          }
        } catch (error) {
          console.error('❌ Error processing ElevenLabs message:', error)
        }
      })
      
      elevenLabsWs.on('error', (error) => {
        console.error('❌ ElevenLabs WebSocket error:', error)
      })
      
      elevenLabsWs.on('close', (code, reason) => {
        console.log('🔌 ElevenLabs WebSocket closed:', code, reason.toString())
      })
      
    } catch (error) {
      console.error('❌ Failed to connect to ElevenLabs:', error)
    }
  }
  
  // Handle messages from Twilio
  twilioWs.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString())
      
      switch (message.event) {
        case 'start':
          streamSid = message.start.streamSid
          console.log('✅ Twilio stream started:', streamSid)
          console.log('📋 Call metadata:', message.start)
          
          // Connect to ElevenLabs when Twilio stream starts
          connectToElevenLabs()
          break
          
        case 'media':
          // Forward user audio to ElevenLabs
          if (elevenLabsWs?.readyState === WebSocket.OPEN && message.media?.payload) {
            const audioMessage = {
              user_audio_chunk: message.media.payload
            }
            elevenLabsWs.send(JSON.stringify(audioMessage))
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
      }
    } catch (error) {
      console.error('❌ Error processing Twilio message:', error)
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

// Start the server
const PORT = process.env.WS_PORT || 8080
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 WebSocket bridge server running on port ${PORT}`)
  console.log(`📞 Ready to bridge Twilio ↔ ElevenLabs`)
})
