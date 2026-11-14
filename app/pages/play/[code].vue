<script setup lang="ts">
import { colorHex, INPUT, NAME_MAX, PALETTE } from '../../../shared/constants'
import type { MeState, ServerMessage } from '../../../shared/protocol'
import { BONUS_DEFS } from '../../../shared/rules'
import { load, save } from '~/utils/storage'

/**
 * Manette téléphone. Chemin critique : `pointerdown` → `ws.send('i<bits>')`
 * synchrone dans le gestionnaire, sans passer par la réactivité Vue.
 */

useHead({ title: 'Tangente — manette' })

const route = useRoute()
const code = String(route.params.code ?? '').toUpperCase()
const tokenKey = `dk:player:${code}`

interface Profile {
  name: string
  color: string
}

const profile = reactive<Profile>(load<Profile>('dk:profile') ?? { name: '', color: '' })
let token = load<string>(tokenKey)
type View = 'form' | 'connecting' | 'joined' | 'notfound' | 'kicked' | 'replaced'
const view = ref<View>(token ? 'connecting' : 'form')
const formError = ref<string | null>(null)
const takenBeforeJoin = ref<string[]>([])
const me = shallowRef<MeState | null>(null)
let pendingJoin = false
const haptics = ref(load<boolean>('dk:haptics') ?? true)
/** Le serveur a annoncé un redémarrage : reconnexion automatique, même joueur. */
const restarting = ref(false)
/** Salon pas (encore) recréé par l'écran après un redémarrage : on patiente. */
const waitingHost = ref(false)
let missingRetries = 0
const MAX_MISSING_RETRIES = 30

const socket = useSocket({ onOpen, onMessage })
const link = useInputLink(socket)

function onOpen() {
  if (token) socket.sendJson({ t: 'join', code, token })
  else if (pendingJoin)
    socket.sendJson({ t: 'join', code, name: profile.name, color: profile.color })
}

function onMessage(data: string) {
  // réponse de synchronisation d'horloge (texte brut)
  if (data.charCodeAt(0) === 83 /* S */) {
    link.onSync(data)
    return
  }
  const m = JSON.parse(data) as ServerMessage
  switch (m.t) {
    case 'joined':
      token = m.token
      save(tokenKey, token)
      pendingJoin = false
      view.value = 'joined'
      restarting.value = false
      waitingHost.value = false
      missingRetries = 0
      link.onJoined(m.iceServers)
      // l'état des touches est renvoyé : un doigt resté posé pendant la coupure compte
      sentBits = -1
      pushInput()
      keepAwake()
      break
    case 'rtc':
      link.onSignal(m)
      break
    case 'me': {
      const prev = me.value
      me.value = m
      if (prev && prev.alive && !m.alive && m.phase === 'playing') buzz([120, 60, 120])
      break
    }
    case 'error':
      if (m.code === 'BAD_TOKEN') {
        token = null
        save(tokenKey, null)
        // serveur redémarré sans sauvegarde : même salon, joueur inconnu → on rejoint
        // aussitôt avec le pseudo et la couleur mémorisés, sans repasser par le formulaire
        if (profile.name.trim()) {
          pendingJoin = true
          socket.sendJson({ t: 'join', code, name: profile.name.trim(), color: profile.color })
        } else view.value = 'form'
      } else if (m.code === 'ROOM_NOT_FOUND') {
        // reconnexion après un redémarrage : l'écran n'a peut-être pas encore recréé
        // le salon (il le reprend sous le même code) — on réessaie chaque seconde
        if (token && missingRetries < MAX_MISSING_RETRIES) {
          missingRetries++
          waitingHost.value = true
          view.value = 'connecting'
          setTimeout(() => {
            if (socket.status.value === 'open' && token) onOpen()
          }, 1000)
        } else {
          token = null
          save(tokenKey, null)
          waitingHost.value = false
          view.value = 'notfound'
        }
      } else {
        formError.value = m.message
        view.value = 'form'
        pendingJoin = false
      }
      break
    case 'kicked':
      token = null
      save(tokenKey, null)
      view.value = 'kicked'
      socket.close()
      break
    case 'replaced':
      view.value = 'replaced'
      socket.close()
      break
    case 'restarting':
      restarting.value = true
      socket.expectRestart()
      break
  }
}

