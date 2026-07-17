<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  ArrowLeftRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Cloud,
  Clock3,
  ExternalLink,
  Fingerprint,
  Globe2,
  House,
  Info,
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  UserRound,
  Volume2,
  X,
} from 'lucide-vue-next'
import { generateConversationAssist, getAliyunConfig, streamSpeech, streamTranslateToMandarin, synthesizeSpeech, translateToMandarin, type AliyunConfig } from './services/aliyun'
import { startRealtimeRecognition, type RecognitionResult } from './services/realtime-asr'
import { captureVoiceprintSample, deleteVoiceprint, enrollVoiceprint, listVoiceprints, type VoiceprintStaff } from './services/voiceprint'

type View = 'welcome' | 'session'
type SessionStatus = 'live' | 'archived'
type Speaker = 1 | 2

interface TranscriptMessage {
  id: number
  speaker: Speaker
  language: string
  text: string
  translation: string
  time: number
  speakerConfidence?: number
  acousticSpeaker?: Speaker
  staffName?: string
  voiceprintMatched?: boolean
  identityResolved?: boolean
  identitySource?: 'voiceprint' | 'session' | 'unmatched' | 'manual'
  translationStreaming?: boolean
}

interface Conversation {
  id: number
  title: string
  meta: string
  service: string
  dialect: string
  duration: number
  status: SessionStatus
  messages: TranscriptMessage[]
}

interface MatterUnderstanding {
  candidates: string[]
  key_facts: string[]
  missing_information: string[]
  suggested_question: string
}

interface PolicyReference {
  status: 'verified' | 'none'
  title: string
  issuer: string
  version_or_date: string
  url: string
  citation_location: string
}

const STORAGE_KEY = 'tsy-demo-state-v2'
const NOISE_REDUCTION_KEY = 'tsy-demo-noise-reduction'
const view = ref<View>('welcome')
const translating = ref(true)
const noiseReduction = ref(true)
const dialect = ref('粤语')
const service = ref('政务咨询窗口')
const activeConversationId = ref(1)
const isListening = ref(false)
const elapsed = ref(0)
const appliedSuggestion = ref(false)
const aiMatter = ref<MatterUnderstanding | null>(null)
const aiPolicyReference = ref<PolicyReference | null>(null)
const assistLoading = ref(false)
const settingsOpen = ref(false)
const profileOpen = ref(false)
const isMaximized = ref(false)
const playingMessageId = ref<number | null>(null)
const aliyunConfig = ref<AliyunConfig | null>(null)
const aliyunLoading = ref(false)
const toast = ref('')
const interimText = ref('')
const interimSpeaker = ref<Speaker>(1)
const interimSpeakerConfidence = ref(0.5)
const micLevel = ref(0)
const voiceprintStaff = ref<VoiceprintStaff[]>([])
const voiceprintReady = ref(false)
const voiceprintProvider = ref<'local' | 'xfyun'>('local')
const voiceprintLoading = ref(false)
const voiceprintRecording = ref(false)
const voiceprintRemaining = ref(0)
const voiceprintConsent = ref(false)
const voiceprintStaffId = ref('ZY-0186')
const voiceprintStaffName = ref('窗口工作人员')
const transcriptList = ref<HTMLElement | null>(null)
const serviceMenuRef = ref<HTMLElement | null>(null)
const dialectOptions = ['粤语', '四川话', '闽南语', '东北话', '河南话', '陕西话', '山东话', '湖南话', '安徽话']
const serviceOptions = ['政务咨询窗口', '警务服务窗口', '社保服务窗口']
const serviceMenuOpen = ref(false)
let clockTimer: number | undefined
let toastTimer: number | undefined
let assistTimer: number | undefined
let assistRequestSequence = 0
let messageSequence = 20
let audioPlayer: HTMLAudioElement | null = null
let stopStreamingAudio: (() => void) | null = null
let stopRecognition: (() => Promise<void>) | null = null
const recognitionMessages = new Map<string, TranscriptMessage>()

const seedConversations: Conversation[] = [
  {
    id: 1,
    title: '居住证办理咨询',
    meta: '10:30 · 政务咨询窗口',
    service: '政务咨询窗口',
    dialect: '粤语',
    duration: 772,
    status: 'archived',
    messages: [
      { id: 1, speaker: 1, language: '粤语', text: '我想问下，申请居住证需要准备哪些材料啊？', translation: '我想问一下，申请居住证需要准备哪些材料？', time: 768 },
      { id: 2, speaker: 2, language: '普通话', text: '一般需要身份证、居住证明、照片这些，具体要看当地要求。', translation: '一般需要身份证、居住证明、照片这些，具体要看当地要求。', time: 772 },
    ],
  },
  {
    id: 2,
    title: '租房备案政策解读',
    meta: '昨天 15:32 · 警务服务窗口',
    service: '警务服务窗口',
    dialect: '粤语',
    duration: 416,
    status: 'archived',
    messages: [
      { id: 3, speaker: 1, language: '粤语', text: '租房备案是不是一定要房东本人到场？', translation: '办理租房备案是否必须房东本人到场？', time: 94 },
      { id: 4, speaker: 2, language: '普通话', text: '通常可以由房东授权办理，但需要提供授权书和双方身份证明。', translation: '通常可以授权办理，需要授权书和双方身份证明。', time: 101 },
    ],
  },
  {
    id: 3,
    title: '社保办理流程咨询',
    meta: '06/22 09:18 · 社保服务窗口',
    service: '社保服务窗口',
    dialect: '四川话',
    duration: 289,
    status: 'archived',
    messages: [
      { id: 5, speaker: 1, language: '四川话', text: '个人社保转到新单位，要先办啥子手续？', translation: '个人社保转入新单位，需要先办理什么手续？', time: 42 },
      { id: 6, speaker: 2, language: '普通话', text: '新单位办理增员后会自动接续，您可以先确认原单位已经完成减员。', translation: '新单位办理增员后会自动接续，可以先确认原单位已完成减员。', time: 49 },
    ],
  },
]

