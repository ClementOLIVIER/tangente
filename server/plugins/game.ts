import { useGameServer } from '../utils/game'

/**
 * Démarre la boucle de simulation dès le lancement du serveur (salons de
 * l'instance précédente restaurés) ; à l'arrêt, sauvegarde et prévient les
 * clients, qui se reconnectent seuls.
 */
export default defineNitroPlugin(nitro => {
  const gs = useGameServer()
  // avant l'arrêt gracieux de Nitro, qui attend la fin des connexions avant
  // d'appeler `close` : on prévient et on ferme nous-mêmes les WebSockets
  for (const sig of ['SIGTERM', 'SIGINT'] as const)
    process.once(sig, () => {
      const t0 = performance.now()
      const n = gs.conns.size
      gs.shutdown()
      const ms = (performance.now() - t0).toFixed(0)
      console.info(`[tangente] arrêt : salons sauvegardés, ${n} connexion(s) fermée(s) en ${ms} ms`)
      if (process.env.TANGENTE_DEBUG_EXIT)
        process.once('exit', () =>
          console.info(`[tangente] sortie ${(performance.now() - t0).toFixed(0)} ms après ${sig}`),
        )
    })
  nitro.hooks.hook('close', () => gs.shutdown())
})
