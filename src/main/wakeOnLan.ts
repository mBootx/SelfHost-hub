import { createSocket } from 'dgram'

/**
 * Wakes a sleeping machine on the local network: the "magic packet" (6 bytes of 0xFF, then its MAC
 * address 16 times) sent as a UDP broadcast. Only reaches the LAN this computer is on.
 */
export function sendMagicPacket(mac: string, broadcast: string): Promise<{ ok: boolean; error?: string }> {
  // Any usual spelling: AA:BB:CC:DD:EE:FF, aa-bb-cc-dd-ee-ff, aabb.ccdd.eeff or no separators at all.
  const hex = mac.replace(/[\s:.-]/g, '')
  if (!/^[0-9a-f]{12}$/i.test(hex)) return Promise.resolve({ ok: false, error: 'Adresse MAC invalide' })
  const bytes = hex.match(/../g)!.map((pair) => parseInt(pair, 16))

  const packet = Buffer.alloc(6 + 16 * 6, 0xff)
  for (let i = 0; i < 16; i++) Buffer.from(bytes).copy(packet, 6 + i * 6)

  return new Promise((resolve) => {
    const socket = createSocket('udp4')
    socket.once('error', (err) => {
      socket.close()
      resolve({ ok: false, error: err.message })
    })
    socket.bind(() => {
      socket.setBroadcast(true)
      socket.send(packet, 9, broadcast.trim() || '255.255.255.255', (err) => {
        socket.close()
        resolve(err ? { ok: false, error: err.message } : { ok: true })
      })
    })
  })
}
