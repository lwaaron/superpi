/**
 * 把 pi 的 HTTP idle 超时抬到「长思考不会被误杀」的量级。
 *
 * ---------------------------------------------------------------------------
 * 为什么需要这一层（0.15.0）
 *
 * pi 的默认值是 `DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000`（`dist/core/http-dispatcher.d.ts:1`）。
 * 这个 300 秒是**连接静默**上限，不是总时长上限 —— 只要这段时间里没有收到任何字节，
 * 就会以 `Body Timeout Error (UND_ERR_BODY_TIMEOUT)` 中止。
 *
 * 而长思考恰恰会长时段**零字节**：模型在 `thinkingLevel: max` 下可能思考数分钟才吐出
 * 第一个 token。实测本机会话里 4 次 `BODY_TIMEOUT` 的「距上次产出间隔」分别是
 * **317s / 333s / 323s / 503s** —— 全部刚过 300 秒线，**没有一次与上下文规模相关**
 * （最浅的一次只有 7.3% 占用）。
 *
 * 换句话说：**用户越想让它想清楚，越容易被掐断。** 这是典型的「能力被机制误伤」，
 * 属于 docs/anti-product-patterns.md 的 A1 类。
 *
 * ---------------------------------------------------------------------------
 * 为什么不直接关掉（设成 0 / "disabled"）
 *
 * pi 支持 `httpIdleTimeoutMs: 0` 表示不设上限（`parseHttpIdleTimeoutMs` 返回 0，
 * `sdk.js:196` 把 0 映射成 `2147483647`）。但那是**换一种卡死**：
 * 上游真的失联时，请求会永远挂着，界面永久转圈、用户无从判断。
 *
 * 正确的做法是**把上限抬到明显大于最坏合法思考时长**，同时保留兜底能力：
 * 30 分钟既是「几乎不可能被正常思考撞到」的量级，又能在真故障时最终失败并报错。
 *
 * ---------------------------------------------------------------------------
 * 为什么不改 pi 的文件
 *
 * `httpIdleTimeoutMs` 是 pi **官方支持的设置项**（`settings-manager.js:713-722` 有 getter/setter，
 * 且 `main.js:765` 会用 `configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs())`
 * 在进入 `runRpcMode` 之前重新配置调度器）。所以这是**配置面**，不是补丁 ——
 * 符合 AGENTS.md §5「禁止给 pi 打补丁」的边界。
 *
 * ---------------------------------------------------------------------------
 * 三条不可退让的规则
 *
 * 1. **只抬不降**：用户设了更大的值（比如 1 小时）就保留，绝不覆盖成 30 分钟；
 * 2. **尊重显式关闭**：`0` / `"disabled"` 是用户的明确选择，原样保留；
 * 3. **坏文件不碰**：settings.json 解析失败时什么都不做，绝不能把用户的其它设置写没。
 */
import fs from 'node:fs'
import path from 'node:path'

/**
 * 下限：30 分钟。
 *
 * 依据：实测最坏合法静默是 503 秒（8.4 分钟）。取 30 分钟留了 3.5 倍余量，
 * 足以覆盖「max 档思考 + 大文件生成」的极端情况，同时仍是有限值。
 */
export const MIN_HTTP_IDLE_TIMEOUT_MS = 30 * 60 * 1000

/** pi 的默认值（文档用 + 门禁据此断言"我们确实抬高了"）。 */
export const PI_DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000

/**
 * 解析用户写的 `httpIdleTimeoutMs`，返回 `{ explicit: boolean, disabled: boolean, ms: number }`。
 *
 * 与 pi 的 `parseHttpIdleTimeoutMs`（`http-dispatcher.js:15-30`）同语义：
 * `"disabled"` 或 `0` → 关闭；非法值 → 当作未设置。
 * **这里刻意不复用 pi 的实现**：它不在公开导出面里，而扩展/host 不该依赖内部路径。
 */
export function parseIdleTimeoutSetting(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.toLowerCase() === 'disabled') return { explicit: true, disabled: true, ms: 0 }
    if (trimmed === '') return { explicit: false, disabled: false, ms: 0 }
    return parseIdleTimeoutSetting(Number(trimmed))
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return { explicit: false, disabled: false, ms: 0 }
  }
  const ms = Math.floor(value)
  return { explicit: true, disabled: ms === 0, ms }
}

