export interface AliyunConfig {
  configured: boolean
  provider: string
  model: string
  asr_sentence_silence_ms?: number
  voice: string
  workspace_id: string
  region: string
  voice_profiles: Record<string, { voice: string; name: string; instruction: string; trait: string }>
  capabilities: string[]
}

interface SpeechResult {
  audio_url: string
  upstream_ms: number
}

interface RewriteResult {
  text: string
  upstream_ms: number
}

export interface AssistResult {
  suggestion: {
    intro: string
    items: string[]
    closing: string
    reply: string
  }
  summary: string[]
  model: string
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || '阿里云服务请求失败。')
  return data as T
}

export function getAliyunConfig() {
  return requestJson<AliyunConfig>('/api/aliyun/config')
}

export function synthesizeSpeech(text: string, dialect = '粤语') {
  return requestJson<SpeechResult>('/api/aliyun/synthesize', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, dialect }),
  })
}

interface StreamCallbacks {
  onFirstAudio?: (milliseconds: number) => void
  onProfile?: (profile: { dialect: string; voice: string; voice_name: string }) => void
  onDone?: (milliseconds: number) => void
  onEnded?: () => void
  onError?: (error: Error) => void
}

export function streamSpeech(text: string, dialect: string, callbacks: StreamCallbacks = {}) {
  if (!('MediaSource' in window)) throw new Error('当前浏览器不支持流式音频。')

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocket(`${protocol}//${location.host}/ws/tts`)
  socket.binaryType = 'arraybuffer'

  const mediaSource = new MediaSource()
  const audio = new Audio(URL.createObjectURL(mediaSource))
  const chunks: ArrayBuffer[] = []
  let sourceBuffer: SourceBuffer | null = null
  let upstreamDone = false
  let stopped = false
  let objectUrlRevoked = false

  function cleanupUrl() {
    if (objectUrlRevoked) return
    objectUrlRevoked = true
    URL.revokeObjectURL(audio.src)
  }

  function finishMediaStream() {
    if (!upstreamDone || !sourceBuffer || sourceBuffer.updating || chunks.length || mediaSource.readyState !== 'open') return
    mediaSource.endOfStream()
  }

  function appendNext() {
    if (!sourceBuffer || sourceBuffer.updating || !chunks.length) {
      finishMediaStream()
      return
    }
    sourceBuffer.appendBuffer(chunks.shift()!)
  }

  mediaSource.addEventListener('sourceopen', () => {
    try {
      sourceBuffer = mediaSource.addSourceBuffer('audio/mpeg')
      sourceBuffer.addEventListener('updateend', appendNext)
      appendNext()
      void audio.play().catch(() => undefined)
    } catch (error) {
      callbacks.onError?.(error instanceof Error ? error : new Error(String(error)))
    }
  })

  audio.addEventListener('ended', () => {
    cleanupUrl()
    callbacks.onEnded?.()
  })

  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'start', dialect }))
    socket.send(JSON.stringify({ type: 'text', text }))
    socket.send(JSON.stringify({ type: 'finish' }))
  })

  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') {
      chunks.push(event.data)
      appendNext()
      void audio.play().catch(() => undefined)
      return
    }

    const message = JSON.parse(event.data)
    if (message.type === 'profile') callbacks.onProfile?.(message)
    if (message.type === 'first-audio') callbacks.onFirstAudio?.(Number(message.ms || 0))
    if (message.type === 'done') {
      upstreamDone = true
      callbacks.onDone?.(Number(message.total_ms || 0))
      finishMediaStream()
    }
    if (message.type === 'error') callbacks.onError?.(new Error(message.error || '阿里云流式语音失败。'))
  })

  socket.addEventListener('error', () => {
    if (!stopped) callbacks.onError?.(new Error('流式语音连接失败。'))
  })

  return () => {
    stopped = true
    socket.close()
    audio.pause()
    cleanupUrl()
  }
}

export function rewriteDialect(text: string, dialect: string) {
  return requestJson<RewriteResult>('/api/aliyun/rewrite', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, dialect }),
  })
}

export function translateToMandarin(text: string) {
  return requestJson<{ text: string }>('/api/aliyun/translate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  })
}

export function generateConversationAssist(
  messages: Array<{ speaker: number; text: string; translation: string }>,
  service: string,
  dialect: string,
) {
  return requestJson<AssistResult>('/api/aliyun/assist', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages, service, dialect }),
  })
}
