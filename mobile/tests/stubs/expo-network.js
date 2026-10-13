const fake = require('./fake')
exports.NetworkStateType = { WIFI: 'WIFI', ETHERNET: 'ETHERNET', CELLULAR: 'CELLULAR' }
exports.getNetworkStateAsync = async () => ({ type: fake.network, isConnected: fake.network !== 'NONE' })
// What the phone says when its connection changes: tests call __emitNetwork({ isConnected, isInternetReachable }).
exports.addNetworkStateListener = (listener) => {
  fake.networkListeners = fake.networkListeners || []
  fake.networkListeners.push(listener)
  return { remove: () => (fake.networkListeners = fake.networkListeners.filter((l) => l !== listener)) }
}
exports.__emitNetwork = (state) => (fake.networkListeners || []).forEach((listener) => listener(state))
