import type { ChannelType } from '../../shared/trust-contracts.ts'
import { AppProblem } from '../assistant/errors.ts'

// One canonical form per contact fact, so "Ravi.Kumar@Example.com " and
// "ravi.kumar@example.com" are the same address and a pasted link is reduced
// to its host before it is ever stored.

const EMAIL = /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,255}\.[a-z]{2,24}$/

export function normalizeName(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

export function normalizeEmail(value: string): string | null {
  const email = value.trim().toLowerCase()
  return email.length <= 320 && EMAIL.test(email) ? email : null
}

/** Digits only, without a leading US country code, so +1 (555) 010-0142 and 555-010-0142 match. */
export function normalizePhone(value: string): string | null {
  if (!/^[\d\s().+\-]{7,32}$/.test(value.trim())) return null
  let digits = value.replace(/\D/g, '')
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1)
  return digits.length >= 7 && digits.length <= 15 ? digits : null
}

/** A website is stored as its host only: no scheme, path, query or "www.". */
export function normalizeHost(value: string): string | null {
  const trimmed = value.trim().toLowerCase()
  if (!trimmed || trimmed.length > 2048 || /\s/.test(trimmed)) return null
  let host: string
  try { host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(trimmed) ? trimmed : 'https://' + trimmed).hostname } catch { return null }
  host = host.replace(/^www\./, '').replace(/\.$/, '')
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) && host.length <= 253 ? host : null
}

export function normalizeChannel(type: ChannelType, value: string): string {
  const normalized = type === 'email' ? normalizeEmail(value) : type === 'phone' ? normalizePhone(value) : normalizeHost(value)
  if (!normalized) {
    throw new AppProblem('invalid_input', type === 'email' ? 'That does not look like an email address.'
      : type === 'phone' ? 'That does not look like a phone number.' : 'That does not look like a website address.')
  }
  return normalized
}

/** `host` is `known` itself or one of its subdomains. "chase.com.evil.example" is neither. */
export function hostWithin(host: string, known: string): boolean {
  return host === known || host.endsWith('.' + known)
}

/** A hint that identifies a channel to its owner without disclosing it: used for anything that leaves this Mac. */
export function maskChannel(type: ChannelType, value: string): string {
  if (type === 'website') return value
  if (type === 'phone') return 'phone ending ' + value.slice(-2)
  const [local, domain] = value.split('@')
  return (local[0] ?? '') + '…@' + domain
}

export function formatPhone(digits: string): string {
  return digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : digits
}
