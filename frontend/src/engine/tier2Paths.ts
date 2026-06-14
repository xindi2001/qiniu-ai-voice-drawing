import type { PathItem, PointPair } from '../types/commands'



/** Approximate circle as polyline (Konva stroke). */

export function circlePoints(cx: number, cy: number, r: number, segments = 20): PointPair[] {

  const pts: PointPair[] = []

  for (let i = 0; i <= segments; i++) {

    const angle = -Math.PI / 2 + (i / segments) * Math.PI * 2

    pts.push([Math.round(cx + r * Math.cos(angle)), Math.round(cy + r * Math.sin(angle))])

  }

  return pts

}



/** Approximate ellipse as polyline. */

export function ellipsePoints(

  cx: number,

  cy: number,

  rx: number,

  ry: number,

  segments = 24,

): PointPair[] {

  const pts: PointPair[] = []

  for (let i = 0; i <= segments; i++) {

    const angle = -Math.PI / 2 + (i / segments) * Math.PI * 2

    pts.push([

      Math.round(cx + rx * Math.cos(angle)),

      Math.round(cy + ry * Math.sin(angle)),

    ])

  }

  return pts

}



/** Smile arc (open polyline). */

function smileArc(cx: number, cy: number, r: number, segments = 14): PointPair[] {

  const pts: PointPair[] = []

  const start = Math.PI * 0.15

  const end = Math.PI * 0.85

  for (let i = 0; i <= segments; i++) {

    const t = i / segments

    const angle = start + t * (end - start)

    pts.push([Math.round(cx + r * Math.cos(angle)), Math.round(cy + r * Math.sin(angle))])

  }

  return pts

}



/** Tier 2 fallback: simplified avatar / face sketch paths (canvas center ~480,300). */

export function simpleFacePathItems(color = '#1f2937'): PathItem[] {

  const cx = 480

  const cy = 300

  return [

    { points: ellipsePoints(cx, cy, 72, 88, 28), color },

    { points: circlePoints(cx - 28, cy - 18, 7, 10), color },

    { points: circlePoints(cx + 28, cy - 18, 7, 10), color },

    { points: smileArc(cx, cy + 22, 32, 12), color },

  ]

}





/** Tier 2 fallback: stick-figure person (head + body + limbs). */

export function stickPersonPathItems(color = '#1f2937'): PathItem[] {

  const cx = 480

  const headY = 220

  return [

    { points: circlePoints(cx, headY, 36, 20), color },

    { points: circlePoints(cx - 14, headY - 8, 5, 8), color },

    { points: circlePoints(cx + 14, headY - 8, 5, 8), color },

    { points: smileArc(cx, headY + 10, 16, 10), color },

    { points: [[cx, headY + 36], [cx, headY + 120]], color },

    { points: [[cx, headY + 60], [cx - 50, headY + 90]], color },

    { points: [[cx, headY + 60], [cx + 50, headY + 90]], color },

    { points: [[cx, headY + 120], [cx - 35, headY + 190]], color },

    { points: [[cx, headY + 120], [cx + 35, headY + 190]], color },

  ]

}

/** Tier 2 fallback: simple rose outline (stem + 2 petals). */

export function rosePathItems(
  petalColor = '#ef4444',
  stemColor = '#15803d',
): PathItem[] {
  const cx = 480
  const baseY = 420
  const bloomY = 260
  return [
    { points: [[cx, baseY], [cx, bloomY + 40]], color: stemColor },
    {
      points: [
        [cx, bloomY + 20], [cx - 38, bloomY - 10], [cx - 12, bloomY - 35],
        [cx + 12, bloomY - 35], [cx + 38, bloomY - 10], [cx, bloomY + 20],
      ],
      color: petalColor,
    },
    {
      points: [
        [cx, bloomY], [cx - 28, bloomY - 28], [cx, bloomY - 48],
        [cx + 28, bloomY - 28], [cx, bloomY],
      ],
      color: petalColor,
    },
  ]
}

export function horsePathItems(color = '#1f2937'): PathItem[] {
  const cx = 480
  const cy = 300
  return [
    { points: ellipsePoints(cx, cy, 95, 42, 20), color },
    { points: [[cx + 55, cy - 8], [cx + 78, cy - 42], [cx + 98, cy - 52]], color },
    { points: [[cx + 98, cy - 52], [cx + 108, cy - 58], [cx + 112, cy - 48]], color },
    { points: [[cx + 78, cy - 42], [cx + 88, cy - 18], [cx + 55, cy - 5]], color },
    { points: [[cx - 75, cy + 5], [cx - 95, cy + 18], [cx - 105, cy + 35]], color },
    { points: [[cx - 42, cy + 38], [cx - 42, cy + 95]], color },
    { points: [[cx - 18, cy + 38], [cx - 18, cy + 95]], color },
    { points: [[cx + 22, cy + 38], [cx + 22, cy + 95]], color },
    { points: [[cx + 48, cy + 38], [cx + 48, cy + 95]], color },
    { points: [[cx + 55, cy - 5], [cx + 62, cy + 12], [cx + 48, cy + 38]], color },
  ]
}

