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
    version: '2.3.1',
    items: [
      {
        title: 'Photos : les plus récentes d’abord',
        text: "La sauvegarde envoie maintenant les photos les plus récentes en premier, puis les plus anciennes, les photos avant les vidéos. Avant, les dernières photos arrivaient en dernier."
      },
      {
        title: 'Un fichier bloqué ne bloque plus le reste',
        text: "Si un fichier n'arrive pas à partir, la sauvegarde continue avec les suivants au lieu de s'arrêter. Les fichiers refusés par le serveur peuvent être renvoyés d'un geste."
      },
      {
        title: 'Onglet Photos à jour',
        text: "À l'ouverture, l'onglet cherche les nouvelles photos du téléphone et les affiche au fur et à mesure de leur envoi. Tirez vers le bas pour actualiser."
      },
      {
        title: 'État de la sauvegarde',
        text: "Une ligne au-dessus des photos indique où en est l'envoi : en cours, en attente du Wi-Fi, refusé par le serveur… avec le bouton qui correspond."
      },
      {
        title: 'Anciennes photos visibles',
        text: "Les photos de l'ancien dossier apparaissent dans l'onglet sans avoir à les déplacer. Les ranger dans votre dossier est facultatif (Réglages → Sauvegarde des photos)."
      }
    ]
  },
  {
    version: '2.3.0',
    items: [
      {
        title: 'Écran de lecture refait',
        text: "La pochette occupe toute la largeur, avec le titre, un cœur pour les favoris, la barre de progression et les boutons. La page prend la couleur de la pochette."
      },
      {
        title: 'Paroles en carte',
        text: "Les paroles forment une carte sous le lecteur. Touchez-la pour les afficher en grand : elles suivent le morceau, et toucher une ligne y emmène."
      },
      {
        title: 'Onglet Photos',
        text: 'Vos photos sauvegardées en grille, mois par mois : affichage en grand, tri, recherche, sélection et suppression.'
      },
      {
        title: 'Sauvegarde par compte',
        text: "Les photos sont rangées dans un dossier à votre nom (/backups/photos/votre-compte). L'onglet Photos propose de déplacer les anciennes sauvegardes."
      },
      {
        title: 'Fondu enchaîné réparé',
        text: 'Le fondu fonctionne aussi écran éteint, et le titre suivant démarre bien au début.'
      },
      {
        title: 'Now Bar Samsung',
        text: 'Passer un titre ne ferme plus la Now Bar, qui affiche maintenant la pochette.'
      }
    ]
  },
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
