import { describe, expect, it } from 'vitest'
import { DT, FLAG, FRAME_STRIDE, INPUT, TICK_RATE } from '../shared/constants'
import { DEFAULT_RULES, arenaDimensions, sanitizeRules, type Rules } from '../shared/rules'
import { Round } from '../game/round'

/** Règles sans trous (déterminisme des tests de collision). */
const NO_GAPS: Partial<Rules> = { gapEveryMin: 30, gapEveryMax: 30 }

function makeRound(n: number, rules: Partial<Rules> = {}, seed = 1, arena = { w: 1000, h: 800 }) {
  return new Round({ rules: sanitizeRules({ ...NO_GAPS, ...rules }), players: n, seed, arena })
}

function place(round: Round, i: number, x: number, y: number, angle: number) {
  const p = round.players[i]!
  p.x = x
  p.y = y
  p.angle = angle
}

describe('déplacement', () => {
  it('avance tout droit à la vitesse configurée, indépendamment du rendu', () => {
    const r = makeRound(1)
    place(r, 0, 100, 400, 0)
    for (let i = 0; i < TICK_RATE; i++) r.step()
    expect(r.players[0]!.x).toBeCloseTo(100 + DEFAULT_RULES.speed, 6)
    expect(r.players[0]!.y).toBeCloseTo(400, 6)
  })

  it('tourne à la vitesse angulaire configurée ; gauche diminue l’angle', () => {
    const r = makeRound(1)
    place(r, 0, 500, 400, 0)
    r.setInput(0, INPUT.LEFT)
    for (let i = 0; i < TICK_RATE / 2; i++) r.step()
    expect(r.players[0]!.angle).toBeCloseTo(-DEFAULT_RULES.turnRate / 2, 6)
  })

  it('aucune touche ou deux touches : tout droit', () => {
    const r = makeRound(2)
    place(r, 0, 100, 200, 0)
    place(r, 1, 100, 600, 0)
    r.setInput(1, INPUT.LEFT | INPUT.RIGHT)
    for (let i = 0; i < 60; i++) r.step()
    expect(r.players[0]!.angle).toBe(0)
    expect(r.players[1]!.angle).toBe(0)
  })

  it('est déterministe à graine et commandes égales', () => {
    const run = () => {
      const r = makeRound(6, { gapEveryMin: 1, gapEveryMax: 2 }, 42)
      for (let t = 0; t < 600; t++) {
        for (let i = 0; i < 6; i++) r.setInput(i, (t >> (i + 3)) & 3)
        r.step()
      }
      return r.hash()
    }
    expect(run()).toBe(run())
  })
})

