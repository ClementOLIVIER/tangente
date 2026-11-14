import { randomInt } from 'node:crypto'
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, TICK_MS, TICK_RATE } from '../shared/constants'
import type {
  ClientMessage,
  ErrorCode,
  IceServerConfig,
  LinkPath,
  PlayerDiag,
  ServerDiag,
  TunnelInfo,
} from '../shared/protocol'
import { parseClientMessage, parseInput } from '../shared/protocol'
import { Room, token, type RoomContext } from './room'
import type { RtcFactory, RtcPeer } from './rtc'
import { SNAPSHOT_VERSION, validRooms, type ServerSnapshot, type StateStore } from './snapshot'

/**
 * Serveur de jeu indépendant du transport : l'adaptateur Nitro (crossws), les
 * tests et le banc de charge lui passent des `Conn`. Il possède l'horloge de
 * simulation (boucle à pas fixe) et route les messages vers les salons.
 */

export interface Conn {
  id: string
  /** Connexion locale (boucle locale, sans en-tête de proxy) : seule autorisée à créer un salon. */
  local: boolean
  send(data: string): void
  close(code?: number, reason?: string): void
}

interface ConnState {
  conn: Conn
  role: 'none' | 'host' | 'player'
  code: string | null
  playerId: string | null
  tokens: number
  tokensAt: number
  violations: number
  pingSeq: number
  pings: Map<number, number>
  lastPongAt: number
  rtt: number | null
  jitter: number | null
  // WebRTC (téléphones)
  rtc: RtcPeer | null
  rtcPath: LinkPath | null
  rtcTokens: number
  rtcTokensAt: number
  rtcPings: Map<number, number>
  rtcRtt: number | null
}

export interface GameServerOptions {
  /** Horloge monotone haute résolution (ms). */
  now?: () => number
  /** Horloge murale haute résolution (ms), partagée avec le navigateur hôte de la même machine. */
  wallNow?: () => number
  lanUrls?: () => string[]
  seed?: () => number
  /** Désactive les pings automatiques (tests). */
  pings?: boolean
  /** Pont WebRTC ; absent = WebSocket seul. */
  rtc?: RtcFactory | null
  /** Sauvegarde des salons (redémarrage transparent) ; absente = mémoire seule. */
  store?: StateStore | null
}

const PING_EVERY_TICKS = TICK_RATE // 1 s
const PONG_TIMEOUT_MS = 6000
const ROOM_IDLE_MS = 30 * 60 * 1000
const RATE_CAPACITY = 120
const RATE_REFILL_PER_MS = 60 / 1000
const MAX_VIOLATIONS = 400
// le DataChannel porte les commandes, leurs copies redondantes et un battement à 20 Hz
const RTC_RATE_CAPACITY = 400
const RTC_RATE_REFILL_PER_MS = 250 / 1000

export class GameServer {
  readonly rooms = new Map<string, Room>()
  readonly conns = new Map<string, ConnState>()
  tick = 0
  private tunnelInfo: TunnelInfo = { provider: 'none', status: 'off', url: null }
  private readonly now: () => number
  private readonly wallNow: () => number
  private readonly lanUrlsFn: () => string[]
  private readonly seedFn: () => number
  private readonly pingsEnabled: boolean
  private timer: ReturnType<typeof setTimeout> | null = null
  private startedAt: number
  private readonly rtcFactory: RtcFactory | null
  /** Serveurs ICE transmis aux téléphones (rafraîchis en tâche de fond). */
  private iceServers: IceServerConfig[] | null = null
  private readonly store: StateStore | null
  /** Un salon a changé depuis la dernière sauvegarde. */
  private persistDirty = false
  private persistFailed = false
  private closing = false
  /** Salons restaurés au démarrage. */
  readonly restored: string[] = []

