import nodeDataChannel, { type DataChannel, type PeerConnection } from 'node-datachannel'
import { afterAll, describe, expect, it } from 'vitest'
import { createNodeRtcFactory } from '../game/rtc-node'
import { SimNet } from './harness'

/**
 * WebRTC réel (libdatachannel des deux côtés, sur cette machine) : un
 * « téléphone » ouvre un DataChannel non ordonné vers le serveur de jeu, la
 * signalisation passant par le WebSocket simulé. Vérifie l'ouverture, le
 * chemin local, l'acheminement des commandes, la déduplication entre les deux
 * chemins et la synchronisation d'horloge par le DataChannel.
 */

process.env.TANGENTE_STUN = 'none'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const peers: PeerConnection[] = []
afterAll(() => {
  for (const p of peers) p.close()
})

async function until(net: SimNet, cond: () => boolean, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > end) throw new Error('délai dépassé')
    await sleep(15)
    net.run(15)
  }
}

describe('DataChannel WebRTC', () => {
  it('s’ouvre en local, achemine les commandes et la synchro, ignore la copie WebSocket', async () => {
    const net = new SimNet(1, { rtc: createNodeRtcFactory(), pings: true })
    await net.server.refreshIceServers()
    const host = net.connect({ local: true })
    host.sendNow({ t: 'host' })
    net.run(10)
    const code = host.last('hosted')!.code
    const phone = net.connect()
    phone.sendNow({ t: 'join', code, name: 'Rtc' })
    net.run(10)
    const joined = phone.last('joined')!
    expect(joined.iceServers).toEqual([]) // TANGENTE_STUN=none : aucune entrée vide (Chrome la refuse)

    // côté « téléphone »
    const pc = new nodeDataChannel.PeerConnection('phone', { iceServers: [] })
    peers.push(pc)
    const received: string[] = []
    pc.onLocalDescription((sdp, type) => {
      if (type === 'offer') phone.send({ t: 'rtc', kind: 'offer', sdp })
    })
    pc.onLocalCandidate((cand, mid) =>
      phone.send({ t: 'rtc', kind: 'cand', cand: cand.replace(/^a=/, ''), mid }),
    )
    phone.onMessage = m => {
      if (m.t !== 'rtc') return
      if (m.kind === 'answer') pc.setRemoteDescription(m.sdp, 'answer')
      else pc.addRemoteCandidate(m.cand, m.mid)
    }
    const dc: DataChannel = pc.createDataChannel('in', { unordered: true, maxRetransmits: 0 })
    let open = false
    dc.onOpen(() => (open = true))
    dc.onMessage(msg => received.push(String(msg)))

    await until(net, () => open)
    const room = net.server.rooms.get(code)!
    const player = room.players.get(joined.id)!
    await until(net, () => player.path !== 'ws')
    expect(player.path).toBe('lan')

    // commande par le DataChannel, puis sa copie fiable par le WebSocket
    dc.sendMessage('i1,1,0')
    await until(net, () => player.input === 1)
    phone.sendNow('i1,1,0')
    expect(player.firstRtc).toBe(1)
    expect(player.firstWs).toBe(0)

    // synchro d'horloge par le DataChannel
    dc.sendMessage('s99.000')
    await until(net, () => received.some(r => r.startsWith('S99.000,')))

    // ping serveur par le DataChannel → RTT WebRTC mesuré
    await until(net, () => received.some(r => r.startsWith('P')))
    for (const r of received.filter(x => x.startsWith('P'))) dc.sendMessage(`Q${r.slice(1)}`)
    await until(net, () => player.rtcRtt !== null)

    // le WebSocket se ferme : la session WebRTC est libérée côté serveur
    phone.drop()
    await until(net, () => !net.server.conns.has(phone.id))
    expect(player.path).toBeNull()
    dc.close()
  }, 20_000)
})
