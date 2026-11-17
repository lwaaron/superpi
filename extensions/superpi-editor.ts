/**
 * superpi-editor —— pi 命令行会话窗口（TUI）的输入框增强。
 *
 * 装法：`node tools/install-pi-extension.mjs --install`
 * （把本文件复制到 ~/.pi/agent/extensions/，pi 重启会话后自动加载）
 *
 * ---------------------------------------------------------------------------
 * 为什么需要它（pi 1.5.2 实测）
 *
 * 1. **剪贴板里的文件贴不进来**。pi 的 Ctrl+V 走 handleClipboardPaste：
 *    filePaths → 图片 → 文本。读文件列表用的是 pi-tui 的 native `getFilePaths()`，
 *    而 Windows 的 native 模块只实现了 getText / setText / getImage —— 没有 getFilePaths
 *    （macOS 才有）。于是「资源管理器里复制一张图 → Ctrl+V」三档全空，什么都没发生。
 *
 * 2. **输入框没有选区**。pi-tui 的 Editor 没有选区模型：Ctrl+A 是「移到行首」，
 *    Ctrl+C 被 pi 的 app.clear 吃掉去清空输入框（这就是「按 Ctrl+C 内容消失」），
 *    Ctrl+X 无绑定，选中后 Backspace 只删一个字符。
 *
 * ---------------------------------------------------------------------------
 * 做法：**不动 pi 的任何文件**，只用 pi 公开的扩展 API
 *   - `ctx.ui.setEditorComponent()` 换输入框（官方 modal-editor.ts 同款做法）
 *   - 继承 `CustomEditor`，pi 会自动把 onSubmit / onChange / actionHandlers 接过来
 *
 * 键位（对齐 Windows 输入框的肌肉记忆）
 *   Ctrl+A                   全选（Home 仍是行首）
 *   Shift+←/→/↑/↓            扩/收选区
 *   Shift+Home / Shift+End   选到行首 / 行尾
 *   Ctrl+C                   复制（有选区复制选区，无选区复制全文；**都不清空内容**）
 *   Ctrl+X                   剪切（无选区 = 剪切全文）
 *   Backspace / Delete       删除选区
 *   可打印字符 / 粘贴        替换选区
 *   Esc                      只清选区，中断/取消仍归 pi
 *   Ctrl+V                   剪贴板里有**文件**就插入绝对路径（Windows 专用回落），
 *                            否则完全交回 pi（图片写临时文件、文本按原样插入）
 *
 * 刻意不做的事：不碰 Ctrl+C 之外的 pi 退出语义（空编辑器时 Ctrl+C 原样放行），
 * 不伪造 pi 没有的能力，不改 node_modules。
 */

import { CustomEditor } from '@earendil-works/pi-coding-agent'
import { getNativeClipboard, matchesKey, visibleWidth } from '@earendil-works/pi-tui'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 选区底色走反色：与 pi 的假光标同一套 SGR，终端不需要额外能力。 */
const SEL_OPEN = '\x1b[7m'
const SEL_CLOSE = '\x1b[27m'

/** 一次 Ctrl+V 里允许的 PowerShell 读取超时（ms）。慢机器上让位给 pi 自己的粘贴。 */
const FILE_LIST_TIMEOUT_MS = 1500

type Point = { line: number; col: number }
type Range = { start: Point; end: Point }

const CTRL_A = '\x01'
const CTRL_C = '\x03'
const CTRL_X = '\x18'
const ESC = '\x1b'

export class SuperPiEditor extends CustomEditor {
  /** 选区锚点；null = 没有选区。焦点就是编辑器光标。 */
  private selAnchor: Point | null = null
  /** 正在异步读剪贴板文件列表，避免连按 Ctrl+V 叠多次 PowerShell。 */
  private pasteInFlight = false

  /* ------------------------------------------------------------ 输入入口 */

  handleInput(data: string): void {
    if (typeof data !== 'string' || data === '') return
    try {
      if (this.handleSelectionKeys(data)) return
    } catch {
      // 选区逻辑出任何意外都退回 pi 的原始处理，绝不把输入吞掉。
      this.selAnchor = null
    }
    super.handleInput(data)
  }

