import { identifyVoiceprint, joinAudioBuffers } from './voiceprint'

export interface RecognitionResult {
  text: string
  final: boolean
  beginTime: number
  endTime: number
  speaker: 1 | 2
  speakerConfidence: number
  staffName?: string
  voiceprintMatched?: boolean
}

interface RecognitionCallbacks {
  onReady?: () => void
  onResult?: (result: RecognitionResult) => void
  onSpeakerResolved?: (result: RecognitionResult) => void
  onLevel?: (level: number) => void
  onError?: (error: Error) => void
  onClose?: () => void
}

interface RecognitionOptions {
  noiseReduction?: boolean
}

interface VoiceSignature {
  rms: number
  zeroCrossing: number
  brightness: number
}

interface VoiceCluster extends VoiceSignature {
  samples: number
}

function downsample(input: Float32Array, inputRate: number, outputRate = 16000) {
  if (inputRate === outputRate) return input
  const ratio = inputRate / outputRate
  const length = Math.round(input.length / ratio)
  const output = new Float32Array(length)
  for (let i = 0; i < length; i += 1) {
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

function analyze(input: Float32Array): VoiceSignature | null {
  let energy = 0
  let crossings = 0
  let difference = 0
  for (let i = 0; i < input.length; i += 1) {
    energy += input[i] * input[i]
    if (i > 0) {
      if ((input[i] >= 0) !== (input[i - 1] >= 0)) crossings += 1
      difference += Math.abs(input[i] - input[i - 1])
    }
  }
  const rms = Math.sqrt(energy / input.length)
  if (rms < 0.012) return null
  return {
    rms,
    zeroCrossing: crossings / input.length,
    brightness: difference / Math.max(1, input.length - 1),
  }
}

function distance(a: VoiceSignature, b: VoiceSignature) {
  return Math.sqrt(
    ((a.rms - b.rms) / 0.12) ** 2
      + ((a.zeroCrossing - b.zeroCrossing) / 0.12) ** 2
      + ((a.brightness - b.brightness) / 0.16) ** 2,
  )
}

function rmsLevel(input: Float32Array) {
  let energy = 0
  for (let i = 0; i < input.length; i += 1) energy += input[i] * input[i]
  return Math.sqrt(energy / Math.max(1, input.length))
}

export async function startRealtimeRecognition(callbacks: RecognitionCallbacks = {}, options: RecognitionOptions = {}) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器不支持麦克风采集。')
  const noiseReduction = options.noiseReduction !== false

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: noiseReduction,
      autoGainControl: false,
    },
  })
  const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  const context = new AudioContextClass()
  await context.resume()
  const source = context.createMediaStreamSource(stream)
  const highPass = context.createBiquadFilter()
  highPass.type = 'highpass'
  highPass.frequency.value = 90
  highPass.Q.value = 0.7
  const lowPass = context.createBiquadFilter()
  lowPass.type = 'lowpass'
  lowPass.frequency.value = 7200
  lowPass.Q.value = 0.7
  const compressor = context.createDynamicsCompressor()
  compressor.threshold.value = -28
  compressor.knee.value = 18
  compressor.ratio.value = 3
  compressor.attack.value = 0.004
  compressor.release.value = 0.18
  const processor = context.createScriptProcessor(4096, 1, 1)
  const silentGain = context.createGain()
  silentGain.gain.value = 0
  if (noiseReduction) {
    source.connect(highPass)
    highPass.connect(lowPass)
    lowPass.connect(compressor)
    compressor.connect(processor)
  } else {
    source.connect(processor)
  }
  processor.connect(silentGain)
  silentGain.connect(context.destination)

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocket(`${protocol}//${location.host}/ws/asr`)
  socket.binaryType = 'arraybuffer'
  let stopped = false
  let ready = false
  let utteranceFeatures: VoiceSignature[] = []
  let utteranceAudio: ArrayBuffer[] = []
  let lastFinalText = ''
  let lastFinalEndTime = -1
  let lastFinalAt = 0
  let noiseFloor = 0.003
  let gateGain = 1
  const clusters: VoiceCluster[] = []

  function reduceBackgroundNoise(input: Float32Array) {
    const level = rmsLevel(input)
    if (level < Math.max(0.006, noiseFloor * 1.8)) {
      noiseFloor = noiseFloor * 0.94 + level * 0.06
    }
    const threshold = Math.max(0.006, noiseFloor * 2.1)
    const targetGain = level < threshold ? 0.18 : 1
    gateGain += (targetGain - gateGain) * (targetGain > gateGain ? 0.86 : 0.16)
    const output = input.slice()
    for (let i = 0; i < output.length; i += 1) output[i] *= gateGain
    return output
  }

  function isDuplicateFinal(text: string, endTime: number) {
    if (!text || text !== lastFinalText) return false
    if (endTime > 0 && lastFinalEndTime > 0) return Math.abs(endTime - lastFinalEndTime) < 500
    return Date.now() - lastFinalAt < 1200
  }

  function averageSignature() {
    if (!utteranceFeatures.length) return null
    return utteranceFeatures.reduce<VoiceSignature>((sum, item) => ({
      rms: sum.rms + item.rms / utteranceFeatures.length,
      zeroCrossing: sum.zeroCrossing + item.zeroCrossing / utteranceFeatures.length,
      brightness: sum.brightness + item.brightness / utteranceFeatures.length,
    }), { rms: 0, zeroCrossing: 0, brightness: 0 })
  }

  function previewSpeaker(): { speaker: 1 | 2; confidence: number } {
    const signature = averageSignature()
    if (!signature || !clusters.length) return { speaker: 1, confidence: signature ? 0.7 : 0.5 }
    const distances = clusters.map((cluster) => distance(signature, cluster))
    if (clusters.length === 1 && distances[0] > 0.42) {
      return { speaker: 2, confidence: Math.min(0.9, 0.6 + distances[0] * 0.22) }
    }
    const index = distances[0] <= (distances[1] ?? Number.POSITIVE_INFINITY) ? 0 : 1
    const nearest = distances[index]
    const other = distances[index === 0 ? 1 : 0]
    const confidence = other === undefined ? 0.64 : Math.min(0.94, 0.56 + Math.max(0, other - nearest) * 0.5)
    return { speaker: (index + 1) as 1 | 2, confidence }
  }

  function assignSpeaker(): { speaker: 1 | 2; confidence: number } {
    const signature = averageSignature()
    utteranceFeatures = []
    if (!signature) return { speaker: 1, confidence: 0.5 }

    if (!clusters.length) {
      clusters.push({ ...signature, samples: 1 })
      return { speaker: 1, confidence: 0.88 }
    }
    const distances = clusters.map((cluster) => distance(signature, cluster))
    let index = distances[0] <= (distances[1] ?? Number.POSITIVE_INFINITY) ? 0 : 1
    if (clusters.length === 1 && distances[0] > 0.42) {
      clusters.push({ ...signature, samples: 1 })
      return { speaker: 2, confidence: Math.min(0.92, 0.62 + distances[0] * 0.25) }
    }
    const nearest = distances[index]
    const other = distances[index === 0 ? 1 : 0]
    const cluster = clusters[index]
    cluster.samples += 1
    const weight = Math.min(0.22, 1 / cluster.samples)
    cluster.rms += (signature.rms - cluster.rms) * weight
    cluster.zeroCrossing += (signature.zeroCrossing - cluster.zeroCrossing) * weight
    cluster.brightness += (signature.brightness - cluster.brightness) * weight
    const confidence = other === undefined ? 0.64 : Math.min(0.96, 0.58 + Math.max(0, other - nearest) * 0.55)
    return { speaker: (index + 1) as 1 | 2, confidence }
  }

  processor.onaudioprocess = (event) => {
    if (!ready || socket.readyState !== WebSocket.OPEN) return
    const samples = downsample(event.inputBuffer.getChannelData(0), context.sampleRate)
    const feature = analyze(samples)
    if (feature) utteranceFeatures.push(feature)
    if (feature) utteranceAudio.push(toPcm16(samples.slice()))
    callbacks.onLevel?.(Math.min(1, (feature?.rms || 0) * 9))
    socket.send(toPcm16(noiseReduction ? reduceBackgroundNoise(samples) : samples))
  }

  socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'start' })))
  socket.addEventListener('message', async (event) => {
    if (typeof event.data !== 'string') return
    let message: Record<string, unknown>
    try { message = JSON.parse(event.data) as Record<string, unknown> } catch { return }
    if (message.type === 'ready') {
      ready = true
      callbacks.onReady?.()
    }
    if (message.type === 'result') {
      const final = Boolean(message.final)
      const text = String(message.text || '').trim()
      const endTime = Number(message.end_time || 0)
      if (!text || !/[\p{L}\p{N}]/u.test(text)) return
      if (final && isDuplicateFinal(text, endTime)) return
      if (final) {
        lastFinalText = text
        lastFinalEndTime = endTime
        lastFinalAt = Date.now()
      }
      const assignment = final ? assignSpeaker() : previewSpeaker()
      const result: RecognitionResult = {
        text,
        final,
        beginTime: Number(message.begin_time || 0),
        endTime,
        speaker: assignment.speaker,
        speakerConfidence: assignment.confidence,
      }
      callbacks.onResult?.(result)

      if (final) {
        const audio = utteranceAudio.length ? joinAudioBuffers(utteranceAudio) : null
        utteranceAudio = []
        if (audio) {
          void identifyVoiceprint(audio).then((match) => {
            if (!match.matched || stopped) return
            callbacks.onSpeakerResolved?.({
              ...result,
              speaker: 2,
              speakerConfidence: match.confidence ?? match.score,
              staffName: match.name || undefined,
              voiceprintMatched: true,
            })
          }).catch(() => {
            // The acoustic speaker assignment remains usable while the online match is unavailable.
          })
        }
      }
    }
    if (message.type === 'error') callbacks.onError?.(new Error(String(message.error || '实时识别失败。')))
  })
  socket.addEventListener('error', () => {
    if (!stopped) callbacks.onError?.(new Error('实时识别连接失败。'))
  })
  socket.addEventListener('close', () => {
    if (!stopped) callbacks.onClose?.()
  })

  return async () => {
    if (stopped) return
    stopped = true
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'finish' }))
    processor.disconnect()
    source.disconnect()
    highPass.disconnect()
    lowPass.disconnect()
    compressor.disconnect()
    silentGain.disconnect()
    stream.getTracks().forEach((track) => track.stop())
    await context.close()
    window.setTimeout(() => socket.close(), 300)
  }
}
