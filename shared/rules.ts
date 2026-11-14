/**
 * Règles configurables depuis le tableau de bord, valeurs par défaut et
 * validation (bornes). Toute règle reçue d'un client passe par `sanitizeRules`.
 */

export type GameMode = 'classic' | 'party'
export type ArenaSize = 'auto' | 'small' | 'medium' | 'large'
export type EndCondition = 'score' | 'rounds'

export const BONUS_KINDS = [
  'speedUp',
  'slowDown',
  'thin',
  'thick',
  'shield',
  'ghost',
  'invert',
  'erase',
  'fastTurn',
  'chaos',
] as const
export type BonusKind = (typeof BONUS_KINDS)[number]

/** Bonus qui posent un effet temporaire sur une tête (les autres sont instantanés). */
export type EffectKind = 'speedUp' | 'slowDown' | 'thin' | 'thick' | 'ghost' | 'invert' | 'fastTurn'

export interface BonusDef {
  label: string
  /** Effet pour le joueur qui le ramasse : `good` (vert), `bad` (rouge), `neutral`. */
  tone: 'good' | 'bad' | 'neutral'
  /** Durée en secondes (effets temporaires). */
  duration: number
  description: string
}

export const BONUS_DEFS: Record<BonusKind, BonusDef> = {
  speedUp: { label: 'Accélération', tone: 'bad', duration: 5, description: 'Vitesse ×1,5' },
  slowDown: { label: 'Ralentissement', tone: 'good', duration: 5, description: 'Vitesse ×0,65' },
  thin: { label: 'Trace fine', tone: 'good', duration: 7, description: 'Épaisseur ×0,5' },
  thick: { label: 'Trace épaisse', tone: 'bad', duration: 6, description: 'Épaisseur ×2' },
  shield: {
    label: 'Bouclier',
    tone: 'good',
    duration: 0,
    description: 'Une charge : annule une collision avec une trace',
  },
  ghost: {
    label: 'Fantôme',
    tone: 'good',
    duration: 3,
    description: 'Traverse les traces (pas les murs), ne laisse pas de trace',
  },
  invert: {
    label: 'Inversion',
    tone: 'bad',
    duration: 4,
    description: 'Gauche et droite inversées',
  },
  erase: {
    label: 'Effacement',
    tone: 'neutral',
    duration: 0,
    description: 'Efface les traces autour du bonus',
  },
  fastTurn: {
    label: 'Virage rapide',
    tone: 'good',
    duration: 5,
    description: 'Vitesse de rotation ×1,5',
  },
  chaos: {
    label: 'Chaos',
    tone: 'good',
    duration: 0,
    description: 'Un malus au hasard pour tous les adversaires',
  },
}

/** Multiplicateurs des effets ; les effets d'un même type se cumulent (produit), bornés. */
export const EFFECT_MULT = {
  speedUp: 1.5,
  slowDown: 0.65,
  thin: 0.5,
  thick: 2,
  fastTurn: 1.5,
} as const
export const SPEED_MULT_BOUNDS = [0.4, 2.5] as const
export const WIDTH_MULT_BOUNDS = [0.35, 4] as const
export const TURN_MULT_BOUNDS = [1, 2.5] as const
/** Malus tirés au sort par « Chaos ». */
export const CHAOS_MALUS: EffectKind[] = ['speedUp', 'invert', 'thick']
/** Durée d'invulnérabilité aux traces après consommation d'un bouclier (s). */
export const SHIELD_IMMUNITY = 0.6
export const SHIELD_MAX_CHARGES = 3

export interface Rules {
  mode: GameMode
  /** Unités logiques / seconde. */
  speed: number
  /** Radians / seconde. */
  turnRate: number
  /** Épaisseur de trace (unités). */
  thickness: number
  /** Intervalle entre deux trous (s). */
  gapEveryMin: number
  gapEveryMax: number
  /** Durée d'un trou (ms). */
  gapDurationMin: number
  gapDurationMax: number
  arenaSize: ArenaSize
  endCondition: EndCondition
  /** 0 = automatique : 10 × (joueurs − 1). */
  targetScore: number
  winByTwo: boolean
  rounds: number
  /** Points par adversaire éliminé, pour chaque survivant. */
  pointsPerDeath: number
  /** Points supplémentaires pour le dernier survivant. */
  survivorBonus: number
  autoNextRound: boolean
  /** Délai avant la manche suivante en mode automatique (s). */
  roundEndDelay: number
  /** Compte à rebours (s). */
  countdown: number
  bonuses: Record<BonusKind, boolean>
  bonusMaxOnField: number
  /** Intervalle d'apparition des bonus (s). */
  bonusSpawnMin: number
  bonusSpawnMax: number
  /** Durée des malus infligés par « Chaos » (s). */
  chaosDuration: number
}

