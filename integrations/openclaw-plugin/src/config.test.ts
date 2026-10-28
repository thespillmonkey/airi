import { chmodSync, linkSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

describe('protected credential files', () => {
  function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'airi-private-token-test-'))
    const path = join(directory, 'credential')
    const token = 'protected-file-fixture-'.repeat(3)
    writeFileSync(path, token, { mode: 0o600 })
    return { path, token, directory, input: { clients: [{ principalId: 'file-person', tokenFile: path, agentIds: ['mitsuki'] }] } }
  }

  it('authenticates a private file snapshot without env mutation and rotates only on reload', () => {
    const f = fixture()
    const config = readConfig(f.input)
    expect(authenticate(config, f.token).principalId).toBe('file-person')
    const replacement = 'rotated-private-fixture-'.repeat(3)
    writeFileSync(f.path, replacement)
    expect(authenticate(config, f.token).principalId).toBe('file-person')
    expect(authenticate(readConfig(f.input), replacement).principalId).toBe('file-person')
  })

  it('accepts one terminal LF or CRLF without trimming other credential bytes', () => {
    const f = fixture()
    for (const newline of ['\n', '\r\n']) {
      writeFileSync(f.path, `${f.token}${newline}`)
      expect(authenticate(readConfig(f.input), f.token).principalId).toBe('file-person')
    }
    const spaced = ` ${f.token} `
    writeFileSync(f.path, spaced)
    expect(authenticate(readConfig(f.input), spaced).principalId).toBe('file-person')
    expect(() => authenticate(readConfig(f.input), spaced.trim())).toThrow('Authentication failed')
  })

  it('rejects symlinks, hard links, public permissions, directories, and oversized files with no source disclosure', () => {
    for (const kind of ['symlink', 'hardlink', 'public', 'directory', 'large']) {
      const f = fixture()
      let path = f.path
      if (kind === 'symlink') {
        path = join(f.directory, 'alias')
        symlinkSync(f.path, path)
      }
      if (kind === 'hardlink')
        linkSync(f.path, join(f.directory, 'second'))
      if (kind === 'public')
        chmodSync(f.path, 0o644)
      if (kind === 'directory') {
        path = join(f.directory, 'nested')
        mkdirSync(path, { mode: 0o600 })
      }
      if (kind === 'large')
        writeFileSync(f.path, 'x'.repeat(4097))
      expect(() => readConfig({ clients: [{ ...f.input.clients[0], tokenFile: path }] })).toThrow('unavailable or insecure')
      try {
        readConfig({ clients: [{ ...f.input.clients[0], tokenFile: path }] })
      }
      catch (error) {
        expect(String(error)).not.toContain(path)
        expect(String(error)).not.toContain(f.token)
      }
    }
  })

  it('rejects mixed credential sources and relative file paths', () => {
    const f = fixture()
    expect(() => readConfig({ clients: [{ ...f.input.clients[0], token: f.token }] })).toThrow()
    expect(() => readConfig({ clients: [{ ...f.input.clients[0], tokenFile: 'relative-token' }] })).toThrow('unavailable or insecure')
  })
})
