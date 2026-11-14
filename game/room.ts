import { randomBytes } from 'node:crypto'
import { FRAME_STRIDE, MAX_PLAYERS, NAME_MAX, PALETTE, TICK_RATE } from '../shared/constants'
import type {
  Frame,
  HostAction,
  InputPacket,
  LinkPath,
  LobbyPlayer,
  MeState,
  Phase,
  RoomState,
  RoundStart,
  TunnelInfo,
} from '../shared/protocol'
import { sanitizeName } from '../shared/protocol'
import { DEFAULT_RULES, effectiveTarget, sanitizeRules, type Rules } from '../shared/rules'
import { BotBrain } from './bot'
import { Round } from './round'
import { gameWinners, pointsForDeaths, survivorBonus } from './scoring'
import type { RoomSnapshot } from './snapshot'

export interface PlayerRec {
  id: string
  token: string
  name: string
  color: string
  ready: boolean
  bot: boolean
  connId: string | null
  score: number
  roundPoints: number
  wins: number
  inGame: boolean
  /** Index dans la manche courante, -1 si spectateur. */
  idx: number
  input: number
  brain: BotBrain | null
  rtt: number | null
  jitter: number | null
  inputCount: number
  inputsPerSec: number
  /** Dernier numéro de commande appliqué (les copies et retards sont ignorés). */
  lastSeq: number
  path: LinkPath | null
  rtcRtt: number | null
  /** Échantillons récents de l'aller téléphone → serveur (ms). */
  uplink: number[]
  uplinkP50: number | null
  uplinkP95: number | null
  /** Commandes nouvelles arrivées d'abord par le DataChannel / le WebSocket. */
  firstRtc: number
  firstWs: number
}

function percentile(values: number[], q: number): number | null {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b)
  return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * q))]! * 10) / 10
}

/** Ce dont un salon a besoin du serveur : envoi de messages et contexte. */
export interface RoomContext {
  toHosts(code: string, data: string): void
  toPlayer(connId: string, data: string): void
  /** Heure murale haute résolution (ms). */
  wallNow(): number
  lanUrls(): string[]
  tunnel(): TunnelInfo
  /** Graine des manches (injectable pour les tests). */
  seed(): number
}

export const token = (bytes = 18) => randomBytes(bytes).toString('base64url')

function blankPlayer(base: Pick<PlayerRec, 'id' | 'token' | 'name' | 'color' | 'bot'>): PlayerRec {
  return {
    ...base,
    ready: false,
    connId: null,
    score: 0,
    roundPoints: 0,
    wins: 0,
    inGame: false,
    idx: -1,
    input: 0,
    brain: null,
    rtt: null,
    jitter: null,
    inputCount: 0,
    inputsPerSec: 0,
    lastSeq: -1,
    path: null,
    rtcRtt: null,
    uplink: [],
    uplinkP50: null,
    uplinkP95: null,
    firstRtc: 0,
    firstWs: 0,
  }
}

export class Room {
  readonly players = new Map<string, PlayerRec>()
  rules: Rules = sanitizeRules({}, DEFAULT_RULES)
  phase: Phase = 'lobby'
  pausedPhase: Phase | null = null
  roundNo = 0
  round: Round | null = null
  /** Id joueur par index de la manche courante. */
  roundIds: string[] = []
  phaseEnd: number | null = null
  /** Ticks restants de la phase au moment de la pause. */
  private pausedRemaining: number | null = null
  winners: string[] = []
  roundWinners: string[] = []
  tick = 0
  metaDirty = true
  meDirty = new Set<string>()
  lastActivity = 0
  private botCount = 0
  /** Marqueurs de latence : [idx, heure d'arrivée] des commandes en attente du prochain tick. */
  private inputMarks: number[] = []
  private lastRoundAwards = new Map<string, number>()
  private lastRoundWinner: string | null = null

