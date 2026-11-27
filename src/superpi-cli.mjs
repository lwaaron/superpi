#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BRAND_NAME } from '../extensions/superpi-brand.mjs'
import { preparePiRuntime, resolvePiRuntime } from './pi-runtime.mjs'
import { prepareModelCompatibility, runtimeSessionOptions, syncExtensionFiles } from './runtime-extensions.mjs'

const pluginRoot = fileURLToPath(new URL('../', import.meta.url))
const runtime = resolvePiRuntime({ pluginRoot })

if (runtime.cliPath === '') {
  console.error(BRAND_NAME + ' runtime not found. Install it or set SUPERPI_CLI_PATH.')
  process.exitCode = 1
} else {
  try { preparePiRuntime(runtime) } catch (error) {
    console.warn(BRAND_NAME + ' could not configure the CLI name: ' + String(error?.message ?? error))
  }
  const { agentDir, envOverrides } = runtimeSessionOptions({ packageDir: runtime.packageDir })
  Object.assign(process.env, envOverrides)

  // The Windows launcher uses this when the caller explicitly skips installation.
  const skipSync = process.argv[2] === '--superpi-skip-extension-sync'
  if (skipSync) process.argv.splice(2, 1)
  const separator = process.argv.indexOf('--', 2)
  const flags = process.argv.slice(2, separator === -1 ? undefined : separator)
  const metadataOnly = flags.some(flag => ['--help', '-h', '--version', '-v'].includes(flag))
  if (!metadataOnly) {
    const compatibility = prepareModelCompatibility(agentDir)
    if (compatibility.reason) console.warn(BRAND_NAME + ' could not prepare model compatibility: ' + compatibility.reason)
  }
  if (!skipSync && !metadataOnly && !flags.some(flag => ['--no-extensions', '-ne'].includes(flag))) {
    try { syncExtensionFiles(pluginRoot, path.join(agentDir, 'extensions')) } catch (error) {
      console.warn(BRAND_NAME + ' could not sync extensions: ' + String(error?.message ?? error))
    }
  }

  process.argv[1] = runtime.cliPath
  await import(pathToFileURL(runtime.cliPath).href)
}
