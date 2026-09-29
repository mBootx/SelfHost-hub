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
    version: '2.2.0',
    items: [
      {
        title: 'Écoutes synchronisées',
        text: "Vos écoutes sont envoyées à Navidrome : « Récemment écouté » et les compteurs d'écoute vous suivent d'un appareil à l'autre, même après une écoute hors ligne."
      },
      {
        title: 'Nouveaux titres',
        text: 'Quand Downtify termine un téléchargement, la bibliothèque se met à jour toute seule.'
      },
      {
        title: 'Contrôles Windows',
        text: 'Le titre et la pochette apparaissent dans le panneau de volume de Windows, et les touches multimédia du clavier fonctionnent.'
      },
      {
        title: 'Zone de notification',
        text: "Fermer la fenêtre laisse la musique jouer : l'icône près de l'horloge permet de la piloter. L'application peut aussi démarrer avec Windows (Réglages → Application)."
      },
      {
        title: 'Serveur',
        text: "Pour le propriétaire du serveur : un onglet avec l'état des services, l'espace disque, le scan de la bibliothèque et le réveil à distance."
      },
      {
        title: 'Nouvelle icône',
        text: 'SelfHost Hub a désormais son propre logo.'
      }
    ]
  },
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
