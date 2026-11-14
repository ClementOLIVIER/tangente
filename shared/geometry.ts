/**
 * Géométrie partagée. Le prédicat d'effacement est utilisé à l'identique par le
 * serveur (vérité) et l'écran hôte (redessin), d'où sa place ici.
 */

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** Distance² entre le point (px, py) et le segment [a, b]. */
export function pointSegDist2(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  let t = 0
  if (len2 > 1e-12) t = clamp01(((px - ax) * dx + (py - ay) * dy) / len2)
  const cx = ax + dx * t - px
  const cy = ay + dy * t - py
  return cx * cx + cy * cy
}

/**
 * Distance² minimale entre les segments [p1, q1] et [p2, q2] (Ericson,
 * Real-Time Collision Detection §5.1.9). Deux capsules de rayons r1, r2 se
 * touchent si cette valeur est < (r1 + r2)².
 */
export function segSegDist2(
  p1x: number,
  p1y: number,
  q1x: number,
  q1y: number,
  p2x: number,
  p2y: number,
  q2x: number,
  q2y: number,
): number {
  const d1x = q1x - p1x
  const d1y = q1y - p1y
  const d2x = q2x - p2x
  const d2y = q2y - p2y
  const rx = p1x - p2x
  const ry = p1y - p2y
  const a = d1x * d1x + d1y * d1y
  const e = d2x * d2x + d2y * d2y
  const f = d2x * rx + d2y * ry
  const EPS = 1e-12
  let s: number
  let t: number
  if (a <= EPS && e <= EPS) return rx * rx + ry * ry
  if (a <= EPS) {
    s = 0
    t = clamp01(f / e)
  } else {
    const c = d1x * rx + d1y * ry
    if (e <= EPS) {
      t = 0
      s = clamp01(-c / a)
    } else {
      const b = d1x * d2x + d1y * d2y
      const denom = a * e - b * b
      s = denom > EPS ? clamp01((b * f - c * e) / denom) : 0
      t = (b * s + f) / e
      if (t < 0) {
        t = 0
        s = clamp01(-c / a)
      } else if (t > 1) {
        t = 1
        s = clamp01((b - c) / a)
      }
    }
  }
  const cx = p1x + d1x * s - (p2x + d2x * t)
  const cy = p1y + d1y * s - (p2y + d2y * t)
  return cx * cx + cy * cy
}

/** Un segment de trace est supprimé par un effacement s'il passe dans le disque. */
export function segmentInEraseZone(
  cx: number,
  cy: number,
  radius: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): boolean {
  return pointSegDist2(cx, cy, x1, y1, x2, y2) <= radius * radius
}
