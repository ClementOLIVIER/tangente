import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { ServerSnapshot, StateStore } from './snapshot'

/**
 * Instantané des salons dans un fichier JSON local (`.data/rooms-<port>.json`
 * par défaut : deux instances sur deux ports ne se marchent pas dessus). Écriture atomique (fichier temporaire puis renommage) : un arrêt
 * brutal laisse l'ancien instantané intact, jamais un fichier tronqué. Le
 * fichier contient les jetons des joueurs et le secret de l'hôte : lisible par
 * l'utilisateur seul.
 *
 * `TANGENTE_STATE_FILE=none` désactive la sauvegarde.
 */
export function stateFilePath(port: number): string | null {
  const v = process.env.TANGENTE_STATE_FILE
  if (v === 'none') return null
  return resolve(v || `.data/rooms-${port}.json`)
}

export function createFileStore(path: string): StateStore {
  return {
    load() {
      try {
        return JSON.parse(readFileSync(path, 'utf8')) as ServerSnapshot
      } catch {
        return null // premier lancement, fichier illisible : on repart à vide
      }
    },
    save(snapshot) {
      mkdirSync(dirname(path), { recursive: true })
      const tmp = `${path}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(snapshot), { mode: 0o600 })
      renameSync(tmp, path)
    },
  }
}
