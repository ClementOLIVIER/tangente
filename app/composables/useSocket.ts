/**
 * WebSocket vers `/_ws` avec reconnexion automatique (backoff court), réponse
 * immédiate aux pings serveur et détection de connexion muette.
 *
 * Les messages arrivent hors de la réactivité Vue (callback brut) : l'écran hôte
 * en reçoit 120 par seconde.
 */
export type SocketStatus = 'connecting' | 'open' | 'closed'

const BACKOFF_MS = [100, 250, 500, 1000, 2000, 3000]
/** Après l'annonce d'un redémarrage : essais rapprochés (le serveur revient en ~0,2 s). */
const RESTART_RETRY_MS = 120
const RESTART_WINDOW_MS = 30_000
/** Le serveur pingue chaque seconde : 4 s de silence = connexion morte. */
const SILENCE_MS = 4000

export function useSocket(opts: { onOpen: () => void; onMessage: (data: string) => void }) {
  const status = ref<SocketStatus>('connecting')
  const attempts = ref(0)
  let ws: WebSocket | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let watchdog: ReturnType<typeof setInterval> | null = null
  let lastMessageAt = 0
  let stopped = false
  let restartUntil = 0

  const url = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/_ws`

  function connect() {
    if (stopped) return
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
    status.value = 'connecting'
    const sock = new WebSocket(url())
    ws = sock
    sock.onopen = () => {
      if (ws !== sock) return
      attempts.value = 0
      restartUntil = 0
      lastMessageAt = performance.now()
      status.value = 'open'
      opts.onOpen()
    }
    sock.onmessage = ev => {
      if (ws !== sock) return
      lastMessageAt = performance.now()
      const data = ev.data as string
      if (data.charCodeAt(0) === 80 /* P */) {
        sock.send(`Q${data.slice(1)}`)
        return
      }
      opts.onMessage(data)
    }
    sock.onclose = () => {
      if (ws !== sock) return
      ws = null
      status.value = 'closed'
      schedule()
    }
    sock.onerror = () => sock.close()
  }

  function schedule() {
    if (stopped || retryTimer) return
    const delay =
      performance.now() < restartUntil
        ? RESTART_RETRY_MS
        : BACKOFF_MS[Math.min(attempts.value, BACKOFF_MS.length - 1)]!
    attempts.value++
    retryTimer = setTimeout(connect, delay)
  }

  /** Reconnexion immédiate (retour au premier plan, réseau revenu). */
  function reconnectNow() {
    if (stopped) return
    if (ws && ws.readyState <= WebSocket.OPEN) return
    attempts.value = 0
    connect()
  }

  /** Le serveur annonce un redémarrage : reconnexion par essais rapprochés. */
  function expectRestart() {
    restartUntil = performance.now() + RESTART_WINDOW_MS
  }

  function send(data: string): boolean {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(data)
      return true
    }
    return false
  }

  function sendJson(data: object): boolean {
    return send(JSON.stringify(data))
  }

  function close() {
    stopped = true
    if (retryTimer) clearTimeout(retryTimer)
    if (watchdog) clearInterval(watchdog)
    ws?.close()
    ws = null
  }

  const onVisible = () => {
    if (document.visibilityState === 'visible') reconnectNow()
  }

  onMounted(() => {
    connect()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', reconnectNow)
    watchdog = setInterval(() => {
      if (ws && status.value === 'open' && performance.now() - lastMessageAt > SILENCE_MS) {
        // socket « ouverte » mais muette (changement de réseau) : on la recycle
        const dead = ws
        ws = null
        dead.onclose = null
        dead.close()
        status.value = 'closed'
        attempts.value = 0
        connect()
      }
    }, 1000)
  })
  onBeforeUnmount(() => {
    document.removeEventListener('visibilitychange', onVisible)
    window.removeEventListener('online', reconnectNow)
    close()
  })

  return { status, attempts, send, sendJson, reconnectNow, expectRestart, close }
}
