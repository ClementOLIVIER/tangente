import { INPUT, TICK_RATE } from '../shared/constants'
import type { Round } from './round'

/**
 * Pilote automatique (tests de charge, parties à 12, appoint en soirée).
 * Toutes les 50 ms, il essaie trois commandes (tout droit, gauche,
 * droite) en extrapolant ~1 s de trajectoire et garde celle qui survit le plus
 * longtemps, avec une préférence pour la commande en cours (stabilité).
 */
export class BotBrain {
  private current = 0
  private countdown = 0

  constructor(
    private readonly idx: number,
    /** Période de décision en ticks (50 ms, quelle que soit la fréquence de simulation). */
    private readonly period = Math.max(1, Math.round(0.05 * TICK_RATE)),
    private readonly seedOffset = 0,
  ) {}

  decide(round: Round): number {
    if (--this.countdown > 0) return this.current
    this.countdown = this.period
    const p = round.players[this.idx]
    if (!p || !p.alive) return 0
    const d = round.derive(p)
    const options = [this.current, 0, INPUT.LEFT, INPUT.RIGHT].filter(
      (v, i, a) => a.indexOf(v) === i,
    )
    let best = this.current
    let bestScore = -1
    for (const opt of options) {
      let score = this.probe(round, opt, d.speedMult, d.turnMult, d.inverted)
      if (opt === this.current) score += 0.5
      // légère variété : les bots ne prennent pas tous la même décision
      score += ((this.idx * 7 + this.seedOffset + round.tick) % 5) * 0.01
      if (score > bestScore) {
        bestScore = score
        best = opt
      }
    }
    this.current = best
    return best
  }

  /** Nombre de pas (sur 24) survécus en maintenant `input`. */
  private probe(
    round: Round,
    input: number,
    speedMult: number,
    turnMult: number,
    inverted: boolean,
  ): number {
    const p = round.players[this.idx]!
    const r = p.width / 2
    // 24 pas de 42 ms ≈ 1 s d'horizon
    const stepSec = 0.042
    const steps = 24
    let dir = (input & INPUT.LEFT ? -1 : 0) + (input & INPUT.RIGHT ? 1 : 0)
    if (inverted) dir = -dir
    let { x, y, angle, dist } = p
    const v = round.rules.speed * speedMult * stepSec
    const turn = dir * round.rules.turnRate * turnMult * stepSec
    const selfIgnore = 2 * (r + round.trails.maxR) + 2 * v
    for (let s = 0; s < steps; s++) {
      angle += turn
      const nx = x + Math.cos(angle) * v
      const ny = y + Math.sin(angle) * v
      const m = r + 6
      if (nx < m || ny < m || nx > round.w - m || ny > round.h - m) return s
      if (round.trails.hit(x, y, nx, ny, r + 2, this.idx, dist, selfIgnore) >= 0) return s
      x = nx
      y = ny
      dist += v
    }
    return steps
  }
}
