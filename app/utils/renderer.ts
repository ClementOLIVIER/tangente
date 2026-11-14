import { BONUS_RADIUS, FLAG, FRAME_STRIDE, colorHex } from '../../shared/constants'
import { segmentInEraseZone } from '../../shared/geometry'
import type { BonusItem, Frame, RoundStart } from '../../shared/protocol'
import { BONUS_DEFS, type BonusKind } from '../../shared/rules'

/**
 * Rendu de l'arène :
 * - `trail` (hors écran) : traces, dessinées incrémentalement (un segment par
 *   tick et par tête) et jamais effacées, sauf redessin complet
 *   (redimensionnement, effacement, réhydratation) ;
 * - `view` (seul canvas visible) : copie des traces + têtes, bonus, effets.
 *
 * Le canvas visible est demandé en mode `desynchronized` (« low latency
 * canvas ») : là où le navigateur le permet, ce qui est dessiné part à l'écran
 * sans attendre le compositeur. Dans ce cas l'écran hôte dessine dès qu'une
 * trame arrive au lieu d'attendre la prochaine image (`lowLatency`).
 *
 * Aucune interpolation : l'écran affiche le dernier tick reçu (le serveur est
 * sur la même machine, la gigue réseau hôte est négligeable). C'est le choix qui
 * minimise le délai appui → écran.
 */

interface Fx {
  x: number
  y: number
  color: string
  t0: number
  kind: 'death' | 'take' | 'shield'
}

const TONE_FILL: Record<string, string> = { good: '#1d7a3c', bad: '#a32020', neutral: '#2558a8' }
const GLYPH: Record<BonusKind, string> = {
  speedUp: '»',
  slowDown: '«',
  thin: '—',
  thick: '▬',
  shield: '◎',
  ghost: '◌',
  invert: '⇄',
  erase: '✕',
  fastTurn: '↻',
  chaos: '?',
}

export interface LatencySample {
  idx: number
  /** Arrivée de la commande au serveur → image où elle est visible (ms). */
  ms: number
  /** Toucher (horloge du téléphone synchronisée) → image (ms), si connu. */
  touchMs: number | null
}

export class ArenaRenderer {
  readonly trail: HTMLCanvasElement
  readonly view: HTMLCanvasElement
  private tctx: CanvasRenderingContext2D
  private octx: CanvasRenderingContext2D
  /** Le navigateur a accordé un canvas basse latence (hors compositeur). */
  readonly lowLatency: boolean
  arena = { w: 1200, h: 900 }
  private scale = 1
  private dpr = 1
  colors: string[] = []
  names: string[] = []
  heads = new Float64Array(0)
  private prev = new Float64Array(0)
  private bonuses = new Map<number, BonusItem>()
  private fx: Fx[] = []
  // segments retenus pour les redessins : owner, width, x1, y1, x2, y2
  private segs = new Float32Array(6 * 16384)
  private segAlive = new Uint8Array(16384)
  private segCount = 0
  private pendingMarks: number[] = []
  /** Mesures arrivée serveur → rendu, consommées par le panneau de diagnostic. */
  latency: LatencySample[] = []
  framesReceived = 0
  showArrows = false
  hasRound = false

  constructor(view: HTMLCanvasElement) {
    this.view = view
    this.trail = document.createElement('canvas')
    this.tctx = this.trail.getContext('2d', { alpha: false })!
    this.octx = view.getContext('2d', { alpha: false, desynchronized: true })!
    this.lowLatency = this.octx.getContextAttributes?.().desynchronized === true
  }

  /** Ajuste la résolution des canvas à la taille CSS × devicePixelRatio. */
  resize(cssW: number, cssH: number, dpr: number): void {
    this.dpr = dpr
    const pw = Math.max(1, Math.round(cssW * dpr))
    const ph = Math.max(1, Math.round(cssH * dpr))
    for (const c of [this.trail, this.view]) {
      c.width = pw
      c.height = ph
    }
    this.view.style.width = `${cssW}px`
    this.view.style.height = `${cssH}px`
    this.scale = pw / this.arena.w
    this.redrawTrails()
  }