  // statistiques (fenêtre d'une seconde)
  private stat = {
    steps: 0,
    stepSum: 0,
    stepMax: 0,
    lateSum: 0,
    lateMax: 0,
    lateN: 0,
    msgIn: 0,
    msgOut: 0,
  }
  private lastDiag: Omit<ServerDiag, 't' | 'players'> = {
    tickRate: TICK_RATE,
    ticksLastSec: 0,
    stepAvgMs: 0,
    stepMaxMs: 0,
    lateAvgMs: 0,
    lateMaxMs: 0,
    connections: 0,
    msgInPerSec: 0,
    msgOutPerSec: 0,
    uptimeSec: 0,
    memMb: 0,
  }

  constructor(opts: GameServerOptions = {}) {
    this.now = opts.now ?? (() => performance.now())
    this.wallNow = opts.wallNow ?? (() => performance.timeOrigin + performance.now())
    this.lanUrlsFn = opts.lanUrls ?? (() => [])
    this.seedFn = opts.seed ?? (() => randomInt(0, 2 ** 31))
    this.pingsEnabled = opts.pings ?? true
    this.startedAt = this.now()
    this.rtcFactory = opts.rtc ?? null
    this.store = opts.store ?? null
    this.restore()
    if (this.rtcFactory) {
      this.iceServers = []
      this.refreshIceServers()
    }
  }

  /** Recharge les serveurs ICE (identifiants TURN éphémères compris). */
  refreshIceServers(): Promise<void> {
    if (!this.rtcFactory) return Promise.resolve()
    return this.rtcFactory
      .clientIceServers()
      .then(list => {
        this.iceServers = list
      })
      .catch(() => {})
  }

  // ─── Connexions ────────────────────────────────────────────────────────────

  onOpen(conn: Conn): void {
    if (this.closing) {
      conn.close(1012, 'restart')
      return
    }
    this.conns.set(conn.id, {
      conn,
      role: 'none',
      code: null,
      playerId: null,
      tokens: RATE_CAPACITY,
      tokensAt: this.now(),
      violations: 0,
      pingSeq: 0,
      pings: new Map(),
      lastPongAt: this.now(),
      rtt: null,
      jitter: null,
      rtc: null,
      rtcPath: null,
      rtcTokens: RTC_RATE_CAPACITY,
      rtcTokensAt: this.now(),
      rtcPings: new Map(),
      rtcRtt: null,
    })
  }

  onClose(connId: string): void {
    const cs = this.conns.get(connId)
    if (!cs) return
    this.conns.delete(connId)
    this.closeRtc(cs)
    const room = cs.code ? this.rooms.get(cs.code) : undefined
    if (!room) return
    if (cs.role === 'player' && cs.playerId) {
      const p = room.players.get(cs.playerId)
      if (p && p.connId === connId) room.setConnected(p.id, null)
    }
    room.lastActivity = this.now()
  }

  private send(cs: ConnState, data: string): void {
    this.stat.msgOut++
    try {
      cs.conn.send(data)
    } catch {
      // connexion déjà fermée : la fermeture sera notifiée par l'adaptateur
    }
  }

  private error(cs: ConnState, code: ErrorCode, message: string): void {
    this.send(cs, JSON.stringify({ t: 'error', code, message }))
  }

  /** Seau à jetons : un client trop bavard voit ses messages ignorés, puis est déconnecté. */
  private allow(cs: ConnState): boolean {
    const now = this.now()
    cs.tokens = Math.min(RATE_CAPACITY, cs.tokens + (now - cs.tokensAt) * RATE_REFILL_PER_MS)
    cs.tokensAt = now
    if (cs.tokens >= 1) {
      cs.tokens--
      return true
    }
    if (++cs.violations > MAX_VIOLATIONS) cs.conn.close(1008, 'rate limit')
    return false
  }

