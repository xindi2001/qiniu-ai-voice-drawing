import type { DrawAction } from '../types/commands'
import { svgToDrawPathActions } from './svgPathParser'

const ICONIFY_BASE = 'https://api.iconify.design'

const API_BASE = import.meta.env.VITE_API_BASE ?? (import.meta.env.DEV ? '' : '')

/** Convert mdi:horse → mdi/horse for Iconify API. */
export function iconifyUrl(iconId: string): string {
  const normalized = iconId.replace(':', '/')
  return `${ICONIFY_BASE}/${normalized}.svg`
}

export function iconProxyUrl(iconId: string): string {
  return `${API_BASE}/api/v1/icons/${encodeURIComponent(iconId)}`
}

async function fetchIconSvg(iconId: string): Promise<string> {
  try {
    const res = await fetch(iconifyUrl(iconId))
    if (res.ok) return res.text()
  } catch {
    /* CORS or network — fall through to backend proxy */
  }

  const proxyRes = await fetch(iconProxyUrl(iconId))
  if (!proxyRes.ok) {
    throw new Error(`图标 ${iconId} 加载失败`)
  }
  return proxyRes.text()
}

export async function loadIconActions(
  iconId: string,
  x: number,
  y: number,
  scale: number,
  color: string,
  animateMs?: number,
): Promise<DrawAction[]> {
  const svgText = await fetchIconSvg(iconId)
  const actions = svgToDrawPathActions(svgText, x, y, scale, color, animateMs)

  if (actions.length === 0) {
    throw new Error(`图标 ${iconId} 无可用路径`)
  }

  return actions
}

/** Map Chinese keywords to Iconify iconId (for docs / tests). */
export const ICON_MAP: Record<string, string> = {
  马: 'mdi:horse',
  房子: 'mdi:home',
  房屋: 'mdi:home',
  树: 'mdi:tree',
  太阳: 'mdi:weather-sunny',
  星星: 'mdi:star',
  猫: 'mdi:cat',
  狗: 'mdi:dog',
  车: 'mdi:car',
  跑车: 'mdi:car-sports',
  玫瑰: 'mdi:flower',
  花: 'mdi:flower',
  人: 'mdi:human',
}

export function isValidIconId(iconId: string): boolean {
  return /^[a-z0-9-]+:[a-z0-9-]+$/i.test(iconId)
}
