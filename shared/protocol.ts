/**
 * Protocole. Deux transports pour un même téléphone :
 * - WebSocket `/_ws` (fiable, passe par le tunnel) : signalisation, états, et
 *   copie de secours de chaque commande ;
 * - WebRTC DataChannel `in` (UDP, non ordonné, sans retransmission) : chemin
 *   rapide des commandes, en direct sur le réseau local quand c'est possible.
 *
 * Messages texte du chemin critique (identiques sur les deux transports) :
 *   téléphone → serveur  `i<bits>,<seq>,<t>`  état des touches (bit 1 = gauche, bit 2 = droite),
 *                                             numéro croissant (la 1re copie reçue gagne),
 *                                             heure du toucher sur l'horloge serveur (0 si inconnue).
 *                                             Forme courte `i<bits>` acceptée.
 *   serveur → client     `P<seq>`             ping ; réponse `Q<seq>` immédiate
 *   téléphone → serveur  `s<t0>`              synchronisation d'horloge ; réponse `S<t0>,<heure serveur>`
 *
 * Tout le reste est du JSON `{ t: <type>, ... }`, validé côté serveur.
 */
import type { BonusKind, EffectKind, Rules } from './rules'

export type Phase = 'lobby' | 'countdown' | 'playing' | 'paused' | 'roundEnd' | 'gameOver'

// ─── Client → serveur ────────────────────────────────────────────────────────

export type HostAction =
  | { t: 'rules'; rules: Partial<Rules> }
  | { t: 'start' }
  | { t: 'pause' }
  | { t: 'resume' }
  | { t: 'next' }
  | { t: 'restartRound' }
  | { t: 'newGame' }
  | { t: 'endGame' }
  | { t: 'kick'; id: string }
  | { t: 'addBot' }
  | { t: 'removeBot' }

export type ClientMessage =
  | { t: 'host'; code?: string; secret?: string; fresh?: boolean }
  | { t: 'join'; code: string; token?: string; name?: string; color?: string }
  | { t: 'ready'; ready: boolean }
  | { t: 'profile'; name?: string; color?: string }
  | { t: 'leave' }
  | { t: 'rtc'; kind: 'offer'; sdp: string }
  | { t: 'rtc'; kind: 'cand'; cand: string; mid: string }
  | HostAction

/** Chemin effectif des commandes d'un joueur. */
export type LinkPath = 'lan' | 'direct' | 'relay' | 'ws'

/** Format `RTCIceServer` du navigateur. */
export interface IceServerConfig {
  urls: string | string[]
  username?: string
  credential?: string
}

// ─── Serveur → client ────────────────────────────────────────────────────────

export interface LobbyPlayer {
  id: string
  name: string
  color: string
  ready: boolean
  connected: boolean
  bot: boolean
  score: number
  /** Points gagnés pendant la manche courante / dernière manche. */
  roundPoints: number
  /** Participe à la partie en cours. */
  inGame: boolean
  /** Index dans la manche courante (-1 si spectateur). */
  idx: number
  alive: boolean
  wins: number
  path: LinkPath | null
  /** Aller seul téléphone → serveur, médiane récente (ms). */
  uplinkMs: number | null
}

export interface TunnelInfo {
  provider: string
  status: 'off' | 'starting' | 'up' | 'down'
  url: string | null
  error?: string
}

export interface RoomState {
  t: 'room'
  code: string
  phase: Phase
  /** Phase en pause : celle qui reprendra. */
  pausedPhase: Phase | null
  round: number
  rules: Rules
  target: number
  players: LobbyPlayer[]
  /** Millisecondes restantes avant la fin de la phase (compte à rebours, enchaînement). */
  phaseRemainingMs: number | null
  winners: string[]
  /** Gagnant(s) de la dernière manche. */
  roundWinners: string[]
  lanUrls: string[]
  tunnel: TunnelInfo
}

export interface RoundPlayerInfo {
  id: string
  name: string
  color: string
}

export interface BonusItem {
  id: number
  kind: BonusKind
  x: number
  y: number
}

/** Envoyé à l'hôte au début d'une manche, ou à la (re)connexion en cours de manche. */
export interface RoundStart {
  t: 'round'
  round: number
  arena: { w: number; h: number }
  players: RoundPlayerInfo[]
  /** État courant des têtes, même format que `Frame.p`. */
  p: number[]
  bonuses: BonusItem[]
  /** Traces existantes : polylignes `[owner, width, n, x0, y0, …]` concaténées. */
  strokes: number[]
  tick: number
}

export type FrameEvent =
  | { e: 'death'; i: number; x: number; y: number; cause: 'wall' | 'trail' | 'head' | 'left' }
  | { e: 'spawn'; b: BonusItem }
  | { e: 'take'; id: number; i: number; kind: BonusKind }
  | { e: 'erase'; x: number; y: number; r: number }
  | { e: 'shield'; i: number }

/** Une trame par tick de simulation, envoyée à l'hôte. */
export interface Frame {
  t: 'f'
  /** Numéro de tick de la manche. */
  k: number
  /** Par tête : x, y, angle, épaisseur, flags (FRAME_STRIDE valeurs). */
  p: number[]
  ev?: FrameEvent[]
  /**
   * Commandes appliquées pendant ce tick, par triplets `[index, arrivée, toucher]` :
   * heure d'arrivée au serveur et heure du toucher ramenée sur l'horloge serveur
   * (0 si inconnue), en ms d'horloge murale. L'écran hôte, sur la même machine,
   * en déduit arrivée → image et toucher → image.
   */
  in?: number[]
}