const conversations = ref<Conversation[]>(structuredClone(seedConversations))

const bars = Array.from({ length: 76 }, (_, index) => {
  const wave = Math.sin(index * 0.48) * 0.5 + 0.5
  const envelope = index < 16 ? index / 16 : index > 58 ? (76 - index) / 18 : 1
  return Math.max(7, Math.round((12 + wave * 34) * Math.max(0.25, envelope)))
})

const fallbackMatter: MatterUnderstanding = {
  candidates: ['待识别事项'],
  key_facts: ['正在根据当前会话提取已明确的信息'],
  missing_information: ['具体办理地区', '申请人的实际情况'],
  suggested_question: '请问您准备在哪个地区办理，当前最希望确认的是材料、条件还是办理流程？',
}
const emptyPolicyReference: PolicyReference = {
  status: 'none',
  title: '无可核验参考',
  issuer: '',
  version_or_date: '',
  url: '',
  citation_location: '',
}

const activeConversation = computed(() => conversations.value.find((item) => item.id === activeConversationId.value) ?? conversations.value[0])
const currentMatter = computed(() => aiMatter.value || fallbackMatter)
const currentPolicyReference = computed(() => aiPolicyReference.value || emptyPolicyReference)
const currentVoiceProfile = computed(() => aliyunConfig.value?.voice_profiles?.[dialect.value] ?? null)
const sessionTitle = computed(() => activeConversation.value?.title ?? '新的咨询会话')
const messages = computed(() => activeConversation.value?.messages ?? [])
const formattedElapsed = computed(() => formatTime(elapsed.value))
const isLive = computed(() => activeConversation.value?.status === 'live')
async function updateConversationAssist(showFeedback = false) {
  if (!messages.value.length || !aliyunConfig.value?.configured) return
  const requestSequence = ++assistRequestSequence
  assistLoading.value = true
  appliedSuggestion.value = false
  try {
    const result = await generateConversationAssist(messages.value, service.value, dialect.value)
    if (requestSequence !== assistRequestSequence) return
    aiMatter.value = result.matter
    aiPolicyReference.value = result.policy_reference
    if (showFeedback) showToast('事项理解和政策引用已更新')
  } catch {
    if (showFeedback) showToast('AI 辅助暂不可用，已保留当前内容')
  } finally {
    if (requestSequence === assistRequestSequence) assistLoading.value = false
  }
}

function scheduleConversationAssist(delay = 900) {
  window.clearTimeout(assistTimer)
  assistTimer = window.setTimeout(() => { void updateConversationAssist() }, delay)
}

function formatTime(seconds: number) {
  const hours = Math.floor(seconds / 3600).toString().padStart(2, '0')
  const minutes = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0')
  const remainingSeconds = Math.floor(seconds % 60).toString().padStart(2, '0')
  return `${hours}:${minutes}:${remainingSeconds}`
}

function showToast(message: string) {
  toast.value = message
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => { toast.value = '' }, 2200)
}

function toggleServiceMenu(enabled = true) {
  if (!enabled) return
  serviceMenuOpen.value = !serviceMenuOpen.value
}

function chooseService(option: string) {
  service.value = option
  serviceMenuOpen.value = false
}

function closeServiceMenuOnOutsideClick(event: PointerEvent) {
  if (!serviceMenuRef.value?.contains(event.target as Node)) serviceMenuOpen.value = false
}

function startClock() {
  window.clearInterval(clockTimer)
  clockTimer = window.setInterval(() => {
    if (!isListening.value || !activeConversation.value) return
    elapsed.value += 1
    activeConversation.value.duration = elapsed.value
  }, 1000)
}

function addMessage(message: Omit<TranscriptMessage, 'id' | 'time'>) {
  if (!activeConversation.value) return null
  const nextMessage = { ...message, id: ++messageSequence, time: elapsed.value }
  activeConversation.value.messages.push(nextMessage)
  scrollTranscriptToBottom()
  return nextMessage
}

function scrollTranscriptToBottom() {
  void nextTick(() => {
    if (transcriptList.value) transcriptList.value.scrollTop = transcriptList.value.scrollHeight
  })
}

function recognitionKey(result: Pick<RecognitionResult, 'beginTime' | 'endTime' | 'text'>) {
  return `${result.beginTime}:${result.endTime}:${result.text}`
}

function isIdentityUnconfirmed(message: TranscriptMessage) {
  return message.identityResolved === false
    || (message.identityResolved === undefined && !message.identitySource && !message.voiceprintMatched)
}

function speakerLabel(message: TranscriptMessage) {
  if (isIdentityUnconfirmed(message)) return `发言人 ${message.acousticSpeaker || message.speaker}`
  return message.speaker === 2 ? message.staffName || '窗口人员' : '办事群众'
}

