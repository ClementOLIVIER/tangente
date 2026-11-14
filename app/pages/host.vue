<script setup lang="ts">
import { colorHex, MAX_PLAYERS } from '../../shared/constants'
import type { HostAction, RoomState, ServerDiag, ServerMessage } from '../../shared/protocol'
import type { Rules } from '../../shared/rules'
import type { ClientStats } from '~/components/DiagPanel.vue'
import { ArenaRenderer, type LatencySample } from '~/utils/renderer'
import { load, save } from '~/utils/storage'

useHead({ title: 'Tangente — écran' })

interface HostSession {
  code: string
  secret: string
}

let session = load<HostSession>('dk:host')
const room = shallowRef<RoomState | null>(null)
const diag = shallowRef<ServerDiag | null>(null)
const error = ref<string | null>(null)
const showDiag = ref(load<boolean>('dk:diag') ?? false)
const urlChoice = ref<string | null>(load<string>('dk:url'))
const customUrl = ref(load<string>('dk:customUrl') ?? '')
const clock = ref(performance.now())
let phaseDeadline: number | null = null

const viewCanvas = ref<HTMLCanvasElement>()
const lowLatency = ref(false)
let lastRenderAt = 0
const arenaBox = ref<HTMLDivElement>()
let renderer: ArenaRenderer | null = null
/** Le serveur a annoncé un redémarrage : le salon sera restauré à la reconnexion. */
const restarting = ref(false)

const socket = useSocket({
  onOpen: () => socket.sendJson({ t: 'host', code: session?.code, secret: session?.secret }),
  onMessage: onMessage,
})

function onMessage(data: string) {
  const m = JSON.parse(data) as ServerMessage
  switch (m.t) {
    case 'f':
      if (renderer) {
        const now = performance.now()
        renderer.pushFrame(m, now)
        // canvas basse latence : on dessine dès réception, sans attendre l'image suivante
        if (renderer.lowLatency && now - lastRenderAt > 2) {
          renderer.render(now, performance.timeOrigin + performance.now())
          lastRenderAt = now
        }
      }
      break
    case 'room':
      room.value = m
      error.value = null
      phaseDeadline = m.phaseRemainingMs === null ? null : performance.now() + m.phaseRemainingMs
      if (renderer) renderer.showArrows = m.phase === 'countdown'
      if (m.phase === 'lobby') renderer?.clear()
      break
    case 'round':
      renderer?.setRound(m)
      layout()
      break
    case 'hosted':
      session = { code: m.code, secret: m.secret }
      save('dk:host', session)
      restarting.value = false
      break
    case 'restarting':
      restarting.value = true
      socket.expectRestart()
      break
    case 'diag':
      diag.value = m
      break
    case 'error':
      error.value = m.message
      break
  }
}

function act(a: HostAction) {
  socket.sendJson(a)
}
function changeRules(rules: Partial<Rules>) {
  act({ t: 'rules', rules })
}
function newRoom() {
  save('dk:host', null)
  session = null
  renderer?.clear()
  socket.sendJson({ t: 'host', fresh: true })
}

// ─── URL publique / QR ──────────────────────────────────────────────────────

const urlOptions = computed(() => {
  const r = room.value
  if (!r) return []
  const opts: { url: string; label: string }[] = []
  if (r.tunnel.url) opts.push({ url: r.tunnel.url, label: `Internet (${r.tunnel.provider})` })
  for (const u of r.lanUrls) opts.push({ url: u, label: 'Wi-Fi local' })
  opts.push({ url: location.origin, label: 'Ce PC' })
  const custom = customUrl.value.trim().replace(/\/+$/, '')
  if (/^https?:\/\/[\w.-]+(:\d+)?$/.test(custom))
    opts.unshift({ url: custom, label: 'Autre adresse' })
  return opts
})
const baseUrl = computed(() => {
  const opts = urlOptions.value
  return opts.find(o => o.url === urlChoice.value)?.url ?? opts[0]?.url ?? location.origin
})
const joinUrl = computed(() => (room.value ? `${baseUrl.value}/play/${room.value.code}` : ''))
watch(urlChoice, v => save('dk:url', v))
function applyCustomUrl() {
  save('dk:customUrl', customUrl.value.trim())
  urlChoice.value = customUrl.value.trim().replace(/\/+$/, '') || null
}

