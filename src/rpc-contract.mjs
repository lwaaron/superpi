/**
 * src/rpc-contract.mjs — superpi 与 pi 命令行的对齐契约（机器可读）
 *
 * 为什么存在这个文件：
 * pi 有两种前端（TUI 与 RPC）。TUI 里 27 条内置斜杠命令是在前端自己实现的
 * （packages/coding-agent/src/modes/interactive/interactive-mode.ts:3325-3470 的
 * setupEditorSubmitHandler 巨型 if 链），RPC 模式（modes/rpc/rpc-mode.ts）里
 * 一条都没有。所以 superpi 面板只要漏实现一条，那条命令就会被当成普通文本发给
 * 模型 —— 语义直接跑偏（最典型：/compact）。
 *
 * 因此这里把三方事实固化成数据：
 *   1. RPC_COMMANDS —— pi RPC 的 33 条 stdin 命令及其必填/可选参数
 *   2. RPC_EVENTS   —— AgentSessionEvent + AssistantMessageEvent 全联合
 *   3. TUI_COMMANDS —— TUI 的 27 条内置斜杠命令，每条标注对齐处置方式
 *   4. BASH_SHORTCUTS —— "!" / "!!" 的语义
 *   5. classifyInput() —— 输入分类器（面板与测试共用同一份判定逻辑）
 *
 * 修改规则（见 AGENTS.md）：pi 升级后本文件必须先更新，否则 test/parity.mjs 会红。
 * 权威来源是 pi 源码，不是这份文件的注释。
 */

/** pi 版本，仅作记录；真正的对齐校验由 test/parity.mjs 读 pi 源码完成。 */
export const PI_VERSION = '1.5.2';

/**
 * pi RPC 的 33 条命令。
 * required / optional 列出协议字段（不含通用的 id 与 type）。
 * category 只用于 UI 分组。
 */
export const RPC_COMMANDS = [
  { name: 'prompt', category: 'prompt', required: ['message'], optional: ['images', 'streamingBehavior'] },
  { name: 'steer', category: 'prompt', required: ['message'], optional: ['images'] },
  { name: 'follow_up', category: 'prompt', required: ['message'], optional: ['images'] },
  { name: 'abort', category: 'prompt', required: [], optional: [] },
  { name: 'clear_queue', category: 'prompt', required: [], optional: [] },
  { name: 'new_session', category: 'session', required: [], optional: ['parentSession'] },
  { name: 'get_state', category: 'state', required: [], optional: [] },
  { name: 'set_model', category: 'model', required: ['provider', 'modelId'], optional: [] },
  { name: 'cycle_model', category: 'model', required: [], optional: [] },
  { name: 'get_available_models', category: 'model', required: [], optional: [] },
  { name: 'set_thinking_level', category: 'thinking', required: ['level'], optional: [] },
  { name: 'cycle_thinking_level', category: 'thinking', required: [], optional: [] },
  { name: 'get_available_thinking_levels', category: 'thinking', required: [], optional: [] },
  { name: 'set_steering_mode', category: 'queue', required: ['mode'], optional: [] },
  { name: 'set_follow_up_mode', category: 'queue', required: ['mode'], optional: [] },
  { name: 'compact', category: 'compaction', required: [], optional: ['customInstructions'] },
  { name: 'set_auto_compaction', category: 'compaction', required: ['enabled'], optional: [] },
  { name: 'set_auto_retry', category: 'retry', required: ['enabled'], optional: [] },
  { name: 'abort_retry', category: 'retry', required: [], optional: [] },
  { name: 'bash', category: 'bash', required: ['command'], optional: ['excludeFromContext'] },
  { name: 'abort_bash', category: 'bash', required: [], optional: [] },
  { name: 'get_session_stats', category: 'session', required: [], optional: [] },
  { name: 'export_html', category: 'session', required: [], optional: ['outputPath'] },
  { name: 'switch_session', category: 'session', required: ['sessionPath'], optional: [] },
  { name: 'fork', category: 'session', required: ['entryId'], optional: [] },
  { name: 'clone', category: 'session', required: [], optional: [] },
  { name: 'get_fork_messages', category: 'session', required: [], optional: [] },
  { name: 'get_entries', category: 'session', required: [], optional: ['since'] },
  { name: 'get_tree', category: 'session', required: [], optional: [] },
  { name: 'get_last_assistant_text', category: 'session', required: [], optional: [] },
  { name: 'set_session_name', category: 'session', required: ['name'], optional: [] },
  { name: 'get_messages', category: 'session', required: [], optional: [] },
  { name: 'get_commands', category: 'commands', required: [], optional: [] },
];

