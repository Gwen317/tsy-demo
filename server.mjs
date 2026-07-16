import { createServer as createHttpServer } from 'node:http'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import Meyda from 'meyda'
import WebSocket, { WebSocketServer } from 'ws'

const rootDir = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(rootDir, '.env.local') })
dotenv.config({ path: path.join(rootDir, '.env') })

const HOST = process.env.HOST || '127.0.0.1'
const PORT = Number(process.env.PORT || 4173)
const API_KEY = process.env.DASHSCOPE_API_KEY || process.env.ALIYUN_BAILIAN_API_KEY || ''
const MODEL = process.env.COSYVOICE_MODEL || 'cosyvoice-v3-flash'
const DEFAULT_VOICE = process.env.COSYVOICE_DEFAULT_VOICE || 'longanhuan_v3'
const WORKSPACE_ID = process.env.DASHSCOPE_WORKSPACE_ID || 'llm-9okku7exfrpx4pkf'
const REGION = process.env.DASHSCOPE_REGION || 'cn-beijing'
const REWRITE_MODEL = process.env.REWRITE_MODEL || 'qwen-plus'
const ASR_MODEL = process.env.ASR_MODEL || 'fun-asr-realtime'
const ASR_SENTENCE_SILENCE_MS = Math.min(800, Math.max(700, Number(process.env.ASR_SENTENCE_SILENCE_MS || 750)))
const TTS_URL = 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer'
const CHAT_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
const REALTIME_TTS_URL = `wss://${WORKSPACE_ID}.${REGION}.maas.aliyuncs.com/api-ws/v1/inference`
const VOICEPRINT_DIR = path.join(rootDir, '.voiceprint-data')
const VOICEPRINT_FILE = path.join(VOICEPRINT_DIR, 'voiceprints.json')
const VOICEPRINT_THRESHOLD = Number(process.env.VOICEPRINT_THRESHOLD || 0.6)
const XFYUN_APP_ID = process.env.XFYUN_APP_ID || ''
const XFYUN_API_KEY = process.env.XFYUN_API_KEY || ''
const XFYUN_API_SECRET = process.env.XFYUN_API_SECRET || ''
const XFYUN_VOICEPRINT_URL = process.env.XFYUN_VOICEPRINT_URL || 'https://api.xf-yun.com/v1/private/s1aa729d0'
const XFYUN_VOICEPRINT_GROUP_ID = process.env.XFYUN_VOICEPRINT_GROUP_ID || 'tsy_staff'
const XFYUN_VOICEPRINT_CONFIGURED = Boolean(XFYUN_APP_ID && XFYUN_API_KEY && XFYUN_API_SECRET)
const VOICEPRINT_PROVIDER = (process.env.VOICEPRINT_PROVIDER || (XFYUN_VOICEPRINT_CONFIGURED ? 'xfyun' : 'local')).toLowerCase()
const voiceprintReady = VOICEPRINT_PROVIDER === 'xfyun' ? XFYUN_VOICEPRINT_CONFIGURED : true
Meyda.sampleRate = 16000
Meyda.bufferSize = 512
Meyda.numberOfMFCCCoefficients = 13

async function loadVoiceprints() {
  try { return JSON.parse(await readFile(VOICEPRINT_FILE, 'utf8')) } catch { return {} }
}

async function saveVoiceprints(database) {
  await mkdir(VOICEPRINT_DIR, { recursive: true })
  await writeFile(VOICEPRINT_FILE, JSON.stringify(database), 'utf8')
}

function normalizeVector(vector) {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1
  return vector.map((value) => value / magnitude)
}

function estimatePitch(frame) {
  const mean = frame.reduce((sum, value) => sum + value, 0) / frame.length
  let bestLag = 0
  let bestCorrelation = 0
  for (let lag = 40; lag <= 267; lag += 1) {
    let correlation = 0
    let leftEnergy = 0
    let rightEnergy = 0
    for (let index = 0; index < frame.length - lag; index += 1) {
      const left = frame[index] - mean
      const right = frame[index + lag] - mean
      correlation += left * right
      leftEnergy += left * left
      rightEnergy += right * right
    }
    const normalized = correlation / (Math.sqrt(leftEnergy * rightEnergy) + 1e-8)
    if (normalized > bestCorrelation) {
      bestCorrelation = normalized
      bestLag = lag
    }
  }
  return {
    pitch: bestCorrelation > 0.28 && bestLag ? 16000 / bestLag : 0,
    periodicity: Math.max(0, bestCorrelation),
  }
}

