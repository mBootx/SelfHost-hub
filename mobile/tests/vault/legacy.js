const LEGACY = '/Appareil photo'

/** An old backup folder (year/month), next to an account folder that already holds a clashing photo. */
function legacyTree() {
  return {
    'Appareil photo': {
      2026: { '08': { 'a.jpg': 10, 'v.mp4': 20 }, '09': { 'b.jpg': 30, 'notes.txt': 1 } },
      2025: { 12: { 'old.jpg': 40 } }
    },
    backups: {
      photos: {
        alice: { 2026: { '09': { 'b.jpg': 99, 'z.jpg': 5 } } },
        bob: { 2026: { '09': { 'secret.jpg': 777 } } }
      }
    }
  }
}

module.exports = { LEGACY, legacyTree }