describe('collisions', () => {
  it('élimine contre un mur, rayon de la tête compris', () => {
    const r = makeRound(2)
    // x + pas + rayon < 1000 après un tick, > 1000 après deux
    const step = DEFAULT_RULES.speed * DT
    place(r, 0, 1000 - 2.5 - 1.5 * step, 400, 0)
    place(r, 1, 100, 100, 0)
    r.step()
    expect(r.players[0]!.alive).toBe(true)
    r.step()
    expect(r.players[0]!.alive).toBe(false)
    expect(r.deaths).toEqual([{ idx: 0, cause: 'wall', tick: 1 }])
  })

  it('ne se heurte jamais à la trace qu’elle vient de poser (ligne droite, virage serré)', () => {
    const r = makeRound(1, { thickness: 12, turnRate: 5 })
    place(r, 0, 500, 400, 0)
    r.setInput(0, INPUT.LEFT)
    for (let i = 0; i < 40; i++) r.step() // un peu moins d'un tour complet
    expect(r.players[0]!.alive).toBe(true)
  })

  it('meurt en recoupant sa propre trace ancienne', () => {
    const r = makeRound(1, { turnRate: 3 })
    place(r, 0, 500, 400, 0)
    r.setInput(0, INPUT.LEFT)
    let ticks = 0
    while (r.players[0]!.alive && ticks < 3 * TICK_RATE) {
      r.step()
      ticks++
    }
    // un tour complet = 2π / 3 ≈ 2,09 s : la tête doit mourir en refermant la boucle
    expect(r.players[0]!.alive).toBe(false)
    expect(ticks / TICK_RATE).toBeGreaterThan(1.8)
    expect(ticks / TICK_RATE).toBeLessThan(2.2)
  })

  it('élimine en touchant la trace d’un adversaire', () => {
    const r = makeRound(2)
    place(r, 0, 300, 400, 0) // trace horizontale
    place(r, 1, 500, 100, Math.PI / 2) // descend et croise
    let dead1 = -1
    for (let t = 0; t < 3 * TICK_RATE && dead1 < 0; t++) {
      r.step()
      if (!r.players[1]!.alive) dead1 = t
    }
    // la tête 0 passe x=500 à t≈1,33 s ; la tête 1 atteint y≈400 à t=2 s
    expect(dead1).toBeGreaterThan(0)
    expect(r.players[0]!.alive).toBe(true)
    expect(r.deaths[0]?.cause ?? 'trail').toBe('trail')
  })

  it('ne traverse pas une trace même à très grande vitesse (balayage continu)', () => {
    const r = makeRound(2, { speed: 400, thickness: 1 })
    // trace verticale de la tête 0
    place(r, 0, 500, 100, Math.PI / 2)
    place(r, 1, 100, 700, 0)
    for (let t = 0; t < 200; t++) r.step()
    // la tête 1 file à 400 u/s (3,3 u/tick) vers une trace de 1 u d'épaisseur
    place(r, 1, 300, 620, 0)
    const p1 = r.players[1]!
    for (let t = 0; t < 120 && p1.alive; t++) r.step()
    expect(p1.alive).toBe(false)
    expect(p1.x).toBeLessThan(505)
  })

  it('traite les éliminations d’un même tick simultanément (face-à-face : égalité)', () => {
    const r = makeRound(2)
    place(r, 0, 400, 400, 0)
    place(r, 1, 600, 400, Math.PI)
    let t = 0
    while (r.players[0]!.alive && r.players[1]!.alive && t < 3 * TICK_RATE) {
      r.step()
      t++
    }
    expect(r.players[0]!.alive).toBe(false)
    expect(r.players[1]!.alive).toBe(false)
    expect(r.players[0]!.deathTick).toBe(r.players[1]!.deathTick)
    expect(r.isOver()).toBe(true)
  })

  it('fin de manche : au plus un survivant', () => {
    const r = makeRound(3)
    place(r, 0, 997, 400, 0)
    place(r, 1, 3, 400, Math.PI)
    place(r, 2, 500, 400, Math.PI / 2)
    r.step()
    expect(r.aliveCount()).toBe(1)
    expect(r.isOver()).toBe(true)
  })
})

describe('trous', () => {
  it('respecte la fréquence et la durée configurées, sans segment pendant un trou', () => {
    const r = makeRound(
      1,
      { gapEveryMin: 1, gapEveryMax: 2, gapDurationMin: 200, gapDurationMax: 300 },
      7,
      {
        w: 100000,
        h: 800,
      },
    )
    place(r, 0, 100, 400, 0)
    const gaps: { start: number; len: number }[] = []
    let inGap = false
    let segmentsBefore = r.trails.count
    for (let t = 0; t < 20 * TICK_RATE; t++) {
      r.step()
      const p = r.players[0]!
      if (p.inGap) {
        expect(r.trails.count).toBe(segmentsBefore) // aucun segment posé
        if (!inGap) gaps.push({ start: t, len: 0 })
        gaps[gaps.length - 1]!.len++
      }
      inGap = p.inGap
      segmentsBefore = r.trails.count
    }
    expect(gaps.length).toBeGreaterThanOrEqual(7)
    for (const g of gaps) {
      expect(g.len).toBeGreaterThanOrEqual(Math.round(0.2 * TICK_RATE))
      expect(g.len).toBeLessThanOrEqual(Math.round(0.3 * TICK_RATE))
    }
    for (let i = 1; i < gaps.length; i++) {
      const between = (gaps[i]!.start - (gaps[i - 1]!.start + gaps[i - 1]!.len)) / TICK_RATE
      expect(between).toBeGreaterThanOrEqual(0.99)
      expect(between).toBeLessThanOrEqual(2.01)
    }
  })

  it('permet de traverser une trace par son trou', () => {
    // la tête 0 trace une ligne horizontale avec un trou forcé à x ∈ [480, 520]
    const r = makeRound(2)
    place(r, 0, 300, 400, 0)
    place(r, 1, 500, 150, Math.PI / 2)
    const p0 = r.players[0]!
    for (let t = 0; t < 2.5 * TICK_RATE; t++) {
      // trou forcé quand la tête 0 passe autour de x = 500
      if (p0.x > 470 && p0.x < 530) p0.gapEnd = r.tick + 2
      r.step()
    }
    // la tête 1 a traversé y = 400 par le trou
    expect(r.players[1]!.y).toBeGreaterThan(420)
    expect(r.players[1]!.alive).toBe(true)
  })
})

