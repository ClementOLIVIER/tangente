import { defineConfig } from 'vitest/config'

// Tests du moteur, du salon et du serveur (modules purs : pas de Nuxt, pas de DOM).
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
  },
})
