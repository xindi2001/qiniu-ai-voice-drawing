import { ref } from 'vue'
import { fixDrawTypo } from '../utils/speakUtils'

export function useSpeechSynthesis() {
  const isSpeaking = ref(false)
  const isSupported = ref(
    typeof window !== 'undefined' && 'speechSynthesis' in window,
  )

  function speak(text: string): void {
    if (!isSupported.value || !text) return

    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(fixDrawTypo(text))
    utterance.lang = 'zh-CN'
    utterance.onstart = () => {
      isSpeaking.value = true
    }
    utterance.onend = () => {
      isSpeaking.value = false
    }
    utterance.onerror = () => {
      isSpeaking.value = false
    }
    window.speechSynthesis.speak(utterance)
  }

  function stop(): void {
    window.speechSynthesis.cancel()
    isSpeaking.value = false
  }

  return { isSpeaking, isSupported, speak, stop }
}
