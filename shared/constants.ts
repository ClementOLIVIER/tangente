/**
 * Constantes partagées serveur / navigateurs. Aucune dépendance : importable
 * par le moteur (Node), les tests (Vitest) et l'application Nuxt.
 */

/** Fréquence de simulation (Hz). 240 Hz : ≤ 4,2 ms (moy. 2,1) d’attente avant prise en compte d’un appui. */
export const TICK_RATE = 240
export const TICK_MS = 1000 / TICK_RATE
export const DT = 1 / TICK_RATE

export const MAX_PLAYERS = 12
export const NAME_MAX = 16
export const ROOM_CODE_LENGTH = 4
/** Lettres sans ambiguïté visuelle (pas de I, O, 0, 1). */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'

/** Rayon logique d'un bonus posé dans l'arène. */
export const BONUS_RADIUS = 14
/** Rayon de la zone supprimée par « Effacement ». */
export const ERASE_RADIUS = 200

/** Bits d'état d'une tête dans une trame (`f`). */
export const FLAG = {
  ALIVE: 1,
  /** Un segment de trace a été posé pendant ce tick. */
  DRAW: 2,
  GHOST: 4,
  SHIELD: 8,
  INVERT: 16,
  /** Invulnérable aux traces juste après la consommation d'un bouclier. */
  IMMUNE: 32,
  /** Dans un trou périodique. */
  GAP: 64,
} as const

/** Nombre de valeurs par tête dans une trame : x, y, angle, épaisseur, flags. */
export const FRAME_STRIDE = 5

/** Bits de commande envoyés par un téléphone. */
export const INPUT = { LEFT: 1, RIGHT: 2 } as const

export interface PaletteColor {
  id: string
  name: string
  hex: string
}

/** 12 couleurs contrastées sur fond noir, distinguables à distance. */
export const PALETTE: readonly PaletteColor[] = [
  { id: 'rouge', name: 'Rouge', hex: '#ff3b30' },
  { id: 'orange', name: 'Orange', hex: '#ff9500' },
  { id: 'jaune', name: 'Jaune', hex: '#ffe11a' },
  { id: 'vert', name: 'Vert', hex: '#9be22d' },
  { id: 'emeraude', name: 'Émeraude', hex: '#00c781' },
  { id: 'cyan', name: 'Cyan', hex: '#2ee6ff' },
  { id: 'bleu', name: 'Bleu', hex: '#4b82ff' },
  { id: 'violet', name: 'Violet', hex: '#a866ff' },
  { id: 'rose', name: 'Rose', hex: '#ff4fc3' },
  { id: 'blanc', name: 'Blanc', hex: '#f0f0f0' },
  { id: 'sable', name: 'Sable', hex: '#d1aa6b' },
  { id: 'gris', name: 'Gris', hex: '#9aa0a6' },
]

export function colorHex(id: string): string {
  return PALETTE.find(c => c.id === id)?.hex ?? '#ffffff'
}
