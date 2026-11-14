import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ServerSnapshot, StateStore } from '../game/snapshot'
import { createFileStore } from '../game/store-node'
import { SimNet, type SimClient } from './harness'

/**
 * Redémarrage transparent : l'instance suivante du serveur reprend les salons
 * de la précédente (même code, mêmes scores) et chaque téléphone se reconnecte
 * avec son jeton, sans rien ressaisir.
 */

class MemoryStore implements StateStore {
  snap: ServerSnapshot | null = null
  saves = 0
  load() {
    return this.snap ? (JSON.parse(JSON.stringify(this.snap)) as ServerSnapshot) : null
  }
  save(s: ServerSnapshot) {
    this.saves++
    this.snap = JSON.parse(JSON.stringify(s)) as ServerSnapshot
  }
}

interface Party {
  net: SimNet
  host: SimClient
  phone: SimClient
  code: string
  secret: string
  id: string
  token: string
}

function party(store: StateStore, seed = 3): Party {
  const net = new SimNet(seed, { store })
  const host = net.connect({ local: true })
  host.sendNow({ t: 'host' })
  net.run(10)
  const { code, secret } = host.last('hosted')!
  host.sendNow({ t: 'rules', rules: { countdown: 1, autoNextRound: false, targetScore: 50 } })
  const phone = net.connect()
  phone.sendNow({ t: 'join', code, name: 'Alice', color: 'cyan' })
  host.sendNow({ t: 'addBot' })
  host.sendNow({ t: 'addBot' })
  net.run(10)
  phone.sendNow({ t: 'ready', ready: true })
  net.run(10)
  const joined = phone.last('joined')!
  return { net, host, phone, code, secret, id: joined.id, token: joined.token }
}

/** Nouvelle instance du serveur sur le même instantané, à la même heure murale. */
function reboot(store: StateStore, from: SimNet, seed = 9): SimNet {
  return new SimNet(seed, { store }, from.clock + 2000) // redémarré 2 s plus tard
}

