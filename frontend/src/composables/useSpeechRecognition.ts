import { ref } from 'vue'

/**
 * Web Speech API 语音识别占位 composable。
 * MVP 阶段使用文本输入调试，后续在此接入 SpeechRecognition。
 */
export function useSpeechRecognition() {
  const isListening = ref(false)
  const transcript = ref('')
  const isSupported = ref(
    typeof window !== 'undefined' &&
      ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window),
  )
  const error = ref<string | null>(null)

  function startListening(): void {
    if (!isSupported.value) {
      error.value = '当前浏览器不支持 Web Speech API'
      return
    }
    // TODO: 接入 SpeechRecognition，将识别结果写入 transcript
    isListening.value = true
    error.value = '语音识别尚未实现，请使用文本输入'
    isListening.value = false
  }

  function stopListening(): void {
    isListening.value = false
  }

  function resetTranscript(): void {
    transcript.value = ''
    error.value = null
  }

  return {
    isListening,
    transcript,
    isSupported,
    error,
    startListening,
    stopListening,
    resetTranscript,
  }
}