onMounted(async () => {
  if (view.value !== 'form') return
  try {
    const info = await $fetch<{ exists: boolean; taken: string[]; full: boolean }>(
      `/api/rooms/${code}`,
    )
    if (!info.exists) view.value = 'notfound'
    else {
      takenBeforeJoin.value = info.taken
      if (info.full) formError.value = 'Salon complet (12 joueurs)'
      if (!profile.color || info.taken.includes(profile.color))
        profile.color = PALETTE.find(c => !info.taken.includes(c.id))?.id ?? ''
    }
  } catch {
    // serveur injoignable : le formulaire reste utilisable, la socket réessaiera
  }
})

function submitJoin() {
  const name = profile.name.trim()
  if (!name) {
    formError.value = 'Choisissez un pseudo'
    return
  }
  formError.value = null
  save('dk:profile', { name, color: profile.color })
  pendingJoin = true
  view.value = 'connecting'
  socket.sendJson({ t: 'join', code, name, color: profile.color })
}

// ─── Profil après connexion ─────────────────────────────────────────────────

const editing = ref(false)
const taken = computed(() => (me.value ? me.value.takenColors : takenBeforeJoin.value))
function setReady(ready: boolean) {
  socket.sendJson({ t: 'ready', ready })
  buzz(15)
}
function pickColor(id: string) {
  profile.color = id
  if (view.value === 'joined') {
    socket.sendJson({ t: 'profile', color: id })
    save('dk:profile', { name: profile.name, color: id })
  }
}
function saveName() {
  const name = profile.name.trim()
  if (name) {
    socket.sendJson({ t: 'profile', name })
    save('dk:profile', { name, color: profile.color })
  }
  editing.value = false
}
function leave() {
  socket.sendJson({ t: 'leave' })
  token = null
  save(tokenKey, null)
  me.value = null
  view.value = 'form'
}

// ─── Commandes tactiles ─────────────────────────────────────────────────────

const pointers = new Map<number, number>()
let sentBits = -1
const pressed = ref(0)
const pad = ref<HTMLElement>()

function zoneAt(clientX: number): number {
  const w = pad.value?.clientWidth || window.innerWidth
  return clientX < w / 2 ? INPUT.LEFT : INPUT.RIGHT
}

/** `eventTs` : instant du toucher (`event.timeStamp`), pour mesurer l'aller depuis le doigt. */
function pushInput(eventTs?: number) {
  let bits = 0
  for (const z of pointers.values()) bits |= z
  if (bits !== sentBits) {
    link.sendInput(bits, eventTs)
    sentBits = bits
  }
  pressed.value = bits
}

function onDown(e: PointerEvent) {
  e.preventDefault()
  const zone = zoneAt(e.clientX)
  const before = pointers.size
  pointers.set(e.pointerId, zone)
  pushInput(e.timeStamp)
  try {
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  } catch {
    // pointeur déjà relâché
  }
  if (pointers.size > before) buzz(8)
}
function onMove(e: PointerEvent) {
  const z = pointers.get(e.pointerId)
  if (z === undefined) return
  const zone = zoneAt(e.clientX)
  if (zone !== z) {
    pointers.set(e.pointerId, zone)
    pushInput(e.timeStamp)
  }
}
function onUp(e: PointerEvent) {
  if (pointers.delete(e.pointerId)) pushInput(e.timeStamp)
}
/** Filet de sécurité : plus aucun doigt à l'écran = plus aucune commande. */
function onTouchEnd(e: TouchEvent) {
  if (e.touches.length === 0 && pointers.size) {
    pointers.clear()
    pushInput()
  }
}
function releaseAll() {
  pointers.clear()
  pushInput()
}

function buzz(pattern: number | number[]) {
  if (haptics.value && 'vibrate' in navigator) navigator.vibrate(pattern)
}
watch(haptics, v => save('dk:haptics', v))

// écran allumé pendant la partie
let wakeLock: { release: () => Promise<void> } | null = null
async function keepAwake() {
  try {
    const nav = navigator as Navigator & {
      wakeLock?: { request: (t: 'screen') => Promise<typeof wakeLock> }
    }
    if (document.visibilityState === 'visible' && nav.wakeLock)
      wakeLock = await nav.wakeLock.request('screen')
  } catch {
    // refusé (économie d'énergie) : sans conséquence
  }
}
function onVisibility() {
  if (document.visibilityState === 'hidden') releaseAll()
  else if (view.value === 'joined') keepAwake()
}