  onMessage(connId: string, data: string): void {
    const cs = this.conns.get(connId)
    if (!cs) return
    this.stat.msgIn++
    if (!this.allow(cs)) return
    const c0 = data.charCodeAt(0)
    // chemin critique : commande `i…` (copie fiable de celle du DataChannel)
    if (c0 === 105 /* i */) {
      this.onInput(cs, data, 'ws')
      return
    }
    // réponse de ping `Q<seq>`
    if (c0 === 81 /* Q */) {
      this.onPong(cs, Number(data.slice(1)))
      return
    }
    // synchronisation d'horloge `s<t0>`
    if (c0 === 115 /* s */) {
      this.send(cs, this.syncReply(data))
      return
    }
    const msg = parseClientMessage(data)
    if (!msg) {
      this.error(cs, 'BAD_MESSAGE', 'Message invalide')
      return
    }
    this.handle(cs, msg)
  }

  private handle(cs: ConnState, msg: ClientMessage): void {
    switch (msg.t) {
      case 'host':
        return this.handleHost(cs, msg)
      case 'join':
        return this.handleJoin(cs, msg)
      case 'rtc':
        return this.handleRtc(cs, msg)
      case 'ready':
      case 'profile':
      case 'leave': {
        const room = cs.code ? this.rooms.get(cs.code) : undefined
        if (cs.role !== 'player' || !room || !cs.playerId)
          return this.error(cs, 'FORBIDDEN', 'Rejoignez un salon')
        if (msg.t === 'ready') room.setReady(cs.playerId, msg.ready)
        else if (msg.t === 'profile') room.setProfile(cs.playerId, msg.name, msg.color)
        else {
          room.removePlayer(cs.playerId)
          cs.role = 'none'
          cs.playerId = null
        }
        return
      }
      default: {
        const room = cs.code ? this.rooms.get(cs.code) : undefined
        if (cs.role !== 'host' || !room)
          return this.error(cs, 'FORBIDDEN', 'Action réservée à l’hôte')
        if (msg.t === 'kick') this.kickConn(room, msg.id)
        room.hostAction(msg)
      }
    }
  }

  private kickConn(room: Room, playerId: string): void {
    const p = room.players.get(playerId)
    if (!p?.connId) return
    const target = this.conns.get(p.connId)
    if (!target) return
    this.send(target, JSON.stringify({ t: 'kicked' }))
    target.role = 'none'
    target.playerId = null
  }

  private newCode(): string {
    for (;;) {
      let code = ''
      for (let i = 0; i < ROOM_CODE_LENGTH; i++)
        code += ROOM_CODE_ALPHABET[randomInt(0, ROOM_CODE_ALPHABET.length)]
      if (!this.rooms.has(code)) return code
    }
  }

  private roomContext(): RoomContext {
    return {
      toHosts: (c, data) => this.toHosts(c, data),
      toPlayer: (connId, data) => {
        const cs = this.conns.get(connId)
        if (cs) this.send(cs, data)
      },
      wallNow: this.wallNow,
      lanUrls: this.lanUrlsFn,
      tunnel: () => this.tunnelInfo,
      seed: this.seedFn,
    }
  }

  /** Code au format des salons (lettres sans ambiguïté), pour reprendre le code d'un écran. */
  private static validCode(code: string | undefined): code is string {
    return (
      !!code &&
      code.length === ROOM_CODE_LENGTH &&
      [...code].every(ch => ROOM_CODE_ALPHABET.includes(ch))
    )
  }

  createRoom(wanted?: string): Room {
    const code = wanted && !this.rooms.has(wanted) ? wanted : this.newCode()
    const room = new Room(code, token(24), this.roomContext())
    room.tick = this.tick
    room.lastActivity = this.now()
    this.rooms.set(code, room)
    return room
  }