export const RPC_COMMAND_NAMES = RPC_COMMANDS.map((command) => command.name);

/**
 * pi 出站事件全联合（25 类真实事件）。
 *
 * 三个来源：
 *   agent    packages/agent/src/types.ts:528-551（AgentEvent）
 *   session  packages/coding-agent/src/core/agent-session.ts:220-261（AgentSessionEvent）
 *   rpc      packages/coding-agent/src/modes/rpc/rpc-mode.ts 自己 output 的非会话记录
 *
 * 出站 type 一共 26 种 = 这 25 种 + response。
 *
 * 曾经在这里写过 extension_ui_notify / _status / _widget / _title / _editor_text 五个名字，
 * 那是错的：pi 把所有扩展 UI 都塞进同一种 extension_ui_request，用 method 区分
 * （rpc-mode.ts:133/158/174/202/224/244/273）。五种 method 见 EXTENSION_UI_METHODS。
 */
export const RPC_EVENTS = [
  { type: 'agent_start', origin: 'agent' },
  { type: 'agent_end', origin: 'agent' },
  { type: 'turn_start', origin: 'agent' },
  { type: 'turn_end', origin: 'agent' },
  { type: 'message_start', origin: 'agent' },
  { type: 'message_update', origin: 'agent' },
  { type: 'message_end', origin: 'agent' },
  { type: 'tool_execution_start', origin: 'agent' },
  { type: 'tool_execution_update', origin: 'agent' },
  { type: 'tool_execution_end', origin: 'agent' },
  { type: 'agent_settled', origin: 'session' },
  { type: 'queue_update', origin: 'session' },
  { type: 'compaction_start', origin: 'session' },
  { type: 'compaction_end', origin: 'session' },
  { type: 'entry_appended', origin: 'session' },
  { type: 'session_info_changed', origin: 'session' },
  { type: 'thinking_level_changed', origin: 'session' },
  { type: 'auto_retry_start', origin: 'session' },
  { type: 'auto_retry_end', origin: 'session' },
  { type: 'summarization_retry_scheduled', origin: 'session' },
  { type: 'summarization_retry_attempt_start', origin: 'session' },
  { type: 'summarization_retry_finished', origin: 'session' },
  { type: 'bash_execution_update', origin: 'session' },
  { type: 'extension_ui_request', origin: 'rpc' },
  { type: 'extension_error', origin: 'session' },
];

export const RPC_EVENT_TYPES = RPC_EVENTS.map((event) => event.type);

/** 助手流式增量事件（message_update.assistantMessageEvent.type）。 */
export const ASSISTANT_EVENT_TYPES = [
  'start',
  'text_start',
  'text_delta',
  'text_end',
  'thinking_start',
  'thinking_delta',
  'thinking_end',
  'toolcall_start',
  'toolcall_delta',
  'toolcall_end',
  'done',
  'error',
];

/**
 * TUI 的 27 条内置斜杠命令，以及面板怎么对齐。
 *
 * disposition 取值：
 *   'rpc'       —— 面板发对应 RPC 命令（真正的对齐）
 *   'prompt'    —— 直接把 "/name args" 当 prompt 发出去（pi 在 RPC 模式下会执行
 *                  扩展命令 / skill / prompt template，见 agent-session.ts:2313
 *                  的 _tryExecuteExtensionCommand）
 *   'client'    —— 面板自己的 UI（选择器、抽屉、对话框），不产生 RPC 消息
 *   'cli-only'  —— 依赖 TUI 的终端渲染或进程生命周期，RPC 面没有等价能力。
 *                  面板必须显式告诉用户「仅命令行可用」，绝不允许静默当 prompt 发出去。
 *   'local'     —— 面板本地就能算出结果（读文件/常量），不需要 pi 参与
 *   'unsupported' —— pi 的 RPC 面确实没有对应能力，面板显式报「不支持」并给出替代路径。
 *                  与 'cli-only' 的区别：cli-only 是「命令行能做、面板不做」，
 *                  unsupported 是「连命令行都只能靠 TUI 渲染层」或干脆没有等价物。
 *
 * commands 是映射到的 RPC 命令名（按顺序发），为空表示不产生命令。
 * match 描述参数形态：'exact' 只认完全相同，'prefix' 认 "cmd" 与 "cmd ..."。
 */
