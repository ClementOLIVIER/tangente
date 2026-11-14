<script setup lang="ts">
import { colorHex } from '../../shared/constants'
import type { LinkPath, LobbyPlayer, ServerDiag, TunnelInfo } from '../../shared/protocol'

type Summary = { p50: number; p95: number; n: number }

export interface ClientStats {
  fps: number
  frameP95: number
  /** Trames serveur reçues par seconde (cible : la fréquence de simulation pendant une manche). */
  framesPerSec: number
  /** Arrivée d'une commande au serveur → image qui l'affiche (ms), par index de manche. */
  latencyByIdx: Map<number, Summary>
  /** Toucher (horloge du téléphone synchronisée) → image (ms), par index de manche. */
  touchByIdx: Map<number, Summary>
  latencyAll: Summary | null
  /** Canvas basse latence accordé (dessin dès réception, hors compositeur). */
  lowLatency: boolean
  wsStatus: string
}

const props = defineProps<{
  diag: ServerDiag | null
  stats: ClientStats
  players: LobbyPlayer[]
  tunnel: TunnelInfo
}>()

const fmt = (v: number | null | undefined, d = 1) =>
  v === null || v === undefined ? '—' : v.toFixed(d)

const PATH: Record<LinkPath, { label: string; cls: string }> = {
  lan: { label: 'LAN', cls: 'text-green-400' },
  direct: { label: 'direct', cls: 'text-green-300' },
  relay: { label: 'relais', cls: 'text-amber-300' },
  ws: { label: 'tunnel', cls: 'text-red-300' },
}

const rows = computed(() =>
  props.players.map(p => {
    const d = props.diag?.players.find(x => x.id === p.id)
    const touch = p.idx >= 0 ? props.stats.touchByIdx.get(p.idx) : undefined
    const srv = p.idx >= 0 ? props.stats.latencyByIdx.get(p.idx) : undefined
    return { p, d, touch, srv }
  }),
)
</script>

<template>
  <div
    class="rounded-xl border border-[var(--color-line)] bg-black/85 p-4 font-mono text-xs leading-relaxed backdrop-blur"
  >
    <div class="mb-2 flex items-center justify-between font-sans text-sm font-bold">
      Diagnostic
      <span class="text-[var(--color-muted)]">touche D</span>
    </div>
    <div class="grid grid-cols-2 gap-x-6">
      <div>
        <div class="text-[var(--color-muted)]">Écran</div>
        <div>FPS {{ fmt(stats.fps, 0) }} · image p95 {{ fmt(stats.frameP95) }} ms</div>
        <div>
          canvas basse latence :
          <b :class="stats.lowLatency ? 'text-green-400' : 'text-amber-300'">
            {{ stats.lowLatency ? 'oui (dessin dès réception)' : 'non (image suivante)' }}
          </b>
        </div>
        <div>trames reçues {{ stats.framesPerSec }}/s · ws {{ stats.wsStatus }}</div>
        <div>
          serveur → image p50 {{ fmt(stats.latencyAll?.p50) }} · p95
          {{ fmt(stats.latencyAll?.p95) }} ms
          <span class="text-[var(--color-muted)]">(n={{ stats.latencyAll?.n ?? 0 }})</span>
        </div>
      </div>
      <div>
        <div class="text-[var(--color-muted)]">Serveur</div>
        <template v-if="diag">
          <div>
            ticks {{ diag.ticksLastSec }}/{{ diag.tickRate }} · tick moy
            {{ fmt(diag.stepAvgMs, 2) }} · max {{ fmt(diag.stepMaxMs, 2) }} ms
          </div>
          <div>
            retard minuteur moy {{ fmt(diag.lateAvgMs, 2) }} · max {{ fmt(diag.lateMaxMs, 2) }} ms
          </div>
          <div>
            msg in {{ diag.msgInPerSec }}/s · out {{ diag.msgOutPerSec }}/s ·
            {{ diag.connections }} conn · {{ diag.memMb }} Mo
          </div>
        </template>
        <div v-else>—</div>
      </div>
    </div>
    <div class="mt-2 text-[var(--color-muted)]">
      Tunnel {{ tunnel.provider }} : {{ tunnel.status }}
      <span v-if="tunnel.error" class="text-red-400">({{ tunnel.error }})</span>
    </div>
    <table v-if="rows.length" class="mt-3 w-full">
      <thead class="text-[var(--color-muted)]">
        <tr class="text-left">
          <th class="font-normal">joueur</th>
          <th class="font-normal">chemin</th>
          <th class="text-right font-normal" title="RTT WebRTC / WebSocket">RTT dc/ws</th>
          <th class="text-right font-normal" title="part des commandes arrivées d'abord par WebRTC">
            1er dc
          </th>
          <th class="text-right font-normal" title="aller seul toucher → serveur, médiane">
            ↑ aller
          </th>
          <th class="text-right font-normal" title="arrivée serveur → image, médiane">srv→img</th>
          <th class="text-right font-normal" title="toucher → image, médiane · p95 (mesuré)">
            toucher→image
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in rows" :key="r.p.id">
          <td class="max-w-[8rem] truncate" :style="{ color: colorHex(r.p.color) }">
            {{ r.p.name }}
            <span v-if="!r.p.connected" class="text-red-400">✕</span>
          </td>
          <template v-if="r.p.bot">
            <td colspan="6" class="text-[var(--color-muted)]">bot</td>
          </template>
          <template v-else>
            <td :class="r.p.path ? PATH[r.p.path].cls : ''">
              {{ r.p.path ? PATH[r.p.path].label : '—' }}
            </td>
            <td class="text-right">{{ fmt(r.d?.rtcRtt, 0) }}/{{ fmt(r.d?.rtt, 0) }}</td>
            <td class="text-right">
              {{ r.d?.rtcFirstRatio != null ? `${Math.round(r.d.rtcFirstRatio * 100)}%` : '—' }}
            </td>
            <td class="text-right">{{ fmt(r.d?.uplinkP50) }}</td>
            <td class="text-right">{{ fmt(r.srv?.p50) }}</td>
            <td class="text-right font-bold">
              {{ r.touch ? `${fmt(r.touch.p50, 0)} · ${fmt(r.touch.p95, 0)}` : '—' }}
            </td>
          </template>
        </tr>
      </tbody>
    </table>
    <p class="mt-2 font-sans text-[11px] text-[var(--color-muted)]">
      « toucher→image » est mesuré (horloges synchronisées) depuis l’événement tactile jusqu’au
      dessin de l’image ; s’y ajoutent la dalle tactile du téléphone et l’affichage de l’écran / TV.
      Référence absolue : filmer téléphone et écran au ralenti (voir README).
    </p>
  </div>
</template>