  private handleHost(cs: ConnState, msg: Extract<ClientMessage, { t: 'host' }>): void {
    let room = msg.code ? this.rooms.get(msg.code.toUpperCase()) : undefined
    if (room && (msg.fresh || msg.secret !== room.secret)) room = undefined
    if (!room) {
      if (!cs.conn.local)
        return this.error(
          cs,
          'NOT_LOCAL',
          'Le tableau de bord s’ouvre depuis le PC hôte (localhost)',
        )
      // un écran qui revient avec un code inconnu (instantané absent ou périmé) le garde :
      // le QR code déjà scanné reste valable, les téléphones n'ont qu'à rejoindre
      const wanted = msg.code?.toUpperCase()
      room = this.createRoom(
        !msg.fresh && GameServer.validCode(wanted) && !this.rooms.has(wanted) ? wanted : undefined,
      )
    }
    cs.role = 'host'
    cs.code = room.code
    cs.playerId = null
    room.lastActivity = this.now()
    this.send(cs, JSON.stringify({ t: 'hosted', code: room.code, secret: room.secret }))
    this.send(cs, JSON.stringify(room.roomState()))
    const rs = room.roundStart()
    if (rs) this.send(cs, JSON.stringify(rs))
  }

  private handleJoin(cs: ConnState, msg: Extract<ClientMessage, { t: 'join' }>): void {
    const room = this.rooms.get(msg.code.toUpperCase())
    if (!room) return this.error(cs, 'ROOM_NOT_FOUND', 'Salon introuvable')
    let player = msg.token ? room.findByToken(msg.token) : null
    if (!player) {
      if (msg.name === undefined)
        return this.error(cs, 'BAD_TOKEN', 'Session expirée : rejoignez à nouveau')
      if (room.isFull()) return this.error(cs, 'ROOM_FULL', 'Salon complet (12 joueurs)')
      player = room.addPlayer(msg.name, msg.color)
      if (!player) return this.error(cs, 'NAME_INVALID', 'Pseudo invalide')
    }
    // une même identité ne vit que sur une connexion : l'ancienne est remplacée
    if (player.connId && player.connId !== cs.conn.id) {
      const old = this.conns.get(player.connId)
      if (old) {
        this.send(old, JSON.stringify({ t: 'replaced' }))
        old.role = 'none'
        old.playerId = null
        old.conn.close(4000, 'replaced')
      }
    }
    // si cette connexion portait déjà un autre joueur, il est détaché
    if (cs.role === 'player' && cs.playerId && cs.playerId !== player.id && cs.code) {
      this.rooms.get(cs.code)?.setConnected(cs.playerId, null)
    }
    cs.role = 'player'
    cs.code = room.code
    cs.playerId = player.id
    room.setConnected(player.id, cs.conn.id)
    room.lastActivity = this.now()
    this.closeRtc(cs)
    this.send(
      cs,
      JSON.stringify({
        t: 'joined',
        id: player.id,
        token: player.token,
        code: room.code,
        iceServers: this.iceServers,
      }),
    )
    const me = room.meState(player.id)
    if (me) this.send(cs, JSON.stringify(me))
  }

  // ─── Commandes et WebRTC ───────────────────────────────────────────────────

  private onInput(cs: ConnState, data: string, via: 'rtc' | 'ws'): void {
    if (cs.role !== 'player' || !cs.playerId || !cs.code) return
    const pkt = parseInput(data)
    if (!pkt) return
    this.rooms.get(cs.code)?.applyInput(cs.playerId, pkt, this.wallNow(), via)
  }

  private syncReply(data: string): string {
    const t0 = data.slice(1, 32)
    return `S${/^[\d.]+$/.test(t0) ? t0 : '0'},${(Math.round(this.wallNow() * 1000) / 1000).toFixed(3)}`
  }

