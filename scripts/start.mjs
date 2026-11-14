#!/usr/bin/env node
/**
 * Lanceur Tangente : serveur de jeu (build de production ou dev) + tunnel
 * public facultatif, supervisés ensemble.
 *
 *   node scripts/start.mjs                       # serveur seul (build existant)
 *   node scripts/start.mjs --build               # rebuild puis serveur
 *   node scripts/start.mjs --tunnel cloudflared  # + Cloudflare Quick Tunnel
 *   node scripts/start.mjs --tunnel localhostrun # + localhost.run (SSH)
 *   node scripts/start.mjs --dev                 # nuxt dev au lieu du build
 *   node scripts/start.mjs --kiosk               # écran hôte dans Chrome plein écran, sans vsync
 *   node scripts/start.mjs --stop                # arrête le lanceur en cours (serveur + tunnel)
 *   options : --port 3000 --open
 *
 * **Relance à chaud.** Si un lanceur tourne déjà sur ce port, la même commande
 * ne le remplace pas : elle construit la nouvelle version à côté
 * (`.output-next`, la partie continue pendant ce temps), puis demande au
 * lanceur en place de redémarrer le seul serveur sur cette version. Le tunnel
 * — donc l'URL publique et le QR code — ne bouge pas, les salons sont
 * restaurés (`.data/rooms.json`) et écrans et téléphones se reconnectent
 * seuls. Si la nouvelle version ne répond pas, l'ancienne est remise en place.
 *
 * Le tunnel est un processus séparé : s'il tombe, le jeu local continue ; il
 * est relancé (nouvelle URL, poussée au tableau de bord et au QR code). Un
 * serveur qui plante est relancé lui aussi (3 plantages en une minute :
 * arrêt). Pas de bascule automatique vers localhost.run : ses serveurs sont aux
 * États-Unis (+80 à +100 ms) ; il reste disponible avec --tunnel localhostrun.
 */
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { Resolver } from 'node:dns/promises'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { get as httpsGet } from 'node:https'
import { createServer } from 'node:net'
import { networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = name => args.includes(`--${name}`)
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def
}

const PORT = Number(opt('port', process.env.PORT || 3000))
const DEV = flag('dev')
let tunnelProvider = opt('tunnel', process.env.TANGENTE_TUNNEL || 'none')
const CONTROL_TOKEN = randomBytes(18).toString('base64url')
const OUTPUT = join(root, '.output')
const OUTPUT_NEXT = join(root, '.output-next')
const OUTPUT_PREV = join(root, '.output-prev')
const STATE_DIR = join(root, '.data')
const LAUNCHER_FILE = join(STATE_DIR, `launcher-${PORT}.json`)
const children = new Set()
let shuttingDown = false

const c = (code, s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s)
const log = (...m) =>
  console.log(c('2', `[tangente ${new Date().toLocaleTimeString('fr-FR')}]`), ...m)
const sleep = ms => new Promise(r => setTimeout(r, ms))

function has(cmd) {
  return spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0
}

function run(cmd, cmdArgs, opts = {}) {
  const child = spawn(cmd, cmdArgs, { cwd: root, ...opts })
  children.add(child)
  child.on('exit', () => children.delete(child))
  return child
}

