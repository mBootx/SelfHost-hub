// The phone says it is 127.0.0.50, so a scan of its subnet probes 127.0.0.1-254, where the test hub listens.
exports.getIpAddressAsync = async () => '127.0.0.50'
exports.NetworkStateType = { WIFI: 'WIFI', ETHERNET: 'ETHERNET', CELLULAR: 'CELLULAR' }
exports.getNetworkStateAsync = async () => ({ type: 'WIFI', isConnected: true })
