export interface ReleaseNote {
  version: string
  items: { title: string; text: string }[]
}

/**
 * What the "Nouveautés" window shows after an update, newest first. In French like the rest of the
 * interface, and only what the Android app changed; CHANGELOG.md keeps the full notes.
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
      }
    ]
  }
]
