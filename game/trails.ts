import { segSegDist2, segmentInEraseZone, pointSegDist2 } from '../shared/geometry'

/**
 * Traces de la manche : segments (capsules) stockés en tableaux typés, indexés
 * par une grille uniforme. Un segment par tick et par tête qui dessine
 * (≈ 1,25 unité à 150 u/s) : une case de 24 unités en contient quelques dizaines.
 *
 * Les segments effacés restent dans les cases mais sont marqués morts
 * (suppression paresseuse, filtrée à la lecture).
 */
export class TrailStore {
  readonly cellSize: number
  readonly cols: number
  readonly rows: number
  private cells: number[][]
  private stamp: Uint32Array
  private queryId = 0

  x1 = new Float64Array(4096)
  y1 = new Float64Array(4096)
  x2 = new Float64Array(4096)
  y2 = new Float64Array(4096)
  r = new Float64Array(4096)
  /** Distance parcourue par le propriétaire à la fin du segment. */
  dist = new Float64Array(4096)
  owner = new Int16Array(4096)
  alive = new Uint8Array(4096)
  count = 0
  /** Plus grand rayon ajouté : marge des requêtes. */
  maxR = 0

  constructor(
    readonly w: number,
    readonly h: number,
    cellSize = 24,
  ) {
    this.cellSize = cellSize
    this.cols = Math.ceil(w / cellSize) + 1
    this.rows = Math.ceil(h / cellSize) + 1
    this.cells = Array.from({ length: this.cols * this.rows }, () => [])
    this.stamp = new Uint32Array(4096)
  }

  private grow(): void {
    const cap = this.x1.length * 2
    const g = <T extends Float64Array | Int16Array | Uint8Array | Uint32Array>(a: T): T => {
      const n = new (a.constructor as new (n: number) => T)(cap)
      n.set(a)
      return n
    }
    this.x1 = g(this.x1)
    this.y1 = g(this.y1)
    this.x2 = g(this.x2)
    this.y2 = g(this.y2)
    this.r = g(this.r)
    this.dist = g(this.dist)
    this.owner = g(this.owner)
    this.alive = g(this.alive)
    this.stamp = g(this.stamp)
  }

  private cellRange(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
  ): [number, number, number, number] {
    const cs = this.cellSize
    const c0 = Math.max(0, Math.floor(minX / cs))
    const r0 = Math.max(0, Math.floor(minY / cs))
    const c1 = Math.min(this.cols - 1, Math.floor(maxX / cs))
    const r1 = Math.min(this.rows - 1, Math.floor(maxY / cs))
    return [c0, r0, c1, r1]
  }

  add(
    owner: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    r: number,
    dist: number,
  ): number {
    if (this.count === this.x1.length) this.grow()
    const id = this.count++
    this.x1[id] = x1
    this.y1[id] = y1
    this.x2[id] = x2
    this.y2[id] = y2
    this.r[id] = r
    this.dist[id] = dist
    this.owner[id] = owner
    this.alive[id] = 1
    if (r > this.maxR) this.maxR = r
    const [c0, r0, c1, r1] = this.cellRange(
      Math.min(x1, x2) - r,
      Math.min(y1, y2) - r,
      Math.max(x1, x2) + r,
      Math.max(y1, y2) + r,
    )
    for (let row = r0; row <= r1; row++)
      for (let col = c0; col <= c1; col++) this.cells[row * this.cols + col]!.push(id)
    return id
  }

