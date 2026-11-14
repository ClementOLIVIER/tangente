import { effectiveTarget, type Rules } from '../shared/rules'

/**
 * Points d'un tick d'éliminations : chaque survivant (vivant après le tick)
 * gagne `pointsPerDeath` par tête éliminée. Les têtes éliminées pendant le même
 * tick ne se rapportent rien entre elles.
 */
export function pointsForDeaths(
  deadCount: number,
  aliveAfter: readonly number[],
  rules: Pick<Rules, 'pointsPerDeath'>,
): Map<number, number> {
  const out = new Map<number, number>()
  if (deadCount <= 0) return out
  for (const idx of aliveAfter) out.set(idx, deadCount * rules.pointsPerDeath)
  return out
}

/** Bonus du dernier survivant (fin de manche avec exactement un survivant). */
export function survivorBonus(
  aliveAtEnd: readonly number[],
  participants: number,
  rules: Pick<Rules, 'survivorBonus'>,
) {
  if (participants < 2 || aliveAtEnd.length !== 1 || rules.survivorBonus <= 0) return null
  return { idx: aliveAtEnd[0]!, points: rules.survivorBonus }
}

/**
 * Partie terminée ? Renvoie les gagnants (ex æquo possibles) ou `null`.
 * - `score` : un joueur atteint l'objectif, avec 2 points d'avance si `winByTwo` ;
 * - `rounds` : le nombre de manches est atteint ; meilleur(s) score(s).
 */
export function gameWinners(
  scores: ReadonlyMap<string, number>,
  roundsPlayed: number,
  rules: Pick<Rules, 'endCondition' | 'targetScore' | 'winByTwo' | 'rounds'>,
): string[] | null {
  const entries = [...scores.entries()].sort((a, b) => b[1] - a[1])
  if (!entries.length) return null
  const top = entries[0]![1]
  const leaders = entries.filter(([, s]) => s === top).map(([id]) => id)
  if (rules.endCondition === 'rounds') return roundsPlayed >= rules.rounds ? leaders : null
  const target = effectiveTarget(rules as Rules, entries.length)
  if (top < target) return null
  if (!rules.winByTwo) return leaders
  const second = entries[1]?.[1] ?? -Infinity
  return top - second >= 2 ? leaders : null
}
