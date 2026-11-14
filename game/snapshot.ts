import type { Phase } from '../shared/protocol'
import type { Rules } from '../shared/rules'

/**
 * Instantané des salons, écrit sur disque pour qu'un redémarrage du serveur
 * (mise à jour, plantage) passe inaperçu : même code de salon, mêmes scores,
 * chaque téléphone se reconnecte avec son jeton.
 *
 * Une manche en cours n'est pas sauvegardée (traces, positions) : elle est
 * annulée — points déjà marqués retirés — et l'écran propose de la rejouer.
 */
export const SNAPSHOT_VERSION = 1

export interface PlayerSnapshot {
  id: string
  token: string
  name: string
  color: string
  ready: boolean
  bot: boolean
  score: number
  wins: number
  inGame: boolean
}

export interface RoomSnapshot {
  code: string
  secret: string
  rules: Rules
  phase: Phase
  roundNo: number
  winners: string[]
  botCount: number
  players: PlayerSnapshot[]
}

export interface ServerSnapshot {
  v: number
  /** Heure murale de l'écriture (ms) : un instantané trop vieux est ignoré. */
  savedAt: number
  rooms: RoomSnapshot[]
}

/** Persistance de l'instantané (fichier en production, mémoire dans les tests). */
export interface StateStore {
  load(): ServerSnapshot | null
  save(snapshot: ServerSnapshot): void
}

const isStr = (v: unknown): v is string => typeof v === 'string'
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const PHASES: Phase[] = ['lobby', 'countdown', 'playing', 'paused', 'roundEnd', 'gameOver']

function validPlayer(p: unknown): p is PlayerSnapshot {
  const o = p as Record<string, unknown> | null
  return (
    !!o &&
    isStr(o.id) &&
    isStr(o.token) &&
    isStr(o.name) &&
    isStr(o.color) &&
    typeof o.ready === 'boolean' &&
    typeof o.bot === 'boolean' &&
    isNum(o.score) &&
    isNum(o.wins) &&
    typeof o.inGame === 'boolean'
  )
}

/** Salons valides d'un instantané lu sur disque (fichier tronqué, édité, ancienne version…). */
export function validRooms(raw: unknown): RoomSnapshot[] {
  const s = raw as Partial<ServerSnapshot> | null
  if (!s || s.v !== SNAPSHOT_VERSION || !Array.isArray(s.rooms)) return []
  return s.rooms.filter((r): r is RoomSnapshot => {
    const o = r as unknown as Record<string, unknown> | null
    return (
      !!o &&
      isStr(o.code) &&
      /^[A-Z]{2,8}$/.test(o.code) &&
      isStr(o.secret) &&
      PHASES.includes(o.phase as Phase) &&
      isNum(o.roundNo) &&
      Array.isArray(o.winners) &&
      o.winners.every(isStr) &&
      isNum(o.botCount) &&
      Array.isArray(o.players) &&
      o.players.every(validPlayer)
    )
  })
}
