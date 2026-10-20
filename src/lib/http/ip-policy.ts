/**
 * Which IP addresses an outbound request may connect to.
 *
 * Pure: no I/O, no DNS. Used by safeFetch both on every address a hostname
 * resolves to and on any host that is itself an IP literal.
 *
 * Two separate BlockLists, one per address family, on purpose: Node's
 * BlockList matches an IPv4 address against IPv6 rules that cover the
 * IPv4-mapped range (::ffff:0:0/96), so a single list containing that rule
 * would classify EVERY public IPv4 address as blocked. IPv4 is therefore only
 * ever checked against the IPv4 list and IPv6 only against the IPv6 list, and
 * IPv6 addresses that embed an IPv4 address (mapped, NAT64, 6to4, Teredo,
 * deprecated IPv4-compatible) are blocked as a whole rather than unwrapped.
 */
import net from 'node:net'

/** [network, prefix length]. Sources: IANA special-purpose address registries. */
const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], //        "this" network
  ['10.0.0.0', 8], //       private
  ['100.64.0.0', 10], //    carrier-grade NAT
  ['127.0.0.0', 8], //      loopback
  ['169.254.0.0', 16], //   link-local (cloud metadata lives at 169.254.169.254)
  ['172.16.0.0', 12], //    private
  ['192.0.0.0', 24], //     IETF protocol assignments
  ['192.0.2.0', 24], //     documentation (TEST-NET-1)
  ['192.88.99.0', 24], //   6to4 relay anycast (deprecated)
  ['192.168.0.0', 16], //   private
  ['198.18.0.0', 15], //    benchmarking
  ['198.51.100.0', 24], //  documentation (TEST-NET-2)
  ['203.0.113.0', 24], //   documentation (TEST-NET-3)
  ['224.0.0.0', 4], //      multicast
  ['240.0.0.0', 4], //      reserved, includes 255.255.255.255
]

const BLOCKED_V6: ReadonlyArray<readonly [string, number]> = [
  ['::', 96], //            unspecified, loopback and deprecated IPv4-compatible
  ['::ffff:0:0', 96], //    IPv4-mapped
  ['64:ff9b::', 96], //     NAT64
  ['64:ff9b:1::', 48], //   local-use NAT64
  ['100::', 64], //         discard-only
  ['2001::', 32], //        Teredo
  ['2001:2::', 48], //      benchmarking
  ['2001:db8::', 32], //    documentation
  ['2002::', 16], //        6to4
  ['3fff::', 20], //        documentation (RFC 9637)
  ['fc00::', 7], //         unique local
  ['fe80::', 10], //        link-local
  ['fec0::', 10], //        site-local (deprecated)
  ['ff00::', 8], //         multicast
]

const v4 = new net.BlockList()
for (const [network, prefix] of BLOCKED_V4) v4.addSubnet(network, prefix, 'ipv4')
const v6 = new net.BlockList()
for (const [network, prefix] of BLOCKED_V6) v6.addSubnet(network, prefix, 'ipv6')

export type AddressVerdict =
  | { allowed: true }
  | { allowed: false; reason: 'not_an_ip' | 'zone_id' | 'reserved_ipv4' | 'reserved_ipv6' }

/** Classify one literal IP address (as returned by a resolver). */
export function classifyAddress(address: string): AddressVerdict {
  if (address.includes('%')) return { allowed: false, reason: 'zone_id' }
  const family = net.isIP(address)
  if (family === 4) {
    return v4.check(address, 'ipv4') ? { allowed: false, reason: 'reserved_ipv4' } : { allowed: true }
  }
  if (family === 6) {
    return v6.check(address, 'ipv6') ? { allowed: false, reason: 'reserved_ipv6' } : { allowed: true }
  }
  return { allowed: false, reason: 'not_an_ip' }
}

export function isPublicAddress(address: string): boolean {
  return classifyAddress(address).allowed
}
