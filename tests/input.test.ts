import { describe, expect, it } from 'vitest'
import { parseInput } from '../shared/protocol'
import { classifyPath, isPrivateAddress } from '../game/rtc'
import { SimNet, type SimClient } from './harness'

/** Salon avec un joueur dans une manche en cours (2 joueurs : manche qui dure). */
function playing(net: SimNet): { host: SimClient; phone: SimClient; code: string; id: string } {
  const host = net.connect({ local: true })
  host.sendNow({ t: 'host' })
  net.run(10)
  const code = host.last('hosted')!.code
  host.sendNow({ t: 'rules', rules: { countdown: 1 } })
  const phone = net.connect()
  phone.sendNow({ t: 'join', code, name: 'Alice' })
  host.sendNow({ t: 'addBot' })
  net.run(10)
  phone.sendNow({ t: 'ready', ready: true })
  host.sendNow({ t: 'start' })
  net.run(1100)
  expect(host.last('room')!.phase).toBe('playing')
  return { host, phone, code, id: phone.last('joined')!.id }
}

describe('format des commandes', () => {
  it('décode la forme courte et la forme numérotée, refuse le reste', () => {
    expect(parseInput('i1')).toEqual({ bits: 1, seq: -1, touch: 0 })
    expect(parseInput('i3,42,1700000000123.5')).toEqual({
      bits: 3,
      seq: 42,
      touch: 1700000000123.5,
    })
    expect(parseInput('i2,7')).toEqual({ bits: 2, seq: 7, touch: 0 })
    for (const bad of [
      'i',
      'i4',
      'i1,',
      'i1,-3,0',
      'i1,x,0',
      'i1,2,NaN',
      'x1',
      'i1,1.5,0',
      `i1,1,${'9'.repeat(80)}`,
    ])
      expect(parseInput(bad)).toBeNull()
  })
})

describe('commandes numérotées (deux chemins, première copie gagnante)', () => {
  it('ignore les copies et les commandes plus anciennes', () => {
    const net = new SimNet()
    const { phone, code, id } = playing(net)
    const room = net.server.rooms.get(code)!
    const p = room.players.get(id)!
    phone.sendNow('i1,5,0')
    expect(p.input).toBe(1)
    phone.sendNow('i1,5,0') // copie (redondance, battement)
    phone.sendNow('i0,4,0') // plus ancienne, arrivée en retard (UDP non ordonné)
    expect(p.input).toBe(1)
    expect(p.lastSeq).toBe(5)
    expect(p.firstWs).toBe(1)
    phone.sendNow('i2,6,0')
    expect(p.input).toBe(2)
    // la forme courte reste acceptée
    phone.sendNow('i0')
    expect(p.input).toBe(0)
  })

  it('la numérotation repart à la reconnexion', () => {
    const net = new SimNet()
    const { phone, code, id } = playing(net)
    const room = net.server.rooms.get(code)!
    phone.sendNow('i1,50,0')
    const token = phone.last('joined')!.token
    phone.drop()
    const again = net.connect()
    again.sendNow({ t: 'join', code, token })
    net.run(10)
    again.sendNow('i2,1,0') // page rechargée : la numérotation recommence à 1
    expect(room.players.get(id)!.input).toBe(2)
  })

  it('mesure l’aller seul depuis l’heure du toucher (horloge serveur)', () => {
    const net = new SimNet()
    const { host, phone, code, id } = playing(net)
    const p = net.server.rooms.get(code)!.players.get(id)!
    phone.link = { latencyMs: 23, jitterMs: 0 }
    for (let k = 1; k <= 20; k++) {
      phone.sendRaw(`i${k % 2 ? 1 : 2},${100 + k},${(net.wall() - 4).toFixed(1)}`) // toucher 4 ms avant l'envoi
      net.run(40)
    }
    net.run(1100)
    expect(p.uplinkP50).toBeGreaterThanOrEqual(26)
    expect(p.uplinkP50).toBeLessThanOrEqual(29)
    expect(host.last('room')!.players.find(x => x.id === id)!.uplinkMs).toBe(p.uplinkP50)
    expect(phone.last('me')!.uplinkMs).toBe(p.uplinkP50)
    // les trames portent [index, arrivée, toucher] pour la mesure toucher → image
    const marks = host.all('f').flatMap(f => f.in ?? [])
    expect(marks.length % 3).toBe(0)
    expect(marks.length / 3).toBeGreaterThanOrEqual(19)
    for (let k = 0; k < marks.length; k += 3) {
      if (marks[k + 2]! > 0) expect(marks[k + 1]! - marks[k + 2]!).toBeGreaterThan(20)
    }
  })

  it('répond à la synchronisation d’horloge avec l’heure serveur', () => {
    const net = new SimNet()
    const { phone } = playing(net)
    phone.sendNow('s1234.500')
    net.run(10)
    const [t0, ts] = phone.raw.at(-1)!.slice(1).split(',').map(Number)
    expect(t0).toBe(1234.5)
    expect(Math.abs(ts! - net.wall())).toBeLessThan(20)
    phone.sendNow('sabc')
    net.run(10)
    expect(phone.raw.at(-1)!.startsWith('S0,')).toBe(true)
  })
})

describe('classement du chemin ICE', () => {
  it('distingue réseau local, direct et relais', () => {
    expect(isPrivateAddress('192.168.1.20')).toBe(true)
    expect(isPrivateAddress('10.0.0.3')).toBe(true)
    expect(isPrivateAddress('172.20.1.1')).toBe(true)
    expect(isPrivateAddress('172.32.1.1')).toBe(false)
    expect(isPrivateAddress('abcd.local')).toBe(true)
    expect(isPrivateAddress('77.205.18.166')).toBe(false)
    const host = { type: 'host', address: '192.168.1.20' }
    expect(classifyPath({ local: host, remote: { type: 'prflx', address: '192.168.1.30' } })).toBe(
      'lan',
    )
    expect(classifyPath({ local: host, remote: { type: 'srflx', address: '80.1.2.3' } })).toBe(
      'direct',
    )
    // IPv6 globales sur le même lien (box, partage de connexion)
    const v6 = { type: 'host', address: '2a02:8440:6503:5fdb:2cf5:9b7f:f523:c11b' }
    expect(
      classifyPath({ local: v6, remote: { type: 'prflx', address: '2a02:8440:6503:5fdb::42' } }),
    ).toBe('lan')
    expect(
      classifyPath({ local: v6, remote: { type: 'prflx', address: '2a01:cb00:1:2::42' } }),
    ).toBe('direct')
    expect(classifyPath({ local: host, remote: { type: 'relay', address: '80.1.2.3' } })).toBe(
      'relay',
    )
    expect(classifyPath({ local: { type: 'relay', address: '1.2.3.4' }, remote: host })).toBe(
      'relay',
    )
  })
})