  constructor(
    readonly code: string,
    readonly secret: string,
    private readonly ctx: RoomContext,
  ) {}

  // ─── Joueurs ───────────────────────────────────────────────────────────────

  takenColors(except?: string): string[] {
    return [...this.players.values()].filter(p => p.id !== except).map(p => p.color)
  }

  private freeColor(wanted?: string, except?: string): string | null {
    const taken = new Set(this.takenColors(except))
    if (wanted && PALETTE.some(c => c.id === wanted) && !taken.has(wanted)) return wanted
    return PALETTE.find(c => !taken.has(c.id))?.id ?? null
  }

  private uniqueName(name: string, except?: string): string {
    const names = new Set(
      [...this.players.values()].filter(p => p.id !== except).map(p => p.name.toLowerCase()),
    )
    if (!names.has(name.toLowerCase())) return name
    for (let i = 2; ; i++) {
      const candidate = `${name.slice(0, NAME_MAX - 2)} ${i}`
      if (!names.has(candidate.toLowerCase())) return candidate
    }
  }

  isFull(): boolean {
    return this.players.size >= MAX_PLAYERS
  }

  addPlayer(rawName: string, color: string | undefined, bot = false): PlayerRec | null {
    if (this.isFull()) return null
    const name = sanitizeName(rawName, NAME_MAX)
    if (!name) return null
    const c = this.freeColor(color)
    if (!c) return null
    const p = blankPlayer({
      id: token(6),
      token: token(),
      name: this.uniqueName(name),
      color: c,
      bot,
    })
    p.ready = bot
    this.players.set(p.id, p)
    this.touch()
    return p
  }

  findByToken(tok: string): PlayerRec | null {
    for (const p of this.players.values()) if (!p.bot && p.token === tok) return p
    return null
  }

  setProfile(id: string, name?: string, color?: string): void {
    const p = this.players.get(id)
    if (!p) return
    if (name !== undefined) {
      const clean = sanitizeName(name, NAME_MAX)
      if (clean) p.name = this.uniqueName(clean, id)
    }
    // la couleur ne change pas pendant une manche (identification à l'écran)
    if (color !== undefined && p.idx < 0) {
      const c = this.freeColor(color, id)
      if (c === color) p.color = c
    }
    this.touch(id)
  }

  setReady(id: string, ready: boolean): void {
    const p = this.players.get(id)
    if (!p) return
    p.ready = ready
    this.touch(id)
  }

  setConnected(id: string, connId: string | null): void {
    const p = this.players.get(id)
    if (!p) return
    p.connId = connId
    // nouvelle session : la numérotation des commandes du téléphone repart
    p.lastSeq = -1
    p.path = connId ? 'ws' : null
    p.rtcRtt = null
    if (!connId) {
      // commande neutralisée à la déconnexion : la tête continue tout droit
      this.setInput(id, 0, this.ctx.wallNow())
      p.rtt = null
      p.jitter = null
    }
    this.touch(id)
  }

  setPath(id: string, path: LinkPath): void {
    const p = this.players.get(id)
    if (!p || p.path === path) return
    p.path = path
    if (path === 'ws') p.rtcRtt = null
    this.touch(id)
  }

  /**
   * Commande reçue d'un téléphone, par le DataChannel ou le WebSocket. La
   * première copie d'un numéro gagne ; les copies suivantes et les commandes
   * plus anciennes (réordonnancement UDP) sont ignorées.
   */
  applyInput(id: string, pkt: InputPacket, arrival: number, via: 'rtc' | 'ws'): boolean {
    const p = this.players.get(id)
    if (!p) return false
    if (pkt.seq >= 0) {
      if (pkt.seq <= p.lastSeq) return false
      p.lastSeq = pkt.seq
      if (via === 'rtc') p.firstRtc++
      else p.firstWs++
      if (pkt.touch > 0) {
        const up = arrival - pkt.touch
        // écart d'horloge résiduel : on écarte les valeurs absurdes
        if (up > -20 && up < 5000) {
          p.uplink.push(Math.max(0, up))
          if (p.uplink.length > 64) p.uplink.shift()
        }
      }
    }
    this.setInput(id, pkt.bits, arrival, pkt.touch)
    return true
  }