function lanUrls() {
  const out = []
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (/^(docker|br-|veth|virbr|lxc|vmnet|vboxnet|zt)/.test(name)) continue
    for (const a of addrs ?? [])
      if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${PORT}`)
  }
  return out
}

function nuxtBuild(outputDir) {
  const env = { ...process.env }
  if (outputDir) env.TANGENTE_OUTPUT_DIR = outputDir
  else delete env.TANGENTE_OUTPUT_DIR
  return spawnSync('pnpm', ['exec', 'nuxt', 'build'], { cwd: root, stdio: 'inherit', env }).status
}

// ─── Lanceur déjà en place : relance à chaud ou arrêt ───────────────────────

function readLauncher() {
  try {
    return JSON.parse(readFileSync(LAUNCHER_FILE, 'utf8'))
  } catch {
    return null
  }
}

/** Le pid est vivant ET c'est bien notre lanceur (pas un pid recyclé). */
function launcherAlive(info) {
  if (!info?.pid) return false
  try {
    process.kill(info.pid, 0)
  } catch {
    return false
  }
  try {
    return readFileSync(`/proc/${info.pid}/cmdline`, 'utf8').includes('start.mjs')
  } catch {
    return true // pas de /proc (macOS) : on se fie au pid
  }
}

function writeLauncher(patch) {
  mkdirSync(STATE_DIR, { recursive: true })
  const cur = readLauncher() ?? {}
  writeFileSync(LAUNCHER_FILE, JSON.stringify({ ...cur, ...patch }, null, 2))
}

const running = readLauncher()
if (launcherAlive(running)) {
  if (flag('stop')) {
    process.kill(running.pid, 'SIGTERM')
    for (let i = 0; i < 50 && launcherAlive(running); i++) await sleep(200)
    log(launcherAlive(running) ? c('31', 'le lanceur ne s’arrête pas') : 'Tangente arrêté')
    process.exit(launcherAlive(running) ? 1 : 0)
  }
  log(`un lanceur tourne déjà sur le port ${PORT} (pid ${running.pid}) : relance à chaud`)
  if (args.some(a => ['--tunnel', '--kiosk', '--open', '--dev'].includes(a)))
    log('(options de tunnel / écran ignorées : le tunnel en place est conservé)')
  rmSync(OUTPUT_NEXT, { recursive: true, force: true })
  if (flag('build') && !running.dev) {
    log('build de la nouvelle version à côté (.output-next) — la partie continue…')
    if (nuxtBuild(OUTPUT_NEXT) !== 0) {
      rmSync(OUTPUT_NEXT, { recursive: true, force: true })
      log(
        c('31', 'build en échec : rien n’a été changé, la partie continue sur l’ancienne version'),
      )
      process.exit(1)
    }
  }
  const generation = running.generation ?? 0
  process.kill(running.pid, 'SIGUSR2')
  log('redémarrage du serveur (tunnel conservé)…')
  for (let i = 0; i < 300; i++) {
    await sleep(200)
    const now = readLauncher()
    if ((now?.generation ?? 0) > generation) {
      if (now.lastRestart?.ok) {
        log(
          c(
            '32',
            `serveur relancé en ${now.lastRestart.ms} ms — salons restaurés, clients reconnectés`,
          ),
        )
        log(c('1', `Tableau de bord : http://localhost:${PORT}/host`))
        if (now.tunnelUrl) log(`Tunnel public (inchangé) : ${now.tunnelUrl}`)
        process.exit(0)
      }
      log(c('31', `relance en échec : ${now.lastRestart?.error ?? 'inconnu'}`))
      process.exit(1)
    }
    if (!launcherAlive(running)) {
      log(c('31', 'le lanceur s’est arrêté pendant la relance'))
      process.exit(1)
    }
  }
  log(c('31', 'pas de réponse du lanceur après 60 s'))
  process.exit(1)
}
if (flag('stop')) {
  log(`aucun lanceur Tangente sur le port ${PORT}`)
  process.exit(0)
}

// ─── Serveur ────────────────────────────────────────────────────────────────

if (!DEV && (flag('build') || !existsSync(join(OUTPUT, 'server/index.mjs')))) {
  log('build de production (nuxt build)…')
  const status = nuxtBuild(null)
  if (status !== 0) process.exit(status ?? 1)
}

/** Le port doit être libre sur toutes les interfaces ET en boucle locale (une autre appli peut n'écouter que 127.0.0.1). */
function portFree(port, host) {
  return new Promise(resolve => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, host, () => srv.close(() => resolve(true)))
  })
}
if (!(await portFree(PORT, '0.0.0.0')) || !(await portFree(PORT, '127.0.0.1'))) {
  log(
    c(
      '31',
      `le port ${PORT} est déjà utilisé par une autre application : choisissez-en un autre (--port 3200)`,
    ),
  )
  process.exit(1)
}

