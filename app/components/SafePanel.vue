<script setup lang="ts">
/**
 * Barrière d'erreur pour les panneaux secondaires de l'écran hôte (diagnostic,
 * règles, classement) : une erreur de rendu dans l'un d'eux affiche un encart
 * au lieu de faire tomber tout l'écran — l'arène et le QR code restent
 * utilisables pendant la soirée.
 */
const props = defineProps<{ name: string }>()

function report(err: unknown) {
  console.error(`[tangente] panneau « ${props.name} » :`, err)
}
</script>

<template>
  <NuxtErrorBoundary @error="report">
    <slot />
    <template #error="{ error, clearError }">
      <div
        class="rounded-lg border border-red-500/40 bg-red-950/50 p-3 font-sans text-xs text-red-200"
        role="alert"
      >
        Panneau « {{ name }} » indisponible :
        <span class="font-mono">{{ (error as Error)?.message ?? error }}</span>
        <button type="button" class="ml-2 underline" @click="clearError()">réessayer</button>
      </div>
    </template>
  </NuxtErrorBoundary>
</template>
