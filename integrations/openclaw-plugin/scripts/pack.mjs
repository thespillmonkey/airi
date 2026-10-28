import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Produce a standalone archive without unpublished workspace dependencies.
 *
 * Call stack:
 * npm run pack:standalone
 *   -> staging manifest and compiled assets
 *     -> npm pack
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const destination = mkdtempSync(join(tmpdir(), 'airi-openclaw-plugin-package-'))
console.info(`Standalone plugin staging: ${destination}`)
for (const file of ['dist', 'README.md', 'openclaw.plugin.json', 'LICENSE'])
  cpSync(join(root, file), join(destination, file), { recursive: true })
// The standalone bundle includes these libraries. Their original license text travels with the archive.
function dependencyLicense(name, from) {
  const require = createRequire(from)
  let directory = dirname(require.resolve(name))
  while (!existsSync(join(directory, 'package.json')) || JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).name !== name) {
    const parent = dirname(directory)
    if (parent === directory)
      throw new Error(`Cannot locate license owner for ${name}`)
    directory = parent
  }
  const metadata = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  const licensePath = ['LICENSE', 'LICENSE.md', 'LICENSE.txt'].map(file => join(directory, file)).find(file => existsSync(file))
  if (!licensePath)
    throw new Error(`Cannot locate license text for ${name}`)
  return { directory, text: `## ${name} ${metadata.version}\n\n${readFileSync(licensePath, 'utf8')}\n` }
}
const bridgeManifest = join(root, '../../packages/openclaw-bridge/package.json')
const eventa = dependencyLicense('@moeru/eventa', bridgeManifest)
const notices = [
  eventa,
  dependencyLicense('nanoid', join(eventa.directory, 'package.json')),
  dependencyLicense('valibot', join(root, 'package.json')),
  dependencyLicense('@valibot/to-json-schema', join(root, 'package.json')),
]
const attribution = '# Third-party notices\n\nThis plugin derives from Project AIRI and preserves its MIT license in `LICENSE`.\nThe standalone JavaScript bundle includes the libraries below.\nThe external `ws` dependency retains its own package license.\n\n'
writeFileSync(join(destination, 'THIRD-PARTY-NOTICES.md'), `${(attribution + notices.map(notice => notice.text).join('\n')).trimEnd()}\n`)
const source = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const runtime = {
  name: source.name,
  version: source.version,
  description: source.description,
  type: 'module',
  license: source.license,
  files: source.files,
  dependencies: { ws: '8.21.3' },
  peerDependencies: source.peerDependencies,
  peerDependenciesMeta: source.peerDependenciesMeta,
  openclaw: source.openclaw,
}
writeFileSync(join(destination, 'package.json'), `${JSON.stringify(runtime, null, 2)}\n`)
execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', root], { cwd: destination, stdio: 'inherit' })