  /** 返回 true 表示本函数已消费该按键。 */
  private handleSelectionKeys(data: string): boolean {
    // Ctrl+V：文件路径优先。命中就自己插，否则原样交回 pi（图片/文本粘贴）。
    if (this.isPasteKey(data)) {
      if (this.pasteInFlight) return true
      const text = this.getExpandedTextSync()
      // 剪贴板里既没有文本也没有图片时才去问文件列表：
      // 复制文本/截图是最常见的两种，不该为它们各付一次 PowerShell 启动成
      // 本。判断用异步，不阻塞渲染。
      void this.tryPasteFilePaths()
      void text
      return true
    }

    // 括号内粘贴：先按选区语义删掉选中内容，再交给 pi 插入。
    if (data.includes('\x1b[200~')) {
      if (this.hasSelection()) this.deleteSelection()
      return false
    }

    // 自动补全菜单打开时，方向键 / Tab / Enter 属于菜单，一律放行。
    if (typeof this.isShowingAutocomplete === 'function' && this.isShowingAutocomplete()) return false

    // Esc 只清选区，其余归 pi（中断、取消补全）。
    if (data === ESC) {
      if (this.hasSelection()) this.selAnchor = null
      return false
    }

    // Ctrl+A 全选（覆盖 pi 的 cursorLineStart；Home 单独保留行首语义）。
    if (data === CTRL_A) {
      this.selectAll()
      return true
    }

    if (data === CTRL_C) return this.copyOrCut(false)
    if (data === CTRL_X) return this.copyOrCut(true)

    const hasSel = this.hasSelection()

    if (hasSel && (data === '\x7f' || data === '\x08' || data === '\x1b[3~' || matchesKey(data, 'shift+delete'))) {
      this.deleteSelection()
      this.selAnchor = null
      return true
    }

    const shiftMove = this.shiftMovement(data)
    if (shiftMove) {
      if (!hasSel) this.selAnchor = { line: this.state.cursorLine, col: this.state.cursorCol }
      shiftMove()
      return true
    }

    // 普通移动键会打断选区（同 Windows 输入框）：清掉后照常交给 pi。
    if (hasSel && this.isNavigationKey(data)) this.selAnchor = null

    // 可打印字符：先删选区再插入，否则新字会插在选区前面。
    if (hasSel && isPrintable(data)) {
      this.deleteSelection()
      this.selAnchor = null
      this.insertTextAtCursor(data)
      return true
    }

    return false
  }

  private isPasteKey(data: string): boolean {
    try {
      if (this.keybindings?.matches?.(data, 'app.clipboard.pasteImage')) return true
    } catch {
      /* 自定义键位读不到就退回默认 */
    }
    return matchesKey(data, 'ctrl+v') || matchesKey(data, 'alt+v')
  }

  private shiftMovement(data: string): (() => void) | null {
    const map: Array<[string, () => void]> = [
      ['shift+left', () => this.moveCursor(0, -1)],
      ['shift+right', () => this.moveCursor(0, 1)],
      ['shift+up', () => this.moveCursor(-1, 0)],
      ['shift+down', () => this.moveCursor(1, 0)],
      ['shift+home', () => this.moveToLineStart()],
      ['shift+end', () => this.moveToLineEnd()],
    ]
    for (const [name, run] of map) if (matchesKey(data, name)) return run
    return null
  }

  private isNavigationKey(data: string): boolean {
    const names = [
      'left',
      'right',
      'up',
      'down',
      'home',
      'end',
      'alt+left',
      'alt+right',
      'ctrl+left',
      'ctrl+right',
      'pageup',
      'pagedown',
    ]
    return names.some(name => matchesKey(data, name))
  }

  /* -------------------------------------------------------------- 复制剪切 */

  private copyOrCut(cut: boolean): boolean {
    const hasSel = this.hasSelection()
    const full = this.getExpandedTextSync()
    // 空编辑器：不拦，让 pi 的 app.clear 照旧工作（两次 Ctrl+C 退出）。
    if (!hasSel && full === '') return false
    const text = hasSel ? this.selectionText() : full
    if (text === '') return false

    void writeClipboard(text)

    if (cut) {
      if (hasSel) {
        this.deleteSelection()
      } else {
        this.pushUndoSnapshot()
        this.setText('')
      }
      this.selAnchor = null
    }
    // 复制后保留选区与内容：用户可以接着按 Backspace / Delete 删掉它。
    this.tui?.requestRender?.()
    return true
  }