  private handleRtc(cs: ConnState, msg: Extract<ClientMessage, { t: 'rtc' }>): void {
    if (!this.rtcFactory || cs.role !== 'player') return
    if (msg.kind === 'cand') {
      cs.rtc?.addCandidate(msg.cand, msg.mid)
      return
    }
    // nouvelle offre : l'éventuelle session précédente est fermée
    this.closeRtc(cs)
    const connId = cs.conn.id
    let peer: RtcPeer | null = null
    try {
      peer = this.rtcFactory.create(`dc-${connId}`, msg.sdp, {
        onAnswer: sdp => this.send(cs, JSON.stringify({ t: 'rtc', kind: 'answer', sdp })),
        onCandidate: (cand, mid) =>
          this.send(cs, JSON.stringify({ t: 'rtc', kind: 'cand', cand, mid })),
        onOpen: path => {
          if (cs.rtc !== peer) return
          cs.rtcPath = path
          this.playerOf(cs)?.room.setPath(cs.playerId!, path)
        },
        onMessage: data => {
          if (cs.rtc === peer) this.onRtcMessage(cs, data)
        },
        onClose: () => {
          if (cs.rtc !== peer) return
          cs.rtc = null
          cs.rtcPath = null
          cs.rtcRtt = null
          const pr = this.playerOf(cs)
          if (pr && pr.player.connId === connId) pr.room.setPath(pr.player.id, 'ws')
        },
      })
    } catch {
      peer = null
    }
    cs.rtc = peer
  }

  private closeRtc(cs: ConnState): void {
    const peer = cs.rtc
    if (!peer) return
    cs.rtc = null
    cs.rtcPath = null
    cs.rtcRtt = null
    peer.close()
  }

  private playerOf(cs: ConnState) {
    if (!cs.code || !cs.playerId) return null
    const room = this.rooms.get(cs.code)
    const player = room?.players.get(cs.playerId)
    return room && player ? { room, player } : null
  }

  /** Message reçu par le DataChannel d'une connexion (commande, pong, synchro). */
  onRtcMessage(cs: ConnState, data: string): void {
    this.stat.msgIn++
    const now = this.now()
    cs.rtcTokens = Math.min(
      RTC_RATE_CAPACITY,
      cs.rtcTokens + (now - cs.rtcTokensAt) * RTC_RATE_REFILL_PER_MS,
    )
    cs.rtcTokensAt = now
    if (cs.rtcTokens < 1) return
    cs.rtcTokens--
    const c0 = data.charCodeAt(0)
    if (c0 === 105 /* i */) this.onInput(cs, data, 'rtc')
    else if (c0 === 115 /* s */) cs.rtc?.send(this.syncReply(data))
    else if (c0 === 81 /* Q */) {
      const sent = cs.rtcPings.get(Number(data.slice(1)))
      if (sent === undefined) return
      cs.rtcPings.delete(Number(data.slice(1)))
      cs.rtcRtt = Math.round((now - sent) * 10) / 10
      const pr = this.playerOf(cs)
      if (pr) {
        pr.player.rtcRtt = cs.rtcRtt
        pr.room.meDirty.add(pr.player.id)
      }
    }
  }

  private toHosts(code: string, data: string): void {
    for (const cs of this.conns.values())
      if (cs.role === 'host' && cs.code === code) this.send(cs, data)
  }

  // ─── Latence ───────────────────────────────────────────────────────────────

  private sendPings(): void {
    const now = this.now()
    for (const cs of this.conns.values()) {
      if (now - cs.lastPongAt > PONG_TIMEOUT_MS) {
        // connexion muette (téléphone en veille, réseau coupé) : on la libère
        cs.conn.close(4001, 'timeout')
        this.onClose(cs.conn.id)
        continue
      }
      const seq = ++cs.pingSeq
      cs.pings.set(seq, now)
      if (cs.pings.size > 8) cs.pings.delete(cs.pings.keys().next().value!)
      this.send(cs, `P${seq}`)
      if (cs.rtc && cs.rtcPath) {
        cs.rtcPings.set(seq, now)
        if (cs.rtcPings.size > 8) cs.rtcPings.delete(cs.rtcPings.keys().next().value!)
        cs.rtc.send(`P${seq}`)
      }
    }
  }

