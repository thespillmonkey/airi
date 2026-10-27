import process from 'node:process'

import { createHash, timingSafeEqual } from 'node:crypto'

import * as v from 'valibot'

const identity = {
  principalId: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
  agentIds: v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(128))), v.minLength(1)),
}
const clientSchema = v.union([
  v.strictObject({ ...identity, tokenEnv: v.pipe(v.string(), v.regex(/^[A-Z][A-Z0-9_]{0,127}$/)) }),
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

/** Reject duplicate identities and absent credentials before the plugin accepts connections. */
export function readConfig(input: unknown): Config {
  const parsed = v.safeParse(configSchema, input)
  if (!parsed.success)
    throw new Error('Invalid AIRI client configuration or unresolved credential. Check the configured secret source.')
  const config = parsed.output
  const principalIds = new Set<string>()
  const credentials = new Set<string>()
  for (const client of config.clients) {
    if (principalIds.has(client.principalId))
      throw new Error('Duplicate AIRI principal ID')
    const token = 'token' in client ? client.token : process.env[client.tokenEnv]
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
    const credential = 'token' in client ? client.token : process.env[client.tokenEnv]
    if (credential && timingSafeEqual(incoming, createHash('sha256').update(credential).digest()))
      principal = client
  }
  if (!principal)
    throw new Error('Authentication failed')
  return principal
}