onMounted(() => {
  window.addEventListener('blur', releaseAll)
  window.addEventListener('pagehide', releaseAll)
  document.addEventListener('visibilitychange', onVisibility)
})
onBeforeUnmount(() => {
  window.removeEventListener('blur', releaseAll)
  window.removeEventListener('pagehide', releaseAll)
  document.removeEventListener('visibilitychange', onVisibility)
  wakeLock?.release().catch(() => {})
})

// ─── Affichage ──────────────────────────────────────────────────────────────

const color = computed(() => colorHex(me.value?.color ?? profile.color))
const showPad = computed(() => {
  const m = me.value
  return !!m && m.inRound && ['countdown', 'playing', 'paused', 'roundEnd'].includes(m.phase)
})
// battement des commandes (radio éveillée) seulement pendant une manche
watch(showPad, v => link.setActive(v), { immediate: true })
const clock = ref(performance.now())
let deadline: number | null = null
watch(me, m => {
  deadline = m?.phaseRemainingMs != null ? performance.now() + m.phaseRemainingMs : null
})
const remaining = computed(() =>
  deadline === null ? null : Math.max(0, Math.ceil((deadline - clock.value) / 1000)),
)
let clockTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => (clockTimer = setInterval(() => (clock.value = performance.now()), 200)))
onBeforeUnmount(() => clockTimer && clearInterval(clockTimer))

function reload() {
  window.location.reload()
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen()
  else document.documentElement.requestFullscreen?.().catch(() => {})
}

const PATH_LABEL: Record<string, string> = {
  lan: 'Wi-Fi direct',
  direct: 'direct',
  relay: 'relais',
  ws: 'tunnel',
}
/** Chemin des commandes et aller seul (toucher → serveur), sinon RTT. */
const statusText = computed(() => {
  if (socket.status.value !== 'open') return 'reconnexion…'
  const m = me.value
  const path = m?.path ? PATH_LABEL[m.path] : ''
  if (m?.uplinkMs != null) return `${path} · ↑ ${Math.round(m.uplinkMs)} ms`
  return m?.rtt != null ? `${path} · ${Math.round(m.rtt)} ms` : path || 'connecté'
})
</script>

