#!/usr/bin/env node
/**
 * Test de bout en bout dans un vrai Chrome (headless, piloté par le protocole
 * DevTools — aucune dépendance) contre le vrai serveur de production :
 *
 *  1. écran hôte avec le panneau diagnostic mémorisé ouvert (régression : la
 *     page plantait avant de recevoir le salon) → QR code et code du salon ;
 *  2. téléphone (contexte séparé, écran mobile tactile) : pseudo, rejoindre,
 *     « prêt » ; l'hôte ajoute un bot et lance la partie ;
 *  3. touchers réels sur la manette → l'aller toucher → serveur est mesuré ;
 *  4. **redémarrage du serveur en pleine partie** : l'écran retrouve le même
 *     salon, le téléphone le même joueur, sans rien ressaisir.
 *
 *   node scripts/e2e.mjs [--build] [--headed] [--port 3390]
 *
 * Code de sortie non nul au premier échec.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = n => args.includes(`--${n}`)
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}
const PORT = Number(opt('port', 3390))
const BASE = `http://127.0.0.1:${PORT}`
const tmp = mkdtempSync(join(tmpdir(), 'tangente-e2e-'))
const sleep = ms => new Promise(r => setTimeout(r, ms))
const t0 = Date.now()
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} s`
let failed = false

function ok(msg) {
  console.log(`  ✔ ${stamp()}  ${msg}`)
}
function info(msg) {
  console.log(`  · ${stamp()}  ${msg}`)
}
function fail(msg) {
  console.log(`  ✘ ${stamp()}  ${msg}`)
  failed = true
  throw new Error(msg)
}

// ─── Serveur ────────────────────────────────────────────────────────────────

if (flag('build') || !existsSync(join(root, '.output/server/index.mjs'))) {
  const r = spawnSync('pnpm', ['exec', 'nuxt', 'build'], { cwd: root, stdio: 'inherit' })
  if (r.status !== 0) process.exit(1)
}

let server = null
function startServer() {
  server = spawn('node', ['.output/server/index.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(PORT),
      NITRO_PORT: String(PORT),
      HOST: '127.0.0.1',
      TANGENTE_STATE_FILE: join(tmp, 'rooms.json'),
      ...(process.env.E2E_STUN ? {} : { TANGENTE_STUN: 'none' }),
      NITRO_SHUTDOWN_TIMEOUT: '4000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stderr.on('data', d => process.env.E2E_DEBUG && process.stderr.write(d))
  server.stdout.on('data', d => process.env.E2E_DEBUG && process.stdout.write(d))
}
async function waitHealthy(ms = 20_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      const r = await fetch(`${BASE}/api/health`)
      if (r.ok && (await r.json()).app === 'tangente') return
    } catch {
      // pas encore prêt
    }
    await sleep(50)
  }
  fail('le serveur ne répond pas')
}
function stopServer() {
  return new Promise(resolve => {
    if (!server || server.exitCode !== null) return resolve()
    server.once('exit', () => resolve())
    server.kill('SIGTERM')
  })
}

// ─── Chrome + protocole DevTools ────────────────────────────────────────────

const chromeBin = ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'].find(
  b => spawnSync('sh', ['-c', `command -v ${b}`]).status === 0,
)
if (!chromeBin) {
  console.log('Chrome/Chromium introuvable : test de bout en bout ignoré')
  process.exit(0)
}

let chrome = null
async function launchChrome() {
  chrome = spawn(
    chromeBin,
    [
      ...(flag('headed') ? [] : ['--headless=new']),
      '--remote-debugging-port=0',
      `--user-data-dir=${join(tmp, 'chrome')}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  return new Promise((resolve, reject) => {
    let buf = ''
    chrome.stderr.on('data', d => {
      buf += d
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/)
      if (m) resolve(m[1])
    })
    chrome.on('exit', () => reject(new Error('Chrome s’est arrêté')))
    setTimeout(() => reject(new Error('Chrome ne démarre pas')), 15_000)
  })
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.pending = new Map()
    this.ws.onmessage = ev => {
      const m = JSON.parse(ev.data)
      const p = m.id !== undefined && this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`))
      else p.resolve(m.result)
    }
  }
  ready() {
    return new Promise((res, rej) => {
      this.ws.onopen = res
      this.ws.onerror = rej
    })
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }))
  }
}

/** Onglet dans un contexte isolé (son propre localStorage, comme un autre appareil). */
async function newPage(cdp, name) {
  const { browserContextId } = await cdp.send('Target.createBrowserContext')
  const { targetId } = await cdp.send('Target.createTarget', {
    url: 'about:blank',
    browserContextId,
  })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  const s = (method, params) => cdp.send(method, params, sessionId)
  await s('Page.enable')
  await s('Runtime.enable')
  const page = {
    name,
    s,
    async eval(expression) {
      const r = await s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (r.exceptionDetails)
        throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
      return r.result.value
    },
    async waitFor(expression, label, ms = 10_000) {
      const end = Date.now() + ms
      let last
      while (Date.now() < end) {
        try {
          last = await page.eval(expression)
          if (last) return last
        } catch {
          // page en cours de chargement
        }
        await sleep(50)
      }
      const seen = (await page.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 400)
      fail(`${name} : ${label} (délai dépassé)\n      page : ${seen}`)
    },
    text: () => page.eval('document.body ? document.body.innerText : ""'),
    goto: url => s('Page.navigate', { url }),
    clickText(text) {
      return page.eval(`(() => {
        const b = [...document.querySelectorAll('button')].find(b => b.innerText.includes(${JSON.stringify(text)}))
        if (!b) return false
        b.click()
        return true
      })()`)
    },
  }
  return page
}

