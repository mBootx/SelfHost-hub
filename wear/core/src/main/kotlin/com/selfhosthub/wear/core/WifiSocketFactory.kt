package com.selfhosthub.wear.core

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import java.net.InetAddress
import java.net.Socket
import javax.net.SocketFactory

/**
 * Opens sockets on the watch's Wi-Fi network when it has one, and on whatever the system chooses otherwise.
 *
 * Navidrome may be on the home network (see PrivateAddress). A watch that is paired to a phone has two ways to the
 * internet, its own Wi-Fi and the phone's connection over Bluetooth, and the system's default can be the second one even
 * while the first is up; a socket opened on that default then may never reach `192.168.x.x`. Binding the socket to the
 * Wi-Fi network is how the Android documentation says to make a connection use a particular network. The choice is
 * made at every connection, so a watch that joins or leaves the Wi-Fi is followed.
 */
class WifiSocketFactory(private val wifi: () -> SocketFactory?) : SocketFactory() {
    private fun current(): SocketFactory = wifi() ?: getDefault()

    override fun createSocket(): Socket = current().createSocket()
    override fun createSocket(host: String, port: Int): Socket = current().createSocket(host, port)
    override fun createSocket(host: String, port: Int, localHost: InetAddress, localPort: Int): Socket = current().createSocket(host, port, localHost, localPort)
    override fun createSocket(host: InetAddress, port: Int): Socket = current().createSocket(host, port)
    override fun createSocket(address: InetAddress, port: Int, localAddress: InetAddress, localPort: Int): Socket = current().createSocket(address, port, localAddress, localPort)

    companion object {
        /** The factory of the watch's Wi-Fi network at this moment, or null when it is not connected to one. */
        @Suppress("DEPRECATION") // allNetworks: the Wi-Fi is not the active network when the Bluetooth proxy is
        fun wifiNetwork(context: Context): Network? {
            val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return null
            return manager.allNetworks.firstOrNull { network ->
                manager.getNetworkCapabilities(network)?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
            }
        }

        fun forContext(context: Context): WifiSocketFactory = WifiSocketFactory { wifiNetwork(context)?.socketFactory }
    }
}
