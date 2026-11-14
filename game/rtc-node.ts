import nodeDataChannel, { type DataChannel } from 'node-datachannel'
import type { IceServerConfig } from '../shared/protocol'
import { classifyPath, type RtcCallbacks, type RtcFactory, type RtcPeer } from './rtc'

/**
 * Implémentation WebRTC réelle (node-datachannel). Configuration par variables
 * d'environnement :
 *   TANGENTE_STUN                  URL STUN séparées par des virgules (défaut : Cloudflare + Google),
 *                                   `none` pour n'utiliser que le réseau local
 *   TANGENTE_TURN_URLS             URL TURN (ex. turn:turn.example.com:3478?transport=udp)
 *   TANGENTE_TURN_USERNAME / _CREDENTIAL
 *   TANGENTE_CF_TURN_KEY_ID / TANGENTE_CF_TURN_API_TOKEN
 *                                   identifiants TURN Cloudflare générés à la volée (TTL 24 h)
 *   TANGENTE_RTC=0                 désactive WebRTC (WebSocket seul)
 */

const DEFAULT_STUN = ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302']

function stunUrls(): string[] {
  const env = process.env.TANGENTE_STUN
  if (env === 'none') return [] // réseau local seul (tests, soirée hors Internet)
  return env
    ? env
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
    : DEFAULT_STUN
}

let cfCache: { at: number; servers: IceServerConfig[] } | null = null

async function cloudflareTurn(): Promise<IceServerConfig[]> {
  const keyId = process.env.TANGENTE_CF_TURN_KEY_ID
  const token = process.env.TANGENTE_CF_TURN_API_TOKEN
  if (!keyId || !token) return []
  if (cfCache && Date.now() - cfCache.at < 3600_000) return cfCache.servers
  try {
    const r = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ttl: 86_400 }),
        signal: AbortSignal.timeout(4000),
      },
    )
    if (!r.ok) return []
    const body = (await r.json()) as { iceServers?: IceServerConfig | IceServerConfig[] }
    const list = Array.isArray(body.iceServers)
      ? body.iceServers
      : body.iceServers
        ? [body.iceServers]
        : []
    // les URL STUN de la réponse sont déjà fournies par ailleurs ; on garde TURN
    const servers = list
      .map(s => ({ ...s, urls: ([] as string[]).concat(s.urls).filter(u => u.startsWith('turn')) }))
      .filter(s => s.urls.length)
    cfCache = { at: Date.now(), servers }
    return servers
  } catch {
    return []
  }
}

function staticTurn(): IceServerConfig[] {
  const urls = process.env.TANGENTE_TURN_URLS
  if (!urls) return []
  return [
    {
      urls: urls.split(',').map(s => s.trim()),
      username: process.env.TANGENTE_TURN_USERNAME,
      credential: process.env.TANGENTE_TURN_CREDENTIAL,
    },
  ]
}

export function rtcEnabled(): boolean {
  return process.env.TANGENTE_RTC !== '0'
}

export function createNodeRtcFactory(): RtcFactory {
  return {
    async clientIceServers() {
      // pas d'entrée `{ urls: [] }` : Chrome refuse une liste vide (RTCPeerConnection lève)
      const stun = stunUrls()
      return [
        ...(stun.length ? [{ urls: stun }] : []),
        ...staticTurn(),
        ...(await cloudflareTurn()),
      ]
    },

    create(id: string, offerSdp: string, cb: RtcCallbacks): RtcPeer {
      const pc = new nodeDataChannel.PeerConnection(id, {
        iceServers: stunUrls(),
        // les commandes font quelques octets : pas besoin de gros messages
        maxMessageSize: 4096,
      })
      let dc: DataChannel | null = null
      let closed = false
      const close = () => {
        if (closed) return
        closed = true
        cb.onClose()
        try {
          dc?.close()
          pc.close()
        } catch {
          // déjà fermé
        }
      }
      pc.onLocalDescription((sdp, type) => {
        if (type === 'answer') cb.onAnswer(sdp)
      })
      pc.onLocalCandidate((candidate, mid) => cb.onCandidate(candidate.replace(/^a=/, ''), mid))
      pc.onStateChange(state => {
        if (state === 'failed' || state === 'closed') close()
      })
      pc.onDataChannel(channel => {
        dc = channel
        const opened = () => cb.onOpen(classifyPath(pc.getSelectedCandidatePair()))
        if (channel.isOpen()) opened()
        else channel.onOpen(opened)
        channel.onMessage(msg =>
          cb.onMessage(typeof msg === 'string' ? msg : Buffer.from(msg as ArrayBuffer).toString()),
        )
        channel.onClosed(close)
      })
      pc.setRemoteDescription(offerSdp, 'offer')
      return {
        addCandidate(candidate, mid) {
          try {
            pc.addRemoteCandidate(candidate.replace(/^a=/, ''), mid)
          } catch {
            // candidat non résolu (ex. mDNS .local) : la connectivité passera par un autre
          }
        },
        send(data) {
          try {
            return !!dc?.isOpen() && dc.sendMessage(data)
          } catch {
            return false
          }
        },
        rtt() {
          try {
            const v = pc.rtt()
            return v > 0 ? v : null
          } catch {
            return null
          }
        },
        close,
      }
    },
  }
}