  setInput(id: string, bits: number, arrival: number, touch = 0): void {
    const p = this.players.get(id)
    if (!p || p.input === bits) return
    p.input = bits
    p.inputCount++
    if (this.round && p.idx >= 0) {
      this.round.setInput(p.idx, bits)
      if (this.phase === 'playing')
        this.inputMarks.push(p.idx, Math.round(arrival * 10) / 10, Math.round(touch * 10) / 10)
    }
  }

  /** Statistiques d'aller (appelé chaque seconde). */
  refreshUplinkStats(): void {
    for (const p of this.players.values()) {
      const p50 = percentile(p.uplink, 0.5)
      const p95 = percentile(p.uplink, 0.95)
      if (p50 !== p.uplinkP50) this.touch(p.id)
      p.uplinkP50 = p50
      p.uplinkP95 = p95
    }
  }

  removePlayer(id: string): void {
    const p = this.players.get(id)
    if (!p) return
    if (this.round && p.idx >= 0) this.round.forceKill(p.idx)
    this.players.delete(id)
    this.touch()
  }

  addBot(): PlayerRec | null {
    this.botCount++
    const p = this.addPlayer(`Bot ${this.botCount}`, undefined, true)
    if (p) p.connId = null
    return p
  }

  removeBot(): void {
    const bots = [...this.players.values()].filter(p => p.bot)
    const last = bots[bots.length - 1]
    if (last) this.removePlayer(last.id)
  }

  /** Marque l'état comme modifié (hôtes + un joueur ou tous). */
  touch(id?: string): void {
    this.metaDirty = true
    if (id) this.meDirty.add(id)
    else for (const p of this.players.values()) this.meDirty.add(p.id)
  }

  // ─── Actions hôte ──────────────────────────────────────────────────────────

  hostAction(a: HostAction): void {
    switch (a.t) {
      case 'rules':
        this.rules = sanitizeRules(a.rules, this.rules)
        break
      case 'start':
        if (this.phase === 'lobby' || this.phase === 'gameOver') this.startGame()
        break
      case 'pause':
        if (this.phase === 'countdown' || this.phase === 'playing') {
          this.pausedPhase = this.phase
          this.pausedRemaining =
            this.phaseEnd !== null ? Math.max(0, this.phaseEnd - this.tick) : null
          this.phase = 'paused'
          this.phaseEnd = null
        }
        break
      case 'resume':
        if (this.phase === 'paused') {
          // reprise toujours précédée d'un court compte à rebours (les joueurs se replacent)
          const remaining = this.pausedPhase === 'countdown' ? (this.pausedRemaining ?? 0) : 0
          this.phase = 'countdown'
          this.phaseEnd = this.tick + Math.max(remaining, Math.round(1.5 * TICK_RATE))
          this.pausedPhase = null
          this.pausedRemaining = null
        }
        break
      case 'next':
        if (this.phase === 'roundEnd') this.beginRound()
        break
      case 'restartRound':
        if (this.round && this.phase !== 'lobby' && this.phase !== 'gameOver') this.restartRound()
        break
      case 'newGame':
        this.toLobby()
        break
      case 'endGame':
        if (this.phase !== 'lobby' && this.phase !== 'gameOver') {
          this.phase = 'gameOver'
          this.phaseEnd = null
          this.pausedPhase = null
          this.winners = this.leaders()
        }
        break
      case 'kick':
        this.removePlayer(a.id)
        break
      case 'addBot':
        this.addBot()
        break
      case 'removeBot':
        this.removeBot()
        break
    }
    this.touch()
  }

