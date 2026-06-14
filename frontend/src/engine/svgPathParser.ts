import type { DrawAction, PointPair } from '../types/commands'



export const VIEWBOX_DEFAULT = { width: 100, height: 100 }

export const POINTS_PER_PATH = 30



export interface ParsedPath {

  points: PointPair[]

  closed: boolean

}



function commitSubpath(subpaths: ParsedPath[], points: PointPair[], closed: boolean): void {

  if (points.length >= 2) {

    subpaths.push({ points: [...points], closed })

  }

}



/** Parse SVG path d into independent subpaths (split on M/m moveto). */

export function parsePathDAll(d: string): ParsedPath[] {

  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? []

  const subpaths: ParsedPath[] = []

  let i = 0

  let cmd = ''

  let cx = 0

  let cy = 0

  let sx = 0

  let sy = 0

  let points: PointPair[] = []

  let closed = false



  const readNum = (): number => {

    const v = parseFloat(tokens[i++] ?? '0')

    return Number.isFinite(v) ? v : 0

  }



  const pushPoint = (x: number, y: number): void => {

    points.push([x, y])

    cx = x

    cy = y

  }



  const startSubpath = (x: number, y: number): void => {

    if (points.length >= 2) {

      commitSubpath(subpaths, points, closed)

    }

    points = []

    closed = false

    pushPoint(x, y)

    sx = cx

    sy = cy

  }



  while (i < tokens.length) {

    const t = tokens[i]

    if (/^[a-zA-Z]$/.test(t)) {

      cmd = t

      i++

    } else if (!cmd) {

      i++

      continue

    }



    const rel = cmd === cmd.toLowerCase()

    const c = cmd.toUpperCase()



    switch (c) {

      case 'M': {

        const x = readNum()

        const y = readNum()

        if (rel) startSubpath(cx + x, cy + y)

        else startSubpath(x, y)

        cmd = rel ? 'l' : 'L'

        break

      }

      case 'L': {

        const x = readNum()

        const y = readNum()

        if (rel) pushPoint(cx + x, cy + y)

        else pushPoint(x, y)

        break

      }

      case 'H': {

        const x = readNum()

        pushPoint(rel ? cx + x : x, cy)

        break

      }

      case 'V': {

        const y = readNum()

        pushPoint(cx, rel ? cy + y : y)

        break

      }

      case 'Z': {

        closed = true

        if (points.length >= 2) pushPoint(sx, sy)

        break

      }

      case 'A': {

        readNum()

        readNum()

        readNum()

        readNum()

        readNum()

        const x = readNum()

        const y = readNum()

        if (rel) pushPoint(cx + x, cy + y)

        else pushPoint(x, y)

        break

      }

      case 'C': {

        readNum()

        readNum()

        readNum()

        readNum()

        const x = readNum()

        const y = readNum()

        if (rel) pushPoint(cx + x, cy + y)

        else pushPoint(x, y)

        break

      }

      default:

        i++

    }

  }



  commitSubpath(subpaths, points, closed)

  return subpaths

}



/** Parse SVG path d — returns the longest subpath (legacy single-path API). */

export function parsePathD(d: string): ParsedPath {

  const subpaths = parsePathDAll(d)

  if (subpaths.length === 0) return { points: [], closed: false }

  return subpaths.reduce((best, cur) =>

    cur.points.length > best.points.length ? cur : best,

  )

}



export function samplePath(points: PointPair[], targetCount: number): PointPair[] {

  if (points.length <= 1) return points

  if (points.length <= targetCount) return points



  const segments: { len: number; from: PointPair; to: PointPair }[] = []

  let totalLen = 0

  for (let j = 1; j < points.length; j++) {

    const from = points[j - 1]

    const to = points[j]

    const len = Math.hypot(to[0] - from[0], to[1] - from[1])

    segments.push({ len, from, to })

    totalLen += len

  }

  if (totalLen === 0) return [points[0]]



  const result: PointPair[] = [points[0]]

  const step = totalLen / (targetCount - 1)

  let dist = step

  let segIdx = 0

  let segDist = segments[0]?.len ?? 0



  for (let n = 1; n < targetCount; n++) {

    while (segIdx < segments.length && dist > segDist) {

      dist -= segDist

      segIdx++

      segDist = segments[segIdx]?.len ?? 0

    }

    if (segIdx >= segments.length) {

      result.push(points[points.length - 1])

      continue

    }

    const seg = segments[segIdx]

    const t = seg.len > 0 ? dist / seg.len : 0

    result.push([

      seg.from[0] + (seg.to[0] - seg.from[0]) * t,

      seg.from[1] + (seg.to[1] - seg.from[1]) * t,

    ])

    dist += step

  }



  return result

}



export function parseViewBox(svgText: string): { width: number; height: number } {

  const match = svgText.match(/viewBox=["']([^"']+)["']/i)

  if (!match) return VIEWBOX_DEFAULT

  const parts = match[1].trim().split(/\s+/).map(Number)

  if (parts.length >= 4 && parts[2] > 0 && parts[3] > 0) {

    return { width: parts[2], height: parts[3] }

  }

  return VIEWBOX_DEFAULT

}



export function extractPathDs(svgText: string): string[] {

  const paths: string[] = []

  const re = /<path[^>]*\sd=["']([^"']+)["']/gi

  let m: RegExpExecArray | null

  while ((m = re.exec(svgText)) !== null) {

    paths.push(m[1])

  }

  return paths

}



export function transformPoints(

  points: PointPair[],

  x: number,

  y: number,

  scale: number,

  vbW: number,

  vbH: number,

): PointPair[] {

  return points.map(([px, py]) => [

    x + (px / vbW) * 100 * scale,

    y + (py / vbH) * 100 * scale,

  ])

}



export function svgToDrawPathActions(

  svgText: string,

  x: number,

  y: number,

  scale: number,

  color: string,

  animateMs?: number,

): DrawAction[] {

  const viewBox = parseViewBox(svgText)

  const pathDs = extractPathDs(svgText)

  const actions: DrawAction[] = []



  for (const d of pathDs) {

    for (const parsed of parsePathDAll(d)) {

      if (parsed.points.length < 2) continue

      const sampled = samplePath(parsed.points, POINTS_PER_PATH)

      const transformed = transformPoints(sampled, x, y, scale, viewBox.width, viewBox.height)

      actions.push({

        action: 'drawPath' as const,

        color,

        points: transformed,

        closed: parsed.closed,

        animateMs: animateMs ?? 800,

      })

    }

  }



  return actions

}


