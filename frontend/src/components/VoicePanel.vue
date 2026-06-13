<script setup lang="ts">
import { useSpeechRecognition } from '../composables/useSpeechRecognition'

const emit = defineEmits<{
  voiceResult: [text: string]
}>()

defineProps<{
  loading?: boolean
}>()

const {
  isListening,
  transcript,
  interimTranscript,
  isSupported,
  continuous,
  error,
  startListening,
  stopListening,
  toggleContinuous,
  resetTranscript,
} = useSpeechRecognition({
  onFinalTranscript(text) {
    if (continuous.value && text.trim()) {
      emit('voiceResult', text.trim())
      resetTranscript()
    }
  },
})

function handleStart(): void {
  startListening()
}

function handleStop(): void {
  stopListening()
  const text = (transcript.value + interimTranscript.value).trim()
  if (!continuous.value && text) {
    emit('voiceResult', text)
    resetTranscript()
  }
}
</script>

<template>
  <section class="voice-panel">
    <h3>语音输入</h3>
    <p v-if="!isSupported" class="notice warn">
      当前浏览器不支持 Web Speech API，请使用 Chrome 或 Edge，或改用文本输入。
    </p>
    <div class="status">
      <span :class="['dot', isSupported ? 'ok' : 'warn']" />
      {{ isSupported ? '浏览器支持语音识别' : '浏览器不支持语音识别' }}
      <span v-if="isListening" class="listening-badge">聆听中...</span>
    </div>
    <div class="mode-toggle">
      <label>
        <input
          type="checkbox"
          :checked="continuous"
          :disabled="isListening || loading"
          @change="toggleContinuous"
        />
        连续识别模式（说完自动提交）
      </label>
    </div>
    <div class="controls">
      <button
        type="button"
        class="btn-start"
        :disabled="!isSupported || isListening || loading"
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
        停止并提交
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
    <p v-if="!continuous" class="hint">
      按住说话模式：点击「开始录音」说话，完成后点击「停止并提交」
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
