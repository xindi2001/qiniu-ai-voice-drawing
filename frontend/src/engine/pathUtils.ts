import type { PointPair } from '../types/commands'

/** Total polyline length from flat [x1,y1,x2,y2,...] coordinates. */
export function computePathLength(points: number[]): number {
  if (points.length < 4) return 0
  let len = 0
  for (let i = 2; i < points.length; i += 2) {
    len += Math.hypot(points[i] - points[i - 2], points[i + 1] - points[i - 1])
  }
  return len
}

export interface FlatBbox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export function flatToPairs(flat: number[]): PointPair[] {
  const pairs: PointPair[] = []
  for (let i = 0; i + 1 < flat.length; i += 2) {
    pairs.push([flat[i], flat[i + 1]])
  }
  return pairs
}

export function pairsToFlat(pairs: PointPair[]): number[] {
  return pairs.flat()
}

export function bboxFromFlat(flat: number[]): FlatBbox {
  const xs = flat.filter((_, i) => i % 2 === 0)
  const ys = flat.filter((_, i) => i % 2 === 1)
  if (!xs.length || !ys.length) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  }
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  }
}

const ORIGIN_EPS = 6

function nearOrigin(x: number, y: number): boolean {
  return Math.abs(x) <= ORIGIN_EPS && Math.abs(y) <= ORIGIN_EPS
}

/** Drop a spurious first segment that jumps from (0,0) to a distant point. */
export function trimOriginJump(flat: number[]): number[] {
  if (flat.length < 6) return flat
  const x0 = flat[0]
  const y0 = flat[1]
  const x1 = flat[2]
  const y1 = flat[3]
  if (nearOrigin(x0, y0) && !nearOrigin(x1, y1)) {
    const jump = Math.hypot(x1 - x0, y1 - y0)
    if (jump > 40) return flat.slice(2)
  }
  return flat
}

/** Remove segments that connect (0,0) to a far-away point (Konva connector artifacts). */
export function removeOriginConnectorSegments(flat: number[]): number[] {
  if (flat.length < 4) return flat

  const segments: number[][] = []
  let current: number[] = [flat[0], flat[1]]

  for (let i = 2; i < flat.length; i += 2) {
    const x0 = current[current.length - 2]
    const y0 = current[current.length - 1]
    const x1 = flat[i]
    const y1 = flat[i + 1]
    const isConnector =
      (nearOrigin(x0, y0) && !nearOrigin(x1, y1) && Math.hypot(x1 - x0, y1 - y0) > 40)
      || (nearOrigin(x1, y1) && !nearOrigin(x0, y0) && Math.hypot(x1 - x0, y1 - y0) > 40)

    if (isConnector) {
      if (current.length >= 4) segments.push(current)
      current = nearOrigin(x1, y1) ? [] : [x1, y1]
    } else if (current.length === 0) {
      current = [x1, y1]
    } else {
      current.push(x1, y1)
    }
  }

  if (current.length >= 4) segments.push(current)
  if (segments.length === 0) return flat.length >= 4 ? flat : []
  if (segments.length === 1) return segments[0]
  return segments.reduce((a, b) => (a.length >= b.length ? a : b))
}

export function coversMostOfCanvas(
  bbox: FlatBbox,
  canvasW: number,
  canvasH: number,
  ratio = 0.8,
): boolean {
  const w = bbox.maxX - bbox.minX
  const h = bbox.maxY - bbox.minY
  return w / canvasW >= ratio && h / canvasH >= ratio
}

