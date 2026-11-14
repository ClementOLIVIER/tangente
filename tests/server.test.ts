import { describe, expect, it } from 'vitest'
import { MAX_PLAYERS } from '../shared/constants'
import { SimNet, type SimClient } from './harness'

function hostRoom(net: SimNet): { host: SimClient; code: string; secret: string } {
  const host = net.connect({ local: true })
  host.sendNow({ t: 'host' })
  net.run(20)
  const hosted = host.last('hosted')!
  return { host, code: hosted.code, secret: hosted.secret }
}

function join(net: SimNet, code: string, name: string, color?: string): SimClient {
  const c = net.connect()
  c.sendNow({ t: 'join', code, name, color })
  net.run(20)
  return c
}

describe('salon et hôte', () => {
  it('crée un salon depuis le PC local, refuse depuis l’extérieur', () => {
    const net = new SimNet()
    const { code, secret } = hostRoom(net)
    expect(code).toMatch(/^[A-Z]{4}$/)
    expect(secret.length).toBeGreaterThan(20)
    const remote = net.connect({ local: false })
    remote.sendNow({ t: 'host' })
    net.run(20)
    expect(remote.last('error')?.code).toBe('NOT_LOCAL')
  })

  it('protège les actions hôte par le secret, même si le code est connu', () => {
    const net = new SimNet()
    const { code, secret } = hostRoom(net)
    const intruder = net.connect({ local: false })
    intruder.sendNow({ t: 'host', code, secret: 'devine' })
    intruder.sendNow({ t: 'start' })
    net.run(20)
    expect(intruder.all('error').map(e => e.code)).toEqual(['NOT_LOCAL', 'FORBIDDEN'])
    // un joueur ne peut pas non plus piloter le salon
    const p = join(net, code, 'Alice')
    p.sendNow({ t: 'endGame' })
    net.run(20)
    expect(p.last('error')?.code).toBe('FORBIDDEN')
    // l'hôte qui recharge sa page retrouve son salon avec le secret
    const again = net.connect({ local: true })
    again.sendNow({ t: 'host', code, secret })
    net.run(20)
    expect(again.last('hosted')?.code).toBe(code)
  })

  it('valide les messages et ignore les formats invalides', () => {
    const net = new SimNet()
    const { code } = hostRoom(net)
    const c = net.connect()
    c.sendNow('pas du json')
    c.sendNow({ t: 'join', code: 42 })
    c.sendNow({ t: 'inconnu' })
    c.sendNow('x'.repeat(10_000))
    net.run(20)
    expect(c.all('error').every(e => e.code === 'BAD_MESSAGE')).toBe(true)
    expect(c.all('error')).toHaveLength(4)
    c.sendNow({ t: 'join', code, name: '   \u0000​  ' })
    net.run(20)
    expect(c.last('error')?.code).toBe('NAME_INVALID')
  })

  it('attribue des couleurs uniques et des pseudos distincts', () => {
    const net = new SimNet()
    const { host, code } = hostRoom(net)
    join(net, code, 'Alice', 'rouge')
    join(net, code, 'Alice', 'rouge')
    net.run(20)
    const players = host.last('room')!.players
    expect(players.map(p => p.name)).toEqual(['Alice', 'Alice 2'])
    expect(new Set(players.map(p => p.color)).size).toBe(2)
    expect(players[0]!.color).toBe('rouge')
  })

  it('refuse le 13e joueur', () => {
    const net = new SimNet()
    const { code } = hostRoom(net)
    for (let i = 0; i < MAX_PLAYERS; i++) join(net, code, `J${i}`)
    const extra = join(net, code, 'Treize')
    expect(extra.last('error')?.code).toBe('ROOM_FULL')
  })
})

