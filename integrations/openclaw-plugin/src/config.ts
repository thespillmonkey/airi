import process from 'node:process'

import { Buffer } from 'node:buffer'
import { createHash, timingSafeEqual } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { isAbsolute } from 'node:path'

import * as v from 'valibot'

const identity = {
  principalId: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
  agentIds: v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(128))), v.minLength(1)),
}
const clientSchema = v.union([
  v.strictObject({ ...identity, tokenEnv: v.pipe(v.string(), v.regex(/^[A-Z][A-Z0-9_]{0,127}$/)) }),
  v.strictObject({ ...identity, tokenFile: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)) }),
  // The host resolves manifest-declared SecretRefs before runtime registration. An unresolved object fails closed here.
  v.strictObject({ ...identity, token: v.pipe(v.string(), v.minLength(32), v.maxLength(4096)) }),
])

const configSchema = v.strictObject({
  clients: v.pipe(v.array(clientSchema), v.minLength(1), v.maxLength(128)),
  allowedOrigins: v.optional(v.array(v.string()), []),
})

/** Configuration identifies people through managed secrets or environment-backed credentials, not client-supplied identities. */
export type Config = v.InferOutput<typeof configSchema>

/** A principal owns all client and conversation identifiers authenticated with its credential. */
export type Principal = Config['clients'][number]

/** Open the exact private inode; never follow a final symlink or read an unbounded source. */
function readTokenFile(path: string): string {
  let descriptor: number | undefined
  try {
    if (!isAbsolute(path) || typeof process.getuid !== 'function' || !constants.O_NOFOLLOW)
      throw new Error('Unsupported protected credential file')
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = fstatSync(descriptor)
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || stat.size < 32 || stat.size > 4096)
      throw new Error('Invalid protected credential file')
    const bytes = Buffer.alloc(4097)
    let length = 0
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null)
      if (count === 0)
        break
      length += count
    }
    const source = bytes.subarray(0, length).toString('utf8')
    const token = source.replace(/\r?\n$/, '')
    if (length < 32 || length > 4096 || token.length < 32 || !Buffer.from(source).equals(bytes.subarray(0, length)))
      throw new Error('Invalid protected credential contents')
    return token
  }
  catch {
    throw new Error('AIRI protected credential file is unavailable or insecure. Use an owned regular file with mode 0600, one hard link, and 32 to 4096 bytes.')
  }
  finally {
    if (descriptor !== undefined)
      closeSync(descriptor)
  }
}

function credential(client: Principal): string | undefined {
  return 'token' in client ? client.token : 'tokenFile' in client ? readTokenFile(client.tokenFile) : process.env[client.tokenEnv]
}

/** Reject duplicate identities and absent credentials before the plugin accepts connections. */
export function readConfig(input: unknown): Config {
  const parsed = v.safeParse(configSchema, input)
  if (!parsed.success)
    throw new Error('Invalid AIRI client configuration or unresolved credential. Check the configured secret source.')
  // Snapshot a protected file only at load: rotation needs a plugin reload, preserving duplicate checks.
  const config: Config = { ...parsed.output, clients: parsed.output.clients.map(client => 'tokenFile' in client ? { principalId: client.principalId, agentIds: client.agentIds, token: readTokenFile(client.tokenFile) } : client) }
  const principalIds = new Set<string>()
  const credentials = new Set<string>()
  for (const client of config.clients) {
    if (principalIds.has(client.principalId))
      throw new Error('Duplicate AIRI principal ID')
    const token = credential(client)
    if (!token || token.length < 32)
      throw new Error('AIRI credential must contain at least 32 characters')
    const digest = createHash('sha256').update(token).digest('hex')
    if (credentials.has(digest))
      throw new Error('AIRI principals must use different credentials')
    principalIds.add(client.principalId)
    credentials.add(digest)
  }
  return config
}

/** Read environment credentials for each connection. Managed secrets change through a host secret refresh and plugin reload. */
export function authenticate(config: Config, token: string): Principal {
  const incoming = createHash('sha256').update(token).digest()
  let principal: Principal | undefined
  for (const client of config.clients) {
    const configured = credential(client)
    if (configured && timingSafeEqual(incoming, createHash('sha256').update(configured).digest()))
      principal = client
  }
  if (!principal)
    throw new Error('Authentication failed')
  return principal
}
