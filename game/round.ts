import {
  BONUS_RADIUS,
  DT,
  ERASE_RADIUS,
  FLAG,
  FRAME_STRIDE,
  INPUT,
  TICK_RATE,
} from '../shared/constants'
import { segSegDist2 } from '../shared/geometry'
import type { BonusItem, FrameEvent } from '../shared/protocol'
import {
  BONUS_DEFS,
  BONUS_KINDS,
  CHAOS_MALUS,
  EFFECT_MULT,
  SHIELD_IMMUNITY,
  SHIELD_MAX_CHARGES,
  SPEED_MULT_BOUNDS,
  TURN_MULT_BOUNDS,
  WIDTH_MULT_BOUNDS,
  arenaDimensions,
  type BonusKind,
  type EffectKind,
  type Rules,
} from '../shared/rules'
import { Rng } from './rng'
import { TrailStore } from './trails'

/**
 * Simulation d'une manche — pure, déterministe, sans horloge ni réseau.
 *
 * Un appel à `step()` avance d'un tick (1/120 s). Ordre d'un tick :
 *   1. expiration des effets, trous périodiques ;
 *   2. rotation (commande courante) puis déplacement de chaque tête ;
 *   3. collisions évaluées pour toutes les têtes sur l'état **d'avant** le tick
 *      (murs, traces existantes, nouveaux segments des autres têtes) : les
 *      éliminations d'un même tick sont simultanées ;
 *   4. pose des nouveaux segments, application des éliminations ;
 *   5. ramassage des bonus (têtes vivantes), puis apparition éventuelle.
 */

export interface Effect {
  kind: EffectKind
  /** Tick (exclu) de fin. */
  until: number
}

export interface RoundPlayer {
  x: number
  y: number
  angle: number
  alive: boolean
  /** Bits INPUT.LEFT / INPUT.RIGHT. */
  input: number
  /** Distance parcourue depuis le début de la manche. */
  dist: number
  gapEnd: number
  nextGap: number
  effects: Effect[]
  shield: number
  immuneUntil: number
  deathTick: number
  /** Dérivés du tick courant (exposés pour l'affichage et les bots). */
  width: number
  drew: boolean
  inGap: boolean
}

export type DeathCause = 'wall' | 'trail' | 'head' | 'left'

export interface Death {
  idx: number
  cause: DeathCause
  tick: number
}

export interface RoundOptions {
  rules: Rules
  players: number
  seed: number
  arena?: { w: number; h: number }
}

interface Move {
  ax: number
  ay: number
  bx: number
  by: number
  r: number
  step: number
  drawing: boolean
  ghost: boolean
}

export interface Derived {
  speedMult: number
  widthMult: number
  turnMult: number
  ghost: boolean
  inverted: boolean
}

const clamp = (v: number, [lo, hi]: readonly [number, number]) => (v < lo ? lo : v > hi ? hi : v)

export class Round {
  readonly rules: Rules
  readonly w: number
  readonly h: number
  readonly trails: TrailStore
  readonly players: RoundPlayer[]
  readonly rng: Rng
  tick = 0
  bonuses: BonusItem[] = []
  /** Événements produits par le dernier `step()`. */
  events: FrameEvent[] = []
  /** Éliminations du dernier `step()` (simultanées). */
  deaths: Death[] = []
  /** Têtes dont les effets ou le bouclier ont changé au dernier `step()`. */
  effectsChanged = new Set<number>()
  private nextBonusId = 1
  private nextBonusTick: number
  /** Éliminations hors simulation (exclusion) en attente du prochain `step()`. */
  private pendingDeaths: Death[] = []
  private pendingEvents: FrameEvent[] = []
  private moves: Move[]

  constructor(opts: RoundOptions) {
    this.rules = opts.rules
    const arena = opts.arena ?? arenaDimensions(opts.rules.arenaSize, opts.players)
    this.w = arena.w
    this.h = arena.h
    this.rng = new Rng(opts.seed)
    this.trails = new TrailStore(this.w, this.h)
    this.players = this.spawn(opts.players)
    this.moves = this.players.map(() => ({
      ax: 0,
      ay: 0,
      bx: 0,
      by: 0,
      r: 0,
      step: 0,
      drawing: false,
      ghost: false,
    }))
    this.nextBonusTick = this.secondsToTicks(
      this.rng.range(opts.rules.bonusSpawnMin, opts.rules.bonusSpawnMax),
    )
  }

  private secondsToTicks(s: number): number {
    return Math.max(1, Math.round(s * TICK_RATE))
  }

