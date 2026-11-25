/** The sub-pages of the settings: each id is the `section` param of the route `/settings/[section]`. */
export type SettingsSectionId = 'services' | 'lecture' | 'downtify' | 'apparence' | 'voiture' | 'montre' | 'photos' | 'verrouillage' | 'stockage' | 'apropos'

/** The title shown in the header of a sub-page, and the sentence at the top saying what it is for. */
export const SETTINGS_SECTIONS: Record<SettingsSectionId, { title: string; intro: string }> = {
  services: { title: 'Services', intro: 'Les serveurs auxquels l’application se connecte, le contrôle à distance depuis le PC et, pour le propriétaire, leur administration.' },
  lecture: { title: 'Lecture', intro: 'Comment la musique s’enchaîne et sonne : fondu, volume uniforme, réseau faible et égaliseur.' },
  downtify: { title: 'Téléchargements Downtify', intro: 'Suivre les téléchargements en cours et choisir le format et la qualité des fichiers récupérés par Downtify.' },
  apparence: { title: 'Apparence', intro: 'Les couleurs de l’application et l’animation qui accompagne le changement d’onglet.' },
  voiture: { title: 'Mode voiture', intro: 'Une interface simplifiée pour garder les yeux sur la route : gros boutons et gestes de la main.' },
  montre: { title: 'Montre', intro: 'Envoyer la bibliothèque à la montre connectée pour l’écouter sans le téléphone.' },
  photos: { title: 'Sauvegarde des photos', intro: 'Envoyer automatiquement les photos du téléphone vers FileBrowser.' },
  verrouillage: { title: 'Verrouillage', intro: 'Protéger l’ouverture de l’application par un code, un schéma ou une empreinte.' },
  stockage: { title: 'Stockage', intro: 'Ce que l’application garde sur ce téléphone : titres téléchargés et pochettes.' },
  apropos: { title: 'À propos', intro: 'La version installée, les mises à jour, les nouveautés et les outils de diagnostic.' }
}

export function isSettingsSection(value: unknown): value is SettingsSectionId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SETTINGS_SECTIONS, value)
}