  private onPong(cs: ConnState, seq: number): void {
    const sent = cs.pings.get(seq)
    cs.lastPongAt = this.now()
    if (sent === undefined) return
    cs.pings.delete(seq)
    const rtt = this.now() - sent
    // gigue façon RFC 3550 : moyenne glissante des écarts entre RTT successifs
    cs.jitter =
      cs.rtt === null ? 0 : (cs.jitter ?? 0) + (Math.abs(rtt - cs.rtt) - (cs.jitter ?? 0)) / 8
    cs.rtt = rtt
    if (cs.role === 'player' && cs.code && cs.playerId) {
      const room = this.rooms.get(cs.code)
      const p = room?.players.get(cs.playerId)
      if (room && p) {
        p.rtt = Math.round(rtt * 10) / 10
        p.jitter = Math.round(cs.jitter * 10) / 10
        room.meDirty.add(p.id)
      }
    }
  }

  // ─── Tunnel ────────────────────────────────────────────────────────────────

  setTunnel(info: TunnelInfo): void {
    this.tunnelInfo = info
    for (const room of this.rooms.values()) room.metaDirty = true
  }

  get tunnel(): TunnelInfo {
    return this.tunnelInfo
  }

  // ─── Simulation ────────────────────────────────────────────────────────────

  /** Avance d'un tick : salons, puis envoi des états modifiés. */
  advance(ticks = 1): void {
    for (let n = 0; n < ticks; n++) {
      const t0 = this.now()
      this.tick++
      for (const room of this.rooms.values()) room.update(this.tick)
      this.flush()
      if (this.pingsEnabled && this.tick % PING_EVERY_TICKS === 0) this.sendPings()
      if (this.tick % TICK_RATE === 0) this.everySecond()
      const dt = this.now() - t0
      this.stat.steps++
      this.stat.stepSum += dt
      if (dt > this.stat.stepMax) this.stat.stepMax = dt
    }
  }

  /** Envoie l'état des salons modifiés : `room` aux hôtes, `me` à chaque joueur concerné. */
  flush(): void {
    for (const room of this.rooms.values()) {
      if (room.metaDirty) {
        room.metaDirty = false
        this.persistDirty = true
        this.toHosts(room.code, JSON.stringify(room.roomState()))
      }
      if (room.meDirty.size) {
        for (const id of room.meDirty) {
          const p = room.players.get(id)
          if (!p?.connId) continue
          const cs = this.conns.get(p.connId)
          const me = room.meState(id)
          if (cs && me) this.send(cs, JSON.stringify(me))
        }
        room.meDirty.clear()
      }
    }
  }

  private everySecond(): void {
    const s = this.stat
    const mem = typeof process !== 'undefined' ? process.memoryUsage().rss / 1048576 : 0
    this.lastDiag = {
      tickRate: TICK_RATE,
      ticksLastSec: s.steps,
      stepAvgMs: s.steps ? round2(s.stepSum / s.steps) : 0,
      stepMaxMs: round2(s.stepMax),
      lateAvgMs: s.lateN ? round2(s.lateSum / s.lateN) : 0,
      lateMaxMs: round2(s.lateMax),
      connections: this.conns.size,
      msgInPerSec: s.msgIn,
      msgOutPerSec: s.msgOut,
      uptimeSec: Math.round((this.now() - this.startedAt) / 1000),
      memMb: Math.round(mem),
    }
    this.stat = {
      steps: 0,
      stepSum: 0,
      stepMax: 0,
      lateSum: 0,
      lateMax: 0,
      lateN: 0,
      msgIn: 0,
      msgOut: 0,
    }
    const now = this.now()
    for (const [code, room] of this.rooms) {
      room.refreshUplinkStats()
      const players: PlayerDiag[] = []
      for (const p of room.players.values()) {
        p.inputsPerSec = p.inputCount
        p.inputCount = 0
        const firsts = p.firstRtc + p.firstWs
        players.push({
          id: p.id,
          rtt: p.rtt,
          jitter: p.jitter,
          rtcRtt: p.rtcRtt,
          connected: p.bot || !!p.connId,
          inputsPerSec: p.inputsPerSec,
          path: p.bot ? null : p.path,
          uplinkP50: p.uplinkP50,
          uplinkP95: p.uplinkP95,
          rtcFirstRatio: firsts ? Math.round((p.firstRtc / firsts) * 100) / 100 : null,
        })
      }
      this.toHosts(
        code,
        JSON.stringify({ t: 'diag', ...this.lastDiag, players } satisfies ServerDiag),
      )
      const someone = [...this.conns.values()].some(cs => cs.code === code && cs.role !== 'none')
      if (someone) room.lastActivity = now
      else if (now - room.lastActivity > ROOM_IDLE_MS) {
        this.rooms.delete(code)
        this.persistDirty = true
      }
    }
    if (this.persistDirty) this.persist()
  }