const serverEnv = {
  ...process.env,
  PORT: String(PORT),
  NITRO_PORT: String(PORT),
  TANGENTE_CONTROL_TOKEN: CONTROL_TOKEN,
  // le serveur de jeu ferme lui-même ses WebSockets à l'arrêt : inutile d'attendre 30 s
  NITRO_SHUTDOWN_TIMEOUT: '4000',
}

let server = null
let restarting = false
const crashes = []

function startServer() {
  const child = DEV
    ? run('pnpm', ['exec', 'nuxt', 'dev', '--host', '0.0.0.0', '--port', String(PORT)], {
        env: serverEnv,
        stdio: 'inherit',
      })
    : run('node', ['.output/server/index.mjs'], {
        env: { ...serverEnv, HOST: '0.0.0.0' },
        stdio: 'inherit',
      })
  server = child
  child.on('exit', code => {
    if (shuttingDown || restarting || server !== child) return
    // plantage : relance (salons restaurés depuis l'instantané), sauf en boucle
    const now = Date.now()
    crashes.push(now)
    while (crashes.length && now - crashes[0] > 60_000) crashes.shift()
    if (crashes.length >= 3) {
      log(c('31', `le serveur plante en boucle (code ${code}) : arrêt`))
      shutdown(code ?? 1)
      return
    }
    log(c('31', `le serveur s'est arrêté (code ${code}) — relance…`))
    setTimeout(async () => {
      if (shuttingDown) return
      startServer()
      if (await waitHealthy()) {
        log(c('32', 'serveur relancé — salons restaurés'))
        republishTunnel()
      }
    }, 1000)
  })
  return child
}

function stopChild(child, timeoutMs = 8000) {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve()
    const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.once('exit', () => {
      clearTimeout(t)
      resolve()
    })
    child.kill('SIGTERM')
  })
}

async function waitHealthy(timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`)
      // on vérifie que c'est bien Tangente qui répond, jamais une autre appli sur le même port
      if (r.ok && (await r.json().catch(() => null))?.app === 'tangente') return true
    } catch {
      // pas encore prêt
    }
    if (server && server.exitCode !== null) return false
    await sleep(150)
  }
  return false
}

let lastTunnelInfo = null

async function publishTunnel(info) {
  lastTunnelInfo = info
  writeLauncher({ tunnelUrl: info.status === 'up' ? info.url : null })
  try {
    await fetch(`http://127.0.0.1:${PORT}/api/tunnel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-control-token': CONTROL_TOKEN },
      body: JSON.stringify(info),
    })
  } catch {
    // serveur en cours d'arrêt
  }
}

/** Un serveur neuf ne connaît pas le tunnel : on lui redonne l'état courant. */
function republishTunnel() {
  if (lastTunnelInfo) publishTunnel(lastTunnelInfo)
}

/**
 * Relance à chaud (SIGUSR2) : arrêt propre du serveur (il sauvegarde ses
 * salons), bascule sur `.output-next` s'il existe, redémarrage, vérification ;
 * en cas d'échec, retour à la version précédente. Le tunnel ne bouge pas.
 */
/**
 * Arrête le serveur et rend la main dès que le port est libéré : l'ancien
 * processus a déjà sauvegardé ses salons (premier geste à SIGTERM) ; la fin
 * de son extinction (bibliothèque WebRTC native : ~2 s) se poursuit en
 * parallèle sans retarder le nouveau serveur.
 */
async function releaseServer(child) {
  const exited = stopChild(child)
  const freed = (async () => {
    const end = Date.now() + 8000
    while (Date.now() < end) {
      if ((await portFree(PORT, '0.0.0.0')) && (await portFree(PORT, '127.0.0.1'))) return
      await sleep(5)
    }
    await exited
  })()
  await Promise.race([exited, freed])
}