  private getExpandedTextSync(): string {
    try {
      return this.getExpandedText?.() ?? this.getText()
    } catch {
      return ''
    }
  }

  /* ---------------------------------------------------------------- 选区 */

  private focus(): Point {
    return { line: this.state.cursorLine, col: this.state.cursorCol }
  }

  private anchor(): Point | null {
    const anchor = this.selAnchor
    if (!anchor) return null
    const lines = this.state.lines ?? []
    if (anchor.line < 0 || anchor.line >= lines.length) return null
    if (anchor.col < 0 || anchor.col > (lines[anchor.line] ?? '').length) return null
    return anchor
  }

  private hasSelection(): boolean {
    const anchor = this.anchor()
    if (!anchor) return false
    const focus = this.focus()
    return anchor.line !== focus.line || anchor.col !== focus.col
  }

  /** 归一化选区：start 在前。行列都是 state.lines 里的 UTF-16 索引。 */
  selectionRange(): Range {
    const anchor = this.anchor()
    const focus = this.focus()
    if (!anchor) return { start: focus, end: focus }
    const anchorFirst = anchor.line < focus.line || (anchor.line === focus.line && anchor.col <= focus.col)
    return anchorFirst ? { start: anchor, end: focus } : { start: focus, end: anchor }
  }

  selectionText(): string {
    const { start, end } = this.selectionRange()
    const lines = this.state.lines ?? []
    if (start.line === end.line) return (lines[start.line] ?? '').slice(start.col, end.col)
    const parts = [(lines[start.line] ?? '').slice(start.col)]
    for (let i = start.line + 1; i < end.line; i += 1) parts.push(lines[i] ?? '')
    parts.push((lines[end.line] ?? '').slice(0, end.col))
    return parts.join('\n')
  }

  private selectAll(): void {
    const lines = this.state.lines ?? []
    if (lines.length === 0) return
    const lastLine = lines.length - 1
    const lastCol = (lines[lastLine] ?? '').length
    if (lastLine === 0 && lastCol === 0) return
    this.selAnchor = { line: 0, col: 0 }
    this.state.cursorLine = lastLine
    this.setCursorCol(lastCol)
    this.lastAction = null
    this.tui?.requestRender?.()
  }

  /** 直接改 state.lines，不走 setText —— 避免把粘贴标记（[paste #1 …]）整份冲掉。 */
  private deleteSelection(): void {
    const { start, end } = this.selectionRange()
    const lines = this.state.lines ?? []
    if (lines.length === 0) return
    const head = (lines[start.line] ?? '').slice(0, start.col)
    const tail = (lines[end.line] ?? '').slice(end.col)
    this.cancelAutocomplete()
    this.pushUndoSnapshot()
    this.state.lines = [...lines.slice(0, start.line), head + tail, ...lines.slice(end.line + 1)]
    this.state.cursorLine = start.line
    this.setCursorCol(start.col)
    this.lastAction = null
    this.exitHistoryBrowsing?.()
    this.invalidate?.()
    this.onChange?.(this.getText())
  }

  /* -------------------------------------------------------------- 渲染 */

  render(width: number): string[] {
    const lines = super.render(width)
    try {
      if (!this.anchor()) return lines
      return paintSelection(this, lines, width)
    } catch {
      return lines
    }
  }

  handleMouse(event: any): any {
    // 鼠标点击（含拖选后的合成 click）会重置光标：先丢掉键盘选区，避免两套选区打架。
    if (event && (event.type === 'press' || event.type === 'click')) this.selAnchor = null
    return super.handleMouse(event)
  }

  /* ---------------------------------------------------------- Ctrl+V 文件 */