function extractVoiceprint(audio) {
  if (audio.length < 32000) throw new Error('有效语音不足 1 秒。')
  const samples = new Float32Array(Math.floor(audio.length / 2))
  for (let i = 0; i < samples.length; i += 1) samples[i] = audio.readInt16LE(i * 2) / 32768
  const features = []
  for (let offset = 0; offset + 512 <= samples.length; offset += 256) {
    const frame = samples.slice(offset, offset + 512)
    const result = Meyda.extract(['mfcc', 'zcr', 'spectralCentroid', 'spectralRolloff', 'rms'], frame)
    if (!result || result.rms < 0.005) continue
    const pitch = estimatePitch(frame)
    features.push([
      ...result.mfcc.slice(1, 13).map((value) => value / 100),
      result.zcr / 170,
      result.spectralCentroid / 100,
      result.spectralRolloff / 3000,
      Math.log10(result.rms + 1e-5),
      pitch.pitch / 120,
      pitch.periodicity * 2,
    ])
  }
  if (features.length < 8) throw new Error('去除静音后有效语音不足，请重新录入。')
  const dimensions = features[0].length
  const means = Array.from({ length: dimensions }, (_, index) => features.reduce((sum, feature) => sum + feature[index], 0) / features.length)
  const deviations = Array.from({ length: dimensions }, (_, index) => Math.sqrt(features.reduce((sum, feature) => sum + (feature[index] - means[index]) ** 2, 0) / features.length))
  return normalizeVector([...means, ...deviations])
}

function cosineSimilarity(left, right) {
  return left.reduce((sum, value, index) => sum + value * (right[index] || 0), 0)
}

async function callLocalVoiceprint(action, payload = {}) {
  const database = await loadVoiceprints()
  if (action === 'list') return { staff: Object.entries(database).map(([staffId, item]) => ({ staff_id: staffId, name: item.name, samples: item.samples })) }
  if (action === 'delete') {
    const removed = Boolean(database[payload.staff_id])
    delete database[payload.staff_id]
    await saveVoiceprints(database)
    return { removed }
  }
  const embedding = extractVoiceprint(Buffer.from(payload.audio, 'base64'))
  if (action === 'enroll') {
    if (!payload.staff_id || !payload.name) throw new Error('员工编号和姓名不能为空。')
    const existing = database[payload.staff_id]
    const samples = existing ? existing.samples + 1 : 1
    const merged = existing ? normalizeVector(existing.embedding.map((value, index) => (value * existing.samples + embedding[index]) / samples)) : embedding
    database[payload.staff_id] = { name: payload.name, samples, embedding: merged }
    await saveVoiceprints(database)
    return { staff_id: payload.staff_id, name: payload.name, samples }
  }
  if (action === 'identify') {
    const candidates = Object.entries(database).map(([staffId, item]) => ({ staffId, item, score: cosineSimilarity(embedding, item.embedding) })).sort((a, b) => b.score - a.score)
    if (!candidates.length) return { matched: false, score: 0, reason: 'VOICEPRINT_DATABASE_EMPTY' }
    const best = candidates[0]
    const matched = best.score >= VOICEPRINT_THRESHOLD
    const confidence = matched ? Math.min(1, 0.8 + ((best.score - VOICEPRINT_THRESHOLD) / (1 - VOICEPRINT_THRESHOLD)) * 0.2) : 0
    return {
      matched,
      staff_id: matched ? best.staffId : null,
      name: matched ? best.item.name : null,
      score: Number(best.score.toFixed(4)),
      confidence: Number(confidence.toFixed(4)),
      threshold: VOICEPRINT_THRESHOLD,
    }
  }
  throw new Error('未知的声纹操作。')
}

function xfyunResultFormat() {
  return { encoding: 'utf8', compress: 'raw', format: 'json' }
}

function xfyunFeatureId(staffId) {
  return `vp_${createHash('sha256').update(staffId).digest('hex').slice(0, 24)}`
}

function xfyunFeatureInfo(staffId, name, samples) {
  return JSON.stringify({ staff_id: staffId, name, samples })
}

function parseXfyunFeature(feature) {
  try {
    const info = JSON.parse(feature.featureInfo || '{}')
    return {
      staff_id: String(info.staff_id || feature.featureId),
      name: String(info.name || info.staff_id || feature.featureId),
      samples: Math.max(1, Number(info.samples) || 1),
      feature_id: feature.featureId,
    }
  } catch {
    return {
      staff_id: feature.featureId,
      name: feature.featureInfo || feature.featureId,
      samples: 1,
      feature_id: feature.featureId,
    }
  }
}

function xfyunAudioPayload(audio) {
  if (!audio || Buffer.byteLength(audio, 'base64') < 32000) throw new Error('有效语音不足 1 秒。')
  return {
    resource: {
      encoding: 'raw',
      sample_rate: 16000,
      channels: 1,
      bit_depth: 16,
      status: 3,
      audio,
    },
  }
}

