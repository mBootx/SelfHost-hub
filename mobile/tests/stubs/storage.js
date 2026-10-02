const fake = require('./fake')
exports.storage = {
  async saveConnection(s, c) { fake.connections[s] = c },
  async loadConnection(s) { return fake.connections[s] || null },
  async clearConnection(s) { delete fake.connections[s] },
  async saveSecret(s, f, v) { fake.secrets[`${s}_${f}`] = v },
  async loadSecret(s, f) { return fake.secrets[`${s}_${f}`] ?? null },
  async clearSecret(s, f) { delete fake.secrets[`${s}_${f}`] },
  async savePref(k, v) { fake.prefs[k] = JSON.parse(JSON.stringify(v)) },
  async loadPref(k) { return k in fake.prefs ? JSON.parse(JSON.stringify(fake.prefs[k])) : null }
}
