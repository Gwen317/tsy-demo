export interface VoiceprintStaff {
  staff_id: string
  name: string
  samples: number
}

export interface VoiceprintMatch {
  matched: boolean
  staff_id?: string | null
  name?: string | null
  score: number
  threshold?: number
  reason?: string
}

function downsample(input: Float32Array, inputRate: number, outputRate = 16000) {
  if (inputRate === outputRate) return input
  const ratio = inputRate / outputRate
  const output = new Float32Array(Math.round(input.length / ratio))
  for (let i = 0; i < output.length; i += 1) {
    const start = Math.floor(i * ratio)
    const end = Math.min(input.length, Math.floor((i + 1) * ratio))
    let sum = 0
    for (let j = start; j < end; j += 1) sum += input[j]
    output[i] = sum / Math.max(1, end - start)
  }
  return output
}

function toPcm16(input: Float32Array) {
  const buffer = new ArrayBuffer(input.length * 2)
  const view = new DataView(buffer)
  input.forEach((sample, index) => {
    const value = Math.max(-1, Math.min(1, sample))
    view.setInt16(index * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true)
  })
  return buffer
}

export function joinAudioBuffers(buffers: ArrayBuffer[]) {
  const length = buffers.reduce((total, item) => total + item.byteLength, 0)
  const output = new Uint8Array(length)
  let offset = 0
  buffers.forEach((item) => {
    output.set(new Uint8Array(item), offset)
    offset += item.byteLength
  })
  return output.buffer
}

async function readResponse<T>(response: Response) {
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || '声纹服务请求失败。')
  return data as T
}

export async function listVoiceprints() {
  return readResponse<{ ready: boolean; staff: VoiceprintStaff[] }>(await fetch('/api/voiceprints'))
}

export async function enrollVoiceprint(staffId: string, name: string, pcm: ArrayBuffer) {
  return readResponse<VoiceprintStaff>(await fetch('/api/voiceprints/enroll', {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'x-staff-id': staffId,
      'x-staff-name': encodeURIComponent(name),
    },
    body: pcm,
  }))
}

export async function identifyVoiceprint(pcm: ArrayBuffer) {
  return readResponse<VoiceprintMatch>(await fetch('/api/voiceprints/identify', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: pcm,
  }))
}

export async function deleteVoiceprint(staffId: string) {
  return readResponse<{ removed: boolean }>(await fetch(`/api/voiceprints/${encodeURIComponent(staffId)}`, { method: 'DELETE' }))
}

export async function captureVoiceprintSample(seconds = 8, onProgress?: (remaining: number) => void) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false } })
  const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  const context = new AudioContextClass()
  await context.resume()
  const source = context.createMediaStreamSource(stream)
  const processor = context.createScriptProcessor(4096, 1, 1)
  const silentGain = context.createGain()
  silentGain.gain.value = 0
  const buffers: ArrayBuffer[] = []
  source.connect(processor)
  processor.connect(silentGain)
  silentGain.connect(context.destination)
  processor.onaudioprocess = (event) => {
    buffers.push(toPcm16(downsample(event.inputBuffer.getChannelData(0), context.sampleRate)))
  }
  const startedAt = Date.now()
  const timer = window.setInterval(() => {
    onProgress?.(Math.max(0, seconds - Math.floor((Date.now() - startedAt) / 1000)))
  }, 250)
  await new Promise((resolve) => window.setTimeout(resolve, seconds * 1000))
  window.clearInterval(timer)
  processor.disconnect()
  source.disconnect()
  silentGain.disconnect()
  stream.getTracks().forEach((track) => track.stop())
  await context.close()
  onProgress?.(0)
  return joinAudioBuffers(buffers)
}
