/**
 * Converts recorded audio to 16 kHz mono WAV for Aliyun ASR.
 */
export async function convertBlobToWav16k(blob: Blob, targetSampleRate = 16000): Promise<Blob> {
  const arrayBuffer = await blob.arrayBuffer()
  const audioContext = new AudioContext()
  try {
    const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0))
    const frameCount = Math.ceil(decoded.duration * targetSampleRate)
    const offlineContext = new OfflineAudioContext(1, frameCount, targetSampleRate)
    const source = offlineContext.createBufferSource()
    source.buffer = decoded
    source.connect(offlineContext.destination)
    source.start(0)
    const rendered = await offlineContext.startRendering()
    return encodeWav(rendered)
  } finally {
    await audioContext.close()
  }
}

function encodeWav(audioBuffer: AudioBuffer): Blob {
  const channel = audioBuffer.getChannelData(0)
  const sampleRate = audioBuffer.sampleRate
  const buffer = new ArrayBuffer(44 + channel.length * 2)
  const view = new DataView(buffer)

  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + channel.length * 2, true)
  writeString(view, 8, 'WAVE')
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeString(view, 36, 'data')
  view.setUint32(40, channel.length * 2, true)

  let offset = 44
  for (let i = 0; i < channel.length; i++) {
    const sample = Math.max(-1, Math.min(1, channel[i] ?? 0))
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
    offset += 2
  }

  return new Blob([buffer], { type: 'audio/wav' })
}

function writeString(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i))
  }
}
