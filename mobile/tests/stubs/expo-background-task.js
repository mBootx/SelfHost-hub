const fake = require('./fake')
exports.BackgroundTaskResult = { Success: 1, Failed: 2 }
exports.registerTaskAsync = async (name, opts) => { fake.registered.add(name); fake.registeredOptions = opts }
exports.unregisterTaskAsync = async (name) => { fake.registered.delete(name) }
