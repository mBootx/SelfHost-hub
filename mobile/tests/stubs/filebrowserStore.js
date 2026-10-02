const fake = require('./fake')
exports.useFileBrowserStore = { getState: () => ({ client: fake.liveClient || null }) }
