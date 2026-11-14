import { useGameServer } from '../utils/game'

export default defineEventHandler(() => {
  const gs = useGameServer()
  return { ok: true, app: 'tangente', rooms: gs.rooms.size, ...gs.diag, tunnel: gs.tunnel }
})