  /**
   * 剪贴板里有**文件**（资源管理器复制、Snipaste 之类）时插入绝对路径。
   *
   * 顺序刻意如此，为了让最常见的两种粘贴零额外开销：
   *   有文本 → 直接交回 pi（pi 自己插文本）
   *   有图片 → 直接交回 pi（pi 写 %TEMP%\pi-clipboard-*.png 并插路径）
   *   两者都没有 → 才去问 Windows 的文件拖放列表（PowerShell，约 200ms，异步）
   */
  private async tryPasteFilePaths(): Promise<void> {
    if (this.pasteInFlight) return
    this.pasteInFlight = true
    try {
      const clipboard = await Promise.resolve(getNativeClipboard?.()).catch(() => null)
      const text = clipboard?.getText ? await Promise.resolve(clipboard.getText()).catch(() => null) : null
      if (text) {
        this.onPasteImage?.()
        return
      }
      const image = clipboard?.getImage ? await Promise.resolve(clipboard.getImage()).catch(() => null) : null
      if (image && image.length > 0) {
        this.onPasteImage?.()
        return
      }
      const files = await readWindowsFileDropList()
      if (!files || files.length === 0) {
        // 也没有图片/文本/文件 —— 交回 pi，行为与不打这个扩展时一致。
        this.onPasteImage?.()
        return
      }
      if (files.some(file => /\p{Cc}/u.test(file))) return
      this.insertFilePaths(files)
    } catch {
      this.onPasteImage?.()
    } finally {
      this.pasteInFlight = false
    }
  }

  /** 与 pi 的 handleClipboardPaste 同一套插入语义（bash 模式用引号+空格，否则每行一条）。 */
  private insertFilePaths(files: string[]): void {
    const bashMode = this.getText().trimStart().startsWith('!')
    const payload = bashMode ? files.map(quoteIfNeeded).join(' ') : files.join('\n')
    const cursor = this.getCursor?.()
    const line = cursor ? (this.getText().split('\n')[cursor.line] ?? '') : ''
    const before = cursor && cursor.col > 0 ? line[cursor.col - 1] : ''
    const after = cursor ? line[cursor.col] : ''
    const leading = before && !/\s/.test(before) ? ' ' : ''
    const trailing = after && !/\s/.test(after) ? ' ' : ''
    this.insertTextAtCursor(`${leading}${payload}${trailing}`)
    this.tui?.requestRender?.()
  }
}

/* ------------------------------------------------------------------ 渲染实现 */

/**
 * 给已渲染的行加选区底色。
 *
 * render() 每一行 = 左边距 + displayText + 右填充 + 右边距，displayText 来自
 * layoutText()（光标字符被换成反色版本，宽度不变）。所以只要知道「这条视觉行对应
 * 逻辑行的哪段字符」，就能算出选区在该行的显示列区间，再按可见列插 SGR。
 * 视觉行与字符区间的对应关系来自 buildVisualLineMap()：它与 layoutText() 用同一套
 * word-wrap，行数一一对应。
 */
function paintSelection(editor: SuperPiEditor, rendered: string[], width: number): string[] {
  const { start, end } = editor.selectionRange()
  if (start.line === end.line && start.col === end.col) return rendered
  const layoutWidth = (editor as any).lastWidth
  if (!Number.isFinite(layoutWidth) || layoutWidth <= 0) return rendered
  const paddingX = Math.min((editor as any).paddingX ?? 0, Math.max(0, Math.floor((width - 1) / 2)))
  const visualLines: Array<{ logicalLine: number; startCol: number; length: number }> =
    (editor as any).buildVisualLineMap?.(layoutWidth) ?? []
  if (!Array.isArray(visualLines) || visualLines.length === 0) return rendered
  const lines: string[] = (editor as any).state?.lines ?? []
  const scrollOffset = (editor as any).scrollOffset ?? 0
  const visibleCount = (editor as any).renderedVisibleLineCount ?? Math.max(0, rendered.length - 2)
  const cursorLine = (editor as any).state?.cursorLine ?? 0
  const cursorCol = (editor as any).state?.cursorCol ?? 0
  const out = rendered.slice()
  for (let i = 0; i < visibleCount; i += 1) {
    const rowIndex = i + 1 // 第 0 行是上边框
    if (rowIndex >= out.length) break
    const visual = visualLines[scrollOffset + i]
    if (!visual) continue
    const logical = visual.logicalLine
    if (logical < start.line || logical > end.line) continue
    const chunkStart = visual.startCol
    const chunkEnd = visual.startCol + visual.length
    const rowFrom = logical === start.line ? start.col : 0
    const rowTo = logical === end.line ? end.col : (lines[logical] ?? '').length
    const from = Math.max(rowFrom, chunkStart)
    const to = Math.min(rowTo, chunkEnd)
    if (to <= from) continue
    const chunkText = (lines[logical] ?? '').slice(chunkStart, chunkEnd)
    const relFrom = Math.max(0, Math.min(chunkText.length, from - chunkStart))
    const relTo = Math.max(relFrom, Math.min(chunkText.length, to - chunkStart))
    const colFrom = widthOf(chunkText.slice(0, relFrom))
    const colTo = colFrom + widthOf(chunkText.slice(relFrom, relTo))
    // 光标所在格跳过：反色叠反色会把光标变隐形。
    const cursorHere = logical === cursorLine && cursorCol >= from && cursorCol < to
    const skip = cursorHere ? paddingX + widthOf(chunkText.slice(0, Math.max(0, cursorCol - chunkStart))) : -1
    out[rowIndex] = paintColumns(out[rowIndex], paddingX + colFrom, paddingX + colTo, skip)
  }
  return out
}

