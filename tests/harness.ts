import { TICK_MS } from '../shared/constants'
import type { ServerMessage } from '../shared/protocol'
import { Rng } from '../game/rng'
import { GameServer, type GameServerOptions } from '../game/server'

/**
 * Réseau simulé à horloge virtuelle : chaque sens d'une connexion est une file
 * FIFO (comme TCP) dont les messages arrivent après latence + gigue. Le serveur
 * avance tick par tick ; aucune attente réelle.
 */
export interface LinkProfile {
  latencyMs: number
  jitterMs: number
}

interface Pending {
  at: number
  deliver: () => void
}

export class SimNet {
  clock = 0
  readonly server: GameServer
  private queue: Pending[] = []
  private nextId = 1
  readonly rng: Rng

  /** `startMs` : heure de départ de l'horloge (un serveur « redémarré » plus tard). */
  constructor(seed = 1, extra: Partial<GameServerOptions> = {}, startMs = 0) {
    this.clock = startMs
    this.rng = new Rng(seed)
    let s = seed * 7919
    this.server = new GameServer({
      now: () => this.clock,
      wallNow: () => this.wall(),
      seed: () => (s = (s * 48271) % 2147483647),
      ...extra,
    })
  }

  /** Horloge murale simulée du serveur (ms). */
  wall(): number {
    return 1_700_000_000_000 + this.clock
  }

  schedule(at: number, deliver: () => void): void {
    this.queue.push({ at, deliver })
  }

  /** Avance l'horloge de `ms` en simulant les ticks et les livraisons de messages. */
  run(ms: number): void {
    const end = this.clock + ms
    while (this.clock < end) {
      this.clock += TICK_MS
      this.deliverDue()
      this.server.advance(1)
      this.deliverDue()
    }
  }

  private deliverDue(): void {
    if (!this.queue.length) return
    this.queue.sort((a, b) => a.at - b.at)
    while (this.queue.length && this.queue[0]!.at <= this.clock) this.queue.shift()!.deliver()
  }

  connect(opts: { local?: boolean; link?: LinkProfile } = {}): SimClient {
    return new SimClient(
      this,
      `c${this.nextId++}`,
      opts.local ?? false,
      opts.link ?? { latencyMs: 0, jitterMs: 0 },
    )
  }
}

export class SimClient {
  received: ServerMessage[] = []
  /** Messages texte hors JSON (réponses de synchronisation). */
  raw: string[] = []
  open = true
  closedCode: number | null = null
  private lastUp = 0
  private lastDown = 0
  onMessage: ((m: ServerMessage) => void) | null = null

  constructor(
    readonly net: SimNet,
    readonly id: string,
    readonly local: boolean,
    public link: LinkProfile,
  ) {
    net.server.onOpen({
      id,
      local,
      send: data => this.fromServer(data),
      close: code => {
        // comme un vrai WebSocket : les messages déjà envoyés arrivent avant la fermeture
        net.schedule(Math.max(net.clock, this.lastDown), () => {
          if (!this.open) return
          this.open = false
          this.closedCode = code ?? 1000
          net.server.onClose(id)
        })
      },
    })
  }

  private delay(last: 'up' | 'down'): number {
    const d = this.link.latencyMs + this.net.rng.next() * this.link.jitterMs
    // FIFO : un message ne double jamais le précédent dans le même sens
    const at = Math.max(this.net.clock + d, last === 'up' ? this.lastUp : this.lastDown)
    if (last === 'up') this.lastUp = at
    else this.lastDown = at
    return at
  }

  private fromServer(data: string): void {
    if (!this.open) return
    const at = this.delay('down')
    this.net.schedule(at, () => {
      if (!this.open) return
      if (data[0] === 'P') {
        this.sendRaw(`Q${data.slice(1)}`)
        return
      }
      if (data[0] === 'S') {
        this.raw.push(data)
        return
      }
      const msg = JSON.parse(data) as ServerMessage
      this.received.push(msg)
      this.onMessage?.(msg)
    })
  }

  sendRaw(data: string): void {
    if (!this.open) return
    const at = this.delay('up')
    this.net.schedule(at, () => {
      if (this.open) this.net.server.onMessage(this.id, data)
    })
  }

  /** Envoi immédiat (latence nulle), pour les tests unitaires de protocole. */
  sendNow(data: unknown): void {
    this.net.server.onMessage(this.id, typeof data === 'string' ? data : JSON.stringify(data))
  }

  send(data: object): void {
    this.sendRaw(JSON.stringify(data))
  }

  /** Coupure brutale côté client. */
  drop(): void {
    if (!this.open) return
    this.open = false
    this.net.server.onClose(this.id)
  }

  last<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }> | undefined {
    for (let i = this.received.length - 1; i >= 0; i--) {
      const m = this.received[i]!
      if (m.t === t) return m as Extract<ServerMessage, { t: T }>
    }
    return undefined
  }

  all<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }>[] {
    return this.received.filter(m => m.t === t) as Extract<ServerMessage, { t: T }>[]
  }
}
