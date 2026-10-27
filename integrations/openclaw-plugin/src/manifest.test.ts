import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

// The real OpenClaw loader rejects runtime tool registration without this ownership declaration.
// This contract guards the host-discovered manifest fault independently of mocked agent dispatch.
describe('native plugin ownership manifest', () => {
  it('declares the exact optional presentation tool before the Gateway registers it', () => {
    const manifest = JSON.parse(readFileSync(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'))
    expect(manifest.id).toBe('airi')
    expect(manifest.channels).toEqual(['airi'])
    expect(manifest.contracts.tools).toEqual(['airi_presentation'])
    expect(manifest.toolMetadata.airi_presentation.optional).toBe(true)
    expect(manifest.configContracts.secretInputs.paths).toEqual([{ path: 'clients.*.token', expected: 'string' }])
  })
})