/** 按可见列给 ANSI 字符串加反色；跳过已有 ANSI 序列，`skipColumn` 那一列不涂。 */
export function paintColumns(line: string, startCol: number, endCol: number, skipColumn = -1): string {
  if (typeof line !== 'string' || endCol <= startCol) return line
  let out = ''
  let visible = 0
  let open = false
  let i = 0
  while (i < line.length) {
    if (line[i] === '\x1b') {
      const stop = ansiEnd(line, i)
      out += line.slice(i, stop)
      i = stop
      continue
    }
    const cp = line.codePointAt(i) ?? 32
    const ch = String.fromCodePoint(cp)
    const w = charWidth(cp)
    const target = visible >= startCol && visible < endCol && visible !== skipColumn
    if (target && !open) {
      out += SEL_OPEN
      open = true
    } else if (!target && open) {
      out += SEL_CLOSE
      open = false
    }
    out += ch
    visible += w
    i += ch.length
  }
  if (open) out += SEL_CLOSE
  return out
}

function ansiEnd(line: string, start: number): number {
  const next = line[start + 1]
  if (next === '[') {
    let i = start + 2
    while (i < line.length) {
      const code = line.charCodeAt(i)
      if (code >= 0x40 && code <= 0x7e) return i + 1
      i += 1
    }
    return line.length
  }
  if (next === ']') {
    let i = start + 2
    while (i < line.length) {
      if (line[i] === '\x07') return i + 1
      if (line[i] === '\x1b' && line[i + 1] === '\\') return i + 2
      i += 1
    }
    return line.length
  }
  return Math.min(line.length, start + 2)
}

function widthOf(text: string): number {
  try {
    return visibleWidth(text)
  } catch {
    let total = 0
    for (const ch of text) total += charWidth(ch.codePointAt(0) ?? 0)
    return total
  }
}

function charWidth(cp: number): number {
  if (cp === 0) return 0
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0
  if (
    cp >= 0x1100 &&
    (cp <= 0x115f ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f9ff) ||
      (cp >= 0x20000 && cp <= 0x3fffd))
  ) {
    return 2
  }
  return 1
}

function isPrintable(data: string): boolean {
  if (data.length === 0 || data.includes('\x1b')) return false
  const cp = data.codePointAt(0)
  if (cp === undefined) return false
  if (cp < 32 || cp === 127) return false
  return data.length === (cp > 0xffff ? 2 : 1)
}