function createXfyunAuthUrl() {
  const endpoint = new URL(XFYUN_VOICEPRINT_URL)
  const date = new Date().toUTCString()
  const requestLine = `POST ${endpoint.pathname} HTTP/1.1`
  const signatureOrigin = `host: ${endpoint.host}\ndate: ${date}\n${requestLine}`
  const signature = createHmac('sha256', XFYUN_API_SECRET).update(signatureOrigin).digest('base64')
  const authorizationOrigin = `api_key="${XFYUN_API_KEY}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`
  endpoint.searchParams.set('authorization', Buffer.from(authorizationOrigin).toString('base64'))
  endpoint.searchParams.set('host', endpoint.host)
  endpoint.searchParams.set('date', date)
  return endpoint
}

function xfyunServiceError(decoded) {
  if (!decoded || Array.isArray(decoded) || typeof decoded !== 'object') return null
  const code = Number(decoded.code ?? decoded.ret ?? 0)
  if (!code) return null
  const detail = decoded.desc || decoded.message || decoded.msg || decoded.info || '未知错误'
  return new Error(`讯飞声纹服务返回错误：${detail}（${code}）`)
}

async function requestXfyunVoiceprint(func, parameters = {}, payload) {
  if (!XFYUN_VOICEPRINT_CONFIGURED) throw new Error('讯飞声纹鉴权信息未配置完整。')
  const resultKey = `${func}Res`
  const body = {
    header: { app_id: XFYUN_APP_ID, status: 3 },
    parameter: {
      s1aa729d0: {
        func,
        ...parameters,
        [resultKey]: xfyunResultFormat(),
      },
    },
    ...(payload ? { payload } : {}),
  }
  const response = await fetch(createXfyunAuthUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok || Number(result.header?.code || 0) !== 0) {
    throw new Error(`讯飞声纹请求失败：${result.header?.message || response.statusText || response.status}`)
  }
  const encoded = result.payload?.[resultKey]?.text
  if (!encoded) return {}
  const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
  const serviceError = xfyunServiceError(decoded)
  if (serviceError) throw serviceError
  return decoded
}

let xfyunGroupPromise

function isXfyunEmptyGroupError(error) {
  return error instanceof Error && /groupId is empty|声纹库为空|特征库为空/i.test(error.message)
}

async function ensureXfyunGroup() {
  if (!xfyunGroupPromise) {
    xfyunGroupPromise = (async () => {
      try {
        await requestXfyunVoiceprint('createGroup', {
          groupId: XFYUN_VOICEPRINT_GROUP_ID,
          groupName: 'Tsy staff voiceprints',
          groupInfo: 'Staff identity profiles for the Tsy demo',
        })
      } catch (createError) {
        try {
          await requestXfyunVoiceprint('queryFeatureList', { groupId: XFYUN_VOICEPRINT_GROUP_ID })
        } catch (queryError) {
          if (isXfyunEmptyGroupError(queryError)) return
          throw createError
        }
      }
    })().catch((error) => {
      xfyunGroupPromise = null
      throw error
    })
  }
  return xfyunGroupPromise
}

async function listXfyunFeatures() {
  await ensureXfyunGroup()
  try {
    const result = await requestXfyunVoiceprint('queryFeatureList', { groupId: XFYUN_VOICEPRINT_GROUP_ID })
    return (Array.isArray(result) ? result : []).map(parseXfyunFeature)
  } catch (error) {
    if (isXfyunEmptyGroupError(error)) return []
    throw error
  }
}

async function callXfyunVoiceprint(action, payload = {}) {
  const staff = await listXfyunFeatures()
  if (action === 'list') return { staff: staff.map(({ feature_id, ...item }) => item) }
  if (action === 'delete') {
    const existing = staff.find((item) => item.staff_id === payload.staff_id)
    if (!existing) return { removed: false }
    await requestXfyunVoiceprint('deleteFeature', {
      groupId: XFYUN_VOICEPRINT_GROUP_ID,
      featureId: existing.feature_id,
    })
    return { removed: true }
  }
  if (action === 'enroll') {
    if (!payload.staff_id || !payload.name) throw new Error('员工编号和姓名不能为空。')
    const existing = staff.find((item) => item.staff_id === payload.staff_id)
    const samples = existing ? existing.samples + 1 : 1
    const featureId = existing?.feature_id || xfyunFeatureId(payload.staff_id)
    const featureInfo = xfyunFeatureInfo(payload.staff_id, payload.name, samples)
    const audioPayload = xfyunAudioPayload(payload.audio)
    if (existing) {
      await requestXfyunVoiceprint('updateFeature', {
        groupId: XFYUN_VOICEPRINT_GROUP_ID,
        featureId,
        featureInfo,
        cover: false,
      }, audioPayload)
    } else {
      await requestXfyunVoiceprint('createFeature', {
        groupId: XFYUN_VOICEPRINT_GROUP_ID,
        featureId,
        featureInfo,
      }, audioPayload)
    }
    return { staff_id: payload.staff_id, name: payload.name, samples }
  }
  if (action === 'identify') {
    if (!staff.length) return { matched: false, score: 0, reason: 'VOICEPRINT_DATABASE_EMPTY' }
    const result = await requestXfyunVoiceprint('searchFea', {
      groupId: XFYUN_VOICEPRINT_GROUP_ID,
      topK: 1,
    }, xfyunAudioPayload(payload.audio))
    const best = Array.isArray(result.scoreList) ? result.scoreList[0] : null
    if (!best) return { matched: false, score: 0, reason: 'VOICEPRINT_NO_MATCH' }
    const profile = staff.find((item) => item.feature_id === best.featureId) || parseXfyunFeature(best)
    const score = Number(best.score || 0)
    const matched = score >= VOICEPRINT_THRESHOLD
    return {
      matched,
      staff_id: matched ? profile.staff_id : null,
      name: matched ? profile.name : null,
      score: Number(score.toFixed(4)),
      confidence: Number(Math.max(0, score).toFixed(4)),
      threshold: VOICEPRINT_THRESHOLD,
    }
  }
  throw new Error('未知的声纹操作。')
}

