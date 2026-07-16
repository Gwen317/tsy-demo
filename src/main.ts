import { createApp } from 'vue'
import App from './App.vue'
import VoiceprintTest from './VoiceprintTest.vue'
import './styles.css'

const isVoiceprintTest = window.location.pathname === '/voiceprint-test'
document.title = isVoiceprintTest ? 'Tsy · 工作人员声纹测试台' : 'Tsy · 方言同声传译 AI 助手'
createApp(isVoiceprintTest ? VoiceprintTest : App).mount('#app')
