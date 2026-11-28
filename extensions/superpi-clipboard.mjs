import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

export const PANEL_CLIPBOARD_LIMIT = 128 * 1024 * 1024

const FORMAT_EXTENSIONS = new Map(Object.entries({
  png: '.png', bitmap: '.png', 'image/png': '.png',
  jpeg: '.jpg', jfif: '.jpg', 'image/jpeg': '.jpg',
  gif: '.gif', 'image/gif': '.gif', 'image/webp': '.webp', 'image/tiff': '.tif', 'image/bmp': '.bmp',
  waveaudio: '.wav', 'audio/wav': '.wav', 'audio/wave': '.wav', 'audio/x-wav': '.wav',
  'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/aac': '.aac', 'audio/flac': '.flac',
  'audio/ogg': '.ogg', 'audio/webm': '.webm', 'video/mp4': '.mp4', 'video/webm': '.webm',
  'video/quicktime': '.mov', 'video/x-msvideo': '.avi', 'application/pdf': '.pdf',
  'application/zip': '.zip', 'text/html': '.html', 'text/rtf': '.rtf',
}))

export function clipboardExtension(name, format) {
  const ext = path.extname(String(name ?? '')).toLowerCase()
  if (/^\.[a-z0-9]{1,16}$/.test(ext)) return ext
  return FORMAT_EXTENSIONS.get(String(format ?? '').split(';', 1)[0].trim().toLowerCase()) ?? '.bin'
}

/** Published paths are content-addressed. An interrupted copy is never returned as a file. */
export async function saveClipboardFile(source, { name, format, directory, limit = Infinity } = {}) {
  const dir = path.resolve(directory ?? path.join(os.homedir(), '.superpi', 'clipboard'))
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const staged = path.join(dir, `.${randomUUID()}.part`)
  const hash = createHash('sha256')
  let size = 0
  try {
    await pipeline(source, async function* (chunks) {
      for await (const chunk of chunks) {
        size += chunk.length
        if (size > limit) throw Object.assign(new Error('clipboard file exceeds the upload limit'), { statusCode: 413 })
        hash.update(chunk)
        yield chunk
      }
    }, createWriteStream(staged, { flags: 'wx', mode: 0o600 }))
    if (size === 0) throw Object.assign(new Error('clipboard file is empty'), { statusCode: 400 })
    const target = path.join(dir, hash.digest('hex') + clipboardExtension(name, format))
    if (await stat(target).then(entry => entry.isFile() && entry.size === size, () => false)) return target
    await rename(staged, target)
    return target
  } finally {
    await rm(staged, { force: true }).catch(() => {})
  }
}
