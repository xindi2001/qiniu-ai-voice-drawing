import type { DrawAction } from '../types/commands'
import { svgToDrawPathActions } from './svgPathParser'

export function templateIconUrl(templateId: string): string {
  const base = import.meta.env.BASE_URL
  return `${base}icons/${templateId}.svg`
}

export async function loadTemplateActions(
  templateId: string,
  x: number,
  y: number,
  scale: number,
  color: string,
  animateMs?: number,
): Promise<DrawAction[]> {
  const res = await fetch(templateIconUrl(templateId))
  if (!res.ok) {
    throw new Error(`模板 ${templateId} 加载失败`)
  }
  const svgText = await res.text()
  const actions = svgToDrawPathActions(svgText, x, y, scale, color, animateMs)

  if (actions.length === 0) {
    throw new Error(`模板 ${templateId} 无可用路径`)
  }

  return actions
}

export const TEMPLATE_IDS = ['house', 'horse', 'tree', 'sun', 'star', 'triangle'] as const
export type TemplateId = (typeof TEMPLATE_IDS)[number]

export function isTemplateId(id: string): id is TemplateId {
  return (TEMPLATE_IDS as readonly string[]).includes(id)
}