  private leaders(): string[] {
    const inGame = [...this.players.values()].filter(p => p.inGame)
    const top = Math.max(...inGame.map(p => p.score))
    return inGame.filter(p => p.score === top).map(p => p.id)
  }

  private toLobby(): void {
    this.phase = 'lobby'
    this.phaseEnd = null
    this.pausedPhase = null
    this.round = null
    this.roundIds = []
    this.roundNo = 0
    this.winners = []
    this.roundWinners = []
    for (const p of this.players.values()) {
      p.score = 0
      p.roundPoints = 0
      p.wins = 0
      p.inGame = false
      p.idx = -1
    }
  }

  /** Participants : bots et joueurs connectés prêts. */
  private eligible(p: PlayerRec): boolean {
    return p.bot || (p.ready && p.connId !== null)
  }

  startGame(): boolean {
    const participants = [...this.players.values()].filter(p => this.eligible(p))
    if (!participants.length) return false
    this.toLobby()
    for (const p of participants) p.inGame = true
    this.beginRound()
    return true
  }

  private beginRound(): void {
    // les retardataires prêts rejoignent la partie à la manche suivante
    for (const p of this.players.values()) if (!p.inGame && this.eligible(p)) p.inGame = true
    const roster = [...this.players.values()].filter(p => p.inGame && (p.bot || p.connId !== null))
    if (!roster.length) {
      this.toLobby()
      return
    }
    this.roundNo++
    for (const p of this.players.values()) {
      p.idx = -1
      p.roundPoints = 0
    }
    this.roundIds = roster.map(p => p.id)
    this.round = new Round({ rules: this.rules, players: roster.length, seed: this.ctx.seed() })
    roster.forEach((p, i) => {
      p.idx = i
      p.brain = p.bot ? new BotBrain(i, undefined, this.roundNo) : null
      this.round!.setInput(i, p.bot ? 0 : p.input)
    })
    this.inputMarks = []
    this.lastRoundAwards = new Map()
    this.lastRoundWinner = null
    this.roundWinners = []
    this.phase = 'countdown'
    this.phaseEnd = this.tick + this.rules.countdown * TICK_RATE
    this.ctx.toHosts(this.code, JSON.stringify(this.roundStart()))
    this.touch()
  }

  private restartRound(): void {
    for (const [id, pts] of this.lastRoundAwards) {
      const p = this.players.get(id)
      if (p) p.score -= pts
    }
    if (this.lastRoundWinner) {
      const w = this.players.get(this.lastRoundWinner)
      if (w) w.wins--
    }
    this.roundNo--
    this.pausedPhase = null
    this.beginRound()
  }

  // ─── Boucle ────────────────────────────────────────────────────────────────

  update(tick: number): void {
    this.tick = tick
    switch (this.phase) {
      case 'countdown':
        if (this.phaseEnd !== null && tick >= this.phaseEnd) {
          this.phase = 'playing'
          this.phaseEnd = null
          this.touch()
        }
        break
      case 'playing':
        this.stepRound()
        break
      case 'roundEnd':
        if (this.phaseEnd !== null && tick >= this.phaseEnd) this.beginRound()
        break
    }
  }

  private award(id: string, pts: number): void {
    const p = this.players.get(id)
    if (!p || pts === 0) return
    p.score += pts
    p.roundPoints += pts
    this.lastRoundAwards.set(id, (this.lastRoundAwards.get(id) ?? 0) + pts)
  }

