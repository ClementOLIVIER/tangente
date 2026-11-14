#!/usr/bin/env node
/**
 * Banc de charge sur un serveur réellement lancé (vrais WebSocket, vraie boucle
 * temps réel) : un écran hôte + N téléphones simulés.
 *
 *   node scripts/load-test.mjs --players 12 --seconds 60
 *   options : --url ws://127.0.0.1:3000/_ws --latency 40 --jitter 20 --drop 0.02 --party
 *
 * --latency/--jitter retardent chaque message des téléphones (aller et retour),
 * --drop est la probabilité par seconde qu'un téléphone coupe puis se reconnecte.
 *
 * Mesures : trames/s et trous côté hôte, régularité d'arrivée des trames,
 * délai arrivée commande → trame la reflétant reçue par l'hôte, RTT, charge
 * serveur, et cohérence exacte des scores avec les éliminations observées.
 */
const args = process.argv.slice(2)
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d
}
const URL_ = opt('url', 'ws://127.0.0.1:3000/_ws')
const N = Number(opt('players', 12))
const SECONDS = Number(opt('seconds', 45))
const LAT = Number(opt('latency', 0))
const JIT = Number(opt('jitter', 0))
const DROP = Number(opt('drop', 0))
const PARTY = args.includes('--party')
const ALIVE = 1
const STRIDE = 5

const sleep = ms => new Promise(r => setTimeout(r, ms))
const pct = (a, q) => (a.length ? a[Math.min(a.length - 1, Math.floor(a.length * q))] : NaN)
const stats = arr => {
  const s = [...arr].sort((a, b) => a - b)
  return {
    n: s.length,
    p50: pct(s, 0.5),
    p95: pct(s, 0.95),
    p99: pct(s, 0.99),
    max: s[s.length - 1],
  }
}
const f1 = v => (Number.isFinite(v) ? v.toFixed(1) : '—')
const wall = () => performance.timeOrigin + performance.now()

function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.onopen = () => resolve(ws)
    ws.onerror = e => reject(e)
  })
}

/** File FIFO à délai : simule latence + gigue sans réordonner (comme TCP). */
function delayed() {
  let last = 0
  return fn => {
    if (!LAT && !JIT) return fn()
    const at = Math.max(performance.now() + LAT + Math.random() * JIT, last)
    last = at
    setTimeout(fn, at - performance.now())
  }
}

// ─── Hôte ───────────────────────────────────────────────────────────────────
const host = await open(URL_)
let code = null
let room = null
let roundInfo = null
let lastK = -1
let frames = 0
let gaps = 0
let lastArrival = 0
const interArrival = []
const inputToHost = []
const expected = new Map()
let rounds = 0
let lastDiag = null
host.onmessage = ev => {
  const data = ev.data
  if (data[0] === 'P') return host.send(`Q${data.slice(1)}`)
  const m = JSON.parse(data)
  const now = performance.now()
  switch (m.t) {
    case 'hosted':
      code = m.code
      break
    case 'room':
      room = m
      break
    case 'diag':
      lastDiag = m
      break
    case 'round':
      roundInfo = m
      lastK = m.tick
      rounds++
      lastArrival = 0
      break
    case 'f': {
      frames++
      if (m.k !== lastK + 1) gaps++
      lastK = m.k
      if (lastArrival) interArrival.push(now - lastArrival)
      lastArrival = now
      if (m.in) {
        const w = wall()
        for (let k = 0; k + 2 < m.in.length; k += 3) inputToHost.push(w - m.in[k + 1])
      }
      const deaths = (m.ev ?? []).filter(e => e.e === 'death' && e.cause !== 'left').length
      if (deaths && roundInfo) {
        roundInfo.players.forEach((p, i) => {
          if (m.p[i * STRIDE + 4] & ALIVE) expected.set(p.id, (expected.get(p.id) ?? 0) + deaths)
        })
      }
      break
    }
  }
}
host.send(JSON.stringify({ t: 'host' }))
while (!code) await sleep(10)
host.send(
  JSON.stringify({
    t: 'rules',
    rules: {
      countdown: 1,
      autoNextRound: true,
      roundEndDelay: 2,
      targetScore: 999,
      mode: PARTY ? 'party' : 'classic',
    },
  }),
)