async function callVoiceprint(action, payload = {}) {
  return VOICEPRINT_PROVIDER === 'xfyun'
    ? callXfyunVoiceprint(action, payload)
    : callLocalVoiceprint(action, payload)
}

const voiceProfiles = {
  粤语: { voice: 'longjiayi_v3', name: '龙嘉怡', instruction: '', trait: '知性粤语女' },
  广东话: { voice: 'longjiayi_v3', name: '龙嘉怡', instruction: '', trait: '知性粤语女' },
  四川话: { voice: 'longanhuan_v3', name: '龙安欢', instruction: '请用四川话表达。', trait: '元气女声' },
  闽南语: { voice: 'longanmin_v3', name: '龙安闽', instruction: '', trait: '清甜闽南女' },
  东北话: { voice: 'longlaotie_v3', name: '龙老铁', instruction: '', trait: '东北直率男' },
  河南话: { voice: 'longanhuan_v3', name: '龙安欢', instruction: '请用河南话表达。', trait: '元气女声' },
  陕西话: { voice: 'longshange_v3', name: '龙陕哥', instruction: '', trait: '原味陕北男' },
  山东话: { voice: 'longanhuan_v3', name: '龙安欢', instruction: '请用山东话表达。', trait: '元气女声' },
  湖南话: { voice: 'longanhuan_v3', name: '龙安欢', instruction: '请用湖南话表达。', trait: '元气女声' },
  安徽话: { voice: 'longanhuan_v3', name: '龙安欢', instruction: '请用安徽话表达。', trait: '元气女声' },
}

function resolveVoiceProfile(dialect) {
  return voiceProfiles[dialect] || { voice: DEFAULT_VOICE, name: '龙安欢', instruction: '', trait: '通用女声' }
}

const dialectPrompts = {
  粤语: '将原文改写成自然、易懂的粤语口语。使用常见粤语汉字，保留原意，适合政务窗口朗读。',
  四川话: '将原文轻度改写成自然四川话口吻，使用常见表达，保留原意，适合政务窗口朗读。',
  闽南语: '将原文改写成自然、易懂的闽南语口吻，优先使用常见汉字，保留原意，适合语音合成。',
  东北话: '将原文轻度改写成自然东北话口吻，保留原意，使用常见表达，适合政务窗口朗读。',
  河南话: '将原文轻度改写成自然河南话口吻，保留原意，使用常见表达，适合政务窗口朗读。',
  陕西话: '将原文轻度改写成自然陕西话口吻，保留原意，使用常见表达，适合政务窗口朗读。',
  山东话: '将原文轻度改写成自然山东话口吻，保留原意，使用常见表达，适合政务窗口朗读。',
  湖南话: '将原文轻度改写成自然湖南话口吻，保留原意，使用常见表达，适合政务窗口朗读。',
  安徽话: '将原文轻度改写成自然安徽话口吻，保留原意，使用常见表达，适合政务窗口朗读。',
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function readBuffer(req, maxBytes = 2 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new Error('AUDIO_TOO_LARGE')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function pickAudioUrl(data) {
  return data?.output?.audio?.url || data?.output?.url || data?.audio?.url || data?.url || ''
}

async function handleSynthesize(req, res) {
  if (!API_KEY) {
    sendJson(res, 503, { error: '阿里云百炼 API Key 尚未配置。', code: 'ALIYUN_NOT_CONFIGURED' })
    return
  }

  let body
  try {
    body = await readJson(req)
  } catch {
    sendJson(res, 400, { error: '请求内容不是有效 JSON。' })
    return
  }

  const text = String(body.text || '').trim()
  const dialect = String(body.dialect || '粤语')
  const profile = resolveVoiceProfile(dialect)
  if (!text) {
    sendJson(res, 400, { error: '合成文本不能为空。' })
    return
  }

  const startedAt = performance.now()
  const upstream = await fetch(TTS_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${API_KEY}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      input: {
        text: text.slice(0, 2000),
        voice: profile.voice,
        format: 'mp3',
        sample_rate: 24000,
        ...(profile.instruction ? { instruction: profile.instruction } : {}),
      },
    }),
  })
  const data = await upstream.json().catch(() => null)
  if (!upstream.ok) {
    sendJson(res, upstream.status, {
      error: '阿里云语音合成请求失败。',
      code: data?.code || 'DASHSCOPE_TTS_FAILED',
      message: data?.message || '',
    })
    return
  }

  const audioUrl = pickAudioUrl(data)
  if (!audioUrl) {
    sendJson(res, 502, { error: '阿里云响应中没有音频地址。', code: 'AUDIO_URL_MISSING' })
    return
  }

  sendJson(res, 200, {
    audio_url: audioUrl,
    provider: 'aliyun-dashscope',
    model: MODEL,
    voice: profile.voice,
    voice_name: profile.name,
    dialect,
    upstream_ms: Math.round(performance.now() - startedAt),
  })
}

