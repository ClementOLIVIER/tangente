<script setup lang="ts">
import { colorHex } from '../../shared/constants'
import type { LobbyPlayer, Phase } from '../../shared/protocol'

const props = defineProps<{
  players: LobbyPlayer[]
  target: number
  phase: Phase
  compact?: boolean
}>()

const rows = computed(() =>
  props.players
    .filter(p => p.inGame)
    .slice()
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)),
)
const inRound = computed(() => props.phase !== 'lobby' && props.phase !== 'gameOver')
</script>

<template>
  <ol class="flex flex-col" :class="compact ? 'gap-1.5' : 'gap-3'">
    <li
      v-for="p in rows"
      :key="p.id"
      class="transition-opacity"
      :class="{ 'opacity-40': inRound && p.idx >= 0 && !p.alive }"
    >
      <div class="flex items-baseline justify-between gap-3 leading-none">
        <span
          class="truncate font-semibold"
          :class="compact ? 'text-[clamp(1rem,1.6vw,1.6rem)]' : 'text-[clamp(1.2rem,2.2vw,2.6rem)]'"
          :style="{ color: colorHex(p.color) }"
        >
          {{ p.name }}
        </span>
        <span class="flex items-baseline gap-2">
          <span v-if="p.roundPoints > 0" class="text-sm font-bold text-white/60">
            +{{ p.roundPoints }}
          </span>
          <span
            class="font-bold tabular-nums"
            :class="
              compact ? 'text-[clamp(1rem,1.6vw,1.6rem)]' : 'text-[clamp(1.2rem,2.2vw,2.6rem)]'
            "
            :style="{ color: colorHex(p.color) }"
          >
            {{ p.score }}
          </span>
        </span>
      </div>
      <div class="mt-1.5 h-1 overflow-hidden rounded-full bg-white/10">
        <div
          class="h-full rounded-full transition-[width] duration-500"
          :style="{
            width: `${Math.min(100, (p.score / Math.max(1, target)) * 100)}%`,
            background: colorHex(p.color),
          }"
        ></div>
      </div>
      <div v-if="!p.connected" class="mt-1 text-xs text-white/50">hors ligne</div>
    </li>
  </ol>
</template>
