import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { BRAND_NAME, KEEP_CONFIG_DIR, readBrand } from '../extensions/superpi-brand.mjs'
import { SESSION_CONTROL_FILE } from '../extensions/superpi-session-controls.mjs'

const AGENT_DIR = '_CODING_AGENT_DIR'
const SESSION_DIR = '_CODING_AGENT_SESSION_DIR'
const BRAND_ENV_PREFIX = BRAND_NAME.toUpperCase()
const DEEPSEEK_CHAT_DEFAULTS = {
  supportsDeveloperRole: false,
  maxTokensField: 'max_tokens',
  requiresReasoningContentOnAssistantMessages: true,
  supportsStore: false,
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// Ordered by local imports, so these files can also be loaded from Pi's discovery directory.
export const EXTENSION_FILES = [
  ['brand-module', 'superpi-brand.mjs'],
  ['text-bytes-module', 'superpi-text-bytes.mjs'],
  ['turn-verdict-module', 'superpi-turn-verdict.mjs'],
  ['context-guard-module', 'superpi-context-guard.mjs'],
  ['clipboard-module', 'superpi-clipboard.mjs'],
  ['editor', 'superpi-editor.ts'],
  ['text-integrity', 'superpi-text-integrity.ts'],
  ['rules-module', 'superpi-rules.mjs'],
  ['rules', 'superpi-rules.ts'],
  ['modalities-module', 'superpi-modalities.mjs'],
  ['context-guard', 'superpi-context-guard.ts'],
  ['modalities', 'superpi-modalities.ts'],
  ['turn-recovery', 'superpi-turn-recovery.ts'],
  ['ask-user', 'superpi-ask-user.ts'],
  ['verification', 'superpi-verification.mjs'],
  ['review', 'superpi-review.mjs'],
  ['delivery', 'superpi-delivery.ts'],
  ['session-controls-protocol', 'superpi-session-controls.mjs'],
  ['session-controls', SESSION_CONTROL_FILE],
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

/** Complete explicitly declared DeepSeek Chat Completions settings before Pi loads the profile. */
export function prepareModelCompatibility(agentDir) {
  const file = path.join(agentDir, 'models.json')
  let temp
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile()) return { updated: 0, reason: 'models.json is not a regular file' }
    const source = fs.readFileSync(file)
    let document
    try { document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(source)) } catch {
      return { updated: 0, reason: 'models.json requires valid UTF-8 JSON' }
    }
    if (!isObject(document?.providers)) return { updated: 0 }
    let updated = 0
    for (const provider of Object.values(document.providers)) {
      if (!Array.isArray(provider?.models) || (provider.compat !== undefined && !isObject(provider.compat))) continue
      for (const model of provider.models) {
        if (!isObject(model) || (model.type !== undefined && model.type !== 'chat') ||
          (model.api ?? provider.api) !== 'openai-completions' || typeof model.id !== 'string' ||
          (model.compat !== undefined && !isObject(model.compat))) continue
        const override = provider.modelOverrides?.[model.id]?.compat
        if (override !== undefined && !isObject(override)) continue
        const effective = { ...provider.compat, ...model.compat, ...override }
        if (effective.thinkingFormat !== 'deepseek') continue
        const defaults = Object.entries(DEEPSEEK_CHAT_DEFAULTS).filter(([key]) => !Object.hasOwn(effective, key))
        if (defaults.length === 0) continue
        model.compat = { ...model.compat, ...Object.fromEntries(defaults) }
        updated += 1
      }
    }
    if (updated === 0) return { updated }
    temp = file + '.' + randomUUID() + '.tmp'
    fs.writeFileSync(temp, JSON.stringify(document, null, 2) + '\n', { flag: 'wx', mode: stat.mode & 0o777 })
    if (!fs.lstatSync(file).isFile() || !fs.readFileSync(file).equals(source)) {
      return { updated: 0, reason: 'models.json changed during preparation' }
    }
    fs.renameSync(temp, file)
    temp = undefined
    return { updated }
  } catch (error) {
    if (error?.code === 'ENOENT' && !temp) return { updated: 0 }
    return { updated: 0, reason: 'could not prepare models.json (' + (error?.code ?? 'error') + ')' }
  } finally {
    if (temp) try { fs.rmSync(temp, { force: true }) } catch { /* The model file is still the source of truth. */ }
  }
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
