const fake = require('./fake')
// The diagnostics log, as a list the tests can read.
exports.logEvent = (scope, message, level = 'info') => {
  fake.logs = fake.logs || []
  fake.logs.push({ scope, message, level })
}
exports.describeError = (err) => String((err && err.message) || err)