  // ─── Sauvegarde ────────────────────────────────────────────────────────────

  snapshot(): ServerSnapshot {
    return {
      v: SNAPSHOT_VERSION,
      savedAt: Math.round(this.wallNow()),
      rooms: [...this.rooms.values()].map(r => r.snapshot()),
    }
  }

  /** Écrit l'instantané (au plus une fois par seconde, et à l'arrêt). */
  persist(): void {
    if (!this.store) return
    this.persistDirty = false
    try {
      this.store.save(this.snapshot())
      this.persistFailed = false
    } catch (err) {
      if (!this.persistFailed) console.warn('[tangente] sauvegarde des salons impossible :', err)
      this.persistFailed = true
    }
  }

  /** Recrée les salons sauvegardés par l'instance précédente (s'ils ne sont pas périmés). */
  private restore(): void {
    if (!this.store) return
    let snap: ServerSnapshot | null = null
    try {
      snap = this.store.load()
    } catch {
      snap = null
    }
    if (!snap || !(this.wallNow() - snap.savedAt < ROOM_IDLE_MS)) return
    for (const rs of validRooms(snap)) {
      if (this.rooms.has(rs.code)) continue
      const room = Room.restore(rs, this.roomContext(), this.tick)
      room.lastActivity = this.now()
      this.rooms.set(room.code, room)
      this.restored.push(room.code)
    }
  }

  get diag() {
    return this.lastDiag
  }

  /**
   * Boucle temps réel à pas fixe : le minuteur vise l'échéance du prochain tick,
   * les ticks en retard sont rattrapés (8 max), un retard > 250 ms est abandonné.
   */
  start(): void {
    if (this.timer) return
    let next = this.now() + TICK_MS
    const loop = () => {
      const now = this.now()
      const late = now - next
      if (late >= 0) {
        this.stat.lateSum += late
        this.stat.lateN++
        if (late > this.stat.lateMax) this.stat.lateMax = late
      }
      let n = 0
      while (this.now() >= next && n < 8) {
        this.advance(1)
        next += TICK_MS
        n++
      }
      if (this.now() - next > 250) next = this.now() + TICK_MS
      this.timer = setTimeout(loop, Math.max(0, next - this.now() - 0.2))
    }
    this.timer = setTimeout(loop, TICK_MS)
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /**
   * Arrêt du processus (mise à jour, redémarrage) : sauvegarde, puis prévient
   * écrans et téléphones — qui se reconnectent seuls — et ferme les connexions
   * (sans quoi l'arrêt gracieux de Nitro attendrait leur fermeture).
   */
  shutdown(): void {
    if (this.closing) return
    this.closing = true
    this.stop()
    this.persist()
    const bye = JSON.stringify({ t: 'restarting' })
    for (const cs of [...this.conns.values()]) {
      this.send(cs, bye)
      this.closeRtc(cs)
      try {
        cs.conn.close(1012, 'restart')
      } catch {
        // déjà fermée
      }
    }
  }
}

const round2 = (v: number) => Math.round(v * 100) / 100