// ─── Arène ──────────────────────────────────────────────────────────────────

const phase = computed(() => room.value?.phase ?? 'lobby')
const inGame = computed(() => phase.value !== 'lobby')
const remaining = computed(() =>
  phaseDeadline === null ? null : Math.max(0, Math.ceil((phaseDeadline - clock.value) / 1000)),
)
const players = computed(() => room.value?.players ?? [])
const readyCount = computed(
  () => players.value.filter(p => p.bot || (p.ready && p.connected)).length,
)
const roundWinnerNames = computed(() =>
  (room.value?.roundWinners ?? []).map(id => players.value.find(p => p.id === id)).filter(Boolean),
)
const winnerPlayers = computed(() =>
  (room.value?.winners ?? []).map(id => players.value.find(p => p.id === id)).filter(Boolean),
)
const ranking = computed(() =>
  players.value.filter(p => p.inGame).sort((a, b) => b.score - a.score),
)

function layout() {
  const box = arenaBox.value
  if (!box || !renderer) return
  const { width, height } = box.getBoundingClientRect()
  const aspect = renderer.aspect
  let w = width
  let h = width / aspect
  if (h > height) {
    h = height
    w = height * aspect
  }
  renderer.resize(Math.floor(w), Math.floor(h), window.devicePixelRatio || 1)
}

// statistiques client (FPS, trames/s, latences)
const stats = shallowRef<ClientStats>({
  fps: 0,
  frameP95: 0,
  framesPerSec: 0,
  latencyByIdx: new Map(),
  touchByIdx: new Map(),
  lowLatency: false,
  latencyAll: null,
  wsStatus: 'connecting',
})
const frameTimes: number[] = []
let lastFrame = 0
let lastStatsAt = 0
let lastFramesReceived = 0

function pct(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!
}

function computeStats(now: number) {
  if (!renderer) return
  const ft = frameTimes.slice().sort((a, b) => a - b)
  const avg = ft.reduce((s, v) => s + v, 0) / Math.max(1, ft.length)
  const summarize = (values: number[]) => {
    const arr = values.slice().sort((a, b) => a - b)
    return arr.length ? { p50: pct(arr, 0.5), p95: pct(arr, 0.95), n: arr.length } : null
  }
  const byIdx = new Map<number, LatencySample[]>()
  for (const s of renderer.latency) {
    let a = byIdx.get(s.idx)
    if (!a) byIdx.set(s.idx, (a = []))
    a.push(s)
  }
  const latencyByIdx = new Map<number, { p50: number; p95: number; n: number }>()
  const touchByIdx = new Map<number, { p50: number; p95: number; n: number }>()
  for (const [idx, arr] of byIdx) {
    const l = summarize(arr.map(x => x.ms))
    if (l) latencyByIdx.set(idx, l)
    const t = summarize(arr.filter(x => x.touchMs !== null).map(x => x.touchMs!))
    if (t) touchByIdx.set(idx, t)
  }
  const all = renderer.latency.map(s => s.ms).sort((a, b) => a - b)
  stats.value = {
    fps: avg ? 1000 / avg : 0,
    frameP95: ft.length ? pct(ft, 0.95) : 0,
    framesPerSec: Math.round(
      ((renderer.framesReceived - lastFramesReceived) * 1000) / (now - lastStatsAt),
    ),
    latencyByIdx,
    touchByIdx,
    lowLatency: renderer.lowLatency,
    latencyAll: all.length ? { p50: pct(all, 0.5), p95: pct(all, 0.95), n: all.length } : null,
    wsStatus: socket.status.value,
  }
  lastFramesReceived = renderer.framesReceived
  lastStatsAt = now
}

let raf = 0
function loop(now: number) {
  raf = requestAnimationFrame(loop)
  if (lastFrame) {
    frameTimes.push(now - lastFrame)
    if (frameTimes.length > 240) frameTimes.shift()
  }
  lastFrame = now
  renderer?.render(now, performance.timeOrigin + performance.now())
  lastRenderAt = now
  if (now - lastStatsAt > 1000) computeStats(now)
  // horloge réactive basse fréquence pour les comptes à rebours
  if (now - clock.value > 100) clock.value = now
}

