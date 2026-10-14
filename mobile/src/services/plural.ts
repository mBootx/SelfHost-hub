/** "1 titre", "12 titres": French takes the singular for 0 and 1. */
export function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString('fr-FR')} ${pluralWord(count, one, many)}`
}

/** Just the word, for sentences that put the number elsewhere. */
export function pluralWord(count: number, one: string, many: string): string {
  return Math.abs(count) > 1 ? many : one
}
