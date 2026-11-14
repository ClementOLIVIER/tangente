import type { IceServerConfig } from '../../shared/protocol'

/**
 * Lien des commandes du téléphone vers le PC, sur deux chemins à la fois :
 *
 * - **DataChannel WebRTC** `in` (UDP, non ordonné, sans retransmission) : le
 *   plus rapide. ICE choisit seul le meilleur trajet — en direct sur le Wi-Fi
 *   local même si la page vient du tunnel, sinon traversée de NAT (STUN) ou
 *   relais TURN. Chaque commande y part 3 fois (0, 6, 20 ms) contre les pertes ;
 * - **WebSocket** : copie fiable de chaque commande (et seul chemin si WebRTC
 *   échoue).
 *
 * Chaque commande porte un numéro croissant : le serveur applique la première
 * copie reçue et ignore les autres. Pendant une manche, l'état courant est
 * renvoyé toutes les 50 ms (DataChannel) / 250 ms (WebSocket) : cela répare une
 * perte et garde la radio du téléphone éveillée (pas de « réveil » 4G/Wi-Fi au
 * premier appui). L'horloge est synchronisée sur celle du serveur pour mesurer
 * l'aller seul, depuis l'instant exact du toucher.
 */
export type RtcState = 'off' | 'connecting' | 'open' | 'failed'

interface SocketLike {
  send(data: string): boolean
  sendJson(data: object): boolean
}

const HEARTBEAT_MS = 50
const WS_HEARTBEAT_EVERY = 5 // 1 battement sur 5 aussi par le WebSocket (250 ms)
const RTC_OPEN_TIMEOUT_MS = 8000
const MAX_RTC_ATTEMPTS = 3