let ro: ResizeObserver | null = null
onMounted(() => {
  // canvas absent = le gabarit a échoué : on laisse la barrière d'erreur l'afficher
  if (viewCanvas.value) {
    renderer = new ArenaRenderer(viewCanvas.value)
    lowLatency.value = renderer.lowLatency
  }
  ro = new ResizeObserver(layout)
  if (arenaBox.value) ro.observe(arenaBox.value)
  layout()
  raf = requestAnimationFrame(loop)
  window.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  ro?.disconnect()
  window.removeEventListener('keydown', onKey)
})
watch(inGame, () => nextTick(layout))

// ─── Raccourcis clavier ─────────────────────────────────────────────────────

function primaryAction() {
  switch (phase.value) {
    case 'lobby':
    case 'gameOver':
      act({ t: 'start' })
      break
    case 'countdown':
    case 'playing':
      act({ t: 'pause' })
      break
    case 'paused':
      act({ t: 'resume' })
      break
    case 'roundEnd':
      act({ t: 'next' })
      break
  }
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen()
  else document.documentElement.requestFullscreen?.().catch(() => {})
}

function onKey(e: KeyboardEvent) {
  if (e.target instanceof Element && e.target.closest('input, select, textarea')) return
  if (e.code === 'Space' || e.code === 'Enter') {
    e.preventDefault()
    primaryAction()
  } else if (e.key === 'd' || e.key === 'D') {
    showDiag.value = !showDiag.value
    save('dk:diag', showDiag.value)
  } else if (e.key === 'f' || e.key === 'F') toggleFullscreen()
  else if (e.key === 'p' || e.key === 'P') {
    if (phase.value === 'paused') act({ t: 'resume' })
    else act({ t: 'pause' })
  }
}

const PHASE_LABEL: Record<string, string> = {
  lobby: 'Salon',
  countdown: 'Préparez-vous',
  playing: 'En jeu',
  paused: 'Pause',
  roundEnd: 'Fin de manche',
  gameOver: 'Fin de partie',
}
</script>