function identityLabel(message: TranscriptMessage) {
  const confidence = message.speakerConfidence ? ` ${Math.round(message.speakerConfidence * 100)}%` : ''
  if (message.identityResolved === false) return '身份确认中'
  if (message.identityResolved === undefined && !message.identitySource && !message.voiceprintMatched) return '历史身份未确认'
  if (message.identitySource === 'voiceprint') return `声纹匹配${confidence}`
  if (message.identitySource === 'session') return `会话关联${confidence}`
  if (message.identitySource === 'unmatched') return `群众 · 分离${confidence}`
  if (message.identitySource === 'manual') return '人工调整'
  return `${message.voiceprintMatched ? '声纹匹配' : '分离'}${confidence}`
}

async function translateMessage(message: TranscriptMessage) {
  if (!translating.value) {
    message.translation = message.text
    message.translationStreaming = false
    scheduleConversationAssist()
    return
  }
  message.translationStreaming = true
  try {
    const translated = await streamTranslateToMandarin(message.text, (partial) => {
      message.translation = partial
      scrollTranscriptToBottom()
    })
    message.translation = translated || message.text
  } catch {
    try {
      const translated = await translateToMandarin(message.text)
      message.translation = translated.text || message.text
    } catch {
      message.translation = message.text
    }
  } finally {
    message.translationStreaming = false
    scheduleConversationAssist()
  }
}

async function beginRecognition() {
  if (stopRecognition) return
  interimText.value = ''
  interimSpeaker.value = 1
  interimSpeakerConfidence.value = 0.5
  recognitionMessages.clear()
  try {
    stopRecognition = await startRealtimeRecognition({
      onReady: () => {
        isListening.value = true
        showToast(noiseReduction.value ? '麦克风已连接 · 智能降噪已开启' : '麦克风已连接，正在实时识别')
      },
      onLevel: (level) => { micLevel.value = level },
      onResult: (result) => {
        if (!result.final) {
          interimText.value = result.text
          interimSpeaker.value = result.speaker
          interimSpeakerConfidence.value = result.speakerConfidence
          scrollTranscriptToBottom()
          return
        }
        interimText.value = ''
        if (!result.text.trim()) return
        const message = addMessage({
          speaker: result.speaker,
          language: result.speaker === 1 ? dialect.value : '普通话',
          text: result.text.trim(),
          translation: '',
          speakerConfidence: result.speakerConfidence,
          acousticSpeaker: result.acousticSpeaker,
          staffName: result.staffName,
          voiceprintMatched: result.voiceprintMatched,
          identityResolved: result.identityResolved,
          identitySource: result.identitySource,
          translationStreaming: translating.value,
        })
        if (!message) return
        recognitionMessages.set(recognitionKey(result), message)
        if (activeConversation.value.messages.length === 1) {
          activeConversation.value.title = `${result.text.trim().slice(0, 10)}${result.text.trim().length > 10 ? '…' : ''}`
          activeConversation.value.meta = `刚刚 · ${service.value}`
        }
        void translateMessage(message)
      },
      onSpeakerResolved: (result) => {
        const message = recognitionMessages.get(recognitionKey(result))
        if (!message) return
        message.speaker = result.speaker
        message.language = result.speaker === 1 ? dialect.value : '普通话'
        message.speakerConfidence = result.speakerConfidence
        message.acousticSpeaker = result.acousticSpeaker
        message.staffName = result.staffName
        message.voiceprintMatched = result.voiceprintMatched
        message.identityResolved = result.identityResolved
        message.identitySource = result.identitySource
        scheduleConversationAssist(200)
      },
      onError: (error) => {
        isListening.value = false
        interimText.value = ''
        showToast(error.message)
      },
      onClose: () => {
        isListening.value = false
        interimText.value = ''
        stopRecognition = null
      },
    }, { noiseReduction: noiseReduction.value })
  } catch (error) {
    isListening.value = false
    stopRecognition = null
    showToast(error instanceof DOMException && error.name === 'NotAllowedError' ? '需要允许麦克风权限才能开始识别' : error instanceof Error ? error.message : '麦克风启动失败')
  }
}

async function stopLiveRecognition() {
  const stop = stopRecognition
  stopRecognition = null
  if (stop) await stop()
  isListening.value = false
  micLevel.value = 0
  interimText.value = ''
  recognitionMessages.clear()
}

async function createNewSession() {
  await stopLiveRecognition()
  const id = Date.now()
  const conversation: Conversation = {
    id,
    title: '新的咨询会话',
    meta: `刚刚 · ${service.value}`,
    service: service.value,
    dialect: dialect.value,
    duration: 0,
    status: 'live',
    messages: [],
  }
  conversations.value.unshift(conversation)
  activeConversationId.value = id
  elapsed.value = 0
  appliedSuggestion.value = false
  aiMatter.value = null
  aiPolicyReference.value = null
  isListening.value = false
  view.value = 'session'
  startClock()
  await beginRecognition()
}

async function openSession(id: number) {
  await stopLiveRecognition()
  activeConversationId.value = id
  const conversation = conversations.value.find((item) => item.id === id)
  if (!conversation) return
  dialect.value = conversation.dialect
  service.value = conversation.service
  elapsed.value = conversation.duration
  isListening.value = false
  appliedSuggestion.value = false
  aiMatter.value = null
  aiPolicyReference.value = null
  view.value = 'session'
  startClock()
  if (conversation.messages.length) scheduleConversationAssist(100)
  if (conversation.status === 'live') await beginRecognition()
}

