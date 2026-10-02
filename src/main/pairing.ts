import { createHmac, randomBytes, timingSafeEqual } from 'crypto'

/**
 * How a phone proves to the remote-control hub that it belongs to its owner. The PC makes a random pairing
 * code once and shows it in the settings; the phone is given the code by typing it. After that the phone never
 * sends the code: it answers a fresh challenge with a keyed hash, so someone watching the network learns
 * nothing they could reuse, and a PC that is not the right one learns nothing either.
 */

/** No I, O, 0 or 1: nobody should have to guess which one is on the screen. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const CODE_LENGTH = 10

/** A new random code (10 characters of 32, about 50 bits). */
export function generateCode(random: (size: number) => Buffer = randomBytes): string {
  const bytes = random(CODE_LENGTH)
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]
  return code
}

/** "ABCDEFGHJK" as shown to the user: "ABCDE-FGHJK". */
export function formatCode(code: string): string {
  return `${code.slice(0, CODE_LENGTH / 2)}-${code.slice(CODE_LENGTH / 2)}`
}

/** What was typed, reduced to the code's own alphabet: case, spaces and dashes don't matter. */
export function normalizeCode(input: string): string {
  return [...input.toUpperCase()].filter((ch) => CODE_ALPHABET.includes(ch)).join('')
}

/** The answer to a challenge: HMAC-SHA256 keyed with the code over the nonce and the asking device's id. */
export function proofFor(code: string, nonce: string, deviceId: string): string {
  return createHmac('sha256', code).update(`${nonce}|${deviceId}`).digest('hex')
}

export function proofMatches(code: string, nonce: string, deviceId: string, proof: unknown): boolean {
  if (typeof proof !== 'string') return false
  const expected = Buffer.from(proofFor(code, nonce, deviceId))
  const given = Buffer.from(proof)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

export function newNonce(): string {
  return randomBytes(16).toString('hex')
}

export function newHubId(): string {
  return randomBytes(12).toString('hex')
}

/** Home-network addresses only: private ranges, link-local and loopback. Anything else is the internet. */
export function isPrivateAddress(address: string | undefined): boolean {
  if (!address) return false
  let ip = address.toLowerCase()
  if (ip.startsWith('::ffff:')) ip = ip.slice(7)
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
  }
  if (ip === '::1') return true
  return /^f[cd][0-9a-f]{2}:/.test(ip) || /^fe[89ab][0-9a-f]:/.test(ip)
}

/**
 * Keeps someone from guessing the code: after too many wrong proofs from one address, that address is
 * ignored for a while. A right proof clears its record.
 */
export class AttemptLimiter {
  private records = new Map<string, { failures: number; since: number; blockedUntil: number }>()

  constructor(
    private readonly maxFailures = 5,
    private readonly windowMs = 10 * 60_000,
    private readonly blockMs = 10 * 60_000
  ) {}

  isBlocked(address: string, now = Date.now()): boolean {
    const record = this.records.get(address)
    return !!record && record.blockedUntil > now
  }

  recordFailure(address: string, now = Date.now()): void {
    let record = this.records.get(address)
    if (!record || now - record.since > this.windowMs) record = { failures: 0, since: now, blockedUntil: 0 }
    record.failures++
    if (record.failures >= this.maxFailures) record.blockedUntil = now + this.blockMs
    this.records.set(address, record)
  }

  recordSuccess(address: string): void {
    this.records.delete(address)
  }
}