  private stepRound(): void {
    const round = this.round
    if (!round) return
    for (const id of this.roundIds) {
      const p = this.players.get(id)
      if (p?.brain && p.idx >= 0) round.setInput(p.idx, p.brain.decide(round))
    }
    round.step()

    const scoring = round.deaths.filter(d => d.cause !== 'left')
    if (round.deaths.length) {
      const aliveAfter = round.players.map((p, i) => (p.alive ? i : -1)).filter(i => i >= 0)
      for (const [idx, pts] of pointsForDeaths(scoring.length, aliveAfter, this.rules))
        this.award(this.roundIds[idx]!, pts)
      for (const d of round.deaths) this.meDirty.add(this.roundIds[d.idx]!)
      this.metaDirty = true
      for (const id of this.roundIds) this.meDirty.add(id)
    }
    for (const idx of round.effectsChanged) {
      const id = this.roundIds[idx]
      if (id) this.meDirty.add(id)
    }

    const frame: Frame = { t: 'f', k: round.tick, p: round.heads() }
    if (round.events.length) frame.ev = round.events
    if (this.inputMarks.length) {
      frame.in = this.inputMarks
      this.inputMarks = []
    }
    this.ctx.toHosts(this.code, JSON.stringify(frame))

    if (round.isOver()) this.endRound()
  }

  private endRound(): void {
    const round = this.round!
    const aliveIdx = round.players.map((p, i) => (p.alive ? i : -1)).filter(i => i >= 0)
    const bonus = survivorBonus(aliveIdx, round.players.length, this.rules)
    if (bonus) this.award(this.roundIds[bonus.idx]!, bonus.points)
    this.roundWinners = aliveIdx.map(i => this.roundIds[i]!)
    if (aliveIdx.length === 1 && round.players.length >= 2) {
      const w = this.players.get(this.roundIds[aliveIdx[0]!]!)
      if (w) {
        w.wins++
        this.lastRoundWinner = w.id
      }
    }
    const scores = new Map(
      [...this.players.values()].filter(p => p.inGame).map(p => [p.id, p.score] as const),
    )
    const winners = gameWinners(scores, this.roundNo, this.rules)
    if (winners) {
      this.phase = 'gameOver'
      this.phaseEnd = null
      this.winners = winners
    } else {
      this.phase = 'roundEnd'
      this.phaseEnd = this.rules.autoNextRound
        ? this.tick + Math.round(this.rules.roundEndDelay * TICK_RATE)
        : null
    }
    this.touch()
  }

  // ─── Messages ──────────────────────────────────────────────────────────────

  target(): number {
    const n = [...this.players.values()].filter(p => p.inGame).length || this.players.size
    return effectiveTarget(this.rules, n)
  }

  private remainingMs(): number | null {
    return this.phaseEnd === null
      ? null
      : Math.max(0, Math.round(((this.phaseEnd - this.tick) * 1000) / TICK_RATE))
  }

  lobbyPlayers(): LobbyPlayer[] {
    return [...this.players.values()].map(p => ({
      id: p.id,
      name: p.name,
      color: p.color,
      ready: p.ready,
      connected: p.bot || p.connId !== null,
      bot: p.bot,
      score: p.score,
      roundPoints: p.roundPoints,
      inGame: p.inGame,
      idx: p.idx,
      alive: p.idx >= 0 && !!this.round?.players[p.idx]?.alive,
      wins: p.wins,
      path: p.bot ? null : p.path,
      uplinkMs: p.uplinkP50,
    }))
  }

  roomState(): RoomState {
    return {
      t: 'room',
      code: this.code,
      phase: this.phase,
      pausedPhase: this.pausedPhase,
      round: this.roundNo,
      rules: this.rules,
      target: this.target(),
      players: this.lobbyPlayers(),
      phaseRemainingMs: this.remainingMs(),
      winners: this.winners,
      roundWinners: this.roundWinners,
      lanUrls: this.ctx.lanUrls(),
      tunnel: this.ctx.tunnel(),
    }
  }

