import { describe, expect, it } from 'vitest'
import { BONUS_RADIUS, DT, ERASE_RADIUS, INPUT, TICK_RATE } from '../shared/constants'
import {
  BONUS_DEFS,
  BONUS_KINDS,
  CHAOS_MALUS,
  sanitizeRules,
  type BonusKind,
  type Rules,
} from '../shared/rules'
import { Round } from '../game/round'

const BASE: Partial<Rules> = {
  mode: 'party',
  gapEveryMin: 30,
  gapEveryMax: 30,
  bonusSpawnMin: 60,
  bonusSpawnMax: 60,
}

function makeRound(n: number, rules: Partial<Rules> = {}, seed = 3) {
  return new Round({
    rules: sanitizeRules({ ...BASE, ...rules }),
    players: n,
    seed,
    arena: { w: 1200, h: 900 },
  })
}

function place(r: Round, i: number, x: number, y: number, angle = 0) {
  Object.assign(r.players[i]!, { x, y, angle })
}

/** Pose un bonus juste devant la tête `i` et avance jusqu'au ramassage. */
function pickup(r: Round, i: number, kind: BonusKind) {
  const p = r.players[i]!
  r.bonuses.push({
    id: 900 + r.tick,
    kind,
    x: p.x + Math.cos(p.angle) * 10,
    y: p.y + Math.sin(p.angle) * 10,
  })
  r.step()
  return r.events.find(e => e.e === 'take')
}

describe('effets', () => {
  it('Accélération : vitesse ×1,5 pendant 5 s puis retour à la normale', () => {
    const r = makeRound(1)
    place(r, 0, 20, 450) // 5 s à 225 u/s = 1125 u : reste dans l'arène de 1200
    expect(pickup(r, 0, 'speedUp')).toMatchObject({ i: 0, kind: 'speedUp' })
    const x0 = r.players[0]!.x
    r.step()
    expect(r.players[0]!.x - x0).toBeCloseTo(150 * 1.5 * DT, 6)
    for (let t = 0; t < 5 * TICK_RATE; t++) r.step()
    const x1 = r.players[0]!.x
    r.step()
    expect(r.players[0]!.x - x1).toBeCloseTo(150 * DT, 6)
  })

  it('cumul : deux accélérations se multiplient, bornées à ×2,5', () => {
    const r = makeRound(1)
    place(r, 0, 100, 450)
    pickup(r, 0, 'speedUp')
    pickup(r, 0, 'speedUp')
    expect(r.derive(r.players[0]!).speedMult).toBeCloseTo(2.25, 6)
    pickup(r, 0, 'speedUp')
    expect(r.derive(r.players[0]!).speedMult).toBe(2.5)
  })

  it('Ralentissement ×0,65 et Accélération se compensent par produit', () => {
    const r = makeRound(1)
    place(r, 0, 100, 450)
    pickup(r, 0, 'slowDown')
    pickup(r, 0, 'speedUp')
    expect(r.derive(r.players[0]!).speedMult).toBeCloseTo(0.975, 6)
  })

  it('Trace fine / épaisse modifient l’épaisseur des nouveaux segments', () => {
    const r = makeRound(2)
    place(r, 0, 100, 300)
    place(r, 1, 100, 600)
    pickup(r, 0, 'thin')
    pickup(r, 1, 'thick')
    r.step()
    expect(r.players[0]!.width).toBeCloseTo(2.5, 6)
    expect(r.players[1]!.width).toBeCloseTo(10, 6)
    expect(BONUS_DEFS.thin.duration).toBe(7)
    expect(BONUS_DEFS.thick.duration).toBe(6)
  })

  it('Virage rapide : vitesse angulaire ×1,5', () => {
    const r = makeRound(1)
    place(r, 0, 600, 450)
    pickup(r, 0, 'fastTurn')
    r.setInput(0, INPUT.RIGHT)
    const a0 = r.players[0]!.angle
    r.step()
    expect(r.players[0]!.angle - a0).toBeCloseTo(2.8 * 1.5 * DT, 6)
  })

  it('Inversion : gauche tourne à droite pendant 4 s', () => {
    const r = makeRound(1)
    place(r, 0, 600, 450)
    pickup(r, 0, 'invert')
    r.setInput(0, INPUT.LEFT)
    r.step()
    expect(r.players[0]!.angle).toBeGreaterThan(0)
    expect(r.activeEffects(0)).toEqual(['invert'])
    for (let t = 0; t < 4 * TICK_RATE; t++) r.step()
    expect(r.activeEffects(0)).toEqual([])
  })

  it('Fantôme : traverse les traces, ne laisse pas de trace, mais meurt contre un mur', () => {
    const r = makeRound(2)
    place(r, 0, 300, 450) // trace horizontale
    place(r, 1, 600, 50, Math.PI / 2)
    for (let t = 0; t < 2.5 * TICK_RATE; t++) r.step() // la trace de 0 dépasse x = 600
    pickup(r, 1, 'ghost')
    const segs = r.trails.count
    for (let t = 0; t < 2.5 * TICK_RATE; t++) r.step() // 1 traverse y = 450
    expect(r.players[1]!.y).toBeGreaterThan(460)
    expect(r.players[1]!.alive).toBe(true)
    // pas de segment pour la tête fantôme
    let own = 0
    for (let id = segs; id < r.trails.count; id++) if (r.trails.owner[id] === 1) own++
    expect(own).toBe(0)
    // mais le mur reste mortel
    place(r, 1, 600, 897.5, Math.PI / 2)
    pickup(r, 1, 'ghost')
    r.step()
    expect(r.players[1]!.alive).toBe(false)
  })

  it('Bouclier : annule une collision avec une trace, consomme la charge, immunité brève', () => {
    const r = makeRound(2)
    place(r, 0, 300, 450)
    place(r, 1, 600, 150, Math.PI / 2)
    for (let t = 0; t < TICK_RATE; t++) r.step()
    pickup(r, 1, 'shield')
    expect(r.players[1]!.shield).toBe(1)
    let consumed = false
    for (let t = 0; t < 3 * TICK_RATE; t++) {
      r.step()
      if (r.events.some(e => e.e === 'shield' && e.i === 1)) consumed = true
    }
    expect(consumed).toBe(true)
    expect(r.players[1]!.alive).toBe(true)
    expect(r.players[1]!.shield).toBe(0)
    expect(r.players[1]!.y).toBeGreaterThan(460)
  })

  it('Bouclier : ne protège pas des murs', () => {
    const r = makeRound(1)
    place(r, 0, 1197.5, 450)
    r.players[0]!.shield = 1
    r.step()
    r.step()
    expect(r.players[0]!.alive).toBe(false)
  })

  it('Effacement : supprime les segments dans le rayon, garde les autres', () => {
    const r = makeRound(2)
    place(r, 0, 100, 300)
    place(r, 1, 100, 700)
    for (let t = 0; t < 4 * TICK_RATE; t++) r.step()
    const before = r.trails.liveCount()
    place(r, 1, 400, 520, -Math.PI / 2)
    r.bonuses.push({ id: 1, kind: 'erase', x: 400, y: 510 })
    r.step()
    const ev = r.events.find(e => e.e === 'erase')
    expect(ev).toEqual({ e: 'erase', x: 400, y: 510, r: ERASE_RADIUS })
    const after = r.trails.liveCount()
    expect(after).toBeLessThan(before)
    // la trace de 0 (y = 300) est à 210 u : hors zone ; celle de 1 (y = 700) à 190 u : effacée en partie
    for (let id = 0; id < r.trails.count; id++) {
      if (!r.trails.alive[id]) {
        const d = Math.hypot(r.trails.x1[id]! - 400, r.trails.y1[id]! - 510)
        expect(d).toBeLessThanOrEqual(ERASE_RADIUS + 2)
      }
    }
  })

  it('Chaos : un malus au hasard pour tous les adversaires vivants, durée configurable', () => {
    const r = makeRound(3, { chaosDuration: 2 })
    place(r, 0, 100, 200)
    place(r, 1, 100, 450)
    place(r, 2, 100, 700)
    pickup(r, 0, 'chaos')
    expect(r.activeEffects(0)).toEqual([])
    const m1 = r.activeEffects(1)
    expect(m1).toHaveLength(1)
    expect(CHAOS_MALUS).toContain(m1[0])
    expect(r.activeEffects(2)).toEqual(m1)
    for (let t = 0; t < 2 * TICK_RATE; t++) r.step()
    expect(r.activeEffects(1)).toEqual([])
  })

  it('collecte simultanée : la tête la plus proche prend le bonus', () => {
    const r = makeRound(2)
    place(r, 0, 500, 440)
    place(r, 1, 500, 460)
    r.bonuses.push({ id: 7, kind: 'shield', x: 503, y: 447 })
    r.step()
    const takes = r.events.filter(e => e.e === 'take')
    expect(takes).toEqual([{ e: 'take', id: 7, i: 0, kind: 'shield' }])
    expect(r.bonuses).toHaveLength(0)
  })

  it('élimination : les effets et le bouclier disparaissent', () => {
    const r = makeRound(2)
    place(r, 0, 1150, 450)
    place(r, 1, 100, 100)
    pickup(r, 0, 'slowDown')
    r.players[0]!.shield = 2
    for (let t = 0; t < TICK_RATE && r.players[0]!.alive; t++) r.step()
    expect(r.players[0]!.alive).toBe(false)
    expect(r.players[0]!.effects).toEqual([])
    expect(r.players[0]!.shield).toBe(0)
  })
})