async function hotRestart() {
  if (restarting || shuttingDown) return
  restarting = true
  const t0 = Date.now()
  let swapped = false
  let result = { ok: false, error: 'inconnu' }
  try {
    await releaseServer(server)
    if (!DEV && existsSync(join(OUTPUT_NEXT, 'server/index.mjs'))) {
      rmSync(OUTPUT_PREV, { recursive: true, force: true })
      if (existsSync(OUTPUT)) renameSync(OUTPUT, OUTPUT_PREV)
      renameSync(OUTPUT_NEXT, OUTPUT)
      swapped = true
      log('nouvelle version en place')
    }
    startServer()
    if (await waitHealthy(30_000)) {
      result = { ok: true, ms: Date.now() - t0 }
    } else if (swapped) {
      log(c('31', 'la nouvelle version ne répond pas : retour à la précédente'))
      await releaseServer(server)
      rmSync(OUTPUT_NEXT, { recursive: true, force: true })
      renameSync(OUTPUT, OUTPUT_NEXT)
      renameSync(OUTPUT_PREV, OUTPUT)
      startServer()
      const back = await waitHealthy(30_000)
      result = {
        ok: false,
        error: back
          ? 'nouvelle version défaillante (gardée dans .output-next) — ancienne version rétablie'
          : 'nouvelle version défaillante et ancienne injoignable',
      }
    } else {
      result = { ok: false, error: 'le serveur ne répond pas sur /api/health' }
    }
  } catch (err) {
    result = { ok: false, error: String(err?.message ?? err) }
  }
  restarting = false
  if (result.ok) {
    log(c('32', `serveur relancé en ${result.ms} ms (tunnel conservé)`))
    republishTunnel()
  } else log(c('31', `relance : ${result.error}`))
  const cur = readLauncher() ?? {}
  writeLauncher({ generation: (cur.generation ?? 0) + 1, lastRestart: result })
}

// ─── Tunnel ─────────────────────────────────────────────────────────────────

const PROVIDERS = {
  cloudflared: {
    available: () => has('cloudflared'),
    // --no-autoupdate : pas de redémarrage surprise en pleine soirée
    spawn: () =>
      run('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`]),
    url: /https:\/\/[a-z0-9-]+\.trycloudflare\.com/,
  },
  localhostrun: {
    available: () => has('ssh'),
    spawn: () =>
      run('ssh', [
        '-o',
        'StrictHostKeyChecking=accept-new',
        '-o',
        'ServerAliveInterval=30',
        '-o',
        'ExitOnForwardFailure=yes',
        '-R',
        `80:localhost:${PORT}`,
        'nokey@localhost.run',
      ]),
    url: /https:\/\/[a-z0-9-]+\.(?:lhr\.life|localhost\.run)/,
  },
}

let failures = 0

function startTunnel() {
  if (shuttingDown || tunnelProvider === 'none') return
  const p = PROVIDERS[tunnelProvider]
  if (!p) {
    log(c('31', `tunnel inconnu : ${tunnelProvider} (cloudflared | localhostrun | none)`))
    return
  }
  if (!p.available()) {
    log(c('33', `${tunnelProvider} introuvable dans le PATH — Wi-Fi local seulement`))
    publishTunnel({ provider: tunnelProvider, status: 'down', url: null, error: 'non installé' })
    return
  }
  log(`ouverture du tunnel ${tunnelProvider}…`)
  publishTunnel({ provider: tunnelProvider, status: 'starting', url: null })
  const child = p.spawn()
  let url = null
  const onData = buf => {
    const text = buf.toString()
    if (process.env.TANGENTE_TUNNEL_DEBUG) process.stderr.write(text)
    const m = text.match(p.url)
    if (m && m[0] !== url) {
      url = m[0]
      failures = 0
      log(c('32', `tunnel public : ${url}`))
      log(`QR code : ${url}/play/<CODE> (affiché sur le tableau de bord)`)
      publishTunnel({ provider: tunnelProvider, status: 'up', url })
      verify(url)
    }
  }
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)
  child.on('exit', code => {
    if (shuttingDown) return
    failures++
    log(c('33', `tunnel ${tunnelProvider} fermé (code ${code}) — le jeu local continue`))
    publishTunnel({
      provider: tunnelProvider,
      status: 'down',
      url: null,
      error: `arrêt (code ${code})`,
    })
    if (failures >= 3)
      log(c('33', 'tunnel instable — essayez --tunnel localhostrun (plus lent) ou le Wi-Fi local'))
    setTimeout(startTunnel, Math.min(30_000, 2000 * 2 ** failures))
  })
}