export function housePathItems(color = '#1f2937'): PathItem[] {
  const cx = 480
  const cy = 320
  const w = 100
  const h = 70
  const left = cx - w / 2
  const top = cy - h / 2
  const roofPeakY = top - 45
  const wallTop = top + 18
  return [
    {
      points: [[left, top + h], [left, wallTop], [left + w, wallTop], [left + w, top + h], [left, top + h]],
      color,
    },
    { points: [[left, wallTop], [cx, roofPeakY], [left + w, wallTop]], color },
    {
      points: [[cx - 14, top + h], [cx - 14, top + h - 32], [cx + 14, top + h - 32], [cx + 14, top + h], [cx - 14, top + h]],
      color,
    },
  ]
}

export function treePathItems(color = '#22c55e'): PathItem[] {
  const cx = 480
  const trunk = '#92400e'
  return [
    { points: [[cx - 5, 320], [cx + 5, 380]], color: trunk },
    { points: [[cx, 320], [cx - 50, 260], [cx, 200], [cx + 50, 260], [cx, 320]], color },
  ]
}

export function sunPathItems(color = '#eab308'): PathItem[] {
  const cx = 480
  const cy = 180
  const items: PathItem[] = [{ points: circlePoints(cx, cy, 35, 24), color }]
  for (let i = 0; i < 8; i++) {
    const angle = (-90 + i * 45) * (Math.PI / 180)
    const innerR = 45
    const outerR = 65
    items.push({
      points: [
        [Math.round(cx + innerR * Math.cos(angle)), Math.round(cy + innerR * Math.sin(angle))],
        [Math.round(cx + outerR * Math.cos(angle)), Math.round(cy + outerR * Math.sin(angle))],
      ],
      color,
    })
  }
  return items
}

export function starPathItems(color = '#6366f1'): PathItem[] {
  const cx = 480
  const cy = 300
  const r = 50
  const pts: PointPair[] = []
  for (let i = 0; i < 5; i++) {
    const outerAngle = (-90 + i * 72) * (Math.PI / 180)
    const innerAngle = (-90 + i * 72 + 36) * (Math.PI / 180)
    pts.push([Math.round(cx + r * Math.cos(outerAngle)), Math.round(cy + r * Math.sin(outerAngle))])
    pts.push([Math.round(cx + r * 0.4 * Math.cos(innerAngle)), Math.round(cy + r * 0.4 * Math.sin(innerAngle))])
  }
  pts.push(pts[0])
  return [{ points: pts, color }]
}

export function simpleCatPathItems(color = '#1f2937'): PathItem[] {
  return [
    { points: [[280, 300], [420, 300]], color },
    { points: [[350, 300], [350, 240], [380, 210]], color },
    { points: [[360, 210], [350, 190], [370, 200]], color },
    { points: [[380, 210], [395, 190], [390, 205]], color },
    { points: [[300, 300], [300, 340]], color },
    { points: [[400, 300], [400, 340]], color },
  ]
}

export function simpleDogPathItems(color = '#1f2937'): PathItem[] {
  return [
    { points: [[260, 300], [440, 300]], color },
    { points: [[440, 300], [480, 260], [500, 270]], color },
    { points: [[320, 300], [320, 230], [360, 210]], color },
    { points: [[280, 300], [280, 350]], color },
    { points: [[400, 300], [400, 350]], color },
  ]
}

/** Resolve tier-2 fallback pathItems from Wanx imagePrompt or user text. */
export function resolvePathItemsFromPrompt(prompt: string, color = '#1f2937'): PathItem[] {
  const text = prompt ?? ''
  if (text.includes('马')) return horsePathItems(color)
  if (text.includes('房子') || text.includes('屋')) return housePathItems(color)
  if (text.includes('树')) return treePathItems(color)
  if (text.includes('太阳')) return sunPathItems(color)
  if (text.includes('星')) return starPathItems(color)
  if (text.includes('猫')) return simpleCatPathItems(color)
  if (text.includes('狗')) return simpleDogPathItems(color)
  if (text.includes('鸟')) {
    const cx = 480
    const cy = 280
    return [
      { points: [[cx - 40, cy], [cx + 40, cy]], color },
      { points: [[cx - 40, cy], [cx - 55, cy - 25], [cx - 20, cy - 15]], color },
      { points: [[cx, cy], [cx, cy + 35]], color },
    ]
  }
  if (text.includes('车')) {
    return [
      { points: [[180, 310], [520, 310]], color },
      { points: [[180, 310], [200, 275], [280, 255], [400, 250], [490, 265], [520, 295]], color },
      { points: [[260, 310], [260, 338]], color: '#1f2937' },
      { points: [[440, 310], [440, 338]], color: '#1f2937' },
    ]
  }
  if (text.includes('玫瑰') || text.includes('花')) return rosePathItems(color, '#15803d')
  if (text.includes('头像') || text.includes('动漫') || text.includes('人脸')) return simpleFacePathItems(color)
  if (text.includes('人')) return stickPersonPathItems(color)
  return horsePathItems(color)
}



export function clampPathItems(

  items: PathItem[],

  canvasW: number,

  canvasH: number,

  maxPaths = 12,

): PathItem[] {

  const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v))

  return items.slice(0, maxPaths).map((item) => ({

    ...item,

    points: item.points.map(([x, y]) => [

      clamp(Math.round(x), canvasW),

      clamp(Math.round(y), canvasH),

    ]),

  }))

}

