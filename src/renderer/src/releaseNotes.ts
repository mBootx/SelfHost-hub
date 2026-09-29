export interface ReleaseNote {
  version: string
  items: { title: string; text: string }[]
}

/**
 * What the "Nouveautés" window shows after an update, newest first. In French like the rest of the
 * interface, and only what this desktop app changed; CHANGELOG.md keeps the full notes.
 */
export const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: '2.1.0',
    items: [
      {
        title: 'Reprise de la lecture',
        text: "En rouvrant l'application, vous retrouvez votre file d'attente et le titre en cours, en pause, là où vous l'aviez laissé, à la seconde près."
      },
      {
        title: 'Nouveautés',
        text: 'Cette fenêtre résume chaque mise à jour. Vous pouvez la rouvrir depuis Réglages → Application.'
      },
      {
        title: 'Accents',
        text: "Tous les textes de l'application s'écrivent enfin avec leurs accents."
      },
      {
        title: 'Interrupteurs',
        text: 'Les interrupteurs des réglages (Lecture sans blanc, Égaliseur, Contrôle à distance) ne débordent plus.'
      }
    ]
  }
]

function versionParts(version: string): number[] {
  return version.split('.').map((part) => parseInt(part, 10) || 0)
}

export function isNewer(candidate: string, current: string): boolean {
  const a = versionParts(candidate)
  const b = versionParts(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff > 0
  }
  return false
}
