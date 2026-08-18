import { mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SETTINGS = join(homedir(), 'Library/Application Support/Motrix/settings.json')
export const TDL_SUBDIR = 'tg'

export function tdlSaveDirFromDefault(defaultSaveDir) {
  return join(String(defaultSaveDir || '').replace(/[/\\]+$/, '') || join(homedir(), 'Downloads', 'Motrix'), TDL_SUBDIR)
}

export function tdlSaveDir() {
  let root = join(homedir(), 'Downloads', 'Motrix')
  try {
    const raw = JSON.parse(readFileSync(SETTINGS, 'utf8'))
    if (typeof raw?.app?.defaultSaveDir === 'string' && raw.app.defaultSaveDir) {
      root = raw.app.defaultSaveDir
    }
  } catch {
    /* keep fallback */
  }
  const dir = tdlSaveDirFromDefault(root)
  mkdirSync(dir, { recursive: true })
  return dir
}