export const DEFAULT_RULES: Rules = {
  mode: 'classic',
  speed: 150,
  turnRate: 2.8,
  thickness: 5,
  gapEveryMin: 4,
  gapEveryMax: 8,
  gapDurationMin: 180,
  gapDurationMax: 300,
  arenaSize: 'auto',
  endCondition: 'score',
  targetScore: 0,
  winByTwo: true,
  rounds: 10,
  pointsPerDeath: 1,
  survivorBonus: 0,
  autoNextRound: false,
  roundEndDelay: 6,
  countdown: 3,
  bonuses: Object.fromEntries(BONUS_KINDS.map(k => [k, true])) as Record<BonusKind, boolean>,
  bonusMaxOnField: 3,
  bonusSpawnMin: 3,
  bonusSpawnMax: 7,
  chaosDuration: 4,
}

/** Bornes des règles numériques : [min, max, entier ?]. */
const NUMERIC_BOUNDS: Partial<Record<keyof Rules, [number, number, boolean]>> = {
  speed: [40, 400, false],
  turnRate: [1, 8, false],
  thickness: [1, 20, false],
  gapEveryMin: [1, 30, false],
  gapEveryMax: [1, 30, false],
  gapDurationMin: [0, 1500, true],
  gapDurationMax: [0, 1500, true],
  targetScore: [0, 999, true],
  rounds: [1, 99, true],
  pointsPerDeath: [0, 10, true],
  survivorBonus: [0, 50, true],
  roundEndDelay: [2, 60, false],
  countdown: [1, 10, true],
  bonusMaxOnField: [1, 10, true],
  bonusSpawnMin: [0.5, 60, false],
  bonusSpawnMax: [0.5, 60, false],
  chaosDuration: [1, 15, false],
}

function num(v: unknown, fallback: number, [min, max, int]: [number, number, boolean]): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  const n = int ? Math.round(v) : v
  return Math.min(max, Math.max(min, n))
}

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback
}

/**
 * Fusionne une proposition (partielle, non fiable) avec des règles de base :
 * types vérifiés, bornes appliquées, intervalles min/max remis dans l'ordre.
 */
export function sanitizeRules(input: unknown, base: Rules = DEFAULT_RULES): Rules {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const out: Rules = { ...base, bonuses: { ...base.bonuses } }
  for (const [key, bounds] of Object.entries(NUMERIC_BOUNDS) as [
    keyof Rules,
    [number, number, boolean],
  ][]) {
    if (key in src)
      (out as unknown as Record<string, number>)[key] = num(src[key], base[key] as number, bounds)
  }
  if ('mode' in src) out.mode = pick(src.mode, ['classic', 'party'] as const, base.mode)
  if ('arenaSize' in src)
    out.arenaSize = pick(
      src.arenaSize,
      ['auto', 'small', 'medium', 'large'] as const,
      base.arenaSize,
    )
  if ('endCondition' in src)
    out.endCondition = pick(src.endCondition, ['score', 'rounds'] as const, base.endCondition)
  if (typeof src.winByTwo === 'boolean') out.winByTwo = src.winByTwo
  if (typeof src.autoNextRound === 'boolean') out.autoNextRound = src.autoNextRound
  if (src.bonuses && typeof src.bonuses === 'object') {
    const b = src.bonuses as Record<string, unknown>
    for (const k of BONUS_KINDS) if (typeof b[k] === 'boolean') out.bonuses[k] = b[k] as boolean
  }
  if (out.gapEveryMax < out.gapEveryMin) out.gapEveryMax = out.gapEveryMin
  if (out.gapDurationMax < out.gapDurationMin) out.gapDurationMax = out.gapDurationMin
  if (out.bonusSpawnMax < out.bonusSpawnMin) out.bonusSpawnMax = out.bonusSpawnMin
  return out
}

/** Objectif de score effectif pour `n` participants. */
export function effectiveTarget(rules: Rules, n: number): number {
  if (rules.targetScore > 0) return rules.targetScore
  return Math.max(5, 10 * (n - 1))
}

/** Dimensions logiques de l'arène (ratio 4:3), plus grande avec plus de joueurs en mode auto. */
export function arenaDimensions(size: ArenaSize, players: number): { w: number; h: number } {
  const scale =
    size === 'small'
      ? 0.8
      : size === 'medium'
        ? 1
        : size === 'large'
          ? 1.3
          : 0.85 + 0.05 * Math.max(2, Math.min(12, players))
  return { w: Math.round(1200 * scale), h: Math.round(900 * scale) }
}
