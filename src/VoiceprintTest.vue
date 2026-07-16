<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ArrowLeft, CheckCircle2, Fingerprint, Mic, RefreshCw, ShieldCheck, Trash2, UserRound, XCircle } from 'lucide-vue-next'
import { captureVoiceprintSample, deleteVoiceprint, enrollVoiceprint, identifyVoiceprint, listVoiceprints, type VoiceprintStaff } from './services/voiceprint'

interface TestRecord {
  id: number
  time: string
  matched: boolean
  name: string
  staffId: string
  score: number
  confidence: number
  threshold: number
  elapsed: number
}

const staff = ref<VoiceprintStaff[]>([])
const ready = ref(false)
const provider = ref<'local' | 'xfyun'>('local')
const threshold = ref(0.6)
const loading = ref(false)
const mode = ref<'idle' | 'enroll' | 'identify'>('idle')
const remaining = ref(0)
const staffId = ref('ZY-0186')
const staffName = ref('窗口工作人员')
const consent = ref(false)
const records = ref<TestRecord[]>([])
const message = ref('')
const latest = computed(() => records.value[0] || null)

function formatPercent(value: number) {
  const percent = value * 100
  return Number.isInteger(percent) ? percent.toFixed(0) : percent.toFixed(1)
}

async function loadStaff() {
  try {
    const result = await listVoiceprints()
    ready.value = result.ready
    provider.value = result.provider || 'local'
    staff.value = result.staff
    threshold.value = result.threshold ?? threshold.value
  } catch (error) {
    ready.value = false
    message.value = error instanceof Error ? error.message : '声纹服务不可用'
  }
}

function explainError(error: unknown) {
  if (error instanceof DOMException && error.name === 'NotAllowedError') return '需要允许麦克风权限才能继续'
  return error instanceof Error ? error.message : '操作失败，请重试'
}

async function enroll() {
  if (!consent.value || !staffId.value.trim() || !staffName.value.trim() || loading.value) return
  try {
    loading.value = true
    mode.value = 'enroll'
    remaining.value = 8
    message.value = '请保持正常坐姿，用日常窗口音量连续朗读。'
    const audio = await captureVoiceprintSample(8, (value) => { remaining.value = value })
    const result = await enrollVoiceprint(staffId.value.trim(), staffName.value.trim(), audio)
    const existingIndex = staff.value.findIndex((item) => item.staff_id === result.staff_id)
    if (existingIndex >= 0) staff.value[existingIndex] = result
    else staff.value.push(result)
    window.setTimeout(() => { void loadStaff() }, 1200)
    message.value = `${result.name} 录入成功，当前共有 ${result.samples} 个样本。`
  } catch (error) {
    message.value = explainError(error)
  } finally {
    loading.value = false
    mode.value = 'idle'
    remaining.value = 0
  }
}

async function identify() {
  if (loading.value) return
  try {
    loading.value = true
    mode.value = 'identify'
    remaining.value = 5
    message.value = '请测试人员连续说一段自然语音。'
    const startedAt = performance.now()
    const audio = await captureVoiceprintSample(5, (value) => { remaining.value = value })
    const result = await identifyVoiceprint(audio)
    records.value.unshift({
      id: Date.now(),
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      matched: result.matched,
      name: result.name || '未匹配',
      staffId: result.staff_id || '-',
      score: result.score,
      confidence: result.confidence || 0,
      threshold: result.threshold || threshold.value,
      elapsed: Math.round(performance.now() - startedAt),
    })
    message.value = result.matched ? `已识别为 ${result.name}` : '未达到工作人员声纹阈值'
  } catch (error) {
    message.value = explainError(error)
  } finally {
    loading.value = false
    mode.value = 'idle'
    remaining.value = 0
  }
}

async function remove(staffIdValue: string) {
  if (loading.value) return
  try {
    loading.value = true
    await deleteVoiceprint(staffIdValue)
    await loadStaff()
    message.value = '声纹档案已删除。'
  } catch (error) {
    message.value = explainError(error)
  } finally {
    loading.value = false
  }
}

onMounted(() => { void loadStaff() })
</script>

