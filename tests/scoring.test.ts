import { describe, expect, it } from 'vitest'
import { DEFAULT_RULES, effectiveTarget, sanitizeRules } from '../shared/rules'
import { gameWinners, pointsForDeaths, survivorBonus } from '../game/scoring'

describe('points', () => {
  it('chaque élimination rapporte un point à chaque survivant', () => {
    expect([...pointsForDeaths(1, [0, 2, 3], DEFAULT_RULES)]).toEqual([
      [0, 1],
      [2, 1],
      [3, 1],
    ])
  })

  it('éliminations simultanées : deux morts = 2 points aux survivants, rien entre elles', () => {
    expect([...pointsForDeaths(2, [3], DEFAULT_RULES)]).toEqual([[3, 2]])
    expect([...pointsForDeaths(2, [], DEFAULT_RULES)]).toEqual([])
  })

  it('points par élimination configurables', () => {
    expect([...pointsForDeaths(1, [1], { pointsPerDeath: 3 })]).toEqual([[1, 3]])
  })

  it('bonus de dernier survivant seulement s’il y a exactement un survivant', () => {
    expect(survivorBonus([2], 4, { survivorBonus: 3 })).toEqual({ idx: 2, points: 3 })
    expect(survivorBonus([], 4, { survivorBonus: 3 })).toBeNull()
    expect(survivorBonus([2], 1, { survivorBonus: 3 })).toBeNull()
    expect(survivorBonus([2], 4, { survivorBonus: 0 })).toBeNull()
  })
})

describe('fin de partie', () => {
  const rules = sanitizeRules({ targetScore: 10, winByTwo: true })

  it('objectif automatique : 10 × (joueurs − 1), minimum 5', () => {
    expect(effectiveTarget(DEFAULT_RULES, 2)).toBe(10)
    expect(effectiveTarget(DEFAULT_RULES, 12)).toBe(110)
    expect(effectiveTarget(DEFAULT_RULES, 1)).toBe(5)
  })

  it('objectif atteint avec 2 points d’avance', () => {
    expect(
      gameWinners(
        new Map([
          ['a', 10],
          ['b', 8],
        ]),
        5,
        rules,
      ),
    ).toEqual(['a'])
    expect(
      gameWinners(
        new Map([
          ['a', 10],
          ['b', 9],
        ]),
        5,
        rules,
      ),
    ).toBeNull()
    expect(
      gameWinners(
        new Map([
          ['a', 9],
          ['b', 2],
        ]),
        5,
        rules,
      ),
    ).toBeNull()
  })

  it('sans « 2 points d’avance » : ex æquo possibles', () => {
    const r = { ...rules, winByTwo: false }
    expect(
      gameWinners(
        new Map([
          ['a', 10],
          ['b', 10],
        ]),
        5,
        r,
      ),
    ).toEqual(['a', 'b'])
  })

  it('par nombre de manches : meilleur(s) score(s) à la fin', () => {
    const r = sanitizeRules({ endCondition: 'rounds', rounds: 3 })
    expect(
      gameWinners(
        new Map([
          ['a', 4],
          ['b', 5],
        ]),
        2,
        r,
      ),
    ).toBeNull()
    expect(
      gameWinners(
        new Map([
          ['a', 4],
          ['b', 5],
        ]),
        3,
        r,
      ),
    ).toEqual(['b'])
  })
})

describe('validation des règles', () => {
  it('borne les valeurs, ignore les types invalides, réordonne les intervalles', () => {
    const r = sanitizeRules({
      speed: 1e9,
      turnRate: 'vite',
      thickness: -3,
      gapEveryMin: 9,
      gapEveryMax: 2,
      mode: 'hack',
      bonuses: { ghost: false, nope: true },
      rounds: 2.7,
    })
    expect(r.speed).toBe(400)
    expect(r.turnRate).toBe(DEFAULT_RULES.turnRate)
    expect(r.thickness).toBe(1)
    expect(r.gapEveryMax).toBe(9)
    expect(r.mode).toBe('classic')
    expect(r.bonuses.ghost).toBe(false)
    expect((r.bonuses as Record<string, boolean>).nope).toBeUndefined()
    expect(r.rounds).toBe(3)
  })
})
