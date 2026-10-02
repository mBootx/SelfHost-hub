const fake = require('./fake')

// Records every request and answers from fake.xhrReplies: a list of [matcher, reply] where matcher is a
// substring of "METHOD url" (or a function of the request) and reply is a response object or a function of the request.
exports.xhrRequest = async (config) => {
  const request = { method: config.method || 'GET', url: config.url, headers: config.headers || {}, data: config.data }
  fake.xhrLog.push(request)
  const label = `${request.method} ${request.url}`
  for (const [matcher, reply] of fake.xhrReplies) {
    const hit = typeof matcher === 'function' ? matcher(request) : label.includes(matcher)
    if (!hit) continue
    const response = typeof reply === 'function' ? reply(request) : reply
    return { ok: response.status >= 200 && response.status < 300, headers: {}, data: null, ...response }
  }
  return { ok: false, status: 404, data: null, headers: {}, error: 'no reply scripted for ' + label }
}