<template>
  <main class="vp-page">
    <header class="vp-header">
      <div class="vp-title"><span><Fingerprint :size="25" /></span><div><h1>工作人员声纹测试台</h1><p>独立注册、识别与阈值验证</p></div></div>
      <div class="vp-header-actions"><span class="vp-status" :class="{ ready }"><i></i>{{ ready ? provider === 'xfyun' ? '讯飞在线服务就绪' : '本地声纹服务就绪' : '服务未就绪' }}</span><a href="/"><ArrowLeft :size="17" />返回主 Demo</a></div>
    </header>

    <section class="vp-metrics">
      <div><span>登记人员</span><strong>{{ staff.length }}</strong><small>{{ provider === 'xfyun' ? '讯飞云声纹档案' : '本地声纹档案' }}</small></div>
      <div><span>判定阈值</span><strong>{{ formatPercent(threshold) }}%</strong><small>原始余弦相似度</small></div>
      <div><span>测试次数</span><strong>{{ records.length }}</strong><small>当前页面会话</small></div>
      <div><span>最近结果</span><strong :class="latest?.matched ? 'positive' : latest ? 'negative' : ''">{{ latest ? latest.matched ? '已匹配' : '未匹配' : '待测试' }}</strong><small>{{ latest?.name || '尚无识别结果' }}</small></div>
    </section>

    <div class="vp-grid">
      <section class="vp-section">
        <div class="vp-section-title"><div><span class="step">01</span><div><h2>登记工作人员</h2><p>建议同一人员在不同距离下录入 3 次</p></div></div></div>
        <div class="vp-form"><label><span>工作人员工号</span><input v-model="staffId" :disabled="loading" /></label><label><span>工作人员姓名</span><input v-model="staffName" :disabled="loading" /></label></div>
        <label class="vp-consent"><input v-model="consent" type="checkbox" :disabled="loading" /><span><ShieldCheck :size="16" />已取得本人授权，仅保存不可逆声学向量</span></label>
        <div class="vp-recording" :class="{ active: mode === 'enroll' }"><div class="vp-orbit"><Fingerprint :size="34" /></div><strong>{{ mode === 'enroll' ? `${remaining} 秒` : '8 秒样本' }}</strong><p>{{ mode === 'enroll' ? '正在采集登记语音' : '使用正常窗口音量连续朗读' }}</p><div class="vp-bars"><i v-for="index in 22" :key="index" :style="{ height: `${7 + (index * 9) % 22}px` }"></i></div></div>
        <button class="vp-primary" :disabled="!ready || !consent || loading" @click="enroll"><Mic :size="19" />{{ mode === 'enroll' ? `录入中 · ${remaining} 秒` : '开始录入声纹' }}</button>
      </section>

      <section class="vp-section">
        <div class="vp-section-title"><div><span class="step">02</span><div><h2>现场身份测试</h2><p>测试语音不会写入任何人员档案</p></div></div></div>
        <div class="vp-test-stage" :class="{ active: mode === 'identify', matched: latest?.matched }">
          <div class="vp-test-icon"><UserRound :size="39" /></div>
          <strong>{{ mode === 'identify' ? `${remaining} 秒` : latest ? latest.name : '等待测试' }}</strong>
          <p>{{ mode === 'identify' ? '正在采集测试语音' : latest ? latest.matched ? '工作人员声纹匹配成功' : '未匹配到登记工作人员' : '录制 5 秒自然语音进行比对' }}</p>
          <div v-if="latest" class="vp-score"><span><b>{{ (latest.score * 100).toFixed(2) }}%</b><small>原始相似度</small></span><span><b>{{ (latest.confidence * 100).toFixed(0) }}%</b><small>校准置信度</small></span><span><b>{{ latest.elapsed }} ms</b><small>总处理耗时</small></span></div>
        </div>
        <button class="vp-primary test" :disabled="!ready || loading || !staff.length" @click="identify"><Fingerprint :size="19" />{{ mode === 'identify' ? `识别中 · ${remaining} 秒` : '开始身份测试' }}</button>
        <p class="vp-message">{{ message || '登记声纹后即可开始身份测试。' }}</p>
      </section>

      <section class="vp-section roster">
        <div class="vp-section-title"><div><span class="step">03</span><div><h2>声纹档案</h2><p>管理登记人员与录入样本</p></div></div><button title="刷新" @click="loadStaff"><RefreshCw :size="17" /></button></div>
        <div v-if="staff.length" class="vp-roster"><div v-for="item in staff" :key="item.staff_id"><span class="vp-avatar"><UserRound :size="20" /></span><span><strong>{{ item.name }}</strong><small>{{ item.staff_id }}</small></span><em>{{ item.samples }} 个样本</em><button title="删除档案" :disabled="loading" @click="remove(item.staff_id)"><Trash2 :size="16" /></button></div></div>
        <div v-else class="vp-empty"><Fingerprint :size="28" /><strong>暂无工作人员声纹</strong><p>请先在左侧完成首次录入</p></div>

        <div class="vp-history-title"><h3>测试记录</h3><button v-if="records.length" @click="records = []">清空</button></div>
        <div v-if="records.length" class="vp-history"><div v-for="record in records" :key="record.id"><CheckCircle2 v-if="record.matched" :size="18" class="ok" /><XCircle v-else :size="18" class="fail" /><span><strong>{{ record.name }}</strong><small>{{ record.time }} · 原始 {{ (record.score * 100).toFixed(2) }}%</small></span><em :class="record.matched ? 'ok' : 'fail'">{{ record.matched ? '通过' : '拒绝' }}</em></div></div>
        <div v-else class="vp-history-empty">测试后将在这里显示识别记录</div>
      </section>
    </div>
  </main>