async function handleRewrite(req, res) {
  if (!API_KEY) {
    sendJson(res, 503, { error: '阿里云百炼 API Key 尚未配置。', code: 'ALIYUN_NOT_CONFIGURED' })
    return
  }

  let body
  try {
    body = await readJson(req)
  } catch {
    sendJson(res, 400, { error: '请求内容不是有效 JSON。' })
    return
  }

  const text = String(body.text || '').trim()
  const dialect = String(body.dialect || '粤语')
  if (!text) {
    sendJson(res, 400, { error: '改写文本不能为空。' })
    return
  }

  const startedAt = performance.now()
  const upstream = await fetch(CHAT_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: REWRITE_MODEL,
      messages: [
        { role: 'system', content: '你是政务窗口方言口语改写助手。只输出改写后的句子，不解释，不加引号。' },
        { role: 'user', content: `${dialectPrompts[dialect] || dialectPrompts.粤语}\n\n原文：${text.slice(0, 2000)}` },
      ],
      temperature: 0.35,
    }),
  })
  const data = await upstream.json().catch(() => null)
  if (!upstream.ok) {
    sendJson(res, upstream.status, {
      error: '阿里云方言改写请求失败。',
      code: data?.code || 'DASHSCOPE_REWRITE_FAILED',
      message: data?.message || '',
    })
    return
  }

  sendJson(res, 200, {
    text: data?.choices?.[0]?.message?.content?.trim() || text,
    provider: 'aliyun-dashscope',
    model: REWRITE_MODEL,
    upstream_ms: Math.round(performance.now() - startedAt),
  })
}

async function handleTranslate(req, res) {
  if (!API_KEY) {
    sendJson(res, 503, { error: '阿里云百炼 API Key 尚未配置。', code: 'ALIYUN_NOT_CONFIGURED' })
    return
  }
  let body
  try {
    body = await readJson(req)
  } catch {
    sendJson(res, 400, { error: '请求内容不是有效 JSON。' })
    return
  }
  const text = String(body.text || '').trim()
  if (!text) {
    sendJson(res, 400, { error: '翻译文本不能为空。' })
    return
  }
  const upstream = await fetch(CHAT_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: REWRITE_MODEL,
      messages: [
        { role: 'system', content: '将用户的方言口语准确转换为简洁自然的普通话。只输出转换结果，不解释，不添加引号。若原文已经是普通话，保持原意并仅修正明显错字。' },
        { role: 'user', content: text.slice(0, 2000) },
      ],
      temperature: 0.1,
    }),
  })
  const data = await upstream.json().catch(() => null)
  if (!upstream.ok) {
    sendJson(res, upstream.status, { error: '阿里云普通话转换失败。', message: data?.message || '' })
    return
  }
  sendJson(res, 200, { text: data?.choices?.[0]?.message?.content?.trim() || text })
}