/** pi 的 quoteIfNeeded 同义：含空白或引号才用双引号包起来。 */
function quoteIfNeeded(value: string): string {
  if (value === '') return '""'
  if (/^[A-Za-z0-9_@%+=:,./\\:-]+$/.test(value) && !/[\s"]/u.test(value)) return value
  return `"${value.replaceAll('"', '\\"')}"`
}

/* ---------------------------------------------------------------- 剪贴板 */

/**
 * 读 Windows 的 CF_HDROP（文件拖放）剪贴板。
 *
 * 走 PowerShell 的 [Windows.Forms.Clipboard]::GetFileDropList()，输出 base64
 * （控制台代码页会把中文路径搞成乱码，所以不直接打印路径）。
 * 非 Windows、没有文件、超时、任何异常 → null，与上游 readClipboardFilePaths 的契约一致。
 */
export function readWindowsFileDropList(): Promise<string[] | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$list = [System.Windows.Forms.Clipboard]::GetFileDropList()',
    'if ($list -and $list.Count -gt 0) {',
    '  [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]::Join("`n", @($list))))',
    '}',
  ].join('; ')
  return new Promise(resolve => {
    let done = false
    const finish = (value: string[] | null) => {
      if (done) return
      done = true
      resolve(value)
    }
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: FILE_LIST_TIMEOUT_MS, windowsHide: true, maxBuffer: 1 << 20 },
      (error, stdout) => {
        if (error) return finish(null)
        finish(decodeListing(stdout))
      },
    )
    child.on('error', () => finish(null))
  })
}

/** base64 列表 → 路径数组；空、解码失败、含控制字符 → null。 */
export function decodeListing(stdout: string): string[] | null {
  const raw = typeof stdout === 'string' ? stdout.trim() : ''
  if (raw === '') return null
  let decoded = ''
  try {
    decoded = Buffer.from(raw, 'base64').toString('utf8')
  } catch {
    return null
  }
  const files = decoded
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '')
  if (files.length === 0) return null
  if (files.some(file => /\p{Cc}/u.test(file))) return null
  return files
}

/**
 * 写系统剪贴板：优先 pi-tui 的 native setText；回落 PowerShell 的 Set-Clipboard。
 * 回落时用临时文件传 UTF-8，因为 clip.exe 会按控制台代码页解码管道输入。
 * 全程异步、失败静默 —— 复制是副作用，不该卡住输入框。
 */
export function writeClipboard(text: string): Promise<boolean> {
  return (async () => {
    try {
      const clipboard = await Promise.resolve(getNativeClipboard?.()).catch(() => null)
      if (clipboard?.setText) {
        await Promise.resolve(clipboard.setText(text))
        return true
      }
    } catch {
      /* 继续试回落 */
    }
    return writeViaPowerShell(text)
  })().catch(() => false) as Promise<boolean>
}

function writeViaPowerShell(text: string): Promise<boolean> {
  return new Promise(resolve => {
    if (process.platform !== 'win32') return resolve(false)
    const file = path.join(os.tmpdir(), `superpi-clip-${process.pid}-${Date.now()}.txt`)
    try {
      fs.writeFileSync(file, text, { encoding: 'utf8' })
    } catch {
      return resolve(false)
    }
    const quoted = file.replace(/'/g, "''")
    const script = `Set-Clipboard -Value ([System.IO.File]::ReadAllText('${quoted}', [System.Text.Encoding]::UTF8))`
    const cleanup = () => {
      try {
        fs.unlinkSync(file)
      } catch {
        /* 临时文件可能已被清理 */
      }
    }
    try {
      const child = execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { timeout: 5000, windowsHide: true },
        error => {
          cleanup()
          resolve(!error)
        },
      )
      child.on('error', () => {
        cleanup()
        resolve(false)
      })
    } catch {
      cleanup()
      resolve(false)
    }
  })
}

/* -------------------------------------------------------------------- 注册 */

/**
 * 扩展入口。pi 在 session_start 之后才允许 setEditorComponent，
 * 所以在这里挂工厂；`pi.on('session_start')` 保证会话（含 /reload）都能盖上。
 */
export default function superpiEditor(pi: any): void {
  const apply = (ctx: any) => {
    try {
      ctx?.ui?.setEditorComponent?.((tui: any, theme: any, keybindings: any) => new SuperPiEditor(tui, theme, keybindings))
    } catch (error) {
      // 拿不到 UI（print/json 模式）或 API 变了 → 静默跳过，绝不让 pi 起不来。
      void error
    }
  }
  if (typeof pi?.on === 'function') {
    pi.on('session_start', (_event: any, ctx: any) => apply(ctx))
    pi.on('session_switch', (_event: any, ctx: any) => apply(ctx))
  }
}