/**
 * Vérifie que l'URL publique répond. La résolution passe par un DNS public
 * (1.1.1.1) : interroger le résolveur local trop tôt, avant la propagation du
 * Quick Tunnel, lui ferait mettre en cache une réponse négative pendant
 * plusieurs minutes (les téléphones, eux, utilisent leur propre DNS).
 */
async function verify(url) {
  const host = new URL(url).hostname
  const resolver = new Resolver()
  resolver.setServers(['1.1.1.1', '8.8.8.8'])
  await sleep(4000)
  for (let i = 0; i < 20; i++) {
    try {
      const [ip] = await resolver.resolve4(host)
      const status = await new Promise((resolve, reject) => {
        const req = httpsGet(
          { host: ip, servername: host, headers: { host }, path: '/api/health', timeout: 5000 },
          res => {
            res.resume()
            resolve(res.statusCode)
          },
        )
        req.on('timeout', () => req.destroy(new Error('timeout')))
        req.on('error', reject)
      })
      if (status === 200) {
        log(c('32', `tunnel vérifié : ${url}/api/health répond (via ${ip})`))
        return
      }
    } catch {
      // DNS pas encore propagé
    }
    await sleep(2000)
  }
  log(c('33', `le tunnel ne répond pas encore (${url}) — vérifiez votre connexion`))
}

// ─── Démarrage ──────────────────────────────────────────────────────────────

/**
 * Écran hôte en Chrome kiosque, réglé pour la latence : pas de synchronisation
 * verticale ni de limite d'images (l'image part dès qu'elle est dessinée, au
 * prix d'un léger déchirement), profil dédié pour que les options s'appliquent
 * même si Chrome est déjà ouvert.
 */
function openKiosk() {
  const bin = ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'].find(has)
  if (!bin) {
    log(c('33', 'Chrome/Chromium introuvable : ouvrez le tableau de bord à la main'))
    return
  }
  const profile = join(root, '.data', 'chrome-kiosk')
  run(
    bin,
    [
      `--user-data-dir=${profile}`,
      '--kiosk',
      `--app=http://localhost:${PORT}/host`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu-vsync',
      '--disable-frame-rate-limit',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--autoplay-policy=no-user-gesture-required',
    ],
    { stdio: 'ignore' },
  )
  log(`écran hôte ouvert en kiosque (${bin}, sans vsync) — Alt+F4 pour quitter`)
}

async function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  // le serveur d'abord (il sauvegarde ses salons), le tunnel ensuite
  await stopChild(server, 5000)
  for (const ch of children) ch.kill('SIGTERM')
  try {
    if (readLauncher()?.pid === process.pid) rmSync(LAUNCHER_FILE, { force: true })
  } catch {
    // rien à nettoyer
  }
  setTimeout(() => process.exit(code), 300)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
process.on('SIGUSR2', () => hotRestart())

writeLauncher({
  pid: process.pid,
  port: PORT,
  dev: DEV,
  tunnel: tunnelProvider,
  tunnelUrl: null,
  generation: 0,
  startedAt: new Date().toISOString(),
})
startServer()

if (await waitHealthy()) {
  console.log()
  log(c('1', `Tableau de bord (écran / TV) : http://localhost:${PORT}/host`))
  for (const u of lanUrls()) log(`Accès Wi-Fi local (téléphones sur le même réseau) : ${u}`)
  if (tunnelProvider === 'none')
    log('Pas de tunnel : ajoutez --tunnel cloudflared pour les téléphones hors Wi-Fi')
  log(
    c('2', 'relance à chaud (tunnel conservé) : relancez la même commande, avec --build si besoin'),
  )
  console.log()
  if (flag('kiosk')) openKiosk()
  else if (flag('open'))
    spawn('xdg-open', [`http://localhost:${PORT}/host`], {
      stdio: 'ignore',
      detached: true,
    }).unref()
  startTunnel()
} else {
  log(c('31', 'le serveur ne répond pas sur /api/health'))
  shutdown(1)
}