export interface PlayerDiag {
  id: string
  /** RTT WebSocket (ms). */
  rtt: number | null
  jitter: number | null
  /** RTT DataChannel (ms), si ouvert. */
  rtcRtt: number | null
  connected: boolean
  inputsPerSec: number
  path: LinkPath | null
  uplinkP50: number | null
  uplinkP95: number | null
  /** Part des commandes arrivées d'abord par le DataChannel (0–1). */
  rtcFirstRatio: number | null
}

export interface ServerDiag {
  t: 'diag'
  tickRate: number
  /** Ticks réellement simulés sur la dernière seconde. */
  ticksLastSec: number
  stepAvgMs: number
  stepMaxMs: number
  /** Retard du minuteur par rapport à l'échéance du tick (moyenne, max). */
  lateAvgMs: number
  lateMaxMs: number
  connections: number
  msgInPerSec: number
  msgOutPerSec: number
  players: PlayerDiag[]
  uptimeSec: number
  memMb: number
}

export interface MeState {
  t: 'me'
  id: string
  code: string
  name: string
  color: string
  ready: boolean
  phase: Phase
  pausedPhase: Phase | null
  round: number
  score: number
  roundPoints: number
  rank: number
  playerCount: number
  inGame: boolean
  /** Participe à la manche en cours (sinon : spectateur jusqu'à la suivante). */
  inRound: boolean
  alive: boolean
  effects: EffectKind[]
  shield: number
  rtt: number | null
  path: LinkPath | null
  uplinkMs: number | null
  takenColors: string[]
  phaseRemainingMs: number | null
  winners: string[]
  mode: Rules['mode']
}

export type ServerMessage =
  | RoomState
  | RoundStart
  | Frame
  | ServerDiag
  | MeState
  | { t: 'hosted'; code: string; secret: string }
  | { t: 'joined'; id: string; token: string; code: string; iceServers: IceServerConfig[] | null }
  | { t: 'rtc'; kind: 'answer'; sdp: string }
  | { t: 'rtc'; kind: 'cand'; cand: string; mid: string }
  | { t: 'error'; code: ErrorCode; message: string }
  | { t: 'kicked' }
  | { t: 'replaced' }
  /** Le serveur redémarre (mise à jour) : se reconnecter, la partie reprend. */
  | { t: 'restarting' }

export type ErrorCode =
  | 'BAD_MESSAGE'
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'NAME_INVALID'
  | 'NOT_LOCAL'
  | 'FORBIDDEN'
  | 'BAD_TOKEN'
  | 'RATE_LIMIT'

// ─── Validation des messages entrants ────────────────────────────────────────

const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max

/** Valide un message JSON reçu ; renvoie `null` si le format est incorrect. */
export function parseClientMessage(raw: string): ClientMessage | null {
  if (raw.length > 16_384) return null
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const m = data as Record<string, unknown>
  switch (m.t) {
    case 'host':
      if (m.code !== undefined && !isStr(m.code, 8)) return null
      if (m.secret !== undefined && !isStr(m.secret, 128)) return null
      return {
        t: 'host',
        code: m.code as string,
        secret: m.secret as string,
        fresh: m.fresh === true,
      }
    case 'join':
      if (!isStr(m.code, 8)) return null
      if (m.token !== undefined && !isStr(m.token, 128)) return null
      if (m.name !== undefined && !isStr(m.name, 64)) return null
      if (m.color !== undefined && !isStr(m.color, 32)) return null
      return {
        t: 'join',
        code: m.code,
        token: m.token as string,
        name: m.name as string,
        color: m.color as string,
      }
    case 'ready':
      return typeof m.ready === 'boolean' ? { t: 'ready', ready: m.ready } : null
    case 'profile':
      if (m.name !== undefined && !isStr(m.name, 64)) return null
      if (m.color !== undefined && !isStr(m.color, 32)) return null
      return { t: 'profile', name: m.name as string, color: m.color as string }
    case 'rules':
      return m.rules && typeof m.rules === 'object'
        ? { t: 'rules', rules: m.rules as Partial<Rules> }
        : null
    case 'rtc':
      if (m.kind === 'offer')
        return isStr(m.sdp, 16_000) ? { t: 'rtc', kind: 'offer', sdp: m.sdp } : null
      if (m.kind === 'cand' && isStr(m.cand, 512) && isStr(m.mid, 32))
        return { t: 'rtc', kind: 'cand', cand: m.cand, mid: m.mid }
      return null
    case 'kick':
      return isStr(m.id, 64) ? { t: 'kick', id: m.id } : null
    case 'leave':
    case 'start':
    case 'pause':
    case 'resume':
    case 'next':
    case 'restartRound':
    case 'newGame':
    case 'endGame':
    case 'addBot':
    case 'removeBot':
      return { t: m.t } as ClientMessage
    default:
      return null
  }
}

/** Nettoie un pseudo : espaces normalisés, caractères de contrôle retirés, longueur bornée. */
export function sanitizeName(name: string, max: number): string {
  return name
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

export interface InputPacket {
  bits: number
  /** -1 : forme courte sans numéro (toujours appliquée). */
  seq: number
  /** Heure du toucher sur l'horloge serveur, 0 si inconnue. */
  touch: number
}

const INPUT_RE = /^i([0-3])(?:,(\d{1,15})(?:,(\d{1,16}(?:\.\d{1,3})?))?)?$/

/** Décode `i<bits>` ou `i<bits>,<seq>,<t>` ; `null` si invalide. */
export function parseInput(data: string): InputPacket | null {
  if (data.length > 48) return null
  const m = INPUT_RE.exec(data)
  if (!m) return null
  return {
    bits: Number(m[1]),
    seq: m[2] === undefined ? -1 : Number(m[2]),
    touch: m[3] === undefined ? 0 : Number(m[3]),
  }
}
