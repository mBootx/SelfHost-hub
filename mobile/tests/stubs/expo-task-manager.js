const fake = require('./fake')
exports.defineTask = (name, fn) => { fake.tasks[name] = fn }
exports.isTaskRegisteredAsync = async (name) => fake.registered.has(name)
