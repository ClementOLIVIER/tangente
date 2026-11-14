import type { TunnelInfo } from '../../shared/protocol'
import { isLocalRequest, useGameServer } from '../utils/game'

/**
 * Le lanceur (scripts/start.mjs) publie ici l'URL du tunnel. Réservé aux appels
 * locaux portant le jeton de contrôle généré au lancement.
 */
export default defineEventHandler(async event => {
  const expected = process.env.TANGENTE_CONTROL_TOKEN
  const headers = new Headers(event.node.req.headers as Record<string, string>)
  if (
    !expected ||
    getHeader(event, 'x-control-token') !== expected ||
    !isLocalRequest(event.node.req.socket.remoteAddress, headers)
  ) {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }
  const body = (await readBody(event)) as Partial<TunnelInfo>
  const status = ['off', 'starting', 'up', 'down'].includes(body.status as string)
    ? body.status!
    : 'down'
  const url = typeof body.url === 'string' && /^https:\/\/[\w.-]+$/.test(body.url) ? body.url : null
  useGameServer().setTunnel({
    provider: String(body.provider ?? 'none').slice(0, 32),
    status,
    url,
    error: body.error ? String(body.error).slice(0, 200) : undefined,
  })
  return { ok: true }
})