  /** Appelle `fn` une fois par segment vivant dont la case recoupe la boîte. */
  private forEachNear(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    fn: (id: number) => boolean | void,
  ): boolean {
    const qid = ++this.queryId
    if (qid === 0xffffffff) {
      this.stamp.fill(0)
      this.queryId = 1
    }
    const [c0, r0, c1, r1] = this.cellRange(minX, minY, maxX, maxY)
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const cell = this.cells[row * this.cols + col]!
        for (let k = 0; k < cell.length; k++) {
          const id = cell[k]!
          if (this.stamp[id] === this.queryId || !this.alive[id]) continue
          this.stamp[id] = this.queryId
          if (fn(id) === true) return true
        }
      }
    }
    return false
  }

  /**
   * Le déplacement de la tête (capsule [a, b] de rayon `r`) touche-t-il une trace ?
   * Les segments du même propriétaire posés il y a moins de `selfIgnore` unités
   * de parcours sont ignorés (la trace immédiatement derrière la tête).
   * Renvoie l'id du segment touché, ou -1.
   */
  hit(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    r: number,
    owner: number,
    ownerDist: number,
    selfIgnore: number,
  ): number {
    const m = r + this.maxR
    let found = -1
    this.forEachNear(
      Math.min(ax, bx) - m,
      Math.min(ay, by) - m,
      Math.max(ax, bx) + m,
      Math.max(ay, by) + m,
      id => {
        if (this.owner[id] === owner && ownerDist - this.dist[id]! < selfIgnore) return
        const rr = r + this.r[id]!
        if (
          segSegDist2(ax, ay, bx, by, this.x1[id]!, this.y1[id]!, this.x2[id]!, this.y2[id]!) <
          rr * rr
        ) {
          found = id
          return true
        }
      },
    )
    return found
  }

  /** Plus petite distance (bord à bord) d'un point à une trace, plafonnée à `maxD`. */
  clearance(x: number, y: number, maxD: number): number {
    let best = maxD
    const m = maxD + this.maxR
    this.forEachNear(x - m, y - m, x + m, y + m, id => {
      const d =
        Math.sqrt(pointSegDist2(x, y, this.x1[id]!, this.y1[id]!, this.x2[id]!, this.y2[id]!)) -
        this.r[id]!
      if (d < best) best = d
    })
    return Math.max(0, best)
  }

  /** Supprime les segments qui passent dans le disque ; renvoie le nombre supprimé. */
  erase(cx: number, cy: number, radius: number): number {
    let n = 0
    const m = radius + this.maxR
    this.forEachNear(cx - m, cy - m, cx + m, cy + m, id => {
      if (
        segmentInEraseZone(cx, cy, radius, this.x1[id]!, this.y1[id]!, this.x2[id]!, this.y2[id]!)
      ) {
        this.alive[id] = 0
        n++
      }
    })
    return n
  }

  liveCount(): number {
    let n = 0
    for (let i = 0; i < this.count; i++) n += this.alive[i]!
    return n
  }

  /**
   * Polylignes compactes pour (ré)hydrater un écran : segments contigus d'un même
   * propriétaire et d'une même épaisseur fusionnés, points espacés d'au moins
   * `minStep` unités (flèche de corde négligeable pour les rayons de virage du jeu).
   * Format : `[owner, width, n, x0, y0, …, xn-1, yn-1]` concaténés.
   */
  toStrokes(minStep = 3): number[] {
    const out: number[] = []
    const lastByOwner = new Map<
      number,
      { x: number; y: number; w: number; start: number; kx: number; ky: number }
    >()
    const round = (v: number) => Math.round(v * 100) / 100
    const flush = (owner: number) => {
      const s = lastByOwner.get(owner)
      if (!s) return
      // force le dernier point
      const n = out[s.start + 2]!
      const lx = out[s.start + 3 + (n - 1) * 2]
      const ly = out[s.start + 3 + (n - 1) * 2 + 1]
      if (lx !== round(s.x) || ly !== round(s.y)) {
        out.push(round(s.x), round(s.y))
        out[s.start + 2] = n + 1
      }
      lastByOwner.delete(owner)
    }
    for (let id = 0; id < this.count; id++) {
      if (!this.alive[id]) continue
      const o = this.owner[id]!
      const w = this.r[id]! * 2
      const s = lastByOwner.get(o)
      const contiguous = s && s.w === w && s.x === this.x1[id] && s.y === this.y1[id]
      if (!contiguous) {
        flush(o)
        const start = out.length
        out.push(o, round(w), 1, round(this.x1[id]!), round(this.y1[id]!))
        lastByOwner.set(o, {
          x: this.x2[id]!,
          y: this.y2[id]!,
          w,
          start,
          kx: this.x1[id]!,
          ky: this.y1[id]!,
        })
        continue
      }
      s.x = this.x2[id]!
      s.y = this.y2[id]!
      const dx = s.x - s.kx
      const dy = s.y - s.ky
      if (dx * dx + dy * dy >= minStep * minStep) {
        out.push(round(s.x), round(s.y))
        out[s.start + 2]!++
        s.kx = s.x
        s.ky = s.y
      }
    }
    for (const o of [...lastByOwner.keys()]) flush(o)
    return out
  }
}