<template>
  <div class="flex h-full w-full overflow-hidden bg-black select-none">
    <!-- ─── Arène (toujours montée : le canvas garde ses traces) ─── -->
    <div v-show="inGame" class="relative flex min-w-0 flex-1 items-center justify-center p-[1.2vh]">
      <div ref="arenaBox" class="relative flex h-full w-full items-center justify-center">
        <div class="relative outline outline-1 outline-[#3a3a40]">
          <canvas ref="viewCanvas" class="block"></canvas>

          <!-- surcouches -->
          <div
            v-if="phase === 'countdown' && remaining !== null"
            class="pointer-events-none absolute inset-0 flex items-center justify-center"
          >
            <span class="text-[18vh] font-black text-white/85 tabular-nums drop-shadow-lg">
              {{ remaining || '' }}
            </span>
          </div>
          <div
            v-if="phase === 'paused'"
            class="absolute inset-0 flex flex-col items-center justify-center bg-black/55"
          >
            <div class="text-[8vh] font-black tracking-wide">PAUSE</div>
            <div class="mt-2 text-white/70">Espace ou P pour reprendre</div>
          </div>
          <div
            v-if="phase === 'roundEnd'"
            class="absolute inset-0 flex items-center justify-center bg-black/45"
          >
            <div
              class="min-w-[28rem] rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)]/95 p-8"
            >
              <div class="text-sm font-bold tracking-widest text-[var(--color-muted)] uppercase">
                Manche {{ room?.round }}
              </div>
              <div class="mt-1 text-4xl font-black">
                <template v-if="roundWinnerNames.length === 1">
                  <span :style="{ color: colorHex(roundWinnerNames[0]!.color) }">
                    {{ roundWinnerNames[0]!.name }}
                  </span>
                  survit !
                </template>
                <template v-else>Égalité : personne ne survit</template>
              </div>
              <ol class="mt-5 flex flex-col gap-1.5">
                <li v-for="p in ranking" :key="p.id" class="flex justify-between gap-6 text-xl">
                  <span :style="{ color: colorHex(p.color) }">{{ p.name }}</span>
                  <span class="tabular-nums">
                    <span v-if="p.roundPoints" class="mr-3 text-white/55">
                      +{{ p.roundPoints }}
                    </span>
                    <b>{{ p.score }}</b>
                  </span>
                </li>
              </ol>
              <div class="mt-6 flex items-center justify-between gap-4">
                <span class="text-sm text-[var(--color-muted)]">
                  {{
                    remaining !== null
                      ? `Manche suivante dans ${remaining} s`
                      : 'Espace : manche suivante'
                  }}
                </span>
                <button class="btn btn-primary" @click="act({ t: 'next' })">Manche suivante</button>
              </div>
            </div>
          </div>
          <div
            v-if="phase === 'gameOver'"
            class="absolute inset-0 flex items-center justify-center bg-black/60"
          >
            <div
              class="min-w-[30rem] rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)]/95 p-8 text-center"
            >
              <div class="text-sm font-bold tracking-widest text-[var(--color-muted)] uppercase">
                Fin de partie
              </div>
              <div class="mt-2 text-5xl font-black">
                <template v-for="(w, i) in winnerPlayers" :key="w!.id">
                  <span v-if="i" class="text-white/50">&</span>
                  <span :style="{ color: colorHex(w!.color) }">{{ w!.name }}</span>
                </template>
              </div>
              <div class="mt-1 text-xl text-white/70">
                {{ winnerPlayers.length > 1 ? 'gagnent' : 'gagne' }} la partie
              </div>
              <ol class="mx-auto mt-6 flex max-w-sm flex-col gap-1 text-left">
                <li v-for="(p, i) in ranking" :key="p.id" class="flex justify-between text-lg">
                  <span>
                    <span class="mr-2 text-white/40">{{ i + 1 }}.</span>
                    <span :style="{ color: colorHex(p.color) }">{{ p.name }}</span>
                  </span>
                  <b class="tabular-nums">{{ p.score }}</b>
                </li>
              </ol>
              <div class="mt-7 flex justify-center gap-3">
                <button class="btn btn-primary" @click="act({ t: 'start' })">Rejouer</button>
                <button class="btn btn-ghost" @click="act({ t: 'newGame' })">
                  Retour au salon
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
      <!-- `room` est nul jusqu'à la réponse du serveur : le panneau (préférence mémorisée) attend -->
      <div v-if="showDiag && room" class="absolute top-4 left-4 w-[34rem] max-w-[60vw]">
        <SafePanel name="diagnostic">
          <DiagPanel :diag="diag" :stats="stats" :players="players" :tunnel="room.tunnel" />
        </SafePanel>
      </div>
    </div>

    <!-- ─── Barre latérale de jeu ─── -->
    <aside
      v-if="inGame && room"
      class="flex w-[clamp(240px,21vw,420px)] shrink-0 flex-col border-l border-[var(--color-line)] bg-[var(--color-panel)] px-[1.4vw] py-[2.5vh]"
    >
      <div class="mb-4 flex items-baseline justify-between text-[var(--color-muted)]">
        <span class="text-sm font-bold tracking-widest uppercase">Manche {{ room.round }}</span>
        <span class="text-sm">
          {{
            room.rules.endCondition === 'score'
              ? `objectif ${room.target}`
              : `sur ${room.rules.rounds}`
          }}
        </span>
      </div>
      <SafePanel name="classement">
        <ScoreBoard
          :players="players"
          :target="
            room.rules.endCondition === 'score'
              ? room.target
              : Math.max(1, ...players.map(p => p.score))
          "
          :phase="phase"
          :compact="players.length > 8"
        />
      </SafePanel>
      <div class="mt-auto flex flex-col gap-3 pt-4">
        <div class="flex items-center gap-3">
          <div class="w-[clamp(72px,6vw,120px)] shrink-0"><QrCode :value="joinUrl" /></div>
          <div class="min-w-0 text-xs text-[var(--color-muted)]">
            Rejoindre : code
            <b class="text-base tracking-widest text-white">{{ room.code }}</b>
            <div class="mt-0.5">les nouveaux joueurs entrent à la manche suivante</div>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-2 text-sm">
          <button v-if="phase === 'paused'" class="btn btn-primary" @click="act({ t: 'resume' })">
            Reprendre
          </button>
          <button
            v-else
            class="btn btn-ghost"
            :disabled="phase !== 'playing' && phase !== 'countdown'"
            @click="act({ t: 'pause' })"
          >
            Pause
          </button>
          <button
            class="btn btn-ghost"
            :disabled="phase === 'gameOver'"
            @click="act({ t: 'restartRound' })"
          >
            Rejouer la manche
          </button>
          <button
            class="btn btn-ghost"
            :disabled="phase === 'gameOver'"
            @click="act({ t: 'endGame' })"
          >
            Terminer
          </button>
          <button class="btn btn-ghost" @click="act({ t: 'newGame' })">Salon</button>
        </div>
        <div class="flex justify-between text-[11px] text-[var(--color-muted)]">
          <span>Espace · P pause · F plein écran · D diag</span>
          <span :class="socket.status.value === 'open' ? '' : 'text-red-400'">
            {{ socket.status.value === 'open' ? '●' : 'connexion…' }}
          </span>
        </div>
      </div>
    </aside>

    <!-- ─── Salon ─── -->
    <div v-if="!inGame" class="flex min-h-0 w-full flex-1 overflow-auto">
      <div v-if="!room" class="m-auto max-w-lg p-8 text-center">
        <div class="text-3xl font-black">Tangente</div>
        <p v-if="error" class="mt-4 text-red-400">{{ error }}</p>
        <p v-else class="mt-4 text-[var(--color-muted)]">
          {{
            socket.status.value === 'open' ? 'Ouverture du salon…' : 'Connexion au serveur de jeu…'
          }}
        </p>
      </div>
      <div
        v-else
        class="mx-auto grid w-full max-w-[1800px] grid-cols-1 gap-8 p-[3vh] lg:grid-cols-[minmax(280px,1fr)_minmax(320px,1.2fr)_minmax(320px,1fr)]"
      >
        <!-- rejoindre -->
        <section class="flex flex-col gap-4">
          <div>
            <h1 class="text-[clamp(2rem,3.4vw,3.6rem)] leading-none font-black">
              <span class="text-[var(--color-accent)]">Tangente</span>
            </h1>
            <p class="mt-2 text-[var(--color-muted)]">Scannez pour jouer avec votre téléphone.</p>
          </div>
          <div class="w-full max-w-[min(26rem,38vh)]"><QrCode :value="joinUrl" /></div>
          <div>
            <div class="text-sm text-[var(--color-muted)]">Code du salon</div>
            <div class="text-5xl font-black tracking-[0.3em]">{{ room.code }}</div>
            <div class="mt-2 font-mono text-sm break-all text-white/80">{{ joinUrl }}</div>
          </div>
          <div class="flex flex-col gap-1 text-sm">
            <label class="text-[var(--color-muted)]">Adresse du QR code</label>
            <select
              class="field"
              :value="baseUrl"
              @change="urlChoice = ($event.target as HTMLSelectElement).value"
            >
              <option v-for="o in urlOptions" :key="o.url" :value="o.url">
                {{ o.label }} — {{ o.url }}
              </option>
            </select>
            <input
              v-model="customUrl"
              class="field text-xs"
              placeholder="Autre adresse (tunnel lancé à la main) : https://…"
              @change="applyCustomUrl"
            />
            <span class="text-xs text-[var(--color-muted)]">
              Tunnel {{ room.tunnel.provider }} :
              <b :class="room.tunnel.status === 'up' ? 'text-green-400' : 'text-amber-400'">
                {{ room.tunnel.status }}
              </b>
              <template v-if="room.tunnel.status !== 'up'">
                — Wi-Fi local ou « pnpm soiree » pour Internet
              </template>
              <span v-if="room.tunnel.error" class="text-red-400">({{ room.tunnel.error }})</span>
            </span>
          </div>
        </section>

        <!-- joueurs -->
        <section class="flex min-h-0 flex-col gap-3">
          <div class="flex items-baseline justify-between">
            <h2 class="text-2xl font-black">Joueurs {{ players.length }}/{{ MAX_PLAYERS }}</h2>
            <span class="text-sm text-[var(--color-muted)]">
              {{ readyCount }} prêt{{ readyCount > 1 ? 's' : '' }}
            </span>
          </div>
          <ul class="flex flex-col gap-2">
            <li
              v-for="p in players"
              :key="p.id"
              class="flex items-center gap-3 rounded-xl bg-[var(--color-panel)] px-4 py-3"
              :class="{ 'opacity-50': !p.connected }"
            >
              <span
                class="size-5 shrink-0 rounded-full"
                :style="{ background: colorHex(p.color) }"
              ></span>
              <span
                class="min-w-0 flex-1 truncate text-xl font-bold"
                :style="{ color: colorHex(p.color) }"
              >
                {{ p.name }}
              </span>
              <span v-if="p.bot" class="rounded bg-white/10 px-2 py-0.5 text-xs">bot</span>
              <span v-else-if="!p.connected" class="text-xs text-red-400">hors ligne</span>
              <span
                v-else
                class="rounded px-2 py-0.5 text-xs font-bold"
                :class="p.ready ? 'bg-green-600 text-black' : 'bg-white/10 text-white/60'"
              >
                {{ p.ready ? 'PRÊT' : 'pas prêt' }}
              </span>
              <button
                class="text-white/30 hover:text-red-400"
                :title="`Exclure ${p.name}`"
                @click="act({ t: 'kick', id: p.id })"
              >
                ✕
              </button>
            </li>
            <li
              v-if="!players.length"
              class="rounded-xl border border-dashed border-[var(--color-line)] p-6 text-center text-[var(--color-muted)]"
            >
              En attente des joueurs…
            </li>
          </ul>
          <div class="flex gap-2 text-sm">
            <button
              class="btn btn-ghost"
              :disabled="players.length >= MAX_PLAYERS"
              @click="act({ t: 'addBot' })"
            >
              + bot
            </button>
            <button
              class="btn btn-ghost"
              :disabled="!players.some(p => p.bot)"
              @click="act({ t: 'removeBot' })"
            >
              − bot
            </button>
          </div>
          <div class="mt-auto flex flex-col gap-2 pt-4">
            <button
              class="btn btn-primary py-4 text-2xl"
              :disabled="readyCount < 1"
              @click="act({ t: 'start' })"
            >
              Lancer la partie
            </button>
            <p class="text-center text-xs text-[var(--color-muted)]">
              Seuls les joueurs prêts participent · Espace pour lancer
              <template v-if="readyCount === 1">· seul en piste : mode entraînement</template>
            </p>
          </div>
        </section>

        <!-- règles -->
        <section class="rounded-2xl bg-[var(--color-panel)] p-5">
          <div class="mb-4 flex items-center justify-between">
            <h2 class="text-2xl font-black">Règles</h2>
            <span class="flex gap-3 text-xs">
              <button
                class="text-[var(--color-muted)] hover:text-white"
                @click="showDiag = !showDiag"
              >
                diag
              </button>
              <button class="text-[var(--color-muted)] hover:text-white" @click="newRoom">
                nouveau salon
              </button>
            </span>
          </div>
          <SafePanel name="règles">
            <RulesPanel :rules="room.rules" :target="room.target" @change="changeRules" />
          </SafePanel>
          <div v-if="showDiag" class="mt-5">
            <SafePanel name="diagnostic">
              <DiagPanel :diag="diag" :stats="stats" :players="players" :tunnel="room.tunnel" />
            </SafePanel>
          </div>
        </section>
      </div>
    </div>

    <div
      v-if="room && socket.status.value !== 'open'"
      class="fixed inset-x-0 top-0 z-50 py-1 text-center text-sm font-bold"
      :class="restarting ? 'bg-sky-700' : 'bg-red-700'"
    >
      {{
        restarting
          ? 'Mise à jour du serveur — le salon et les scores reprennent dans un instant…'
          : 'Connexion au serveur perdue — reconnexion…'
      }}
    </div>
    <span class="sr-only">{{ PHASE_LABEL[phase] }}</span>
  </div>
</template>