describe('sauvegarde des salons', () => {
  it('reprend le salon : même code, hôte et téléphone reconnectés par secret et jeton', () => {
    const store = new MemoryStore()
    const a = party(store)
    a.net.run(1100) // sauvegarde périodique
    expect(store.snap?.rooms.map(r => r.code)).toEqual([a.code])

    const net = reboot(store, a.net)
    expect(net.server.restored).toEqual([a.code])
    const room = net.server.rooms.get(a.code)!
    expect(room.rules.targetScore).toBe(50)
    expect([...room.players.values()].every(p => p.connId === null)).toBe(true)

    // l'écran se reconnecte avec son secret (sans être local : c'est le secret qui compte)
    const host = net.connect({ local: true })
    host.sendNow({ t: 'host', code: a.code, secret: a.secret })
    net.run(10)
    expect(host.last('hosted')!.code).toBe(a.code)

    // le téléphone rejoint avec son seul jeton : même joueur, même couleur, toujours prêt
    const phone = net.connect()
    phone.sendNow({ t: 'join', code: a.code, token: a.token })
    net.run(10)
    expect(phone.last('joined')!.id).toBe(a.id)
    const me = phone.last('me')!
    expect(me.name).toBe('Alice')
    expect(me.color).toBe('cyan')
    expect(me.ready).toBe(true)
    expect(host.last('room')!.players.filter(p => p.bot)).toHaveLength(2)
    // un nouveau bot ne réutilise pas un nom existant
    host.sendNow({ t: 'addBot' })
    net.run(10)
    expect(new Set(host.last('room')!.players.map(p => p.name)).size).toBe(4)
  })

  it('annule la manche interrompue : points de la manche retirés, la suivante se rejoue', () => {
    const store = new MemoryStore()
    const a = party(store)
    a.host.sendNow({ t: 'start' })
    const room = a.net.server.rooms.get(a.code)!
    for (let i = 0; i < 400 && room.phase !== 'roundEnd'; i++) a.net.run(250)
    expect(room.phase).toBe('roundEnd')
    const afterRound1 = new Map([...room.players.values()].map(p => [p.id, p.score]))
    const wins1 = new Map([...room.players.values()].map(p => [p.id, p.wins]))

    // manche 2 interrompue en plein jeu, des points déjà distribués ou non
    a.host.sendNow({ t: 'next' })
    for (let i = 0; i < 400 && room.phase !== 'playing'; i++) a.net.run(50)
    a.net.run(1500)
    expect(room.roundNo).toBe(2)
    a.net.server.persist()

    const net = reboot(store, a.net)
    const r2 = net.server.rooms.get(a.code)!
    expect(r2.phase).toBe('roundEnd')
    expect(r2.roundNo).toBe(1)
    for (const p of r2.players.values()) {
      expect(p.score).toBe(afterRound1.get(p.id))
      expect(p.wins).toBe(wins1.get(p.id))
      expect(p.inGame).toBe(true)
    }

    // le téléphone revient, l'hôte relance : la manche 2 se rejoue avec tout le monde
    const host = net.connect({ local: true })
    host.sendNow({ t: 'host', code: a.code, secret: a.secret })
    const phone = net.connect()
    phone.sendNow({ t: 'join', code: a.code, token: a.token })
    net.run(10)
    host.sendNow({ t: 'next' })
    net.run(10)
    expect(r2.roundNo).toBe(2)
    expect(r2.phase).toBe('countdown')
    expect(host.last('round')!.players.map(p => p.id)).toContain(a.id)
  })

  it('une première manche interrompue ramène au salon', () => {
    const store = new MemoryStore()
    const a = party(store)
    a.host.sendNow({ t: 'start' })
    a.net.run(1500)
    expect(a.net.server.rooms.get(a.code)!.phase).toBe('playing')
    a.net.server.persist()
    const r = reboot(store, a.net).server.rooms.get(a.code)!
    expect(r.phase).toBe('lobby')
    expect(r.roundNo).toBe(0)
    expect([...r.players.values()].every(p => p.score === 0 && !p.inGame)).toBe(true)
  })

  it('n’écrit que si quelque chose a changé, au plus une fois par seconde', () => {
    const store = new MemoryStore()
    const a = party(store)
    a.net.run(1100)
    const n = store.saves
    a.net.run(5000) // salon au repos : rien à écrire
    expect(store.saves).toBe(n)
    a.host.sendNow({ t: 'rules', rules: { targetScore: 30 } })
    a.net.run(1100)
    expect(store.saves).toBe(n + 1)
    expect(store.snap!.rooms[0]!.rules.targetScore).toBe(30)
  })

  it('ignore un instantané périmé ou invalide', () => {
    const store = new MemoryStore()
    const a = party(store)
    a.net.server.persist()
    const later = new SimNet(1, { store }, a.net.clock + 31 * 60 * 1000)
    expect(later.server.rooms.size).toBe(0)

    store.snap = { v: 1, savedAt: store.snap!.savedAt, rooms: [{ code: 'abc' } as never] }
    expect(reboot(store, a.net).server.rooms.size).toBe(0)
    store.snap = { v: 99, savedAt: store.snap.savedAt, rooms: [] }
    expect(reboot(store, a.net).server.rooms.size).toBe(0)
  })

  it('sans instantané, l’écran garde son code : le QR déjà scanné reste valable', () => {
    const net = new SimNet(5) // aucune sauvegarde : redémarrage « à froid »
    const host = net.connect({ local: true })
    host.sendNow({ t: 'host', code: 'WXYZ', secret: 'ancien' })
    net.run(10)
    expect(host.last('hosted')!.code).toBe('WXYZ')
    // le téléphone revient avec un jeton que ce serveur ne connaît pas : il rejoint à nouveau
    const phone = net.connect()
    phone.sendNow({ t: 'join', code: 'WXYZ', token: 'inconnu' })
    net.run(10)
    expect(phone.last('error')!.code).toBe('BAD_TOKEN')
    // code invalide, ou demande explicite d'un nouveau salon : code neuf
    const other = net.connect({ local: true })
    other.sendNow({ t: 'host', code: 'WXYZ', secret: 'faux' }) // déjà pris, mauvais secret
    other.sendNow({ t: 'host', code: 'ab1', secret: 'x' })
    net.run(10)
    const codes = other.all('hosted').map(h => h.code)
    expect(codes).toHaveLength(2)
    expect(codes).not.toContain('WXYZ')
    expect(codes).not.toContain('AB1')
    const fresh = net.connect({ local: true })
    fresh.sendNow({ t: 'host', code: 'QRST', fresh: true })
    net.run(10)
    expect(fresh.last('hosted')!.code).not.toBe('QRST')
  })

  it('à l’arrêt : sauvegarde, prévient les clients et ferme les connexions', () => {
    const store = new MemoryStore()
    const a = party(store)
    const before = store.saves
    a.net.server.shutdown()
    a.net.run(10)
    expect(store.saves).toBe(before + 1)
    expect(a.phone.last('restarting')).toBeDefined()
    expect(a.host.last('restarting')).toBeDefined()
    expect(a.phone.closedCode).toBe(1012)
    expect(a.host.closedCode).toBe(1012)
  })
})

describe('fichier d’instantané', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tangente-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('écrit de façon atomique, lisible par l’utilisateur seul, et relit', () => {
    const path = join(dir, 'sub', 'rooms.json')
    const store = createFileStore(path)
    expect(store.load()).toBeNull()
    const snap: ServerSnapshot = { v: 1, savedAt: 1, rooms: [] }
    store.save(snap)
    expect(store.load()).toEqual(snap)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(snap)
    writeFileSync(path, '{"v":1,"rooms":[') // fichier tronqué
    expect(store.load()).toBeNull()
  })
})