export const TUI_COMMANDS = [
  { text: '/settings', disposition: 'client', commands: ['get_state'], match: 'exact', note: '面板设置弹窗（0.7.0 起由抽屉改为居中弹窗）：自动压缩/自动重试/steering/followUp 四个开关，读 get_state 回填' },
  { text: '/scoped-models', disposition: 'client', commands: ['get_available_models'], match: 'exact', note: '模型下拉的过滤视图；TUI 是 scoped 子集，面板统一展示全量并标注' },
  { text: '/model', disposition: 'rpc', commands: ['get_available_models', 'set_model'], match: 'prefix', note: '无参开下拉，有参精确匹配后 set_model' },
  { text: '/thinking', disposition: 'rpc', commands: ['get_available_thinking_levels', 'set_thinking_level'], match: 'prefix', note: '无参开档位下拉，有参精确匹配后 set_thinking_level' },
  { text: '/export', disposition: 'rpc', commands: ['export_html'], match: 'prefix', note: '可选路径参数透传 outputPath，返回 {path}' },
  { text: '/import', disposition: 'unsupported', commands: [], match: 'prefix', note: 'RPC 面无 import；面板只能提示改用历史会话抽屉（等价能力：switch_session）' },
  { text: '/share', disposition: 'cli-only', commands: [], match: 'exact', note: 'session-share.ts 依赖 TUI editor/ui，RPC 面无对应命令' },
  { text: '/bug', disposition: 'cli-only', commands: [], match: 'prefix', note: 'bug-report.ts 依赖 TUI 键位与终端信息' },
  { text: '/copy', disposition: 'rpc', commands: ['get_last_assistant_text'], match: 'exact', note: '取回文本后写剪贴板（面板侧 navigator.clipboard）' },
  { text: '/name', disposition: 'rpc', commands: ['set_session_name'], match: 'prefix', note: '空参显示当前名；pi 1.5.2 在会话无 header 名时可能抛 slice 错误，错误原文要透出' },
  { text: '/session', disposition: 'client', commands: ['get_session_stats', 'get_entries'], match: 'exact', note: '统计面板：消息数/工具调用/用量/成本/上下文占用' },
  { text: '/changelog', disposition: 'local', commands: [], match: 'exact', note: '读 pi 包内 CHANGELOG.md，面板直接渲染' },
  { text: '/hotkeys', disposition: 'client', commands: [], match: 'exact', note: '面板键位表（Enter 发送 / Esc 打断 / Shift+Enter 换行）' },
  { text: '/fork', disposition: 'client', commands: ['get_fork_messages', 'fork'], match: 'exact', note: '拉用户消息列表，选中后发 fork {entryId}' },
  { text: '/clone', disposition: 'rpc', commands: ['clone'], match: 'exact', note: '无叶子节点会返回 "Cannot clone session: no current entry selected"' },
  { text: '/tree', disposition: 'client', commands: ['get_tree', 'switch_session'], match: 'exact', note: '树形抽屉；点节点等价于切到该分支（RPC 面靠 fork/switch）' },
  { text: '/trust', disposition: 'cli-only', commands: [], match: 'exact', note: 'TUI 的项目信任选择器，RPC 面无命令' },
  { text: '/login', disposition: 'cli-only', commands: [], match: 'prefix', note: 'OAuth 交互流依赖扩展 UI 的 select/input 链，面板只能给指引' },
  { text: '/logout', disposition: 'cli-only', commands: [], match: 'exact', note: '同上' },
  { text: '/new', disposition: 'rpc', commands: ['new_session'], match: 'exact', note: '发 new_session，pi 内部 SessionManager.create 落盘' },
  { text: '/compact', disposition: 'rpc', commands: ['compact'], match: 'prefix', note: '可选自定义指令透传 customInstructions；绝不能当 prompt 发' },
  { text: '/reload', disposition: 'cli-only', commands: [], match: 'exact', note: 'RPC 面无 reload；重载扩展需重启子进程（面板走「重启会话」）' },
  { text: '/debug', disposition: 'cli-only', commands: [], match: 'exact', note: 'dump 终端渲染行，纯 TUI 专属' },
  { text: '/arminsayshi', disposition: 'cli-only', commands: [], match: 'exact', note: 'TUI 彩蛋' },
  { text: '/dementedelves', disposition: 'cli-only', commands: [], match: 'exact', note: 'TUI 彩蛋' },
  { text: '/resume', disposition: 'client', commands: ['get_state', 'switch_session'], match: 'exact', note: '历史会话抽屉：host 扫 ~/.pi/agent/sessions 列会话，选中后 switch_session' },
  { text: '/quit', disposition: 'client', commands: [], match: 'exact', note: '面板不退出进程，只断开面板（子进程由 host 管）' },
];