async function handleAssist(req, res) {
  if (!API_KEY) {
    sendJson(res, 503, { error: '阿里云百炼 API Key 尚未配置。', code: 'ALIYUN_NOT_CONFIGURED' })
    return
  }
  let body
  try {
    body = await readJson(req)
  } catch {
    sendJson(res, 400, { error: '请求内容不是有效 JSON。' })
    return
  }
  const messages = Array.isArray(body.messages) ? body.messages.slice(-20) : []
  if (!messages.length) {
    sendJson(res, 400, { error: '会话内容不能为空。' })
    return
  }
  const transcript = messages.map((message) => {
    const role = Number(message.speaker) === 1 ? '办事群众' : '窗口人员'
    return `${role}：${String(message.translation || message.text || '').slice(0, 800)}`
  }).join('\n').slice(0, 10000)
  const upstream = await fetch(CHAT_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: REWRITE_MODEL,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: '你是政务服务窗口的实时辅助助手。根据对话生成工作人员下一步可直接使用的回复建议，并持续维护客观摘要。严格规则：1. 只能引用对话里逐字出现过的事实；2. 如果群众的问题在对话中尚未被工作人员回答，reply 必须只做澄清追问或表示需要查询当地官方办事指南，绝对不能直接给出答案；3. 对话没有出现的材料名称、政策、金额、地址、时限、办理条件、资格要求不得出现在任何字段；4. summary 只能复述已经说过的话，不能列出“未说明”的推断项。违反规则会导致政务错误。只输出 JSON。',
        },
        {
          role: 'user',
          content: `服务窗口：${String(body.service || '政务咨询窗口')}\n识别方言：${String(body.dialect || '粤语')}\n\n当前对话：\n${transcript}\n\n输出结构：{"suggestion":{"intro":"一句引导语","items":["2至4条关键回复要点"],"closing":"一句风险提示或下一步","reply":"工作人员可直接说出的完整简洁回复"},"summary":["3至6条按事实组织的会话摘要"]}`,
        },
      ],
      temperature: 0.25,
    }),
  })
  const data = await upstream.json().catch(() => null)
  if (!upstream.ok) {
    sendJson(res, upstream.status, { error: '阿里云会话辅助生成失败。', message: data?.message || '' })
    return
  }
  const raw = data?.choices?.[0]?.message?.content?.trim() || ''
  let parsed
  try {
    parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''))
  } catch {
    sendJson(res, 502, { error: 'AI 回复结构解析失败。', code: 'ASSIST_JSON_INVALID' })
    return
  }
  const suggestion = parsed?.suggestion || {}
  const summary = Array.isArray(parsed?.summary) ? parsed.summary.map(String).filter(Boolean).slice(0, 8) : []
  sendJson(res, 200, {
    suggestion: {
      intro: String(suggestion.intro || '根据当前咨询内容，建议这样回复：'),
      items: Array.isArray(suggestion.items) ? suggestion.items.map(String).filter(Boolean).slice(0, 5) : [],
      closing: String(suggestion.closing || '具体要求请以当地最新规定为准。'),
      reply: String(suggestion.reply || suggestion.closing || ''),
    },
    summary,
    model: REWRITE_MODEL,
  })
}

function makeTaskMessage(action, taskId, payload = {}) {
  return {
    header: { action, task_id: taskId, streaming: 'duplex' },
    payload,
  }
}

function openRealtimeTts(client) {
  if (!API_KEY) {
    client.send(JSON.stringify({ type: 'error', error: '阿里云百炼 API Key 尚未配置。' }))
    client.close()
    return
  }

  const upstream = new WebSocket(REALTIME_TTS_URL, {
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'X-DashScope-DataInspection': 'enable',
    },
  })
  const taskId = randomUUID().replaceAll('-', '')
  let settings = null
  let queuedMessages = []
  let startedAt = 0
  let firstAudioSent = false
  let upstreamReady = false

  function sendUpstream(message) {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify(message))
  }

  function startTask(nextSettings) {
    settings = nextSettings
    const profile = resolveVoiceProfile(settings.dialect || '粤语')
    startedAt = performance.now()
    firstAudioSent = false
    sendUpstream(makeTaskMessage('run-task', taskId, {
      task_group: 'audio',
      task: 'tts',
      function: 'SpeechSynthesizer',
      model: MODEL,
      parameters: {
        text_type: 'PlainText',
        voice: profile.voice,
        format: 'mp3',
        sample_rate: 24000,
        ...(profile.instruction ? { instruction: profile.instruction } : {}),
      },
      input: {},
    }))
    client.send(JSON.stringify({ type: 'profile', dialect: settings.dialect, voice: profile.voice, voice_name: profile.name }))
  }

  function handleClientMessage(message) {
    if (message.type === 'start') startTask(message)
    if (message.type === 'text') sendUpstream(makeTaskMessage('continue-task', taskId, { input: { text: String(message.text || '') } }))
    if (message.type === 'finish') sendUpstream(makeTaskMessage('finish-task', taskId, { input: {} }))
  }

  upstream.on('open', () => {
    upstreamReady = true
    client.send(JSON.stringify({ type: 'connected' }))
    queuedMessages.forEach(handleClientMessage)
    queuedMessages = []
  })

  upstream.on('message', (data, isBinary) => {
    if (isBinary) {
      if (!firstAudioSent) {
        firstAudioSent = true
        client.send(JSON.stringify({ type: 'first-audio', ms: Math.round(performance.now() - startedAt) }))
      }
      client.send(data, { binary: true })
      return
    }

    let event
    try {
      event = JSON.parse(data.toString('utf8'))
    } catch {
      return
    }
    const eventName = event?.header?.event
    if (eventName === 'task-finished' || eventName === 'task-failed') {
      client.send(JSON.stringify({
        type: eventName === 'task-finished' ? 'done' : 'error',
        error: event?.header?.error_message || '',
        total_ms: Math.round(performance.now() - startedAt),
      }))
      upstream.close()
    }
  })

  upstream.on('error', (error) => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'error', error: error.message }))
  })
  upstream.on('close', () => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'closed' }))
  })
  client.on('message', (raw) => {
    let message
    try {
      message = JSON.parse(raw.toString('utf8'))
    } catch {
      client.send(JSON.stringify({ type: 'error', error: '无效的流式请求。' }))
      return
    }
    if (!upstreamReady) queuedMessages.push(message)
    else handleClientMessage(message)
  })
  client.on('close', () => {
    if (upstream.readyState === WebSocket.OPEN) upstream.close()
  })
}

