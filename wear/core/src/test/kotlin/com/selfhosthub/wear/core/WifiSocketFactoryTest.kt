package com.selfhosthub.wear.core

import java.net.InetAddress
import java.net.Socket
import javax.net.SocketFactory
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Test

class WifiSocketFactoryTest {
    /** A factory that hands out one known socket, to tell which factory was asked. */
    private class Marked(val socket: Socket = Socket()) : SocketFactory() {
        override fun createSocket(): Socket = socket
        override fun createSocket(host: String?, port: Int): Socket = socket
        override fun createSocket(host: String?, port: Int, localHost: InetAddress?, localPort: Int): Socket = socket
        override fun createSocket(host: InetAddress?, port: Int): Socket = socket
        override fun createSocket(address: InetAddress?, port: Int, localAddress: InetAddress?, localPort: Int): Socket = socket
    }

    @Test
    fun `sockets come from the Wi-Fi network while there is one`() {
        val wifi = Marked()
        val factory = WifiSocketFactory { wifi }
        assertSame(wifi.socket, factory.createSocket())
        assertSame(wifi.socket, factory.createSocket("192.168.1.20", 51823))
    }

    @Test
    fun `and the choice is made again at every connection`() {
        var wifi: SocketFactory? = null
        val factory = WifiSocketFactory { wifi }
        val first = factory.createSocket()
        val joined = Marked()
        wifi = joined
        assertSame(joined.socket, factory.createSocket())
        wifi = null
        // Back to the system's choice: a fresh socket of the default factory, not the Wi-Fi's.
        val again = factory.createSocket()
        assertNotSame(joined.socket, again)
        assertNotSame(first, again)
    }
}
