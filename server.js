const { WebSocketServer } = require('ws')
const WebSocket = require('ws')
let fetch;
(async () => {
  fetch = (await import('node-fetch')).default;
})();
const http = require('http')

const server = http.createServer((req, res) => {
  if (req.url === '/twiml' && req.method === 'POST') {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${process.env.RAILWAY_PUBLIC_DOMAIN}">
      <Parameter name="codec" value="audio/l16;rate=16000"/>
      <Parameter name="debug" value="true"/>
    </Stream>
  </Connect>
</Response>`
    res.writeHead(200, { 'Content-Type': 'application/xml' })
    res.end(twiml)
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('Server running')
  }
})

const wss = new WebSocketServer({ server })

wss.on('connection', (twilioWs) => {
  console.log('📞 New Twilio WebSocket connection established!')

  let elevenLabsWs = null
  let streamSid = null
  let audioBuffer = []
  let elevenlabsReady = false

  const connectToElevenLabs = async () => {
    const agentId = process.env.ELEVENLABS_DISCOVERY_AGENT_ID
    const apiKey = process.env.ELEVENLABS_API_KEY

    const response = await fetch(`https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${agentId}`, {
      method: 'GET',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
      },
    })

    const data = await response.json()
    if (!data.signed_url) {
      console.error('❌ Failed to get signed URL')
      return
    }

    elevenLabsWs = new WebSocket(data.signed_url)

    elevenLabsWs.on('open', () => {
      console.log('✅ Connected to ElevenLabs agent')
      elevenlabsReady = true

      // 👇 FIX: Tell ElevenLabs you're ready to speak
      elevenLabsWs.send(JSON.stringify({ user_audio_chunk: "" }))
      console.log('🟢 Sent initial empty audio chunk to ElevenLabs')

      audioBuffer.forEach(audio => elevenLabsWs.send(audio))
      audioBuffer = []
    })

    elevenLabsWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())

        // ✅ Add this debug log to see if ElevenLabs is replying at all
        console.log('📩 Message from ElevenLabs:', msg)

        if (msg.type === 'audio' && msg.audio_event?.audio_base_64 && twilioWs.readyState === WebSocket.OPEN) {
          const twilioMsg = {
            event: 'media',
            streamSid,
            media: {
              payload: msg.audio_event.audio_base_64
            }
          }
          twilioWs.send(JSON.stringify(twilioMsg))
        }

        if (msg.type === 'conversation_initiation_metadata') {
          elevenLabsWs.send(JSON.stringify({ user_audio_chunk: '' }))
        }

      } catch (err) {
        console.error('❌ ElevenLabs message error:', err)
      }
    })
  }

  twilioWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString())

      if (msg.event === 'start') {
        streamSid = msg.start.streamSid
        console.log('▶️ Stream started:', streamSid)
        connectToElevenLabs()
      }

      if (msg.event === 'media' && msg.media?.payload) {
        const audioMsg = JSON.stringify({ user_audio_chunk: msg.media.payload })
        if (elevenlabsReady && elevenLabsWs?.readyState === WebSocket.OPEN) {
          console.log('🔊 Forwarding audio chunk to ElevenLabs')
          elevenLabsWs.send(audioMsg)
        } else {
          console.log('🛑 Buffering audio chunk, ElevenLabs not ready')
          audioBuffer.push(audioMsg)
        }
      }

      if (msg.event === 'stop') {
        console.log('⏹️ Call ended')
        if (elevenLabsWs?.readyState === WebSocket.OPEN) elevenLabsWs.close()
      }

    } catch (err) {
      console.error('❌ Twilio message error:', err)
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
