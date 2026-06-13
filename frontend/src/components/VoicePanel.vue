<script setup lang="ts">
import { computed } from 'vue'
import { useSpeechRecognition } from '../composables/useSpeechRecognition'

const emit = defineEmits<{
  voiceResult: [text: string]
}>()

defineProps<{
  loading?: boolean
}>()

const {
  isListening,
  isTranscribing,
  transcript,
  interimTranscript,
  isSupported,
  continuous,
  confirmBeforeExecute,
  providerName,
  providerMessage,
  error,
  startListening,
  stopListening,
  toggleContinuous,
  toggleConfirmBeforeExecute,
  confirmTranscript,
  submitPendingTranscript,
} = useSpeechRecognition({
  onFinalTranscript(text) {
    if (text.trim()) {
      emit('voiceResult', text.trim())
    }
  },
})

const providerLabel = computed(() =>
  providerName.value === 'aliyun' ? '阿里云 ASR' : 'Web Speech API',
)

const busy = computed(() => isListening.value || isTranscribing.value)

function handleStart(): void {
  startListening()
}

function handleStop(): void {
  stopListening()
  if (!confirmBeforeExecute.value) {
    submitPendingTranscript()
  }
}

function handleConfirm(): void {
  confirmTranscript()
}
</script>

<template>
  <section class="voice-panel">
    <h3>语音输入</h3>
    <p v-if="!isSupported" class="notice warn">
      当前环境不支持语音识别。请配置阿里云 ASR 环境变量并重启后端，或使用 Chrome/Edge 的 Web Speech API。
    </p>
    <p v-else-if="providerMessage" class="notice">
      {{ providerMessage }}
    </p>
    <div class="status">
      <span :class="['dot', isSupported ? 'ok' : 'warn']" />
      {{ isSupported ? `识别引擎：${providerLabel}` : '语音识别不可用' }}
      <span v-if="isListening" class="listening-badge">录音中...</span>
      <span v-else-if="isTranscribing" class="listening-badge transcribing">识别中...</span>
    </div>
    <div class="mode-toggle">
      <label>
        <input
          type="checkbox"
          :checked="continuous"
          :disabled="busy || loading || providerName === 'aliyun'"
          @change="toggleContinuous"
        />
        连续识别模式（说完自动提交，仅 Web Speech）
      </label>
    </div>
    <div class="mode-toggle">
      <label>
        <input
          type="checkbox"
          :checked="confirmBeforeExecute"
          :disabled="busy || loading"
          @change="toggleConfirmBeforeExecute"
        />
        确认后再执行（识别完成后需点「确认执行」）
      </label>
    </div>
    <div class="controls">
      <button
        type="button"
        class="btn-start"
        :disabled="!isSupported || busy || loading"
        @click="handleStart"
      >
        {{ loading ? '解析中...' : '开始录音' }}
      </button>
      <button
        type="button"
        class="btn-stop"
        :disabled="!isListening"
        @click="handleStop"
      >
        停止并识别
      </button>
      <button
        v-if="confirmBeforeExecute && (transcript || interimTranscript)"
        type="button"
        class="btn-confirm"
        :disabled="loading"
        @click="handleConfirm"
      >
        确认执行
      </button>
    </div>
    <p v-if="loading" class="loading">
      <span class="spinner" />正在解析指令...
    </p>
    <p v-if="error" class="error">{{ error }}</p>
    <div v-if="transcript || interimTranscript" class="transcript-box">
      <p v-if="transcript" class="transcript">
        <strong>识别结果：</strong>{{ transcript }}
      </p>
      <p v-if="interimTranscript" class="interim">
        <strong>实时识别：</strong>{{ interimTranscript }}
      </p>
    </div>
    <p v-if="!continuous && !confirmBeforeExecute" class="hint">
      按住说话模式：点击「开始录音」说话，完成后点击「停止并识别」
    </p>
  </section>
</template>

<style scoped>
.voice-panel {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

h3 {
  margin: 0;
  font-size: 1rem;
}

.notice {
  margin: 0;
  font-size: 0.85rem;
  color: #64748b;
  background: #fffbeb;
  border: 1px solid #fde68a;
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
}

.notice.warn {
  background: #fef2f2;
  border-color: #fecaca;
  color: #b91c1c;
}

.status {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.85rem;
  color: #475569;
  flex-wrap: wrap;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.dot.ok {
  background: #22c55e;
}

.dot.warn {
  background: #f59e0b;
}

.listening-badge {
  font-size: 0.75rem;
  color: #dc2626;
  background: #fee2e2;
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  animation: pulse 1.5s ease-in-out infinite;
}

.listening-badge.transcribing {
  color: #4f46e5;
  background: #e0e7ff;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}

.mode-toggle label {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.85rem;
  color: #475569;
  cursor: pointer;
}

.controls {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

button {
  padding: 0.5rem 1rem;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  background: white;
}

.btn-start {
  background: #4f46e5;
  color: white;
  border-color: #4f46e5;
}

.btn-stop {
  background: #fef2f2;
  border-color: #fecaca;
  color: #b91c1c;
}

.btn-confirm {
  background: #ecfdf5;
  border-color: #86efac;
  color: #15803d;
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.loading {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: #4f46e5;
  font-size: 0.85rem;
  margin: 0;
}

.spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid #c7d2fe;
  border-top-color: #4f46e5;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.error {
  color: #dc2626;
  font-size: 0.85rem;
  margin: 0;
}

.transcript-box {
  background: white;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
}

.transcript,
.interim {
  font-size: 0.85rem;
  color: #334155;
  margin: 0.2rem 0;
}

.interim {
  color: #94a3b8;
  font-style: italic;
}

.hint {
  margin: 0;
  font-size: 0.8rem;
  color: #94a3b8;
}
</style>