<template>
  <div
    class="no-gesture flex h-dvh w-full flex-col overflow-hidden bg-black text-white"
    @contextmenu.prevent
  >
    <!-- ─── Formulaire ─── -->
    <div
      v-if="view === 'form'"
      class="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 overflow-auto p-6"
      style="touch-action: pan-y"
    >
      <div>
        <div class="text-sm text-[var(--color-muted)]">Salon {{ code }}</div>
        <h1 class="text-4xl font-black">
          <span class="text-[var(--color-accent)]">Tangente</span>
        </h1>
      </div>
      <form class="flex flex-col gap-5" @submit.prevent="submitJoin">
        <label class="flex flex-col gap-2">
          <span class="font-bold">Pseudo</span>
          <input
            v-model="profile.name"
            :maxlength="NAME_MAX"
            autocomplete="nickname"
            enterkeyhint="go"
            class="field py-3 text-2xl"
            placeholder="Votre pseudo"
            style="user-select: text; -webkit-user-select: text"
          />
        </label>
        <div class="flex flex-col gap-2">
          <span class="font-bold">Couleur</span>
          <div class="grid grid-cols-6 gap-3">
            <button
              v-for="c in PALETTE"
              :key="c.id"
              type="button"
              class="aspect-square rounded-full border-4 transition-transform disabled:opacity-15"
              :class="profile.color === c.id ? 'scale-110 border-white' : 'border-transparent'"
              :style="{ background: c.hex }"
              :disabled="taken.includes(c.id)"
              :aria-label="c.name"
              @click="pickColor(c.id)"
            ></button>
          </div>
        </div>
        <p v-if="formError" class="text-red-400">{{ formError }}</p>
        <button class="btn btn-primary py-4 text-2xl" :style="{ background: color }">
          Rejoindre
        </button>
      </form>
    </div>

    <!-- ─── États d'erreur ─── -->
    <div
      v-else-if="view === 'notfound'"
      class="m-auto flex max-w-sm flex-col gap-4 p-6 text-center"
    >
      <div class="text-2xl font-black">Salon {{ code }} introuvable</div>
      <p class="text-[var(--color-muted)]">
        Le salon a peut-être été recréé : scannez à nouveau le QR code affiché sur l’écran.
      </p>
      <NuxtLink to="/" class="btn btn-ghost">Saisir un autre code</NuxtLink>
    </div>
    <div v-else-if="view === 'kicked'" class="m-auto max-w-sm p-6 text-center">
      <div class="text-2xl font-black">Vous avez été retiré du salon</div>
      <button class="btn btn-ghost mt-4" @click="view = 'form'">Rejoindre à nouveau</button>
    </div>
    <div v-else-if="view === 'replaced'" class="m-auto max-w-sm p-6 text-center">
      <div class="text-2xl font-black">Manette ouverte ailleurs</div>
      <p class="mt-2 text-[var(--color-muted)]">
        Votre joueur est contrôlé depuis un autre onglet ou appareil.
      </p>
      <button class="btn btn-ghost mt-4" @click="reload">Reprendre ici</button>
    </div>
    <div
      v-else-if="view === 'connecting' || !me"
      class="m-auto p-6 text-center text-[var(--color-muted)]"
    >
      <template v-if="waitingHost">
        <div class="text-xl font-bold text-white">En attente de l’écran…</div>
        <p class="mt-2">
          Le serveur a redémarré : le salon {{ code }} revient dès que l’écran se reconnecte.
        </p>
      </template>
      <template v-else>Connexion au salon {{ code }}…</template>
    </div>

    <!-- ─── Connecté ─── -->
    <template v-else>
      <header
        class="flex shrink-0 items-center gap-3 px-4 pt-[max(env(safe-area-inset-top),0.5rem)] pb-2"
      >
        <span class="size-4 rounded-full" :style="{ background: color }"></span>
        <span class="min-w-0 flex-1 truncate text-lg font-black" :style="{ color }">
          {{ me.name }}
        </span>
        <span v-if="me.inGame" class="text-lg font-black tabular-nums">
          {{ me.score }}
          <span class="text-sm font-normal text-white/50">
            pts · {{ me.rank }}/{{ me.playerCount }}
          </span>
        </span>
        <span
          class="text-xs"
          :class="socket.status.value === 'open' ? 'text-white/50' : 'text-red-400'"
        >
          {{ statusText }}
        </span>
      </header>

      <!-- manette -->
      <div
        v-if="showPad"
        ref="pad"
        class="relative flex flex-1"
        @pointerdown="onDown"
        @pointermove="onMove"
        @pointerup="onUp"
        @pointercancel="onUp"
        @lostpointercapture="onUp"
        @touchend="onTouchEnd"
        @touchcancel="onTouchEnd"
      >
        <div
          v-for="z in [INPUT.LEFT, INPUT.RIGHT]"
          :key="z"
          class="m-1.5 flex flex-1 items-center justify-center rounded-3xl border-2 text-[22vmin] font-black transition-[background-color] duration-75"
          :style="{
            borderColor: color,
            backgroundColor: pressed & z ? color : `${color}22`,
            color: pressed & z ? '#000' : color,
          }"
        >
          {{ z === INPUT.LEFT ? '◀' : '▶' }}
        </div>

        <!-- informations superposées, sans capter le toucher -->
        <div
          class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-center"
        >
          <div
            v-if="me.effects.includes('invert')"
            class="rounded-xl bg-pink-600 px-4 py-2 text-2xl font-black"
          >
            ⇄ COMMANDES INVERSÉES
          </div>
          <div
            v-if="me.phase === 'countdown' && remaining"
            class="text-[30vmin] leading-none font-black text-white/90"
          >
            {{ remaining }}
          </div>
          <div
            v-if="me.phase === 'paused'"
            class="rounded-xl bg-black/70 px-5 py-3 text-3xl font-black"
          >
            PAUSE
          </div>
          <div
            v-if="!me.alive && (me.phase === 'playing' || me.phase === 'roundEnd')"
            class="rounded-xl bg-black/75 px-5 py-3"
          >
            <div class="text-3xl font-black">Éliminé</div>
            <div class="text-white/70">+{{ me.roundPoints }} cette manche</div>
          </div>
          <div v-if="me.phase === 'roundEnd' && me.alive" class="rounded-xl bg-black/75 px-5 py-3">
            <div class="text-3xl font-black" :style="{ color }">Dernier survivant !</div>
            <div class="text-white/70">+{{ me.roundPoints }} cette manche</div>
          </div>
          <div
            v-if="me.mode === 'party' && (me.effects.length || me.shield)"
            class="flex flex-wrap justify-center gap-1.5"
          >
            <span v-if="me.shield" class="rounded bg-green-700 px-2 py-0.5 text-sm font-bold">
              Bouclier ×{{ me.shield }}
            </span>
            <span
              v-for="e in me.effects.filter(e => e !== 'invert')"
              :key="e"
              class="rounded px-2 py-0.5 text-sm font-bold"
              :class="BONUS_DEFS[e].tone === 'bad' ? 'bg-red-700' : 'bg-green-700'"
            >
              {{ BONUS_DEFS[e].label }}
            </span>
          </div>
        </div>
      </div>

      <!-- salon / spectateur / fin de partie -->
      <div
        v-else
        class="mx-auto flex w-full max-w-md flex-1 flex-col gap-5 overflow-auto p-5"
        style="touch-action: pan-y"
      >
        <div
          v-if="me.phase === 'gameOver'"
          class="rounded-2xl bg-[var(--color-panel)] p-5 text-center"
        >
          <div class="text-sm text-[var(--color-muted)]">Fin de partie</div>
          <div class="text-3xl font-black">
            {{
              me.winners.includes(me.id)
                ? 'Vous avez gagné !'
                : `Classement : ${me.rank}e / ${me.playerCount}`
            }}
          </div>
          <div class="mt-1 text-white/70">{{ me.score }} points</div>
        </div>
        <div
          v-else-if="me.phase !== 'lobby'"
          class="rounded-2xl bg-[var(--color-panel)] p-5 text-center"
        >
          <div class="text-xl font-black">Partie en cours</div>
          <p class="mt-1 text-white/70">
            {{
              me.ready
                ? 'Vous entrerez dans la partie à la prochaine manche.'
                : 'Mettez-vous prêt pour entrer à la prochaine manche.'
            }}
          </p>
        </div>

        <button
          class="rounded-3xl py-10 text-4xl font-black transition-colors"
          :style="
            me.ready
              ? { background: color, color: '#000' }
              : { border: `3px solid ${color}`, color }
          "
          @click="setReady(!me.ready)"
        >
          {{ me.ready ? 'PRÊT ✓' : 'Je suis prêt' }}
        </button>
        <p class="text-center text-sm text-[var(--color-muted)]">
          Pendant la partie : moitié gauche de l’écran = tourner à gauche, moitié droite = à droite.
        </p>

        <div v-if="me.phase === 'lobby' || me.phase === 'gameOver'" class="flex flex-col gap-3">
          <div v-if="editing" class="flex gap-2">
            <input
              v-model="profile.name"
              :maxlength="NAME_MAX"
              class="field min-w-0 flex-1 py-2 text-xl"
              style="user-select: text; -webkit-user-select: text"
              @keydown.enter="saveName"
            />
            <button class="btn btn-ghost" @click="saveName">OK</button>
          </div>
          <button
            v-else
            class="btn btn-ghost"
            @click="((profile.name = me.name), (editing = true))"
          >
            Changer de pseudo
          </button>
          <div class="grid grid-cols-6 gap-3">
            <button
              v-for="c in PALETTE"
              :key="c.id"
              class="aspect-square rounded-full border-4 disabled:opacity-15"
              :class="me.color === c.id ? 'border-white' : 'border-transparent'"
              :style="{ background: c.hex }"
              :disabled="taken.includes(c.id)"
              :aria-label="c.name"
              @click="pickColor(c.id)"
            ></button>
          </div>
        </div>

        <div
          class="mt-auto flex items-center justify-between gap-3 text-sm text-[var(--color-muted)]"
        >
          <label class="flex items-center gap-2">
            <input v-model="haptics" type="checkbox" class="accent-[var(--color-accent)]" />
            Vibrations
          </label>
          <button class="underline" @click="toggleFullscreen">Plein écran</button>
          <button class="underline" @click="leave">Quitter</button>
        </div>
      </div>
    </template>

    <div
      v-if="view === 'joined' && socket.status.value !== 'open'"
      class="pointer-events-none fixed inset-x-0 bottom-0 py-1 text-center text-sm font-bold"
      :class="restarting ? 'bg-sky-700' : 'bg-red-700'"
    >
      {{
        restarting
          ? 'Mise à jour du serveur — reprise automatique, ne fermez pas la page…'
          : 'Connexion perdue — reconnexion automatique…'
      }}
    </div>
  </div>
</template>
