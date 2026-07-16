import { createServer as createHttpServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
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
const TTS_URL = 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer'
const CHAT_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
const REALTIME_TTS_URL = `wss://${WORKSPACE_ID}.${REGION}.maas.aliyuncs.com/api-ws/v1/inference`

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
        semantic_punctuation_enabled: false,
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
        voice: DEFAULT_VOICE,
        workspace_id: WORKSPACE_ID,
        region: REGION,
        voice_profiles: voiceProfiles,
        capabilities: ['cosyvoice-streaming-tts', 'fun-asr-realtime', 'two-speaker-acoustic-clustering', 'qwen-dialect-rewrite', 'qwen-live-assist'],
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
  })
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
