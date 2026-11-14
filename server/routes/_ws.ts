import { isLocalRequest, useGameServer } from '../utils/game'

/** Adaptateur crossws → GameServer : aucune logique de jeu ici. */
export default defineWebSocketHandler({
  open(peer) {
    const headers = peer.request?.headers ?? new Headers()
    useGameServer().onOpen({
      id: peer.id,
      local: isLocalRequest(peer.remoteAddress, headers as Headers),
      send: data => peer.send(data),
      close: (code, reason) => peer.close(code, reason),
    })
  },
  message(peer, message) {
    useGameServer().onMessage(peer.id, message.text())
  },
  close(peer) {
    useGameServer().onClose(peer.id)
  },
  error(peer) {
    useGameServer().onClose(peer.id)
  },
})