async function toggleListening() {
  if (!isLive.value) return
  if (isListening.value) {
    await stopLiveRecognition()
    showToast('实时收音已暂停')
  } else {
    await beginRecognition()
  }
}

async function endSession() {
  await stopLiveRecognition()
  if (activeConversation.value) {
    activeConversation.value.status = 'archived'
    activeConversation.value.duration = elapsed.value
    activeConversation.value.meta = `刚刚 · ${activeConversation.value.service}`
  }
  window.clearInterval(clockTimer)
  view.value = 'welcome'
  showToast('本次会话已保存')
}

function swapSpeaker(message: TranscriptMessage) {
  message.speaker = message.speaker === 1 ? 2 : 1
  message.language = message.speaker === 1 ? dialect.value : '普通话'
  message.voiceprintMatched = false
  message.identityResolved = true
  message.identitySource = 'manual'
  message.staffName = undefined
  showToast(`已调整为发言人 ${message.speaker}`)
}

async function loadVoiceprints() {
  try {
    const result = await listVoiceprints()
    voiceprintReady.value = result.ready
    voiceprintProvider.value = result.provider || 'local'
    voiceprintStaff.value = result.staff
  } catch {
    voiceprintReady.value = false
    voiceprintStaff.value = []
  }
}

async function recordVoiceprint() {
  if (!voiceprintConsent.value || !voiceprintStaffId.value.trim() || !voiceprintStaffName.value.trim() || voiceprintRecording.value) return
  try {
    voiceprintRecording.value = true
    voiceprintRemaining.value = 8
    showToast('请用正常音量连续朗读窗口服务用语')
    const pcm = await captureVoiceprintSample(8, (remaining) => { voiceprintRemaining.value = remaining })
    voiceprintLoading.value = true
    showToast('录音完成，正在保存声纹样本')
    const result = await enrollVoiceprint(voiceprintStaffId.value.trim(), voiceprintStaffName.value.trim(), pcm)
    const existingIndex = voiceprintStaff.value.findIndex((item) => item.staff_id === result.staff_id)
    if (existingIndex >= 0) voiceprintStaff.value[existingIndex] = result
    else voiceprintStaff.value.push(result)
    window.setTimeout(() => { void loadVoiceprints() }, 1200)
    showToast(`声纹录入成功 · 已有 ${result.samples} 个样本`)
  } catch (error) {
    showToast(error instanceof DOMException && error.name === 'NotAllowedError' ? '需要允许麦克风权限才能录入声纹' : error instanceof Error ? error.message : '声纹录入失败')
  } finally {
    voiceprintRecording.value = false
    voiceprintLoading.value = false
    voiceprintRemaining.value = 0
  }
}

async function removeVoiceprint(staffId: string) {
  try {
    voiceprintLoading.value = true
    await deleteVoiceprint(staffId)
    await loadVoiceprints()
    showToast('工作人员声纹已删除')
  } catch (error) {
    showToast(error instanceof Error ? error.message : '删除声纹失败')
  } finally {
    voiceprintLoading.value = false
  }
}

function refreshSuggestion() {
  void updateConversationAssist(true)
}

async function useSuggestion() {
  if (appliedSuggestion.value) return
  const question = currentMatter.value.suggested_question
  if (!question) return
  const message = addMessage({ speaker: 2, language: '普通话', text: question, translation: question })
  appliedSuggestion.value = true
  showToast('建议追问已加入实时对话')
  scheduleConversationAssist(1200)
  if (message) void speakMessage(message)
}

function speakLocally(message: TranscriptMessage) {
  if (!('speechSynthesis' in window)) {
    showToast('当前浏览器不支持语音播放')
    return
  }
  window.speechSynthesis.cancel()
  if (playingMessageId.value === message.id) {
    playingMessageId.value = null
    return
  }
  const utterance = new SpeechSynthesisUtterance(message.translation || message.text)
  utterance.lang = 'zh-CN'
  utterance.rate = 0.95
  utterance.onend = () => { playingMessageId.value = null }
  playingMessageId.value = message.id
  window.speechSynthesis.speak(utterance)
}

