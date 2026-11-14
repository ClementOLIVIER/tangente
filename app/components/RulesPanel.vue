<script setup lang="ts">
import {
  BONUS_DEFS,
  BONUS_KINDS,
  DEFAULT_RULES,
  type BonusKind,
  type Rules,
} from '../../shared/rules'

const props = defineProps<{ rules: Rules; target: number }>()
const emit = defineEmits<{ change: [rules: Partial<Rules>] }>()

const advanced = ref(false)

function set<K extends keyof Rules>(key: K, value: Rules[K]) {
  emit('change', { [key]: value } as Partial<Rules>)
}
function setNum(key: keyof Rules, ev: Event) {
  const v = Number((ev.target as HTMLInputElement).value)
  if (Number.isFinite(v)) emit('change', { [key]: v } as Partial<Rules>)
}
function toggleBonus(k: BonusKind) {
  emit('change', { bonuses: { ...props.rules.bonuses, [k]: !props.rules.bonuses[k] } })
}
function setAllBonuses(v: boolean) {
  emit('change', { bonuses: Object.fromEntries(BONUS_KINDS.map(k => [k, v])) as Rules['bonuses'] })
}
function resetAdvanced() {
  const {
    speed,
    turnRate,
    thickness,
    gapEveryMin,
    gapEveryMax,
    gapDurationMin,
    gapDurationMax,
    arenaSize,
  } = DEFAULT_RULES
  emit('change', {
    speed,
    turnRate,
    thickness,
    gapEveryMin,
    gapEveryMax,
    gapDurationMin,
    gapDurationMax,
    arenaSize,
  })
}

const TONE: Record<string, string> = {
  good: 'bg-green-700',
  bad: 'bg-red-700',
  neutral: 'bg-blue-700',
}
</script>

