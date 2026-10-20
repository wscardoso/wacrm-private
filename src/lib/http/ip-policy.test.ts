import { describe, expect, it } from 'vitest'
import { classifyAddress, isPublicAddress } from './ip-policy'

// =============================================================
// Address policy. The tables are written by hand and deliberately NOT derived
// from the policy's own constants, so a wrong range cannot hide behind a
// test that repeats it. Both directions matter equally:
//   - a missing block is an SSRF hole;
//   - an over-broad block (for example IPv4-mapped IPv6 rules applied to IPv4)
//     takes every public destination offline.
// Each range has its first and last address inside and the neighbours outside.
// =============================================================

describe('IPv4: public addresses are allowed (including every range edge)', () => {
  it.each([
    '1.0.0.0', '1.1.1.1', '8.8.8.8', '9.255.255.255', '11.0.0.0', '93.184.216.34',
    '100.63.255.255', '100.128.0.0', '126.255.255.255', '128.0.0.0',
    '169.253.255.255', '169.255.0.0', '172.15.255.255', '172.32.0.0',
    '192.0.1.0', '192.0.3.0', '192.88.98.255', '192.88.100.0',
    '192.167.255.255', '192.169.0.0', '198.17.255.255', '198.20.0.0',
    '198.51.99.255', '198.51.101.0', '203.0.112.255', '203.0.114.0', '223.255.255.255',
  ])('%s', (ip) => {
    expect(classifyAddress(ip)).toEqual({ allowed: true })
    expect(isPublicAddress(ip)).toBe(true)
  })
})

describe('IPv4: reserved ranges are blocked (first and last address of each)', () => {
  it.each([
    '0.0.0.0', '0.255.255.255',
    '10.0.0.0', '10.255.255.255',
    '100.64.0.0', '100.127.255.255',
    '127.0.0.0', '127.0.0.1', '127.255.255.255',
    '169.254.0.0', '169.254.169.254', '169.254.255.255',
    '172.16.0.0', '172.31.255.255',
    '192.0.0.0', '192.0.0.255',
    '192.0.2.0', '192.0.2.255',
    '192.88.99.0', '192.88.99.255',
    '192.168.0.0', '192.168.255.255',
    '198.18.0.0', '198.19.255.255',
    '198.51.100.0', '198.51.100.255',
    '203.0.113.0', '203.0.113.255',
    '224.0.0.0', '239.255.255.255',
    '240.0.0.0', '255.255.255.255',
  ])('%s', (ip) => {
    expect(classifyAddress(ip)).toEqual({ allowed: false, reason: 'reserved_ipv4' })
    expect(isPublicAddress(ip)).toBe(false)
  })
})

describe('IPv6: public addresses are allowed', () => {
  it.each([
    '2606:4700:4700::1111', '2a00:1450:4001::200e', '2001:4860:4860::8888', '2400:cb00::1',
    '2001:1::1', // outside 2001::/32 (Teredo)
    '2001:3::1', // outside 2001:2::/48
    '2001:db9::1', // next to the documentation block
    '2003::1', // next to 6to4
    '2620:fe::fe',
    '3fff:1000::1', // outside 3fff::/20
  ])('%s', (ip) => {
    expect(classifyAddress(ip)).toEqual({ allowed: true })
  })
})

describe('IPv6: reserved ranges and every embedded-IPv4 form are blocked', () => {
  it.each([
    // unspecified, loopback, deprecated IPv4-compatible
    '::', '::1', '::2', '0:0:0:0:0:0:0:1', '::127.0.0.1', '::8.8.8.8',
    // IPv4-mapped, in every spelling (public mapped addresses are blocked too)
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:8.8.8.8',
    '0000:0000:0000:0000:0000:ffff:7f00:0001', '::ffff:0:0',
    // NAT64
    '64:ff9b::7f00:1', '64:ff9b::808:808', '64:ff9b:1::1',
    // discard, Teredo, benchmarking, documentation
    '100::1', '2001::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001:2::1',
    '2001:db8::1', '2001:db8:ffff::1', '3fff::1', '3fff:fff::1',
    // 6to4
    '2002:7f00:1::1', '2002:c0a8:101::1',
    // unique local, link-local, site-local, multicast
    'fc00::1', 'fd12:3456:789a::1', 'fdff:ffff::1',
    'fe80::1', 'febf::1', 'fec0::1', 'ff02::1', 'ffff::1',
  ])('%s', (ip) => {
    const verdict = classifyAddress(ip)
    expect(verdict.allowed, ip).toBe(false)
    expect(verdict).toMatchObject({ reason: 'reserved_ipv6' })
  })
})

describe('inputs that are not a plain address', () => {
  it('rejects zone identifiers', () => {
    expect(classifyAddress('fe80::1%eth0')).toEqual({ allowed: false, reason: 'zone_id' })
    expect(classifyAddress('2606:4700:4700::1111%1')).toEqual({ allowed: false, reason: 'zone_id' })
  })

  it.each(['', 'example.com', '999.1.1.1', '1.2.3', '1.2.3.4.5', '[::1]', ' 8.8.8.8', '8.8.8.8 ', '0x7f.0.0.1', '2130706433'])(
    'rejects %j as not an IP',
    (value) => {
      expect(classifyAddress(value)).toEqual({ allowed: false, reason: 'not_an_ip' })
    },
  )
})

describe('the two families never leak into each other', () => {
  it('a public IPv4 address is not caught by the IPv4-mapped IPv6 rule', () => {
    // Regression guard for the single-BlockList mistake: with ::ffff:0:0/96 in
    // the same list as the IPv4 rules, every IPv4 address matches it.
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '100.128.0.1']) {
      expect(isPublicAddress(ip), ip).toBe(true)
    }
  })

  it('the same public IPv4 address, written IPv4-mapped, is blocked', () => {
    expect(isPublicAddress('::ffff:8.8.8.8')).toBe(false)
    expect(isPublicAddress('::ffff:808:808')).toBe(false)
  })
})
