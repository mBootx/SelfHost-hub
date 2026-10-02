const fake = require('./fake')
exports.NetworkStateType = { WIFI: 'WIFI', ETHERNET: 'ETHERNET', CELLULAR: 'CELLULAR' }
exports.getNetworkStateAsync = async () => ({ type: fake.network, isConnected: fake.network !== 'NONE' })
