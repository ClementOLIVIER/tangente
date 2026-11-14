import { cpSync, existsSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import tailwindcss from '@tailwindcss/vite'

/**
 * node-datachannel charge son binaire natif depuis un paquet optionnel propre à
 * la plateforme (`@node-datachannel/linux-x64-gnu`…), par un `require`
 * dynamique que le traçage de Nitro ne voit pas : après la compilation, on
 * recopie ces paquets à côté de node-datachannel dans `.output`.
 */
function copyNodeDataChannelBinaries(rootDir: string, serverDir: string): number {
  const pkgDir = realpathSync(join(rootDir, 'node_modules', 'node-datachannel'))
  const scopeDir = join(pkgDir, '..', '@node-datachannel')
  if (!existsSync(scopeDir)) return 0
  const names = readdirSync(scopeDir)
  for (const name of names) {
    cpSync(
      realpathSync(join(scopeDir, name)),
      join(serverDir, 'node_modules', '@node-datachannel', name),
      {
        recursive: true,
        dereference: true,
      },
    )
  }
  return names.length
}

export default defineNuxtConfig({
  ssr: false, // SPA : aucun intérêt SEO, chargement minimal côté téléphone
  devtools: { enabled: false },
  css: ['~/assets/css/main.css'],

  nitro: {
    preset: 'node-server',
    experimental: { websocket: true },
    // le lanceur construit une mise à jour à côté (`.output-next`) pendant que la partie continue
    ...(process.env.TANGENTE_OUTPUT_DIR
      ? { output: { dir: process.env.TANGENTE_OUTPUT_DIR } }
      : {}),
  },

  vite: {
    plugins: [tailwindcss()],
    // le dev server reçoit l'Host du tunnel (xxx.trycloudflare.com / xxx.lhr.life)
    server: { allowedHosts: true },
  },

  app: {
    head: {
      title: 'Tangente',
      htmlAttrs: { lang: 'fr' },
      meta: [
        {
          name: 'viewport',
          content:
            'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover',
        },
        { name: 'theme-color', content: '#000000' },
        { name: 'mobile-web-app-capable', content: 'yes' },
        { name: 'apple-mobile-web-app-capable', content: 'yes' },
        { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' },
      ],
      link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    },
  },

  hooks: {
    'nitro:init'(nitro) {
      nitro.hooks.hook('compiled', () => {
        if (nitro.options.dev) return
        const n = copyNodeDataChannelBinaries(nitro.options.rootDir, nitro.options.output.serverDir)
        console.info(`[tangente] binaire natif node-datachannel copié (${n} paquet)`)
      })
    },
  },

  compatibilityDate: '2025-07-15',
})