// ─── Scénario ───────────────────────────────────────────────────────────────

async function main() {
  console.log(`Tangente — bout en bout (${chromeBin}, port ${PORT})`)
  startServer()
  await waitHealthy()
  ok('serveur de production démarré')

  const cdp = new Cdp(await launchChrome())
  await cdp.ready()

  // 1. écran hôte, panneau diagnostic mémorisé ouvert
  const host = await newPage(cdp, 'écran')
  await host.s('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { if (!localStorage.getItem('dk:diag')) localStorage.setItem('dk:diag', 'true') } catch {}`,
  })
  await host.s('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await host.goto(`${BASE}/host`)
  const code = await host.waitFor(
    `(() => { try { return JSON.parse(localStorage.getItem('dk:host')).code } catch { return null } })()`,
    'code du salon',
  )
  const hostText = await host.text()
  if (hostText.includes('Internal Server Error')) fail('écran : erreur 500')
  if (!hostText.includes(code)) fail('écran : code du salon non affiché')
  if (!(await host.eval(`!!document.querySelector('svg path, svg rect')`)))
    fail('écran : QR code absent')
  if (!hostText.includes('Diagnostic')) fail('écran : panneau diagnostic absent')
  ok(`écran hôte : salon ${code}, QR code et diagnostic affichés`)

  // 2. téléphone
  const phone = await newPage(cdp, 'téléphone')
  await phone.s('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
  })
  await phone.s('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await phone.goto(`${BASE}/play/${code}`)
  await phone.waitFor(`!!document.querySelector('form input')`, 'formulaire')
  await phone.eval(`(() => {
    const i = document.querySelector('form input')
    i.value = 'E2E'
    i.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector('form').requestSubmit()
  })()`)
  await phone.waitFor(`document.body.innerText.includes('Je suis prêt')`, 'salon rejoint')
  const token = await phone.eval(`localStorage.getItem('dk:player:${code}')`)
  await phone.clickText('Je suis prêt')
  await phone.waitFor(`document.body.innerText.includes('PRÊT')`, 'prêt')
  await host.waitFor(`document.body.innerText.includes('E2E')`, 'joueur listé')
  ok('téléphone : pseudo, salon rejoint, prêt — visible sur l’écran')

  if (!(await host.clickText('+ bot'))) fail('écran : bouton « + bot » absent')
  await sleep(150)
  if (!(await host.clickText('Lancer la partie')))
    fail('écran : bouton « Lancer la partie » absent')
  await phone.waitFor(`document.body.innerText.includes('◀')`, 'manette affichée')
  ok('partie lancée : manette affichée')

  // 3. touchers réels (Input.dispatchTouchEvent) → aller mesuré par le serveur
  // WebRTC s'ouvre en quelques centaines de ms ; « tunnel » = WebSocket seul
  const pathExpr = `/Wi-Fi direct|direct|relais|tunnel/.exec(document.querySelector('header')?.innerText ?? '')?.[0] ?? ''`
  let path = ''
  for (let i = 0; i < 60 && (!path || path === 'tunnel'); i++) {
    path = await phone.eval(pathExpr).catch(() => '')
    if (path && path !== 'tunnel') break
    await sleep(100)
  }
  // même machine : WebRTC doit s'ouvrir (sinon les commandes ne passent que par le WebSocket)
  if (path !== 'Wi-Fi direct') fail(`WebRTC ne s'ouvre pas (chemin : ${path || 'inconnu'})`)
  ok('WebRTC ouvert : commandes en direct sur le réseau local')
  for (let k = 0; k < 12; k++) {
    const x = k % 2 ? 300 : 90
    await phone.s('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: 500 }] })
    await sleep(60)
    await phone.s('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await sleep(60)
  }
  const uplink = await phone.waitFor(
    `/↑ (\\d+) ms/.exec(document.querySelector('header')?.innerText ?? '')?.[1]`,
    'aller toucher → serveur',
    8000,
  )
  ok(`touchers reçus par le serveur : aller ${uplink} ms (${path})`)

  // 4. redémarrage du serveur en pleine partie
  await sleep(500)
  const tStop = Date.now()
  const stopped = stopServer().then(() => Date.now())
  // instant où le port ne répond plus (le nouveau serveur peut alors démarrer)
  const portFreed = (async () => {
    for (;;) {
      try {
        await fetch(`${BASE}/api/health`)
      } catch {
        return Date.now()
      }
      await sleep(5)
    }
  })()
  const banner = await phone.waitFor(
    `document.body.innerText.includes('Mise à jour du serveur')`,
    'bandeau « mise à jour »',
    3000,
  )
  const freedAt = await portFreed
  ok(
    `arrêt propre : port libéré ${freedAt - tStop} ms après SIGTERM, bandeau « mise à jour » ${banner ? 'affiché' : 'absent'}`,
  )
  const downAt = freedAt
  // comme le lanceur : le nouveau serveur démarre dès que le port est libre
  startServer()
  stopped.then(at => info(`ancien processus terminé ${at - tStop} ms après SIGTERM (en parallèle)`))
  await waitHealthy()
  const upAt = Date.now()
  ok(`serveur relancé en ${upAt - downAt} ms`)

  await host.waitFor(
    `(() => { const t = document.body.innerText; return t.includes(${JSON.stringify(code)}) && t.includes('E2E') && !t.includes('Mise à jour du serveur') && !t.includes('Connexion au serveur perdue') })()`,
    'écran reconnecté au même salon',
  )
  const hostBack = Date.now()
  if ((await host.text()).includes('Internal Server Error'))
    fail('écran : erreur 500 après relance')
  const sameCode = await host.eval(`JSON.parse(localStorage.getItem('dk:host')).code`)
  if (sameCode !== code) fail(`écran : nouveau salon ${sameCode} au lieu de ${code}`)
  ok(`écran : même salon ${code} retrouvé ${hostBack - upAt} ms après la relance`)

  await phone.waitFor(
    `(() => { const t = document.body.innerText; return t.includes('E2E') && !t.includes('reconnexion') && !t.includes('Mise à jour') && !t.includes('introuvable') })()`,
    'téléphone reconnecté au même joueur',
  )
  const phoneBack = Date.now()
  const token2 = await phone.eval(`localStorage.getItem('dk:player:${code}')`)
  if (token2 !== token) fail('téléphone : jeton changé (nouveau joueur)')
  ok(`téléphone : même joueur, sans rien ressaisir, ${phoneBack - upAt} ms après la relance`)
  const after = await phone.text()
  info(`téléphone après relance : ${after.split('\n').filter(Boolean).slice(0, 3).join(' | ')}`)

  // la partie continue : l'hôte relance une partie, la manette réapparaît
  // manche 1 interrompue → retour au salon ; manche déjà finie → manche suivante
  if (!(await host.clickText('Lancer la partie')) && !(await host.clickText('Manche suivante')))
    fail('écran : ni « Lancer la partie » ni « Manche suivante »')
  await phone.waitFor(`document.body.innerText.includes('◀')`, 'manette après relance')
  ok('nouvelle manche lancée après le redémarrage')

  // 5. redémarrage « à froid » : sauvegarde perdue — même code, le téléphone rejoint seul
  await stopServer()
  rmSync(join(tmp, 'rooms.json'), { force: true })
  startServer()
  await waitHealthy()
  const coldAt = Date.now()
  await host.waitFor(
    `(() => { const t = document.body.innerText; return t.includes(${JSON.stringify(code)}) && t.includes('E2E') && !t.includes('Mise à jour du serveur') })()`,
    'écran : même code et joueur revenu après relance à froid',
  )
  await phone.waitFor(
    `(() => { const t = document.body.innerText; return t.includes('E2E') && t.includes('Je suis prêt') && !t.includes('Mise à jour') })()`,
    'téléphone : rejoint seul après relance à froid',
  )
  const token3 = await phone.eval(`localStorage.getItem('dk:player:${code}')`)
  if (!token3 || token3 === token) fail('téléphone : pas de nouveau jeton après relance à froid')
  ok(`relance à froid : même code ${code}, téléphone revenu seul en ${Date.now() - coldAt} ms`)
}

try {
  await main()
} catch (err) {
  if (!failed) console.log(`  ✘ ${stamp()}  ${err?.message ?? err}`)
  failed = true
} finally {
  chrome?.kill('SIGKILL')
  await stopServer()
  rmSync(tmp, { recursive: true, force: true })
}
console.log(failed ? '\nÉCHEC' : '\nOK — bout en bout réussi')
process.exit(failed ? 1 : 0)
