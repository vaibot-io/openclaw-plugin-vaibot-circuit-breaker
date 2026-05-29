import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Guards the vendored copy of the credential resolver. @vaibot/shared is private
// and this plugin ships unbundled, so src/creds.{mjs,d.mts} are verbatim copies
// of packages/shared/src. This fails if a copy drifts from the canonical source.

const here = dirname(fileURLToPath(import.meta.url)) // packages/openclaw-…/src
const sharedSrc = join(here, '..', '..', 'shared', 'src')

describe('vendored creds parity', () => {
  test('creds.mjs is byte-identical to @vaibot/shared source', () => {
    expect(readFileSync(join(here, 'creds.mjs'), 'utf-8')).toBe(
      readFileSync(join(sharedSrc, 'creds.mjs'), 'utf-8'),
    )
  })

  test('creds.d.mts is byte-identical to @vaibot/shared source', () => {
    expect(readFileSync(join(here, 'creds.d.mts'), 'utf-8')).toBe(
      readFileSync(join(sharedSrc, 'creds.d.mts'), 'utf-8'),
    )
  })
})