function openRealtimeAsr(client) {
  if (!API_KEY) {
    client.send(JSON.stringify({ type: 'error', error: '阿里云百炼 API Key 尚未配置。' }))
    client.close()
    return
  }
  const upstream = new WebSocket(REALTIME_TTS_URL, {
    headers: { Authorization: `Bearer ${API_KEY}`, 'X-DashScope-DataInspection': 'enable' },
  })
  const taskId = randomUUID().replaceAll('-', '')
  const queuedAudio = []
  let upstreamOpen = false
  let taskStarted = false
  let finishRequested = false

  function finishTask() {
    if (!taskStarted) {
      finishRequested = true
      return
    }
    upstream.send(JSON.stringify(makeTaskMessage('finish-task', taskId, { input: {} })))
  }

  upstream.on('open', () => {
    upstreamOpen = true
    upstream.send(JSON.stringify(makeTaskMessage('run-task', taskId, {
      task_group: 'audio',
      task: 'asr',
      function: 'recognition',
      model: ASR_MODEL,
      parameters: {
        format: 'pcm',
        sample_rate: 16000,
        max_sentence_silence: ASR_SENTENCE_SILENCE_MS,
        semantic_punctuation_enabled: true,
        heartbeat: true,
      },
      input: {},
    })))
  })

  upstream.on('message', (data, isBinary) => {
    if (isBinary) return
    let event
    try { event = JSON.parse(data.toString('utf8')) } catch { return }
    const eventName = event?.header?.event
    if (eventName === 'task-started') {
      taskStarted = true
      queuedAudio.splice(0).forEach((chunk) => upstream.send(chunk))
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'ready', model: ASR_MODEL }))
      if (finishRequested) finishTask()
      return
    }
    if (eventName === 'result-generated') {
      const sentence = event?.payload?.output?.sentence || {}
      if (client.readyState === WebSocket.OPEN && sentence.text) {
        client.send(JSON.stringify({
          type: 'result',
          text: sentence.text,
          final: Boolean(sentence.sentence_end),
          begin_time: sentence.begin_time || 0,
          end_time: sentence.end_time || 0,
        }))
      }
      return
    }
    if (eventName === 'task-failed') {
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'error', error: event?.header?.error_message || '阿里云实时识别失败。' }))
      upstream.close()
      return
    }
    if (eventName === 'task-finished') {
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'done' }))
      upstream.close()
    }
  })
  upstream.on('error', (error) => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'error', error: error.message }))
  })
  client.on('message', (data, isBinary) => {
    if (isBinary) {
      const chunk = Buffer.from(data)
      if (upstreamOpen && taskStarted) upstream.send(chunk)
      else queuedAudio.push(chunk)
      return
    }
    let message
    try { message = JSON.parse(data.toString('utf8')) } catch { return }
    if (message.type === 'finish') finishTask()
  })
  client.on('close', () => {
    if (upstream.readyState === WebSocket.OPEN) upstream.close()
  })
}

