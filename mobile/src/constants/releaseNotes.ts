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
    version: '2.2.0',
    items: [
      {
        title: 'Sauvegarde des photos',
        text: "Les photos et vidéos de l'appareil photo peuvent partir automatiquement dans FileBrowser, rangées par année et par mois (Réglages → Sauvegarde des photos)."
      },
      {
        title: 'Verrouillage',
        text: "Protégez l'application par un code ou un schéma, avec l'empreinte digitale en option (Réglages → Verrouillage)."
      },
      {
        title: 'Écoutes synchronisées',
        text: "Vos écoutes sont envoyées à Navidrome : « Récemment écouté » et les compteurs d'écoute vous suivent d'un appareil à l'autre, même après une écoute hors ligne."
      },
      {
        title: 'Nouveaux titres',
        text: 'Quand Downtify termine un téléchargement, la bibliothèque se met à jour toute seule.'
      },
      {
        title: 'Serveur',
        text: "Pour le propriétaire du serveur : l'état des services, l'espace disque, le scan de la bibliothèque et le réveil à distance (Réglages → Serveur)."
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
      }
    ]
  }
]