async function speakMessage(message: TranscriptMessage) {
  window.speechSynthesis?.cancel()
  const stoppingCurrent = playingMessageId.value === message.id
  stopStreamingAudio?.()
  stopStreamingAudio = null
  if (audioPlayer) {
    audioPlayer.pause()
    audioPlayer = null
  }
  if (stoppingCurrent) {
    playingMessageId.value = null
    return
  }

  const text = message.speaker === 2 ? message.translation : message.text
  if (!aliyunConfig.value?.configured) {
    speakLocally(message)
    return
  }

  try {
    playingMessageId.value = message.id
    aliyunLoading.value = true
    showToast('正在连接阿里云流式语音')
    let fallbackStarted = false
    const fallbackToHttp = async () => {
      if (fallbackStarted) return
      fallbackStarted = true
      try {
        const result = await synthesizeSpeech(text, dialect.value)
        audioPlayer = new Audio(result.audio_url)
        audioPlayer.onended = () => { playingMessageId.value = null; audioPlayer = null }
        await audioPlayer.play()
        showToast(`已切换完整音频 · ${result.upstream_ms} ms`)
      } catch {
        playingMessageId.value = null
        showToast('阿里云语音暂不可用，已切换本地播放')
        speakLocally(message)
      }
    }
    stopStreamingAudio = streamSpeech(text, dialect.value, {
      onFirstAudio: (milliseconds) => {
        aliyunLoading.value = false
        showToast(`首音已播放 · ${milliseconds} ms`)
      },
      onDone: () => { aliyunLoading.value = false },
      onEnded: () => {
        playingMessageId.value = null
        stopStreamingAudio = null
      },
      onError: () => {
        stopStreamingAudio?.()
        stopStreamingAudio = null
        aliyunLoading.value = false
        void fallbackToHttp()
      },
    })
  } catch {
    playingMessageId.value = null
    aliyunLoading.value = false
    showToast('阿里云语音暂不可用，已切换本地播放')
    speakLocally(message)
  }
}

async function loadAliyunConfig() {
  try {
    aliyunConfig.value = await getAliyunConfig()
  } catch {
    aliyunConfig.value = null
  }
}

function resetDemo() {
  conversations.value = structuredClone(seedConversations)
  localStorage.removeItem(STORAGE_KEY)
  localStorage.removeItem(NOISE_REDUCTION_KEY)
  noiseReduction.value = true
  settingsOpen.value = false
  view.value = 'welcome'
  void stopLiveRecognition()
  activeConversationId.value = 1
  aiMatter.value = null
  aiPolicyReference.value = null
  showToast('演示数据已重置')
}

function handleWindowAction(action: 'minimize' | 'maximize' | 'close') {
  if (action === 'maximize') {
    isMaximized.value = !isMaximized.value
    return
  }
  if (action === 'close') {
    if (view.value === 'session' && isLive.value) endSession()
    else view.value = 'welcome'
    return
  }
  showToast('桌面版接入后可最小化到任务栏')
}

watch([dialect, service], () => {
  if (!activeConversation.value || view.value !== 'session' || !isLive.value) return
  activeConversation.value.dialect = dialect.value
  activeConversation.value.service = service.value
})

watch(conversations, (value) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(value.slice(0, 8)))
}, { deep: true })

watch(noiseReduction, (value) => {
  localStorage.setItem(NOISE_REDUCTION_KEY, String(value))
})

