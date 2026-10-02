const ROOT = '/backups/photos/alice'

/** Alice's backups, and next to them Bob's: the files the gallery must never reach. */
function vaultTree() {
  return {
    backups: {
      photos: {
        alice: {
          2026: { '09': { 'a.jpg': 100, 'b.HEIC': 200, 'c.mp4': 999, 'notes.txt': 5 }, '08': { 'd.png': 300 } },
          2025: { 12: { 'e.jpg': 50 } },
          'stray.jpg': 10,
          deep: { x: { y: { w: { 'z.jpg': 1 } } } }
        },
        bob: { 2026: { '09': { 'secret.jpg': 777 } } }
      }
    }
  }
}

module.exports = { ROOT, vaultTree }
