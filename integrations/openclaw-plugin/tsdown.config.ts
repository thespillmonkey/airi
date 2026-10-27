import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  dts: true,
  external: [/^openclaw\//, 'ws'],
  noExternal: [/^(?:@proj-airi\/openclaw-bridge|@moeru\/eventa|valibot|@valibot\/to-json-schema)(?:\/|$)/],
})