describe('départ', () => {
  it('positions équitables : loin des murs et des autres, 1,5 s de ligne droite', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const n = 2 + (seed % 11)
      const arena = arenaDimensions('auto', n)
      const r = new Round({ rules: DEFAULT_RULES, players: n, seed, arena })
      const minSide = Math.min(arena.w, arena.h)
      for (const p of r.players) {
        expect(p.x).toBeGreaterThanOrEqual(60)
        expect(p.y).toBeGreaterThanOrEqual(60)
        expect(p.x).toBeLessThanOrEqual(arena.w - 60)
        expect(p.y).toBeLessThanOrEqual(arena.h - 60)
        const fx = p.x + Math.cos(p.angle) * DEFAULT_RULES.speed * 1.5
        const fy = p.y + Math.sin(p.angle) * DEFAULT_RULES.speed * 1.5
        expect(fx > 0 && fx < arena.w && fy > 0 && fy < arena.h).toBe(true)
      }
      for (let i = 0; i < n; i++)
        for (let j = i + 1; j < n; j++) {
          const a = r.players[i]!
          const b = r.players[j]!
          expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(0.08 * minSide)
        }
    }
  })

  it('aucune collision artificielle au départ : 1 s sans commande, personne ne meurt', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const r = new Round({
        rules: DEFAULT_RULES,
        players: 12,
        seed,
        arena: arenaDimensions('auto', 12),
      })
      for (let t = 0; t < TICK_RATE; t++) r.step()
      expect(r.aliveCount()).toBe(12)
    }
  })
})

describe('trames', () => {
  it('encode position, angle, épaisseur et drapeaux', () => {
    const r = makeRound(2)
    place(r, 0, 100, 100, 0)
    r.step()
    const h = r.heads()
    expect(h).toHaveLength(2 * FRAME_STRIDE)
    expect(h[0]).toBeCloseTo(100 + DEFAULT_RULES.speed * DT, 2)
    expect(h[3]).toBe(5)
    expect(h[4]! & FLAG.ALIVE).toBeTruthy()
    expect(h[4]! & FLAG.DRAW).toBeTruthy()
  })

  it('les polylignes de réhydratation couvrent toute la trace', () => {
    const r = makeRound(1, {
      gapEveryMin: 1,
      gapEveryMax: 1,
      gapDurationMin: 300,
      gapDurationMax: 300,
    })
    place(r, 0, 100, 400, 0)
    for (let t = 0; t < 4 * TICK_RATE; t++) r.step()
    const s = r.trails.toStrokes()
    let k = 0
    let strokes = 0
    let maxX = 0
    while (k < s.length) {
      const n = s[k + 2]!
      for (let j = 0; j < n; j++) maxX = Math.max(maxX, s[k + 3 + j * 2]!)
      k += 3 + n * 2
      strokes++
    }
    expect(strokes).toBeGreaterThanOrEqual(3) // trace découpée par les trous
    expect(maxX).toBeCloseTo(r.players[0]!.x, 0)
  })
})
