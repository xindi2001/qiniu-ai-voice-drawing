import type { DrawAction } from '../types/commands'

const DRAWING_ACTIONS = new Set([
  'draw',
  'draw_stroke',
  'draw_paths',
  'drawPath',
  'generate_and_trace',
  'useTemplate',
  'useIcon',
])

const FUTURE_TENSE_PATTERN =
  /我来|为你画|正在画|开始画|马上画|这就画|好，我|我来为|即将画|准备画/

/** Fix common ASR/LLM typo: 话 → 画 in drawing context. */
export function fixDrawTypo(text: string): string {
  return text
    .replace(/([来为帮])话/g, '$1画')
    .replace(/画一话/g, '画一画')
    .replace(/话一([匹只条棵座颗个])/g, '画一$1')
    .replace(/一话([匹只条棵座颗张])/g, '一$1')
}

export function isDrawingAction(action: DrawAction): boolean {
  return DRAWING_ACTIONS.has(action.action)
}

export function hasDrawingActions(actions: DrawAction[]): boolean {
  return actions.some(isDrawingAction)
}

export function isFutureTenseSpeak(text: string): boolean {
  return FUTURE_TENSE_PATTERN.test(text)
}

export function resolveCompletionSpeak(
  speak: string | undefined,
  userText: string,
): string {
  const fixed = fixDrawTypo(speak?.trim() ?? '')
  if (fixed && !isFutureTenseSpeak(fixed)) {
    return fixed
  }
  return fallbackCompletionSpeak(userText)
}

const PAST_TENSE_PATTERN = /已画|已描|已执行|画好了|描绘完成|已完成|好了，已/

/** Short acknowledgment spoken immediately before drawing starts. */
export function resolveAckSpeak(
  speak: string | undefined,
  userText: string,
  _actions: DrawAction[],
): string {
  const fixed = fixDrawTypo(speak?.trim() ?? '')
  if (fixed && isFutureTenseSpeak(fixed)) {
    return fixed
  }
  if (fixed && PAST_TENSE_PATTERN.test(fixed)) {
    return pastToAckSpeak(fixed, userText)
  }
  if (fixed && !PAST_TENSE_PATTERN.test(fixed)) {
    return fixed
  }
  return fallbackAckSpeak(userText)
}

function pastToAckSpeak(past: string, userText: string): string {
  const ack = fallbackAckSpeak(userText)
  if (ack !== '好的，开始绘制') return ack
  return past.replace(/已/g, '开始').replace(/好了/g, '开始')
}

function fallbackAckSpeak(userText: string): string {
  const text = userText.trim()
  if (text.includes('马')) return '好的，开始画一匹马'
  if (text.includes('跑车') || text.includes('车')) return '好的，开始画一辆车'
  if (text.includes('猫')) return '好的，开始画一只猫'
  if (text.includes('狗')) return '好的，开始画一只狗'
  if (text.includes('房子') || text.includes('屋')) return '好的，开始画一座房子'
  if (text.includes('树')) return '好的，开始画一棵树'
  if (text.includes('太阳')) return '好的，开始画一个太阳'
  if (text.includes('星星') || text.includes('星')) return '好的，开始画一颗星星'
  if (text.includes('头像') || text.includes('人像') || text.includes('肖像')) {
    return '好的，开始描绘头像'
  }
  if (text.includes('圆')) return '好的，开始画圆'
  if (text.includes('矩形') || text.includes('方块')) return '好的，开始画矩形'
  if (text.includes('线')) return '好的，开始画线'
  return '好的，开始绘制'
}

function fallbackCompletionSpeak(userText: string): string {
  const text = userText.trim()
  if (text.includes('马')) return '马已经画好了'
  if (text.includes('跑车') || text.includes('车')) return '车已经画好了'
  if (text.includes('猫')) return '猫已经画好了'
  if (text.includes('狗')) return '狗已经画好了'
  if (text.includes('房子') || text.includes('屋')) return '房子已经画好了'
  if (text.includes('树')) return '树已经画好了'
  if (text.includes('太阳')) return '太阳已经画好了'
  if (text.includes('星星') || text.includes('星')) return '星星已经画好了'
  if (text.includes('头像') || text.includes('人像')) return '头像已经画好了'
  if (text.includes('圆')) return '圆已经画好了'
  if (text.includes('矩形') || text.includes('方块')) return '矩形已经画好了'
  return '已经画好了'
}