  /**
   * Positions de départ équitables : loin des murs, espacées entre elles, et
   * orientées pour laisser au moins ~1,5 s de ligne droite avant un mur.
   */
  private spawn(n: number): RoundPlayer[] {
    const { w, h, rules, rng } = this
    const min = Math.min(w, h)
    const margin = Math.min(160, Math.max(60, 0.12 * min))
    const ahead = rules.speed * 1.5
    const placed: { x: number; y: number }[] = []
    const players: RoundPlayer[] = []
    for (let i = 0; i < n; i++) {
      let minDist = 0.32 * min
      let x = w / 2
      let y = h / 2
      for (let attempt = 0; attempt < 400; attempt++) {
        if (attempt > 0 && attempt % 40 === 0) minDist *= 0.85
        x = rng.range(margin, w - margin)
        y = rng.range(margin, h - margin)
        if (placed.every(p => (p.x - x) ** 2 + (p.y - y) ** 2 >= minDist * minDist)) break
      }
      placed.push({ x, y })
      let angle = Math.atan2(h / 2 - y, w / 2 - x)
      for (let attempt = 0; attempt < 60; attempt++) {
        const a = rng.range(-Math.PI, Math.PI)
        const fx = x + Math.cos(a) * ahead
        const fy = y + Math.sin(a) * ahead
        if (fx > 40 && fx < w - 40 && fy > 40 && fy < h - 40) {
          angle = a
          break
        }
      }
      const every = rules.gapEveryMin + rng.next() * (rules.gapEveryMax - rules.gapEveryMin)
      players.push({
        x,
        y,
        angle,
        alive: true,
        input: 0,
        dist: 0,
        gapEnd: -1,
        nextGap: this.secondsToTicks(every),
        effects: [],
        shield: 0,
        immuneUntil: 0,
        deathTick: -1,
        width: rules.thickness,
        drew: false,
        inGap: false,
      })
    }
    return players
  }

  setInput(idx: number, bits: number): void {
    const p = this.players[idx]
    if (p) p.input = bits & (INPUT.LEFT | INPUT.RIGHT)
  }

  derive(p: RoundPlayer): Derived {
    let speedMult = 1
    let widthMult = 1
    let turnMult = 1
    let ghost = false
    let inverted = false
    for (const e of p.effects) {
      switch (e.kind) {
        case 'speedUp':
        case 'slowDown':
          speedMult *= EFFECT_MULT[e.kind]
          break
        case 'thin':
        case 'thick':
          widthMult *= EFFECT_MULT[e.kind]
          break
        case 'fastTurn':
          turnMult *= EFFECT_MULT.fastTurn
          break
        case 'ghost':
          ghost = true
          break
        case 'invert':
          inverted = true
          break
      }
    }
    return {
      speedMult: clamp(speedMult, SPEED_MULT_BOUNDS),
      widthMult: clamp(widthMult, WIDTH_MULT_BOUNDS),
      turnMult: clamp(turnMult, TURN_MULT_BOUNDS),
      ghost,
      inverted,
    }
  }

  aliveCount(): number {
    let n = 0
    for (const p of this.players) if (p.alive) n++
    return n
  }

  /** Manche terminée : au plus un survivant (ou plus personne en solo). */
  isOver(): boolean {
    const alive = this.aliveCount()
    return this.players.length >= 2 ? alive <= 1 : alive === 0
  }

  /** Élimine une tête hors simulation (joueur exclu). */
  forceKill(idx: number): void {
    const p = this.players[idx]
    if (!p || !p.alive) return
    p.alive = false
    p.deathTick = this.tick
    p.effects = []
    p.shield = 0
    this.pendingDeaths.push({ idx, cause: 'left', tick: this.tick })
    this.pendingEvents.push({ e: 'death', i: idx, x: p.x, y: p.y, cause: 'left' })
  }

