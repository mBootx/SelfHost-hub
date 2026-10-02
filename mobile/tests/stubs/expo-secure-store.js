const fake = require('./fake')
exports.getItemAsync = async (k) => fake.secure[k] ?? null
exports.setItemAsync = async (k, v) => { fake.secure[k] = v }
exports.deleteItemAsync = async (k) => { delete fake.secure[k] }
