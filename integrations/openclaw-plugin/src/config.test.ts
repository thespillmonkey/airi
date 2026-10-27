import { afterEach, describe, expect, it, vi } from 'vitest'

import { authenticate, readConfig } from './config'

afterEach(() => vi.unstubAllEnvs())

describe('credential configuration', () => {
  it('authenticates the configured principal without trusting a claimed principal ID', () => {
    vi.stubEnv('AIRI_TEST_A', 'a'.repeat(40))
    vi.stubEnv('AIRI_TEST_B', 'b'.repeat(40))
    const config = readConfig({ clients: [
      { principalId: 'person-a', tokenEnv: 'AIRI_TEST_A', agentIds: ['mitsuki'] },
      { principalId: 'person-b', tokenEnv: 'AIRI_TEST_B', agentIds: ['other'] },
    ] })
    expect(authenticate(config, 'b'.repeat(40)).principalId).toBe('person-b')
    expect(() => authenticate(config, 'not-a-credential')).toThrow('Authentication failed')
    vi.stubEnv('AIRI_TEST_B', 'c'.repeat(40))
    expect(() => authenticate(config, 'b'.repeat(40))).toThrow('Authentication failed')
    expect(authenticate(config, 'c'.repeat(40)).principalId).toBe('person-b')
  })

  it('rejects duplicate credentials and absent environment references', () => {
    vi.stubEnv('AIRI_TEST_A', 'a'.repeat(40))
    vi.stubEnv('AIRI_TEST_B', 'a'.repeat(40))
    expect(() => readConfig({ clients: [
      { principalId: 'person-a', tokenEnv: 'AIRI_TEST_A', agentIds: ['mitsuki'] },
      { principalId: 'person-b', tokenEnv: 'AIRI_TEST_B', agentIds: ['other'] },
    ] })).toThrow('different credentials')
    vi.stubEnv('AIRI_TEST_B', undefined)
    expect(() => readConfig({ clients: [{ principalId: 'person-b', tokenEnv: 'AIRI_TEST_B', agentIds: ['other'] }] })).toThrow('at least 32')
  })
})

describe('host-managed credentials', () => {
  it('accepts a materialized SecretRef without a new process environment', () => {
    const token = 'managed-fixture-token-'.repeat(3)
    const config = readConfig({ clients: [{ principalId: 'managed-person', token, agentIds: ['mitsuki'] }] })
    expect(authenticate(config, token).principalId).toBe('managed-person')
    expect(() => authenticate(config, 'unrelated-token')).toThrow('Authentication failed')
  })

  it('rejects unresolved references and ambiguous credential sources', () => {
    vi.stubEnv('AIRI_TEST_A', 'a'.repeat(40))
    expect(() => readConfig({ clients: [{ principalId: 'managed-person', token: { source: 'file', provider: 'airi-token', id: 'value' }, agentIds: ['mitsuki'] }] })).toThrow()
    expect(() => readConfig({ clients: [{ principalId: 'managed-person', token: 'a'.repeat(40), tokenEnv: 'AIRI_TEST_A', agentIds: ['mitsuki'] }] })).toThrow()
  })
})