describe('apparition', () => {
  it('respecte la limite simultanée, les bonus désactivés et une zone sûre', () => {
    const enabled = {
      ...Object.fromEntries(BONUS_KINDS.map(k => [k, false])),
      shield: true,
      thin: true,
    }
    const r = makeRound(4, {
      bonusSpawnMin: 0.5,
      bonusSpawnMax: 0.5,
      bonusMaxOnField: 2,
      bonuses: enabled as never,
    })
    r.players.forEach((_, i) => place(r, i, 200 + i * 250, 450, -Math.PI / 2))
    let max = 0
    for (let t = 0; t < 2 * TICK_RATE; t++) {
      r.step()
      for (const e of r.events) {
        if (e.e !== 'spawn') continue
        expect(['shield', 'thin']).toContain(e.b.kind)
        expect(e.b.x).toBeGreaterThanOrEqual(60)
        expect(e.b.y).toBeGreaterThanOrEqual(60)
        for (const p of r.players)
          if (p.alive) expect(Math.hypot(p.x - e.b.x, p.y - e.b.y)).toBeGreaterThan(110)
        expect(r.trails.clearance(e.b.x, e.b.y, 50)).toBeGreaterThanOrEqual(BONUS_RADIUS)
      }
      max = Math.max(max, r.bonuses.length)
    }
    expect(max).toBe(2)
  })

  it('mode Classique : aucun bonus', () => {
    const r = makeRound(2, { mode: 'classic', bonusSpawnMin: 0.5, bonusSpawnMax: 0.5 })
    for (let t = 0; t < 3 * TICK_RATE; t++) r.step()
    expect(r.bonuses).toEqual([])
  })
})