</template>

<style scoped>
:global(*){box-sizing:border-box}:global(body){margin:0;background:#eef2f7;color:#12213f;font-family:Inter,"PingFang SC","Microsoft YaHei",sans-serif}.vp-page{min-height:100vh;padding:24px 30px 38px}.vp-header{max-width:1440px;margin:auto;display:flex;align-items:center;justify-content:space-between}.vp-title,.vp-title>span,.vp-header-actions,.vp-header-actions a,.vp-status{display:flex;align-items:center}.vp-title{gap:12px}.vp-title>span{width:46px;height:46px;justify-content:center;color:#fff;border-radius:8px;background:#1268df}.vp-title h1{margin:0;font-size:21px}.vp-title p{margin:4px 0 0;color:#72809a;font-size:12px}.vp-header-actions{gap:15px}.vp-status{gap:7px;padding:7px 10px;color:#a04b4b;border:1px solid #eed1d1;border-radius:6px;background:#fff6f6;font-size:12px}.vp-status i{width:7px;height:7px;border-radius:50%;background:#dc5252}.vp-status.ready{color:#087c45;border-color:#c5e7d5;background:#f1fbf6}.vp-status.ready i{background:#18aa62}.vp-header-actions a{gap:7px;color:#3d5477;font-size:13px;text-decoration:none}.vp-metrics{max-width:1440px;margin:22px auto 14px;display:grid;grid-template-columns:repeat(4,1fr);border:1px solid #dce3ec;border-radius:8px;background:white}.vp-metrics>div{min-height:92px;padding:16px 20px;display:grid;align-content:center;border-right:1px solid #e4e9f0}.vp-metrics>div:last-child{border:0}.vp-metrics span,.vp-metrics small{color:#77849a;font-size:11px}.vp-metrics strong{margin:4px 0 2px;font-size:22px}.positive{color:#09814a}.negative{color:#cf4450}.vp-grid{max-width:1440px;margin:auto;display:grid;grid-template-columns:1fr 1fr .9fr;gap:14px}.vp-section{min-height:610px;padding:20px;overflow:hidden;border:1px solid #dce3ec;border-radius:8px;background:#fff}.vp-section-title,.vp-section-title>div{display:flex;align-items:center;justify-content:space-between}.vp-section-title>div{justify-content:flex-start;gap:10px}.vp-section-title h2{margin:0;font-size:16px}.vp-section-title p{margin:4px 0 0;color:#7b879b;font-size:11px}.step{width:29px;height:29px;display:grid;place-items:center;color:#176bda;border-radius:6px;background:#edf4ff;font-size:11px;font-weight:700}.vp-section-title>button{width:30px;height:30px;display:grid;place-items:center;color:#64738d;border:0;border-radius:6px;background:#f2f5f9}.vp-form{margin-top:22px;display:grid;grid-template-columns:1fr 1fr;gap:10px}.vp-form label{display:grid;gap:6px;color:#66748d;font-size:11px}.vp-form input{width:100%;height:39px;padding:0 11px;border:1px solid #d8e0eb;border-radius:6px;outline:0}.vp-form input:focus{border-color:#67a2ef;box-shadow:0 0 0 3px #eaf3ff}.vp-consent{margin-top:14px;display:flex;align-items:center;gap:8px;color:#596984;font-size:11px}.vp-consent input{width:15px;height:15px;accent-color:#1268df}.vp-consent span{display:flex;align-items:center;gap:5px}.vp-recording,.vp-test-stage{height:278px;margin-top:18px;display:flex;flex-direction:column;align-items:center;justify-content:center;border:1px solid #e0e6ef;border-radius:8px;background:#f8fafc}.vp-orbit,.vp-test-icon{width:82px;height:82px;display:grid;place-items:center;color:#176bd7;border-radius:50%;background:#e8f2ff;box-shadow:0 0 0 12px #f1f6fd}.vp-recording strong,.vp-test-stage>strong{margin-top:22px;font-size:22px}.vp-recording p,.vp-test-stage>p{margin:6px 0 0;color:#77849a;font-size:12px}.vp-bars{height:34px;margin-top:19px;display:flex;align-items:center;gap:3px}.vp-bars i{width:3px;border-radius:3px;background:#a8c7ef}.vp-recording.active .vp-orbit,.vp-test-stage.active .vp-test-icon{color:white;background:#df4351;animation:pulse 1s infinite}.vp-recording.active .vp-bars i{background:#e75965;animation:bars .55s ease-in-out infinite alternate}.vp-recording.active .vp-bars i:nth-child(3n){animation-delay:.18s}.vp-primary{width:100%;height:44px;margin-top:14px;display:flex;align-items:center;justify-content:center;gap:8px;color:#fff;border:0;border-radius:7px;background:#1268df;font-weight:700}.vp-primary.test{background:#128b56}.vp-primary:disabled{color:#8c98aa;background:#e6eaf0}.vp-test-stage{height:340px}.vp-test-stage.matched .vp-test-icon{color:#07824a;background:#dff7ea;box-shadow:0 0 0 12px #eefbf4}.vp-score{width:calc(100% - 34px);margin-top:25px;padding-top:18px;display:grid;grid-template-columns:repeat(3,1fr);border-top:1px solid #dde4ed}.vp-score span{display:grid;text-align:center}.vp-score span+span{border-left:1px solid #e2e7ee}.vp-score b{font-size:15px}.vp-score small{margin-top:3px;color:#7e8a9e;font-size:9px}.vp-message{min-height:30px;margin:12px 3px 0;color:#69768e;font-size:11px;text-align:center}.vp-roster{margin-top:18px;display:grid;gap:8px}.vp-roster>div{min-height:56px;padding:8px;display:grid;grid-template-columns:38px 1fr auto 30px;align-items:center;gap:8px;border:1px solid #e1e7ef;border-radius:7px}.vp-avatar{width:36px;height:36px;display:grid;place-items:center;color:#176bd7;border-radius:6px;background:#edf4fe}.vp-roster>div>span:nth-child(2){display:grid;gap:3px}.vp-roster strong{font-size:12px}.vp-roster small{color:#7b879b;font-size:10px}.vp-roster em{padding:4px 7px;color:#50709a;border-radius:5px;background:#eff4fa;font-size:9px;font-style:normal}.vp-roster button{width:28px;height:28px;display:grid;place-items:center;color:#d64955;border:0;border-radius:5px;background:transparent}.vp-roster button:hover{background:#fff0f1}.vp-empty{height:150px;margin-top:18px;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#8a96a8;border:1px dashed #d8dfe9;border-radius:7px}.vp-empty strong{margin-top:8px;color:#5f6f87;font-size:12px}.vp-empty p{margin:4px 0 0;font-size:10px}.vp-history-title{margin-top:22px;padding-top:17px;display:flex;align-items:center;justify-content:space-between;border-top:1px solid #e4e9f0}.vp-history-title h3{margin:0;font-size:13px}.vp-history-title button{color:#6e7c92;border:0;background:transparent;font-size:10px}.vp-history{margin-top:10px;display:grid;gap:6px}.vp-history>div{min-height:46px;padding:7px 8px;display:grid;grid-template-columns:21px 1fr auto;align-items:center;gap:7px;border-radius:6px;background:#f7f9fc}.vp-history span{display:grid;gap:2px}.vp-history strong{font-size:11px}.vp-history small{color:#8490a2;font-size:9px}.vp-history em{font-size:10px;font-style:normal}.ok{color:#0a9555}.fail{color:#d34752}.vp-history-empty{margin-top:10px;padding:24px;color:#909aac;border-radius:6px;background:#f8fafc;font-size:10px;text-align:center}@keyframes pulse{50%{box-shadow:0 0 0 19px rgba(223,67,81,.08)}}@keyframes bars{to{transform:scaleY(.45);opacity:.5}}@media(max-width:1100px){.vp-grid{grid-template-columns:1fr 1fr}.vp-section.roster{grid-column:1/-1;min-height:auto}.vp-metrics{grid-template-columns:1fr 1fr}.vp-metrics>div:nth-child(2){border-right:0}.vp-metrics>div:nth-child(-n+2){border-bottom:1px solid #e4e9f0}}@media(max-width:720px){.vp-page{padding:16px}.vp-header{align-items:flex-start}.vp-header-actions{align-items:flex-end;flex-direction:column}.vp-status{display:none}.vp-grid{grid-template-columns:1fr}.vp-section.roster{grid-column:auto}.vp-metrics{grid-template-columns:1fr 1fr}.vp-form{grid-template-columns:1fr}.vp-section{min-height:auto}}
</style>