export function useInputLink(ws: SocketLike) {
  const rtcState = ref<RtcState>('off')
  /** Meilleur RTT de synchronisation récent (ms). */
  const syncRtt = ref<number | null>(null)

  let pc: RTCPeerConnection | null = null
  let dc: RTCDataChannel | null = null
  let pendingCands: RTCIceCandidateInit[] = []
  let remoteSet = false
  let iceServers: IceServerConfig[] | null = null
  let attempts = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let openTimer: ReturnType<typeof setTimeout> | null = null

  let seq = 0
  let bits = 0
  let lastMsg = 'i0'
  let active = false
  let beats = 0

  // synchronisation d'horloge : offset = horloge serveur − horloge locale
  let offset: number | null = null
  const samples: { rtt: number; offset: number }[] = []
  const wall = () => performance.timeOrigin + performance.now()

  function dcSend(m: string): boolean {
    if (dc && dc.readyState === 'open') {
      try {
        dc.send(m)
        return true
      } catch {
        return false
      }
    }
    return false
  }

  /**
   * Nouvelle commande. `eventTs` est `event.timeStamp` (instant du toucher,
   * relatif à `performance.timeOrigin`) : la mesure inclut la file d'événements.
   */
  function sendInput(newBits: number, eventTs: number = performance.now()) {
    bits = newBits
    seq++
    const touch = offset !== null ? (performance.timeOrigin + eventTs + offset).toFixed(1) : '0'
    const m = `i${bits},${seq},${touch}`
    lastMsg = m
    if (dcSend(m)) {
      setTimeout(() => dcSend(m), 6)
      setTimeout(() => dcSend(m), 20)
    }
    ws.send(m)
  }

  /** Renvoie l'état courant comme une nouvelle commande (après une reconnexion). */
  function resend() {
    sendInput(bits)
  }

  function setActive(v: boolean) {
    active = v
  }

  const heartbeat = setInterval(() => {
    if (!active) return
    beats++
    const viaDc = dcSend(lastMsg)
    if (!viaDc || beats % WS_HEARTBEAT_EVERY === 0) ws.send(lastMsg)
  }, HEARTBEAT_MS)

  // ─── Horloge ───────────────────────────────────────────────────────────────

  function syncOnce() {
    const m = `s${wall().toFixed(3)}`
    if (!dcSend(m)) ws.send(m)
  }

  function syncBurst() {
    for (let k = 0; k < 6; k++) setTimeout(syncOnce, k * 120)
  }

  /** Réponse `S<t0>,<heure serveur>` : on garde l'échantillon au plus petit RTT (NTP simplifié). */
  function onSync(data: string) {
    const t1 = wall()
    const [a, b] = data.slice(1).split(',')
    const t0 = Number(a)
    const ts = Number(b)
    if (!t0 || !ts) return
    const rtt = t1 - t0
    if (rtt < 0 || rtt > 5000) return
    samples.push({ rtt, offset: ts - (t0 + t1) / 2 })
    if (samples.length > 12) samples.shift()
    let best = samples[0]!
    for (const s of samples) if (s.rtt < best.rtt) best = s
    offset = best.offset
    syncRtt.value = Math.round(best.rtt * 10) / 10
  }

  const syncTimer = setInterval(syncOnce, 2000)

  // ─── WebRTC ────────────────────────────────────────────────────────────────

  function clearTimers() {
    if (retryTimer) clearTimeout(retryTimer)
    if (openTimer) clearTimeout(openTimer)
    retryTimer = null
    openTimer = null
  }

  function stopRtc() {
    clearTimers()
    const c = pc
    pc = null
    dc?.close()
    dc = null
    c?.close()
    if (rtcState.value !== 'failed') rtcState.value = 'off'
  }

  function fail() {
    stopRtc()
    rtcState.value = 'failed'
    if (iceServers && attempts < MAX_RTC_ATTEMPTS) {
      attempts++
      retryTimer = setTimeout(() => startRtc(iceServers), 1500 * attempts)
    }
  }

  async function startRtc(servers: IceServerConfig[] | null) {
    stopRtc()
    iceServers = servers
    if (!servers || typeof RTCPeerConnection === 'undefined') {
      rtcState.value = 'off'
      return
    }
    rtcState.value = 'connecting'
    const conn = new RTCPeerConnection({ iceServers: servers })
    pc = conn
    remoteSet = false
    pendingCands = []
    const ch = conn.createDataChannel('in', { ordered: false, maxRetransmits: 0 })
    dc = ch
    ch.onopen = () => {
      if (pc !== conn) return
      clearTimers()
      rtcState.value = 'open'
      attempts = 0
      syncBurst()
      dcSend(lastMsg)
    }
    ch.onmessage = ev => {
      const d = String(ev.data)
      if (d.charCodeAt(0) === 80 /* P */) dcSend(`Q${d.slice(1)}`)
      else if (d.charCodeAt(0) === 83 /* S */) onSync(d)
    }
    ch.onclose = () => {
      if (pc === conn) fail()
    }
    conn.onicecandidate = ev => {
      if (ev.candidate?.candidate)
        ws.sendJson({
          t: 'rtc',
          kind: 'cand',
          cand: ev.candidate.candidate,
          mid: ev.candidate.sdpMid ?? '0',
        })
    }
    conn.onconnectionstatechange = () => {
      if (pc === conn && conn.connectionState === 'failed') fail()
    }
    try {
      const offer = await conn.createOffer()
      await conn.setLocalDescription(offer)
      if (pc !== conn) return
      ws.sendJson({ t: 'rtc', kind: 'offer', sdp: conn.localDescription!.sdp })
      openTimer = setTimeout(() => {
        if (pc === conn && rtcState.value !== 'open') fail()
      }, RTC_OPEN_TIMEOUT_MS)
    } catch {
      if (pc === conn) fail()
    }
  }

  async function onSignal(m: { kind: string; sdp?: string; cand?: string; mid?: string }) {
    const conn = pc
    if (!conn) return
    try {
      if (m.kind === 'answer' && m.sdp) {
        await conn.setRemoteDescription({ type: 'answer', sdp: m.sdp })
        remoteSet = true
        for (const c of pendingCands) await conn.addIceCandidate(c).catch(() => {})
        pendingCands = []
      } else if (m.kind === 'cand' && m.cand) {
        const c = { candidate: m.cand, sdpMid: m.mid ?? '0' }
        if (remoteSet) await conn.addIceCandidate(c).catch(() => {})
        else pendingCands.push(c)
      }
    } catch {
      if (pc === conn) fail()
    }
  }

  /** Nouvelle session WebSocket : synchro immédiate, WebRTC relancé. */
  function onJoined(servers: IceServerConfig[] | null) {
    attempts = 0
    syncBurst()
    startRtc(servers)
  }

  function close() {
    clearInterval(heartbeat)
    clearInterval(syncTimer)
    iceServers = null
    stopRtc()
  }

  onBeforeUnmount(close)

  return {
    rtcState,
    syncRtt,
    sendInput,
    resend,
    setActive,
    onSync,
    onSignal,
    onJoined,
    stopRtc,
    close,
  }
}