async function main() {
  const production = process.env.NODE_ENV === 'production'
  const vite = production ? null : await (await import('vite')).createServer({
    root: rootDir,
    server: { middlewareMode: true },
    appType: 'spa',
  })

  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`)

    if (req.method === 'GET' && url.pathname === '/api/aliyun/config') {
      sendJson(res, 200, {
        configured: Boolean(API_KEY),
        provider: '阿里云百炼',
        model: MODEL,
        asr_sentence_silence_ms: ASR_SENTENCE_SILENCE_MS,
        voice: DEFAULT_VOICE,
        workspace_id: WORKSPACE_ID,
        region: REGION,
        voice_profiles: voiceProfiles,
        capabilities: ['cosyvoice-streaming-tts', 'fun-asr-realtime', 'voiceprint-identification', 'two-speaker-acoustic-clustering', 'qwen-dialect-rewrite', 'qwen-live-assist'],
        voiceprint_ready: voiceprintReady,
        voiceprint_provider: VOICEPRINT_PROVIDER,
      })
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/aliyun/synthesize') {
      handleSynthesize(req, res).catch((error) => {
        sendJson(res, 502, { error: '无法连接阿里云语音服务。', code: 'ALIYUN_NETWORK_ERROR', message: error.message })
      })
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/aliyun/rewrite') {
      handleRewrite(req, res).catch((error) => {
        sendJson(res, 502, { error: '无法连接阿里云改写服务。', code: 'ALIYUN_NETWORK_ERROR', message: error.message })
      })
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/aliyun/translate') {
      handleTranslate(req, res).catch((error) => {
        sendJson(res, 502, { error: '无法连接阿里云翻译服务。', code: 'ALIYUN_NETWORK_ERROR', message: error.message })
      })
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/aliyun/assist') {
      handleAssist(req, res).catch((error) => {
        sendJson(res, 502, { error: '无法连接阿里云会话辅助服务。', code: 'ALIYUN_NETWORK_ERROR', message: error.message })
      })
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/voiceprints') {
      callVoiceprint('list').then((result) => sendJson(res, 200, { ready: voiceprintReady, provider: VOICEPRINT_PROVIDER, threshold: VOICEPRINT_THRESHOLD, ...result })).catch((error) => sendJson(res, 503, { ready: false, provider: VOICEPRINT_PROVIDER, error: error.message }))
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/voiceprints/enroll') {
      try {
        const audio = await readBuffer(req)
        const result = await callVoiceprint('enroll', {
          staff_id: String(req.headers['x-staff-id'] || ''),
          name: decodeURIComponent(String(req.headers['x-staff-name'] || '')),
          audio: audio.toString('base64'),
        })
        sendJson(res, 200, result)
      } catch (error) {
        sendJson(res, error.message === 'AUDIO_TOO_LARGE' ? 413 : 400, { error: error.message })
      }
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/voiceprints/identify') {
      try {
        const audio = await readBuffer(req)
        const result = await callVoiceprint('identify', { audio: audio.toString('base64') })
        sendJson(res, 200, result)
      } catch (error) {
        sendJson(res, error.message === 'AUDIO_TOO_LARGE' ? 413 : 400, { error: error.message })
      }
      return
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/voiceprints/')) {
      try {
        const result = await callVoiceprint('delete', { staff_id: decodeURIComponent(url.pathname.slice('/api/voiceprints/'.length)) })
        sendJson(res, 200, result)
      } catch (error) {
        sendJson(res, 400, { error: error.message })
      }
      return
    }

    if (vite) {
      vite.middlewares(req, res)
      return
    }

    const distDir = path.join(rootDir, 'dist')
    const requested = url.pathname === '/' ? 'index.html' : path.normalize(url.pathname.replace(/^\/+/, ''))
    const filePath = path.join(distDir, requested)
    if (!filePath.startsWith(distDir)) {
      sendJson(res, 403, { error: 'Forbidden' })
      return
    }
    try {
      const content = await readFile(filePath)
      const extension = path.extname(filePath)
      const contentType = extension === '.html' ? 'text/html; charset=utf-8' : extension === '.css' ? 'text/css; charset=utf-8' : extension === '.js' ? 'application/javascript; charset=utf-8' : 'application/octet-stream'
      res.writeHead(200, { 'content-type': contentType })
      res.end(content)
    } catch {
      try {
        const content = await readFile(path.join(rootDir, 'dist', 'index.html'))
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(content)
      } catch {
        sendJson(res, 404, { error: '页面不存在，请先执行 npm run build。' })
      }
    }
  })

  const ttsWss = new WebSocketServer({ noServer: true })
  const asrWss = new WebSocketServer({ noServer: true })
  ttsWss.on('connection', openRealtimeTts)
  asrWss.on('connection', openRealtimeAsr)
  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`).pathname
    const target = pathname === '/ws/tts' ? ttsWss : pathname === '/ws/asr' ? asrWss : null
    if (!target) {
      socket.destroy()
      return
    }
    target.handleUpgrade(request, socket, head, (ws) => target.emit('connection', ws, request))
  })

  server.listen(PORT, HOST, () => {
    console.log(`Tsy demo: http://${HOST}:${PORT}`)
    console.log(`Aliyun DashScope: ${API_KEY ? 'configured' : 'missing DASHSCOPE_API_KEY'}`)
    console.log(`CosyVoice model=${MODEL} defaultVoice=${DEFAULT_VOICE}`)
    console.log(`ASR model=${ASR_MODEL}`)
    console.log(`ASR sentence silence=${ASR_SENTENCE_SILENCE_MS}ms`)
    console.log(`Voiceprint provider=${VOICEPRINT_PROVIDER} ${voiceprintReady ? 'configured' : 'missing credentials'}`)
  })
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
