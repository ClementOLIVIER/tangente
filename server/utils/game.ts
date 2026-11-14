import { networkInterfaces } from 'node:os'
import { createNodeRtcFactory, rtcEnabled } from '../../game/rtc-node'
import { GameServer } from '../../game/server'
import { createFileStore, stateFilePath } from '../../game/store-node'

/** Port d'écoute effectif (Nitro lit PORT / NITRO_PORT ; 3000 par défaut). */
export function listenPort(): number {
  return Number(process.env.NITRO_PORT || process.env.PORT || 3000)
}

const IGNORED_IFACES = /^(docker|br-|veth|virbr|lxc|vmnet|vboxnet|zt)/

/** URL LAN (IPv4 privées) : les téléphones du même Wi-Fi s'y connectent sans tunnel. */
export function lanUrls(): string[] {
  const port = listenPort()
  const urls: string[] = []
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (IGNORED_IFACES.test(name)) continue
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) urls.push(`http://${a.address}:${port}`)
    }
  }
  return urls
}

const g = globalThis as unknown as { __tangente?: GameServer }

/** Instance unique du serveur de jeu (survit aux rechargements de modules en dev). */
export function useGameServer(): GameServer {
  if (!g.__tangente) {
    let cache: { at: number; urls: string[] } = { at: 0, urls: [] }
    const statePath = stateFilePath(listenPort())
    g.__tangente = new GameServer({
      rtc: rtcEnabled() ? createNodeRtcFactory() : null,
      store: statePath ? createFileStore(statePath) : null,
      lanUrls: () => {
        const now = Date.now()
        if (now - cache.at > 10_000) cache = { at: now, urls: lanUrls() }
        return cache.urls
      },
    })
    if (g.__tangente.restored.length)
      console.info(`[tangente] salons restaurés : ${g.__tangente.restored.join(', ')}`)
    g.__tangente.start()
  }
  return g.__tangente
}

const PROXY_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-host',
  'forwarded',
  'cf-connecting-ip',
  'cf-ray',
  'x-real-ip',
]
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const PRIVATE = /^(::ffff:)?(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/

/**
 * Requête locale = boucle locale ET aucun en-tête de proxy (le tunnel arrive
 * aussi par 127.0.0.1, mais avec cf-connecting-ip / x-forwarded-for).
 * TANGENTE_LAN_HOST=1 autorise aussi un écran hôte sur le réseau local.
 */
export function isLocalRequest(remoteAddress: string | undefined, headers: Headers): boolean {
  if (PROXY_HEADERS.some(h => headers.has(h))) return false
  if (!remoteAddress) return false
  if (LOOPBACK.has(remoteAddress)) return true
  return process.env.TANGENTE_LAN_HOST === '1' && PRIVATE.test(remoteAddress)
}