/**
 * "!" 与 "!!"：TUI 里分别是普通 bash 与「不进上下文」的 bash。
 * 面板对应 RPC 的 bash 命令，excludeFromContext 区分两者。
 */
export const BASH_SHORTCUTS = [
  { prefix: '!', excludeFromContext: false, command: 'bash', note: '普通 bash，输出进上下文' },
  { prefix: '!!', excludeFromContext: true, command: 'bash', note: 'bash，输出不进上下文' },
];

/**
 * 畸形输出 / 坏字节 / 截断的判据**不在这里**（0.18.0 起）。
 *
 * 0.16.2 曾把判定表与文案复制到这个文件，让面板按表实现一份孪生判据
 * （面板只能 `require('react')`，拿不到仓库模块）。那份表已经删除，原因有两条：
 *
 *   ① 同一份知识两个实现 —— 门禁只能对账"两边结论相等"，
 *      而"两边同时漏掉同一类新形态"这种共同盲区永远测不出来；
 *   ② 面板的判读**依赖** `/contract` 先到 —— 事件早到的那一轮提示会永久丢失
 *      （0.17.3 用启动顺序绕开，依赖本身还在）。
 *
 * 现在唯一真相在 `extensions/superpi-turn-verdict.mjs`：host 对每条 `message_end`
 * 算一次，结果作为 `record.verdict` 随事件下发（见 `src/event-verdict.mjs`），
 * 面板只渲染。契约只登记 pi 侧的事实（命令、事件、斜杠、输入分类），
 * 不再承载产品判据。
 */

const TUI_BY_TEXT = new Map(TUI_COMMANDS.map((entry) => [entry.text, entry]));

/**
 * 输入分类器 —— 面板与 parity 测试共用同一份判定逻辑。
 *
 * 返回：
 *   { kind: 'empty' }
 *   { kind: 'bash', command, excludeFromContext, invoked: '!'|'!!' }
 *   { kind: 'slash', name, args, entry, disposition, commands }
 *   { kind: 'unknown-slash', name, args }   // 首词以 / 开头但不在 27 条里：
 *                                           // 可能是扩展/skill/prompt 命令，按 prompt 发
 *   { kind: 'prompt', text }
 *
 * 注意：unknown-slash 一律按 prompt 发出，这是 pi 的既有语义（RPC 模式会执行
 * 扩展命令）。27 条内置命令绝不落到这个分支。
 */
export function classifyInput(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') return { kind: 'empty' };

  if (text.startsWith('!')) {
    const excludeFromContext = text.startsWith('!!');
    const command = (excludeFromContext ? text.slice(2) : text.slice(1)).trim();
    if (command === '') return { kind: 'empty' };
    return { kind: 'bash', command, excludeFromContext, invoked: excludeFromContext ? '!!' : '!' };
  }

  if (text.startsWith('/')) {
    const match = /^(\S+)([\s\S]*)$/.exec(text);
    const name = match === null ? text : match[1];
    const args = match === null ? '' : match[2].trim();
    const entry = TUI_BY_TEXT.get(name);
    if (entry === undefined) return { kind: 'unknown-slash', name, args };
    return {
      kind: 'slash',
      name,
      args,
      entry,
      disposition: entry.disposition,
      commands: entry.commands.slice(),
    };
  }

  return { kind: 'prompt', text };
}

/**
 * 扩展 UI：pi 只用**一种**出站记录 extension_ui_request，用 method 区分
 * （packages/coding-agent/src/modes/rpc/rpc-mode.ts:133/158/174/202/224/244/273）。
 *
 *   select   {id, method, title, options[], timeout?}   → 应答 {id, value} 或 {id, cancelled:true}
 *   confirm  {id, method, title, message, timeout?}     → 应答 {id, confirmed:boolean} 或 {id, cancelled:true}
 *   input    {id, method, title, placeholder?, timeout?}→ 应答 {id, value} 或 {id, cancelled:true}
 *   editor   {id, method, title, prefill?}              → 应答 {id, value} 或 {id, cancelled:true}
 *   notify / setStatus / setWidget / setTitle / set_editor_text —— 单向，不需要应答
 *   SuperPi 的 ask_user 工具复用 select 与 input，应答回到原生工具调用。
 *   SuperPi 的任务进度复用 setWidget，/superpi-task 由 get_commands 发现并通过 editor 查看。
 *
 * 阻塞语义（rpc-mode.ts:95-135 createDialogPromise）：只有扩展自己传了 timeout 或
 * 中途 abort，pi 才会自己收尾；**没有默认超时**。客户端不应答 ⇒ Promise 永久 pending、
 * 该次 prompt 的 response 永不出现、activeCommands 永不递减。editor 连 timeout 字段都没有。
 * 所以面板必须无条件兜底（client.js 的 ExtensionDialog 按 DIALOG_FALLBACK_MS 自动 cancelled）。
 */
