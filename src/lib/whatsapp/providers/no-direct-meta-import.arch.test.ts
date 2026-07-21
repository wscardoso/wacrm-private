import { describe, it, expect } from 'vitest'
import { promises as fs } from 'fs'
import { join, relative } from 'path'

const PROJECT_ROOT = join(__dirname, '..', '..', '..', '..')
const SRC_DIR = join(PROJECT_ROOT, 'src')

const ALLOWED_PATTERNS = [
  // D6 exemption: providers and delivery are the only authorized consumers.
  /\/providers\//,
  /\/delivery\//,
]

const KNOWN_VIOLATORS = [
  // All files outside providers/ and delivery/ that currently import meta-api
  // directly. As each messaging call-site is migrated, remove it from here.
  // Non-messaging routes and test files may remain — D6 targets messaging
  // call-sites, not every consumer.
  'app/api/whatsapp/config/route.ts',
  'app/api/whatsapp/config/verify-registration/route.ts',
  'app/api/whatsapp/media/[mediaId]/route.ts',
  'app/api/whatsapp/templates/submit/route.ts',
  'app/api/whatsapp/templates/[id]/route.ts',
  'app/api/whatsapp/webhook/route.ts',
  'lib/flows/validate.ts',
  'lib/whatsapp/meta-api.resumable.test.ts',
  'lib/whatsapp/registration.test.ts',
  'lib/whatsapp/template-header-handle.test.ts',
  'lib/whatsapp/template-header-handle.ts',
  'lib/whatsapp/template-lifecycle.test.ts',
]

describe('D6 — No direct import of concrete provider API', () => {
  it('no module outside providers/ and delivery/ imports from meta-api', async () => {
    const violating: string[] = []

    async function walk(dir: string) {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.next') {
          await walk(full)
        } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
          const rel = relative(SRC_DIR, full).replace(/\\/g, '/')
          const allowed = ALLOWED_PATTERNS.some((p) => p.test(rel))
          if (allowed) continue

          const content = await fs.readFile(full, 'utf-8')
          if (
            content.includes("from '@/lib/whatsapp/meta-api'") ||
            content.includes('from "../meta-api"') ||
            content.includes("from './meta-api'") ||
            content.includes("from '../../whatsapp/meta-api'")
          ) {
            violating.push(rel)
          }
        }
      }
    }

    await walk(SRC_DIR)

    const unknownViolators = violating.filter((v) => !KNOWN_VIOLATORS.includes(v))
    const knownStillViolating = violating.filter((v) => KNOWN_VIOLATORS.includes(v))

    if (unknownViolators.length > 0) {
      console.error('New D6 violations detected:', unknownViolators)
    }
    if (knownStillViolating.length > 0) {
      console.warn('Known D6 violations (not yet migrated):', knownStillViolating)
    }

    expect(unknownViolators).toEqual([])
  })

  it('all known violators are still listed (remove each when migrated)', async () => {
    for (const v of KNOWN_VIOLATORS) {
      const full = join(SRC_DIR, v)
      const exists = await fs.access(full).then(() => true).catch(() => false)
      expect(exists).toBe(true)
    }
  })
})