/**
 * 给定当前设置，算出该写什么。纯函数，便于门禁覆盖全部分支。
 *
 * 策略边界（这里有一个必须说清的取舍）：
 *
 *   - **未设置** → 抬到下限。这是绝大多数情况（本机实测 `settings.json` 里根本没有这个键），
 *     而 pi 的默认 300s 会误杀长思考。补默认值是纯收益。
 *   - **显式设了非零值** → **一律尊重，不改**。哪怕它小于我们的下限。
 *     理由：显式配置是用户的明确意图，可能就是想「快点失败好重试」。
 *     我们无权替用户判定他错了 —— 「只抬不降」如果变成「小的也抬」，
 *     就成了 docs/anti-product-patterns.md 的 C5（用配置掩盖设计问题）。
 *   - **显式关闭（0 / disabled）** → 原样保留。
 *   - **坏值（非数字字符串等）** → 视为未设置（因为没有可尊重的有效意图）。
 *
 * @returns {{ action: 'skip'|'write'|'keep', ms: number, reason: string }}
 *   - `skip`  —— 不需要动（坏文件 / 关闭态 / 已达标 / 显式小值）
 *   - `write` —— 需要写入 `ms`
 *   - `keep`  —— 已明确且无需改动
 */
export function decideIdleTimeout(settings, { min = MIN_HTTP_IDLE_TIMEOUT_MS } = {}) {
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    return { action: 'skip', ms: 0, reason: 'settings 不是对象（坏文件），不碰' }
  }
  const current = parseIdleTimeoutSetting(settings.httpIdleTimeoutMs)
  if (current.disabled === true) {
    return { action: 'skip', ms: 0, reason: '用户显式关闭（0 / disabled），尊重选择' }
  }
  if (current.explicit === true) {
    // 显式配置一律尊重：不因"小于下限"去覆盖用户的明确意图。
    return { action: 'keep', ms: current.ms, reason: '用户已显式设置为 ' + String(current.ms) + 'ms，保持不动' }
  }
  return { action: 'write', ms: min, reason: '未设置（运行时默认 ' + String(PI_DEFAULT_HTTP_IDLE_TIMEOUT_MS) + 'ms 会误杀长思考）→ ' + String(min) }
}

/**
 * 在 pi 的 agent 目录里确保 `httpIdleTimeoutMs` 不低于下限。
 *
 * 幂等：已达标时**不写文件**（避免每次 spawn 都刷 mtime、触发 settings 重载）。
 * 容错：任何异常都吞掉并返回 `{ ok: false, reason }` —— 会话必须能起来，
 * 一个优化项不该成为前置条件。
 *
 * @param {{ agentDir: string }} options
 * @returns {{ ok: boolean, action: string, ms: number, reason: string, filePath: string }}
 */
export function ensureHttpIdleTimeout(options = {}) {
  const agentDir = typeof options.agentDir === 'string' ? options.agentDir : ''
  const min = Number.isFinite(options.min) ? options.min : MIN_HTTP_IDLE_TIMEOUT_MS
  const filePath = agentDir === '' ? '' : path.join(agentDir, 'settings.json')
  const empty = { ok: false, action: 'skip', ms: 0, reason: 'agentDir 未知', filePath }
  if (filePath === '') return empty

  let raw
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    // 文件不存在是常见情况（全新安装）：按空对象处理，直接建一个。
    if (error?.code !== 'ENOENT') return { ...empty, reason: '读不到设置文件：' + String(error?.message ?? error) }
    raw = '{}'
  }

  let settings
  try {
    settings = raw.trim() === '' ? {} : JSON.parse(raw)
  } catch {
    // 坏 JSON：**绝不覆盖**。用户手写坏了一个逗号，我们把它整个文件写没才是灾难。
    return { ...empty, reason: 'settings.json 不是合法 JSON，不动它' }
  }

  const decision = decideIdleTimeout(settings, { min })
  if (decision.action !== 'write') {
    return { ok: true, action: decision.action, ms: decision.ms, reason: decision.reason, filePath }
  }

  const next = { ...settings, httpIdleTimeoutMs: decision.ms }
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    // 原子落盘：先写 tmp 再 rename。中途崩掉不会留下半个 JSON。
    const tmp = filePath + '.' + String(process.pid) + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, filePath)
  } catch (error) {
    return { ...empty, reason: '写入失败：' + String(error?.message ?? error) }
  }
  return { ok: true, action: 'write', ms: decision.ms, reason: decision.reason, filePath }
}