export const EXTENSION_UI_METHODS = [
  { method: 'select', kind: 'dialog', response: ['value', 'cancelled'], fields: ['title', 'options', 'timeout'] },
  { method: 'confirm', kind: 'dialog', response: ['confirmed', 'cancelled'], fields: ['title', 'message', 'timeout'] },
  { method: 'input', kind: 'dialog', response: ['value', 'cancelled'], fields: ['title', 'placeholder', 'timeout'] },
  { method: 'editor', kind: 'dialog', response: ['value', 'cancelled'], fields: ['title', 'prefill'] },
  { method: 'notify', kind: 'oneway', response: [], fields: ['message', 'notifyType'] },
  { method: 'setStatus', kind: 'oneway', response: [], fields: ['statusKey', 'statusText'] },
  { method: 'setWidget', kind: 'oneway', response: [], fields: ['widgetKey', 'widgetLines', 'widgetPlacement'] },
  { method: 'setTitle', kind: 'oneway', response: [], fields: ['title'] },
  { method: 'set_editor_text', kind: 'oneway', response: [], fields: ['text'] },
];

/** Pi 的任务进度需要在事件环淘汰旧记录后仍可回显。 */
export const TASK_WIDGET_KEY = 'superpi-task';

/** 面板兜底超时（毫秒）。pi 不给默认值，客户端必须自己兜。 */
export const DIALOG_FALLBACK_MS = 5 * 60 * 1000;

/** 面板要展示在斜杠菜单里的条目（含 27 条内置 + 三类动态命令的占位说明）。 */
export function slashMenuEntries(dynamicCommands) {
  const dynamic = Array.isArray(dynamicCommands) ? dynamicCommands : [];
  const builtin = TUI_COMMANDS.map((entry) => ({
    name: entry.text,
    args: entry.match === 'prefix' ? '<args>' : '',
    description: entry.note,
    source: 'builtin',
    disposition: entry.disposition,
  }));
  const extras = dynamic.map((command) => ({
    name: '/' + String(command.name),
    args: '',
    description: typeof command.description === 'string' ? command.description : '',
    source: String(command.source),
    disposition: 'prompt',
  }));
  return builtin.concat(extras);
}

/** disposition 的合法取值（validateContract 用）。 */
export const DISPOSITIONS = new Set(['rpc', 'prompt', 'client', 'cli-only', 'local', 'unsupported']);

/** 自检：契约内部一致性（测试会跑）。返回问题数组，空数组表示 OK。 */
export function validateContract() {
  const problems = [];
  const seen = new Set();
  for (const command of RPC_COMMANDS) {
    if (seen.has(command.name)) problems.push('duplicate RPC command: ' + command.name);
    seen.add(command.name);
  }
  const texts = new Set();
  for (const entry of TUI_COMMANDS) {
    if (texts.has(entry.text)) problems.push('duplicate TUI command: ' + entry.text);
    texts.add(entry.text);
    if (!entry.text.startsWith('/')) problems.push('TUI command missing slash: ' + entry.text);
    for (const name of entry.commands) {
      if (!seen.has(name)) problems.push('TUI command ' + entry.text + ' maps to unknown RPC command ' + name);
    }
    if (entry.disposition === 'rpc' && entry.commands.length === 0) {
      problems.push('TUI command ' + entry.text + ' is rpc but maps to no command');
    }
    if (entry.disposition !== 'rpc' && entry.disposition !== 'client' && entry.commands.length > 0) {
      problems.push('TUI command ' + entry.text + ' is ' + entry.disposition + ' but maps to commands');
    }
    if (!DISPOSITIONS.has(entry.disposition)) {
      problems.push('TUI command ' + entry.text + ' has unknown disposition ' + entry.disposition);
    }
  }
  const methods = new Set();
  for (const entry of EXTENSION_UI_METHODS) {
    if (methods.has(entry.method)) problems.push('duplicate extension UI method: ' + entry.method);
    methods.add(entry.method);
    if (entry.kind === 'dialog' && entry.response.length === 0) {
      problems.push('extension UI method ' + entry.method + ' is a dialog but declares no response field');
    }
    if (entry.kind === 'oneway' && entry.response.length > 0) {
      problems.push('extension UI method ' + entry.method + ' is one-way but declares a response field');
    }
  }
  return problems;
}