<template>
  <div class="flex flex-col gap-5 text-sm">
    <section>
      <h3 class="mb-2 text-xs font-bold tracking-widest text-[var(--color-muted)] uppercase">
        Mode
      </h3>
      <div class="grid grid-cols-2 gap-2">
        <button
          v-for="m in [
            { id: 'classic', label: 'Classique', sub: 'traces, trous, collisions' },
            { id: 'party', label: 'Party', sub: 'avec bonus et malus' },
          ] as const"
          :key="m.id"
          class="rounded-lg border px-3 py-2 text-left transition-colors"
          :class="
            rules.mode === m.id
              ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10'
              : 'border-[var(--color-line)] hover:border-white/40'
          "
          @click="set('mode', m.id)"
        >
          <div class="font-bold">{{ m.label }}</div>
          <div class="text-xs text-[var(--color-muted)]">{{ m.sub }}</div>
        </button>
      </div>
    </section>

    <section>
      <h3 class="mb-2 text-xs font-bold tracking-widest text-[var(--color-muted)] uppercase">
        Fin de partie
      </h3>
      <div class="flex flex-col gap-2">
        <label class="flex items-center gap-2">
          <input
            type="radio"
            :checked="rules.endCondition === 'score'"
            class="accent-[var(--color-accent)]"
            @change="set('endCondition', 'score')"
          />
          Objectif de points
          <input
            type="number"
            min="0"
            max="999"
            class="field w-20"
            :value="rules.targetScore"
            :disabled="rules.endCondition !== 'score'"
            @change="setNum('targetScore', $event)"
          />
          <span class="text-xs text-[var(--color-muted)]">
            {{ rules.targetScore === 0 ? `auto : ${target}` : '' }}
          </span>
        </label>
        <label
          class="ml-6 flex items-center gap-2"
          :class="{ 'opacity-40': rules.endCondition !== 'score' }"
        >
          <input
            type="checkbox"
            :checked="rules.winByTwo"
            class="accent-[var(--color-accent)]"
            @change="set('winByTwo', ($event.target as HTMLInputElement).checked)"
          />
          2 points d’avance pour gagner
        </label>
        <label class="flex items-center gap-2">
          <input
            type="radio"
            :checked="rules.endCondition === 'rounds'"
            class="accent-[var(--color-accent)]"
            @change="set('endCondition', 'rounds')"
          />
          Nombre de manches
          <input
            type="number"
            min="1"
            max="99"
            class="field w-20"
            :value="rules.rounds"
            :disabled="rules.endCondition !== 'rounds'"
            @change="setNum('rounds', $event)"
          />
        </label>
      </div>
    </section>

    <section>
      <h3 class="mb-2 text-xs font-bold tracking-widest text-[var(--color-muted)] uppercase">
        Manches et points
      </h3>
      <div class="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-2">
        <span>Points par adversaire éliminé</span>
        <input
          type="number"
          min="0"
          max="10"
          class="field w-20"
          :value="rules.pointsPerDeath"
          @change="setNum('pointsPerDeath', $event)"
        />
        <span>Bonus du dernier survivant</span>
        <input
          type="number"
          min="0"
          max="50"
          class="field w-20"
          :value="rules.survivorBonus"
          @change="setNum('survivorBonus', $event)"
        />
        <span>Compte à rebours (s)</span>
        <input
          type="number"
          min="1"
          max="10"
          class="field w-20"
          :value="rules.countdown"
          @change="setNum('countdown', $event)"
        />
        <label class="flex items-center gap-2">
          <input
            type="checkbox"
            :checked="rules.autoNextRound"
            class="accent-[var(--color-accent)]"
            @change="set('autoNextRound', ($event.target as HTMLInputElement).checked)"
          />
          Enchaîner automatiquement après (s)
        </label>
        <input
          type="number"
          min="2"
          max="60"
          class="field w-20"
          :value="rules.roundEndDelay"
          :disabled="!rules.autoNextRound"
          @change="setNum('roundEndDelay', $event)"
        />
      </div>
    </section>

    <section v-if="rules.mode === 'party'">
      <div class="mb-2 flex items-center justify-between">
        <h3 class="text-xs font-bold tracking-widest text-[var(--color-muted)] uppercase">Bonus</h3>
        <span class="flex gap-2 text-xs">
          <button class="text-[var(--color-muted)] hover:text-white" @click="setAllBonuses(true)">
            tous
          </button>
          <button class="text-[var(--color-muted)] hover:text-white" @click="setAllBonuses(false)">
            aucun
          </button>
        </span>
      </div>
      <div class="grid grid-cols-2 gap-1.5">
        <button
          v-for="k in BONUS_KINDS"
          :key="k"
          class="flex items-center gap-2 rounded-md border px-2 py-1.5 text-left transition-opacity"
          :class="rules.bonuses[k] ? 'border-[var(--color-line)]' : 'border-transparent opacity-40'"
          :title="BONUS_DEFS[k].description"
          @click="toggleBonus(k)"
        >
          <span class="size-2.5 shrink-0 rounded-full" :class="TONE[BONUS_DEFS[k].tone]"></span>
          <span class="truncate">{{ BONUS_DEFS[k].label }}</span>
        </button>
      </div>
      <div class="mt-3 grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-2">
        <span>Bonus simultanés (max)</span>
        <input
          type="number"
          min="1"
          max="10"
          class="field w-20"
          :value="rules.bonusMaxOnField"
          @change="setNum('bonusMaxOnField', $event)"
        />
        <span>Apparition toutes les (s)</span>
        <span class="flex items-center gap-1">
          <input
            type="number"
            step="0.5"
            class="field w-16"
            :value="rules.bonusSpawnMin"
            @change="setNum('bonusSpawnMin', $event)"
          />
          –
          <input
            type="number"
            step="0.5"
            class="field w-16"
            :value="rules.bonusSpawnMax"
            @change="setNum('bonusSpawnMax', $event)"
          />
        </span>
        <span>Durée des malus « Chaos » (s)</span>
        <input
          type="number"
          min="1"
          max="15"
          class="field w-20"
          :value="rules.chaosDuration"
          @change="setNum('chaosDuration', $event)"
        />
      </div>
    </section>

    <section>
      <button
        class="flex w-full items-center justify-between text-xs font-bold tracking-widest text-[var(--color-muted)] uppercase hover:text-white"
        @click="advanced = !advanced"
      >
        Paramètres avancés
        <span>{{ advanced ? '−' : '+' }}</span>
      </button>
      <div v-if="advanced" class="mt-2 grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-2">
        <span>Vitesse (unités/s)</span>
        <input
          type="number"
          step="5"
          class="field w-20"
          :value="rules.speed"
          @change="setNum('speed', $event)"
        />
        <span>Rotation (rad/s)</span>
        <input
          type="number"
          step="0.1"
          class="field w-20"
          :value="rules.turnRate"
          @change="setNum('turnRate', $event)"
        />
        <span>Épaisseur</span>
        <input
          type="number"
          step="0.5"
          class="field w-20"
          :value="rules.thickness"
          @change="setNum('thickness', $event)"
        />
        <span>Trou toutes les (s)</span>
        <span class="flex items-center gap-1">
          <input
            type="number"
            step="0.5"
            class="field w-16"
            :value="rules.gapEveryMin"
            @change="setNum('gapEveryMin', $event)"
          />
          –
          <input
            type="number"
            step="0.5"
            class="field w-16"
            :value="rules.gapEveryMax"
            @change="setNum('gapEveryMax', $event)"
          />
        </span>
        <span>Durée d’un trou (ms)</span>
        <span class="flex items-center gap-1">
          <input
            type="number"
            step="10"
            class="field w-16"
            :value="rules.gapDurationMin"
            @change="setNum('gapDurationMin', $event)"
          />
          –
          <input
            type="number"
            step="10"
            class="field w-16"
            :value="rules.gapDurationMax"
            @change="setNum('gapDurationMax', $event)"
          />
        </span>
        <span>Taille de l’arène</span>
        <select
          class="field"
          :value="rules.arenaSize"
          @change="
            set('arenaSize', ($event.target as HTMLSelectElement).value as Rules['arenaSize'])
          "
        >
          <option value="auto">Auto (selon joueurs)</option>
          <option value="small">Petite</option>
          <option value="medium">Moyenne</option>
          <option value="large">Grande</option>
        </select>
        <span></span>
        <button
          class="text-right text-xs text-[var(--color-muted)] hover:text-white"
          @click="resetAdvanced"
        >
          valeurs par défaut
        </button>
      </div>
    </section>
    <p class="text-xs text-[var(--color-muted)]">
      Les changements s’appliquent à la manche suivante.
    </p>
  </div>
</template>