export function isCanvasBorderArtifact(
  flat: number[],
  canvasW: number,
  canvasH: number,
): boolean {
  if (flat.length < 4) return true
  const bbox = bboxFromFlat(flat)
  const w = bbox.maxX - bbox.minX
  const h = bbox.maxY - bbox.minY

  if (coversMostOfCanvas(bbox, canvasW, canvasH)) return true

  // Top-left corner border traces (two edges meeting at origin)
  if (bbox.minX <= ORIGIN_EPS && bbox.minY <= ORIGIN_EPS) {
    if (bbox.maxX >= canvasW * 0.85 || bbox.maxY >= canvasH * 0.85) return true
    if (w >= canvasW * 0.7 && h <= 8) return true
    if (h >= canvasH * 0.7 && w <= 8) return true
  }

  // Full-canvas diagonal bridge
  const diag = Math.hypot(w, h)
  const canvasDiag = Math.hypot(canvasW, canvasH)
  const pointCount = flat.length / 2
  if (diag >= canvasDiag * 0.82 && pointCount <= 4) return true

  const edgeMargin = Math.max(4, Math.min(canvasW, canvasH) * 0.012)
  const touchesLeft = bbox.minX <= edgeMargin
  const touchesRight = bbox.maxX >= canvasW - edgeMargin
  const touchesTop = bbox.minY <= edgeMargin
  const touchesBottom = bbox.maxY >= canvasH - edgeMargin

  // Stray vertical/horizontal strokes glued to canvas edges (Sobel / crop artifacts).
  if ((touchesLeft || touchesRight) && h >= canvasH * 0.22 && w <= canvasW * 0.06) return true
  if ((touchesTop || touchesBottom) && w >= canvasW * 0.22 && h <= canvasH * 0.06) return true

  let edgePts = 0
  for (let i = 0; i < flat.length; i += 2) {
    const x = flat[i]
    const y = flat[i + 1]
    if (
      x <= edgeMargin || x >= canvasW - edgeMargin
      || y <= edgeMargin || y >= canvasH - edgeMargin
    ) {
      edgePts++
    }
  }
  const edgeFrac = edgePts / (flat.length / 2)
  if (edgeFrac >= 0.85 && pointCount >= 3 && diag < canvasDiag * 0.55) return true

  return false
}

/** Split a polyline at segments longer than maxLen (removes bridge lines). */
export function splitAtLongSegments(flat: number[], maxLen: number): number[][] {
  if (flat.length < 4) return flat.length >= 4 ? [flat] : []

  const chunks: number[][] = []
  let current: number[] = [flat[0], flat[1]]

  for (let i = 2; i < flat.length; i += 2) {
    const x0 = current[current.length - 2]
    const y0 = current[current.length - 1]
    const x1 = flat[i]
    const y1 = flat[i + 1]
    const segLen = Math.hypot(x1 - x0, y1 - y0)

    if (segLen > maxLen && current.length >= 4) {
      chunks.push(current)
      current = [x1, y1]
    } else {
      current.push(x1, y1)
    }
  }

  if (current.length >= 4) chunks.push(current)
  else if (current.length === 2 && chunks.length > 0) {
    chunks[chunks.length - 1].push(current[0], current[1])
  } else if (current.length >= 4 || (current.length === 2 && chunks.length === 0 && flat.length === 4)) {
    chunks.push(current)
  }

  return chunks.length > 0 ? chunks : [flat]
}

export interface SanitizePathOptions {
  canvasW?: number
  canvasH?: number
  maxSegmentLen?: number
}

/** Clean flat path coords: trim origin jumps, drop border/bridge artifacts, split long segments. */
export function sanitizeFlatPath(
  flat: number[],
  opts: SanitizePathOptions = {},
): number[][] {
  if (flat.length < 4) return []

  let cleaned = trimOriginJump(flat)
  cleaned = removeOriginConnectorSegments(cleaned)
  if (cleaned.length < 4) return []

  const { canvasW, canvasH, maxSegmentLen } = opts
  if (canvasW && canvasH && isCanvasBorderArtifact(cleaned, canvasW, canvasH)) {
    return []
  }

  const maxLen = maxSegmentLen ?? (canvasW && canvasH ? Math.hypot(canvasW, canvasH) * 0.55 : Infinity)
  const chunks = Number.isFinite(maxLen) ? splitAtLongSegments(cleaned, maxLen) : [cleaned]

  return chunks.filter((chunk) => {
    if (chunk.length < 4) return false
    if (canvasW && canvasH && isCanvasBorderArtifact(chunk, canvasW, canvasH)) return false
    return true
  })
}