describe('reconnexion et identité', () => {
  it('retrouve son identité avec le jeton ; l’ancienne connexion est remplacée', () => {
    const net = new SimNet()
    const { host, code } = hostRoom(net)
    const a = join(net, code, 'Alice', 'bleu')
    const joined = a.last('joined')!
    const a2 = net.connect()
    a2.sendNow({ t: 'join', code, token: joined.token })
    net.run(20)
    expect(a2.last('joined')?.id).toBe(joined.id)
    expect(a.last('replaced')).toBeDefined()
    expect(a.open).toBe(false)
    expect(host.last('room')!.players).toHaveLength(1)
    expect(host.last('room')!.players[0]).toMatchObject({
      name: 'Alice',
      color: 'bleu',
      connected: true,
    })
  })

  it('un jeton inconnu ne permet pas d’usurper une identité', () => {
    const net = new SimNet()
    const { host, code } = hostRoom(net)
    const a = join(net, code, 'Alice')
    const id = a.last('joined')!.id
    const thief = net.connect()
    thief.sendNow({ t: 'join', code, token: id }) // l'id public n'est pas le jeton
    net.run(20)
    expect(thief.last('error')?.code).toBe('BAD_TOKEN')
    expect(host.last('room')!.players).toHaveLength(1)
    expect(a.open).toBe(true)
  })

  it('neutralise la commande à la déconnexion (la tête repart tout droit)', () => {
    const net = new SimNet()
    const { host, code } = hostRoom(net)
    const a = join(net, code, 'Alice')
    join(net, code, 'Bob').sendNow({ t: 'ready', ready: true })
    a.sendNow({ t: 'ready', ready: true })
    host.sendNow({ t: 'rules', rules: { countdown: 1 } })
    host.sendNow({ t: 'start' })
    net.run(1100)
    a.sendNow('i1')
    net.run(100)
    const room = net.server.rooms.get(code)!
    const idx = room.players.get(a.last('joined')!.id)!.idx
    expect(room.round!.players[idx]!.input).toBe(1)
    a.drop()
    net.run(10)
    expect(room.round!.players[idx]!.input).toBe(0)
    expect(host.last('room')!.players.find(p => p.idx === idx)?.connected).toBe(false)
  })

  it('libère une connexion muette (plus de réponse aux pings)', () => {
    const net = new SimNet()
    const { host, code } = hostRoom(net)
    const a = join(net, code, 'Alice')
    a.link = { latencyMs: 60_000, jitterMs: 0 } // le téléphone ne répond plus
    net.run(9000)
    // côté serveur : connexion libérée, joueur marqué déconnecté (sa tête ira tout droit)
    expect(net.server.conns.has(a.id)).toBe(false)
    expect(host.last('room')!.players[0]!.connected).toBe(false)
  })

  it('limite le débit d’un client abusif', () => {
    const net = new SimNet()
    const { code } = hostRoom(net)
    const a = join(net, code, 'Alice')
    for (let i = 0; i < 1000; i++) a.sendNow(`i${i % 4}`)
    net.run(10)
    expect(a.open).toBe(false)
    expect(a.closedCode).toBe(1008)
  })
})

describe('phases', () => {
  it('compte à rebours → manche → résultats → manche suivante, pause et reprise', () => {
    const net = new SimNet()
    const { host, code } = hostRoom(net)
    host.sendNow({ t: 'rules', rules: { countdown: 2 } })
    host.sendNow({ t: 'addBot' })
    host.sendNow({ t: 'addBot' })
    host.sendNow({ t: 'start' })
    net.run(20)
    expect(host.last('room')!.phase).toBe('countdown')
    expect(host.last('round')!.players).toHaveLength(2)
    net.run(2000)
    expect(host.last('room')!.phase).toBe('playing')
    host.sendNow({ t: 'pause' })
    net.run(20)
    const frames = host.all('f').length
    net.run(1000)
    expect(host.last('room')!.phase).toBe('paused')
    expect(host.all('f').length).toBe(frames) // simulation figée
    host.sendNow({ t: 'resume' })
    net.run(20)
    expect(host.last('room')!.phase).toBe('countdown')
    net.run(1600)
    expect(host.last('room')!.phase).toBe('playing')
    net.run(120_000)
    expect(['roundEnd', 'gameOver']).toContain(host.last('room')!.phase)
  })

  it('recommencer une manche annule ses points', () => {
    const net = new SimNet(5)
    const { host } = hostRoom(net)
    host.sendNow({ t: 'rules', rules: { countdown: 1, targetScore: 50 } })
    for (let i = 0; i < 4; i++) host.sendNow({ t: 'addBot' })
    host.sendNow({ t: 'start' })
    while (host.last('room')?.phase !== 'roundEnd') net.run(500)
    const before = host.last('room')!.players.reduce((s, p) => s + p.score, 0)
    expect(before).toBeGreaterThan(0)
    host.sendNow({ t: 'restartRound' })
    net.run(20)
    const after = host.last('room')!
    expect(after.phase).toBe('countdown')
    expect(after.players.reduce((s, p) => s + p.score, 0)).toBe(0)
    expect(after.round).toBe(1)
  })

  it('un écran hôte qui se reconnecte en pleine manche reçoit l’état complet des traces', () => {
    const net = new SimNet()
    const { code, secret } = hostRoom(net)
    const host = net.server
    void host
    const h = net.connect({ local: true })
    h.sendNow({ t: 'host', code, secret })
    h.sendNow({ t: 'rules', rules: { countdown: 1 } })
    h.sendNow({ t: 'addBot' })
    h.sendNow({ t: 'addBot' })
    h.sendNow({ t: 'start' })
    net.run(3000)
    const late = net.connect({ local: true })
    late.sendNow({ t: 'host', code, secret })
    net.run(20)
    const rs = late.last('round')!
    expect(rs.strokes.length).toBeGreaterThan(20)
    expect(rs.tick).toBeGreaterThan(100)
  })
})
