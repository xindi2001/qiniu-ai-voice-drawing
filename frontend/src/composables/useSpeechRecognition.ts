import { onUnmounted, ref } from 'vue'

const ERROR_MESSAGES: Record<string, string> = {
  'not-allowed': '麦克风权限被拒绝，请在浏览器设置中允许访问',
  'no-speech': '未检测到语音，请重试',
  'audio-capture': '未找到麦克风设备',
  'network': '语音识别需要网络连接（Chrome 使用云端识别）',
  'aborted': '语音识别已取消',
  'language-not-supported': '当前浏览器不支持中文语音识别',
  'service-not-allowed': '语音识别服务不可用',
}

function getRecognitionCtor(): SpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') return null
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null
}

export interface SpeechRecognitionOptions {
  continuous?: boolean
  onFinalTranscript?: (text: string) => void
}

export function useSpeechRecognition(options: SpeechRecognitionOptions = {}) {
  const isListening = ref(false)
  const transcript = ref('')
  const interimTranscript = ref('')
  const isSupported = ref(getRecognitionCtor() !== null)
  const error = ref<string | null>(null)
  const continuous = ref(options.continuous ?? false)

  let recognition: SpeechRecognition | null = null

  function createRecognition(): SpeechRecognition | null {
    const Ctor = getRecognitionCtor()
    if (!Ctor) return null

    const instance = new Ctor()
    instance.lang = 'zh-CN'
    instance.continuous = continuous.value
    instance.interimResults = true
    instance.maxAlternatives = 1

    instance.onstart = () => {
      isListening.value = true
      error.value = null
    }

    instance.onresult = (event: SpeechRecognitionEvent) => {
      let interim = ''
      let finalText = ''

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        const text = result[0]?.transcript ?? ''
        if (result.isFinal) {
          finalText += text
        } else {
          interim += text
        }
      }

      interimTranscript.value = interim
      if (finalText) {
        transcript.value = (transcript.value + finalText).trim()
        interimTranscript.value = ''
        options.onFinalTranscript?.(finalText.trim())
      }
    }

    instance.onerror = (event: SpeechRecognitionErrorEvent) => {
      const message =
        ERROR_MESSAGES[event.error] ?? `语音识别错误: ${event.error}`
      error.value = message
      isListening.value = false
    }

    instance.onend = () => {
      isListening.value = false
      interimTranscript.value = ''
    }

    return instance
  }

  function startListening(): void {
    if (!isSupported.value) {
      error.value = '当前浏览器不支持 Web Speech API，请使用 Chrome 或 Edge'
      return
    }

    if (isListening.value) return

    error.value = null
    transcript.value = ''
    interimTranscript.value = ''

    try {
      recognition?.abort()
      recognition = createRecognition()
      if (!recognition) {
        error.value = '无法初始化语音识别'
        return
      }
      recognition.start()
    } catch {
      error.value = '启动语音识别失败，请检查麦克风权限'
      isListening.value = false
    }
  }

  function stopListening(): void {
    if (!recognition || !isListening.value) return
    try {
      recognition.stop()
    } catch {
      isListening.value = false
    }
  }

  function toggleContinuous(): void {
    continuous.value = !continuous.value
    if (isListening.value) {
      stopListening()
    }
  }

  function resetTranscript(): void {
    transcript.value = ''
    interimTranscript.value = ''
    error.value = null
  }

  onUnmounted(() => {
    recognition?.abort()
    recognition = null
  })

  return {
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
  }
}
