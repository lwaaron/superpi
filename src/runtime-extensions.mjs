import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

// Ordered by local imports, so these files can also be loaded from Pi's discovery directory.
export const EXTENSION_FILES = [
  ['text-bytes-module', 'superpi-text-bytes.mjs'],
  ['turn-verdict-module', 'superpi-turn-verdict.mjs'],
  ['editor', 'superpi-editor.ts'],
  ['text-integrity', 'superpi-text-integrity.ts'],
  ['rules-module', 'superpi-rules.mjs'],
  ['rules', 'superpi-rules.ts'],
  ['modalities-module', 'superpi-modalities.mjs'],
  ['context-guard-module', 'superpi-context-guard.mjs'],
  ['context-guard', 'superpi-context-guard.ts'],
  ['modalities', 'superpi-modalities.ts'],
  ['turn-recovery', 'superpi-turn-recovery.ts'],
].map(([label, name]) => ({ label, name, source: 'extensions/' + name }))

/** Match the selected Pi binary's config directory and application-specific environment variable. */
export function runtimeAgentDir({ packageDir, env = process.env, home = os.homedir(), cwd = process.cwd() } = {}) {
  let config
  if (packageDir) {
    try { config = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')).piConfig } catch { /* stock Pi */ }
  }
  const app = typeof config?.name === 'string' && config.name !== '' ? config.name.toUpperCase() : 'PI'
  const custom = env[app + '_CODING_AGENT_DIR']
  if (custom === '~') return home
  if (typeof custom === 'string' && custom !== '') {
    return /^[~][\\/]/.test(custom) ? path.join(home, custom.slice(2)) : path.resolve(cwd, custom)
  }
  return path.join(home, config?.configDir || '.pi', 'agent')
}

function readInstalled(file) {
  try { return fs.readFileSync(file) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

export function extensionFilesAt(root, dir) {
  return EXTENSION_FILES.map(entry => {
    const source = path.join(root, entry.source)
    const target = path.join(dir, entry.name)
    const from = readInstalled(source)
    const to = readInstalled(target)
    return {
      label: entry.label, source, target, sourceExists: from !== null, targetExists: to !== null,
      identical: from !== null && to !== null && from.equals(to),
    }
  })
}

export function syncExtensionFiles(root, dir) {
  const files = extensionFilesAt(root, dir)
  const missing = files.find(file => !file.sourceExists)
  if (missing) throw new Error('SuperPi extension missing from package: ' + missing.source)
  fs.mkdirSync(dir, { recursive: true })
  for (const file of files) {
    if (file.identical) continue
    if (file.targetExists) fs.copyFileSync(file.target, file.target + '.bak')
    const temp = path.join(dir, '.' + path.basename(file.target) + '.' + randomUUID() + '.tmp')
    try {
      fs.copyFileSync(file.source, temp)
      fs.renameSync(temp, file.target)
    } finally {
      fs.rmSync(temp, { force: true })
    }
  }
  return files
}

/** Use the same paths as TUI discovery. Pi deduplicates explicit and discovered paths. */
export function rpcExtensionArgs(root, agentDir) {
  return syncExtensionFiles(root, path.join(agentDir, 'extensions'))
    .filter(file => file.label !== 'editor' && file.target.endsWith('.ts'))
    .flatMap(file => ['--extension', file.target])
}
