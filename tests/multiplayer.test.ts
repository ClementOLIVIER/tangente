import { describe, expect, it } from 'vitest'
import { FLAG, FRAME_STRIDE } from '../shared/constants'
import type { Frame, RoundStart } from '../shared/protocol'
import { SimNet, type LinkProfile, type SimClient } from './harness'

/**
 * Parties complètes de bout en bout (serveur réel, réseau simulé) : 2, 6 et 12
 * téléphones avec latence, gigue et coupures/reconnexions. Vérifie que la
 * partie se termine, que l'écran hôte reçoit chaque tick sans trou, et que les
 * scores du serveur correspondent exactement aux éliminations vues par l'hôte.
 */

interface Phone {
  client: SimClient
  token: string
  id: string
  name: string
  link: LinkProfile
  nextInputAt: number
  downUntil: number
}

function playGame(
  n: number,
  seed: number,
  opts: { disconnects: boolean; rules?: object; bots?: number },
) {
  const net = new SimNet(seed)
  const host = net.connect({ local: true })
  host.sendNow({ t: 'host' })
  net.run(10)
  const code = host.last('hosted')!.code
  host.sendNow({
    t: 'rules',
    rules: { countdown: 1, autoNextRound: true, roundEndDelay: 2, ...opts.rules },
  })

  const phones: Phone[] = []
  for (let i = 0; i < n; i++) {
    const link = { latencyMs: 10 + net.rng.next() * 90, jitterMs: net.rng.next() * 40 }
    const client = net.connect({ link })
    client.send({ t: 'join', code, name: `Tel ${i}` })
    phones.push({ client, token: '', id: '', name: `Tel ${i}`, link, nextInputAt: 0, downUntil: 0 })
  }
  net.run(500)
  for (const p of phones) {
    const j = p.client.last('joined')!
    p.token = j.token
    p.id = j.id
    p.client.send({ t: 'ready', ready: true })
  }
  for (let i = 0; i < (opts.bots ?? 0); i++) host.sendNow({ t: 'addBot' })
  net.run(500)
  host.sendNow({ t: 'start' })

  // ce que voit l'écran hôte
  let roundInfo: RoundStart | null = null
  let lastK = -1
  let gapsInFrames = 0
  const expected = new Map<string, number>()
  let reconnects = 0
  let rounds = 0
  host.onMessage = m => {
    if (m.t === 'round') {
      roundInfo = m
      lastK = m.tick
      rounds++
    } else if (m.t === 'f') {
      const f = m as Frame
      if (f.k !== lastK + 1) gapsInFrames++
      lastK = f.k
      const deaths = (f.ev ?? []).filter(e => e.e === 'death' && e.cause !== 'left').length
      if (deaths && roundInfo) {
        for (let i = 0; i < roundInfo.players.length; i++) {
          if (f.p[i * FRAME_STRIDE + 4]! & FLAG.ALIVE) {
            const id = roundInfo.players[i]!.id
            expected.set(id, (expected.get(id) ?? 0) + deaths)
          }
        }
      }
    }
  }

  const deadline = net.clock + 15 * 60_000
  while (host.last('room')?.phase !== 'gameOver' && net.clock < deadline) {
    for (const p of phones) {
      if (net.clock >= p.nextInputAt && p.client.open) {
        p.client.sendRaw(`i${net.rng.int(4)}`)
        p.nextInputAt = net.clock + 150 + net.rng.next() * 500
      }
      if (opts.disconnects) {
        if (p.client.open && net.rng.next() < 0.0008) {
          p.client.drop()
          p.downUntil = net.clock + 300 + net.rng.next() * 2500
        } else if (!p.client.open && net.clock >= p.downUntil) {
          p.client = net.connect({ link: p.link })
          p.client.send({ t: 'join', code, token: p.token })
          reconnects++
        }
      }
    }
    net.run(50)
  }

  const room = host.last('room')!
  return { net, host, room, phones, expected, gapsInFrames, reconnects, rounds }
}

describe.each([
  [2, 11],
  [6, 12],
  [12, 13],
])('partie complète à %i joueurs', (n, seed) => {
  it('se termine avec des scores cohérents malgré latence, gigue et coupures', () => {
    const res = playGame(n, seed, { disconnects: true })
    expect(res.room.phase).toBe('gameOver')
    expect(res.room.winners.length).toBeGreaterThanOrEqual(1)
    expect(res.gapsInFrames).toBe(0)
    expect(res.rounds).toBeGreaterThanOrEqual(2)
    // chaque joueur a retrouvé son identité après ses coupures
    expect(res.room.players).toHaveLength(n)
    for (const p of res.phones) {
      const lp = res.room.players.find(x => x.id === p.id)!
      expect(lp.name).toBe(p.name)
      expect(lp.score).toBe(res.expected.get(p.id) ?? 0)
    }
    // le gagnant atteint l'objectif avec 2 points d'avance
    const sorted = [...res.room.players].sort((a, b) => b.score - a.score)
    expect(sorted[0]!.score).toBeGreaterThanOrEqual(res.room.target)
    expect(sorted[0]!.score - (sorted[1]?.score ?? 0)).toBeGreaterThanOrEqual(2)
    if (n > 2) expect(res.reconnects).toBeGreaterThan(0)
  })
})

it('mode Party à 12 (2 téléphones + 10 bots) : tous les bonus actifs, scores exacts', () => {
  const res = playGame(2, 21, {
    disconnects: false,
    bots: 10,
    rules: {
      mode: 'party',
      bonusSpawnMin: 0.5,
      bonusSpawnMax: 1.5,
      bonusMaxOnField: 5,
      targetScore: 60,
    },
  })
  expect(res.room.phase).toBe('gameOver')
  expect(res.room.players).toHaveLength(12)
  for (const p of res.room.players) expect(p.score).toBe(res.expected.get(p.id) ?? 0)
  const takes = res.host.all('f').flatMap(f => (f.ev ?? []).filter(e => e.e === 'take'))
  const spawns = res.host.all('f').flatMap(f => (f.ev ?? []).filter(e => e.e === 'spawn'))
  // les bots ne visent pas les bonus : on vérifie seulement qu'il y a eu du jeu
  expect(spawns.length).toBeGreaterThan(20)
  expect(takes.length).toBeGreaterThan(3)
})

it('partie par nombre de manches avec bonus de dernier survivant', () => {
  const res = playGame(4, 31, {
    disconnects: false,
    rules: { endCondition: 'rounds', rounds: 3, survivorBonus: 2 },
  })
  expect(res.room.phase).toBe('gameOver')
  expect(res.room.round).toBe(3)
  const total = res.room.players.reduce((s, p) => s + p.score, 0)
  const fromDeaths = [...res.expected.values()].reduce((s, v) => s + v, 0)
  const soleSurvivorRounds = res.room.players.reduce((s, p) => s + p.wins, 0)
  expect(total).toBe(fromDeaths + 2 * soleSurvivorRounds)
})