onMounted(() => {
  document.addEventListener('pointerdown', closeServiceMenuOnOutsideClick)
  void loadAliyunConfig()
  void loadVoiceprints()
  noiseReduction.value = localStorage.getItem(NOISE_REDUCTION_KEY) !== 'false'
  const saved = localStorage.getItem(STORAGE_KEY)
  if (saved) {
    try {
      const parsed = JSON.parse(saved) as Conversation[]
      if (Array.isArray(parsed) && parsed.length) conversations.value = parsed.map((item) => ({ ...item, status: 'archived' }))
    } catch {
      localStorage.removeItem(STORAGE_KEY)
    }
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', closeServiceMenuOnOutsideClick)
  window.clearInterval(clockTimer)
  window.clearTimeout(toastTimer)
  window.clearTimeout(assistTimer)
  void stopLiveRecognition()
  stopStreamingAudio?.()
  audioPlayer?.pause()
  window.speechSynthesis?.cancel()
})
</script>

<template>
  <main class="page-shell">
    <section class="desktop-window" :class="{ 'session-window': view === 'session', maximized: isMaximized }">
      <aside class="sidebar">
        <div class="brand-row">
          <div class="brand-mark"><span></span><span></span><span></span><span></span><span></span></div>
          <div><h1>Tsy ·</h1><p>方言同声传译 AI 助手</p></div>
        </div>
        <div v-if="view === 'welcome'" class="network-state"><span></span>实时网络连接中</div>
        <button class="new-chat" @click="createNewSession"><Plus :size="20" /> 新建会话</button>

        <div class="recent-heading">最近会话</div>
        <nav class="conversation-list">
          <button
            v-for="conversation in conversations.slice(0, 5)"
            :key="conversation.id"
            class="conversation"
            :class="{ active: view === 'session' && activeConversationId === conversation.id }"
            @click="openSession(conversation.id)"
          >
            <span class="conversation-dot" :class="{ live: conversation.status === 'live' }"></span>
            <span><strong>{{ conversation.title }}</strong><small>{{ conversation.meta }}</small></span>
          </button>
        </nav>

        <div class="sidebar-spacer"></div>
        <button v-if="view === 'welcome'" class="settings-link" @click="settingsOpen = true"><Settings :size="21" /> 设置中心</button>
        <button class="profile" :aria-expanded="profileOpen" aria-label="窗口工作人员账户" @click="profileOpen = !profileOpen">
          <span class="profile-avatar"><UserRound :size="24" /><i></i></span>
          <span class="profile-info"><strong>窗口工作人员</strong><small>政务服务中心</small></span>
          <Settings v-if="view === 'session'" :size="20" class="profile-action" />
          <ChevronDown v-else :size="18" class="profile-action profile-chevron" />
        </button>
        <div v-if="profileOpen" class="profile-popover"><strong>窗口工作人员</strong><span>工号：ZY-0186</span><button @click="settingsOpen = true; profileOpen = false"><Settings :size="16" /> 偏好设置</button></div>
      </aside>

      <section v-if="view === 'welcome'" class="welcome-view">
        <div class="window-toolbar">
          <div ref="serviceMenuRef" class="service-picker" @keydown.esc="serviceMenuOpen = false">
            <button class="service-select" :class="{ open: serviceMenuOpen }" type="button" aria-haspopup="listbox" :aria-expanded="serviceMenuOpen" @click="toggleServiceMenu()">
              <ShieldCheck :size="18" /><span>{{ service }}</span><ChevronDown :size="17" class="service-chevron" />
            </button>
            <ul v-if="serviceMenuOpen" class="service-menu" role="listbox" aria-label="选择服务窗口">
              <li v-for="option in serviceOptions" :key="option">
                <button type="button" role="option" :aria-selected="service === option" :class="{ selected: service === option }" @click="chooseService(option)">
                  <span>{{ option }}</span><CheckCircle2 v-if="service === option" :size="17" />
                </button>
              </li>
            </ul>
          </div>
          <button aria-label="最小化" title="最小化" @click="handleWindowAction('minimize')"><Minimize2 :size="20" /></button>
          <button aria-label="最大化" title="最大化" @click="handleWindowAction('maximize')"><Maximize2 :size="18" /></button>
          <button aria-label="关闭" title="关闭" @click="handleWindowAction('close')"><X :size="22" /></button>
        </div>
        <div class="welcome-content">
          <header><h2>Tsy · 方言同声传译 AI 助手</h2><p>让沟通更简单，让服务更高效</p></header>
          <div class="voice-stage">
            <div class="wave wave-left"><i v-for="(height, index) in bars" :key="index" :style="{ height: `${height}px` }"></i></div>
            <button class="mic-button" aria-label="开始同传" title="开始同传" @click="createNewSession"><Mic :size="56" /></button>
            <div class="wave wave-right"><i v-for="(height, index) in bars" :key="index" :style="{ height: `${height}px` }"></i></div>
          </div>
          <label class="dialect-select"><span>方言翻译：</span><select v-model="dialect"><option v-for="item in dialectOptions" :key="item">{{ item }}</option></select><ChevronDown :size="17" /></label>
          <p class="helper-text">请使用方言开始说话，系统将自动识别并翻译</p>
          <div class="privacy-note"><ShieldCheck :size="17" /> 所有对话内容仅用于本次服务，严格保密 <Info :size="16" /></div>
        </div>
      </section>

      <section v-else class="session-view">
        <header class="session-header">
          <div ref="serviceMenuRef" class="service-picker" @keydown.esc="serviceMenuOpen = false">
            <button class="service-select" :class="{ open: serviceMenuOpen }" type="button" :disabled="!isLive" aria-haspopup="listbox" :aria-expanded="serviceMenuOpen" @click="toggleServiceMenu(isLive)">
              <House :size="18" /><span>{{ service }}</span><ChevronDown :size="17" class="service-chevron" />
            </button>
            <ul v-if="serviceMenuOpen && isLive" class="service-menu" role="listbox" aria-label="选择服务窗口">
              <li v-for="option in serviceOptions" :key="option">
                <button type="button" role="option" :aria-selected="service === option" :class="{ selected: service === option }" @click="chooseService(option)">
                  <span>{{ option }}</span><CheckCircle2 v-if="service === option" :size="17" />
                </button>
              </li>
            </ul>
          </div>
          <button class="live-pill" :class="{ paused: !isListening, archived: !isLive }" :disabled="!isLive" @click="toggleListening"><i></i>{{ !isLive ? '会话已归档' : isListening ? '实时同传中' : '已暂停收音' }}</button>
          <h2>{{ sessionTitle }}</h2>
          <span class="timer"><i :class="{ paused: !isListening }"></i>{{ formattedElapsed }}<Clock3 :size="17" /></span>
          <div class="window-actions"><button title="最小化" @click="handleWindowAction('minimize')"><Minimize2 :size="20" /></button><button title="最大化" @click="handleWindowAction('maximize')"><Maximize2 :size="18" /></button><button title="关闭" @click="handleWindowAction('close')"><X :size="22" /></button></div>
        </header>

        <div class="session-body">
          <section class="transcript-panel">
            <div class="panel-title">
              <h3>实时同传</h3>
              <div class="listening-tools">
                <div class="mini-wave" :class="{ active: isListening }"><i v-for="n in 27" :key="n" :style="{ height: `${6 + micLevel * (8 + (n * 7) % 18)}px` }"></i></div>
                <button v-if="isLive" class="listen-toggle" :title="isListening ? '暂停收音' : '继续收音'" @click="toggleListening"><Pause v-if="isListening" :size="17" /><Play v-else :size="17" />{{ isListening ? '暂停' : '继续' }}</button>
              </div>
            </div>

            <div ref="transcriptList" class="messages-list">
              <div v-if="messages.length === 0 && !interimText" class="listening-empty"><span class="listening-ring"><Mic :size="28" /></span><strong>{{ isListening ? '正在聆听' : '麦克风已暂停' }}</strong><p>{{ isListening ? '请两位依次说话，系统将自动识别并分离说话人' : '点击继续恢复实时识别' }}</p></div>
              <article v-for="message in messages" :key="message.id" class="speaker-card" :class="message.speaker === 1 ? 'speaker-one' : 'speaker-two'">
                <div class="speaker-meta">
                  <span class="speaker-avatar"><Fingerprint v-if="message.identitySource === 'voiceprint' || message.identitySource === 'session' || message.voiceprintMatched" :size="22" /><UserRound v-else :size="23" /></span><strong>{{ speakerLabel(message) }}</strong><em>{{ message.language }}</em>
                  <small class="speaker-confidence" :class="{ matched: message.identitySource === 'voiceprint' || message.identitySource === 'session' || message.voiceprintMatched, pending: isIdentityUnconfirmed(message) }">{{ identityLabel(message) }}</small>
                  <span class="sentence-status"><CheckCircle2 :size="13" />已断句</span>
                  <button class="swap-speaker" title="交换说话人" aria-label="交换说话人" @click="swapSpeaker(message)"><ArrowLeftRight :size="16" /></button>
                  <button class="play-audio" :class="{ playing: playingMessageId === message.id }" :aria-label="playingMessageId === message.id ? '停止播放' : '播放发言'" @click="speakMessage(message)"><Volume2 :size="20" /></button>
                  <div class="audio-line" :class="{ active: playingMessageId === message.id || (isListening && message.id === messages[messages.length - 1]?.id) }"><i v-for="n in 50" :key="n" :style="{ height: `${5 + (n * (message.speaker === 1 ? 11 : 13)) % 19}px` }"></i></div>
                  <time>{{ formatTime(message.time) }}</time>
                </div>
                <p class="spoken">{{ message.text }}</p>
                <div v-if="translating" class="translation" :class="{ streaming: message.translationStreaming }"><b>普通话整理 <small v-if="message.translationStreaming"><i></i>流式生成中</small></b><span>{{ message.translation || '正在接收转换结果…' }}</span></div>
              </article>
              <article v-if="interimText" class="speaker-card live-draft" :class="interimSpeaker === 1 ? 'speaker-one' : 'speaker-two'">
                <div class="speaker-meta">
                  <span class="speaker-avatar"><UserRound :size="23" /></span><strong>发言人 {{ interimSpeaker }}</strong><em>身份预判</em>
                  <small class="speaker-confidence">预判 {{ Math.round(interimSpeakerConfidence * 100) }}%</small>
                  <span class="sentence-status pending"><i></i>识别中 · 等待断句</span>
                  <div class="audio-line active"><i v-for="n in 50" :key="n" :style="{ height: `${5 + (n * (interimSpeaker === 1 ? 11 : 13)) % 19}px` }"></i></div>
                  <time>实时</time>
                </div>
                <p class="spoken">{{ interimText }}</p>
              </article>
            </div>

            <footer class="session-controls">
              <label class="language-control"><Globe2 :size="25" /><span>方言识别<strong>{{ dialect }}</strong></span><select v-model="dialect" :disabled="!isLive"><option v-for="item in dialectOptions" :key="item">{{ item }}</option></select><ChevronDown :size="17" /></label>
              <button v-if="isLive" class="end-button" @click="endSession"><Square :size="23" fill="white" /> 结束</button>
              <button v-else class="return-button" @click="view = 'welcome'"><ChevronRight :size="20" /> 返回首页</button>
              <label class="translate-toggle">发言人翻译 <input v-model="translating" type="checkbox" /><span></span></label>
            </footer>
          </section>

          <aside class="insights-panel">
            <section class="insight-card matter-card">
              <div class="insight-title"><h3><Sparkles :size="21" /> AI 事项理解</h3><button :disabled="messages.length === 0 || assistLoading" @click="refreshSuggestion"><RefreshCw :size="16" :class="{ spinning: assistLoading }" />{{ assistLoading ? '推断中' : '刷新' }}</button></div>
              <div v-if="messages.length" class="matter-content">
                <div class="ai-inference-warning"><Info :size="15" /><span>AI 推断候选，不构成行政判断</span></div>
                <section class="matter-section matter-candidates"><h4>事项候选</h4><div class="candidate-tags"><span v-for="item in currentMatter.candidates" :key="item">{{ item }}</span></div></section>
                <div class="matter-grid">
                  <section class="matter-section"><h4>关键事实</h4><ul><li v-for="item in currentMatter.key_facts" :key="item">{{ item }}</li></ul></section>
                  <section class="matter-section missing"><h4>缺失信息</h4><ul><li v-for="item in currentMatter.missing_information" :key="item">{{ item }}</li></ul></section>
                </div>
                <section class="suggested-question"><h4>建议追问</h4><p>{{ currentMatter.suggested_question }}</p></section>
                <button class="use-suggestion" :class="{ applied: appliedSuggestion }" :disabled="appliedSuggestion || !isLive || !currentMatter.suggested_question" @click="useSuggestion"><CheckCircle2 :size="19" />{{ appliedSuggestion ? '已加入实时对话' : isLive ? '使用该追问' : '历史内容仅供查看' }}</button>
              </div>
              <div v-else class="insight-empty"><Sparkles :size="26" /><span>等待识别咨询内容</span></div>
            </section>
            <section class="insight-card policy-card">
              <div class="insight-title"><h3><ShieldCheck :size="21" /> 政策材料引用</h3><span v-if="assistLoading" class="updating-state">核验中</span><span v-else-if="currentPolicyReference.status === 'verified'" class="verified-state">来源已核验</span></div>
              <div v-if="messages.length && currentPolicyReference.status === 'verified'" class="policy-reference">
                <h4>{{ currentPolicyReference.title }}</h4>
                <dl><div><dt>发布机构</dt><dd>{{ currentPolicyReference.issuer }}</dd></div><div><dt>版本 / 发布日期</dt><dd>{{ currentPolicyReference.version_or_date }}</dd></div><div><dt>引用位置</dt><dd>{{ currentPolicyReference.citation_location }}</dd></div></dl>
                <a :href="currentPolicyReference.url" target="_blank" rel="noopener noreferrer">查看官方来源 <ExternalLink :size="15" /></a>
              </div>
              <div v-else-if="messages.length" class="policy-empty"><ShieldCheck :size="24" /><strong>无可核验参考</strong><p>当前未找到可访问且版本信息完整的官方来源，系统不会自由生成政策答案。</p></div>
              <div v-else class="insight-empty"><ShieldCheck :size="26" /><span>等待事项信息后检索官方材料</span></div>
              <p v-if="messages.length" class="policy-disclaimer">模块六返回的是带来源和版本的引用草案，不构成政策结论。</p>
            </section>
          </aside>
        </div>
      </section>
    </section>

    <div v-if="settingsOpen" class="modal-backdrop" @click.self="settingsOpen = false">
      <section class="settings-modal" role="dialog" aria-modal="true" aria-label="设置中心">
        <header><div><h2>设置中心</h2><p>演示环境偏好设置</p></div><button aria-label="关闭设置" @click="settingsOpen = false"><X :size="21" /></button></header>
        <label><span>默认服务窗口</span><select v-model="service"><option>政务咨询窗口</option><option>警务服务窗口</option><option>社保服务窗口</option></select></label>
        <label><span>默认识别方言</span><select v-model="dialect"><option v-for="item in dialectOptions" :key="item">{{ item }}</option></select></label>
        <label class="modal-toggle"><span><strong>自动显示译文</strong><small>识别后同步展示普通话译文</small></span><input v-model="translating" type="checkbox" /><i></i></label>
        <label class="modal-toggle"><span><strong>智能降噪</strong><small>{{ isListening ? '暂停实时收音后可调整' : '过滤环境底噪并保留人声特征' }}</small></span><input v-model="noiseReduction" type="checkbox" :disabled="isListening" /><i></i></label>
        <div class="provider-card" :class="{ connected: aliyunConfig?.configured }">
          <span class="provider-icon"><Cloud :size="21" /></span>
          <span><strong>阿里云百炼 CosyVoice</strong><small>{{ aliyunConfig?.configured ? `${currentVoiceProfile?.name || '系统音色'} · ${currentVoiceProfile?.trait || '流式语音'}` : '等待配置 DASHSCOPE_API_KEY' }}</small></span>
          <em>{{ aliyunConfig?.configured ? '流式' : '未连接' }}</em>
        </div>
        <section class="voiceprint-panel">
          <div class="voiceprint-heading"><span class="provider-icon"><Fingerprint :size="21" /></span><span><strong>工作人员声纹</strong><small>{{ voiceprintReady ? voiceprintStaff.length ? `${voiceprintProvider === 'xfyun' ? '讯飞在线' : '本地'} · 已登记 ${voiceprintStaff.length} 位工作人员` : `${voiceprintProvider === 'xfyun' ? '讯飞在线服务' : '本地模型'}就绪，等待录入` : '声纹服务未就绪' }}</small></span></div>
          <div class="voiceprint-fields"><label><span>工号</span><input v-model="voiceprintStaffId" :disabled="voiceprintRecording" /></label><label><span>姓名</span><input v-model="voiceprintStaffName" :disabled="voiceprintRecording" /></label></div>
          <label class="voiceprint-consent"><input v-model="voiceprintConsent" type="checkbox" :disabled="voiceprintRecording" /><span>已取得工作人员本人授权，仅保存声纹向量</span></label>
          <button class="enroll-voiceprint" :class="{ recording: voiceprintRecording }" :disabled="!voiceprintReady || !voiceprintConsent || voiceprintRecording || voiceprintLoading || isListening" @click="recordVoiceprint"><MicOff v-if="voiceprintRecording" :size="18" /><Fingerprint v-else :size="18" />{{ voiceprintLoading ? '正在保存声纹样本' : voiceprintRecording ? `录入中 · ${voiceprintRemaining} 秒` : isListening ? '请先暂停实时收音' : '录入 8 秒声纹样本' }}</button>
          <div v-if="voiceprintStaff.length" class="voiceprint-list"><div v-for="staff in voiceprintStaff" :key="staff.staff_id"><span><strong>{{ staff.name }}</strong><small>{{ staff.staff_id }} · {{ staff.samples }} 个样本</small></span><button title="删除声纹" :disabled="voiceprintLoading" @click="removeVoiceprint(staff.staff_id)"><Trash2 :size="16" /></button></div></div>
        </section>
        <footer><button class="reset-button" @click="resetDemo"><RotateCcw :size="17" /> 重置演示数据</button><button class="save-button" @click="settingsOpen = false; showToast('设置已保存')">保存设置</button></footer>
      </section>
    </div>
    <Transition name="toast"><div v-if="toast" class="toast-message"><CheckCircle2 :size="18" />{{ toast }}</div></Transition>
  </main>
</template>
