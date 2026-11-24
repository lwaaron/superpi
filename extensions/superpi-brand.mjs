import fs from 'node:fs'
import { randomUUID } from 'node:crypto'

export const BRAND_NAME = 'SuperPi'
export const KEEP_CONFIG_DIR = '.pi'

export function readBrand(pkgPath) {
  const { piConfig: config = {} } = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  const name = typeof config?.name === 'string' ? config.name : ''
  const configDir = typeof config?.configDir === 'string' ? config.configDir : ''
  return { path: pkgPath, name, configDir, branded: name === BRAND_NAME, configDirOk: (configDir || KEEP_CONFIG_DIR) === KEEP_CONFIG_DIR }
}

// Replace the manifest atomically so readers see valid JSON and pnpm hardlinks stay isolated.
function writeManifest(pkgPath, manifest, raw) {
  const indent = /\r?\n([\t ]+)"/.exec(raw)?.[1] ?? '  '
  const temp = pkgPath + '.' + randomUUID() + '.tmp'
  try {
    fs.writeFileSync(temp, JSON.stringify(manifest, null, indent) + '\n', { mode: fs.statSync(pkgPath).mode })
    fs.renameSync(temp, pkgPath)
  } finally {
    fs.rmSync(temp, { force: true })
  }
}

export function applyBrand(pkgPath, { brand = BRAND_NAME } = {}) {
  const raw = fs.readFileSync(pkgPath, 'utf8')
  const manifest = JSON.parse(raw)
  const config = manifest.piConfig ?? {}
  if (config.name === brand && config.configDir !== undefined) return { changed: false, reason: 'already branded' }
  // Pi derives a new data directory from its name unless configDir is set explicitly.
  manifest.piConfig = { configDir: KEEP_CONFIG_DIR, ...config, name: brand }
  writeManifest(pkgPath, manifest, raw)
  return { changed: true, reason: 'branded' }
}

export function revertBrand(pkgPath) {
  const raw = fs.readFileSync(pkgPath, 'utf8')
  const manifest = JSON.parse(raw)
  if (manifest.piConfig?.name === undefined) return { changed: false, reason: 'not branded' }
  delete manifest.piConfig.name
  writeManifest(pkgPath, manifest, raw)
  return { changed: true, reason: 'reverted' }
}