// ─── Téléphones ─────────────────────────────────────────────────────────────
const phones = []
async function connectPhone(p) {
  const ws = await open(URL_)
  const up = delayed()
  const down = delayed()
  p.ws = ws
  ws.onmessage = ev =>
    down(() => {
      const data = ev.data
      if (data[0] === 'P') return up(() => ws.readyState === 1 && ws.send(`Q${data.slice(1)}`))
      const m = JSON.parse(data)
      if (m.t === 'joined') {
        p.token = m.token
        p.id = m.id
        p.joined = true
      } else if (m.t === 'me') p.me = m
    })
  ws.onclose = () => (p.open = false)
  p.open = true
  p.up = up
  up(() =>
    ws.send(
      JSON.stringify(
        p.token ? { t: 'join', code, token: p.token } : { t: 'join', code, name: p.name },
      ),
    ),
  )
}
for (let i = 0; i < N; i++) {
  const p = {
    name: `Charge ${i + 1}`,
    token: null,
    id: null,
    joined: false,
    open: false,
    reconnects: 0,
  }
  phones.push(p)
  await connectPhone(p)
}
while (!phones.every(p => p.joined)) await sleep(20)
for (const p of phones) p.up(() => p.ws.send(JSON.stringify({ t: 'ready', ready: true })))
await sleep(300 + LAT * 2 + JIT)
host.send(JSON.stringify({ t: 'start' }))
console.log(
  `salon ${code} : ${N} téléphones, ${SECONDS} s, latence ${LAT}±${JIT} ms, coupures ${DROP}/s`,
)

// commandes : chaque téléphone change d'état toutes les 120–600 ms (rafales d'appuis)
const t0 = performance.now()
const timers = phones.map(p => {
  const tick = () => {
    if (performance.now() - t0 > SECONDS * 1000) return
    if (p.open) {
      const bits = Math.floor(Math.random() * 4)
      p.up(() => p.ws.readyState === 1 && p.ws.send(`i${bits}`))
      if (DROP && Math.random() < DROP * 0.3) {
        p.ws.close()
        p.reconnects++
        setTimeout(() => connectPhone(p), 300 + Math.random() * 2000)
      }
    }
    setTimeout(tick, 120 + Math.random() * 480)
  }
  return setTimeout(tick, Math.random() * 300)
})

const cpu0 = process.cpuUsage()
while (performance.now() - t0 < SECONDS * 1000) {
  await sleep(5000)
  const d = lastDiag
  if (d)
    console.log(
      `  t=${Math.round((performance.now() - t0) / 1000)}s manche ${room?.round} ${room?.phase} · ticks ${d.ticksLastSec}/s · tick moy ${d.stepAvgMs} max ${d.stepMaxMs} ms · retard minuteur moy ${d.lateAvgMs} max ${d.lateMaxMs} ms · ${d.memMb} Mo`,
    )
}
timers.forEach(clearTimeout)
await sleep(1500)

// ─── Rapport ────────────────────────────────────────────────────────────────
const rtts = (lastDiag?.players ?? []).map(p => p.rtt).filter(v => v !== null)
const ia = stats(interArrival)
const lat = stats(inputToHost)
let mismatches = 0
for (const p of room.players) {
  const exp = expected.get(p.id) ?? 0
  if (p.score !== exp) mismatches++
}
const cpu = process.cpuUsage(cpu0)
console.log('\n── Résultats ──')
console.log(`manches jouées            : ${rounds}`)
console.log(`trames reçues par l'hôte  : ${frames} · trous de séquence : ${gaps}`)
console.log(
  `intervalle entre trames   : p50 ${f1(ia.p50)} · p95 ${f1(ia.p95)} · p99 ${f1(ia.p99)} · max ${f1(ia.max)} ms (cible ${(1000 / 240).toFixed(1)})`,
)
console.log(
  `commande → trame à l'hôte : p50 ${f1(lat.p50)} · p95 ${f1(lat.p95)} · p99 ${f1(lat.p99)} · max ${f1(lat.max)} ms (n=${lat.n})`,
)
console.log(`RTT téléphones (serveur)  : ${rtts.map(v => Math.round(v)).join(' ') || '—'} ms`)
console.log(`reconnexions              : ${phones.reduce((s, p) => s + p.reconnects, 0)}`)
console.log(`scores ≠ éliminations     : ${mismatches} (phase finale ${room.phase})`)
console.log(`CPU du client de charge   : ${((cpu.user + cpu.system) / 1e6).toFixed(1)} s`)
host.close()
phones.forEach(p => p.ws?.close())
process.exit(gaps === 0 && mismatches === 0 ? 0 : 1)
