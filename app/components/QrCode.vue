<script setup lang="ts">
import { renderSVG } from 'uqr'

const props = defineProps<{ value: string }>()
// modules noirs sur blanc, marge incluse : lisible par tous les lecteurs, même projeté
const svg = computed(() => renderSVG(props.value, { ecc: 'M', border: 2, pixelSize: 8 }))
</script>

<template>
  <div class="qr overflow-hidden rounded-xl bg-white" v-html="svg"></div>
</template>

<style scoped>
.qr :deep(svg) {
  display: block;
  width: 100%;
  height: auto;
}
</style>
