import { onUnmounted, ref } from 'vue'

export function useAudioRecorder() {
  const isRecording = ref(false)
  const error = ref<string | null>(null)

  let mediaRecorder: MediaRecorder | null = null
  let mediaStream: MediaStream | null = null
  let chunks: Blob[] = []

  async function startRecording(): Promise<void> {
    if (isRecording.value) return

    error.value = null
    chunks = []

    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = pickMimeType()
      mediaRecorder = mimeType
        ? new MediaRecorder(mediaStream, { mimeType })
        : new MediaRecorder(mediaStream)

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data)
        }
      }

      mediaRecorder.start()
      isRecording.value = true
    } catch {
      error.value = '无法访问麦克风，请检查浏览器权限'
      cleanup()
    }
  }

  function stopRecording(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      if (!mediaRecorder || !isRecording.value) {
        reject(new Error('未在录音中'))
        return
      }

      mediaRecorder.onstop = () => {
        const type = mediaRecorder?.mimeType || 'audio/webm'
        const blob = new Blob(chunks, { type })
        isRecording.value = false
        cleanup()
        resolve(blob)
      }

      mediaRecorder.onerror = () => {
        error.value = '录音失败'
        isRecording.value = false
        cleanup()
        reject(new Error('录音失败'))
      }

      mediaRecorder.stop()
    })
  }

  function cleanup(): void {
    mediaStream?.getTracks().forEach((track) => track.stop())
    mediaStream = null
    mediaRecorder = null
    chunks = []
  }

  function pickMimeType(): string | undefined {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
    ]
    return candidates.find((type) => MediaRecorder.isTypeSupported(type))
  }

  onUnmounted(() => {
    if (isRecording.value) {
      mediaRecorder?.stop()
    }
    cleanup()
  })

  return {
    isRecording,
    error,
    startRecording,
    stopRecording,
  }
}
