import type { IceServerConfig, LinkPath } from '../shared/protocol'

/**
 * Pont WebRTC du serveur, injecté dans `GameServer` : le cœur reste testable
 * sans module natif, l'implémentation réelle (`rtc-node.ts`) utilise
 * node-datachannel (libdatachannel).
 *
 * Le téléphone crée l'offre et un DataChannel `in` non ordonné, sans
 * retransmission ; le serveur répond. La signalisation passe par le WebSocket.
 */
export interface RtcCallbacks {
  onAnswer(sdp: string): void
  onCandidate(candidate: string, mid: string): void
  /** DataChannel ouvert ; `path` décrit le chemin ICE retenu. */
  onOpen(path: LinkPath): void
  onMessage(data: string): void
  onClose(): void
}

export interface RtcPeer {
  addCandidate(candidate: string, mid: string): void
  send(data: string): boolean
  /** RTT ICE/SCTP mesuré par la pile WebRTC (ms), si disponible. */
  rtt(): number | null
  close(): void
}

export interface RtcFactory {
  /** Serveurs ICE à transmettre au téléphone (STUN, TURN éventuel). */
  clientIceServers(): Promise<IceServerConfig[]>
  create(id: string, offerSdp: string, cb: RtcCallbacks): RtcPeer
}

const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|127\.)/
const PRIVATE_V6 = /^(fe80:|fc|fd|::1$)/i

export function isPrivateAddress(addr: string): boolean {
  return PRIVATE_V4.test(addr) || PRIVATE_V6.test(addr) || addr.endsWith('.local')
}

/** Même sous-réseau IPv6 /64 (les box et partages de connexion donnent des IPv6 globales en local). */
function sameV6Prefix(a: string, b: string): boolean {
  if (!a.includes(':') || !b.includes(':')) return false
  const head = (x: string) => x.toLowerCase().split(':').slice(0, 4).join(':')
  return head(a) === head(b)
}

type CandidateInfo = { type: string; address: string }

/**
 * Classe la paire de candidats ICE retenue :
 * - `relay` si l'une des extrémités passe par TURN ;
 * - `lan` si le téléphone est joint sans traduction d'adresse : candidat
 *   `host`, adresse IPv4 privée, ou IPv6 du même /64 que le PC ;
 * - `direct` sinon (traversée de NAT par STUN, sans relais).
 */
export function classifyPath(
  pair: { local: CandidateInfo; remote: CandidateInfo } | null,
): LinkPath {
  if (!pair) return 'direct'
  const { local, remote } = pair
  if (local.type === 'relay' || remote.type === 'relay') return 'relay'
  if (
    remote.type === 'host' ||
    isPrivateAddress(remote.address) ||
    sameV6Prefix(local.address, remote.address)
  )
    return 'lan'
  return 'direct'
}
