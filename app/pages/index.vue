<script setup lang="ts">
import { ROOM_CODE_LENGTH } from '../../shared/constants'

const code = ref('')
const isLocal = ref(false)
onMounted(() => {
  isLocal.value = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
})
function join() {
  const c = code.value.trim().toUpperCase()
  if (c.length === ROOM_CODE_LENGTH) navigateTo(`/play/${c}`)
}
</script>

<template>
  <main class="flex min-h-full flex-col items-center justify-center gap-10 p-6">
    <h1 class="text-[clamp(3rem,10vw,7rem)] leading-none font-black">
      <span class="text-[var(--color-accent)]">Tangente</span>
    </h1>
    <NuxtLink v-if="isLocal" to="/host" class="btn btn-primary px-10 py-5 text-2xl">
      Ouvrir l’écran de jeu
    </NuxtLink>
    <form class="flex w-full max-w-xs flex-col gap-3" @submit.prevent="join">
      <label class="text-center text-[var(--color-muted)]" for="code">
        Rejoindre avec le code affiché
      </label>
      <input
        id="code"
        v-model="code"
        :maxlength="ROOM_CODE_LENGTH"
        autocapitalize="characters"
        autocomplete="off"
        class="field py-3 text-center text-4xl font-black tracking-[0.4em] uppercase"
        placeholder="ABCD"
      />
      <button
        class="btn btn-ghost py-3 text-xl"
        :disabled="code.trim().length !== ROOM_CODE_LENGTH"
      >
        Rejoindre
      </button>
    </form>
  </main>
</template>