  /** Rapport largeur/hauteur de l'arène (pour dimensionner le conteneur). */
  get aspect(): number {
    return this.arena.w / this.arena.h
  }

  setRound(rs: RoundStart): void {
    this.arena = rs.arena
    this.colors = rs.players.map(p => colorHex(p.color))
    this.names = rs.players.map(p => p.name)
    this.heads = Float64Array.from(rs.p)
    this.prev = Float64Array.from(rs.p)
    this.bonuses = new Map(rs.bonuses.map(b => [b.id, b]))
    this.fx = []
    this.segCount = 0
    this.pendingMarks = []
    this.hasRound = true
    // polylignes de réhydratation → segments
    const s = rs.strokes
    let k = 0
    while (k < s.length) {
      const owner = s[k]!
      const w = s[k + 1]!
      const n = s[k + 2]!
      for (let j = 1; j < n; j++) {
        const o = k + 3 + j * 2
        this.pushSeg(owner, w, s[o - 2]!, s[o - 1]!, s[o]!, s[o + 1]!)
      }
      k += 3 + n * 2
    }
    this.scale = this.trail.width / this.arena.w
    this.redrawTrails()
  }

  private pushSeg(owner: number, w: number, x1: number, y1: number, x2: number, y2: number): void {
    if (this.segCount * 6 >= this.segs.length) {
      const segs = new Float32Array(this.segs.length * 2)
      segs.set(this.segs)
      this.segs = segs
      const alive = new Uint8Array(this.segAlive.length * 2)
      alive.set(this.segAlive)
      this.segAlive = alive
    }
    const o = this.segCount * 6
    this.segs[o] = owner
    this.segs[o + 1] = w
    this.segs[o + 2] = x1
    this.segs[o + 3] = y1
    this.segs[o + 4] = x2
    this.segs[o + 5] = y2
    this.segAlive[this.segCount] = 1
    this.segCount++
  }

  private lineWidth(w: number): number {
    return Math.max(1.25 * this.dpr, w * this.scale)
  }

  /** Applique une trame : nouveaux segments dessinés tout de suite, événements. */
  pushFrame(f: Frame, now: number): void {
    this.framesReceived++
    const p = f.p
    const n = Math.min(this.colors.length, p.length / FRAME_STRIDE)
    const ctx = this.tctx
    const s = this.scale
    ctx.lineCap = 'round'
    for (let i = 0; i < n; i++) {
      const o = i * FRAME_STRIDE
      const x = p[o]!
      const y = p[o + 1]!
      if (p[o + 4]! & FLAG.DRAW) {
        const px = this.prev[o]!
        const py = this.prev[o + 1]!
        const w = p[o + 3]!
        this.pushSeg(i, w, px, py, x, y)
        ctx.strokeStyle = this.colors[i]!
        ctx.lineWidth = this.lineWidth(w)
        ctx.beginPath()
        ctx.moveTo(px * s, py * s)
        ctx.lineTo(x * s, y * s)
        ctx.stroke()
      }
    }
    this.prev.set(p.length === this.prev.length ? p : this.prev)
    this.heads.set(p.length === this.heads.length ? p : this.heads)
    if (f.ev) {
      for (const e of f.ev) {
        switch (e.e) {
          case 'death':
            this.fx.push({
              x: e.x,
              y: e.y,
              color: this.colors[e.i] ?? '#fff',
              t0: now,
              kind: 'death',
            })
            break
          case 'spawn':
            this.bonuses.set(e.b.id, e.b)
            break
          case 'take': {
            const b = this.bonuses.get(e.id)
            if (b)
              this.fx.push({
                x: b.x,
                y: b.y,
                color: TONE_FILL[BONUS_DEFS[b.kind].tone]!,
                t0: now,
                kind: 'take',
              })
            this.bonuses.delete(e.id)
            break
          }
          case 'erase':
            this.erase(e.x, e.y, e.r)
            break
          case 'shield': {
            const o = e.i * FRAME_STRIDE
            this.fx.push({
              x: this.heads[o]!,
              y: this.heads[o + 1]!,
              color: '#ffffff',
              t0: now,
              kind: 'shield',
            })
            break
          }
        }
      }
    }
    if (f.in)
      for (let k = 0; k + 2 < f.in.length; k += 3)
        this.pendingMarks.push(f.in[k]!, f.in[k + 1]!, f.in[k + 2]!)
  }

