const { WebSocketServer } = require('ws')
const WebSocket = require('ws')
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
    <Stream url="wss://elevenlabs-twilio-bridge-production-95ab.up.railway.app">
      <Parameter name="codec" value="audio/l16;rate=16000"/>
    </Stream>
  </Connect>
</Response>`

    res.writeHead(200, { 'Content-Type': 'application/xml' })
    res.end(twiml)
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('ElevenLabs-Twilio WebSocket Bridge Running')
  }
})

const wss = new WebSocketServer({ server })

wss.on('connection', (twilioWs, request) => {
  console.log('📞 New Twilio WebSocket connection established!')

  let elevenLabsWs = null
  let streamSid = null
  let audioBuffer = []
  let elevenlabsReady = false

  const connectToElevenLabs = async () => {
    try {
      console.log('🔗 Connecting to ElevenLabs...')

      const agentId = process.env.ELEVENLABS_DISCOVERY_AGENT_ID || 'agent_01k0q3vpk7f8bsrq2aqk71v9j9'
      const apiKey = process.env.ELEVENLABS_API_KEY

      if (!agentId || !apiKey) {
        console.error('❌ Missing ElevenLabs credentials')
        return
      }

      const apiUrl = `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${agentId}`
      const response = await fetch(apiUrl, {
        method: 'GET',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json'
        }
      })

      if (!response.ok) {
        console.error('❌ Failed to get ElevenLabs signed URL')
        return
      }

      const data = await response.json()
      if (!data.signed_url) {
        console.error('❌ No signed_url in response')
        return
      }

      elevenLabsWs = new WebSocket(data.signed_url)

      elevenLabsWs.on('open', () => {
        console.log('✅ Connected to ElevenLabs agent')
        elevenlabsReady = true
        audioBuffer.forEach(audio => elevenLabsWs.send(audio))
        audioBuffer = []
      })

      elevenLabsWs.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString())

          if (message.type === 'conversation_initiation_metadata') {
            elevenLabsWs.send(JSON.stringify({ user_audio_chunk: "" }))
          }

          if (message.type === 'audio' && twilioWs.readyState === WebSocket.OPEN && streamSid && message.audio_event?.audio_base_64) {
            const audioMessage = {
              event: 'media',
              streamSid: streamSid,
              media: {
                payload: message.audio_event.audio_base_64
              }
            }
            twilioWs.send(JSON.stringify(audioMessage))
          }

        } catch (err) {
          console.error('❌ Error processing ElevenLabs message:', err)
        }
      })
    } catch (err) {
      console.error('❌ Error connecting to ElevenLabs:', err)
    }
  }

  twilioWs.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString())

      switch (message.event) {
        case 'start':
          streamSid = message.start.streamSid
          connectToElevenLabs()
          break

        case 'media':
          if (elevenlabsReady && elevenLabsWs?.readyState === WebSocket.OPEN && message.media?.payload) {
            const audioMessage = {
              user_audio_chunk: message.media.payload
            }
            elevenLabsWs.send(JSON.stringify(audioMessage))
          } else {
            const audioMessage = {
              user_audio_chunk: message.media?.payload || ""
            }
            audioBuffer.push(JSON.stringify(audioMessage))
          }
          break

        case 'stop':
          if (elevenLabsWs?.readyState === WebSocket.OPEN) {
            elevenLabsWs.close()
          }
          break
      }
    } catch (err) {
      console.error('❌ Error processing Twilio message:', err)
    }
  })

  twilioWs.on('close', () => {
    if (elevenLabsWs?.readyState === WebSocket.OPEN) {
      elevenLabsWs.close()
    }
  })
})

const PORT = process.env.PORT || 5000
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 WebSocket bridge running on port ${PORT}`)
})
