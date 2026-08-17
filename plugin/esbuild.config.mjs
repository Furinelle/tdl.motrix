import * as esbuild from 'esbuild'

await esbuild.build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/plugin.js',
  bundle: true,
  format: 'esm',
  target: 'es2020',
  platform: 'neutral',
  external: ['motrix:plugin-api'],
  logLevel: 'info',
})