  step(): void {
    const t = this.tick
    const { rules, trails } = this
    this.events = this.pendingEvents
    this.deaths = this.pendingDeaths
    this.pendingEvents = []
    this.pendingDeaths = []
    this.effectsChanged.clear()

    // 1–2. effets, trous, rotation, déplacement
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i]!
      const mv = this.moves[i]!
      if (!p.alive) continue
      const before = p.effects.length
      if (before) {
        p.effects = p.effects.filter(e => e.until > t)
        if (p.effects.length !== before) this.effectsChanged.add(i)
      }
      const d = this.derive(p)
      if (t >= p.nextGap) {
        const dur =
          rules.gapDurationMin + this.rng.next() * (rules.gapDurationMax - rules.gapDurationMin)
        const every = rules.gapEveryMin + this.rng.next() * (rules.gapEveryMax - rules.gapEveryMin)
        p.gapEnd = t + Math.max(0, Math.round((dur / 1000) * TICK_RATE))
        p.nextGap = p.gapEnd + this.secondsToTicks(every)
      }
      p.inGap = t < p.gapEnd
      let dir = (p.input & INPUT.LEFT ? -1 : 0) + (p.input & INPUT.RIGHT ? 1 : 0)
      if (d.inverted) dir = -dir
      p.angle += dir * rules.turnRate * d.turnMult * DT
      if (p.angle > Math.PI) p.angle -= 2 * Math.PI
      else if (p.angle < -Math.PI) p.angle += 2 * Math.PI
      const step = rules.speed * d.speedMult * DT
      p.width = rules.thickness * d.widthMult
      mv.ax = p.x
      mv.ay = p.y
      mv.bx = p.x + Math.cos(p.angle) * step
      mv.by = p.y + Math.sin(p.angle) * step
      mv.r = p.width / 2
      mv.step = step
      mv.ghost = d.ghost
      mv.drawing = !p.inGap && !d.ghost
    }

    // 3. collisions, toutes évaluées sur l'état d'avant le tick
    const dying: { idx: number; cause: DeathCause }[] = []
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i]!
      if (!p.alive) continue
      const mv = this.moves[i]!
      const r = mv.r
      let cause: DeathCause | null = null
      if (mv.bx - r < 0 || mv.bx + r > this.w || mv.by - r < 0 || mv.by + r > this.h) {
        cause = 'wall'
      } else if (!mv.ghost && t >= p.immuneUntil) {
        const selfIgnore = 2 * (r + trails.maxR) + 2 * mv.step
        if (trails.hit(mv.ax, mv.ay, mv.bx, mv.by, r, i, p.dist, selfIgnore) >= 0) cause = 'trail'
        else {
          for (let j = 0; j < this.players.length; j++) {
            const q = this.players[j]!
            const mq = this.moves[j]!
            if (j === i || !q.alive || !mq.drawing) continue
            const rr = r + mq.r
            if (segSegDist2(mv.ax, mv.ay, mv.bx, mv.by, mq.ax, mq.ay, mq.bx, mq.by) < rr * rr) {
              cause = 'head'
              break
            }
          }
        }
        if (cause && p.shield > 0) {
          p.shield--
          p.immuneUntil = t + this.secondsToTicks(SHIELD_IMMUNITY)
          this.effectsChanged.add(i)
          this.events.push({ e: 'shield', i })
          cause = null
        }
      }
      if (cause) dying.push({ idx: i, cause })
    }

    // 4. pose des segments, déplacement, éliminations simultanées
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i]!
      if (!p.alive) {
        p.drew = false
        continue
      }
      const mv = this.moves[i]!
      p.drew = mv.drawing
      if (mv.drawing) trails.add(i, mv.ax, mv.ay, mv.bx, mv.by, mv.r, p.dist + mv.step)
      p.x = mv.bx
      p.y = mv.by
      p.dist += mv.step
    }
    for (const { idx, cause } of dying) {
      const p = this.players[idx]!
      p.alive = false
      p.deathTick = t
      if (p.effects.length || p.shield) this.effectsChanged.add(idx)
      p.effects = []
      p.shield = 0
      this.deaths.push({ idx, cause, tick: t })
      this.events.push({ e: 'death', i: idx, x: p.x, y: p.y, cause })
    }

    // 5. bonus
    if (this.bonuses.length) this.collectBonuses()
    if (rules.mode === 'party' && t >= this.nextBonusTick) {
      this.nextBonusTick =
        t + this.secondsToTicks(this.rng.range(rules.bonusSpawnMin, rules.bonusSpawnMax))
      this.trySpawnBonus()
    }

    this.tick++
  }

  /** Ramassage : si plusieurs têtes touchent le même bonus, la plus proche le prend (puis l'index le plus bas). */
  private collectBonuses(): void {
    const taken: { b: BonusItem; idx: number }[] = []
    for (const b of this.bonuses) {
      let best = -1
      let bestD = Infinity
      for (let i = 0; i < this.players.length; i++) {
        const p = this.players[i]!
        if (!p.alive) continue
        const reach = BONUS_RADIUS + p.width / 2
        const d2 = (p.x - b.x) ** 2 + (p.y - b.y) ** 2
        if (d2 < reach * reach && d2 < bestD) {
          best = i
          bestD = d2
        }
      }
      if (best >= 0) taken.push({ b, idx: best })
    }
    if (!taken.length) return
    const takenIds = new Set(taken.map(x => x.b.id))
    this.bonuses = this.bonuses.filter(b => !takenIds.has(b.id))
    for (const { b, idx } of taken) {
      this.events.push({ e: 'take', id: b.id, i: idx, kind: b.kind })
      this.applyBonus(b, idx)
    }
  }

  applyBonus(b: Pick<BonusItem, 'kind' | 'x' | 'y'>, idx: number): void {
    const p = this.players[idx]!
    const kind = b.kind
    switch (kind) {
      case 'shield':
        p.shield = Math.min(SHIELD_MAX_CHARGES, p.shield + 1)
        this.effectsChanged.add(idx)
        break
      case 'erase':
        this.trails.erase(b.x, b.y, ERASE_RADIUS)
        this.events.push({ e: 'erase', x: b.x, y: b.y, r: ERASE_RADIUS })
        break
      case 'chaos': {
        const malus = this.rng.pick(CHAOS_MALUS)
        const until = this.tick + this.secondsToTicks(this.rules.chaosDuration)
        for (let j = 0; j < this.players.length; j++) {
          const q = this.players[j]!
          if (j === idx || !q.alive) continue
          q.effects.push({ kind: malus, until })
          this.effectsChanged.add(j)
        }
        break
      }
      default:
        p.effects.push({ kind, until: this.tick + this.secondsToTicks(BONUS_DEFS[kind].duration) })
        this.effectsChanged.add(idx)
    }
  }

  /** Apparition dans une zone sûre : loin des murs, des têtes, des traces et des autres bonus. */
  private trySpawnBonus(): void {
    const { rules } = this
    if (this.bonuses.length >= rules.bonusMaxOnField) return
    const kinds = BONUS_KINDS.filter(k => rules.bonuses[k])
    if (!kinds.length) return
    const kind: BonusKind = this.rng.pick(kinds)
    const margin = 60
    for (let attempt = 0; attempt < 40; attempt++) {
      const x = this.rng.range(margin, this.w - margin)
      const y = this.rng.range(margin, this.h - margin)
      if (this.players.some(p => p.alive && (p.x - x) ** 2 + (p.y - y) ** 2 < 120 * 120)) continue
      if (this.bonuses.some(b => (b.x - x) ** 2 + (b.y - y) ** 2 < (4 * BONUS_RADIUS) ** 2))
        continue
      if (this.trails.clearance(x, y, BONUS_RADIUS + 12) < BONUS_RADIUS + 12) continue
      const b: BonusItem = { id: this.nextBonusId++, kind, x: Math.round(x), y: Math.round(y) }
      this.bonuses.push(b)
      this.events.push({ e: 'spawn', b })
      return
    }
  }

  /** Bits FLAG d'une tête. */
  flags(i: number): number {
    const p = this.players[i]!
    let f = 0
    if (p.alive) f |= FLAG.ALIVE
    if (p.drew) f |= FLAG.DRAW
    if (p.inGap) f |= FLAG.GAP
    if (p.shield > 0) f |= FLAG.SHIELD
    if (this.tick < p.immuneUntil) f |= FLAG.IMMUNE
    for (const e of p.effects) {
      if (e.kind === 'ghost') f |= FLAG.GHOST
      else if (e.kind === 'invert') f |= FLAG.INVERT
    }
    return f
  }

  /** État compact des têtes (FRAME_STRIDE valeurs par tête), arrondi au centième. */
  heads(): number[] {
    const out: number[] = new Array(this.players.length * FRAME_STRIDE)
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i]!
      const o = i * FRAME_STRIDE
      out[o] = Math.round(p.x * 100) / 100
      out[o + 1] = Math.round(p.y * 100) / 100
      out[o + 2] = Math.round(p.angle * 1000) / 1000
      out[o + 3] = Math.round(p.width * 100) / 100
      out[o + 4] = this.flags(i)
    }
    return out
  }

  activeEffects(i: number): EffectKind[] {
    return [...new Set(this.players[i]!.effects.map(e => e.kind))]
  }

  /** Empreinte de l'état (tests de déterminisme). */
  hash(): string {
    return this.players
      .map(p => `${p.x.toFixed(6)},${p.y.toFixed(6)},${p.angle.toFixed(6)},${+p.alive}`)
      .join('|')
  }
}
