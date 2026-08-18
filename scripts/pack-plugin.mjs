import { spawnSync } from 'node:child_process'
import { mkdirSync, copyFileSync, existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugin')
const dist = join(pluginDir, 'dist')
const staging = join(dist, 'pack')
const out = join(dist, 'furina.tdl-0.1.3.moext')

const build = spawnSync('node', ['esbuild.config.mjs'], {
  cwd: pluginDir,
  stdio: 'inherit',
})
if (build.status !== 0) process.exit(build.status ?? 1)

rmSync(staging, { recursive: true, force: true })
mkdirSync(join(staging, 'dist'), { recursive: true })
mkdirSync(join(staging, 'locales'), { recursive: true })
copyFileSync(join(pluginDir, 'motrix-plugin.json'), join(staging, 'motrix-plugin.json'))
copyFileSync(join(dist, 'plugin.js'), join(staging, 'dist', 'plugin.js'))
copyFileSync(join(pluginDir, 'locales', 'en-US.json'), join(staging, 'locales', 'en-US.json'))
copyFileSync(join(pluginDir, 'locales', 'zh-CN.json'), join(staging, 'locales', 'zh-CN.json'))

if (existsSync(out)) rmSync(out)
const zip = spawnSync(
  'zip',
  ['-r', '-q', out, 'motrix-plugin.json', 'dist/plugin.js', 'locales'],
  { cwd: staging, stdio: 'inherit' }
)
if (zip.status !== 0) process.exit(zip.status ?? 1)
console.log(out)
