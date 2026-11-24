import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { BRAND_NAME, KEEP_CONFIG_DIR, readBrand } from '../extensions/superpi-brand.mjs'

const AGENT_DIR = '_CODING_AGENT_DIR'
const SESSION_DIR = '_CODING_AGENT_SESSION_DIR'
const BRAND_ENV_PREFIX = BRAND_NAME.toUpperCase()

// Ordered by local imports, so these files can also be loaded from Pi's discovery directory.
export const EXTENSION_FILES = [
  ['brand-module', 'superpi-brand.mjs'],
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
  ['ask-user', 'superpi-ask-user.ts'],
  ['verification', 'superpi-verification.mjs'],
  ['review', 'superpi-review.mjs'],
  ['delivery', 'superpi-delivery.ts'],
].map(([label, name]) => ({ label, name, source: 'extensions/' + name }))

/** Resolve SuperPi's paths and project them onto the variable names the selected CLI reads. */
export function runtimeSessionOptions({ packageDir, env = process.env, home = os.homedir(), cwd = process.cwd() } = {}) {
  let config
  if (packageDir) {
    try { config = readBrand(path.join(packageDir, 'package.json')) } catch { /* stock Pi */ }
  }
  const app = typeof config?.name === 'string' && config.name !== '' ? config.name.toUpperCase() : 'PI'
  const envOverrides = {}
  for (const suffix of [AGENT_DIR, SESSION_DIR]) {
    const value = env[BRAND_ENV_PREFIX + suffix] || env[app + suffix] || env['PI' + suffix]
    if (value) envOverrides[app + suffix] = value
  }
  const custom = envOverrides[app + AGENT_DIR]
  let agentDir = path.join(home, config?.configDir || KEEP_CONFIG_DIR, 'agent')
  if (custom === '~') agentDir = home
  else if (custom) agentDir = /^[~][\\/]/.test(custom) ? path.join(home, custom.slice(2)) : path.resolve(cwd, custom)
  return { agentDir, sessionDir: envOverrides[app + SESSION_DIR] ?? '', envOverrides }
}

export function runtimeAgentDir(options) {
  return runtimeSessionOptions(options).agentDir
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
