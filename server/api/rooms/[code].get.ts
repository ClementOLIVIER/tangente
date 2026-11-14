import { MAX_PLAYERS } from '../../../shared/constants'
import { useGameServer } from '../../utils/game'

/** Avant de rejoindre : le salon existe-t-il, quelles couleurs sont prises ? */
export default defineEventHandler(event => {
  const code = String(getRouterParam(event, 'code') ?? '')
    .toUpperCase()
    .slice(0, 8)
  const room = useGameServer().rooms.get(code)
  if (!room) return { exists: false, taken: [], full: false }
  return { exists: true, taken: room.takenColors(), full: room.players.size >= MAX_PLAYERS }
})