  private erase(cx: number, cy: number, r: number): void {
    for (let i = 0; i < this.segCount; i++) {
      if (!this.segAlive[i]) continue
      const o = i * 6
      if (
        segmentInEraseZone(
          cx,
          cy,
          r,
          this.segs[o + 2]!,
          this.segs[o + 3]!,
          this.segs[o + 4]!,
          this.segs[o + 5]!,
        )
      )
        this.segAlive[i] = 0
    }
    this.redrawTrails()
  }

  /** Redessin complet : un chemin par (joueur, épaisseur) pour limiter les appels. */
  redrawTrails(): void {
    const ctx = this.tctx
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, this.trail.width, this.trail.height)
    if (!this.segCount) return
    const s = this.scale
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const groups = new Map<string, number[]>()
    for (let i = 0; i < this.segCount; i++) {
      if (!this.segAlive[i]) continue
      const key = `${this.segs[i * 6]}|${this.segs[i * 6 + 1]}`
      let g = groups.get(key)
      if (!g) groups.set(key, (g = []))
      g.push(i)
    }
    for (const [key, ids] of groups) {
      const [owner, w] = key.split('|').map(Number) as [number, number]
      ctx.strokeStyle = this.colors[owner] ?? '#fff'
      ctx.lineWidth = this.lineWidth(w)
      ctx.beginPath()
      let lx = NaN
      let ly = NaN
      for (const i of ids) {
        const o = i * 6
        const x1 = this.segs[o + 2]!
        const y1 = this.segs[o + 3]!
        if (x1 !== lx || y1 !== ly) ctx.moveTo(x1 * s, y1 * s)
        lx = this.segs[o + 4]!
        ly = this.segs[o + 5]!
        ctx.lineTo(lx * s, ly * s)
      }
      ctx.stroke()
    }
  }

  /** Image : têtes, bonus, effets ; puis mesure des latences des commandes affichées. */
  render(now: number, wallNow: number): void {
    const ctx = this.octx
    const s = this.scale
    // les traces (déjà dessinées hors écran) puis les éléments mobiles par-dessus
    ctx.drawImage(this.trail, 0, 0)
    if (!this.hasRound) return

    // bonus
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const br = BONUS_RADIUS * s
    ctx.font = `bold ${Math.round(br * 1.25)}px system-ui, sans-serif`
    for (const b of this.bonuses.values()) {
      const pulse = 1 + 0.06 * Math.sin(now / 180 + b.id)
      ctx.fillStyle = TONE_FILL[BONUS_DEFS[b.kind].tone]!
      ctx.beginPath()
      ctx.arc(b.x * s, b.y * s, br * pulse, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#fff'
      ctx.fillText(GLYPH[b.kind], b.x * s, b.y * s + br * 0.06)
    }

    // têtes
    const n = this.colors.length
    for (let i = 0; i < n; i++) {
      const o = i * FRAME_STRIDE
      const flags = this.heads[o + 4]!
      const x = this.heads[o]! * s
      const y = this.heads[o + 1]! * s
      const r = Math.max(2.4 * this.dpr, (this.heads[o + 3]! / 2) * s * 1.15)
      const alive = flags & FLAG.ALIVE
      if (!alive && !this.showArrows) continue
      ctx.globalAlpha = flags & FLAG.GHOST ? 0.45 : 1
      ctx.fillStyle = this.colors[i]!
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()
      // cœur clair : distingue la tête de la trace, surtout pendant un trou
      ctx.fillStyle = '#fff'
      ctx.globalAlpha *= 0.55
      ctx.beginPath()
      ctx.arc(x, y, r * 0.45, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalAlpha = 1
      if (flags & (FLAG.SHIELD | FLAG.IMMUNE)) {
        ctx.strokeStyle = flags & FLAG.IMMUNE ? '#ffffffaa' : '#ffffff'
        ctx.lineWidth = 1.5 * this.dpr
        ctx.beginPath()
        ctx.arc(x, y, r + 4 * this.dpr, 0, Math.PI * 2)
        ctx.stroke()
      }
      if (flags & FLAG.INVERT) {
        ctx.strokeStyle = '#ff4fc3'
        ctx.lineWidth = 1.5 * this.dpr
        ctx.setLineDash([3 * this.dpr, 3 * this.dpr])
        ctx.beginPath()
        ctx.arc(x, y, r + 8 * this.dpr, 0, Math.PI * 2)
        ctx.stroke()
        ctx.setLineDash([])
      }
      if (this.showArrows) {
        // compte à rebours : direction de départ et pseudo de chacun
        const a = this.heads[o + 2]!
        const len = 46 * s
        ctx.strokeStyle = this.colors[i]!
        ctx.lineWidth = 2 * this.dpr
        ctx.beginPath()
        ctx.moveTo(x + Math.cos(a) * (r + 4), y + Math.sin(a) * (r + 4))
        const tx = x + Math.cos(a) * len
        const ty = y + Math.sin(a) * len
        ctx.lineTo(tx, ty)
        ctx.lineTo(tx - Math.cos(a - 0.45) * 12 * s, ty - Math.sin(a - 0.45) * 12 * s)
        ctx.moveTo(tx, ty)
        ctx.lineTo(tx - Math.cos(a + 0.45) * 12 * s, ty - Math.sin(a + 0.45) * 12 * s)
        ctx.stroke()
        ctx.fillStyle = this.colors[i]!
        ctx.font = `700 ${Math.round(Math.max(13 * this.dpr, 20 * s))}px 'Nunito Variable', system-ui, sans-serif`
        ctx.fillText(
          this.names[i] ?? '',
          x - Math.cos(a) * 30 * s,
          y - Math.sin(a) * 30 * s - 4 * s,
        )
      }
    }

    // effets éphémères
    this.fx = this.fx.filter(f => now - f.t0 < 600)
    for (const f of this.fx) {
      const k = (now - f.t0) / 600
      ctx.globalAlpha = 1 - k
      ctx.strokeStyle = f.color
      ctx.lineWidth = (f.kind === 'death' ? 3 : 2) * this.dpr
      ctx.beginPath()
      ctx.arc(f.x * s, f.y * s, (f.kind === 'death' ? 8 + 40 * k : 6 + 24 * k) * s, 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.globalAlpha = 1

    // latence : la commande arrivée au serveur est visible dans cette image
    for (let k = 0; k < this.pendingMarks.length; k += 3) {
      const touch = this.pendingMarks[k + 2]!
      this.latency.push({
        idx: this.pendingMarks[k]!,
        ms: wallNow - this.pendingMarks[k + 1]!,
        touchMs: touch > 0 ? wallNow - touch : null,
      })
    }
    this.pendingMarks.length = 0
    if (this.latency.length > 400) this.latency.splice(0, this.latency.length - 400)
  }

  clear(): void {
    this.hasRound = false
    this.segCount = 0
    this.bonuses.clear()
    this.fx = []
    this.redrawTrails()
    this.octx.drawImage(this.trail, 0, 0)
  }
}