  meState(id: string): MeState | null {
    const p = this.players.get(id)
    if (!p) return null
    const rp = p.idx >= 0 ? this.round?.players[p.idx] : undefined
    const sorted = [...this.players.values()]
      .filter(q => q.inGame)
      .sort((a, b) => b.score - a.score)
    const rank = p.inGame ? sorted.findIndex(q => q.score === p.score) + 1 : 0
    return {
      t: 'me',
      id: p.id,
      code: this.code,
      name: p.name,
      color: p.color,
      ready: p.ready,
      phase: this.phase,
      pausedPhase: this.pausedPhase,
      round: this.roundNo,
      score: p.score,
      roundPoints: p.roundPoints,
      rank,
      playerCount: sorted.length,
      inGame: p.inGame,
      inRound: p.idx >= 0,
      alive: !!rp?.alive,
      effects: rp && this.round ? this.round.activeEffects(p.idx) : [],
      shield: rp?.shield ?? 0,
      rtt: p.path && p.path !== 'ws' && p.rtcRtt !== null ? p.rtcRtt : p.rtt,
      path: p.path,
      uplinkMs: p.uplinkP50,
      takenColors: this.takenColors(id),
      phaseRemainingMs: this.remainingMs(),
      winners: this.winners,
      mode: this.rules.mode,
    }
  }

  /** Début de manche, ou réhydratation d'un écran qui se (re)connecte en cours de manche. */
  roundStart(): RoundStart | null {
    const round = this.round
    if (!round) return null
    return {
      t: 'round',
      round: this.roundNo,
      arena: { w: round.w, h: round.h },
      players: this.roundIds.map(id => {
        const p = this.players.get(id)
        return { id, name: p?.name ?? '?', color: p?.color ?? 'blanc' }
      }),
      p: round.heads(),
      bonuses: round.bonuses,
      strokes: round.trails.toStrokes(),
      tick: round.tick,
    }
  }

  // ─── Sauvegarde ────────────────────────────────────────────────────────────

  /**
   * État à restaurer après un redémarrage du serveur. Une manche entamée
   * (compte à rebours, jeu, pause) ne peut pas reprendre : elle est annulée,
   * ses points retirés, et l'écran repart sur « manche suivante » — ou sur le
   * salon si c'était la première.
   */
  snapshot(): RoomSnapshot {
    const live = this.phase === 'countdown' || this.phase === 'playing' || this.phase === 'paused'
    const roundNo = live ? this.roundNo - 1 : this.roundNo
    const phase = live ? (roundNo > 0 ? 'roundEnd' : 'lobby') : this.phase
    return {
      code: this.code,
      secret: this.secret,
      rules: this.rules,
      phase,
      roundNo: phase === 'lobby' ? 0 : roundNo,
      winners: phase === 'gameOver' ? this.winners : [],
      botCount: this.botCount,
      players: [...this.players.values()].map(p => ({
        id: p.id,
        token: p.token,
        name: p.name,
        color: p.color,
        ready: p.ready,
        bot: p.bot,
        score: phase === 'lobby' ? 0 : live ? p.score - p.roundPoints : p.score,
        wins: phase === 'lobby' ? 0 : p.wins,
        inGame: phase === 'lobby' ? false : p.inGame,
      })),
    }
  }

  /** Salon recréé depuis un instantané : joueurs déconnectés, en attente de leur reconnexion. */
  static restore(snap: RoomSnapshot, ctx: RoomContext, tick: number): Room {
    const room = new Room(snap.code, snap.secret, ctx)
    room.rules = sanitizeRules(snap.rules, DEFAULT_RULES)
    room.phase = snap.phase
    room.roundNo = snap.roundNo
    room.winners = snap.winners
    room.botCount = snap.botCount
    room.tick = tick
    for (const s of snap.players.slice(0, MAX_PLAYERS)) {
      if (room.players.has(s.id)) continue
      const p = blankPlayer({ id: s.id, token: s.token, name: s.name, color: s.color, bot: s.bot })
      p.ready = s.ready
      p.score = s.score
      p.wins = s.wins
      p.inGame = s.inGame
      room.players.set(p.id, p)
    }
    room.touch()
    return room
  }

  static readonly STRIDE = FRAME_STRIDE
}
