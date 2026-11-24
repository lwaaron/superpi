// superpi —— 在 DeepSeek Runtime 侧栏里跑 pi 编码代理（client 半区）
//
// 契约（改动前必读，违反会导致宿主启动卡死或面板空白）：
//   1. sidebar.panellist 的 id 必须与 main slot 的 key 相同（都是 'superpi'），否则点侧栏切不过去。
//   2. main 是 root 作用域 keyed slot：register({ name: 'main', key: PANEL_ID })。
//   3. 所有 slots.inject / locale.register 必须包在 ctx.inject([...]) 里，
//      否则 entry 永久 pending，会卡死整个 dsh 启动。
//   4. 客户端 require 白名单只有 react / react-dom / jsx-runtime / @deepseek-ai/dsh-client-ui-primitives，
//      这个文件只 require('react')，不引任何构建产物。
//   5. 样式只用 --dsw-* 变量，类名统一 .superpi- 前缀，避免污染宿主。
//   6. 同源路由用相对路径（不带前导斜杠），插件路由不需要 token。
//   7. 面板与命令行 pi 必须 100% 对齐（见 AGENTS.md / docs/parity.md）。
//      单一真相源是 src/rpc-contract.mjs：host 用 GET /contract 原样下发，面板在挂载时取回并按它
//      分类输入、生成斜杠菜单。**本文件不许硬编码命令表/事件表**，硬编码就必然与 pi 漂移。
//      要加能力：改 src/rpc-contract.mjs（契约）→ 改 UI（消费契约）→ 跑 test/parity.mjs 对账。
/* eslint-disable */
window.__ModuleLoader__.load({
  id: 'superpi',
  factory: function (require) {
    'use strict'
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useRef = React.useRef
    var useCallback = React.useCallback
    var useMemo = React.useMemo

    var NS = 'superpi'
    var PANEL_ID = 'superpi'
    var API_PREFIX = 'api/superpi'
    var BRAND_NAME = 'SuperPi'

    // ── 文案（zh / en 必须键集一致，test/client-render.mjs 会断言）─────────────
    var ZH = {
      panelTitle: BRAND_NAME,
      newSession: '新会话',
      newSessionHint: '新会话（等价于命令行 SuperPi 的 /new：同一进程内换一棵会话树）',
      reconnectHint: '重连（关掉 SuperPi 子进程再起一个；会话记录不丢）',
      sessions: '历史会话',
      sessionsEmpty: '这个目录下还没有历史会话。',
      sessionsLoading: '正在读取会话…',
      sessionsHint: '点击任意一条即可切换过去（等价于命令行 SuperPi 的 /resume）。',
      current: '当前',
      untitled: '未命名会话',
      messages: '条消息',
      retry: '重试',
      viewImage: '查看图片',
      toolLimit: '上限 {limit}',
      toolSilent: '已静默 {silent}，仍在运行',
      toolOverLimit: '已超出上限 {limit}',
      imageFailed: '这张图取不回来了（可能已超出缓存，滚动或重新打开会话再试）',
      loadEarlier: '加载更早的消息',
      messageTotal: '共 {n} 条',
      stop: '停止',
      send: '发送',
      queue: '排队',
      composerHint: '给 SuperPi 说点什么, / 调用指令, @ 文件',
      composerTipIdle: 'Enter 发送 · Shift+Enter 换行 · / 命令 · @ 文件 · ! 跑 bash',
      composerTipBusy: '发送 = steer 插话 · Alt+Enter 排队 · Esc 停止',
      emptyTitle: '和 SuperPi 对话',
      emptyHint: '在目录里读写文件、跑命令，整个会话跑在独立子进程里，出问题不会影响 DSH 本体。',
      thinking: '思考',
      workspace: '目录',
      model: '模型',
      dead: '已结束',
      loading: '正在连接 SuperPi…',
      error: '出错了',
      reconnect: '重新连接',
      failed: '失败',
      /**
       * 「这一轮没交付」（0.18.0）。
       *
       * 文案本体**不在这里**：host 把判读结果（含中英文案）随 `message_end` 下发，
       * 面板只是渲染者。这里只留那个按钮的字 —— 六类形态共用同一个动作「继续」。
       *
       * 为什么去掉了 0.16.2 的三条兜底文案：兜底存在的前提是"面板自己判"，
       * 而现在面板不判。留着它们就等于留着一份"看起来还在用"的死文案，
       * 下一个人会以为面板还认得 `malformedNotice`（`/contract` 已经不下发它了）。
       */
      verdictRetry: '继续',
      verdictDetail: '继续会使用当前会话的进度和已完成的工具结果。',
      /**
       * 语言码本身作为一个词条（0.18.0）。
       *
       * 用途：`verdict.notice` 由 host 同时下发中英两份，面板要按当前语言选一份。
       * 而 `t()` 是**已绑定语言**的，不暴露语言码 —— 这里不猜它的内部实现、
       * 也不用比较某个词条的文本，直接把语言码做成词条：中文环境返回 `zh`，
       * 英文环境返回 `en`。语言换了，取值自己跟着换。
       */
      verdictLang: 'zh',
      /** 契约仍承载斜杠命令分派（`classifyInput`），拉不到时要说清缺的是什么。 */
      contractFailed: '契约加载失败，斜杠命令分派将退化为「未知斜杠照发」',
      procThink: '思考',
      procBash: '运行命令',
      procRead: '读取',
      procReadImage: '读取图片',
      procWrite: '写入',
      procEdit: '编辑',
      procGrep: '搜索文件内容',
      procGlob: '查找文件',
      procList: '浏览目录',
      procGeneric: '工具调用',
      procAsk: '询问用户',
      procVerify: '执行验证',
      procTaskProgress: '任务进度',
      procResult: '结果',
      deepDiving: '深度求索中',
      working: '深度求索中，用时 {duration} ···',
      // 单位自带尾随空格，靠 join('') 拼出「43分54秒」；与 DSH duration.* 一致（中文不带空格）
      durHour: '{n}小时',
      durMin: '{n}分',
      durSec: '{n}秒',
      tokens: 'tokens',
      crashed: 'SuperPi 子进程已退出',
      sessionEnded: '这个会话已经结束（SuperPi 子进程退出了）',
      sessionEndedHint: '会话文件已保存，历史记录不会丢。点「重新连接」起一个新进程，或到「历史会话」里挑一条继续。',
      synced: '代码已同步',
      syncedHint: '运行时文件与磁盘一致',
      staleCode: '代码有改动未生效',
      staleBuild: '构建产物过期',
      runtimeMissing: '没找到 SuperPi 运行时',
      runtimeMissingHint: '点一下，从公共 npm 装到插件目录里，不需要开命令行。',
      installRuntime: '安装 SuperPi 运行时',
      installing: '正在安装…',
      installFailed: '安装失败',
      recheck: '重新检查',
      runtimeReady: '运行时就绪',
      searchedAt: '已检查',
      // —— 0.3.0 新增 ──
      refresh: '刷新',
      filter: '筛选',
      slashHint: '↑↓ 选择 · Tab 补全 · Enter 执行 · Esc 关闭',
      cliOnly: '仅命令行可用',
      cliOnlyDetail: '这个命令依赖终端界面或进程生命周期，面板里没法等价实现。请在终端里运行 SuperPi 后使用。',
      unsupported: '面板不支持',
      unsupportedDetail: 'SuperPi 的 RPC 协议里没有对应能力，这里不会假装支持。',
      noArgs: '需要参数',
      models: '模型',
      modelsLoading: '正在读取模型…',
      modelsEmpty: '没有可用模型。',
      attachImage: '插入图片',
      imageRemove: '移除',
      images: '张图片',
      insertPath: '插入路径',
      filesEmpty: '这个目录是空的。',
      fork: '分支',
      forkPick: '选一条消息，从它之后开新分支',
      forkEmpty: '还没有可分支的用户消息。',
      forkDone: '已切到新分支',
      clone: '克隆会话',
      tree: '会话树',
      treeEmpty: '会话里还没有条目。',
      entries: '条目',
      stats: '会话统计',
      statsUser: '用户消息',
      statsAssistant: '助手消息',
      statsTools: '工具调用',
      statsTotal: '总条目',
      contextUsage: '上下文占用',
      contextReal: '真实占用（上下文守卫）',
      imagesReleased: '已释放图片',
      contextOverBudget: '已裁到最严仍超预算，建议压缩上下文',
      modalitiesSection: '模型模态',
      modalitiesBadge: '按协议解析',
      modalitiesHint: '默认文本与图像开启；关闭某个模态后，发给该模型的请求里不再包含它的内容。',
      modalitiesLoadFailed: '读取模态设置失败',
      modalitiesNoSession: '还没有可用会话，模型列表暂时读不到；可先在命令行窗口用 /superpi-modalities 设置。',
      modality_text: '文本',
      modality_image: '图像',
      modalityLocked: '对话必需通道，不可关闭',
      modalityClickOn: '点击开启',
      modalityClickOff: '点击关闭',
      cost: '费用',
      compactNow: '压缩上下文',
      compacting: '正在压缩上下文…',
      compactDone: '上下文已压缩',
      namePrompt: '给这个会话起个名字',
      nameSet: '已命名',
      exportDone: '已导出',
      copyDone: '已复制最后一条回复',
      copyFailed: '复制失败（浏览器拒绝写剪贴板）',
      extSelect: '请选择',
      extConfirm: '请确认',
      extInput: '请输入',
      extEditor: '请编辑',
      extYes: '确认',
      extNo: '否',
      extSubmit: '提交',
      extResponseFailed: '回答未能发送。可以重试。',
      extTimeout: '还剩 {n}s 后自动取消',
      notify: '提示',
      steerQueued: '排队中（steer）',
      autoCompact: '自动压缩',
      autoRetry: '自动重试',
      // ── 用户自定义规则（0.10.0）───────────────────────────────────────
      rulesSection: '用户自定义规则（最高优先级）',
      rulesSummary: '{lines} 行 · {chars} 字',
      rulesBadgeTop: '最高优先级',
      rulesBadgeDefault: '默认',
      rulesEmptyState: '当前未生效：不会向模型追加任何内容',
      rulesEmptySave: '保存后将生效：下一轮对话立刻带上这段规则',
      rulesEdit: '编辑规则',
      rulesEditHint: '编辑规则（保存后下一轮对话立刻生效）',
      rulesReset: '恢复默认',
      rulesResetConfirm: '恢复默认规则？',
      rulesResetBody: '当前的修改会被替换成内置默认规则，这一步不能撤销。',
      rulesSaved: '规则已保存',
      rulesResetDone: '已恢复默认规则',
      rulesLoadFailed: '规则读取失败',
      rulesCounter: '{n} / {max} 字',
      rulesOverLimit: '超出上限，请先删掉 {n} 个字再保存',
      rulesDiscard: '丢弃未保存的修改？',
      rulesDiscardBody: '编辑框里还有没保存的内容，关闭就丢了。',
      rulesDiscardOk: '丢弃',
      rulesCliMissing: '命令行窗口未生效：运行 npm run superpi:editor 安装扩展',
      rulesCliReady: '命令行窗口与面板同一份，/superpi-rules 可编辑',
      rulesDelivery: '交付链路',
      rulesPlaceholder: '在这里写你的规则，每行一条；清空 = 不追加任何内容',
      rulesSaving: '保存中…',
      rulesSave: '保存',
      rulesDrift: '文件被外部修改过（指纹不一致），保存一次即可对齐',
      steeringMode: '插入模式',
      on: '开',
      off: '关',
      search: '搜索',
      sessionName: '会话名',
      noSession: '新会话（尚未落盘）',
      retrying: '重试中',
      loadMore: '加载更多',
      emptyResult: '没有匹配项',
      cliCommands: '命令行专属',
      commands: '命令',
      notFoundCmd: '未知命令，按普通消息发送',
      steerHint: '运行中发送 = steer（插话），与命令行一致',
      autoApprove: '扩展弹窗无应答会卡住 agent，这里超时后自动取消',
      files: '文件',
      treeHint: 'SuperPi 的会话树（只读，与 /tree 一致）',
      forkHint: '选择一条用户消息，从它分叉出新会话',
      settings: '设置',
      followUpMode: '排队模式',
      cancel: '取消',
      close: '关闭',
      slashTitle: '斜杠命令',
      fileTitle: '插入文件路径',
      thinkingHint: '思考档位',
      modelHint: '模型',
      exported: '已导出',
      copied: '已复制',
      copiedPath: '路径已复制',
      noImages: '没有可粘贴的图片',
      attach: '图片',
      queued: '排队中',
      loginHint: '请在你的浏览器中完成登录，完成后回到这里',
      followUpSend: '排队（follow_up）',
      dequeued: '已把排队消息取回输入框',
      pickDir: '选择工作区',
      dirTitle: '选择工作区',
      dirHint: '单击选中、双击进入；不存在的路径在开新会话时自动创建',
      dirEmpty: '这个目录下没有子目录。',
      dirLoading: '正在读取目录…',
      dirUp: '上一级',
      dirHome: '主目录',
      dirThisPc: '此电脑',
      dirPickDrive: '选一个盘符进入；双击可直接打开',
      dirHere: '用这个工作区',
      dirNotWritable: '这个目录不可写',
      dirSwitched: '已在新工作区开会话',
      dirInputHint: '输入绝对路径后回车',
      dirPickMark: '已选中',
      dirSwitching: '正在切换…',
      allProjects: '全部项目',
      projectsEmpty: '还没有任何已保存的会话。',
      projectsLoading: '正在读取项目…',
      projectsHint: '选择一个项目，再选其中的会话（等价于命令行 SuperPi 的 /resume）。',
      projectSessions: '{n} 个会话',
      tempTag: '临时',
      sessionCwdMissing: '这个会话原来的目录已不存在：{path}。会话文件还在，可用命令行 SuperPi 打开它并选择换一个目录继续。',
      openFile: '在预览区打开',
      openFileFailed: '打不开这个文件：{path}',
      openFileNoSession: '右侧预览需要一个正在显示的会话；这里先用面板内预览。',
      filePreview: '文件预览',
      attachFile: '插入文件路径',
      attachFileHint: '图片会作为附件发送；其它文件按 SuperPi 命令行的方式把路径插进输入框',
      pathInserted: '已插入 {n} 个文件路径',
      pathUnavailable: '这个环境拿不到 {n} 个文件的本地路径（只有桌面版能拿到），改用输入框里的 @ 选择文件吧',
      binaryFile: '这是二进制文件，面板内不渲染它的内容（{size} 字节）。',
      fileTruncated: '…（文件较大，这里只显示前 512 KiB）',
      revealFile: '在文件管理器里显示',
      revealFileFailed: '打不开文件管理器：{path}',
      addMenu: '添加',
      addGroupAdd: '添加',
      addGroupCommands: '指令',
      addFile: '文件',
      addFileDesc: '选图片当附件，其它文件插入路径',
      addDirDesc: '换一个工作区开会话',
      addSessionsDesc: '从磁盘上的历史会话里挑一个',
      addCompactDesc: '把当前上下文压缩成摘要',
      addModelDesc: '切换 provider 与模型',
      addThinkingDesc: '切换推理等级',
      addStatsDesc: '本次会话的用量与条目',
      addSettingsDesc: '自动压缩、自动重试、插话模式',
      addHotkeysDesc: '键盘操作一览',
      addNewDesc: '同一进程内重开一棵会话树',
      hotkeys: '快捷键',
      footerTurns: '{n} 轮',
      footerSteps: '{n} 步',
      footerCache: '缓存命中 {pct}%',
      footerTokens: '{n} tok',
      // 顶栏「更多」与两个自造弹层的文案（用户 30427）。
      moreActions: '更多操作',
      pickModel: '切换模型',
      pickThinking: '思考档位',
      confirmCompact: '压缩上下文？',
      confirmCompactBody: '把当前会话的上下文压成摘要，之后仍可继续对话。',
      confirmReconnect: '重新连接？',
      confirmReconnectBody: '会关掉 SuperPi 子进程再起一个；会话记录留在磁盘上，但正在进行的一轮会中断。',
      // 历史会话两级列表（项目层 → 会话层）的文案。
      projectList: '项目列表',
      searchProjects: '搜索项目',
      searchSessions: '搜索会话',
      newProject: '新建项目',
      newProjectHint: '选一个工作区，并在那里开一个新会话',
      renameProject: '重命名项目',
      renameSession: '重命名会话',
      pinSession: '置顶',
      unpinSession: '取消置顶',
      newSessionHere: '在此新建会话',
      renamePrompt: '输入新名称',
      sessionFallbackTitle: '未命名会话',
    }
    var EN = {
      panelTitle: BRAND_NAME,
      newSession: 'New session',
      newSessionHint: 'New session (same as /new: a fresh session tree in the same process)',
      reconnectHint: 'Reconnect (restart the SuperPi child process; the session files stay)',
      sessions: 'Sessions',
      sessionsEmpty: 'No sessions in this directory yet.',
      sessionsLoading: 'Loading sessions…',
      sessionsHint: 'Click one to switch to it (same as /resume in the CLI).',
      current: 'current',
      untitled: 'Untitled session',
      messages: 'messages',
      retry: 'Retry',
      viewImage: 'view image',
      toolLimit: 'limit {limit}',
      toolSilent: 'silent {silent}, still running',
      toolOverLimit: 'over limit {limit}',
      imageFailed: 'Could not load this image (cache may have evicted it; reopen the session and retry)',
      loadEarlier: 'Load earlier messages',
      messageTotal: '{n} total',
      stop: 'Stop',
      send: 'Send',
      queue: 'Queue',
      composerHint: 'Say something to SuperPi, / commands, @ files',
      composerTipIdle: 'Enter to send · Shift+Enter for newline · / commands · @ files · ! for bash',
      composerTipBusy: 'Send = steer while busy · Alt+Enter to queue · Esc to stop',
      emptyTitle: 'Talk to SuperPi',
      emptyHint: 'Read and write files, run commands — the whole session runs in its own child process, so it cannot hurt DSH itself.',
      thinking: 'Thinking',
      workspace: 'Workspace',
      model: 'Model',
      dead: 'Exited',
      loading: 'Connecting to SuperPi…',
      error: 'Something went wrong',
      reconnect: 'Reconnect',
      failed: 'failed',
      verdictRetry: 'Continue',
      verdictDetail: 'Continue using the current session and completed tool results.',
      verdictLang: 'en',
      contractFailed: 'Contract load failed — slash dispatch falls back to "send unknown slashes as text"',
      procThink: 'Thinking',
      procBash: 'Run command',
      procRead: 'Read',
      procReadImage: 'Read image',
      procWrite: 'Write',
      procEdit: 'Edit',
      procGrep: 'Grep',
      procGlob: 'Find files',
      procList: 'List folder',
      procGeneric: 'Tool call',
      procAsk: 'Ask user',
      procVerify: 'Run verification',
      procTaskProgress: 'Task progress',
      procResult: 'Result',
      deepDiving: 'Deep diving',
      working: 'Deep diving, {duration} ···',
      // EN 的尾随空格就是拼接分隔符本身（DSH duration.hourUnit = 'h '），join('') 后成「2h 3m 9s」
      durHour: '{n}h ',
      durMin: '{n}m ',
      durSec: '{n}s',
      tokens: 'tokens',
      crashed: 'SuperPi child process exited',
      sessionEnded: 'This session has ended (the SuperPi child process exited)',
      sessionEndedHint: 'The session file is safe — history is not lost. Reconnect to start a fresh process, or pick a session from History.',
      synced: 'Code in sync',
      syncedHint: 'Runtime files match disk',
      staleCode: 'Code changed but not loaded',
      staleBuild: 'Build artifact is stale',
      runtimeMissing: 'SuperPi runtime not found',
      runtimeMissingHint: 'One click installs it from public npm into the plugin directory — no terminal needed.',
      installRuntime: 'Install SuperPi runtime',
      installing: 'Installing…',
      installFailed: 'Install failed',
      recheck: 'Re-check',
      runtimeReady: 'Runtime ready',
      searchedAt: 'checked',
      refresh: 'Refresh',
      filter: 'Filter',
      slashHint: '↑↓ select · Tab complete · Enter run · Esc close',
      cliOnly: 'CLI only',
      cliOnlyDetail: 'This command needs the terminal UI or process lifecycle; the panel cannot match it. Run SuperPi in a terminal to use it.',
      unsupported: 'Not supported here',
      unsupportedDetail: 'SuperPi RPC exposes no equivalent capability, so the panel will not fake it.',
      noArgs: 'Argument required',
      models: 'Models',
      modelsLoading: 'Loading models…',
      modelsEmpty: 'No models available.',
      attachImage: 'Attach image',
      imageRemove: 'Remove',
      images: 'images',
      insertPath: 'Insert path',
      filesEmpty: 'This directory is empty.',
      fork: 'Fork',
      forkPick: 'Pick a message to branch after',
      forkEmpty: 'No user message to fork from yet.',
      forkDone: 'Switched to the new branch',
      clone: 'Clone session',
      tree: 'Session tree',
      treeEmpty: 'No entries in this session yet.',
      entries: 'entries',
      stats: 'Session stats',
      statsUser: 'User messages',
      statsAssistant: 'Assistant messages',
      statsTools: 'Tool calls',
      statsTotal: 'Total entries',
      contextUsage: 'Context usage',
      contextReal: 'Real usage (context guard)',
      imagesReleased: 'images released',
      contextOverBudget: 'still over budget — compact the context',
      modalitiesSection: 'Model modalities',
      modalitiesBadge: 'parsed from protocol',
      modalitiesHint: 'Text and image are on by default; turning a modality off removes its content from requests to that model.',
      modalitiesLoadFailed: 'Failed to read modality settings',
      modalitiesNoSession: 'No live session yet, so the model list is unavailable; set them in the CLI with /superpi-modalities.',
      modality_text: 'Text',
      modality_image: 'Image',
      modalityLocked: 'Required channel — cannot be disabled',
      modalityClickOn: 'Click to enable',
      modalityClickOff: 'Click to disable',
      cost: 'Cost',
      compactNow: 'Compact context',
      compacting: 'Compacting context…',
      compactDone: 'Context compacted',
      namePrompt: 'Name this session',
      nameSet: 'Named',
      exportDone: 'Exported',
      copyDone: 'Copied last reply',
      copyFailed: 'Copy failed (clipboard denied)',
      extSelect: 'Select',
      extConfirm: 'Confirm',
      extInput: 'Input',
      extEditor: 'Edit',
      extYes: 'Confirm',
      extNo: 'No',
      extSubmit: 'Submit',
      extResponseFailed: 'Your response could not be sent. Try again.',
      extTimeout: 'Auto-cancels in {n}s',
      notify: 'Notice',
      steerQueued: 'Queued (steer)',
      autoCompact: 'Auto-compact',
      autoRetry: 'Auto-retry',
      // ── User-defined rules (0.10.0) ──────────────────────────────────
      rulesSection: 'User-defined rules (highest priority)',
      rulesSummary: '{lines} lines · {chars} chars',
      rulesBadgeTop: 'Highest priority',
      rulesBadgeDefault: 'Default',
      rulesEmptyState: 'Not active: nothing is appended to the model',
      rulesEmptySave: 'Effective after saving: the next turn carries these rules',
      rulesEdit: 'Edit rules',
      rulesEditHint: 'Edit rules (effective on the next turn after saving)',
      rulesReset: 'Restore default',
      rulesResetConfirm: 'Restore the default rules?',
      rulesResetBody: 'Your edits are replaced by the built-in default. This cannot be undone.',
      rulesSaved: 'Rules saved',
      rulesResetDone: 'Default rules restored',
      rulesLoadFailed: 'Cannot read the rules',
      rulesCounter: '{n} / {max} chars',
      rulesOverLimit: 'Over the limit — remove {n} more characters before saving',
      rulesDiscard: 'Discard unsaved changes?',
      rulesDiscardBody: 'The editor still has unsaved content; closing loses it.',
      rulesDiscardOk: 'Discard',
      rulesCliMissing: 'CLI window not covered yet: run npm run superpi:editor to install the extension',
      rulesCliReady: 'The CLI window shares this file; /superpi-rules edits it there',
      rulesDelivery: 'Delivery',
      rulesPlaceholder: 'Write your rules here, one per line; empty = nothing is appended',
      rulesSaving: 'Saving…',
      rulesSave: 'Save',
      rulesDrift: 'Changed outside the panel (checksum mismatch); save once to realign',
      steeringMode: 'Steering',
      on: 'on',
      off: 'off',
      search: 'Search',
      sessionName: 'Session',
      noSession: 'New session (not persisted yet)',
      retrying: 'Retrying',
      loadMore: 'Load more',
      emptyResult: 'No match',
      cliCommands: 'CLI only',
      commands: 'Commands',
      notFoundCmd: 'Unknown command — sending as a normal message',
      steerHint: 'Sending while busy = steer, same as the CLI',
      autoApprove: 'An unanswered extension dialog blocks the agent, so it auto-cancels on timeout',
      files: 'Files',
      treeHint: 'SuperPi session tree (read-only, same as /tree)',
      forkHint: 'Pick a user message to fork the session from',
      settings: 'Settings',
      followUpMode: 'Follow-up mode',
      cancel: 'Cancel',
      close: 'Close',
      slashTitle: 'Slash commands',
      fileTitle: 'Insert file path',
      thinkingHint: 'Thinking level',
      modelHint: 'Model',
      exported: 'Exported',
      copied: 'Copied',
      copiedPath: 'Path copied',
      noImages: 'No image in the clipboard',
      attach: 'Image',
      queued: 'Queued',
      loginHint: 'Finish signing in with your browser, then come back here',
      followUpSend: 'Queue (follow_up)',
      dequeued: 'Queued messages restored to the editor',
      pickDir: 'Choose workspace',
      dirTitle: 'Choose workspace',
      dirHint: 'Click to select, double-click to enter; a missing path is created when the session starts',
      dirEmpty: 'No subdirectories here.',
      dirLoading: 'Reading directory…',
      dirUp: 'Parent',
      dirHome: 'Home',
      dirThisPc: 'This PC',
      dirPickDrive: 'Pick a drive; double-click to open it',
      dirHere: 'Use this workspace',
      dirNotWritable: 'This directory is not writable',
      dirSwitched: 'Started a session in the new workspace',
      dirInputHint: 'Type an absolute path and press Enter',
      dirPickMark: 'selected',
      dirSwitching: 'Switching…',
      allProjects: 'All projects',
      projectsEmpty: 'No saved sessions yet.',
      projectsLoading: 'Loading projects…',
      projectsHint: 'Pick a project, then a session inside it (same as /resume in the CLI).',
      projectSessions: '{n} sessions',
      tempTag: 'temp',
      sessionCwdMissing: 'The folder this session lived in no longer exists: {path}. The session file is still there — open it with the SuperPi CLI and pick another folder.',
      openFile: 'Open in preview',
      openFileFailed: 'Cannot open this file: {path}',
      openFileNoSession: 'The right preview needs a session on screen; showing the in-panel preview instead.',
      filePreview: 'File preview',
      attachFile: 'Insert file path',
      attachFileHint: 'Images are sent as attachments; other files insert their path, exactly like the SuperPi CLI',
      pathInserted: 'Inserted {n} file path(s)',
      pathUnavailable: 'This host cannot resolve the local path of {n} file(s) — only the desktop app can; pick them with @ in the composer instead',
      binaryFile: 'Binary file: the panel does not render its bytes ({size} bytes).',
      fileTruncated: '… (large file: showing the first 512 KiB only)',
      revealFile: 'Reveal in file manager',
      revealFileFailed: 'Cannot open the file manager: {path}',
      addMenu: 'Add',
      addGroupAdd: 'Add',
      addGroupCommands: 'Commands',
      addFile: 'File',
      addFileDesc: 'Images become attachments, other files insert a path',
      addDirDesc: 'Start a session in another workspace',
      addSessionsDesc: 'Pick a session from disk',
      addCompactDesc: 'Compress the current context into a summary',
      addModelDesc: 'Switch provider and model',
      addThinkingDesc: 'Switch reasoning effort',
      addStatsDesc: 'Usage and entries for this session',
      addSettingsDesc: 'Auto-compaction, auto-retry, steering mode',
      addHotkeysDesc: 'Every keyboard shortcut',
      addNewDesc: 'Start a fresh session tree in this process',
      hotkeys: 'Shortcuts',
      footerTurns: '{n} turns',
      footerSteps: '{n} steps',
      footerCache: 'cache {pct}%',
      footerTokens: '{n} tok',
      moreActions: 'More actions',
      pickModel: 'Switch model',
      pickThinking: 'Reasoning effort',
      confirmCompact: 'Compact context?',
      confirmCompactBody: 'Compress this conversation into a summary. You can keep talking afterwards.',
      confirmReconnect: 'Reconnect?',
      confirmReconnectBody: 'Stops the SuperPi subprocess and starts a new one. Session history stays on disk; a running turn is interrupted.',
      projectList: 'Projects',
      searchProjects: 'Search projects',
      searchSessions: 'Search sessions',
      newProject: 'New project',
      newProjectHint: 'Pick a workspace and start a new session there',
      renameProject: 'Rename project',
      renameSession: 'Rename session',
      pinSession: 'Pin',
      unpinSession: 'Unpin',
      newSessionHere: 'New session here',
      renamePrompt: 'Enter a new name',
      sessionFallbackTitle: 'Untitled session',
    }

    // ── 样式（只用 --dsw-* 变量；类名统一 .superpi- 前缀）──────────────────────
    var CSS = [
      // ── 基础 ────────────────────────────────────────────────────────────────
      // 只引用 DSH 设计令牌（--dsw-*）；外部变量（--ds-font-family-code / --dsh-*）
      // 一律带兜底。焦点环走 DSH 自己的 --dsw-focus-ring-color 钩子：DSH 默认把它设成
      // transparent（等于不要环），面板在根节点上把它指回 state-business-primary，
      // 这样键盘可达性不打折，且仍由主题决定具体色值。
      '.superpi-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:var(--dsw-font-s-14-font-size);line-height:var(--dsw-font-s-14-line-height);position:relative;--dsw-focus-ring-color:var(--dsw-alias-state-business-primary);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}',
      '.superpi-root *{box-sizing:border-box}',
      '.superpi-root :is(button,input,select,textarea){font-family:inherit}',
      '.superpi-root :is(button,input,select,textarea,summary,a,[tabindex]):focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',

      // ── 头部 ────────────────────────────────────────────────────────────────
      '.superpi-head{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:.5px solid var(--dsw-alias-border-l3);flex:0 0 auto;flex-wrap:wrap}',
      '.superpi-head-main{display:flex;align-items:center;gap:8px;min-width:0;flex:1 1 auto}',
      '.superpi-brand{display:flex;align-items:center;gap:6px;font-size:var(--dsw-font-s-14-font-size);line-height:var(--dsw-font-s-14-line-height);font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.superpi-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:0 0 auto}',
      '.superpi-dot[data-state="ready"]{background:var(--dsw-alias-state-success-primary)}',
      '.superpi-dot[data-state="busy"]{background:var(--dsw-alias-state-business-primary);animation:superpi-pulse 1.2s ease-in-out infinite}',
      '.superpi-dot[data-state="dead"]{background:var(--dsw-alias-state-error-primary)}',
      '@keyframes superpi-pulse{0%,100%{opacity:1}50%{opacity:.35}}',

      // 胶囊标签：对齐 DSH 的 ._tag（radius 999 / padding 1px 8px / 11px / weight 500），
      // tone 语义与 DSH 的 success(10%) / warning(12%) / danger(10%) color-mix 一致。
      '.superpi-chip{display:inline-flex;align-items:center;gap:5px;height:20px;padding:1px 8px;border:0;border-radius:999px;corner-shape:round;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:var(--dsw-font-xxxs-11-font-size);line-height:var(--dsw-font-xxxs-11-line-height);font-weight:500;white-space:nowrap;max-width:220px;overflow:hidden;text-overflow:ellipsis;transition:background-color .16s ease,color .16s ease}',
      '.superpi-chip[data-clickable="1"]{cursor:pointer}',
      '.superpi-chip[data-clickable="1"]:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.superpi-chip[data-tone="ok"]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);color:var(--dsw-alias-state-success-primary)}',
      '.superpi-chip[data-tone="warn"]{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);color:var(--dsw-alias-state-warn-primary)}',
      '.superpi-chip[data-tone="err"]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-state-error-primary)}',
      '.superpi-chip-name{overflow:hidden;text-overflow:ellipsis}',

      // 头部下拉（思考档位）：沿用 DSH 输入框的配方（.5px border-l4 + bg-layer-3 + radius-sm）。

      // ── 按钮 ────────────────────────────────────────────────────────────────
      // 基线 = DSH ._button + ._sm（28px / radius-sm / 12px）+ ._outline 的 hairline；
      // -ghost 去掉 hairline 与底色，-primary 用 button-primary-fill/hover 令牌。
      '.superpi-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 10px;border:0;border-radius:var(--dsw-radius-sm);box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l4);background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:var(--dsw-font-xxs-12-font-size);line-height:var(--dsw-font-xxs-12-line-height);cursor:pointer;white-space:nowrap;transition:background-color .16s ease,color .16s ease,box-shadow .16s ease}',
      '.superpi-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.superpi-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}',
      '.superpi-btn:disabled{opacity:.4;cursor:not-allowed}',
      '.superpi-btn-primary{box-shadow:none;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);padding:0 14px}',
      '.superpi-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);color:var(--dsw-alias-label-primary-foreground)}',
      '.superpi-btn-primary:active:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
      '.superpi-btn-danger{box-shadow:none;color:var(--dsw-alias-state-error-primary)}',
      '.superpi-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}',
      '.superpi-btn-ghost{box-shadow:none;background:transparent;color:var(--dsw-alias-label-secondary)}',
      '.superpi-btn-ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.superpi-btn-icon{width:28px;padding:0}',
      '.superpi-btn svg{width:15px;height:15px}',

      // ── 消息流 ──────────────────────────────────────────────────────────────
      '.superpi-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden}',
      '.superpi-inner{display:flex;flex-direction:column;gap:16px;padding:16px 16px 20px}',
      '.superpi-row{display:flex;gap:8px;min-width:0}',
      '.superpi-row-user{justify-content:flex-end}',
      // 用户气泡 = DSH ._bubble（specific-bubble / radius-xl / 10px 16px / 内容字号可调）
      '.superpi-bubble-user{max-width:82%;padding:10px 16px;border:0;border-radius:var(--dsw-radius-xl);background:var(--dsw-specific-bubble);color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size,var(--dsw-font-s-14-font-size));line-height:calc(22px + var(--dsh-content-font-delta,0px));white-space:pre-wrap;word-break:break-word}',
      '.superpi-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:8px}',
      // 正文 = DSH markdown base（14px/24px，可用 --dsh-content-font-* 缩放）
      '.superpi-prose{font-size:var(--dsh-content-font-size,var(--dsw-font-s-14-font-size));line-height:calc(24px + var(--dsh-content-font-delta,0px));word-break:break-word}',
      '.superpi-prose p{margin:0 0 8px}',
      '.superpi-prose p:last-child{margin-bottom:0}',
      '.superpi-prose ul{margin:0 0 8px;padding-left:20px}',
      '.superpi-prose h3{margin:16px 0 8px;font:var(--dsw-font-markdown-h3)}',
      '.superpi-prose strong{font-weight:600}',
      '.superpi-code-inline{padding:1px 4px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-markdown-inline-code);font:var(--dsw-font-markdown-code-block-small);color:var(--dsw-alias-label-primary)}',
      // 代码块 = DSH ._card / ._header / ._body 三段（banner + body，无边框）
      '.superpi-fence{margin:16px 0;overflow:hidden;border:0;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-markdown-code-block);font:var(--dsw-font-markdown-code-block)}',
      '.superpi-fence-lang{padding:10px 18px 8px 22px;border-bottom:0;background:var(--dsw-alias-markdown-code-block-banner);color:var(--dsw-alias-label-secondary);font-size:var(--dsw-font-xxxs-11-font-size);line-height:18px;font-family:var(--dsw-font-family)}',
      '.superpi-pre{margin:0;padding:6px 22px 20px;overflow-x:auto;font:var(--dsw-font-markdown-code-block);color:var(--dsw-alias-label-primary)}',
      // ── 过程行（思考 / 工具调用 / 工具结果）──────────────────────────────
      //
      // 对齐 DSH 会话过程流（research/tool-pkg/client.js 的 ToolRow.module.css）：
      // 一行 = [16px 图标位][label][2×2 实心圆点][单行摘要]，字号 13 / 行高 24，
      // 无外框、无描边、无卡片。一次任务常连着十几条工具调用，行里再套卡片会形成
      // 框套框的噪音墙（用户 18994 明确要求去掉圆角框），DSH 自己也是平铺行。
      // 层级靠缩进表达：模型「想了什么」是父行，它「做了什么」缩进成子行并带一条
      // 左侧竖线 —— 与 DSH 的 tool 行 + 嵌套子行同构。展开区沿用同一条竖线语言。
      // 行节奏按参考截图逐像素反推。先把参考图里被「1px 点线下划线」切出来的细带并回各自
      // 的行（那几处 h2 的带子是路径下划线，不是独立行），实测结果是：父→父 40 图 px、
      // 父→首个子行 40、子→子 40、子行组→下一父行 44 —— 父子节奏一致，不存在「子行比父行
      // 紧一半」。早先把下划线当成行，才算出 32:16 这个错结论。
      // 比例尺用 CJK 字形 ink 高校准：参考图 label ink 17-18 图 px，本文件 13px 字号的 ink
      // 是 13-14 css px，故 ≈1.3；40 图 px ÷ 1.3 ≈ 31 css，本文件父行步长 = 24 行盒 + body
      // 的 8px gap = 32，两者对齐，因此子行也走同一节奏（见 .superpi-sub 的 gap 与行盒）。
      '.superpi-proc{border:0;border-radius:0;background:transparent;box-shadow:none;display:block;min-width:0}',
      '.superpi-tool{border:0;border-radius:0;background:transparent;box-shadow:none;display:block;min-width:0}',
      '.superpi-proc-head,.superpi-tool-head{display:flex;align-items:center;min-width:0;list-style:none;cursor:pointer;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary)}',
      '.superpi-proc-head::-webkit-details-marker,.superpi-tool-head::-webkit-details-marker{display:none}',
      '.superpi-proc-head::marker,.superpi-tool-head::marker{content:""}',
      // 悬停只提亮文字，不铺底色 —— 没有外框时铺底色会露出一块矩形色斑。
      '.superpi-proc-head:hover .superpi-proc-text,.superpi-proc-head:hover .superpi-proc-label,.superpi-proc-head:hover .superpi-proc-path,.superpi-tool-head:hover .superpi-proc-text,.superpi-tool-head:hover .superpi-proc-label,.superpi-tool-head:hover .superpi-proc-path{color:var(--dsw-alias-label-primary)}',
      '.superpi-proc-head:focus-visible,.superpi-tool-head:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '.superpi-proc-icon{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:16px;height:16px;margin-right:11px;color:var(--dsw-alias-label-tertiary)}',
      '.superpi-proc-label{flex:0 0 auto;font-weight:400;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}',
      // 行内三段间距统一 11：图标→label（见上一行 margin-right）、label→圆点、圆点→摘要。
      // 参考图里这三段是 15 / 14 / 15 图 px，几乎等宽 —— 等宽才是「整齐」的来源；
      // 11 css 由 CJK 字形 ink 宽 16 图 px = 13 css 定出比例尺 ≈1.23 换算而来。
      '.superpi-sep{flex:0 0 auto;width:2px;height:2px;margin:0 11px;border-radius:1px;background:var(--dsw-alias-label-caption)}',
      '.superpi-proc-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}',
      '.superpi-proc-text[data-tone="err"]{color:var(--dsw-alias-state-error-primary)}',
      '.superpi-proc-text[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary)}',
      '.superpi-proc-note{flex:0 0 auto;margin-left:8px;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.superpi-proc-note[data-tone="err"]{color:var(--dsw-alias-state-error-primary)}',
      '.superpi-proc-note[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary)}',
      // 可点路径：DSH 用 1px 点线下划线 + 3px 偏移，颜色与正文一致，不额外染色。
      '.superpi-proc-path{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:0;padding:0;border:0;background:0 0;color:inherit;font:inherit;line-height:inherit;text-align:left;text-decoration:underline 1px dotted;text-underline-offset:3px;cursor:pointer}',
      '.superpi-proc[data-state="running"] .superpi-sep,.superpi-tool[data-state="running"] .superpi-sep{background:var(--dsw-alias-state-business-primary);animation:superpi-pulse 1.2s ease-in-out infinite}',
      // 子行组：模型「做了什么」缩进成一组，靠一条左侧竖线归组。
      // 横向：margin-left 26 让竖线落在父行 label 左缘（图标 16 + margin-right 11 = 27，差 1 是给
      // 1px 描边的亚像素让位），padding-left 12 让子行图标距竖线 12（≈参考图 15 图 px ÷ 1.23）；
      // 于是子行图标相对父行整体右移 38，与参考图的 46 图 px ÷ 1.23 ≈ 37 同量级。
      // 纵向：组内 gap 与 body 一样是 8、行盒沿用父行的 24 ⇒ 子行步长 32，与父行完全同节奏；
      // 上下 padding 归零，使「父行→首个子行」和「组末→下一父行」也是 32，整段过程流是一张
      // 均匀的网格。早先子行压到 16px 行盒 + gap 0，行距只剩父行一半，看着像被挤扁。
      '.superpi-sub{display:flex;flex-direction:column;gap:8px;margin:0 0 0 26px;padding:0 0 0 12px;border-left:1px solid var(--dsw-alias-border-l3)}',
      // 展开区：与图标列对齐的 22px 缩进 + 左侧竖线，和 DSH 折叠体同一套语言。
      '.superpi-proc-body{margin:2px 0 2px 26px;padding:0 0 0 14px;border-left:1px solid var(--dsw-alias-border-l3);white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-tertiary);line-height:calc(22px + var(--dsh-content-font-delta,0px))}',
      '.superpi-tool-body{margin:2px 0 4px;padding:0 0 0 14px;border-top:0;border-left:1px solid var(--dsw-alias-border-l3);max-height:340px;overflow:auto;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:var(--dsw-font-xxxs-11-font-size);line-height:18px;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary)}',
      // 底部「正在生成」行：DSH 在过程流末尾放一条极淡横线 + 一行状态。
      // 颜色 / 字号 / 行高一律取 DSH running 行（ChatView.module.css）的原式：
      // 文字是 brand 蓝 --dsw-alias-label-deep-diving（= color-mix(#4176e6 70%, #172554) = #345EBA），
      // 字号是正文 - 2px（14-2=12），行高 22px —— 都比过程行（13/24）小一号，视觉上退到过程流之后。
      '.superpi-working{display:flex;align-items:center;gap:6px;margin-top:2px;padding-top:10px;border-top:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-deep-diving);font-size:calc(var(--dsh-content-font-size,14px) - 2px);line-height:calc(22px + var(--dsh-content-font-delta,0px))}',
      // 0.14.2：与命令行窗口对齐 —— 图标放大 14px → 18px，动效从「呼吸」改成「旋转」。
      // 端点端语义必须一致：TUI 那边是 8 帧月相在转，面板这边只闪烁就会让人觉得"这边卡住了"。
      // CSS 动画由浏览器合成线程驱动，与 SSE/重绘无关，所以天然不会"停下来静止"（这是 TUI 端最大的坑）。
      '.superpi-working-icon{flex:0 0 auto;display:inline-flex;width:18px;height:18px;animation:superpi-spin 1.6s linear infinite}',
      '@keyframes superpi-spin{0%{transform:rotate(0)}100%{transform:rotate(360deg)}}',
      '.superpi-working-text{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}',
      // 当前工具段：与主文案同色但更弱，等宽数字避免秒数跳动时抖动。
      '.superpi-working-tool{flex:0 1 auto;min-width:0;margin-left:8px;padding-left:8px;border-left:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-tertiary);font-size:var(--dsw-font-xxxs-11-font-size);line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-variant-numeric:tabular-nums}',

      // 状态标签 = DSH ._tag 的四种 tone（run/success/warning/danger）
      '.superpi-tag{display:inline-flex;align-items:center;height:17px;padding:1px 8px;border:0;border-radius:999px;corner-shape:round;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:var(--dsw-font-xxxs-11-font-size);line-height:var(--dsw-font-xxxs-11-line-height);font-weight:500;white-space:nowrap}',
      '.superpi-tag[data-tone="run"]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent);color:var(--dsw-alias-state-business-primary)}',
      '.superpi-tag[data-tone="ok"]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);color:var(--dsw-alias-state-success-primary)}',
      '.superpi-tag[data-tone="err"]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-state-error-primary)}',
      '.superpi-tag[data-tone="warn"]{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);color:var(--dsw-alias-state-warn-primary)}',
      '.superpi-usage{margin-top:2px;font-size:var(--dsw-font-xxxs-11-font-size);line-height:var(--dsw-font-xxxs-11-line-height);color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums}',
      '.superpi-caret{display:inline-block;width:6px;height:14px;margin-left:2px;background:var(--dsw-alias-label-secondary);animation:superpi-pulse 1s steps(2) infinite;vertical-align:text-bottom}',
      '.superpi-img{max-width:min(100%,360px);max-height:240px;border:0;border-radius:var(--dsw-radius-md);cursor:zoom-in;display:block}',
      // 历史图片占位卡（0.14.0）：不发 base64，点开才取真实像素。
      // 外观刻意做成"可点的中性块"而不是缩略图轮廓 —— 免得用户以为图加载失败了。
      '.superpi-imagestub{display:inline-flex;align-items:center;gap:6px;height:26px;margin:2px 0;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:var(--dsw-font-xxxs-11-font-size);line-height:18px;cursor:pointer;transition:background-color .16s ease,color .16s ease}',
      '.superpi-imagestub:hover{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary)}',
      '.superpi-imagestub-icon{opacity:.72}',
      // 「加载更早」入口：只在还有更早历史时出现，贴在列表顶部。
      '.superpi-earlier{display:flex;justify-content:center;padding:10px 0 2px}',
      '.superpi-earlier button{height:26px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l3);border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:var(--dsw-font-xxxs-11-font-size);cursor:pointer}',
      '.superpi-earlier button:hover{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary)}',
      '.superpi-earlier button[disabled]{opacity:.55;cursor:default}',
      '.superpi-img-open{position:fixed;inset:0;z-index:60;background:var(--dsw-alias-bg-mask-photo);display:flex;align-items:center;justify-content:center;padding:40px;cursor:zoom-out}',
      '.superpi-img-open img{max-width:100%;max-height:100%;border-radius:var(--dsw-radius-md)}',
      // 结论里的文件 = 可点标签（用户 m22969：过程里生成的文件要点得开）。
      // 用 button 而不是 span：Tab 能落到它上面、Enter 能打开，焦点环由根选择器统一兜底。
      // 目录段压暗、文件名提亮，长路径只截目录不截名字 —— 名字才是识别依据。
      '.superpi-fileref{display:inline-flex;align-items:center;gap:4px;max-width:100%;margin:0 1px;padding:0 6px;border:0;border-radius:var(--dsw-radius-sm);box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:var(--dsw-font-xxxs-11-font-size);line-height:20px;vertical-align:baseline;cursor:pointer;transition:background-color .16s ease,box-shadow .16s ease}',
      '.superpi-fileref:hover{background:var(--dsw-alias-interactive-bg-hover);box-shadow:inset 0 0 0 .5px var(--dsw-alias-state-business-primary)}',
      '.superpi-fileref svg{flex:0 0 auto;color:var(--dsw-alias-state-business-primary)}',
      '.superpi-fileref-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.superpi-fileref-dir{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}',
      '.superpi-fileref-block{margin:8px 0;padding:0 10px;line-height:26px}',

      // ── 空态 / 运行时引导 ───────────────────────────────────────────────────
      '.superpi-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:48px 24px;text-align:center;color:var(--dsw-alias-label-secondary);flex:1 1 auto}',
      '.superpi-empty h2{margin:4px 0 0;font:var(--dsw-font-base-strong-16);color:var(--dsw-alias-label-primary)}',
      '.superpi-empty p{margin:0;max-width:420px;font-size:var(--dsw-font-s-14-font-size);line-height:var(--dsw-font-s-14-line-height);color:var(--dsw-alias-label-secondary)}',
      '.superpi-empty-meta{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:var(--dsw-font-xxs-12-font-size);line-height:var(--dsw-font-xxs-12-line-height);color:var(--dsw-alias-label-caption);word-break:break-all}',
      '.superpi-empty-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:4px}',
      '.superpi-center{flex:1 1 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:32px;color:var(--dsw-alias-label-secondary)}',
      '.superpi-gate{flex:1 1 auto;display:flex;align-items:center;justify-content:center;padding:24px}',
      '.superpi-gate-card{max-width:520px;width:100%;display:flex;flex-direction:column;gap:10px;padding:20px;border:0;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-panel)}',
      '.superpi-gate-card h3{margin:0;font:var(--dsw-font-base-strong-16)}',
      '.superpi-gate-actions{display:flex;gap:8px;flex-wrap:wrap}',
      '.superpi-gate-path{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:var(--dsw-font-xxxs-11-font-size);line-height:18px;color:var(--dsw-alias-label-tertiary);word-break:break-all}',
      '.superpi-gate-searched{display:flex;flex-direction:column;gap:2px;font-size:var(--dsw-font-xxxs-11-font-size);line-height:18px;color:var(--dsw-alias-label-dimmed)}',

      // ── 输入区 ──────────────────────────────────────────────────────────────
      // Composer 的卡面与行布局逐条对齐宿主主对话区（dsh-client-ui-conversation 的 composer）：
      // 28px 圆角 + specific-input-major 底 + soft elevation、顶部 8px 内缩、12px 行距，
      // 行内左侧圆形「+」、右侧圆形发送键。宿主里这些是硬编码的 CSS 变量引用，
      // 这里同样只引用令牌，深浅色与品牌色由主题注入。
      // 容器是 column + 居中：卡与 dock 同宽同心，跟宿主 .GRgSLq_root 一样。
      '.superpi-composer{flex:0 0 auto;background:var(--dsw-alias-bg-base);display:flex;flex-direction:column;align-items:center;padding:0 12px 4px;position:relative}',
      '.superpi-composer-inner{display:flex;flex-direction:column;gap:6px;width:100%;min-width:0}',
      '.superpi-box{position:relative;display:flex;flex-direction:column;gap:12px;padding-top:8px;border:0;border-radius:var(--dsw-radius-panel);background:var(--dsw-specific-input-major);box-shadow:var(--dsw-elevation-soft);transition:box-shadow .16s ease}',
      // 聚焦时把 elevation 的描边层换成品牌色：既保留投影，又给出焦点反馈（宿主同理）。
      '.superpi-box:focus-within{--dsw-elevation-stroke-color:var(--dsw-alias-state-business-primary)}',
      '.superpi-widget{display:flex;flex-direction:column;gap:2px;padding:8px 10px 0}',
      '.superpi-widget-body{margin:0;padding:6px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:var(--dsw-font-xxxs-11-font-size);line-height:18px;white-space:pre-wrap;word-break:break-word;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);max-height:120px;overflow:auto}',
      // dock：卡下方的统计行（宿主 .GRgSLq_dock）—— 居中、12px 间距、上方 4px。
      // 状态文案（steering / 排队）与统计数字共用一行，中点分隔。
      '.superpi-statusbar{display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap;max-width:100%;padding:4px 2px 0;font-size:var(--dsw-font-xxxs-11-font-size);line-height:18px;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums}',
      '.superpi-statusbar span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:240px}',
      '.superpi-ta{box-sizing:border-box;width:100%;min-height:52px;max-height:220px;resize:none;border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary);caret-color:var(--dsw-alias-state-business-primary);padding:4px 8px 0 14px;font-family:inherit;font-size:var(--dsw-font-s-14-font-size);line-height:calc(24px + var(--dsh-content-font-delta,0px))}',
      '.superpi-ta::placeholder{color:var(--dsw-alias-label-caption)}',
      '.superpi-bar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;min-width:0;padding:2px 8px 6px}',
      '.superpi-bar-actions{display:flex;align-items:center;gap:8px;min-width:0;flex:0 1 auto}',
      '.superpi-bar-right{display:flex;align-items:center;gap:8px;flex:1 1 auto;min-width:0;justify-content:flex-end}',
      '.superpi-bar-hint{min-width:0;font-size:var(--dsw-font-xxxs-11-font-size);line-height:18px;color:var(--dsw-alias-label-caption);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      // 「+」：宿主 ._add —— 28×28 圆形、selector 底、图标居中。
      '.superpi-add-wrap{position:relative;flex:0 0 auto;display:flex}',
      '.superpi-add{display:grid;place-items:center;width:28px;height:28px;padding:0;border:0;border-radius:999px;background:var(--dsw-specific-selector);color:var(--dsw-alias-label-primary);cursor:pointer;transition:background-color .12s ease}',
      '.superpi-add:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}',
      '.superpi-add:disabled{opacity:.5;cursor:not-allowed}',
      '.superpi-add[data-open="1"]{background:var(--dsw-alias-interactive-bg-hover-solid)}',
      // 模型 / 推理等级选择器：宿主 ._select —— 28 高、透明底、13px 次级色、hover 才出底。
      '.superpi-picker{display:inline-flex;align-items:center;gap:4px;max-width:220px;height:28px;padding:0 6px 0 8px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:var(--dsw-font-xs-13-font-size);line-height:var(--dsw-font-xs-13-line-height);font-weight:500;cursor:pointer;transition:background-color .12s ease}',
      '.superpi-picker:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}',
      '.superpi-picker:disabled{opacity:.5;cursor:not-allowed}',
      '.superpi-picker-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  // 档位按钮与模型按钮并排：两者外观同源（.superpi-picker），档位那个只多一点左边距，
  // 免得两个 28px 胶囊贴在一起看不出边界。
  '.superpi-picker-level{margin-left:2px;padding:0 6px 0 8px}',
  '.superpi-picker-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      // 发送键：宿主 ._primary —— 34×34 圆形、info-fill 底、上移 2px。
      '.superpi-send{flex:0 0 auto;display:grid;place-items:center;width:34px;height:34px;padding:0;border:0;border-radius:999px;background:var(--dsw-alias-button-info-fill);color:var(--dsw-alias-label-primary-foreground);cursor:pointer;transform:translateY(-2px);transition:background-color .1s ease}',
      '.superpi-send:hover:not(:disabled){background:var(--dsw-alias-button-info-hover)}',
      '.superpi-send:disabled{opacity:.4;cursor:default}',
      '.superpi-stop{flex:0 0 auto;display:grid;place-items:center;width:34px;height:34px;padding:0;border:0;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary);cursor:pointer;transform:translateY(-2px);transition:background-color .1s ease}',
      '.superpi-stop:hover{background:var(--dsw-alias-interactive-bg-hover-danger)}',
      '.superpi-thumbs{display:flex;flex-wrap:wrap;gap:6px;padding:8px 10px 0}',
      '.superpi-thumb{position:relative;width:52px;height:52px;border-radius:var(--dsw-radius-sm);overflow:hidden;box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l3)}',
      '.superpi-thumb img{width:100%;height:100%;object-fit:cover;display:block}',
      '.superpi-thumb-x{position:absolute;top:2px;right:2px;width:16px;height:16px;line-height:16px;text-align:center;border:0;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-mask-1);color:var(--dsw-static-neutral-bluish-00);font-size:11px;cursor:pointer;padding:0}',
      '.superpi-thumb-x:hover{background:var(--dsw-alias-bg-mask-2)}',

      // 弹出菜单 = DSH ._list（padding 4 / radius-lg / specific-menu / 毛玻璃 / elevation-panel）
      '.superpi-menu{position:absolute;left:0;right:0;bottom:calc(100% + 4px);z-index:20;display:flex;flex-direction:column;max-height:min(46vh,360px);overflow:hidden;padding:4px;border:0;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);box-shadow:var(--dsw-elevation-panel);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1)}',
      '.superpi-menu-head{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:0;font-size:var(--dsw-font-xxxs-11-font-size);line-height:var(--dsw-font-xxxs-11-line-height);color:var(--dsw-alias-label-tertiary)}',
      '.superpi-menu-list{overflow-y:auto;min-height:0;padding:0}',
      '.superpi-item{display:flex;align-items:center;gap:6px;width:100%;min-height:34px;padding:6px 8px;border:0;border-radius:var(--dsw-radius-md);background:transparent;cursor:pointer;font-size:var(--dsw-font-xs-13-font-size);line-height:var(--dsw-font-xs-13-line-height);color:var(--dsw-alias-label-primary);text-align:left}',
      '.superpi-item[data-active="1"]{background:var(--dsw-alias-interactive-bg-hover)}',
      '.superpi-item[data-disabled="1"]{opacity:.4;cursor:not-allowed}',
      '.superpi-item-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:0}',
      '.superpi-item-name{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.superpi-item-desc{font-size:var(--dsw-font-xxxs-11-font-size);line-height:var(--dsw-font-xxxs-11-line-height);color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.superpi-item-side{flex:0 0 auto;font-size:var(--dsw-font-xxxs-11-font-size);line-height:var(--dsw-font-xxxs-11-line-height);color:var(--dsw-alias-label-caption)}',
      '.superpi-empty-row{padding:12px;text-align:center;color:var(--dsw-alias-label-dimmed);font-size:var(--dsw-font-xxs-12-font-size);line-height:var(--dsw-font-xxs-12-line-height)}',

      // 「+」菜单：宿主是两列（左图标 + 主标签 + 英文键，右灰色说明）。宽度按内容走，
      // 不再像 slash 补全那样撑满卡片。
      '.superpi-menu-add{left:0;right:auto;min-width:288px;max-width:min(360px,calc(100vw - 48px))}',
      '.superpi-menu-section{padding:8px 8px 4px;font-size:var(--dsw-font-xxxs-11-font-size);line-height:var(--dsw-font-xxxs-11-line-height);color:var(--dsw-alias-label-caption)}',
      '.superpi-add-item{display:flex;align-items:center;gap:10px;width:100%;min-height:34px;padding:6px 8px;border:0;border-radius:var(--dsw-radius-md);background:transparent;cursor:pointer;font-size:var(--dsw-font-xs-13-font-size);line-height:var(--dsw-font-xs-13-line-height);color:var(--dsw-alias-label-primary);text-align:left}',
      '.superpi-add-item[data-active="1"]{background:var(--dsw-alias-interactive-bg-hover)}',
      '.superpi-add-icon{display:grid;place-items:center;flex:0 0 auto;width:20px;height:20px;color:var(--dsw-alias-label-secondary)}',
      '.superpi-add-text{display:flex;align-items:baseline;gap:6px;min-width:0;flex:1 1 auto}',
      '.superpi-add-label{flex:0 0 auto;white-space:nowrap}',
      '.superpi-add-key{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:var(--dsw-font-xxxs-11-font-size);line-height:var(--dsw-font-xxxs-11-line-height);color:var(--dsw-alias-label-caption)}',
      '.superpi-add-desc{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--dsw-font-xxxs-11-font-size);line-height:var(--dsw-font-xxxs-11-line-height);color:var(--dsw-alias-label-tertiary)}',

      // ── 提示 ────────────────────────────────────────────────────────────────
      '.superpi-alert{padding:8px 12px;border:0;border-radius:var(--dsw-radius-sm);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-state-error-primary);font-size:var(--dsw-font-xxs-12-font-size);line-height:var(--dsw-font-xxs-12-line-height);white-space:pre-wrap;word-break:break-word}',
      /**
       * 畸形输出告警（0.16.2）。
       *
       * 用 warn 色而不是 error 色：这不是「出错了」，而是「这一轮没执行、重发即可」——
       * 用户在 error 红条下会以为程序坏了，然后去查网络（实测已两次误归因）。
       * 布局用 column + gap，让文字、按钮、说明各占一行；窄面板下不换行错位。
       */
      '.superpi-verdict-box{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:var(--dsw-radius-sm);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);color:var(--dsw-alias-state-warn-primary);font-size:var(--dsw-font-xxs-12-font-size);line-height:var(--dsw-font-xxs-12-line-height)}',
      '.superpi-verdict-text{word-break:break-word}',
      '.superpi-verdict-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.superpi-verdict-retry{flex:0 0 auto}',
      '.superpi-verdict-detail{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-caption);font-size:var(--dsw-font-xxxs-11-font-size);line-height:var(--dsw-font-xxxs-11-line-height)}',
      '.superpi-notice{padding:8px 12px;border:0;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:var(--dsw-font-xxs-12-font-size);line-height:var(--dsw-font-xxs-12-line-height)}',
      '.superpi-notice[data-tone="err"]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-state-error-primary)}',
      '.superpi-notice[data-tone="warn"]{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);color:var(--dsw-alias-state-warn-primary)}',
      '.superpi-notice[data-tone="ok"]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);color:var(--dsw-alias-state-success-primary)}',
      '.superpi-queue{display:flex;align-items:center;gap:8px;font-size:var(--dsw-font-xxxs-11-font-size);line-height:18px;color:var(--dsw-alias-label-tertiary)}',

      // ── 抽屉 ────────────────────────────────────────────────────────────────
      // DSH ._float 的配方：bg-layer-2 + radius-panel + elevation-prominent + 局部描边色。
      '.superpi-sheet{position:absolute;inset:0;z-index:30;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base)}',
      '.superpi-sheet-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:.5px solid var(--dsw-alias-border-l2);flex:0 0 auto}',
      // 关闭按钮：28x28 命中区与 .superpi-btn 基线对齐，图标 16px（覆盖 .superpi-btn svg 的 15px），
      // 右边距收紧 4px，视觉上与 14px 内边距的标题栏同宽。
      '.superpi-sheet-head .superpi-btn-icon,.superpi-dir-head .superpi-btn-icon{width:32px;height:32px;margin-right:-4px}',
      '.superpi-sheet-head .superpi-btn-icon svg,.superpi-dir-head .superpi-btn-icon svg{width:16px;height:16px}',
      '.superpi-sheet-title{flex:1 1 auto;min-width:0;font:var(--dsw-font-base-strong-16);color:var(--dsw-alias-label-primary)}',
      '.superpi-search{height:28px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:var(--dsw-font-xxs-12-font-size);line-height:var(--dsw-font-xxs-12-line-height);outline:0;min-width:0;transition:border-color .16s ease}',
      '.superpi-search:focus{border-color:var(--dsw-alias-state-business-primary)}',
      '.superpi-search::placeholder{color:var(--dsw-alias-label-dimmed)}',
      '.superpi-sheet-body{flex:1 1 auto;min-height:0;overflow-y:auto;padding:12px 14px 16px;display:flex;flex-direction:column;gap:8px}',
      // ── 用户自定义规则（0.10.0）──────────────────────────────────────────
      // 整区是一张「设置项卡片」：与上面的开关同宽，视觉上属于同一组设置项。
      '.superpi-rules{display:flex;flex-direction:column;gap:6px;padding:12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2)}',
      '.superpi-rules[data-empty="1"]{box-shadow:inset 0 0 0 .5px var(--dsw-alias-state-warn-primary)}',
      '.superpi-rules-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.superpi-rules-title{flex:1 1 auto;min-width:0;font-size:var(--dsw-font-s-14-font-size);line-height:var(--dsw-font-s-14-line-height);color:var(--dsw-alias-label-primary);font-weight:500}',
      // 徽标：不靠纯色块传意，文本本身就是内容（无障碍读屏也能读出来）。
      '.superpi-rules-badge{flex:0 0 auto;padding:1px 6px;border-radius:999px;corner-shape:round;font-size:var(--dsw-font-xxxs-11-font-size);line-height:18px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
      '.superpi-rules-badge[data-tone="top"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);color:var(--dsw-alias-brand-primary)}',
      '.superpi-rules-line{font-size:var(--dsw-font-xxs-12-font-size);line-height:var(--dsw-font-xxs-12-line-height);color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.superpi-rules-line[data-tone="muted"]{color:var(--dsw-alias-label-tertiary)}',
      '.superpi-rules-line[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary);white-space:normal}',
      '.superpi-rules-line[data-tone="err"]{color:var(--dsw-alias-state-error-primary);white-space:normal}',
      '.superpi-rules-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:2px}',
      // 模型模态（0.13.0）：一行一个模型，右侧是模态 chip。
      // 限高滚动：模型可能有几十个，不能让设置弹窗被列表撑爆；滚动条只在超长时出现。
      '.superpi-mod-section{display:flex;flex-direction:column;gap:8px;margin-top:4px}',
      '.superpi-mod-list{display:flex;flex-direction:column;gap:2px;max-height:260px;overflow-y:auto;overscroll-behavior:contain;padding-right:2px}',
      '.superpi-mod-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:5px 8px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1)}',
      '.superpi-mod-row:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.superpi-mod-name-wrap{display:flex;flex-direction:column;gap:1px;min-width:0}',
      '.superpi-mod-name{font-size:var(--dsw-font-xxs-12-font-size);line-height:var(--dsw-font-xxs-12-line-height);color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.superpi-mod-provider{font-size:var(--dsw-font-xxxs-11-font-size);line-height:var(--dsw-font-xxxs-11-line-height);color:var(--dsw-alias-label-caption)}',
      '.superpi-mod-chips{display:flex;gap:4px;flex:0 0 auto}',
      '.superpi-mod-chip{padding:2px 8px;border:0;border-radius:999px;corner-shape:round;font:inherit;font-size:var(--dsw-font-xxxs-11-font-size);line-height:16px;cursor:pointer;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-tertiary);transition:background-color .16s ease,color .16s ease}',
      '.superpi-mod-chip[data-on="1"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);color:var(--dsw-alias-brand-primary)}',
      '.superpi-mod-chip[data-locked="1"]{cursor:default;opacity:.85}',
      '.superpi-mod-chip:hover:not([data-locked="1"]){background:var(--dsw-alias-interactive-bg-hover)}',
      '.superpi-mod-chip:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
      // 编辑框：与搜索框同一套 token，但允许多行、可纵向调高；高度固定 14 行以免抽屉高度跳动。
      '.superpi-rules-textarea{width:100%;box-sizing:border-box;resize:vertical;min-height:220px;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:var(--dsw-font-xxs-12-font-size);line-height:1.6;outline:0;transition:border-color .16s ease}',
      '.superpi-rules-textarea:focus{border-color:var(--dsw-alias-state-business-primary)}',
      '.superpi-rules-textarea::placeholder{color:var(--dsw-alias-label-dimmed)}',
      // 项目层与会话层共用一套行视觉（.superpi-proj 只是语义钩子，样式与 .superpi-sess 完全一致）。
      '.superpi-sess,.superpi-proj{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border:0;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l2);cursor:pointer;transition:background-color .16s ease,box-shadow .16s ease}',
      '.superpi-sess:hover,.superpi-proj:hover{background:var(--dsw-alias-bg-layer-2);box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l4)}',
      '.superpi-sess[data-current="1"],.superpi-proj[data-current="1"]{box-shadow:inset 0 0 0 .5px var(--dsw-alias-state-business-primary)}',
      '.superpi-proj[data-temporary="1"] .superpi-sess-title{color:var(--dsw-alias-label-secondary)}',
      '.superpi-sess-top{display:flex;align-items:center;gap:6px;font-size:var(--dsw-font-xxs-12-font-size);line-height:var(--dsw-font-xxs-12-line-height);color:var(--dsw-alias-label-secondary)}',
      // 会话数/标签不许换行：0.7.0 实拍里「1 个会话」被挤成两行（「话」掉到第二行），卡片从 60px 涨到 96px。
      '.superpi-sess-top > span{flex:0 0 auto;white-space:nowrap}',
      '.superpi-sess-title{flex:1 1 auto;min-width:0;font-weight:500;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.superpi-sess-line{font-size:var(--dsw-font-xxs-12-font-size);line-height:var(--dsw-font-xxs-12-line-height);color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.superpi-mono{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:var(--dsw-font-xxxs-11-font-size);line-height:18px;color:var(--dsw-alias-label-tertiary);word-break:break-all}',
      // 侧栏/侧栏式列表里的路径行只占一行：break-all 会让长路径折成两三行、把卡片高度撑到 96px。
      '.superpi-sess .superpi-mono,.superpi-proj .superpi-mono{word-break:normal;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.superpi-kv{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:var(--dsw-font-xxs-12-font-size);line-height:var(--dsw-font-xxs-12-line-height)}',
      '.superpi-kv-k{color:var(--dsw-alias-label-tertiary)}',
      '.superpi-kv-v{color:var(--dsw-alias-label-primary);word-break:break-word;font-variant-numeric:tabular-nums}',
      '.superpi-tree{display:flex;flex-direction:column;gap:1px;font-size:var(--dsw-font-xxs-12-font-size);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace)}',
      '.superpi-tree-node{display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:var(--dsw-radius-sm);cursor:default}',
      '.superpi-tree-node[data-clickable="1"]{cursor:pointer}',
      '.superpi-tree-node[data-clickable="1"]:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.superpi-tree-node[data-leaf="1"]{background:var(--dsw-alias-interactive-bg-hover)}',
      '.superpi-tree-kind{flex:0 0 auto;color:var(--dsw-alias-label-caption);font-size:var(--dsw-font-xxxs-11-font-size);min-width:56px}',
      '.superpi-tree-text{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary)}',

      // 开关 = DSH ._switch（36x20 胶囊 + 20px 滑块 + aria-checked 驱动）
      '.superpi-switch{position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:999px;corner-shape:round;background:var(--dsw-alias-border-l3);cursor:pointer;transition:background-color .16s ease}',
      '.superpi-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary)}',
      '.superpi-switch:disabled{cursor:default;opacity:.5}',
      '.superpi-switch-thumb{display:block;width:16px;height:16px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-label-primary-foreground);transition:transform .12s ease}',
      '.superpi-switch[aria-checked="false"] .superpi-switch-thumb{background:var(--dsw-alias-switch-thumb)}',
      '.superpi-switch[aria-checked="true"] .superpi-switch-thumb{transform:translate(16px)}',
      '.superpi-switch-row{display:grid;grid-template-columns:1fr auto;align-items:center;gap:12px}',
      '.superpi-switch-label{font-size:var(--dsw-font-s-14-font-size);line-height:var(--dsw-font-s-14-line-height);color:var(--dsw-alias-label-primary)}',

      // ── 工作目录选择（DirSheet）────────────────────────────────────────────
      // 对齐 DSH directory-picker：头部面包屑 + 可编辑路径，主体左「层级」右「子项」两栏。
      '.superpi-dir{display:flex;flex-direction:column;gap:8px;flex:1 1 auto;min-height:0}',
      '.superpi-dir-crumbs{display:flex;align-items:center;gap:2px;flex-wrap:wrap;min-height:20px}',
      '.superpi-dir-crumb{padding:1px 6px;border:0;border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:var(--dsw-font-xxs-12-font-size);line-height:18px;cursor:pointer}',
      '.superpi-dir-crumb:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.superpi-dir-crumb[data-last="1"]{color:var(--dsw-alias-label-primary);font-weight:500}',
      '.superpi-dir-sep{color:var(--dsw-alias-label-dimmed);font-size:var(--dsw-font-xxs-12-font-size);line-height:18px}',
      '.superpi-dir-cols{display:flex;gap:1px;flex:1 1 auto;min-height:240px;overflow:hidden;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1)}',
      '.superpi-dir-col{display:flex;flex-direction:column;min-width:0;flex:1 1 0;overflow-y:auto;padding:4px}',
      '.superpi-dir-col+.superpi-dir-col{border-left:.5px solid var(--dsw-alias-border-l2)}',
      '.superpi-dir-item{display:flex;align-items:center;gap:6px;width:100%;min-height:30px;padding:4px 8px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:var(--dsw-font-xs-13-font-size);line-height:var(--dsw-font-xs-13-line-height);text-align:left;cursor:pointer}',
      '.superpi-dir-item:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.superpi-dir-item[data-selected="1"]{background:var(--dsw-alias-interactive-bg-active)}',
      '.superpi-dir-item[data-current="1"]{color:var(--dsw-alias-state-business-primary)}',
      '.superpi-dir-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.superpi-dir-mark{flex:0 0 auto;color:var(--dsw-alias-state-business-primary);font-size:var(--dsw-font-xxxs-11-font-size)}',
      '.superpi-dir-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.superpi-dir-hint{flex:0 0 auto;min-width:0;font-size:var(--dsw-font-xxxs-11-font-size);line-height:18px;color:var(--dsw-alias-label-caption);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.superpi-dir-target{flex:1 1 auto;min-width:0;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:var(--dsw-font-xxxs-11-font-size);line-height:18px;color:var(--dsw-alias-label-caption);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      // 弹窗外壳：对齐 DSH directory-picker 的 680x500，用 .superpi-dialog-wrap 提供的遮罩层居中。
      // 高度固定（而不是靠内容撑）是刻意的：Miller 两栏切换时列表高度必须稳定，
      // 否则用户点中一个目录、第二栏冒出来，整个弹窗会跳一下。
      '.superpi-dir-dialog{display:flex;flex-direction:column;width:min(680px,100%);height:min(500px,100%);overflow:hidden;border:0;border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);animation:superpi-modal-in .16s ease-in-out}',
      '.superpi-dir-head{display:flex;align-items:center;gap:8px;flex:0 0 auto;padding:14px 16px 10px 20px}',
      '.superpi-dir-title{flex:1 1 auto;min-width:0;font:var(--dsw-font-base-strong-16);color:var(--dsw-alias-label-primary)}',
      '.superpi-dir-dialog .superpi-dir{flex:1 1 auto;min-height:0;padding:0 20px 16px}',

      // ── 对话框 ──────────────────────────────────────────────────────────────
      // 对齐 DSH ._dialog：radius-panel + bg-layer-2 + elevation-prominent +
      // header(padding 22px 14px 12px 24px) / body / footer(24px) 三段留白。
      '.superpi-dialog-wrap{position:absolute;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-mask-1);padding:20px}',
      '.superpi-dialog{display:flex;flex-direction:column;width:min(440px,100%);max-height:100%;overflow:hidden;border:0;border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);animation:superpi-modal-in .16s ease-in-out}',
      '@keyframes superpi-modal-in{0%{opacity:0}to{opacity:1}}',
      '.superpi-dialog-head{display:flex;align-items:flex-start;gap:8px;padding:22px 18px 0 24px}',
      '.superpi-dialog-head h3{flex:1 1 auto;min-width:0;margin:0;padding:0;font:var(--dsw-font-base-strong-16);color:var(--dsw-alias-label-primary)}',
      '.superpi-dialog-head .superpi-btn-icon{width:32px;height:32px;margin-top:-6px}',
      '.superpi-dialog-head .superpi-btn-icon svg{width:16px;height:16px}',
      '.superpi-dialog .superpi-mono{margin:6px 24px 0}',
      '.superpi-dialog-msg{margin:0;padding:10px 24px 0;color:var(--dsw-alias-label-secondary);font-size:var(--dsh-content-font-size,var(--dsw-font-s-14-font-size));line-height:calc(22px + var(--dsh-content-font-delta,0px));white-space:pre-wrap;word-break:break-word}',
      '.superpi-dialog-body{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:6px;overflow-y:auto;padding:14px 24px 0}',
      '.superpi-dialog-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;padding:22px 24px 24px}',
      '.superpi-opt{display:flex;align-items:center;gap:8px;width:100%;min-height:34px;padding:6px 10px;border:0;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:var(--dsw-font-xs-13-font-size);line-height:var(--dsw-font-xs-13-line-height);text-align:left;cursor:pointer;transition:background-color .16s ease,box-shadow .16s ease}',
      '.superpi-opt:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.superpi-opt[data-active="1"]{box-shadow:inset 0 0 0 .5px var(--dsw-alias-state-business-primary)}',
      '.superpi-mini-ta{width:100%;min-height:84px;max-height:180px;padding:6px 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);resize:vertical;outline:0;transition:border-color .16s ease}',
      '.superpi-mini-ta:focus{border-color:var(--dsw-alias-state-business-primary)}',
      '.superpi-row2{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.superpi-spacer{flex:1 1 auto}',
      '.superpi-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}',

      // ── 动效偏好 ────────────────────────────────────────────────────────────
      '@media (prefers-reduced-motion: reduce){.superpi-root *,.superpi-root *::before,.superpi-root *::after{animation-duration:.01ms !important;animation-iteration-count:1 !important;transition-duration:.01ms !important}}',
      // 模型 / 推理档位合一弹层：点左下角模型名向上弹出，两段同屏（用户 30427）。
      // 复用 .superpi-menu 的底/阴影/毛玻璃，只改锚定与宽度。
      '.superpi-picker-box{position:relative;display:flex;align-items:center;min-width:0;flex:0 1 auto}',
      '.superpi-picker-menu{left:0;right:auto;bottom:calc(100% + 6px);min-width:260px;max-width:min(380px,calc(100vw - 48px))}',
      '.superpi-picker-sec{padding:8px 8px 4px;font-size:var(--dsw-font-xxxs-11-font-size);line-height:var(--dsw-font-xxxs-11-line-height);color:var(--dsw-alias-label-caption)}',
      '.superpi-picker-row{display:flex;align-items:center;gap:8px;width:100%;min-height:32px;padding:5px 8px;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:var(--dsw-font-xs-13-font-size);line-height:var(--dsw-font-xs-13-line-height);text-align:left;cursor:pointer}',
      '.superpi-picker-row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.superpi-picker-row[data-current="1"]{box-shadow:inset 0 0 0 .5px var(--dsw-alias-state-business-primary)}',
      '.superpi-picker-row-name{min-width:0;flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.superpi-picker-row-sub{flex:0 0 auto;font-size:var(--dsw-font-xxxs-11-font-size);line-height:16px;color:var(--dsw-alias-label-tertiary)}',
      '.superpi-picker-empty{padding:10px 8px;font-size:var(--dsw-font-xxs-12-font-size);color:var(--dsw-alias-label-dimmed)}',

      // 顶栏「更多」：与「+」菜单同一套面板配方，锚在按钮右下、向下展开。
      '.superpi-more-wrap{position:relative;display:flex}',
      '.superpi-more-menu{left:auto;right:0;top:calc(100% + 6px);bottom:auto;min-width:184px;max-width:min(260px,calc(100vw - 32px))}',
      '.superpi-more-item{display:flex;align-items:center;gap:8px;width:100%;min-height:32px;padding:6px 8px;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:var(--dsw-font-xs-13-font-size);line-height:var(--dsw-font-xs-13-line-height);text-align:left;cursor:pointer}',
      '.superpi-more-item:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.superpi-more-icon{display:grid;place-items:center;flex:0 0 auto;width:16px;height:16px;color:var(--dsw-alias-label-secondary)}',

      // 历史会话：从左侧滑出的侧栏（不再铺满面板）。
      '.superpi-side-wrap{position:absolute;inset:0;z-index:30;display:flex;background:var(--dsw-alias-bg-mask-1)}',
      '.superpi-side{display:flex;flex-direction:column;width:min(360px,86%);height:100%;background:var(--dsw-alias-bg-base);box-shadow:var(--dsw-elevation-panel);animation:superpi-side-in .18s ease-out}',
      '@keyframes superpi-side-in{0%{transform:translateX(-100%)}to{transform:translateX(0)}}',
      '.superpi-side-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:0 0 auto;padding:12px 10px 12px 16px;border-bottom:.5px solid var(--dsw-alias-border-l2)}',
      '.superpi-side-title{flex:1 1 auto;min-width:0;font:var(--dsw-font-base-strong-16);color:var(--dsw-alias-label-primary)}',
      '.superpi-side-body{flex:1 1 auto;min-height:0;overflow-y:auto;padding:12px 14px 16px;display:flex;flex-direction:column;gap:8px}',
      '.superpi-side-head .superpi-btn-icon{width:32px;height:32px;margin-right:-4px}',
      '.superpi-side-head .superpi-btn-icon svg{width:16px;height:16px}',
      '.superpi-side-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:0 0 auto;padding:0 16px 10px}',
      '.superpi-side-actions .superpi-search{flex:1 1 auto;min-width:0}',

      // 侧栏 + 行内 ⋯ 菜单（0.8.0）：宿主包一层是为了让「侧栏 + 重命名弹窗」能并存 ——
      // RenameDialog 走 Dialog（position:absolute 相对最近的定位祖先），必须在同一层里挂。
      '.superpi-side-host{position:absolute;inset:0;z-index:30;display:flex}',
      // 返回键在标题左侧：不能被右侧关闭键的 -4px 负边距规则带偏。
      '.superpi-side-head .superpi-side-back{width:28px;height:28px;margin-right:0;margin-left:-6px}',
      '.superpi-side-new{flex:0 0 auto;white-space:nowrap;gap:6px}',
      // 行内「⋯」：靠右、22px 命中区；菜单锚在按钮上（.superpi-more-menu 的 left:auto/right:0 正好接住）。
      '.superpi-row-more{position:relative;display:flex;flex:0 0 auto;margin-left:auto}',
      '.superpi-row-more > button{display:grid;place-items:center;width:22px;height:22px;padding:0;border:0;border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}',
      '.superpi-row-more > button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.superpi-row-more .superpi-more-menu{min-width:160px;max-width:min(220px,calc(100vw - 32px))}',
      // 会话标题（首条用户消息）单独占一格，压在消息数左侧；标题已是它时不再重复。
      '.superpi-sess-sum{flex:0 1 auto;max-width:44%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}',
      '.superpi-pin{display:grid;place-items:center;flex:0 0 auto;width:12px;height:12px;color:var(--dsw-alias-state-business-primary)}',

      // 居中弹窗的加宽变体：会话统计 / 设置的行数比通用 440px 多。
      '.superpi-dialog-wide{width:min(560px,100%)}',
      '.superpi-dialog-grow{flex:1 1 auto;min-height:0;overflow-y:auto}',
      '.superpi-more-label{min-width:0;flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      // 底部留 22px：内容滚动到底时最后一行不能贴住卡片圆角（实拍 p071-04 发现贴边）。
      '.superpi-dialog-content{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:8px;overflow-y:auto;padding:14px 24px 22px}',
    ].join('')


    // ── HTTP ────────────────────────────────────────────────────────────────

    function errorOf(status, body) {
      var message = 'HTTP ' + String(status)
      if (body !== null && typeof body === 'object' && typeof body.error === 'string' && body.error !== '') message = body.error
      else if (typeof body === 'string' && body.trim() !== '') message = body.trim().slice(0, 400)
      var error = new Error(message)
      error.status = status
      return error
    }

    function requestJson(path, init) {
      var options = init === null || init === undefined ? {} : init
      var headers = options.headers === undefined ? {} : options.headers
      var timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 20000
      var controller = typeof AbortController === 'function' ? new AbortController() : null
      var timer = null
      if (controller !== null && timeoutMs > 0) {
        timer = setTimeout(function () {
          controller.abort()
        }, timeoutMs)
      }
      var body = options.body
      var fetchInit = {
        method: options.method === undefined ? 'GET' : options.method,
        headers: headers,
        cache: 'no-store',
        redirect: 'error',
      }
      if (controller !== null) fetchInit.signal = controller.signal
      if (body !== undefined && body !== null) {
        headers['content-type'] = 'application/json'
        fetchInit.body = JSON.stringify(body)
      }
      return fetch(API_PREFIX + path, fetchInit).then(function (response) {
        if (timer !== null) clearTimeout(timer)
        return response.text().then(function (text) {
          var parsed = null
          if (text !== '') {
            try { parsed = JSON.parse(text) } catch (error) { parsed = text }
          }
          if (response.ok === false) throw errorOf(response.status, parsed)
          return parsed
        })
      }, function (error) {
        if (timer !== null) clearTimeout(timer)
        if (error !== null && error.name === 'AbortError') {
          var timedOut = new Error('request timed out (' + String(Math.round(timeoutMs / 1000)) + 's)')
          timedOut.code = 'timeout'
          throw timedOut
        }
        throw error
      })
    }

    var api = {
      state: function () { return requestJson('/state') },
      health: function () { return requestJson('/health') },
      contract: function () { return requestJson('/contract') },
      create: function (body) { return requestJson('/sessions', { method: 'POST', body: body === undefined ? {} : body, timeoutMs: 60000 }) },
      snapshot: function (id, since) {
        return requestJson('/sessions/' + encodeURIComponent(id) + '/snapshot?since=' + String(typeof since === 'number' ? since : 0))
      },
      command: function (id, body, timeoutMs) {
        return requestJson('/sessions/' + encodeURIComponent(id) + '/command', {
          method: 'POST',
          body: body,
          timeoutMs: typeof timeoutMs === 'number' ? timeoutMs : 120000,
        })
      },
      respond: function (id, body) {
        return requestJson('/sessions/' + encodeURIComponent(id) + '/respond', { method: 'POST', body: body, timeoutMs: 20000 })
      },
      close: function (id) { return requestJson('/sessions/' + encodeURIComponent(id), { method: 'DELETE', timeoutMs: 20000 }) },
      /**
       * 读历史会话。
       *
       * options.scope = 'all' → 扫 ~/.pi/agent/sessions 下所有项目（pi 的 SessionManager.listAll），
       * options.scope = 'project' + options.cwd → 只读该 cwd 那个目录，
       * 都不传时由 host 按有没有 cwd 推断（兼容旧调用）。
       */
      history: function (options) {
        var opts = options !== null && typeof options === 'object' ? options : {}
        var parts = ['limit=' + String(typeof opts.limit === 'number' ? opts.limit : 60)]
        if (opts.scope === 'all' || opts.scope === 'project') parts.push('scope=' + opts.scope)
        if (typeof opts.cwd === 'string' && opts.cwd !== '') parts.push('cwd=' + encodeURIComponent(opts.cwd))
        return requestJson('/sessions/history?' + parts.join('&'))
      },
      files: function (dir, query, limit) {
        var parts = ['limit=' + String(typeof limit === 'number' ? limit : 50)]
        if (typeof dir === 'string' && dir !== '') parts.push('dir=' + encodeURIComponent(dir))
        if (typeof query === 'string' && query !== '') parts.push('query=' + encodeURIComponent(query))
        return requestJson('/files?' + parts.join('&'))
      },
      /**
       * 读单个文件给右侧预览用（host GET /file）。
       * 文本超过 512KB 由 host 截断并回 truncated=true；二进制只回元信息不回内容。
       */
      file: function (target) {
        var text = String(target === undefined || target === null ? '' : target)
        return requestJson('/file?path=' + encodeURIComponent(text), { timeoutMs: 30000 })
      },
      /**
       * 在系统文件管理器里定位这个文件（host POST /reveal）。
       * host 侧 Windows 走 explorer /select，macOS 走 open -R，Linux 走 xdg-open 父目录；
       * explorer 的退出码不可信（成功也常回 1），所以这里只认 HTTP 结果，不看进程退出码。
       */
      reveal: function (target) {
        var text = String(target === undefined || target === null ? '' : target)
        return requestJson('/reveal', { method: 'POST', body: { path: text }, timeoutMs: 20000 })
      },
      directories: function (dir, query, limit) {
        var parts = ['limit=' + String(typeof limit === 'number' ? limit : 200)]
        if (typeof dir === 'string' && dir !== '') parts.push('dir=' + encodeURIComponent(dir))
        if (typeof query === 'string' && query !== '') parts.push('query=' + encodeURIComponent(query))
        return requestJson('/directories?' + parts.join('&'))
      },
      changelog: function () { return requestJson('/changelog') },
      selfcheck: function () { return requestJson('/selfcheck') },
      runtime: function () { return requestJson('/runtime') },
      install: function () { return requestJson('/runtime/install', { method: 'POST', body: {}, timeoutMs: 900000 }) },
      // 面板偏好（项目显示名 / 会话显示名与置顶）。三条都回全量结构，客户端不做增量合并。
      uiPrefs: function () { return requestJson('/ui-prefs') },
      setProjectPref: function (key, name) {
        return requestJson('/ui-prefs/project', { method: 'POST', body: { key: key, name: name } })
      },
      // patch 只带要改的字段（{ name } 或 { pinned }）：缺省的字段在 host 侧等于「别动它」。
      setSessionPref: function (sessionPath, patch) {
        return requestJson('/ui-prefs/session', { method: 'POST', body: Object.assign({ path: sessionPath }, patch) })
      },
      /**
       * 用户自定义规则（最高优先级）。
       *
       * 三条都回**全量视图**（text / checksum / empty / rank / isDefault / maxLength /
       * delivery.extensionInstalled …）。归一与校验在 host 的 extensions/superpi-rules.mjs 里，
       * 面板不重复一遍规则 —— 复制一份判定就是等它下次分叉。
       *
       * 为什么绕 host 而不是直接从浏览器读盘：浏览器没有 fs，而这份文件同时是 pi 扩展
       * 每轮 `before_agent_start` 读的那一份，走 host 读写才能保证「面板改什么、pi 用什么」。
       */
      /** 上下文守卫的真实占用：host 读观测日志最后一行（不依赖会话进程活着）。 */
      context: function (sessionId) {
        var query = typeof sessionId === 'string' && sessionId !== '' ? '?sessionId=' + encodeURIComponent(sessionId) : ''
        return requestJson('/context' + query)
      },
      /** 模型模态开关：状态 + 注册表（可用模态 / 默认值 / 锁定项）。 */
      modalities: function () { return requestJson('/modalities') },
      setModality: function (body) { return requestJson('/modalities', { method: 'POST', body: body }) },
      rules: function () { return requestJson('/rules') },
      setRules: function (text) { return requestJson('/rules', { method: 'POST', body: { text: text } }) },
      resetRules: function () { return requestJson('/rules/reset', { method: 'POST', body: {} }) },
    }

    /** command 的统一入口：成功返回 data，失败抛出带 command 名的错误。 */
    function rpc(id, payload, timeoutMs) {
      return api.command(id, payload, timeoutMs).then(function (body) {
        if (body === null || typeof body !== 'object') return null
        if (body.ok === false) throw new Error(typeof body.error === 'string' ? body.error : 'command failed')
        return body.data === undefined ? null : body.data
      })
    }

    // ── 消息归一化 ──────────────────────────────────────────────────────────

    function stringifyArgs(value) {
      if (value === null || value === undefined) return ''
      if (typeof value === 'string') return value
      try { return JSON.stringify(value, null, 2) } catch (error) { return String(value) }
    }

    /**
     * 把 pi 的 content block 转成面板内部形状。
     * image 保留原始 base64（走 <img src="data:...">），绝不能降级成文字占位——
     * 命令行的 pi 会把图片交给模型看，面板把图丢了就是能力缺失。
     *
     * 0.14.0 新增 `image-stub`：分页接口不传 base64（历史里 88.2% 的体积都是它），
     * 只给 `{ id, mimeType, bytes }`。面板**不是把图丢掉**，而是渲染一张
     * 「N KB · 点击查看」的占位卡，点开时才走 `/images/:id` 取回真实像素 ——
     * 能力等价，代价从「打开会话就传 48.6MB」降到「看哪张取哪张」。
     */
    function normalizeBlock(block) {
      if (block === null || typeof block !== 'object') return null
      if (block.type === 'text') return { type: 'text', text: String(block.text === undefined ? '' : block.text) }
      if (block.type === 'thinking') return { type: 'thinking', text: String(block.thinking === undefined ? (block.text === undefined ? '' : block.text) : block.thinking) }
      if (block.type === 'toolCall' || block.type === 'tool_call') {
        return {
          type: 'toolCall',
          id: block.id === undefined ? null : block.id,
          name: String(block.name === undefined ? 'tool' : block.name),
          argsText: stringifyArgs(block.arguments === undefined ? block.args : block.arguments),
        }
      }
      if (block.type === 'image') {
        return { type: 'image', data: String(block.data === undefined ? '' : block.data), mimeType: typeof block.mimeType === 'string' ? block.mimeType : 'image/png' }
      }
      if (block.type === 'image-stub') {
        return {
          type: 'image',
          data: '',
          mimeType: typeof block.mimeType === 'string' ? block.mimeType : 'image/png',
          stubId: typeof block.id === 'string' ? block.id : null,
          bytes: typeof block.bytes === 'number' ? block.bytes : 0,
        }
      }
      return { type: 'text', text: stringifyArgs(block) }
    }

    function blocksOf(content) {
      if (typeof content === 'string') return [{ type: 'text', text: content }]
      if (content === null || content === undefined) return []
      if (Array.isArray(content) === false) return [{ type: 'text', text: stringifyArgs(content) }]
      var blocks = []
      for (var i = 0; i < content.length; i += 1) {
        var block = normalizeBlock(content[i])
        if (block !== null) blocks.push(block)
      }
      return blocks
    }

    function makeMessage(raw, seq) {
      var message = raw === null || typeof raw !== 'object' ? {} : raw
      var role = typeof message.role === 'string' ? message.role : 'assistant'
      var toolName = null
      if (typeof message.toolName === 'string') toolName = message.toolName
      else if (role === 'toolResult' && typeof message.name === 'string') toolName = message.name
      return {
        seq: seq,
        role: role,
        blocks: blocksOf(message.content),
        streaming: false,
        stopReason: typeof message.stopReason === 'string' ? message.stopReason : null,
        usage: message.usage === undefined ? null : message.usage,
        toolName: toolName,
        toolCallId: typeof message.toolCallId === 'string' ? message.toolCallId : null,
        isError: message.isError === true,
        timestamp: message.timestamp === undefined ? null : message.timestamp,
        // bashExecution 是 pi 的自定义消息（命令行的 ! / !! 也就是它）。
        // 它只在 agent_end 之后落库、不产生 message_start/message_end 事件，
        // 面板必须靠 get_messages 回拉才能看到，所以这里把原始字段原样带上。
        bash: role === 'bashExecution' ? {
          command: String(message.command === undefined ? '' : message.command),
          output: String(message.output === undefined ? '' : message.output),
          exitCode: message.exitCode === undefined || message.exitCode === null ? null : message.exitCode,
          cancelled: message.cancelled === true,
          truncated: message.truncated === true,
        } : null,
      }
    }

    /**
     * 把 pi 的 get_messages 结果整形成面板消息列表。
     *
     * 只保留 pi 真正产生的对话消息（system 是每轮几十 KB 的提示词，面板不显示也不能塞进列表）。
     * seq 用数组下标：它只是 React 列表 key 的一部分，与 host 事件序号（view.lastSeq）无语义关联 ——
     * 混用会让 applyBatch 的去重逻辑误判，所以这里刻意不去碰 lastSeq。
     */
    function messagesFromHistory(list) {
      if (Array.isArray(list) === false) return null
      var next = []
      for (var i = 0; i < list.length; i += 1) {
        var raw = list[i]
        if (raw === null || typeof raw !== 'object') continue
        if (raw.role === 'system') continue
        // host 分页时给每条消息带上了它在**完整列表**里的下标 `seq`（0.14.0）。
        // 必须用它而不是 next.length：翻页拼接时数组下标会重排，只有完整列表下标
        // 才能用来去重和保持 React key 稳定；没有该字段（如事件流回放）就退回下标。
        var seq = typeof raw.seq === 'number' && Number.isFinite(raw.seq) && raw.seq >= 0 ? raw.seq : next.length
        next.push(makeMessage(raw, seq))
      }
      return next
    }

    function textOfMessage(message) {
      if (message === null || message === undefined) return ''
      var parts = []
      for (var i = 0; i < message.blocks.length; i += 1) {
        if (message.blocks[i].type === 'text') parts.push(message.blocks[i].text)
      }
      return parts.join('\n')
    }

    // ── 文件路径 → 可点标签 ───────────────────────────────────────────────────
    //
    // 助手回复里提到的文件必须能在结论里直接点开（用户 m22969）。面板不自己造预览器：
    // DSH 内置的 documentpreview 已经能渲染 markdown / 代码 / 图片，这里只负责把
    // session 作用域的文件地址交给 sidebarRight，让右栏去显示。
    //
    // 识别路径的原则是「宁可少认，不要误认」：只有能确定它是文件时才算，否则
    // /model、1.5、https://… 这些都会被误标成文件，反而让正文变得没法读。

    var FILE_URL = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//
    var FILE_EXT = /\.[A-Za-z0-9]{1,12}$/
    // 没有分隔符的裸文件名只认这些扩展名 —— 否则 example.com、v1.2.3 之类会被误标成文件。
    var FILE_BARE_EXT = {
      md: 1, markdown: 1, mdx: 1, txt: 1, rst: 1, log: 1, csv: 1, tsv: 1,
      json: 1, jsonl: 1, json5: 1, yml: 1, yaml: 1, toml: 1, ini: 1, cfg: 1, conf: 1, env: 1, properties: 1,
      js: 1, mjs: 1, cjs: 1, jsx: 1, ts: 1, tsx: 1, mts: 1, cts: 1, vue: 1, svelte: 1, astro: 1,
      py: 1, pyi: 1, ipynb: 1, rs: 1, go: 1, java: 1, kt: 1, kts: 1, swift: 1, dart: 1, lua: 1, rb: 1, php: 1, pl: 1, r: 1,
      c: 1, h: 1, cc: 1, cpp: 1, cxx: 1, hpp: 1, cs: 1, m: 1, mm: 1,
      sh: 1, bash: 1, zsh: 1, fish: 1, bat: 1, cmd: 1, ps1: 1, psm1: 1,
      sql: 1, graphql: 1, gql: 1, proto: 1, thrift: 1,
      html: 1, htm: 1, xhtml: 1, css: 1, scss: 1, sass: 1, less: 1, styl: 1,
      xml: 1, xsl: 1, svg: 1, plist: 1, gradle: 1, lock: 1, gitignore: 1, dockerignore: 1,
      png: 1, jpg: 1, jpeg: 1, gif: 1, webp: 1, bmp: 1, ico: 1, avif: 1, tif: 1, tiff: 1, psd: 1,
      pdf: 1, doc: 1, docx: 1, xls: 1, xlsx: 1, ppt: 1, pptx: 1, odt: 1, rtf: 1, epub: 1,
      zip: 1, tar: 1, gz: 1, tgz: 1, bz2: 1, xz: 1, rar: 1, '7z': 1, jar: 1, war: 1, whl: 1, exe: 1, msi: 1, dll: 1,
      mp3: 1, wav: 1, flac: 1, ogg: 1, mp4: 1, mov: 1, avi: 1, mkv: 1, webm: 1, woff: 1, woff2: 1, ttf: 1, otf: 1,
    }
    var FILE_BARE = /^[A-Za-z0-9._-]+\.([A-Za-z][A-Za-z0-9]{0,11})$/
    var FILE_ABS = /^(?:[A-Za-z]:[\\/]|\\\\|~[\\/]|\.{1,2}[\\/]|\/)/
    var FILE_TAIL = /[.,;:!?，。；：！？、)\]】}》」』·…]+$/
    var FILE_RUN = /[^\s"'<>|*?\u3000]+/g
    var FILE_LEAD = /[({\[「『（【]/
    var FILE_SEP = /[\\/]/

    /** 这个 token 是不是一条文件路径。 */
    function isFilePathToken(value) {
      if (typeof value !== 'string') return false
      if (value === '' || value.length > 400) return false
      if (FILE_URL.test(value)) return false
      if (/\s/.test(value)) return false
      if (FILE_TAIL.test(value)) return false
      // 必须以「带扩展名的末段」收尾，否则 .git、make 这类词也会被认成文件。
      if (FILE_EXT.test(value) === false) return false
      if (FILE_ABS.test(value)) return true
      if (FILE_SEP.test(value)) return true
      var bare = FILE_BARE.exec(value)
      if (bare === null) return false
      return FILE_BARE_EXT[bare[1].toLowerCase()] === 1
    }

    /** 把一段文本切成 [{ start, end, value }]，只返回能确认是文件路径的片段。 */
    function splitFileTokens(text) {
      var source = String(text === undefined || text === null ? '' : text)
      var out = []
      FILE_RUN.lastIndex = 0
      var match = null
      while ((match = FILE_RUN.exec(source)) !== null) {
        var raw = match[0]
        var lead = 0
        while (lead < raw.length && FILE_LEAD.test(raw.charAt(lead))) lead += 1
        var value = raw.slice(lead)
        var caret = value.length
        while (caret > 0 && FILE_TAIL.test(value.charAt(caret - 1))) caret -= 1
        value = value.slice(0, caret)
        if (value === '') continue
        if (isFilePathToken(value) === false) continue
        var start = match.index + lead
        out.push({ start: start, end: start + value.length, value: value })
      }
      return out
    }

    /**
     * 文件类型 → 图标。
     *
     * 标签上只留「图标 + 文件名」。既然路径被省掉了，类型就必须靠图标一眼看出来，
     * 否则 md / ts / png 在正文里长得一模一样，标签的信息量等于零。
     */
    var FILE_EXT_GROUPS = [
      ['code', 'js jsx mjs cjs ts tsx py rs go java kt kts c h cc cpp cxx hpp cs rb php swift sh bash zsh fish ps1 bat cmd sql html htm css scss sass less json jsonc json5 yml yaml toml ini cfg conf env xml vue svelte astro lua pl r dart ex exs erl hs ml clj gradle mk cmake dockerfile proto graphql gql'],
      ['image', 'png jpg jpeg gif webp bmp ico avif svg tif tiff heic heif psd'],
      ['archive', 'zip tar gz tgz bz2 xz zst 7z rar jar war iso dmg'],
      ['sheet', 'csv tsv xls xlsx xlsm ods numbers'],
      ['doc', 'md markdown mdx txt text rst log pdf doc docx odt rtf ppt pptx key pages epub'],
    ]
    var FILE_EXT_KIND = (function () {
      var table = {}
      for (var i = 0; i < FILE_EXT_GROUPS.length; i += 1) {
        var group = FILE_EXT_GROUPS[i]
        var names = group[1].split(' ')
        for (var j = 0; j < names.length; j += 1) table[names[j]] = group[0]
      }
      return table
    })()

    function fileExtensionOf(name) {
      var text = String(name)
      var dot = text.lastIndexOf('.')
      if (dot < 0 || dot + 1 >= text.length) return ''
      return text.slice(dot + 1).toLowerCase()
    }

    /** 'code' | 'image' | 'archive' | 'sheet' | 'doc' | 'file' */
    function fileKindOf(name) {
      var kind = FILE_EXT_KIND[fileExtensionOf(name)]
      return kind === undefined ? 'file' : kind
    }

    function fileIconElement(name, key, size) {
      var kind = fileKindOf(name)
      if (kind === 'code') return h(CodeIcon, { key: key, size: size })
      if (kind === 'image') return h(ImageFileIcon, { key: key, size: size })
      if (kind === 'archive') return h(ArchiveIcon, { key: key, size: size })
      if (kind === 'sheet') return h(SheetFileIcon, { key: key, size: size })
      if (kind === 'doc') return h(DocIcon, { key: key, size: size })
      return h(FileIcon, { key: key, size: size })
    }

    /**
     * 文件标签的动作集合。
     *
     * 兼容两种调用：只给一个函数 = 只要「打开」；给对象 = { open, reveal }。
     * 不拆成两个位置参数，是因为这两个动作要一路透传过
     * renderMarkdown → renderInline → pushTextNodes，多一个参数就多一处漏传。
     */
    function normalizeFileActions(actions) {
      if (typeof actions === 'function') return { open: actions, reveal: null }
      if (actions !== null && typeof actions === 'object') {
        return {
          open: typeof actions.open === 'function' ? actions.open : null,
          reveal: typeof actions.reveal === 'function' ? actions.reveal : null,
        }
      }
      return { open: null, reveal: null }
    }

    /**
     * 文件标签 = 一个真正的按钮。
     *
     * 用 button 而不是 span：键盘 Tab 能落到它上面，回车能打开 —— 这条由
     * .superpi-root :is(button,…):focus-visible 的焦点环统一兜底。
     *
     * 标签只显示「类型图标 + 文件名（含后缀）」：完整路径信息量太大，一段回复里
     * 三个同目录文件就会把正文挤爆。路径仍然保留在 title 与 data-path 上 ——
     * 悬停可看全，右键在资源管理器里定位（见 onContextMenu）。
     */
    function renderFileChip(value, key, actions, inline) {
      var target = String(value)
      var sep = Math.max(target.lastIndexOf('\\'), target.lastIndexOf('/'))
      var base = sep >= 0 ? target.slice(sep + 1) : target
      var acts = normalizeFileActions(actions)
      var parts = [
        fileIconElement(base, 'i', 12),
        h('span', { key: 'n', className: 'superpi-fileref-name' }, base),
      ]
      return h('button', {
        key: key,
        type: 'button',
        className: inline === true ? 'superpi-fileref superpi-fileref-block' : 'superpi-fileref',
        title: target,
        'data-path': target,
        'data-kind': fileKindOf(base),
        'data-openable': acts.open === null ? '0' : '1',
        'data-revealable': acts.reveal === null ? '0' : '1',
        onClick: function (event) {
          event.preventDefault()
          event.stopPropagation()
          if (acts.open !== null) acts.open(target)
        },
        onContextMenu: function (event) {
          if (acts.reveal === null) return
          event.preventDefault()
          event.stopPropagation()
          acts.reveal(target)
        },
      }, parts)
    }

    /** 纯文本片段：按路径切开，路径段换成可点标签，其余原样保留。 */
    function pushTextNodes(nodes, chunk, keyPrefix, onOpenFile) {
      var text = String(chunk)
      if (text === '') return
      var tokens = splitFileTokens(text)
      if (tokens.length === 0) { nodes.push(text); return }
      var last = 0
      for (var i = 0; i < tokens.length; i += 1) {
        if (tokens[i].start > last) nodes.push(text.slice(last, tokens[i].start))
        nodes.push(renderFileChip(tokens[i].value, keyPrefix + '-f' + String(i), onOpenFile))
        last = tokens[i].end
      }
      if (last < text.length) nodes.push(text.slice(last))
    }


    /** 把相对路径按 cwd 补成绝对路径。 */
    function absolutePathOf(cwd, path) {
      var value = String(path)
      if (FILE_ABS.test(value)) return value
      var root = typeof cwd === 'string' ? cwd : ''
      if (root === '') return value
      var sep = FILE_BACKSLASH.test(root) ? '\\' : '/'
      return root.replace(/[\\/]+$/, '') + sep + value.replace(/^(?:\.\/)+/, '')
    }

    /** 桌面 App（dsh-app://app）才有这条桥；浏览器里 window.__DSH_HOST_PATHS__ 不存在。 */
    function pathOfFile(file) {
      var host = typeof window === 'undefined' || window === null ? null : window.__DSH_HOST_PATHS__
      if (host === null || host === undefined || typeof host.pathFor !== 'function') return ''
      try {
        var value = host.pathFor(file)
        return typeof value === 'string' ? value : ''
      } catch (err) {
        return ''
      }
    }

    // ── 文件地址（与 DSH 内置文件引用同一套拼法）──────────────────────────────
    //
    // 右栏的 documentpreview 只认 dsh-resource://file/<scope>/… 这种地址；absolute 作用域
    // 没有授权 Session，读取会以 workspace-file/unknown-workspace 失败，所以这里一律拼
    // session 作用域。
    //
    // 为什么不做「绝对路径压成工作区相对」（DSH 的 fileAddressFor 会压）：pi 的工作目录和
    // DSH 会话的工作目录是两个目录，压成相对路径后会被 DSH 按它自己的根解析，指到别处。
    // 绝对路径是唯一不产生歧义、也不依赖对方根目录的写法。

    var FILE_BACKSLASH = /\\/
    var FILE_ADDRESS_PREFIX = 'dsh-resource://file/'

    function encodeFileSegment(segment) {
      return encodeURIComponent(String(segment)).replace(/%3A/gi, ':')
    }

    /** dsh-resource://file/session/<id>/<path>：反斜杠转正斜杠，盘符冒号保持字面。 */
    function sessionFileAddress(sessionId, path) {
      var normalized = String(path).replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
      var encoded = []
      var parts = normalized.split('/')
      for (var i = 0; i < parts.length; i += 1) encoded.push(encodeFileSegment(parts[i]))
      return FILE_ADDRESS_PREFIX + 'session/' + encodeFileSegment(sessionId) + '/' + encoded.join('/')
    }


    // ── 极简 markdown（无依赖，绝不拼 HTML 字符串）───────────────────────────

    var FENCE = /^\x60\x60\x60(\S*)\s*$/
    var INLINE = /(\x60[^\x60]+\x60)|(\*\*[^*]+\*\*)/g

    function renderInline(text, prefix, onOpenFile) {
      var nodes = []
      var last = 0
      var match = null
      var index = 0
      INLINE.lastIndex = 0
      while ((match = INLINE.exec(text)) !== null) {
        if (match.index > last) pushTextNodes(nodes, text.slice(last, match.index), prefix + '-' + String(index), onOpenFile)
        if (match[1] !== undefined) {
          // 行内 code 里如果整段就是一条路径，也让它可点 —— 助手常把路径包在反引号里。
          var inner = match[1].slice(1, -1)
          if (isFilePathToken(inner)) nodes.push(renderFileChip(inner, prefix + '-c' + String(index), onOpenFile))
          else nodes.push(h('code', { key: prefix + '-c' + String(index), className: 'superpi-code-inline' }, inner))
        } else {
          nodes.push(h('strong', { key: prefix + '-b' + String(index) }, match[2].slice(2, -2)))
        }
        index += 1
        last = INLINE.lastIndex
      }
      if (last < text.length) pushTextNodes(nodes, text.slice(last), prefix + '-' + String(index), onOpenFile)
      return nodes
    }

    function renderMarkdown(text, onOpenFile) {
      var lines = String(text === undefined ? '' : text).split('\n')
      var blocks = []
      var buffer = []
      var key = 0
      var i = 0
      var flush = function () {
        if (buffer.length === 0) return
        var body = buffer.join('\n').replace(/\s+$/, '')
        buffer = []
        if (body === '') return
        blocks.push(h('p', { key: 'p' + String(key) }, renderInline(body, 'p' + String(key), onOpenFile)))
        key += 1
      }
      while (i < lines.length) {
        var fence = FENCE.exec(lines[i])
        if (fence !== null) {
          flush()
          var lang = fence[1]
          var code = []
          i += 1
          while (i < lines.length && FENCE.test(lines[i]) === false) { code.push(lines[i]); i += 1 }
          i += 1
          // 围栏里整块就是一条路径时，它本来就是「一个文件」，不要再让人去复制粘贴。
          var only = code.length === 1 ? code[0].trim() : ''
          if (only !== '' && isFilePathToken(only)) {
            blocks.push(renderFileChip(only, 'f' + String(key), onOpenFile, true))
            key += 1
            continue
          }
          blocks.push(h('div', { key: 'f' + String(key), className: 'superpi-fence' },
            lang === '' ? null : h('div', { className: 'superpi-fence-lang' }, lang),
            h('pre', { className: 'superpi-pre' }, h('code', null, code.join('\n')))))
          key += 1
          continue
        }
        if (/^#{1,6}\s+/.test(lines[i])) {
          flush()
          blocks.push(h('h3', { key: 'h' + String(key) }, renderInline(lines[i].replace(/^#{1,6}\s+/, ''), 'h' + String(key), onOpenFile)))
          key += 1
          i += 1
          continue
        }
        if (/^\s*[-*]\s+/.test(lines[i])) {
          flush()
          var items = []
          while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
            items.push(h('li', { key: 'li' + String(items.length) }, renderInline(lines[i].replace(/^\s*[-*]\s+/, ''), 'li' + String(key) + '-' + String(items.length), onOpenFile)))
            i += 1
          }
          blocks.push(h('ul', { key: 'u' + String(key) }, items))
          key += 1
          continue
        }
        buffer.push(lines[i])
        i += 1
      }
      flush()
      return blocks.length === 0 ? null : blocks
    }


    // ── 事件归约 ────────────────────────────────────────────────────────────
    //
    // 契约（src/rpc-contract.mjs 的 RPC_EVENTS，共 25 类）里的**每一类**都必须在这里有归宿。
    // 漏一类就意味着某个状态下界面骗人（比如 compaction_end 不处理，notice 永远卡住）。
    // test/parity.mjs 会扫本文件的 EVENT_CASES 表与契约对账，两边不齐就红。

    var MAX_NOTICES = 5
    var MAX_PENDING_UI = 12
    var DIALOG_FALLBACK_MS = 5 * 60 * 1000

    /**
     * 对话类命令（prompt / bash / follow_up）的客户端超时：0 = 不设上限。
     *
     * 为什么不能给一个「够大」的数（0.3.0 之前给的是十分钟）：这些命令的完成时刻不由面板决定。
     * 一条 prompt 若命中扩展命令，pi 会 await 整个扩展生命周期（agent-session.ts:2304-2338
     * 的 _tryExecuteExtensionCommand），中途的 select/confirm/input/editor 弹窗**等的是人**。
     * 人盯着屏幕想 10 分钟是正常行为，客户端先 abort 只会产生两个后果：面板显示超时红条、
     * 而 pi 侧命令仍在跑并继续推事件（面板把它们当成「已完成轮次」之外的僵尸事件丢弃）。
     *
     * 超时由谁负责：host 侧 src/pi-rpc.mjs 的 armTimer —— 它知道 pendingUi 里有几个弹窗，
     * 弹窗未答时按 60s 一段续期（最多 MAX_TIMEOUT_DEFERRALS 段），并给出可读的失败原因。
     * 面板不重复实现这套判断，否则两套阈值必然打架（0.3.0 之前就是打架：面板 10 分钟
     * 先 abort、host 60s 先 reject，谁也没等到人）。
     */
    var CHAT_TIMEOUT_MS = 0

    /**
     * busy 的进入 / 退出只走这两个口。
     *
     * 用时是「工作状态行」唯一的动态内容，散在五处手写 `busy = true` 必然漏记或残留
     * （漏记 → 用时从 1 秒开始涨；残留 → 空闲时还挂着上次的 43 分）。
     * resync / attach 会在中途把 busy 重设为快照值，因此这里必须幂等：
     * 已经在忙就不重置起点，否则一轮任务里每重连一次计时就归零。
     */
    function markBusy(view) {
      view.busy = true
      if (!(view.busySince > 0)) view.busySince = Date.now()
    }

    function markIdle(view) {
      view.busy = false
      view.busySince = 0
      // 轮次结束不可能还有工具在跑：不清的话 Working 行会在下一轮显示上一轮的工具。
      view.activeTool = null
    }

    function createView() {
      return {
        messages: [],
        lastSeq: 0,
        openIndex: -1,
        streamingIndex: -1,
        busy: false,
        // 工作状态行的计时起点：busy 由谁点亮不重要，用时必须从「真正开始」那一拍算起，
        // 0 表示当前不是 busy（或还没记过点）。
        busySince: 0,
        compacting: false,
        retrying: false,
        toolStatus: {},
        queue: { steering: 0, followUp: 0, steeringText: [], followUpText: [] },
        notice: null,
        notices: [],
        statuses: {},
        widgets: {},
        title: null,
        editorText: null,
        pendingUi: [],
        uiSeq: 0,
        entryCount: 0,
        dropped: 0,
        thinkingLevel: '',
        lastError: null,
        /**
         * 本轮「没交付」的判读（0.18.0；前身是 `malformed` 字符串）。
         *
         * **面板不判，只渲染**：host 在 `message_end` 事件上算好 `record.verdict`
         * （含六类 `kind` 与中英文案），这里原样存下来。
         *
         * 为什么不在面板判：0.16.2~0.17.3 是「表在契约、算法在面板」，
         * 于是同一份知识有两个实现，而且面板的判读**依赖 `/contract` 先到** ——
         * 事件早到的那一轮提示会永久丢失（0.17.3 只好把启动顺序改成契约先行来绕开）。
         * 现在判在 host、面板只存结果，依赖与竞态一起消失。
         *
         * 只描述**当前这一轮**：`agent_start` 清空，`message_end` 覆盖。
         */
        verdict: null,
        // 0.14.0 分页状态：总条数 / 还有更早的 / 下一次翻页的游标 / 是否正在翻。
        // 这几个字段只用于「加载更早」入口与「共 N 条」提示，不影响消息渲染本身。
        messageTotal: 0,
        hasEarlier: false,
        nextBefore: 0,
        loadingEarlier: false,
        // 当前正在跑的工具（Working 行据此显示「bash · 8m20s · 上限 500s」）。
        // null = 没有工具在跑（纯模型推理中），此时只显示原来的"深度求索中"。
        activeTool: null,
      }
    }

    function pushNotice(view, text, tone) {
      if (typeof text !== 'string' || text === '') return
      view.uiSeq += 1
      view.notices = view.notices.concat([{ id: 'n' + String(view.uiSeq), text: text, tone: tone === undefined ? 'info' : tone, at: Date.now() }])
      if (view.notices.length > MAX_NOTICES) view.notices = view.notices.slice(view.notices.length - MAX_NOTICES)
    }

    function applyAssistantEvent(message, event) {
      var kind = String(event === null || event === undefined || event.type === undefined ? '' : event.type)
      var index = typeof event.contentIndex === 'number' ? event.contentIndex : -1
      var block = index >= 0 ? message.blocks[index] : undefined
      // 'start' 只有类型没有字段（docs/json.md 的 assistantMessageEvent 表：The provider stream started），
      // 流式容器已经由 message_start 建好，这里显式忽略即可 —— 写出来是为了让 parity 门禁能机械对账。
      if (kind === 'start') return
      if (kind === 'text_start') { message.blocks[index] = { type: 'text', text: '' }; return }
      if (kind === 'text_delta') {
        if (block === undefined || block.type !== 'text') message.blocks[index] = { type: 'text', text: '' }
        message.blocks[index].text += String(event.delta === undefined ? '' : event.delta)
        return
      }
      if (kind === 'text_end') { message.blocks[index] = { type: 'text', text: String(event.content === undefined ? '' : event.content) }; return }
      if (kind === 'thinking_start') { message.blocks[index] = { type: 'thinking', text: '' }; return }
      if (kind === 'thinking_delta') {
        if (block === undefined || block.type !== 'thinking') message.blocks[index] = { type: 'thinking', text: '' }
        message.blocks[index].text += String(event.delta === undefined ? '' : event.delta)
        return
      }
      if (kind === 'thinking_end') { message.blocks[index] = { type: 'thinking', text: String(event.content === undefined ? '' : event.content) }; return }
      if (kind === 'toolcall_start') {
        message.blocks[index] = {
          type: 'toolCall',
          id: event.id === undefined ? null : event.id,
          name: String(event.toolName === undefined ? 'tool' : event.toolName),
          argsText: '',
        }
        return
      }
      if (kind === 'toolcall_delta') {
        if (block === undefined || block.type !== 'toolCall') message.blocks[index] = { type: 'toolCall', id: null, name: 'tool', argsText: '' }
        message.blocks[index].argsText += String(event.delta === undefined ? '' : event.delta)
        return
      }
      if (kind === 'toolcall_end') { message.blocks[index] = normalizeBlock(event.toolCall === undefined ? { type: 'toolCall' } : event.toolCall); return }
      if (kind === 'done') {
        if (event.message !== undefined && event.message !== null) {
          var finalMessage = makeMessage(event.message, message.seq)
          message.blocks = finalMessage.blocks
          message.usage = finalMessage.usage
          message.stopReason = finalMessage.stopReason
        }
        return
      }
      if (kind === 'error') {
        message.stopReason = 'error'
        message.blocks = message.blocks.concat([{ type: 'text', text: event.error === undefined ? 'error' : String(event.error) }])
      }
    }

    /** tool_execution_update 的 partialResult 让工具卡片在跑的时候就显示进度（bash 尤其明显）。 */
    function applyToolUpdate(view, record) {
      var id = String(record.toolCallId === undefined ? '' : record.toolCallId)
      if (id === '') return
      var entry = view.toolStatus[id]
      if (entry === undefined) {
        view.toolStatus[id] = { status: 'running', name: String(record.toolName === undefined ? '' : record.toolName), partial: '' }
        return
      }
      var partial = record.partialResult === undefined ? '' : stringifyArgs(record.partialResult)
      entry.partial = partial.length > 2000 ? partial.slice(partial.length - 2000) : partial
      updateToolMessageText(view, id, entry.partial)
    }

    /** 把流式工具输出写进对应的 toolResult 气泡（如果已经存在）。 */
    function updateToolMessageText(view, id, text) {
      for (var i = view.messages.length - 1; i >= 0; i -= 1) {
        var message = view.messages[i]
        if (message.role === 'toolResult' && message.toolCallId === id) {
          var next = message.blocks.filter(function (block) { return block.type !== 'text' })
          if (text !== '') next = next.concat([{ type: 'text', text: text }])
          message.blocks = next
          return
        }
      }
    }

    function pendingUiOf(record) {
      return {
        id: String(record.id === undefined ? '' : record.id),
        method: String(record.method === undefined ? 'select' : record.method),
        title: String(record.title === undefined ? '' : record.title),
        message: typeof record.message === 'string' ? record.message : null,
        options: Array.isArray(record.options) ? record.options.map(function (item) { return String(item) }) : [],
        prefill: typeof record.prefill === 'string' ? record.prefill : null,
        placeholder: typeof record.placeholder === 'string' ? record.placeholder : null,
        timeout: typeof record.timeout === 'number' ? record.timeout : null,
        receivedAt: typeof record.receivedAt === 'number' ? record.receivedAt : Date.now(),
      }
    }

    function addPendingUi(view, request) {
      if (request.id === '') return
      var kept = view.pendingUi.filter(function (item) { return item.id !== request.id })
      kept.push(request)
      if (kept.length > MAX_PENDING_UI) kept = kept.slice(kept.length - MAX_PENDING_UI)
      view.pendingUi = kept
    }

    function dropPendingUi(view, id) {
      view.pendingUi = view.pendingUi.filter(function (item) { return item.id !== id })
    }

    /**
     * 弹窗的倒计时预算（毫秒）。
     *
     * 三档取值，全部有据可依：
     *  - 扩展自己声明了 timeout（rpc-mode.ts:119-124 到点由 pi 侧 resolve 默认值继续跑）
     *    → 用它的值。面板必须与 pi 对齐，否则出现「pi 早已按默认值继续、面板还在倒计时」。
     *  - 没声明（editor 请求连字段都没有）→ 用 DIALOG_FALLBACK_MS 兜底。
     *  - 两者都取不超过 DIALOG_FALLBACK_MS：兜底是上限，不能被扩展声明的超大值顶掉。
     */
    function dialogBudgetMs(request) {
      var declared = request !== null && request !== undefined && typeof request.timeout === 'number' && Number.isFinite(request.timeout) && request.timeout > 0
        ? request.timeout
        : null
      if (declared === null) return DIALOG_FALLBACK_MS
      return Math.min(declared, DIALOG_FALLBACK_MS)
    }

    /**
     * 扩展 UI 只有一种出站记录（extension_ui_request），按 method 分流。
     *
     * 四个 dialog（select/confirm/input/editor）进 pendingUi 等用户点；
     * 五个 oneway（notify/setStatus/setWidget/setTitle/set_editor_text）直接作用到 view。
     * 在这里分错就等于丢消息 —— 契约的 EXTENSION_UI_METHODS 是唯一真相源。
     */
    function applyExtensionUi(view, record) {
      var method = String(record.method === undefined ? '' : record.method)
      if (method === 'select' || method === 'confirm' || method === 'input' || method === 'editor') {
        addPendingUi(view, pendingUiOf(record))
        return
      }
      if (method === 'notify') {
        pushNotice(view, String(record.message === undefined ? '' : record.message), typeof record.notifyType === 'string' ? record.notifyType : 'info')
        return
      }
      if (method === 'setStatus') {
        var statusKey = String(record.statusKey === undefined ? '' : record.statusKey)
        if (statusKey === '') return
        var statuses = {}
        var keys = Object.keys(view.statuses)
        for (var si = 0; si < keys.length; si += 1) statuses[keys[si]] = view.statuses[keys[si]]
        if (record.statusText === undefined || record.statusText === null || record.statusText === '') delete statuses[statusKey]
        else statuses[statusKey] = String(record.statusText)
        view.statuses = statuses
        return
      }
      if (method === 'setWidget') {
        var widgetKey = String(record.widgetKey === undefined ? '' : record.widgetKey)
        if (widgetKey === '') return
        var widgets = {}
        var wkeys = Object.keys(view.widgets)
        for (var wi = 0; wi < wkeys.length; wi += 1) widgets[wkeys[wi]] = view.widgets[wkeys[wi]]
        if (Array.isArray(record.widgetLines) === false || record.widgetLines.length === 0) delete widgets[widgetKey]
        else widgets[widgetKey] = {
          lines: record.widgetLines.map(function (item) { return String(item) }),
          placement: String(record.widgetPlacement === undefined ? 'aboveEditor' : record.widgetPlacement),
        }
        view.widgets = widgets
        return
      }
      if (method === 'setTitle') {
        view.title = typeof record.title === 'string' ? record.title : view.title
        return
      }
      if (method === 'set_editor_text') {
        view.editorText = String(record.text === undefined ? '' : record.text)
        return
      }
      // 未知 method：pi 未来新增时不要静默丢弃，留一条通知便于排障。
      pushNotice(view, 'unknown extension_ui_request method: ' + (method === '' ? '(empty)' : method), 'warn')
    }

    function applyRecord(view, record) {
      var type = String(record === null || record === undefined || record.type === undefined ? '' : record.type)
      var started = null
      var message = null
      var current = null
      var entry = null

      if (type === 'agent_start') { markBusy(view); view.lastError = null; view.verdict = null; return }
      if (type === 'turn_start') { markBusy(view); return }
      if (type === 'turn_end') {
        // 一轮结束：关掉流式指针，但 busy 不归零（agent 可能还有后续轮次）。
        view.openIndex = -1
        view.streamingIndex = -1
        return
      }
      if (type === 'agent_end') {
        // agent 主循环结束。pi 会在此之后 flush _pendingBashMessages（不进事件流），
        // SuperPiPanel 收到 agent_settled 后会重拉 snapshot 把 bash 气泡补上。
        view.openIndex = -1
        view.streamingIndex = -1
        return
      }
      if (type === 'agent_settled') {
        if (record.aborted === true) view.verdict = null
        markIdle(view)
        view.retrying = false
        view.openIndex = -1
        view.streamingIndex = -1
        // pi 在 agent_settled 时会把没应答的扩展请求丢掉（host 侧也同步清理），
        // 面板若还挂着这些弹窗，用户点下去会得到 409，所以这里一并清空。
        view.pendingUi = []
        return
      }
      if (type === 'message_start') {
        started = record.message
        if (started === null || typeof started !== 'object') return
        if (started.role === 'system') return
        message = makeMessage(started, view.messages.length)
        message.streaming = message.role === 'assistant'
        view.messages = view.messages.concat([message])
        view.openIndex = view.messages.length - 1
        if (message.streaming) view.streamingIndex = view.openIndex
        return
      }
      if (type === 'message_update') {
        if (record.assistantMessageEvent === null || typeof record.assistantMessageEvent !== 'object') return
        if (view.streamingIndex < 0) return
        applyAssistantEvent(view.messages[view.streamingIndex], record.assistantMessageEvent)
        return
      }
      if (type === 'message_end') {
        if (record.message === null || typeof record.message !== 'object') return
        if (record.message.role === 'system') return
        current = view.openIndex >= 0 ? view.messages[view.openIndex] : undefined
        if (current !== undefined && current.role === record.message.role) {
          message = makeMessage(record.message, current.seq)
          message.streaming = false
          var nextMessages = view.messages.slice()
          nextMessages[view.openIndex] = message
          view.messages = nextMessages
        } else {
          message = makeMessage(record.message, view.messages.length)
          view.messages = view.messages.concat([message])
        }
        view.openIndex = -1
        view.streamingIndex = -1
        /**
         * 「这一轮交付了吗」的**唯一接缝**（0.16.2 建，0.18.0 改成纯渲染）。
         *
         * 0.16.2 这里调面板自己的判据（`detectMalformedOutput`），为此需要契约先到 ——
         * 于是有了 0.17.3 那个"契约晚到、提示永久丢失"的竞态。
         * 0.18.0 起判读在 host（`src/event-verdict.mjs`），`record.verdict` 随事件到达，
         * 这里只做一件事：把 `delivered === false` 的那份存进 view。
         *
         * 存整份（不是只存 kind）：文案在 verdict.notice 里，面板不复制任何一句 ——
         * 命令行 Working 行读的是同一份文案，两端必须逐字相同。
         */
        if (record.message.role === 'assistant') {
          view.verdict = record.verdict !== null && record.verdict !== undefined && record.verdict.delivered === false
            ? record.verdict
            : null
        }
        return
      }
      if (type === 'tool_execution_start') {
        // 记下 args 里的 `timeout`（秒）：模型经常自己给 bash 开很大的上限
        // （实测 p90=1800s、最大 120000s）。面板据此在 Working 行显示
        // 「工具名 · 已跑 · 上限」，让"合法的长等待"可见，而不是看起来像卡死。
        var limitSeconds = 0
        var rawArgs = record.args === undefined ? (record.arguments === undefined ? null : record.arguments) : record.args
        if (rawArgs !== null && typeof rawArgs === 'object' && typeof rawArgs.timeout === 'number' && rawArgs.timeout > 0) {
          limitSeconds = rawArgs.timeout
        }
        view.toolStatus[String(record.toolCallId)] = {
          status: 'running',
          name: String(record.toolName === undefined ? '' : record.toolName),
          partial: '',
          startedAt: Date.now(),
          limitSeconds: limitSeconds,
        }
        // 当前活跃工具：Working 行只显示"最近启动且还没结束"的那一个。
        view.activeTool = { id: String(record.toolCallId), name: String(record.toolName === undefined ? '' : record.toolName), startedAt: Date.now(), limitSeconds: limitSeconds, lastOutputAt: Date.now() }
        return
      }
      if (type === 'tool_execution_update') {
        applyToolUpdate(view, record)
        /**
         * 0.15.0：bash 每 100ms 发一次本事件，收到就说明**那条命令**在推进。
         *
         * 必须按 id 匹配：并行工具调用时，工具 B 的输出不能刷新工具 A 的静默计时
         * （否则 A 明明卡住了，心跳却被 B 的输出不断重置，永远不报警）。
         */
        var updateId = String(record.toolCallId === undefined ? '' : record.toolCallId)
        if (view.activeTool !== null && view.activeTool !== undefined && view.activeTool.id === updateId) {
          view.activeTool.lastOutputAt = Date.now()
        }
        return
      }
      if (type === 'tool_execution_end') {
        var id = String(record.toolCallId)
        view.toolStatus[id] = {
          status: record.isError === true ? 'error' : 'done',
          name: String(record.toolName === undefined ? '' : record.toolName),
          partial: view.toolStatus[id] === undefined ? '' : view.toolStatus[id].partial,
        }
        if (view.activeTool !== null && view.activeTool !== undefined && view.activeTool.id === id) view.activeTool = null
        return
      }
      if (type === 'thinking_level_changed') { view.thinkingLevel = String(record.level === undefined ? '' : record.level); return }
      if (type === 'queue_update') {
        // record.steering / record.followUp 是「当前完整队列」的字符串数组，
        // 长度用于状态栏计数，文本用于 Esc 时把排队消息还给编辑器（对齐 TUI 的 restoreQueuedMessagesToEditor）。
        var steeringText = Array.isArray(record.steering) ? record.steering.map(function (item) { return String(item) }) : []
        var followUpText = Array.isArray(record.followUp) ? record.followUp.map(function (item) { return String(item) }) : []
        view.queue = { steering: steeringText.length, followUp: followUpText.length, steeringText: steeringText, followUpText: followUpText }
        return
      }
      if (type === 'compaction_start') {
        view.compacting = true
        view.notice = { text: 'compaction', detail: String(record.reason === undefined ? 'manual' : record.reason), tone: 'info' }
        return
      }
      if (type === 'compaction_end') {
        view.compacting = false
        view.notice = null
        if (record.errorMessage !== undefined && record.errorMessage !== null) pushNotice(view, String(record.errorMessage), 'err')
        else if (record.aborted === true) pushNotice(view, 'compaction aborted', 'warn')
        return
      }
      if (type === 'auto_retry_start') {
        view.retrying = true
        view.notice = { text: 'retry', detail: String(record.attempt) + '/' + String(record.maxAttempts), tone: 'warn' }
        if (record.errorMessage !== undefined && record.errorMessage !== null) pushNotice(view, String(record.errorMessage), 'warn')
        return
      }
      if (type === 'auto_retry_end') {
        view.retrying = false
        view.notice = null
        if (record.success === false && record.finalError !== undefined && record.finalError !== null) pushNotice(view, String(record.finalError), 'err')
        return
      }
      if (type === 'summarization_retry_scheduled') {
        view.notice = { text: 'summarize-retry', detail: String(record.attempt) + '/' + String(record.maxAttempts) + ' · ' + String(record.source === undefined ? '' : record.source), tone: 'warn' }
        return
      }
      if (type === 'summarization_retry_attempt_start') { return }
      if (type === 'summarization_retry_finished') { view.notice = null; return }
      if (type === 'entry_appended') {
        view.entryCount += 1
        entry = record.entry
        if (entry !== null && typeof entry === 'object') {
          if (entry.type === 'session_info' && typeof entry.name === 'string') view.title = entry.name
          else if (entry.type === 'thinking_level_change' && typeof entry.thinkingLevel === 'string') view.thinkingLevel = entry.thinkingLevel
        }
        return
      }
      if (type === 'session_info_changed') {
        view.title = typeof record.name === 'string' ? record.name : null
        return
      }
      if (type === 'bash_execution_update') {
        var bashId = String(record.id === undefined ? '' : record.id)
        var delta = String(record.delta === undefined ? '' : record.delta)
        if (bashId !== '' && delta !== '') {
          var prev = view.toolStatus[bashId]
          if (prev === undefined) view.toolStatus[bashId] = { status: 'running', name: 'bash', partial: delta }
          else prev.partial = (prev.partial === undefined ? '' : prev.partial) + delta
          updateToolMessageText(view, bashId, view.toolStatus[bashId].partial)
        }
        return
      }
      if (type === 'extension_error') {
        pushNotice(view, 'extension error: ' + String(record.error === undefined ? '' : record.error), 'err')
        return
      }
      if (type === 'extension_ui_request') { applyExtensionUi(view, record); return }
    }

    /**
     * 回放一批事件，并**独占**推进水位 view.lastSeq。
     *
     * ── 为什么水位只能由这里推进（0.16.1 修掉的 P0）───────────────
     *
     * 旧实现在 attach() 里先 `view.lastSeq = snapshot.eventSeq` 再调本函数
     * （原来的 client.js:5551-5553），于是缓冲里每条事件的 seq 都 ≤ 水位，
     * 全部命中下面的 `continue` —— **缓冲事件 100% 被丢弃**，且不报错。
     *
     * 为什么不是「改一下那两行的顺序」了事：所有调用点都得自己维护水位，
     * 就必然有下一个人再写错一次（resync 已经踩过同一个坑）。所以把水位收进
     * 本函数：调用方一律不写 view.lastSeq，只调用 applyBatch，必要时调
     * advanceSeq()。这样「水位」与「回放」在结构上不可能再分家。
     *
     * 判据 `seq <= view.lastSeq` 仍然保留：SSE 重连会重放，去重是必需的。
     */
    function applyBatch(view, entries) {
      if (Array.isArray(entries) === false) return
      for (var i = 0; i < entries.length; i += 1) {
        var entry = entries[i]
        if (entry === null || typeof entry !== 'object') continue
        var seq = typeof entry.seq === 'number' ? entry.seq : 0
        if (seq > 0) {
          if (seq <= view.lastSeq) continue
          view.lastSeq = seq
        }
        if (entry.record !== undefined && entry.record !== null) applyRecord(view, entry.record)
      }
    }

    /**
     * 用一份 snapshot **重建**一个 view 的事件态（纯函数：不碰 DOM、不发请求、不读时钟）。
     *
     * ── 为什么要有这个函数（0.16.1）───────────────
     *
     * 0.16.0 的 P0 是「attach() 里两行的顺序写反了」。但真正的缺陷不是那两行，
     * 而是**「顺序」这个概念本身需要人来维护** —— 谁都能再写反一次（resync 就踩过）。
     *
     * 所以把「从快照重建状态」收紧成一个函数，内部顺序写死一次、只写一次：
     *   ① 水位归零
     *   ② 回放快照里带的事件（applyBatch 独占推进水位）
     *   ③ 把水位补齐到快照声称的位置（advanceSeq 只前进）
     *   ④ 补挂快照里已挂起的扩展弹窗
     *
     * 调用方只调 `hydrateFromSnapshot(view, snapshot)`，没有顺序可以写错。
     * 这也是它必须能被门禁直接调用的原因：装配逻辑本身要可测，
     * 而不是「测了 applyBatch 和 advanceSeq 各自没问题，就假定组装起来没问题」。
     */
    function hydrateFromSnapshot(view, snapshot) {
      var snap = snapshot !== null && typeof snapshot === 'object' ? snapshot : {}
      view.lastSeq = 0
      /**
       * ② 先回放。0.16.0 及之前这里是「先把 lastSeq 抬到 snapshot.eventSeq，再 applyBatch」，
       * 于是缓冲里每条事件的 seq 都 ≤ 水位、全被去重判据 continue 掉 ——
       * 缓冲事件 100% 丢弃且不报错（探针实测：3 条缓冲事件应用 0 条）。
       * 正文当时靠 hydrate()（get_messages）兜住了所以没人发现，
       * 但运行态与扩展弹窗兜不住：agent_start / extension_ui_request 在事件流之外没有副本。
       */
      applyBatch(view, Array.isArray(snap.events) ? snap.events : [])
      // ③ 再补水位（只前进，所以上一步应用过的位置不会被回退）。
      advanceSeq(view, snap.eventSeq)
      if (snap.lastVerdict !== undefined) view.verdict = snap.lastVerdict
      if (snap.taskWidget) applyExtensionUi(view, snap.taskWidget)
      /**
       * ④ 补挂「已挂起但还没被应答」的扩展弹窗（0.16.1 修的 P1）。
       *
       * host 的 snapshot() 一直带着 pendingUi（src/pi-rpc.mjs:603），但客户端
       * 从来没有读过这个字段 —— 于是「面板刷新时 pi 正等着用户点弹窗」的场景下，
       * 弹窗在 UI 上不存在，用户无法应答，命令只能挂到 12 轮续期耗尽
       * （约 12 分钟）才报 `N dialog(s) never answered`。
       *
       * 走与实时事件完全相同的路径（pendingUiOf + addPendingUi），不另起一套：
       * 否则「补挂的弹窗」与「实时弹窗」会分叉出两种行为。
       * 排在 applyBatch 之后：实时事件里的弹窗优先，补挂的只在 id 不重复时覆盖。
       */
      if (Array.isArray(snap.pendingUi)) {
        for (var p = 0; p < snap.pendingUi.length; p += 1) addPendingUi(view, pendingUiOf(snap.pendingUi[p]))
      }
      return view
    }

    /**
     * 把水位补齐到「快照声称的」位置（**只前进，不后退**）。
     *
     * 唯一合法用途：snapshot 响应里带着 `eventSeq`，表示 host 那边已经产出到第几条。
     * 而 SSE 从 `since=eventSeq` 开始推，所以水位必须先到那里，
     * 否则重连时会把已经处理过的事件再放一遍。
     *
     * 调用顺序铁律（0.16.1）：见 hydrateFromSnapshot —— 装配只有那一个入口。
     * 单独调本函数时务必先 applyBatch，反过来会把回放整个作废（0.16.0 的 P0）。
     */
    function advanceSeq(view, seq) {
      if (typeof seq !== 'number' || Number.isFinite(seq) === false || seq <= 0) return
      if (seq > view.lastSeq) view.lastSeq = seq
    }


    // ── 基础组件 ────────────────────────────────────────────────────────────

    function SuperPiIcon(props) {
      var size = props !== null && props !== undefined && typeof props.size === 'number' ? props.size : 18
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
        style: { flex: '0 0 auto' },
      },
        h('path', { d: 'M4 7h16' }),
        h('path', { d: 'M4 12.5h9' }),
        h('path', { d: 'M4 18h5' }),
        h('circle', { cx: 18, cy: 15.5, r: 3.2 }))
    }

    /** 目录图标（与 SuperPiIcon 同一描边风格，用 currentColor，不引入图片资源）。 */
    function DirIcon(props) {
      var size = props !== null && props !== undefined && typeof props.size === 'number' ? props.size : 15
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
        style: { flex: '0 0 auto' },
      },
        h('path', { d: 'M3 7.5a1.5 1.5 0 0 1 1.5-1.5h4l2 2.5h8A1.5 1.5 0 0 1 20 10v7.5a1.5 1.5 0 0 1-1.5 1.5h-14A1.5 1.5 0 0 1 3 17.5z' }))
    }

    /** 文件图标（折角纸张，同 SuperPiIcon 描边风格）。 */
    function FileIcon(props) {
      var size = props !== null && props !== undefined && typeof props.size === 'number' ? props.size : 15
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
        style: { flex: '0 0 auto' },
      },
        h('path', { d: 'M6.5 3.5h7.5l4 4v13a1 1 0 0 1-1 1h-10.5a1 1 0 0 1-1-1v-16a1 1 0 0 1 1-1z' }),
        h('path', { d: 'M14 3.5v4h4' }))
    }

    /** 盘符/卷图标：横向的盒子 + 底部指示灯，与 DirIcon 同一描边风格。 */
    function DriveIcon(props) {
      var size = props !== null && props !== undefined && typeof props.size === 'number' ? props.size : 15
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
        style: { flex: '0 0 auto' },
      },
        h('rect', { x: 3, y: 6, width: 18, height: 12, rx: 2 }),
        h('path', { d: 'M3 14h18' }),
        h('circle', { cx: 17, cy: 17, r: 0.9, fill: 'currentColor', stroke: 'none' }))
    }

    /**
     * 一组「类型图标」：全部与 SuperPiIcon 同一描边风格（24 网格 / 1.7 / round），
     * 只用 currentColor，颜色由标签的 CSS 决定。
     *
     * 为什么不引入图标包：客户端 require 白名单里只有 react，插件必须零依赖；
     * 也不引图片资源，描边路径能在任意 DPI 下清晰。
     */
    function iconSvg(props, children) {
      var size = props !== null && props !== undefined && typeof props.size === 'number' ? props.size : 15
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
        style: { flex: '0 0 auto' },
      }, children)
    }

    /** 代码文件：尖括号。 */
    function CodeIcon(props) {
      return iconSvg(props, [
        h('path', { key: 'l', d: 'M9 8.5 5 12l4 3.5' }),
        h('path', { key: 'r', d: 'M15 8.5 19 12l-4 3.5' }),
      ])
    }

    /** 图片文件：相框 + 山与太阳。 */
    function ImageFileIcon(props) {
      return iconSvg(props, [
        h('rect', { key: 'b', x: 3.5, y: 4.5, width: 17, height: 15, rx: 2 }),
        h('circle', { key: 's', cx: 8.5, cy: 9.5, r: 1.4 }),
        h('path', { key: 'm', d: 'M4 17l4.8-4.4a1.4 1.4 0 0 1 1.9 0L20 19.5' }),
      ])
    }

    /** 压缩包：盒子 + 拉链。 */
    function ArchiveIcon(props) {
      return iconSvg(props, [
        h('rect', { key: 'b', x: 3.5, y: 4.5, width: 17, height: 15, rx: 2 }),
        h('path', { key: 'z', d: 'M12 4.5v3M12 9.5v2M12 13.5v2' }),
        h('path', { key: 'h', d: 'M10 17.5h4' }),
      ])
    }

    /** 表格：框 + 行线。 */
    function SheetFileIcon(props) {
      return iconSvg(props, [
        h('rect', { key: 'b', x: 3.5, y: 5, width: 17, height: 14, rx: 2 }),
        h('path', { key: 'v', d: 'M9.5 5v14M15 5v14' }),
        h('path', { key: 'h', d: 'M3.5 12h17' }),
      ])
    }

    /** 文档：折角纸 + 两行字（与 FileIcon 区分：纸内有内容线）。 */
    function DocIcon(props) {
      return iconSvg(props, [
        h('path', { key: 'p', d: 'M6.5 3.5h7.5l4 4v13a1 1 0 0 1-1 1h-10.5a1 1 0 0 1-1-1v-16a1 1 0 0 1 1-1z' }),
        h('path', { key: 'c', d: 'M14 3.5v4h4' }),
        h('path', { key: 'l1', d: 'M9 12.5h6' }),
        h('path', { key: 'l2', d: 'M9 16h4' }),
      ])
    }

    /** 思考：圆内十字（对齐 DSH 过程行的 thinking 图标）。 */
    function ThinkIcon(props) {
      return iconSvg(props, [
        h('circle', { key: 'c', cx: 12, cy: 12, r: 8.6 }),
        h('path', { key: 'a', d: 'M9.1 9.1 14.9 14.9' }),
        h('path', { key: 'b', d: 'M14.9 9.1 9.1 14.9' }),
      ])
    }

    /** 代码：井号。DSH 过程行里「一次模型回合」的父行用它。 */
    function HashIcon(props) {
      return iconSvg(props, [
        h('path', { key: 'a', d: 'M9.6 4.5 7.6 19.5' }),
        h('path', { key: 'b', d: 'M16.4 4.5 14.4 19.5' }),
        h('path', { key: 'c', d: 'M4.6 9.2h15' }),
        h('path', { key: 'd', d: 'M4 14.8h15' }),
      ])
    }

    /** 运行命令：终端提示符 >_。 */
    function TerminalIcon(props) {
      return iconSvg(props, [
        h('path', { key: 'a', d: 'M6.5 8 10 12l-3.5 4' }),
        h('path', { key: 'b', d: 'M12.5 16.4h5' }),
      ])
    }

    /** 读取图片 / 读取文件：带框图。 */
    function FrameIcon(props) {
      return iconSvg(props, [
        h('rect', { key: 'b', x: 3.5, y: 4.8, width: 17, height: 14.4, rx: 2 }),
        h('path', { key: 'i', d: 'M7.4 8.6v6.8' }),
        h('path', { key: 'l', d: 'M11 9.6h6.2' }),
        h('path', { key: 'l2', d: 'M11 14.4h4' }),
      ])
    }

    /** 搜索文件内容 / 查找文件：放大镜。 */
    function SearchIcon(props) {
      return iconSvg(props, [
        h('circle', { key: 'c', cx: 10.6, cy: 10.6, r: 6.1 }),
        h('path', { key: 'h', d: 'M15.2 15.2 20 20' }),
      ])
    }

    /** 写入 / 编辑文件：铅笔。 */
    function PencilIcon(props) {
      return iconSvg(props, [
        h('path', { key: 'p', d: 'M4.2 19.8h4l11-11a2.83 2.83 0 0 0-4-4l-11 11v4z' }),
        h('path', { key: 't', d: 'M14.6 5.4 18.6 9.4' }),
      ])
    }

    /** 兜底：四角星（DSH 的 others 也是这个语义）。 */
    function SparkIcon(props) {
      return iconSvg(props, [
        h('path', { key: 'a', d: 'M12 4.5l1.9 4.6 4.6 1.9-4.6 1.9L12 19.5l-1.9-4.6L5.5 13l4.6-1.9z' }),
      ])
    }


    /**
     * 鲸鱼尾：工作状态行的品牌标记（DSH RunningWhaleTail 的静态分支）。
     *
     * 与上面那组图标**不同一套规格**，所以不走 iconSvg：DSH 的路径是按 16 网格画的、
     * 描边 1 而不是 24 网格的 1.7。照抄路径与描边参数才能在同一字号下得到同样的粗细；
     * 换成 24 网格重画会立刻看出来是另一个图标。
     * 动效版（APNG 蒙版）是 DSH 的可选装饰，插件不引二进制资源，静态描边就是
     * DSH 自己在 prefers-reduced-motion 下的退化成什么样。
     */
    function WhaleTailIcon() {
      return h('svg', {
        width: '100%', height: '100%', viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
        style: { display: 'block' },
      }, h('path', {
        d: 'M8.844 13.742C8.967 12.328 8.45 10.4 8.45 9.65C8.45 8.94 8.88 8.43 9.6 8.43C11.285 8.43 12.106 8.281 12.685 8.104C13.71 7.791 14.585 6.768 15.055 5.945C15.137 5.803 14.99 5.641 14.829 5.671C13.829 5.86 12.828 5.376 11.827 4.978C10.659 4.514 9.491 4.707 8.935 4.876C8.805 4.915 8.658 4.819 8.636 4.686C8.468 3.643 7.405 2.615 5.498 2.238C4.54 2.048 3.748 1.574 3.347 1.202C3.252 1.113 3.088 1.125 3.03 1.242C2.628 2.059 2.168 3.82 5.248 6.115C5.82 6.494 6.31 6.785 6.574 7.637C6.72 8.104 6.157 9.168 6.061 9.368C5.157 11.27 5.089 12.19 4.926 13.742',
      }))
    }
    /** 关闭：两条对角线。抽屉与弹窗右上角统一用它，不再用纯文本 '×'。 */
    function CloseIcon(props) {
      return iconSvg(props, [
        h('path', { key: 'a', d: 'M7.5 7.5 16.5 16.5' }),
        h('path', { key: 'b', d: 'M16.5 7.5 7.5 16.5' }),
      ])
    }

    /** 回形针：插入文件。之前这里用的是产品 logo（SuperPiIcon），语义不对。 */
    function PaperclipIcon(props) {
      return iconSvg(props, [
        h('path', { key: 'p', d: 'M20.4 11.4l-8.5 8.5a5.4 5.4 0 0 1-7.6-7.6l8.5-8.5a3.6 3.6 0 0 1 5.1 5.1l-8.5 8.5a1.8 1.8 0 0 1-2.5-2.5l7.8-7.8' }),
      ])
    }

    /**
     * 抽屉 / 弹窗右上角统一的关闭按钮。
     *
     * 之前是纯文本 '×'（11px 字高、没有 -icon 类），在 16px 标题旁又小又轻，
     * 而且 Sheet 带 type="button"、DirSheet 不带，两处已经分叉。现在所有关闭
     * 入口共用这一个组件：28x28 命中区 + 16px 描边图标 + aria-label，
     * 与 .superpi-btn 基线的 28px 高度完全对齐。
     */
    function CloseButton(props) {
      var label = props.t('close')
      return h('button', {
        type: 'button',
        className: 'superpi-btn superpi-btn-ghost superpi-btn-icon',
        title: label,
        'aria-label': label,
        onClick: props.onClick,
      }, h(CloseIcon, { size: 16 }))
    }

    /** 加号：composer 左侧的「添加」入口（对齐 DSH composer 的 + 按钮）。 */
    function PlusIcon(props) {
      return iconSvg(props, [
        h('path', { key: 'v', d: 'M12 5.6v12.8' }),
        h('path', { key: 'h', d: 'M5.6 12h12.8' }),
      ])
    }

    /** 向上箭头：空闲态的发送键。 */
    function ArrowUpIcon(props) {
      return iconSvg(props, [
        h('path', { key: 'v', d: 'M12 19V5.6' }),
        h('path', { key: 'a', d: 'M6.1 11.4 12 5.5l5.9 5.9' }),
      ])
    }

    /**
     * 实心方块：运行中把发送键换成停止。
     * DSH 的 composer 只有一颗主按钮（空闲=箭头、运行=方块），这里保持同一模型 ——
     * 不再像 0.6.x 那样在旁边多挂一颗「停止 / 排队」文字按钮。
     */
    function StopSquareIcon(props) {
      return iconSvg(props, [
        h('rect', { key: 'r', x: 8.4, y: 8.4, width: 7.2, height: 7.2, rx: 1.6, fill: 'currentColor', stroke: 'none' }),
      ])
    }

    /** 下拉箭头：模型 / 推理等级选择器右侧的 V 形。 */
    function ChevronDownIcon(props) {
      return iconSvg(props, [
        h('path', { key: 'c', d: 'M6.5 9.6 12 15.1l5.5-5.5' }),
      ])
    }

    /** 省略号：顶栏的「更多」入口（压缩上下文 / 重新连接都收在这里）。 */
    function EllipsisIcon(props) {
      return iconSvg(props, [
        h('circle', { key: 'a', cx: 12, cy: 5.4, r: 1.35, fill: 'currentColor', stroke: 'none' }),
        h('circle', { key: 'b', cx: 12, cy: 12, r: 1.35, fill: 'currentColor', stroke: 'none' }),
        h('circle', { key: 'c', cx: 12, cy: 18.6, r: 1.35, fill: 'currentColor', stroke: 'none' }),
      ])
    }

    /** 左向 V 形：历史会话侧栏从会话层退回项目层。 */
    function ChevronLeftIcon(props) {
      return iconSvg(props, [
        h('path', { key: 'c', d: 'M14.5 5.4 8.9 11l5.6 5.6' }),
      ])
    }

    /** 图钉：会话置顶 / 取消置顶（实心针尖，与 DSH 的 pin 同语汇）。 */
    function PinIcon(props) {
      return iconSvg(props, [
        h('path', { key: 'p', d: 'M9.2 3.8h5.6l-.9 4.4 2.6 2.4v1.7h-3.3v6.2l-1.5 1.7-1.5-1.7v-6.2H6.9v-1.7l2.6-2.4-.3-4.4' }),
      ])
    }

    /** 芯片：模型。 */
    function ChipIcon(props) {
      return iconSvg(props, [
        h('rect', { key: 'r', x: 7, y: 7, width: 10, height: 10, rx: 2.2 }),
        h('path', { key: 'p', d: 'M10.2 3.6v3.4M13.8 3.6v3.4M10.2 17v3.4M13.8 17v3.4M3.6 10.2h3.4M3.6 13.8h3.4M17 10.2h3.4M17 13.8h3.4' }),
      ])
    }

    /** 闪电：推理等级。 */
    function BoltIcon(props) {
      return iconSvg(props, [
        h('path', { key: 'b', d: 'M13.4 3 6.8 13.2h4.1l-1 7.8 6.6-10.2h-4.1z' }),
      ])
    }

    /** 列表：历史会话。 */
    function ListIcon(props) {
      return iconSvg(props, [
        h('path', { key: 'l', d: 'M9 6.5h11M9 12h11M9 17.5h11' }),
        h('path', { key: 'd', d: 'M4.4 6.5h.02M4.4 12h.02M4.4 17.5h.02' }),
      ])
    }

    /** 仪表：会话统计 / 上下文占用。 */
    function GaugeIcon(props) {
      return iconSvg(props, [
        h('path', { key: 'a', d: 'M4 16.5a8.6 8.6 0 1 1 16 0' }),
        h('path', { key: 'n', d: 'M12 16.5 15.6 11' }),
      ])
    }

    /** 齿轮：设置。 */
    function GearIcon(props) {
      return iconSvg(props, [
        h('circle', { key: 'c', cx: 12, cy: 12, r: 3 }),
        h('path', { key: 'p', d: 'M12 3.4v2.4M12 18.2v2.4M3.4 12h2.4M18.2 12h2.4M6 6l1.7 1.7M16.3 16.3 18 18M18 6l-1.7 1.7M7.7 16.3 6 18' }),
      ])
    }

    /** 环形箭头：重连。 */
    function RefreshIcon(props) {
      return iconSvg(props, [
        h('path', { key: 'a', d: 'M20 12a8 8 0 1 1-2.4-5.7' }),
        h('path', { key: 'b', d: 'M20.2 4.4v4.2h-4.2' }),
      ])
    }

    /** 时钟：轮次 / 步数。 */
    function ClockIcon(props) {
      return iconSvg(props, [
        h('circle', { key: 'c', cx: 12, cy: 12, r: 8.4 }),
        h('path', { key: 'h', d: 'M12 7.6V12l3 1.9' }),
      ])
    }

    /** 数据库：token 用量。 */
    function DatabaseIcon(props) {
      return iconSvg(props, [
        h('path', { key: 'a', d: 'M4.4 7c0-1.7 3.4-3.1 7.6-3.1S19.6 5.3 19.6 7 16.2 10.1 12 10.1 4.4 8.7 4.4 7z' }),
        h('path', { key: 'b', d: 'M4.4 7v10c0 1.7 3.4 3.1 7.6 3.1s7.6-1.4 7.6-3.1V7' }),
        h('path', { key: 'c', d: 'M4.4 12c0 1.7 3.4 3.1 7.6 3.1s7.6-1.4 7.6-3.1' }),
      ])
    }

    /**
     * 把绝对路径切成面包屑：[{label, path}]。
     * - Windows：'C:\\Users\\PC' → C: / Users / PC，累积路径保持反斜杠。
     * - POSIX：'/home/pc' → '/' / home / pc。
     * 只做字符串切分，不碰文件系统 —— 面包屑必须能在目录读失败时照常显示。
     */
    function pathCrumbs(dir) {
      if (typeof dir !== 'string' || dir === '') return []
      var sep = dir.indexOf('\\') >= 0 ? '\\' : '/'
      var parts = dir.split(sep)
      var out = []
      var acc = ''
      for (var i = 0; i < parts.length; i += 1) {
        var part = parts[i]
        if (part === '') {
          if (i === 0) { acc = sep; out.push({ label: sep, path: sep }) }
          continue
        }
        if (acc === '') acc = part
        else if (acc === sep) acc = sep + part
        else acc = acc + sep + part
        out.push({ label: part, path: acc })
      }
      return out
    }

    // ── 过程行 ────────────────────────────────────────────────────────────────
    //
    // DSH 会话过程流的行解剖：一行 = [16px 图标][措辞][2×2 圆点][单行摘要]，
    // 详情收在同一条行的展开区里，展开区带一条左侧竖线与图标列对齐。
    // 四种行（思考 / 工具调用 / 工具结果 / ! bash）共用下面这一套构造器，
    // 分开写会让间距、字号、灰阶四处漂移 —— 那正是 0.4.0 之前的样子。

    /** pi 的工具参数是 JSON 文本；解析失败就当作「没有结构化参数」，不能让异常冒到渲染层。 */
    function parseToolArgs(argsText) {
      if (typeof argsText !== 'string' || argsText === '') return null
      try {
        var value = JSON.parse(argsText)
        return value !== null && typeof value === 'object' ? value : null
      } catch (error) {
        return null
      }
    }

    /** 单行摘要：只取第一行并压缩空白 —— 过程行永远是单行，超出部分交给 CSS 省略号。 */
    function firstLineOf(text) {
      var value = text === null || text === undefined ? '' : String(text)
      var cut = value.indexOf('\n')
      if (cut >= 0) value = value.slice(0, cut)
      return value.trim()
    }

    // pi 的 8 个工具（packages/coding-agent/src/core/tools/）：read / write / edit / bash /
    // powershell / grep / find / ls。措辞与图标按 DSH 的中文标题表对齐
    // （tool.title.read=读取、bash=运行命令、edit=编辑、grep=搜索文件内容、glob=查找文件），
    // 没有对应项的（ls）落到「浏览目录」，完全未知的工具才落到「工具调用」+ 星形图标。
    var TOOL_VIEWS = {
      read: { label: 'procRead', Icon: DocIcon },
      write: { label: 'procWrite', Icon: FrameIcon },
      edit: { label: 'procEdit', Icon: PencilIcon },
      bash: { label: 'procBash', Icon: TerminalIcon },
      powershell: { label: 'procBash', Icon: TerminalIcon },
      grep: { label: 'procGrep', Icon: SearchIcon },
      find: { label: 'procGlob', Icon: SearchIcon },
      ls: { label: 'procList', Icon: ListIcon },
      ask_user: { label: 'procAsk', Icon: SparkIcon },
      verify: { label: 'procVerify', Icon: TerminalIcon },
      task_progress: { label: 'procTaskProgress', Icon: ListIcon },
    }

    function toolViewOf(name, args) {
      var key = typeof name === 'string' ? name : ''
      var view = TOOL_VIEWS[key]
      if (view === undefined) return { label: 'procGeneric', Icon: SparkIcon, name: key }
      // 读图片与读文本是两条措辞、两个图标（DSH 的 readImage 亦然）；判据只能是扩展名。
      if (key === 'read' && args !== null && typeof args.path === 'string' && fileKindOf(args.path) === 'image') {
        return { label: 'procReadImage', Icon: FrameIcon, name: key }
      }
      return { label: view.label, Icon: view.Icon, name: key }
    }

    // 摘要优先取这些字段：命令 → 路径 → 模式。顺序固定，同一工具永远在同一行位置显示同一类信息。
    var TOOL_SUMMARY_FIELDS = ['command', 'path', 'file_path', 'pattern', 'query', 'url']

    function primaryToolArg(args) {
      if (args === null) return null
      for (var i = 0; i < TOOL_SUMMARY_FIELDS.length; i += 1) {
        var field = TOOL_SUMMARY_FIELDS[i]
        var value = args[field]
        if (typeof value === 'string' && value.trim() !== '') return { field: field, text: value }
      }
      return null
    }

    /**
     * 摘要格：路径可点（左键预览 / 右键定位），命令与模式是纯文本。
     * DSH 的过程行只给路径一条 1px 点线下划线，其余正文不着色 —— 这里照抄，
     * 不给每行都加可点态，否则整片过程流看起来像链接墙。
     */
    function ProcPath(props) {
      var acts = normalizeFileActions(props.actions)
      var text = String(props.path)
      if (acts.open === null && acts.reveal === null) {
        return h('span', { key: 'p', className: 'superpi-proc-text', title: text }, text)
      }
      return h('button', {
        key: 'p',
        type: 'button',
        className: 'superpi-proc-path',
        title: text,
        onClick: function (event) {
          event.preventDefault()
          event.stopPropagation()
          if (acts.open !== null) acts.open(text)
        },
        onContextMenu: function (event) {
          if (acts.reveal === null) return
          event.preventDefault()
          event.stopPropagation()
          acts.reveal(text)
        },
      }, text)
    }

    /** 摘要单元格的统一入口：有结构化主参数就用它，否则回落到调用名 / 原始参数首行。 */
    function procSummary(props) {
      var primary = props.primary
      if (primary === null) {
        return h('span', { key: 'p', className: 'superpi-proc-text' }, props.fallback)
      }
      var text = firstLineOf(primary.text)
      if (primary.field === 'path' || primary.field === 'file_path') {
        return h(ProcPath, { key: 'p', path: text, actions: props.actions })
      }
      return h('span', { key: 'p', className: 'superpi-proc-text', title: text }, text)
    }

    /**
     * 行头：[图标][措辞][圆点][摘要][可选注脚]。
     * 注脚放状态（失败 / exit N / truncated），它必须排在摘要之后，
     * 否则摘要是弹性的（flex:1 1 auto），状态会被挤到行外。
     */
    function procHead(parts) {
      var Icon = parts.Icon
      var cells = [
        h('span', { key: 'i', className: 'superpi-proc-icon' }, h(Icon, { size: 15 })),
        h('span', { key: 'l', className: 'superpi-proc-label' }, parts.label),
        h('span', { key: 's', className: 'superpi-sep', 'aria-hidden': 'true' }),
        parts.summary,
      ]
      var note = parts.note === null || parts.note === undefined ? '' : String(parts.note)
      if (note !== '') {
        cells.push(h('span', { key: 'n', className: 'superpi-proc-note', 'data-tone': parts.noteTone === undefined ? '' : parts.noteTone }, note))
      }
      return cells
    }

    function ThinkingBlock(props) {
      if (props.text === '') return null
      var summary = firstLineOf(props.text)
      return h('details', { className: 'superpi-proc', 'data-kind': 'thinking' },
        h('summary', { className: 'superpi-proc-head' }, procHead({
          Icon: ThinkIcon,
          label: props.t('procThink'),
          summary: h('span', { key: 'p', className: 'superpi-proc-text' }, summary),
        })),
        h('div', { className: 'superpi-proc-body' }, props.text))
    }

    function ToolBlock(props) {
      var t = props.t
      var args = parseToolArgs(props.argsText)
      var primary = primaryToolArg(args)
      var view = toolViewOf(props.name, args)
      var body = props.argsText === '' ? '{}' : props.argsText
      // 只有还在跑的时候才露 live —— 结束后 partial 与 output 是同一份内容的两副面孔，
      // 一起展示等于把结果印两遍（第一次实拍就撞上了）。
      if (props.status === 'running' && typeof props.partial === 'string' && props.partial !== '') {
        body = body + '\n\n── live ──\n' + props.partial
      }
      // 结果并进同一条行的展开区：一条调用只占一行，展开就是「参数 + 输出」。
      var resultText = typeof props.resultText === 'string' ? props.resultText : ''
      if (resultText !== '') body = body + '\n\n── output ──\n' + resultText
      // 调用名本身只在「没有结构化参数」时才需要露出来（DSH 的 generic 行同此语义）。
      var fallback = primary === null && view.label === 'procGeneric' ? view.name : ''
      // 根 className 必须**恰好**是 superpi-tool：门禁用 includes('class="superpi-tool"') 精确匹配。
      var attrs = { className: 'superpi-tool' }
      if (props.status === 'running') attrs['data-state'] = 'running'
      if (props.status === 'error') attrs['data-state'] = 'error'
      return h('details', attrs,
        h('summary', { className: 'superpi-proc-head' }, procHead({
          Icon: view.Icon,
          label: t(view.label),
          summary: procSummary({ primary: primary, fallback: fallback, actions: props.onOpenFile }),
          note: props.status === 'error' ? t('failed') : '',
          noteTone: 'err',
        })),
        h('pre', { className: 'superpi-tool-body' }, body))
    }

    function ToolResultRow(props) {
      var message = props.message
      var text = textOfMessage(message)
      var view = toolViewOf(message.toolName, null)
      var summary = firstLineOf(text)
      return h('details', { className: 'superpi-tool', 'data-role': 'toolResult' },
        h('summary', { className: 'superpi-proc-head' }, procHead({
          Icon: view.Icon,
          label: props.t('procResult'),
          summary: h('span', {
            key: 'p',
            className: 'superpi-proc-text',
            'data-tone': message.isError ? 'err' : '',
          }, summary === '' ? props.t('procResult') : summary),
          note: message.isError ? props.t('failed') : '',
          noteTone: 'err',
        })),
        h('pre', { className: 'superpi-tool-body' }, text === '' ? '{}' : text))
    }

    /**
     * 工作状态行：「深度求索中，用时 43分54秒 ···」。形状照 DSH 的 RunningStatus：
     * 鲸鱼尾图标 + 一行 brand 蓝文字，末尾三个中点（不是省略号——DSH 用 `···` 表示还在继续）。
     *
     * 计时器挂在这一条节点自己身上，而不是面板级 —— 面板级每秒 repaint 会把整条
     * 过程流（可能上百行、含流式 markdown）一起重算，只为刷新一行文字。
     * 这里是唯一需要 1Hz 的地方，自己 state 自己跳。
     *
     * 没有起点（`since` 缺省）时只说「深度求索中」，不编一个用时出来；有起点时照 DSH `RunningStatus` 的 `formatRunDuration(Math.max(1e3, now - startTime), t)` 钳到 1 秒（首帧否则闪「0秒」）。
     * 屏幕阅读器那边用 `role=status` + `aria-live=polite` 只播报不带秒数的那半句：
     * 每秒都在变的数字进 live region 会把读屏软件刷成噪音。
     */
    /**
     * 工作状态行。
     *
     * 0.14.0 起不只显示"深度求索中 N 分钟"，还显示**当前在跑什么、跑了多久、它自己
     * 设了多长上限**。理由：实测一个真实会话里 71 次工具执行超过 60 秒（累计 198 分钟），
     * 全是模型自己给 bash 传了 timeout=300/1800/6000 秒。这些等待是**合法的**
     * （跑全量测试、多次取帧），但用户只看到 Working 秒数一直涨，无从判断
     * 「它在干活」还是「它卡死了」。把工具名与上限摆出来，等待就从"疑似卡死"变成"可见的进度"。
     *
     * 上限已过而仍未返回时显式说明「超出上限、可能仍在下游执行」—— 不静默继续加秒数，
     * 因为那正是用户以为卡死的时刻。
     */
    /**
     * 工具静默多久后开始心跳（毫秒）。与 `extensions/superpi-editor.ts` 的
     * HEARTBEAT_AFTER_MS **必须同值** —— 两端同一句文案，节奏不同会让人觉得是两个系统。
     */
    var HEARTBEAT_AFTER_MS = 20000

    function WorkingRow(props) {
      var state = useState(0)
      var setTick = state[1]
      var since = props.since
      var known = typeof since === 'number' && since > 0
      var tool = props.tool === undefined ? null : props.tool
      var toolSince = tool !== null && typeof tool.startedAt === 'number' ? tool.startedAt : 0
      useEffect(function () {
        if (known === false) return undefined
        var timer = window.setInterval(function () { setTick(function (value) { return value + 1 }) }, 1000)
        return function () { window.clearInterval(timer) }
      }, [since, known])
      var label = props.t('deepDiving')
      var text = known === false ? label : props.t('working').replace('{duration}', fmtDuration(Math.max(1000, Date.now() - since), props.t))
      // 工具段：`bash · 8m20s · 上限 500s`（无上限时省掉最后一段）。
      var toolText = null
      if (tool !== null && tool.name !== '') {
        var elapsedMs = toolSince > 0 ? Math.max(1000, Date.now() - toolSince) : 0
        var parts = [String(tool.name)]
        if (elapsedMs > 0) parts.push(fmtDuration(elapsedMs, props.t))
        var limitSeconds = typeof tool.limitSeconds === 'number' && tool.limitSeconds > 0 ? tool.limitSeconds : 0
        if (limitSeconds > 0) {
          if (elapsedMs > 0 && elapsedMs > limitSeconds * 1000) parts.push(props.t('toolOverLimit').replace('{limit}', fmtDuration(limitSeconds * 1000, props.t)))
          else parts.push(props.t('toolLimit').replace('{limit}', fmtDuration(limitSeconds * 1000, props.t)))
        }
        // 0.15.0 静默心跳：与命令行窗口同口径（HEARTBEAT_AFTER_MS = 20s）。
        // 有输出时不显示（bash 每 100ms 发 update，那时工具行本身就有实时内容）；
        // 长时间无输出时明确说"已静默 N，仍在运行" —— 诚实地消解焦虑，不编造进度。
        var lastOutputAt = typeof tool.lastOutputAt === 'number' && tool.lastOutputAt > 0 ? tool.lastOutputAt : toolSince
        var silentMs = lastOutputAt > 0 ? Date.now() - lastOutputAt : 0
        if (silentMs >= HEARTBEAT_AFTER_MS) {
          parts.push(props.t('toolSilent').replace('{silent}', fmtDuration(silentMs, props.t)))
        }
        toolText = parts.join(' · ')
      }
      return h('div', { className: 'superpi-working' },
        h('span', { className: 'superpi-sr', role: 'status', 'aria-live': 'polite', key: 'sr' }, label),
        h('span', { className: 'superpi-working-icon', key: 'icon' }, h(WhaleTailIcon, null)),
        h('span', { className: 'superpi-working-text', key: 'text' }, text),
        toolText === null ? null : h('span', { className: 'superpi-working-tool', key: 'tool', title: toolText }, toolText))
    }

    function usageLine(usage, t) {
      if (usage === null || typeof usage !== 'object') return null
      var parts = []
      if (typeof usage.input === 'number') parts.push('in ' + String(usage.input))
      if (typeof usage.output === 'number') parts.push('out ' + String(usage.output))
      if (typeof usage.cacheRead === 'number' && usage.cacheRead > 0) parts.push('cache ' + String(usage.cacheRead))
      if (typeof usage.totalTokens === 'number') parts.push(String(usage.totalTokens) + ' ' + t('tokens'))
      if (parts.length === 0) return null
      return h('div', { className: 'superpi-usage' }, parts.join(' · '))
    }

    /**
     * 图片块：pi 把图片以 base64 交给模型，面板必须同样显示，不能降级成 "[image png]" 文字。
     *
     * 0.14.0：历史图片不再随 `get_messages` 下发 base64（那占历史体量的 88.2%），
     * 只给 `stubId`。这里渲染一张「N KB · 点击查看」的占位卡，**点开时**才走
     * `/images/:id` 取回真实像素 —— 用户看到的仍是完整的图，只是不再为「116 张里
     * 99% 都不会被点开」的那些付首屏传输与解码代价。
     *
     * 本轮（刚由工具产生）的图片仍是完整 base64，直接渲染，零额外请求。
     */
    function ImageBlock(props) {
      var open = props.onOpen
      // t 必须从 props 取：ImageBlock 是 module 级组件，拿不到 SuperPiPanel 闭包里的 t。
      // （少了这一行会直接 ReferenceError —— 0.14.0 的 client-render 门禁抓到过。）
      var t = typeof props.t === 'function' ? props.t : function (key) { return String(key) }
      var stubId = typeof props.stubId === 'string' ? props.stubId : null
      var hasData = typeof props.data === 'string' && props.data !== ''
      if (!hasData && stubId !== null) {
        var kb = typeof props.bytes === 'number' && props.bytes > 0 ? Math.round(props.bytes / 1024) : 0
        return h('button', {
          type: 'button',
          className: 'superpi-imagestub',
          'data-stub-id': stubId,
          title: props.mimeType,
          onClick: function () {
            if (open === undefined) return
            open({ stubId: stubId, mimeType: props.mimeType })
          },
        }, h('span', { className: 'superpi-imagestub-icon', 'aria-hidden': 'true' }, '▣'),
          h('span', { className: 'superpi-imagestub-text' },
            (kb > 0 ? String(kb) + ' KB' : String(props.mimeType)) + ' · ' + String(t('viewImage'))))
      }
      return h('img', {
        className: 'superpi-img',
        alt: props.mimeType,
        src: 'data:' + String(props.mimeType) + ';base64,' + String(props.data),
        onClick: function () { if (open !== undefined) open({ data: props.data, mimeType: props.mimeType }) },
      })
    }

    /**
     * 助手消息 → 过程流。
     *
     * 结构与 DSH 会话过程流同构：模型的「思考」是父行，紧随其后的「工具调用」缩进成
     * 子行组（左竖线 + 22px 缩进）；纯文本 / 图片是正文块，它们把过程流切成若干段，
     * 所以文本之后再次出现的工具调用会重新起一组，而不是继续挂在很久以前的思考下面。
     *
     * 工具结果不单独占一行：pi 把结果作为独立的 toolResult 消息送达，而 DSH 的
     * 一次调用 = 一行、输出收在同一行的展开区里。折叠逻辑在 SuperPiPanel 里按 toolCallId
     * 建表后传进来（props.results）；对不上号的孤儿结果仍按行渲染，不能吞掉内容。
     */
    function MessageRow(props) {
      var message = props.message
      var t = props.t
      var nodes = []
      var groupCount = 0
      var i = 0
      if (message.role === 'user') {
        var userText = textOfMessage(message)
        var userImages = message.blocks.filter(function (block) { return block.type === 'image' })
        return h('div', { className: 'superpi-row superpi-row-user' },
          h('div', { className: 'superpi-bubble-user' },
            userImages.length === 0 ? null : h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: userText === '' ? '0' : '6px' } },
              userImages.map(function (block, index) { return h(ImageBlock, { key: 'ui' + String(index), data: block.data, mimeType: block.mimeType, stubId: block.stubId, bytes: block.bytes, onOpen: props.onOpenImage, t: props.t }) })),
            userText === '' ? null : userText))
      }
      if (message.role === 'toolResult') {
        if (message.toolCallId !== null && props.results !== undefined && props.results[message.toolCallId] !== undefined) return null
        return h(ToolResultRow, { message: message, t: t })
      }
      if (message.role === 'bashExecution') {
        return h('div', { className: 'superpi-row' }, h('div', { className: 'superpi-body' }, h(BashBlock, { t: t, message: message })))
      }
      if (message.role !== 'assistant') return null

      var openThinking = null
      var openTools = null
      var flushTools = function () {
        if (openTools !== null && openTools.length > 0) {
          nodes.push(h('div', { key: 'g' + String(groupCount), className: 'superpi-sub' }, openTools))
          groupCount += 1
        }
        openTools = null
        openThinking = null
      }
      for (i = 0; i < message.blocks.length; i += 1) {
        var block = message.blocks[i]
        if (block.type === 'thinking') {
          if (block.text === '') continue
          // 新的思考行：把上一组子行收口，避免两次思考的子行混在一起。
          flushTools()
          nodes.push(h(ThinkingBlock, { key: 'k' + String(i), t: t, text: block.text }))
          openThinking = block
        } else if (block.type === 'toolCall') {
          var entry = block.id === null ? undefined : props.toolStatus[block.id]
          var result = block.id === null || props.results === undefined ? undefined : props.results[block.id]
          var row = h(ToolBlock, {
            key: 'k' + String(i),
            t: t,
            name: block.name,
            argsText: block.argsText,
            status: entry === undefined ? '' : entry.status,
            partial: entry === undefined ? '' : entry.partial,
            resultText: result === undefined ? '' : result.text,
            resultError: result === undefined ? false : result.isError,
            onOpenFile: props.onOpenFile,
          })
          if (openThinking === null) {
            // 没有思考铺路时，工具调用自己就是一条顶层过程行（DSH 的独立 tool 行同理）。
            if (openTools !== null) openTools.push(row)
            else nodes.push(row)
          } else {
            if (openTools === null) openTools = []
            openTools.push(row)
          }
        } else if (block.type === 'image') {
          flushTools()
          nodes.push(h(ImageBlock, { key: 'k' + String(i), data: block.data, mimeType: block.mimeType, stubId: block.stubId, bytes: block.bytes, onOpen: props.onOpenImage, t: props.t }))
        } else if (block.type === 'text' && block.text.trim() !== '') {
          flushTools()
          nodes.push(h('div', { key: 'k' + String(i), className: 'superpi-prose' }, renderMarkdown(block.text, props.onOpenFile)))
        }
      }
      flushTools()
      if (message.streaming) nodes.push(h('span', { key: 'caret', className: 'superpi-caret' }))
      if (message.stopReason === 'error') nodes.push(h('div', { key: 'stop', className: 'superpi-alert' }, t('error')))
      var usage = usageLine(message.usage, t)
      if (usage !== null) nodes.push(h('div', { key: 'usage' }, usage))
      return h('div', { className: 'superpi-row' }, h('div', { className: 'superpi-body' }, nodes))
    }

    /**
     * 空态：pi 还没有任何消息时显示。
     * cwd 之后给一个「选择工作区」入口 —— 这是用户在 DSH 里第一次用 pi 时
     * 最想做的事（默认 ~/superpi-workspace 不一定是他要的目录），也是 TUI 里
     * 「新建工作目录」的等价物。
     */
    function EmptyState(props) {
      var actions = typeof props.onPickDir !== 'function' ? null : h('div', { className: 'superpi-empty-actions' },
        h('button', { type: 'button', className: 'superpi-btn', title: props.t('dirTitle'), onClick: props.onPickDir },
          h(DirIcon, { size: 14 }),
          h('span', null, props.t('pickDir'))))
      return h('div', { className: 'superpi-empty' },
        h(SuperPiIcon, { size: 30 }),
        h('h2', null, props.t('emptyTitle')),
        h('p', null, props.t('emptyHint')),
        props.meta === null ? null : h('div', { className: 'superpi-empty-meta' }, props.meta),
        actions)
    }


    // ── 输入区组件 ──────────────────────────────────────────────────────────

    /**
     * SlashMenu：斜杠命令与 @文件补全共用这一层。
     * 数据源是 src/rpc-contract.mjs 的 TUI_COMMANDS（/contract 路由原样下发）
     * 加上 pi 自己通过 get_commands 报上来的 extension / prompt / skill 命令。
     */
    function SlashMenu(props) {
      var items = props.items
      if (items.length === 0) return null
      var active = Math.max(0, Math.min(props.active, items.length - 1))
      return h('div', { className: 'superpi-menu' },
        h('div', { className: 'superpi-menu-head' }, props.title),
        h('div', { className: 'superpi-menu-list' },
          items.map(function (item, index) {
            return h('div', {
              key: item.key,
              className: 'superpi-item',
              'data-active': index === active ? 'true' : 'false',
              onMouseDown: function (event) { event.preventDefault(); props.onPick(item) },
              onMouseEnter: function () { props.onHover(index) },
            },
              h('div', { className: 'superpi-item-main' },
                h('div', { className: 'superpi-item-name' }, item.name),
                item.desc === '' ? null : h('div', { className: 'superpi-item-desc' }, item.desc)),
              item.side === '' ? null : h('div', { className: 'superpi-item-side', 'data-tone': item.tone === undefined ? '' : item.tone }, item.side))
          })))
    }

    /**
     * 「+」菜单：宿主主对话区那个圆形加号的弹层。
     *
     * 只列面板真正做得到的事（文件 / 工作区 / 模型 / 推理等级 / 压缩 / 统计 / 会话 / 设置 /
     * 快捷键 / 新会话 / 重连）——宿主截图里的「目标 / 计划 / 反馈」在 pi 的 RPC 契约里没有
     * 对应能力，编不出来就不放，否则点下去只能弹一句错误。
     */
    function AddMenu(props) {
      var t = props.t
      var state = useState(-1)
      var active = state[0]
      var setActive = state[1]
      var items = props.items
      var children = []
      var lastGroup = null
      for (var i = 0; i < items.length; i += 1) {
        var item = items[i]
        if (item.group !== lastGroup) {
          lastGroup = item.group
          children.push(h('div', { key: 'g:' + item.group, className: 'superpi-menu-section' }, item.groupLabel))
        }
        children.push(h('button', {
          key: 'i:' + item.key,
          type: 'button',
          className: 'superpi-add-item',
          'data-active': active === i ? '1' : '0',
          role: 'menuitem',
          onMouseEnter: function (index) { return function () { setActive(index) } }(i),
          onMouseDown: function (pick) { return function (event) { event.preventDefault(); props.onPick(pick) } }(item),
        },
          h('span', { className: 'superpi-add-icon' }, item.icon === null ? null : h(item.icon, { size: 16 })),
          h('span', { className: 'superpi-add-text' },
            h('span', { className: 'superpi-add-label' }, item.label),
            h('span', { className: 'superpi-add-key' }, item.keyName)),
          item.desc === '' ? null : h('span', { className: 'superpi-add-desc' }, item.desc)))
      }
      return h('div', {
        className: 'superpi-menu superpi-menu-add',
        role: 'menu',
        onKeyDown: function (event) {
          if (event.key === 'Escape') { event.preventDefault(); props.onClose() }
        },
      }, children)
    }

    /**
     * Composer：所有输入的必经之路。
     *
     * 三种提交形态（与 TUI 的 setupEditorSubmitHandler 一一对应）：
     *   1. 斜杠命令 → 由 SuperPiPanel.handleSlash 决定走 RPC 还是面板 UI，**绝不把 /compact 当 prompt 发出去**
     *   2. ! / !!    → bash RPC（!! 带 excludeFromContext）
     *   3. 普通文本  → prompt；busy 时用 streamingBehavior:'steer'（对齐 interactive-mode.ts:3507）
     *
     * 图片：粘贴/选文件后进 props.images，提交时塞进 prompt.images（ImageContent 形状见契约）。
     */
    function Composer(props) {
      var t = props.t
      var textRef = useRef(null)
      var taRef = useRef(null)
      var stateText = useState('')
      var text = stateText[0]
      var setText = stateText[1]
      var stateMenu = useState(null)
      var menu = stateMenu[0]
      var setMenu = stateMenu[1]
      var stateActive = useState(0)
      var active = stateActive[0]
      var setActive = stateActive[1]
      var stateFiles = useState([])
      var files = stateFiles[0]
      var setFiles = stateFiles[1]
      var stateAddOpen = useState(false)
      var addOpen = stateAddOpen[0]
      var setAddOpen = stateAddOpen[1]
      var addRef = useRef(null)
      var pickerRef = useRef(null)

      // 「+」菜单是浮层：点外面或按 Esc 都得关掉，否则它会一直盖在输入区上。
      useEffect(function () {
        if (addOpen !== true) return undefined
        function onDocDown(event) {
          var node = addRef.current
          if (node !== null && node !== undefined && node.contains(event.target)) return
          setAddOpen(false)
        }
        function onDocKey(event) {
          if (event.key === 'Escape') setAddOpen(false)
        }
        document.addEventListener('mousedown', onDocDown)
        document.addEventListener('keydown', onDocKey)
        return function () {
          document.removeEventListener('mousedown', onDocDown)
          document.removeEventListener('keydown', onDocKey)
        }
      }, [addOpen])

      // 模型 / 思考档位弹层同理：点外面或 Esc 关闭。开合是受控的（pickerOpen 在面板上），
      // 这里只负责把「关」这个意图回传，面板切档位之后也会自己收回弹层。
      useEffect(function () {
        if (props.pickerOpen !== true) return undefined
        function onDocDown(event) {
          var node = pickerRef.current
          if (node !== null && node !== undefined && node.contains(event.target)) return
          props.onClosePicker()
        }
        function onDocKey(event) {
          if (event.key === 'Escape') props.onClosePicker()
        }
        document.addEventListener('mousedown', onDocDown)
        document.addEventListener('keydown', onDocKey)
        return function () {
          document.removeEventListener('mousedown', onDocDown)
          document.removeEventListener('keydown', onDocKey)
        }
      }, [props.pickerOpen])

      function resize() {
        var node = taRef.current
        if (node === null || node === undefined) return
        node.style.height = 'auto'
        var next = node.scrollHeight
        if (next > 220) next = 220
        node.style.height = String(next) + 'px'
      }

      useEffect(function () { resize() }, [text])

      // editor_text 是扩展主动写输入框的通道（TUI 里就是 editor.setText）
      useEffect(function () {
        if (props.editorText === null || props.editorText === undefined) return
        setText(props.editorText)
        props.onEditorTextConsumed()
      }, [props.editorText])

      function submit() {
        var value = text
        if (value.trim() === '' && props.images.length === 0) return
        setText('')
        setMenu(null)
        props.onSubmit(value)
      }

      /** 计算补全菜单：'/' 开头走命令，'@' 开头走文件（文件列表来自 host 的 GET /files）。 */
      function refreshMenu(value, caret) {
        var head = value.slice(0, caret)
        var slash = /(^|\s)\/([A-Za-z0-9_:.-]*)$/.exec(head)
        if (slash !== null) {
          var word = slash[2].toLowerCase()
          var entries = props.slashEntries.filter(function (entry) {
            if (word === '') return true
            return entry.name.toLowerCase().indexOf(word) >= 0
          })
          setMenu({ kind: 'slash', token: slash[0], items: entries, start: caret - word.length - 1 })
          setActive(0)
          return
        }
        var at = /(^|\s)@([^\s@]*)$/.exec(head)
        if (at !== null) {
          var query = at[2]
          var found = props.searchFiles(query)
          if (found !== null && found !== undefined && typeof found.then === 'function') {
            found.then(function (items) { setFiles(Array.isArray(items) ? items : []) }, function () { setFiles([]) })
          } else {
            setFiles(Array.isArray(found) ? found : [])
          }
          setMenu({ kind: 'file', token: at[0], items: [], start: caret - query.length - 1, query: query })
          setActive(0)
          return
        }
        setMenu(null)
      }

      useEffect(function () {
        if (menu === null || menu.kind !== 'file') return
        setMenu({ kind: 'file', token: menu.token, items: files, start: menu.start, query: menu.query })
        setActive(0)
      }, [files])

      function onChange(event) {
        var value = event.target.value
        setText(value)
        refreshMenu(value, event.target.selectionStart)
      }

      function insertToken(item) {
        if (menu === null) return
        var caret = menu.start
        var tail = text.slice(caret)
        var atSpace = tail.indexOf(' ')
        if (atSpace >= 0) tail = tail.slice(atSpace)
        else tail = ''
        var insert = item.insert
        var next = text.slice(0, caret) + insert + (insert.charAt(insert.length - 1) === ' ' ? '' : ' ') + tail.replace(/^\s+/, '')
        setText(next)
        setMenu(null)
        var node = taRef.current
        if (node !== null && node !== undefined) {
          var pos = caret + insert.length + 1
          window.setTimeout(function () { node.focus(); node.setSelectionRange(pos, pos) }, 0)
        }
      }

      function onKeyDown(event) {
        // 与 TUI 的 keybindings 对齐（pi-main/packages/coding-agent/src/core/keybindings.ts）：
        //   ctrl+p            → app.model.cycleForward      → cycle_model
        //   shift+tab         → app.thinking.cycle          → cycle_thinking_level
        //   alt+enter / ctrl+q → app.message.followUp       → follow_up
        //   alt+q / alt+up    → app.message.dequeue         → clear_queue
        if (event.ctrlKey === true && event.key === 'p') {
          event.preventDefault()
          props.onCycleModel()
          return
        }
        if (event.shiftKey === true && event.key === 'Tab') {
          event.preventDefault()
          props.onCycleThinking()
          return
        }
        if (event.altKey === true && (event.key === 'q' || event.key === 'Q')) {
          event.preventDefault()
          props.onDequeue()
          return
        }
        if (event.altKey === true && event.key === 'Enter') {
          event.preventDefault()
          var altValue = text
          if (altValue.trim() === '') return
          setText('')
          setMenu(null)
          props.onFollowUp(altValue)
          return
        }
        if (menu !== null && menu.items.length > 0) {
          if (event.key === 'ArrowDown') { event.preventDefault(); setActive((active + 1) % menu.items.length); return }
          if (event.key === 'ArrowUp') { event.preventDefault(); setActive((active - 1 + menu.items.length) % menu.items.length); return }
          if (event.key === 'Tab' || (event.key === 'Enter' && menu.kind === 'slash' && /^\/([A-Za-z0-9_:.-]*)$/.test(text.trim()))) {
            event.preventDefault()
            insertToken(menu.items[Math.max(0, Math.min(active, menu.items.length - 1))])
            return
          }
        }
        if (event.key === 'Escape') {
          if (menu !== null) { event.preventDefault(); setMenu(null); return }
          event.preventDefault()
          props.onStop()
          return
        }
        if (event.key === 'Enter' && event.shiftKey === false && event.nativeEvent !== undefined && event.nativeEvent.isComposing) return
        if (event.key === 'Enter' && event.shiftKey === false) { event.preventDefault(); submit() }
      }

      /** 把一段文本插到光标处，并按 pi 的规矩在前后补空格（interactive-mode.ts:3286-3292）。 */
      function insertText(chunk) {
        if (chunk === '') return
        var node = taRef.current
        var caret = node === null || node === undefined || typeof node.selectionStart !== 'number' ? text.length : node.selectionStart
        var before = text.slice(0, caret)
        var after = text.slice(caret)
        var lead = before === '' || /\s$/.test(before) ? '' : ' '
        var tail = after === '' || /^\s/.test(after) ? '' : ' '
        setText(before + lead + chunk + tail + after)
        setMenu(null)
        if (node !== null && node !== undefined) {
          var pos = (before + lead + chunk).length
          window.setTimeout(function () { node.focus(); node.setSelectionRange(pos, pos) }, 0)
        }
      }

      /**
       * 剪贴板 / 选择框里的文件怎么落地 —— 与命令行 pi 的 handleClipboardPaste 一一对应
       * （pi-main/packages/coding-agent/src/modes/interactive/interactive-mode.ts:3278-3318）：
       *   ① 图片 → 作为 ImageContent 附件（RPC 的 prompt/steer/follow_up 只有这一个附件通道）；
       *   ② 其它文件 / 压缩包 → 把绝对路径文本插进输入框（pi 自己会用 read / bash 去打开它）；
       *   ③ 拿不到本地路径（浏览器里访问 DSH 时 __DSH_HOST_PATHS__ 不存在）→ 明确告诉用户
       *      改用 @ 补全，绝不假装成功。
       * 面板不复制文件字节：RPC 契约里没有任意文件的附件字段，伪造成图片通道就是错的语义。
       */
      function takeFiles(list) {
        var images = []
        var paths = []
        var unresolved = 0
        var files = list === null || list === undefined ? [] : list
        for (var i = 0; i < files.length; i += 1) {
          var file = files[i]
          if (file === null || file === undefined) continue
          var type = typeof file.type === 'string' ? file.type : ''
          if (type.indexOf('image/') === 0) { images.push(file); continue }
          var local = pathOfFile(file)
          if (local !== '') paths.push(local)
          else unresolved += 1
        }
        if (images.length > 0) props.onImages(images)
        if (paths.length > 0) insertText(paths.join('\n'))
        if (unresolved > 0) props.onPathsUnavailable(unresolved)
      }

      function onPaste(event) {
        var data = event.clipboardData
        if (data === null || data === undefined) return
        var fileItems = []
        if (data.items !== undefined) {
          for (var i = 0; i < data.items.length; i += 1) {
            var item = data.items[i]
            if (item.kind !== 'file') continue
            var file = item.getAsFile()
            if (file !== null) fileItems.push(file)
          }
        }
        if (fileItems.length === 0) return
        event.preventDefault()
        takeFiles(fileItems)
      }

      function pickFiles() {
        var input = document.createElement('input')
        input.type = 'file'
        input.multiple = true
        input.onchange = function () {
          var picked = []
          for (var i = 0; i < input.files.length; i += 1) picked.push(input.files[i])
          takeFiles(picked)
        }
        input.click()
      }

      var placeholder = t('composerHint')
      var busy = props.busy
      var canSend = text.trim() !== '' || props.images.length > 0
      var tip = busy === true ? t('composerTipBusy') : t('composerTipIdle')

      // 「+」菜单的条目：分组 + 图标 + 中文标签 + 英文键 + 右侧说明，对齐宿主的加号菜单。
      // 每一项都必须真的能做（点下去就有结果），宿主里 pi 没有对应能力的条目一律不放。
      var addItems = [
        { key: 'file', group: 'add', groupLabel: t('addGroupAdd'), label: t('addFile'), keyName: 'file', desc: t('addFileDesc'), icon: FileIcon, run: pickFiles },
        { key: 'dir', group: 'add', groupLabel: t('addGroupAdd'), label: t('pickDir'), keyName: 'workspace', desc: t('addDirDesc'), icon: DirIcon, run: props.onPickDir },
        { key: 'sessions', group: 'add', groupLabel: t('addGroupAdd'), label: t('sessions'), keyName: 'sessions', desc: t('addSessionsDesc'), icon: ClockIcon, run: props.onOpenSessions },
        { key: 'compact', group: 'cmd', groupLabel: t('addGroupCommands'), label: t('compactNow'), keyName: 'compact', desc: t('addCompactDesc'), icon: ArchiveIcon, run: function () { props.onCompact() } },
        { key: 'model', group: 'cmd', groupLabel: t('addGroupCommands'), label: t('model'), keyName: 'model', desc: t('addModelDesc'), icon: ChipIcon, run: props.onOpenModels },
        { key: 'thinking', group: 'cmd', groupLabel: t('addGroupCommands'), label: t('thinking'), keyName: 'thinking', desc: t('addThinkingDesc'), icon: BoltIcon, run: props.onOpenThinking },
        { key: 'stats', group: 'cmd', groupLabel: t('addGroupCommands'), label: t('stats'), keyName: 'stats', desc: t('addStatsDesc'), icon: GaugeIcon, run: props.onOpenStats },
        { key: 'settings', group: 'cmd', groupLabel: t('addGroupCommands'), label: t('settings'), keyName: 'settings', desc: t('addSettingsDesc'), icon: GearIcon, run: props.onOpenSettings },
        { key: 'hotkeys', group: 'cmd', groupLabel: t('addGroupCommands'), label: t('hotkeys'), keyName: 'hotkeys', desc: t('addHotkeysDesc'), icon: ListIcon, run: props.onOpenHotkeys },
        { key: 'new', group: 'cmd', groupLabel: t('addGroupCommands'), label: t('newSession'), keyName: 'new', desc: t('addNewDesc'), icon: RefreshIcon, run: props.onNewSession },
      ]

      var modelName = props.model === null || props.model === undefined ? '' : String(props.model.id)
      var thinkingLevels = Array.isArray(props.thinkingLevels) ? props.thinkingLevels : []

      // 右端那颗圆钮与宿主同义：空闲时是「发出去」（向上箭头），运行中同一位置变「停下」（方块）。
      // 运行中输入回车仍然是 steer 插话、Alt+Enter 仍然是排队 —— 这两个语义靠键盘走，
      // 不占按钮（按钮只有一个，位置固定，语义随状态切换，用户不用重新找）。
      var sendButton = busy === true
        ? h('button', {
          type: 'button',
          className: 'superpi-stop',
          title: t('stop') + ' (Esc)',
          'aria-label': t('stop'),
          onClick: props.onStop,
        }, h(StopSquareIcon, { size: 14 }))
        : h('button', {
          type: 'button',
          className: 'superpi-send',
          disabled: canSend === false,
          title: t('send') + ' (Enter)',
          'aria-label': t('send'),
          onClick: submit,
        }, h(ArrowUpIcon, { size: 16 }))

      return h('div', { className: 'superpi-composer' },
        h('div', { className: 'superpi-composer-inner' },
          props.widgets.length === 0 ? null : h('div', { className: 'superpi-widget' },
            props.widgets.map(function (widget, index) { return h('pre', { key: 'w' + String(index), className: 'superpi-widget-body' }, widget.lines.join('\n')) })),
          h('div', { className: 'superpi-box' },
            props.images.length === 0 ? null : h('div', { className: 'superpi-thumbs' },
              props.images.map(function (image, index) {
                return h('div', { key: 't' + String(index), className: 'superpi-thumb' },
                  h('img', { alt: image.name, src: 'data:' + image.mimeType + ';base64,' + image.data }),
                  h('button', { type: 'button', className: 'superpi-thumb-x', title: t('imageRemove'), onClick: function () { props.onRemoveImage(index) } }, '×'))
              })),
            h('textarea', {
              ref: taRef,
              className: 'superpi-ta',
              rows: 1,
              value: text,
              placeholder: placeholder,
              onChange: onChange,
              onKeyDown: onKeyDown,
              onPaste: onPaste,
            }),
            menu === null ? null : h(SlashMenu, {
              items: menu.items.map(function (item, index) {
                return Object.assign({ key: (item.name === undefined ? item.path : item.name) + ':' + String(index) }, item)
              }),
              active: active,
              title: menu.kind === 'slash' ? t('commands') : t('files'),
              onHover: setActive,
              onPick: insertToken,
            }),
            h('div', { className: 'superpi-bar' },
              // 左：宿主是「圆形 + / 模型 / 推理等级」。附件与目录都收进 + 菜单，
              // 否则行里会挤五个控件，跟宿主的样子就差远了。
              h('div', { className: 'superpi-bar-actions' },
                h('span', { className: 'superpi-add-wrap', ref: addRef },
                  h('button', {
                    type: 'button',
                    className: 'superpi-add',
                    'data-open': addOpen === true ? '1' : '0',
                    title: t('addMenu'),
                    'aria-label': t('addMenu'),
                    'aria-expanded': addOpen === true ? 'true' : 'false',
                    onClick: function () { setAddOpen(addOpen !== true) },
                  }, h(PlusIcon, { size: 16 })),
                  addOpen === true ? h(AddMenu, {
                    t: t,
                    items: addItems,
                    onPick: function (item) {
                      setAddOpen(false)
                      setMenu(null)
                      var node = taRef.current
                      if (node !== null && node !== undefined) node.focus()
                      if (item !== null && item !== undefined && typeof item.run === 'function') item.run()
                    },
                    onClose: function () { setAddOpen(false) },
                  }) : null),
                // 模型名与思考档位合成一个锚点，点开的是同一张向上弹层（用户 30427）：
                // 原来模型名是按钮、档位是原生 select 叠在自绘外壳里，同一个位置两种交互；
                // 而且换档位要铺开整个抽屉，选完再收起，来回四拍。
                modelName === '' && thinkingLevels.length === 0 ? null : h('span', { className: 'superpi-picker-box', ref: pickerRef },
                  modelName === '' ? null : h('button', {
                    type: 'button',
                    className: 'superpi-picker',
                    title: t('modelHint') + ' · ' + String(props.model.provider) + '/' + String(props.model.id),
                    'aria-haspopup': 'menu',
                    'aria-expanded': props.pickerOpen === true ? 'true' : 'false',
                    onClick: props.onOpenPicker,
                  },
                    h('span', { className: 'superpi-picker-name' }, modelName),
                    h(ChevronDownIcon, { size: 12 })),
                  thinkingLevels.length === 0 ? null : h('button', {
                    type: 'button',
                    className: 'superpi-picker superpi-picker-level',
                    title: t('thinkingHint'),
                    'aria-haspopup': 'menu',
                    'aria-expanded': props.pickerOpen === true ? 'true' : 'false',
                    onClick: props.onOpenPicker,
                  },
                    h('span', { className: 'superpi-picker-label' }, String(props.thinking)),
                    h(ChevronDownIcon, { size: 12 })),
                  props.pickerOpen === true ? h(ModelPicker, {
                    t: t,
                    models: props.models,
                    loading: props.modelsLoading === true,
                    current: props.model,
                    thinking: props.thinking,
                    levels: thinkingLevels,
                    onPickModel: props.onPickModel,
                    onPickThinking: props.onPickThinking,
                    onClose: props.onClosePicker,
                  }) : null)),
              // 右：快捷键提示 + 圆形发送键。提示语是两套完整语义（空闲 / 运行中），
              // 不借用 slashHint（那讲的是菜单导航，只在菜单弹出时才成立）。
              h('div', { className: 'superpi-bar-right' },
                h('span', { className: 'superpi-bar-hint', title: tip }, tip),
                sendButton)),
            h('div', { className: 'superpi-sr' }, placeholder))),
        // dock：宿主的统计行在输入卡下方、同一个 composer 容器里（.GRgSLq_dock）。
        // 放在这里而不是面板根部，背景、左右内缩、随 composer 一起贴底，才跟宿主一致。
        props.footer === null || props.footer === undefined ? null : props.footer)
    }


    // ── 抽屉（历史会话 / 树 / fork / 统计 / 设置 / changelog）────────────────

    /** 所有抽屉共用外壳：标题栏 + 关闭，body 负责滚动。 */
    function Sheet(props) {
      return h('div', { className: 'superpi-sheet', role: 'dialog', 'aria-label': props.title },
        h('div', { className: 'superpi-sheet-head' },
          h('div', { className: 'superpi-sheet-title' }, props.title),
          props.actions === undefined ? null : props.actions,
          h(CloseButton, { t: props.t, onClick: props.onClose })),
        h('div', { className: 'superpi-sheet-body' }, props.children))
    }

    /**
     * 遮罩点击判定（用户 35984：居中弹窗一律模态，点非弹窗区域隐藏）。
     *
     * 只认 `event.target === event.currentTarget`：卡片内部的点击会冒泡到遮罩，那时 target 是卡片里的
     * 某个节点而不是遮罩本身，不该关。反过来也成立 —— 从卡片里拖选文本、松手落到遮罩上时 target 是
     * 遮罩，会关；这和浏览器地址栏里拖选松手的直觉一致，用户要的就是「点了外面」。
     *
     * 不用 stopPropagation：内层每一处都得记得吞事件，漏一处就是「点卡片也关」。判定式只有这一份，
     * 四个弹窗（Dialog / ConfirmDialog / DirSheet / ExtensionDialog）与 SidePanel 全走它。
     */
    function maskHandler(onClose) {
      return function (event) {
        if (event.target === event.currentTarget) onClose()
      }
    }

    /**
     * 点外部关闭的判定（菜单）：菜单自身与触发按钮都算「内部」。
     *
     * 触发按钮必须放行 —— 否则同一次点击里 mousedown 先把它关掉、随后的 click 又打开，
     * 表现为「⋯ 怎么点都关不掉」。anchor 是触发按钮的 ref 对象（可为 null）。
     */
    function isOutsideMenu(node, anchor, target) {
      if (node !== null && node !== undefined && node.contains(target)) return false
      var trigger = anchor === null || anchor === undefined ? null : anchor.current
      if (trigger !== null && trigger !== undefined && trigger.contains(target)) return false
      return true
    }

    /**
     * 居中弹窗外壳（统计 / 设置 / 二次确认）。
     *
     * 与抽屉（Sheet）的分界是**语义**：抽屉是「进到另一个空间去挑东西」（历史会话、树、
     * fork、目录），弹窗是「在当前对话上盖一层、处理完就回到原位」。统计与设置属于后者 ——
     * 用户 30427 的原话是「弹出弹窗，不要使用页面」。
     * 配方照抄 DirSheet / ExtensionDialog：遮罩 superpi-dialog-wrap + 卡片 superpi-dialog。
     */
    function Dialog(props) {
      var className = props.wide === true ? 'superpi-dialog superpi-dialog-wide' : 'superpi-dialog'
      return h('div', { className: 'superpi-dialog-wrap', onClick: maskHandler(props.onClose) },
        h('div', { className: className, role: 'dialog', 'aria-modal': 'true', 'aria-label': props.title },
          h('div', { className: 'superpi-dialog-head' },
            h('h3', null, props.title),
            h(CloseButton, { t: props.t, onClick: props.onClose })),
          h('div', { className: 'superpi-dialog-content' }, props.children)))
    }

    /**
     * 左侧滑入侧栏（历史会话）。
     *
     * 用户 30427 要的是「从页面左侧向右侧弹出侧边栏弹窗」—— 占满面板的抽屉会把当前对话
     * 整个盖掉，选会话时看不到自己在哪儿；侧栏只取左边一条，右边留着上下文。
     */
    function SidePanel(props) {
      // onBack 给了才出返回箭头：历史会话的会话层要能退回项目层，其它侧栏没有上一层。
      var back = props.onBack === undefined ? null : h('button', {
        type: 'button',
        className: 'superpi-btn superpi-btn-ghost superpi-btn-icon superpi-side-back',
        title: props.backTitle === undefined ? props.t('allProjects') : props.backTitle,
        'aria-label': props.backTitle === undefined ? props.t('allProjects') : props.backTitle,
        onClick: props.onBack,
      }, h(ChevronLeftIcon, { size: 16 }))
      return h('div', {
        className: 'superpi-side-wrap',
        onClick: maskHandler(props.onClose),
      },
        h('div', { className: 'superpi-side', role: 'dialog', 'aria-modal': 'true', 'aria-label': props.title },
          h('div', { className: 'superpi-side-head' },
            back,
            h('div', { className: 'superpi-side-title' }, props.title),
            h(CloseButton, { t: props.t, onClick: props.onClose })),
          props.actions === undefined ? null : h('div', { className: 'superpi-side-actions' }, props.actions),
          h('div', { className: 'superpi-side-body' }, props.children)))
    }

    /**
     * 二次确认：压缩上下文 / 重新连接都是「不可撤销或会打断当前一轮」的动作，
     * 从「更多」菜单里点出来之后必须再多问一次（用户 30427）。
     */
    function ConfirmDialog(props) {
      var t = props.t
      // 点遮罩 = 取消，绝不等于确认：确认是一次不可逆动作，只能由按钮或 Enter 触发。
      return h('div', { className: 'superpi-dialog-wrap', onClick: maskHandler(props.onCancel) },
        h('div', { className: 'superpi-dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': props.title },
          h('div', { className: 'superpi-dialog-head' },
            h('h3', null, props.title),
            h(CloseButton, { t: t, onClick: props.onCancel })),
          h('p', { className: 'superpi-dialog-msg' }, props.body),
          h('div', { className: 'superpi-dialog-actions' },
            h('button', { type: 'button', className: 'superpi-btn', onClick: props.onCancel }, t('cancel')),
            h('button', { type: 'button', className: 'superpi-btn superpi-btn-primary', onClick: props.onConfirm }, t('extYes')))))
    }

    /** 顶栏「更多」的下拉：锚在按钮右下，向下展开，项 = 图标 + 文案。 */
    /**
     * 「这一轮没交付」告警条（0.18.0 从 renderGate 里抽成组件）。
     *
     * 为什么抽出来：0.16.2 起这段逻辑内联在 `renderGate` 里，于是**没有任何门禁
     * 能渲染它** —— 只能靠 `indexOf` 断言字符串存在。那正是 0.16.1 D-05 那个
     * 「协议字段发了出去、但没人断言面板会渲染」的形状：管道通了 ≠ 交付到了。
     * 抽成纯展示组件后，`test/turn-verdict.mjs` 可以用 react-dom/server 真的把它
     * 渲成 HTML，断言文案、按钮、禁用态 —— 用户能不能看见，从此是机器事实。
     *
     * 组件**不含任何判据**：`verdict` 由 host 算好（`message_end.verdict`），
     * 连同中英文案一起下发。这里只做两件事：按语言选一段文案、给一个「继续」按钮。
     */
    function VerdictNotice(props) {
      var verdict = props.verdict
      if (verdict === null || verdict === undefined) return null
      var notice = verdict.notice !== null && typeof verdict.notice === 'object' ? verdict.notice : {}
      var text = String(props.lang) === 'en'
        ? String(notice.en === undefined ? '' : notice.en)
        : String(notice.zh === undefined ? '' : notice.zh)
      return h('div', { className: 'superpi-verdict-box', role: 'status', 'aria-live': 'polite' },
        h('div', { className: 'superpi-verdict-text' }, text),
        h('div', { className: 'superpi-verdict-actions' },
          h('button', {
            type: 'button',
            className: 'superpi-btn superpi-btn-primary superpi-verdict-retry',
            // 按钮与用户手打「继续」走**同一条** submit 路径：没有第二条发送通道。
            onClick: function () { if (props.busy !== true && typeof props.onRetry === 'function') props.onRetry() },
            disabled: props.busy === true,
          }, String(props.retryLabel === undefined ? '' : props.retryLabel)),
          h('span', { className: 'superpi-verdict-detail' }, String(props.detail === undefined ? '' : props.detail))))
    }

    function MoreMenu(props) {
      var t = props.t
      // 点外部关闭（用户 35984）：0.8.0 及之前只有自身 keydown 的 Escape 能收起，点面板别处它赖着不走。
      // 范式照抄 Composer 的「+」菜单与模型弹层（client.js:2706-2722）：document 级 mousedown + keydown，
      // 依赖数组给 onClose 而不是 []，父层重新渲染后闭包里的回调不会指向上一轮的 state 快照。
      // anchor 是触发按钮的 ref：点触发器本身必须放行 —— 否则 mousedown 先关闭、随后的 click 又把它打开，
      // 表现为「⋯ 怎么点都关不掉」。菜单自身 node 同样放行，点菜单项由 onPick 自己收尾。
      var menuRef = useRef(null)
      var anchor = props.anchor === undefined ? null : props.anchor
      var onCloseMenu = props.onClose
      useEffect(function () {
        function onDocDown(event) {
          if (isOutsideMenu(menuRef.current, anchor, event.target) === false) return
          onCloseMenu()
        }
        function onDocKey(event) {
          if (event.key === 'Escape') onCloseMenu()
        }
        document.addEventListener('mousedown', onDocDown)
        document.addEventListener('keydown', onDocKey)
        return function () {
          document.removeEventListener('mousedown', onDocDown)
          document.removeEventListener('keydown', onDocKey)
        }
      }, [onCloseMenu])
      return h('div', {
        className: 'superpi-menu superpi-more-menu',
        role: 'menu',
        ref: menuRef,
        onKeyDown: function (event) {
          if (event.key === 'Escape') { event.preventDefault(); props.onClose() }
        },
      }, h('div', { className: 'superpi-menu-list' }, props.items.map(function (item) {
        return h('button', {
          key: item.key,
          type: 'button',
          role: 'menuitem',
          className: 'superpi-more-item',
          title: item.title === undefined ? item.label : item.title,
          onClick: function () { props.onPick(item) },
        },
          h('span', { className: 'superpi-more-icon' }, h(item.icon, { size: 16 })),
          h('span', { className: 'superpi-more-label' }, item.label))
      })))
    }

    /**
     * 模型 + 思考档位合一弹层（用户 30427：点左下角模型名向上弹出，思考模式放在同一层）。
     *
     * 原来这两件事各有一个占满面板的抽屉（ModelsSheet / ThinkingSheet），换个档位要
     * 「铺开 → 找 → 点 → 收起」四拍；合成一层之后一次点击就能在两者之间横跳。
     * 行是 menuitemradio（不是 menuitem）：两段都是单选，aria-checked 由当前值决定。
     */
    function ModelPicker(props) {
      var t = props.t
      var models = Array.isArray(props.models) ? props.models : []
      var levels = Array.isArray(props.levels) ? props.levels : []
      var rows = []
      rows.push(h('div', { key: 'sec-model', className: 'superpi-picker-sec' }, t('pickModel')))
      if (props.loading === true) {
        rows.push(h('div', { key: 'loading', className: 'superpi-picker-empty' }, t('modelsLoading')))
      } else if (models.length === 0) {
        rows.push(h('div', { key: 'empty', className: 'superpi-picker-empty' }, t('modelsEmpty')))
      } else {
        models.forEach(function (model, index) {
          var current = props.current !== null && props.current !== undefined && props.current.provider === model.provider && props.current.id === model.id
          rows.push(h('button', {
            key: 'm' + String(index),
            type: 'button',
            role: 'menuitemradio',
            'aria-checked': current ? 'true' : 'false',
            'data-current': current ? '1' : '0',
            className: 'superpi-picker-row',
            onClick: function (pick) { return function () { props.onPickModel(pick) } }(model),
          },
            h('span', { className: 'superpi-picker-row-name' }, String(model.name === undefined || model.name === '' ? model.id : model.name)),
            h('span', { className: 'superpi-picker-row-sub' }, String(model.provider === undefined ? '' : model.provider))))
        })
      }
      rows.push(h('div', { key: 'sec-thinking', className: 'superpi-picker-sec' }, t('pickThinking')))
      if (levels.length === 0) {
        rows.push(h('div', { key: 'level-empty', className: 'superpi-picker-empty' }, t('modelsEmpty')))
      } else {
        levels.forEach(function (level) {
          var current = props.thinking === level
          rows.push(h('button', {
            key: 'l:' + String(level),
            type: 'button',
            role: 'menuitemradio',
            'aria-checked': current ? 'true' : 'false',
            'data-current': current ? '1' : '0',
            className: 'superpi-picker-row',
            onClick: function () { props.onPickThinking(level) },
          }, h('span', { className: 'superpi-picker-row-name' }, String(level))))
        })
      }
      return h('div', {
        className: 'superpi-menu superpi-picker-menu',
        role: 'menu',
        onKeyDown: function (event) {
          if (event.key === 'Escape') { event.preventDefault(); props.onClose() }
        },
      }, h('div', { className: 'superpi-menu-list' }, rows))
    }

    /** 数值兜底：RPC 回来的用量字段可能缺省，缺省按 0 算，别让 NaN 漏进百分比。 */
    function numOr0(value) {
      return typeof value === 'number' && isFinite(value) ? value : 0
    }

    /** 大数字加千分位：统计行里 12 万 token 写成 120,000 才读得出来。 */
    function fmtCount(value) {
      var n = typeof value === 'number' && isFinite(value) ? Math.round(value) : 0
      var text = String(Math.abs(n))
      var out = ''
      for (var i = 0; i < text.length; i += 1) {
        if (i > 0 && (text.length - i) % 3 === 0) out += ','
        out += text[i]
      }
      return (n < 0 ? '-' : '') + out
    }

    function fmtTime(value) {
      if (typeof value === 'number') {
        var date = new Date(value)
        if (isNaN(date.getTime())) return ''
        return date.toLocaleString()
      }
      if (typeof value === 'string' && value !== '') {
        var parsed = new Date(value)
        if (isNaN(parsed.getTime())) return value
        return parsed.toLocaleString()
      }
      return ''
    }

    /**
     * 工作状态行的用时：12秒 / 43分54秒 / 2小时3分9秒（中文单位不留空格，与 DSH 目标图一致）。
     *
     * 进位规则照抄 DSH 的 formatRunDuration（dsh-client-ui-chat/lib/client.js:5847-5875）：
     * 小时只在真有小时时出现，分钟只在 total >= 60 时出现，秒恒出现（所以 90 秒是「1分30秒」）。
     * 不显示毫秒——1Hz 刷新下毫秒位只会让数字跳动得更快。
     * 拼接用 join('')：单位词条自带它需要的间距（中文不带、EN 带尾空格），
     * 与 DSH `parts.map((part) => part.text).join('')` 完全同一拼法，不在这里自己插空格。
     */
    function fmtDuration(ms, t) {
      var total = typeof ms === 'number' && isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0
      var hours = Math.floor(total / 3600)
      var minutes = Math.floor(total / 60) % 60
      var seconds = total % 60
      var parts = []
      if (hours > 0) parts.push(t('durHour').replace('{n}', String(hours)))
      if (total >= 60) parts.push(t('durMin').replace('{n}', String(minutes)))
      parts.push(t('durSec').replace('{n}', String(seconds)))
      // join('') 而不是 join(' ')：单位词条自带它需要的间距（中文不带、EN 带尾空格），
      // 与 DSH `formatRunDuration(...).map((part) => part.text).join('')` 同一拼法。
      return parts.join('')
    }

    /** ui-prefs 里某条记录的名字；没有就地返回空串（投影层不造 undefined）。 */
    function prefName(map, key) {
      if (map === undefined || map === null) return ''
      var entry = map[key]
      if (entry === undefined || entry === null) return ''
      return typeof entry.name === 'string' ? entry.name : ''
    }

    /** 会话是否置顶（ui-prefs 只在 pinned === true 时留条目）。 */
    function prefPinned(map, path) {
      if (map === undefined || map === null) return false
      var entry = map[path]
      return entry !== undefined && entry !== null && entry.pinned === true
    }

    /**
     * 顶栏标题 = 当前项目标题（用户 35984：原来固定显示品牌名 SuperPi，用户看不出这是哪个项目）。
     *
     * 优先级：面板里重命名过的项目名 → host 下发的 displayPath → 原始 cwd。
     * 三者都空（还没绑会话、或缺运行时）时返回空串，由调用方回落品牌名 ——
     * 没有项目的时候显示一个项目名是撒谎。
     *
     * projectKey 由 host 用 pathComparisonKey 算好随快照下发（Windows 转小写 + 路径归一），
     * 与 groupSessionsByProject 给项目列表的 key 同源，因此两边命中同一条重命名记录。
     * displayPath 同理来自 host 的 shortenHomePath（home 下缩成 `~\rel`）：路径缩短只有一份真相，
     * 不在浏览器里重写一遍 —— 那迟早与历史会话列表的写法分叉。
     */
    function projectTitleOf(prefs, meta) {
      if (meta === null || meta === undefined) return ''
      var key = typeof meta.projectKey === 'string' ? meta.projectKey : ''
      var renamed = key === '' ? '' : prefName(prefs === undefined || prefs === null ? null : prefs.projects, key)
      if (renamed !== '') return renamed
      var display = typeof meta.displayPath === 'string' ? meta.displayPath : ''
      if (display !== '') return display
      var cwd = meta.sessionCwd !== undefined && meta.sessionCwd !== null ? meta.sessionCwd : meta.cwd
      return typeof cwd === 'string' ? cwd : ''
    }

    /**
     * 会话标题 = 首条用户消息的第一行。
     * host 的 firstMessage 在没有消息时会回落成哨兵串 `(no messages)`（src/session-store.mjs:34），
     * 直接当标题会出现一行英文占位；这里统一折成空串，由调用方回落到别的文案。
     * 截到 60 字符是因为侧栏只有 360px，再长必然是省略号，先截能让 title 提示短一点。
     */
    function sessionHeadline(value) {
      if (typeof value !== 'string') return ''
      var line = value.split(String.fromCharCode(10))[0].trim()
      if (line === '' || line === '(no messages)') return ''
      return line.length > 60 ? line.slice(0, 60).trim() + '…' : line
    }
    /**
     * 历史会话抽屉 = 面板的 /resume。**两级**，逐条对齐 pi 的 SessionSelectorComponent：
     *   第一层 ProjectList：全部项目（当前项目置顶 → 非临时 → 最近活动降序）
     *   第二层 SessionList：点进项目后只列该 cwd 的会话
     * pi 的 scope 开关在进项目后就失效（session-selector.ts:1663 `if (this.projectPath) return`），
     * 所以这里不做「当前/全部」切换按钮，而是把它变成两级导航，语义等价、点击次数更少。
     *
     * pi 的 RPC 面没有「列会话」命令（rpc-mode.ts 的 33 条里没有），列表由 host 扫
     * ~/.pi/agent/sessions/<slug>/*.jsonl 生成（GET /sessions/history?scope=all|project），
     * 选中后用 switch_session {sessionPath} 切过去。
     *
     * 本函数是**纯渲染视图**：不取数、不持有导航状态，全部由 props 决定。
     * 容器 SessionsSheet 负责取数与层级切换，因此这里可以直接被客户端渲染测试喂假数据。
     *
     * 0.8.0 起它还承担「面板自己的账」：prefs 覆盖项目名与会话名、置顶排到最前、
     * 每行右侧的 ⋯ 菜单（重命名 / 在此新建会话 / 置顶）。这些都不在 pi 的 RPC 面里 ——
     * 会话标题取 firstMessage、项目别名、置顶标记全是面板概念，落在 ui-prefs.json。
     */
    function SessionsList(props) {
      var t = props.t
      var level = props.level
      var project = props.project
      var info = props.info
      var query = props.query
      var prefs = props.prefs === undefined || props.prefs === null ? {} : props.prefs
      var menuKey = typeof props.menuKey === 'string' ? props.menuKey : null
      var onRowMenu = props.onRowMenu === undefined ? function () {} : props.onRowMenu
      // 只有展开那一行的容器挂 ref：同一 ref 挂在所有行上会被最后一行覆盖，外部点击判定就会误伤。
      var rowMenuAnchor = useRef(null)

      var needle = query.trim().toLowerCase()
      var isProjects = level === 'projects'
      var rows = []

      /**
       * 行内「⋯」+ 下拉菜单：容器只存一个 menuKey（同时只允许一栏菜单展开）。
        * 整个容器吞掉点击冒泡 —— 否则点 ⋯ 或点菜单项都等于点了整行（会把项目点进去 / 把会话切过去）；
        * 菜单项一冒泡，重命名弹窗刚打开就被 onPick 把侧栏整体关掉（实拍 a080 抓到的真缺陷）。
       */
      var rowMore = function (key, items) {
        var open = menuKey === key
        return h('div', {
          className: 'superpi-row-more',
          ref: open ? rowMenuAnchor : null,
          onClick: function (event) { event.stopPropagation() },
        },
          h('button', {
            type: 'button',
            title: t('moreActions'),
            'aria-label': t('moreActions'),
            'aria-haspopup': 'menu',
            'aria-expanded': open ? 'true' : 'false',
            onClick: function (event) {
              event.stopPropagation()
              onRowMenu(open ? null : key)
            },
          }, h(EllipsisIcon, { size: 14 })),
          open ? h(MoreMenu, {
            t: t,
            items: items,
            anchor: rowMenuAnchor,
            onPick: function (item) { item.run() },
            onClose: function () { onRowMenu(null) },
          }) : null)
      }

      if (isProjects) {
        var projects = info.projects
        if (needle !== '') {
          projects = projects.filter(function (entry) {
            var haystack = [String(entry.displayPath), String(entry.cwd), prefName(prefs.projects, entry.key)].join(' ').toLowerCase()
            return haystack.indexOf(needle) >= 0
          })
        }
        rows = projects.map(function (entry) {
          // 重命名优先于 displayPath：用户改过的名字才是他要找的那一行。
          var renamed = prefName(prefs.projects, entry.key)
          var title = renamed === '' ? (entry.displayPath === '' ? String(entry.cwd) : String(entry.displayPath)) : renamed
          var key = 'proj:' + String(entry.key)
          return h('div', {
            key: key,
            className: 'superpi-proj',
            'data-current': entry.isCurrent === true ? '1' : '0',
            'data-temporary': entry.isTemporary === true ? '1' : '0',
            'data-renamed': renamed === '' ? '0' : '1',
            onClick: function () { props.onOpenProject(entry) },
          },
            h('div', { className: 'superpi-sess-top' },
              h('div', { className: 'superpi-sess-title' }, title),
              entry.isCurrent === true ? h('span', { className: 'superpi-tag', 'data-tone': 'ok' }, t('current')) : null,
              entry.isTemporary === true ? h('span', { className: 'superpi-tag', 'data-tone': 'warn' }, t('tempTag')) : null,
              h('span', null, t('projectSessions').replace('{n}', String(entry.sessionCount))),
              rowMore(key, [
                { key: 'rename', label: t('renameProject'), icon: PencilIcon, run: function () { onRowMenu(null); props.onRenameProject(String(entry.key), title) } },
                { key: 'new', label: t('newSessionHere'), icon: PlusIcon, run: function () { onRowMenu(null); props.onNewSessionAt(String(entry.cwd)) } },
              ])),
            h('div', { className: 'superpi-mono', title: fmtTime(entry.lastActivity) + ' · ' + String(entry.cwd) }, fmtTime(entry.lastActivity) + ' · ' + String(entry.cwd)))
        })
      } else {
        var sessions = info.sessions
        if (needle !== '') {
          sessions = sessions.filter(function (session) {
            var haystack = [
              session.name,
              session.firstMessage,
              session.lastMessage,
              session.path,
              prefName(prefs.sessions, session.path),
            ].join(' ').toLowerCase()
            return haystack.indexOf(needle) >= 0
          })
        }
        // 置顶的排最前：两遍 partition 而不是 sort —— host 给的顺序本身有意义（最近活动降序），
        // 不能为了把置顶顶上去而把其余顺序交给引擎（sort 的稳定性在旧引擎上没有保证）。
        var pinnedFirst = []
        var rest = []
        sessions.forEach(function (session) {
          if (prefPinned(prefs.sessions, session.path)) pinnedFirst.push(session)
          else rest.push(session)
        })
        sessions = pinnedFirst.concat(rest)
        rows = sessions.map(function (session) {
          var current = props.currentPath !== null && props.currentPath === session.path
          var renamed = prefName(prefs.sessions, session.path)
          var headline = sessionHeadline(session.firstMessage)
          var piName = session.name === undefined || session.name === null ? '' : String(session.name)
          // 标题优先级：用户改的名字 → pi 的会话名 → 首条用户消息摘要 → 末条消息 → 占位。
          var title = renamed !== '' ? renamed : (piName !== '' ? piName : (headline !== '' ? headline : (session.lastMessage === '' || session.lastMessage === undefined ? t('sessionFallbackTitle') : String(session.lastMessage))))
          // 「会话标题」单独占一格（消息数左侧）：只在标题已被名字（改过的名或 pi 的会话名）占据时
          // 才有意义 —— 否则标题本身就是这段摘要，再放一遍是重复。
          var capsule = headline !== '' && title !== headline ? headline : null
          var pinned = prefPinned(prefs.sessions, session.path)
          var key = 'sess:' + session.path
          return h('div', {
            key: key,
            className: 'superpi-sess',
            'data-current': current ? '1' : '0',
            'data-renamed': renamed === '' ? '0' : '1',
            'data-pinned': pinned ? '1' : '0',
            onClick: function () { props.onPick(session) },
          },
            h('div', { className: 'superpi-sess-top' },
              h('div', { className: 'superpi-sess-title', title: title }, title),
              current ? h('span', { className: 'superpi-tag', 'data-tone': 'ok' }, t('current')) : null,
              pinned ? h('span', { className: 'superpi-pin', title: t('pinSession') }, h(PinIcon, { size: 12 })) : null,
              capsule === null ? null : h('span', { className: 'superpi-sess-sum', title: capsule }, capsule),
              h('span', null, String(session.messageCount) + ' ' + t('messages')),
              rowMore(key, [
                { key: 'rename', label: t('renameSession'), icon: PencilIcon, run: function () { onRowMenu(null); props.onRenameSession(session.path, title) } },
                pinned
                  ? { key: 'pin', label: t('unpinSession'), icon: PinIcon, run: function () { onRowMenu(null); props.onTogglePin(session.path, false) } }
                  : { key: 'pin', label: t('pinSession'), icon: PinIcon, run: function () { onRowMenu(null); props.onTogglePin(session.path, true) } },
              ])),
            h('div', { className: 'superpi-sess-line' }, session.lastMessage === '' || session.lastMessage === undefined ? t('sessionFallbackTitle') : String(session.lastMessage)),
            h('div', { className: 'superpi-mono', title: fmtTime(session.modified) + ' · ' + session.path }, fmtTime(session.modified) + ' · ' + session.path))
        })
      }

      var projectTitle = project === null ? '' : (project.displayPath === '' ? String(project.cwd) : String(project.displayPath))
      if (project !== null) {
        var renamedProject = prefName(prefs.projects, project.key)
        if (renamedProject !== '') projectTitle = renamedProject
      }
      var title = isProjects ? t('projectList') : projectTitle
      var actions = []
      if (isProjects) {
        actions.push(h('button', {
          key: 'newp',
          type: 'button',
          className: 'superpi-btn superpi-side-new',
          title: t('newProjectHint'),
          onClick: function () { props.onNewProject() },
        }, h(PlusIcon, { size: 14 }), t('newProject')))
      }
      actions.push(h('input', {
        key: 'q',
        className: 'superpi-search',
        value: query,
        placeholder: isProjects ? t('searchProjects') : t('searchSessions'),
        'aria-label': isProjects ? t('searchProjects') : t('searchSessions'),
        onChange: function (event) { props.onQuery(event.target.value) },
      }))

      var emptyText = isProjects ? t('projectsEmpty') : t('sessionsEmpty')
      var hintText = isProjects ? t('projectsHint') : t('sessionsHint')
      var loadingText = isProjects ? t('projectsLoading') : t('sessionsLoading')

      return h(SidePanel, {
        t: t,
        title: title,
        onClose: props.onClose,
        actions: actions,
        onBack: isProjects ? undefined : props.onBack,
        backTitle: t('allProjects'),
      },
        info.loading ? h('div', { className: 'superpi-empty-row' }, loadingText) : null,
        info.error === null ? null : h('div', { className: 'superpi-alert' }, info.error),
        info.loading === false && info.error === null && rows.length === 0 ? h('div', { className: 'superpi-empty-row' }, emptyText) : null,
        h('div', { className: 'superpi-sess-line' }, hintText),
        rows)
    }

    /**
     * 重命名弹窗（项目 / 会话共用）。
     * 不复用 NameSheet 的原因：NameSheet 挂在 SuperPiPanel 的 drawer 状态上，而 drawer 是单值 ——
     * 改名会把左侧栏自己顶掉。这个弹窗归 SessionsSheet 所属，侧栏与弹窗可以并存。
     */
    function RenameDialog(props) {
      var t = props.t
      var stateValue = useState(props.value === undefined ? '' : String(props.value))
      var value = stateValue[0]
      var setValue = stateValue[1]
      var submit = function () { props.onSubmit(String(value).trim()) }
      return h(Dialog, { t: t, title: props.title, onClose: props.onClose },
        h('input', {
          key: 'v',
          className: 'superpi-search',
          value: value,
          placeholder: t('renamePrompt'),
          'aria-label': t('renamePrompt'),
          autoFocus: true,
          onChange: function (event) { setValue(event.target.value) },
          onKeyDown: function (event) {
            if (event.key === 'Enter') { event.preventDefault(); submit(); return }
            if (event.key === 'Escape') { event.preventDefault(); props.onClose() }
          },
        }),
        h('div', { className: 'superpi-dialog-actions' },
          h('button', { key: 'c', type: 'button', className: 'superpi-btn', onClick: props.onClose }, t('cancel')),
          h('button', { key: 'o', type: 'button', className: 'superpi-btn superpi-btn-primary', onClick: submit }, t('extSubmit'))))
    }

    /**
     * 规则编辑弹窗（0.10.0）。
     *
     * 三个必须做对的交互（每个都有对应的门禁断言）：
     *  ① **有改动就要拦一下**：Esc / 取消 / 点遮罩三条路都走同一个 `tryClose()`。
     *     它只比「当前值 vs 打开时的值」，有差异就叫二次确认 ——
     *     三条路各自判一次必漏一条（这正是 0.8.1 弹窗叠层里踩过的坑）。
     *  ② **超限不许提交**：字数实时算，超了直接禁用主按钮并提示还差多少字，
     *     而不是提交后让 host 回一个 400（那会在弹窗里显示英文，且用户还是丢不掉）。
     *  ③ **保存中锁住**：`saving` 期间主按钮 disabled，避免双击发两次写。
     */
    function RulesSheet(props) {
      var t = props.t
      var rules = props.rules === null || props.rules === undefined ? null : props.rules
      var max = rules !== null && typeof rules.maxLength === 'number' ? rules.maxLength : 20000
      var initial = rules === null ? '' : String(rules.text === undefined ? '' : rules.text)
      var stateText = useState(initial)
      var text = stateText[0]
      var setText = stateText[1]
      var stateSaving = useState(false)
      var saving = stateSaving[0]
      var setSaving = stateSaving[1]
      var stateError = useState(props.error === undefined || props.error === null ? '' : String(props.error))
      var error = stateError[0]
      var setError = stateError[1]
      var stateConfirm = useState(false)
      var confirmDiscard = stateConfirm[0]
      var setConfirmDiscard = stateConfirm[1]
      var over = text.length > max
      var dirty = text !== initial
      var counts = t('rulesCounter').replace('{n}', String(text.length)).replace('{max}', String(max))
      var submit = function () {
        if (saving || over || typeof props.onSave !== 'function') return
        setSaving(true)
        setError('')
        Promise.resolve(props.onSave(text)).then(function () { setSaving(false) }, function (failure) {
          setSaving(false)
          setError(String(failure !== null && failure !== undefined && failure.message !== undefined ? failure.message : failure))
        })
      }
      var tryClose = function () {
        if (saving) return
        if (dirty) { setConfirmDiscard(true); return }
        props.onClose()
      }
      return h(Dialog, { t: t, title: t('rulesSection'), onClose: tryClose, wide: true },
        h('div', { key: 'meta', className: 'superpi-rules-line', 'data-tone': 'muted' }, counts),
        text.trim() === '' ? h('div', { key: 'empty', className: 'superpi-rules-line', 'data-tone': 'warn' }, t('rulesEmptySave')) : null,
        h('textarea', {
          key: 'ta',
          className: 'superpi-rules-textarea',
          value: text,
          rows: 14,
          spellCheck: false,
          placeholder: t('rulesPlaceholder'),
          'aria-label': t('rulesSection'),
          autoFocus: true,
          onChange: function (event) { setText(event.target.value) },
          onKeyDown: function (event) {
            // Ctrl/Cmd+Enter 直接保存（多行 textarea 里 Enter 必须留给换行）。
            if (event.key === 'Enter' && (event.ctrlKey === true || event.metaKey === true)) { event.preventDefault(); submit() }
            if (event.key === 'Escape') { event.preventDefault(); tryClose() }
          },
        }),
        over ? h('div', { key: 'over', className: 'superpi-rules-line', 'data-tone': 'err', role: 'alert' }, t('rulesOverLimit').replace('{n}', String(text.length - max))) : null,
        error === '' ? null : h('div', { key: 'err', className: 'superpi-rules-line', 'data-tone': 'err', role: 'alert' }, error),
        h('div', { key: 'actions', className: 'superpi-dialog-actions' },
          h('button', { key: 'c', type: 'button', className: 'superpi-btn', disabled: saving, onClick: tryClose }, t('cancel')),
          h('button', { key: 's', type: 'button', className: 'superpi-btn superpi-btn-primary', disabled: saving || over, onClick: submit }, saving ? t('rulesSaving') : t('rulesSave'))),
        confirmDiscard ? h(ConfirmDialog, {
          t: t,
          title: t('rulesDiscard'),
          body: t('rulesDiscardBody'),
          confirmLabel: t('rulesDiscardOk'),
          onCancel: function () { setConfirmDiscard(false) },
          onConfirm: function () { setConfirmDiscard(false); props.onClose() },
        }) : null)
    }

    /**
     * 抽屉的**容器**：只管「现在在哪一层、要哪个 cwd 的数据」，把取数结果交给无状态视图。
     * 之所以拆成 SessionsSheet（容器）+ SessionsList（纯渲染），是因为两级抽屉的渲染分支
     * 全靠 host 返回的数据决定，把取数写在渲染里就只能靠真浏览器验证；拆开之后
     * client-render 可以直接喂假数据断言项目层／会话层两套 DOM，倒计时类断言仍归真浏览器。
     *
     * 0.8.0 起这里还承担 ui-prefs（项目名 / 会话名 / 置顶）与行内菜单的开关状态：
     * 偏好是「面板自己的账」，不归 pi 的 RPC 面管，读写都走 /api/superpi/ui-prefs。
     *
     * 0.8.1 起 prefs **不再由这里持有**，改由 SuperPiPanel 单点持有后经 props 下传：顶栏标题要显示
     * 当前项目名（renamed 优先），若两处各拉一次 /ui-prefs，改名后就会出现「列表已更新、顶栏还是旧名」。
     * 写入仍由这里发起，成功后把 host 回的全量结构经 props.onPrefs 交回 SuperPiPanel。
     */
    function SessionsSheet(props) {
      var t = props.t
      var stateLevel = useState('projects')
      var level = stateLevel[0]
      var setLevel = stateLevel[1]
      var stateProject = useState(null)
      var project = stateProject[0]
      var setProject = stateProject[1]
      var stateInfo = useState({ loading: true, error: null, projects: [], sessions: [], total: 0 })
      var info = stateInfo[0]
      var setInfo = stateInfo[1]
      var stateQuery = useState('')
      var query = stateQuery[0]
      var setQuery = stateQuery[1]
      var prefs = props.prefs === undefined || props.prefs === null ? { projects: {}, sessions: {} } : props.prefs
      var onPrefs = props.onPrefs === undefined ? function () {} : props.onPrefs
      var stateMenuKey = useState(null)
      var menuKey = stateMenuKey[0]
      var setMenuKey = stateMenuKey[1]
      var stateRename = useState(null)
      var rename = stateRename[0]
      var setRename = stateRename[1]
      var onNotice = props.onNotice === undefined ? function () {} : props.onNotice

      var errorText = function (error) {
        return String(error !== null && error !== undefined && error.message !== undefined ? error.message : error)
      }

      var openCwd = level === 'sessions' && project !== null ? String(project.cwd) : ''

      useEffect(function () {
        var stopped = false
        setInfo({ loading: true, error: null, projects: [], sessions: [], total: 0 })
        var request = openCwd === ''
          ? api.history({ scope: 'all', limit: 200 })
          : api.history({ scope: 'project', cwd: openCwd, limit: 200 })
        request.then(function (body) {
          if (stopped) return
          setInfo({
            loading: false,
            error: null,
            projects: Array.isArray(body.projects) ? body.projects : [],
            sessions: Array.isArray(body.sessions) ? body.sessions : [],
            total: typeof body.total === 'number' ? body.total : 0,
          })
        }).catch(function (error) {
          if (stopped) return
          setInfo({ loading: false, error: errorText(error), projects: [], sessions: [], total: 0 })
        })
        return function () { stopped = true }
      }, [openCwd])

      /**
       * 写一条偏好：成功就把 host 回的**全量**结构交回 SuperPiPanel（host 是唯一真相，不在本地猜合并）。
       * 收账的人从 0.8.1 起是 SuperPiPanel —— 它同时供顶栏项目标题与这份列表，两处必须同一份。
       */
      var pushPref = function (request, failText) {
        request.then(onPrefs).catch(function (error) { onNotice(failText + ' · ' + errorText(error), 'err') })
      }

      var submitRename = function (name) {
        var pending = rename
        if (pending === null) return
        setRename(null)
        if (pending.kind === 'project') {
          pushPref(api.setProjectPref(pending.target, name), t('renameProject'))
          return
        }
        pushPref(api.setSessionPref(pending.target, { name: name }), t('renameSession'))
      }

      var dialog = rename === null ? null : h(RenameDialog, {
        t: t,
        title: rename.kind === 'project' ? t('renameProject') : t('renameSession'),
        value: rename.value,
        onSubmit: submitRename,
        onClose: function () { setRename(null) },
      })

      return h('div', { className: 'superpi-side-host' },
        h(SessionsList, {
          t: t,
          level: level,
          project: project,
          info: info,
          query: query,
          currentPath: props.currentPath,
          prefs: prefs,
          menuKey: menuKey,
          onQuery: function (next) { setQuery(next) },
          onRowMenu: function (next) { setMenuKey(next) },
          onOpenProject: function (entry) { setMenuKey(null); setProject(entry); setQuery(''); setLevel('sessions') },
          onBack: function () { setMenuKey(null); setQuery(''); setProject(null); setLevel('projects') },
          onRenameProject: function (key, current) { setRename({ kind: 'project', target: key, value: current }) },
          onRenameSession: function (sessionPath, current) { setRename({ kind: 'session', target: sessionPath, value: current }) },
          onTogglePin: function (sessionPath, pinned) { pushPref(api.setSessionPref(sessionPath, { pinned: pinned }), t('pinSession')) },
          onNewProject: function () { setMenuKey(null); props.onNewProject() },
          onNewSessionAt: function (cwd) { setMenuKey(null); props.onNewSessionAt(cwd) },
          onPick: props.onPick,
          onClose: props.onClose,
        }),
        dialog)
    }

    /**
     * 工作目录抽屉 = TUI 会话选择器里「新建工作目录」的等价物（pi-main session-selector.ts 的 ProjectList）。
     *
     * 为什么由 host 代读：pi 的 RPC 面没有任何 fs 能力（rpc-mode.ts 33 条命令里没有目录操作），
     * 所以浏览走 host 的 GET /directories（只读、不递归、只收子目录）。选中目录后用
     * POST /sessions {cwd} 让 host 起一个新 pi 子进程 —— 与命令行 pi 在别的目录里启动等价。
     *
     * 交互对齐 DSH directory-picker（680x500 Miller 分栏）：面包屑 + 可编辑路径 + 左「层级」右「子项」；
     * 确认路径即采纳，关闭即取消。
     */
    /**
     * 目录浏览的纯数据模型（不碰 React、不碰 fs），DirSheet 与测试共用同一份判定：
     *  · Miller 分栏 = 第一栏恒为当前层级的子项；选中某一项后出现第二栏装它的子项；
     *  · 前缀过滤只作用于最后一栏（对齐 DSH picker 的「过滤最后一栏」语义）；
     *  · 「用这个工作区」的目标优先级 deep（第二栏选中）> selected（第一栏选中）> 当前层级。
     */
    function dirPickModel(input) {
      var source = input === null || input === undefined ? {} : input
      var listing = source.listing === null || source.listing === undefined ? {} : source.listing
      var selected = typeof source.selected === 'string' && source.selected !== '' ? source.selected : null
      var deep = typeof source.deep === 'string' && source.deep !== '' ? source.deep : null
      var query = typeof source.query === 'string' ? source.query.trim().toLowerCase() : ''
      // 「此电脑」层：第一栏换成本机文件系统根（Windows 盘符 / POSIX '/'）。
      // 没有这一层，从工作目录逐级往上只能走到当前盘符的根，别的盘永远选不到。
      var rootsView = source.rootsView === true
      var roots = Array.isArray(source.roots) ? source.roots : []
      var all = rootsView ? roots : (Array.isArray(listing.entries) ? listing.entries : [])
      var subAll = source.sub !== null && source.sub !== undefined && Array.isArray(source.sub.entries) ? source.sub.entries : []
      var match = function (entry) {
        if (query === '') return true
        return String(entry.name === undefined ? '' : entry.name).toLowerCase().indexOf(query) >= 0
      }
      var current = String(listing.dir === undefined ? '' : listing.dir)
      // 「此电脑」层什么都没选时 target 是 null：此刻列表里没有「当前目录」这个概念，
      // 回落 current 会把上一个浏览层级当成本层目标，脚注显示与实际不符。
      var target = deep !== null ? deep : (selected !== null ? selected : (rootsView ? null : current))
      return {
        selected: selected,
        deep: deep,
        rootsView: rootsView,
        showSub: selected !== null,
        main: selected === null ? all.filter(match) : all,
        sub: selected === null ? [] : subAll.filter(match),
        target: target,
      }
    }

    function DirSheet(props) {
      var t = props.t
      var listingState = useState({ loading: true, error: null, dir: props.startDir === undefined ? '' : String(props.startDir), parent: null, writable: true, entries: [], truncated: false, home: '', roots: [] })
      var listing = listingState[0]
      var setListing = listingState[1]
      var queryState = useState('')
      var query = queryState[0]
      var setQuery = queryState[1]
      var selectedState = useState(null)
      var selected = selectedState[0]
      var setSelected = selectedState[1]
      var typedState = useState('')
      var typed = typedState[0]
      var setTyped = typedState[1]
      var busyState = useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]
      // Miller 双栏：第一栏 = 当前层级的子项，第二栏 = 第一栏选中项的子项。
      // 第二栏里再选中的目录记在 deep，优先于 selected 成为「用这个工作区」的目标。
      var deepState = useState(null)
      var deep = deepState[0]
      var setDeep = deepState[1]
      var subState = useState({ loading: false, error: null, dir: '', entries: [] })
      var sub = subState[0]
      var setSub = subState[1]
      // 「此电脑」层：第一栏列本机所有盘符。没有它，从工作目录往上只能走到当前盘的根，
      // 用户在别的盘上的工程永远进不去（这正是用户红框指出的缺口）。
      var rootsViewState = useState(false)
      var rootsView = rootsViewState[0]
      var setRootsView = rootsViewState[1]

      var go = function (dir) {
        setSelected(null)
        setRootsView(false)
        setListing(function (prev) { return Object.assign({}, prev, { loading: true, error: null }) })
        return api.directories(dir, '', 400).then(function (body) {
          setListing({
            loading: false,
            error: null,
            dir: String(body.dir === undefined ? dir : body.dir),
            parent: body.parent === undefined ? null : body.parent,
            writable: body.writable !== false,
            entries: Array.isArray(body.entries) ? body.entries : [],
            truncated: body.truncated === true,
            home: typeof body.home === 'string' ? body.home : '',
            roots: Array.isArray(body.roots) ? body.roots : [],
          })
          setTyped(String(body.dir === undefined ? dir : body.dir))
          return null
        }, function (failure) {
          var message = String(failure !== null && failure !== undefined && failure.message !== undefined ? failure.message : failure)
          setListing(function (prev) { return Object.assign({}, prev, { loading: false, error: message }) })
          return null
        })
      }

      useEffect(function () { go(props.startDir === undefined ? '' : String(props.startDir)) }, [])

      var enter = function (dir) {
        setQuery('')
        go(dir)
      }

      var accept = function () {
        if (busy === true) return
        var pick = dirPickModel({ listing: listing, selected: selected, deep: deep, query: '', sub: sub, rootsView: rootsView, roots: listing.roots })
        var target = pick.target
        // 「此电脑」层什么都没选时没有可采纳的目标（盘符本身不是工作目录，选中盘符会拉到第二栏）。
        if (target === null || target === '') return
        setBusy(true)
        Promise.resolve(props.onPick(target)).then(function () { setBusy(false) }, function () { setBusy(false) })
      }

      useEffect(function () {
        if (selected === null) {
          setSub({ loading: false, error: null, dir: '', entries: [] })
          return undefined
        }
        var live = true
        setSub({ loading: true, error: null, dir: String(selected), entries: [] })
        api.directories(String(selected), '', 400).then(function (body) {
          if (live !== true) return
          setSub({
            loading: false,
            error: null,
            dir: String(body.dir === undefined ? selected : body.dir),
            entries: Array.isArray(body.entries) ? body.entries : [],
          })
        }, function (failure) {
          if (live !== true) return
          var message = String(failure !== null && failure !== undefined && failure.message !== undefined ? failure.message : failure)
          setSub({ loading: false, error: message, dir: String(selected), entries: [] })
        })
        return function () { live = false }
      }, [selected])

      var model = dirPickModel({ listing: listing, selected: selected, deep: deep, query: query, sub: sub, rootsView: rootsView, roots: listing.roots })
      // 「当前」= 会话现在所在的目录（props.startDir），不是正在浏览的层级 —— 用户翻到上级时
      // 仍能看出自己原本在哪儿，这也是 Miller 分栏里唯一有意义的当前态标记。
      var currentCwd = props.startDir === undefined ? '' : String(props.startDir)
      var mainEntries = model.main
      var subEntries = model.sub
      // 「此电脑」层没有磁盘路径可切，面包屑只显示一层；点它回到盘符列表（本身已在则不做事）。
      var crumbs = rootsView ? [{ label: t('dirThisPc'), path: '' }] : pathCrumbs(listing.dir)

      var body = []
      // 面包屑：每一段都可点，最后一段是当前目录（加粗、不可回退到同一处）。
      body.push(h('div', { key: 'crumbs', className: 'superpi-dir-crumbs' }, (function () {
        var nodes = []
        for (var i = 0; i < crumbs.length; i += 1) {
          if (i > 0) nodes.push(h('span', { key: 'sep' + String(i), className: 'superpi-dir-sep' }, '›'))
          var crumb = crumbs[i]
          var isLast = i === crumbs.length - 1
          nodes.push(h('button', {
            key: 'c' + String(i),
            type: 'button',
            className: 'superpi-dir-crumb',
            'data-last': isLast ? '1' : '0',
            title: crumb.path,
            onClick: (function (node) {
              return function () {
                if (node.path === '' || node.path === listing.dir) return
                enter(node.path)
              }
            })(crumb),
          }, crumb.label))
        }
        return nodes
      })()))
      // 可编辑路径（等价 DSH picker 头部的路径输入区）：回车即跳转，支持不存在的路径（开会话时创建）。
      body.push(h('div', { key: 'typed', className: 'superpi-row2' },
        h('input', {
          className: 'superpi-search',
          style: { flex: '1 1 auto', minWidth: '0' },
          value: typed,
          placeholder: t('dirInputHint'),
          onChange: function (event) { setTyped(event.target.value) },
          onKeyDown: function (event) {
            if (event.key !== 'Enter') return
            event.preventDefault()
            var next = typed.trim()
            if (next !== '') enter(next)
          },
        }),
        h('input', {
          className: 'superpi-search',
          style: { width: '160px', flex: '0 0 auto' },
          value: query,
          placeholder: t('filter'),
          onChange: function (event) { setQuery(event.target.value) },
        })))
      body.push(h('div', { key: 'hint', className: 'superpi-dir-hint' },
        rootsView === true ? t('dirPickDrive') : (listing.writable === true ? t('dirHint') : t('dirNotWritable'))))

      var makeRow = function (item, currentPath, activePath, markable) {
        var target = String(item.path === undefined ? '' : item.path)
        var active = target !== '' && target === String(activePath)
        return h('button', {
          type: 'button',
          className: 'superpi-dir-item',
          'data-selected': active ? '1' : '0',
          'data-current': target !== '' && target === String(currentPath) ? '1' : '0',
          title: target,
          onClick: function () {
            setDeep(null)
            setSelected(target)
            setTyped(target)
          },
          onDoubleClick: function () {
            setQuery('')
            setDeep(null)
            enter(target)
          },
        }, h(DirIcon, { size: 14 }),
          h('span', { className: 'superpi-dir-name' }, String(item.name === undefined ? '' : item.name)),
          markable === true && active ? h('span', { className: 'superpi-dir-mark' }, t('dirPickMark')) : null)
      }

      var rows = []
      if (rootsView === true) {
        // 「此电脑」层：第一行退回刚才浏览的层级（列表已经拿在手里，不必再请求）。
        if (listing.dir !== '') {
          rows.push(h('button', {
            key: 'back',
            type: 'button',
            className: 'superpi-dir-item',
            title: listing.dir,
            onClick: function () { setDeep(null); setSelected(null); setRootsView(false) },
          }, h(DirIcon, { size: 14 }), h('span', { className: 'superpi-dir-name' }, '..  ' + t('dirUp'))))
        }
        for (var r = 0; r < mainEntries.length; r += 1) {
          var drive = mainEntries[r]
          var drivePath = String(drive.path === undefined ? '' : drive.path)
          var driveActive = drivePath !== '' && drivePath === String(selected)
          rows.push(h('button', {
            key: 'root' + String(r),
            type: 'button',
            className: 'superpi-dir-item',
            'data-selected': driveActive ? '1' : '0',
            'data-drive': '1',
            title: drivePath,
            onClick: (function (path) {
              return function () { setDeep(null); setSelected(path); setTyped(path) }
            })(drivePath),
            onDoubleClick: (function (path) {
              return function () { setQuery(''); setDeep(null); enter(path) }
            })(drivePath),
          }, h(DriveIcon, { size: 14 }),
            h('span', { className: 'superpi-dir-name' }, String(drive.name === undefined ? '' : drive.name)),
            driveActive ? h('span', { className: 'superpi-dir-mark' }, t('dirPickMark')) : null))
        }
      }
      if (rootsView !== true && listing.parent !== null && listing.parent !== undefined) {
        rows.push(h('button', {
          key: 'up',
          type: 'button',
          className: 'superpi-dir-item',
          title: String(listing.parent),
          onClick: function () { setDeep(null); enter(String(listing.parent)) },
        }, h(DirIcon, { size: 14 }), h('span', { className: 'superpi-dir-name' }, '..  ' + t('dirUp'))))
      }
      if (rootsView !== true && listing.roots.length > 0) {
        // 「此电脑」入口：切到盘符列表。放在「上一级 / 主目录」之后、子目录之前，
        // 与资源管理器里「此电脑」和层级导航同组的直觉一致。
        rows.push(h('button', {
          key: 'pc',
          type: 'button',
          className: 'superpi-dir-item',
          'data-pc': '1',
          title: t('dirThisPc'),
          onClick: function () { setDeep(null); setSelected(null); setRootsView(true) },
        }, h(DriveIcon, { size: 14 }), h('span', { className: 'superpi-dir-name' }, t('dirThisPc'))))
      }
      if (rootsView !== true && listing.home !== '' && listing.home !== listing.dir) {
        rows.push(h('button', {
          key: 'home',
          type: 'button',
          className: 'superpi-dir-item',
          title: listing.home,
          onClick: function () { setDeep(null); enter(listing.home) },
        }, h(DirIcon, { size: 14 }), h('span', { className: 'superpi-dir-name' }, '~  ' + t('dirHome'))))
      }
      // 盘符层已经由上面的专有分支渲染过（盘符要用 DriveIcon + 双击进盘语义，
      // 与普通目录行不同）。这里必须跳过，否则 mainEntries 会在同一层被画第二遍。
      if (rootsView !== true) {
        for (var i = 0; i < mainEntries.length; i += 1) {
          var entry = mainEntries[i]
          rows.push(h('span', { key: 'e' + String(i), style: { display: 'contents' } }, makeRow(entry, currentCwd, selected, true)))
        }
      }

      var listBody = rows
      if (listing.loading === true) listBody = [h('div', { key: 'ld', className: 'superpi-empty-row' }, t('dirLoading'))]
      else if (listing.error !== null) listBody = [h('div', { key: 'er', className: 'superpi-alert' }, String(listing.error))]
      else if (rows.length === 0) listBody = [h('div', { key: 'em', className: 'superpi-empty-row' }, t('dirEmpty'))]

      var cols = [h('div', { key: 'col0', className: 'superpi-dir-col' }, listBody)]
      if (model.showSub === true) {
        var subRows = []
        for (var j = 0; j < subEntries.length; j += 1) {
          subRows.push(h('span', { key: 's' + String(j), style: { display: 'contents' } }, makeRow(subEntries[j], currentCwd, deep, true)))
        }
        var subBody = subRows
        if (sub.loading === true) subBody = [h('div', { key: 'sld', className: 'superpi-empty-row' }, t('dirLoading'))]
        else if (sub.error !== null) subBody = [h('div', { key: 'ser', className: 'superpi-alert' }, String(sub.error))]
        else if (subRows.length === 0) subBody = [h('div', { key: 'sem', className: 'superpi-empty-row' }, t('dirEmpty'))]
        cols.push(h('div', { key: 'col1', className: 'superpi-dir-col' }, subBody))
      }

      body.push(h('div', { key: 'cols', className: 'superpi-dir-cols' }, cols))

      // 「此电脑」层未选盘时 target 为 null：脚注留空、按钮禁用，避免把上一层的目录当成本层目标。
      var targetDir = model.target === null || model.target === undefined ? '' : String(model.target)
      var canAccept = targetDir !== '' && busy !== true && listing.loading !== true
      body.push(h('div', { key: 'foot', className: 'superpi-dir-foot' },
        h('span', { key: 'target', className: 'superpi-dir-target', title: targetDir }, targetDir),
        h('span', { className: 'superpi-spacer' }),
        h('button', {
          type: 'button',
          className: 'superpi-btn superpi-btn-primary',
          disabled: canAccept !== true,
          onClick: function () { accept() },
        }, busy === true ? t('dirSwitching') : t('dirHere'))))

      // 居中弹窗（不是整块抽屉）：选择工作区是一次会打断当前会话的决策，
      // 用模态把面板其余部分压暗，用户不会误以为还能一边聊天一边挑目录。
      // 尺寸对齐 DSH directory-picker 的 680x500。
      return h('div', { className: 'superpi-dialog-wrap', onClick: maskHandler(props.onClose) },
        h('div', {
          className: 'superpi-dir-dialog',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': t('dirTitle'),
        },
          h('div', { className: 'superpi-dir-head' },
            h('div', { className: 'superpi-dir-title' }, t('dirTitle')),
            h(CloseButton, { t: t, onClick: props.onClose })),
          h('div', { className: 'superpi-dir' }, body)))
    }

    /**
     * 树抽屉 = 面板的 /tree。
     *
     * pi 的 RPC 面有 get_tree / get_entries，但**没有 navigate_tree**（rpc-mode.ts 33 条里没有），
     * 所以面板只能「看」树、不能「跳」分支。要跳分支的等价操作是 switch_session（换会话）
     * 或 fork {entryId}（从某条用户消息开新分支）。这里如实标注，不假装能导航。
     */
    function TreeSheet(props) {
      var t = props.t
      var rows = []
      function walk(nodes, depth) {
        for (var i = 0; i < nodes.length; i += 1) {
          var node = nodes[i]
          rows.push({ node: node, depth: depth })
          if (Array.isArray(node.children)) walk(node.children, depth + 1)
        }
      }
      walk(Array.isArray(props.tree) ? props.tree : [], 0)
      return h(Sheet, { t: t, title: t('tree'), onClose: props.onClose },
        h('div', { className: 'superpi-sess-line' }, t('treeHint')),
        rows.length === 0 ? h('div', { className: 'superpi-empty-row' }, t('treeEmpty')) : null,
        h('div', { className: 'superpi-tree' }, rows.map(function (row, index) {
          var entry = row.node.entry === undefined ? {} : row.node.entry
          var isLeaf = entry.id !== undefined && entry.id === props.leafId
          var label = entry.type === 'message' && entry.message !== undefined
            ? entry.message.role + ': ' + textOfMessage(makeMessage(entry.message, 0)).slice(0, 120)
            : String(entry.type === undefined ? '' : entry.type) + (typeof entry.name === 'string' ? ' · ' + entry.name : '')
          return h('div', {
            key: 'n' + String(index),
            className: 'superpi-tree-node',
            'data-leaf': isLeaf ? '1' : '0',
            style: { paddingLeft: String(6 + row.depth * 14) + 'px' },
          },
            h('span', { className: 'superpi-tree-kind' }, String(entry.type === undefined ? '' : entry.type)),
            h('span', { className: 'superpi-tree-text' }, label),
            isLeaf ? h('span', { className: 'superpi-tag', 'data-tone': 'ok' }, t('current')) : null)
        })))
    }

    /** fork 抽屉 = 面板的 /fork：列出用户消息，选中后 fork{entryId} 并回填文本。 */
    function ForkSheet(props) {
      var t = props.t
      var items = Array.isArray(props.items) ? props.items : []
      return h(Sheet, { t: t, title: t('fork'), onClose: props.onClose },
        h('div', { className: 'superpi-sess-line' }, t('forkHint')),
        items.length === 0 ? h('div', { className: 'superpi-empty-row' }, t('forkEmpty')) : null,
        items.map(function (item, index) {
          return h('div', {
            key: item.entryId === undefined ? 'f' + String(index) : item.entryId,
            className: 'superpi-sess',
            onClick: function () { props.onPick(item) },
          },
            h('div', { className: 'superpi-sess-line' }, String(item.text === undefined ? '' : item.text).slice(0, 400)),
            h('div', { className: 'superpi-mono' }, String(item.entryId === undefined ? '' : item.entryId)))
        }))
    }

    /** 统计抽屉 = 面板的 /session。数据来自 get_session_stats + get_state。 */
    function StatsSheet(props) {
      var t = props.t
      var stats = props.stats
      var state = props.state
      var rows = []
      function push(key, value) { if (value !== undefined && value !== null && String(value) !== '') rows.push([key, String(value)]) }
      function formatTokenCount(value) {
        var count = typeof value === 'number' && isFinite(value) ? value : 0
        if (count >= 1000000) return (count / 1000000).toFixed(2) + 'M'
        if (count >= 1000) return String(Math.round(count / 1000)) + 'k'
        return String(count)
      }
      // stats 是异步拉的：null 表示还在路上，此时不能读字段（否则抽屉一打开就抛 TypeError）。
      if (stats !== null && stats !== undefined) {
      push(t('statsUser'), stats.userMessages)
      push(t('statsAssistant'), stats.assistantMessages)
      push(t('statsTools'), stats.toolCalls)
      push(t('statsTotal'), stats.totalMessages)
      if (stats.tokens !== undefined && stats.tokens !== null) {
        push(t('tokens') + ' · in', stats.tokens.input)
        push(t('tokens') + ' · out', stats.tokens.output)
        push(t('tokens') + ' · cache', stats.tokens.cacheRead)
        push(t('tokens') + ' · total', stats.tokens.total)
      }
      if (stats.contextUsage !== undefined && stats.contextUsage !== null) {
        var usage = stats.contextUsage
        push(t('contextUsage'), (usage.tokens === null ? '?' : String(usage.tokens)) + ' / ' + String(usage.contextWindow) + (usage.percent === null ? '' : ' · ' + String(Math.round(usage.percent)) + '%'))
      }
      // 上面那行是 provider 报告的 usage 派生值（当前上游把 prompt 记在 cache 且 input=0，
      // 真实 1.31M 会被显示成 3.7%）。这一行是守卫按「图片算视觉 token」重算的真实值：
      // 两个数并列，用户能看出哪个可信，而不是被一个假百分比带着走到 400。
      if (props.guardContext !== undefined && props.guardContext !== null) {
        var guard = props.guardContext
        var guardText = formatTokenCount(guard.before) + ' → ' + formatTokenCount(guard.after) + ' / ' + formatTokenCount(guard.window)
        if (typeof guard.imagesDropped === 'number' && guard.imagesDropped > 0) guardText += ' · ' + t('imagesReleased') + ' ' + String(guard.imagesDropped)
        if (guard.overBudget === true) guardText += ' · ' + t('contextOverBudget')
        push(t('contextReal'), guardText)
      }
      push(t('cost'), typeof stats.cost === 'number' ? stats.cost.toFixed(4) : undefined)
      push(t('sessionName'), state.sessionName)
      push(t('workspace'), state.cwd)
      push('sessionId', state.sessionId)
      push('sessionFile', state.sessionFile)
      push(t('autoCompact'), state.autoCompactionEnabled === true ? t('on') : state.autoCompactionEnabled === false ? t('off') : undefined)
      push(t('steeringMode'), state.steeringMode)
      push(t('followUpMode'), state.followUpMode)
      // get_entries 比 get_messages 多出「压缩前历史 / 被放弃分支」，是 TUI /session 的口径：
      // 条目总数与当前叶子 entry id（对齐 docs/rpc-commands.md:689）。
      if (props.entries !== null && props.entries !== undefined) {
        push(t('entries'), Array.isArray(props.entries.entries) ? props.entries.entries.length : undefined)
        push('leafId', props.entries.leafId)
      }
      }
      return h(Dialog, { t: t, title: t('stats'), onClose: props.onClose, wide: true },
        stats === null ? h('div', { className: 'superpi-empty-row' }, t('loading')) : null,
        stats === null ? null : h('div', { className: 'superpi-kv' }, rows.map(function (row, index) {
          return [h('div', { key: 'k' + String(index), className: 'superpi-kv-k' }, row[0]), h('div', { key: 'v' + String(index), className: 'superpi-kv-v' }, row[1])]
        })))
    }

    /** 设置弹窗 = 面板的 /settings（0.7.0 起是居中弹窗 Dialog，不再是抽屉）。四个开关全部走 RPC，与 TUI 的 settingsManager 语义一致。 */
    function SettingsSheet(props) {
      var t = props.t
      var state = props.state
      /** 开关：对齐 DSH 的 ._switch_1ik0f_5（36x20 胶囊 + 16px 滑块），不再是文字按钮。 */
      function toggle(key, label, value, onChange) {
        var checked = value === true
        return h('div', { className: 'superpi-switch-row' },
          h('span', { className: 'superpi-switch-label', id: 'superpi-sw-' + key }, label),
          h('button', {
            type: 'button',
            className: 'superpi-switch',
            role: 'switch',
            'aria-checked': checked ? 'true' : 'false',
            'aria-labelledby': 'superpi-sw-' + key,
            onClick: function () { onChange(checked !== true) },
          }, h('span', { className: 'superpi-switch-thumb' })))
      }
      return h(Dialog, { t: t, title: t('settings'), onClose: props.onClose, wide: true },
        toggle('autoCompaction', t('autoCompact'), state.autoCompactionEnabled, function (next) { props.onAutoCompaction(next) }),
        toggle('autoRetry', t('autoRetry'), state.autoRetryEnabled, function (next) { props.onAutoRetry(next) }),
        h('div', { className: 'superpi-row2' },
          h('span', { className: 'superpi-kv-k', style: { minWidth: '180px' } }, t('steeringMode')),
          h('button', { type: 'button', className: 'superpi-btn', onClick: function () { props.onSteering(state.steeringMode === 'all' ? 'one-at-a-time' : 'all') } }, String(state.steeringMode === undefined ? 'all' : state.steeringMode))),
        h('div', { className: 'superpi-row2' },
          h('span', { className: 'superpi-kv-k', style: { minWidth: '180px' } }, t('followUpMode')),
          h('button', { type: 'button', className: 'superpi-btn', onClick: function () { props.onFollowUp(state.followUpMode === 'all' ? 'one-at-a-time' : 'all') } }, String(state.followUpMode === undefined ? 'all' : state.followUpMode))),
        h('div', { className: 'superpi-sess-line' }, t('autoApprove')),
        RulesSection({ t: t, rules: props.rules, loadError: props.rulesError, onEdit: props.onEditRules, onReset: props.onResetRules, onRetry: props.onLoadRules }),
        ModalitiesSection({
          t: t,
          models: props.models,
          modalities: props.modalities,
          error: props.modalitiesError,
          onToggle: props.onToggleModality,
          onRetry: props.onLoadModalities,
        }))
    }

    /**
     * 设置弹窗里的「模型模态」区（0.13.0）。
     *
     * 语义（与 `extensions/superpi-modalities.mjs` 同一套规则，门禁交叉对账）：
     *  - **可开关的模态** = 模型协议声明（`model.input`）∩ 运行时能发送的（text / image）；
     *  - 默认：文本与图像开启，其它默认关闭（今天没有"其它"，pi 只有这两种）；
     *  - 文本锁定开启：关掉文本等于这个模型不能对话，是脚枪不是能力；
     *  - 关闭 = 请求发出前把该模态的块换成占位 —— 真的会变，不是只存一个布尔值。
     *
     * 列表按 provider + 名字排序并限高滚动：模型可能有几十个，但不能让设置弹窗被撑爆。
     */
    function ModalitiesSection(props) {
      var t = props.t
      var models = Array.isArray(props.models) ? props.models : []
      var payload = props.modalities === undefined ? null : props.modalities
      var error = props.error === undefined || props.error === null ? null : props.error
      var registry = payload !== null && payload.registry !== undefined && payload.registry !== null ? payload.registry : {}
      var runtime = Array.isArray(registry.runtime) ? registry.runtime : ['text', 'image']
      var defaults = Array.isArray(registry.defaults) ? registry.defaults : ['text', 'image']
      var lockedIds = Array.isArray(registry.locked) ? registry.locked : ['text']
      var state = payload !== null && payload.state !== undefined && payload.state !== null ? payload.state : { models: {} }
      var overrides = state.models !== null && typeof state.models === 'object' ? state.models : {}

      /** 某模型的模态条目（与 mjs 的 resolveModelModalities 同规则）。 */
      function entriesFor(model) {
        var declared = Array.isArray(model.input) ? runtime.filter(function (id) { return model.input.indexOf(id) >= 0 }) : []
        // 拿不到协议声明时按产品默认（文本+图像），不凭空降级成"一个都不能用"。
        var available = declared.length > 0 ? declared : defaults.slice()
        var key = String(model.provider === undefined ? '' : model.provider) + '/' + String(model.id === undefined ? '' : model.id)
        var own = overrides[key] !== null && typeof overrides[key] === 'object' ? overrides[key] : {}
        return available.map(function (id) {
          var isLocked = lockedIds.indexOf(id) >= 0
          var override = own[id]
          var enabled = isLocked ? true : (typeof override === 'boolean' ? override : defaults.indexOf(id) >= 0)
          return { id: id, enabled: enabled, locked: isLocked, isDefault: typeof override !== 'boolean' }
        })
      }

      var children = []
      children.push(h('div', { key: 'head', className: 'superpi-rules-head' },
        h('span', { className: 'superpi-rules-title' }, t('modalitiesSection')),
        h('span', { className: 'superpi-rules-badge', 'data-tone': 'default' }, t('modalitiesBadge'))))

      if (error !== null) {
        children.push(h('div', { key: 'err', className: 'superpi-rules-line', 'data-tone': 'err', role: 'alert' }, t('modalitiesLoadFailed') + ' · ' + String(error)))
        if (typeof props.onRetry === 'function') {
          children.push(h('button', { key: 'retry', type: 'button', className: 'superpi-btn', onClick: props.onRetry }, t('retry')))
        }
        return h('div', { className: 'superpi-mod-section' }, children)
      }
      if (payload === null) {
        children.push(h('div', { key: 'loading', className: 'superpi-rules-line', 'data-tone': 'muted' }, t('loading')))
        return h('div', { className: 'superpi-mod-section' }, children)
      }
      children.push(h('div', { key: 'hint', className: 'superpi-rules-line', 'data-tone': 'muted' }, t('modalitiesHint')))

      if (models.length === 0) {
        children.push(h('div', { key: 'empty', className: 'superpi-rules-line', 'data-tone': 'muted' }, t('modalitiesNoSession')))
        return h('div', { className: 'superpi-mod-section' }, children)
      }

      var sorted = models.slice().sort(function (a, b) {
        var pa = String(a.provider === undefined ? '' : a.provider)
        var pb = String(b.provider === undefined ? '' : b.provider)
        if (pa !== pb) return pa < pb ? -1 : 1
        var na = String(a.name === undefined || a.name === '' ? a.id : a.name)
        var nb = String(b.name === undefined || b.name === '' ? b.id : b.name)
        return na < nb ? -1 : (na > nb ? 1 : 0)
      })

      children.push(h('div', { key: 'list', className: 'superpi-mod-list', role: 'group', 'aria-label': t('modalitiesSection') },
        sorted.map(function (model, index) {
          var key = String(model.provider === undefined ? '' : model.provider) + ':' + String(model.id === undefined ? '' : model.id)
          var entries = entriesFor(model)
          return h('div', { key: 'm' + String(index), className: 'superpi-mod-row', 'data-model': key },
            h('div', { className: 'superpi-mod-name-wrap' },
              h('span', { className: 'superpi-mod-name' }, String(model.name === undefined || model.name === '' ? model.id : model.name)),
              h('span', { className: 'superpi-mod-provider' }, String(model.provider === undefined ? '' : model.provider))),
            h('div', { className: 'superpi-mod-chips' },
              entries.map(function (entry) {
                var label = t('modality_' + entry.id) === 'modality_' + entry.id ? entry.id : t('modality_' + entry.id)
                var title = entry.locked ? t('modalityLocked') : (entry.enabled ? t('modalityClickOff') : t('modalityClickOn'))
                return h('button', {
                  key: entry.id,
                  type: 'button',
                  className: 'superpi-mod-chip',
                  'data-modality': entry.id,
                  'data-on': entry.enabled ? '1' : '0',
                  'data-locked': entry.locked ? '1' : '0',
                  'aria-pressed': entry.enabled ? 'true' : 'false',
                  'aria-disabled': entry.locked ? 'true' : 'false',
                  title: title,
                  onClick: entry.locked ? null : function () { props.onToggle(model, entry.id, entry.enabled !== true) },
                }, label)
              })))
        })))

      if (registry.filePath !== undefined && registry.filePath !== null) {
        children.push(h('div', { key: 'path', className: 'superpi-rules-line', 'data-tone': 'muted' }, String(registry.filePath)))
      }
      return h('div', { className: 'superpi-mod-section' }, children)
    }

    /**
     * 设置弹窗里的「用户自定义规则」区（0.10.0）。
     *
     * 这是一个**状态机**而不是一行按钮：规则可能正在加载、读失败、默认、已改、空。
     * 每种状态的最小信息量不同，所以摘要行按状态换文案（而不是统一显示一句「已启用」）：
     *  - rules 为 null  → 还在路上（按钮禁用，避免拿旧值/空值开编辑框）；
     *  - loadError 非空 → 失败 + 重试（此时禁用编辑：读不出来就写回去等于毁掉用户的文件）；
     *  - empty:true     → 告警语气，明说「不会追加任何内容」（静默看起来像故障）；
     *  - 否则           → 行数/字数 + 首行摘要 + 徽标（最高优先级 / 默认）。
     *
     * 「命令行有没有装」单独一行（delivery.extensionInstalled）：它决定规则在 TUI 里到底生效不生效，
     * 不装就是两端不对等，必须在设置里看得见，而不是让用户去 TUI 里试了才发现。
     */
    function RulesSection(props) {
      var t = props.t
      var rules = props.rules === undefined ? null : props.rules
      var error = props.loadError === undefined || props.loadError === null ? null : props.loadError
      var text = rules === null ? '' : String(rules.text === undefined ? '' : rules.text)
      var nonEmpty = text.split('\n').filter(function (line) { return line.trim() !== '' })
      var chars = text.length
      var head = nonEmpty.length === 0 ? '' : nonEmpty[0]
      if (head.length > 72) head = head.slice(0, 72) + '…'
      var summary = t('rulesSummary').replace('{lines}', String(nonEmpty.length)).replace('{chars}', String(chars))
      var disabled = rules === null || error !== null
      var children = []
      children.push(h('div', { key: 'head', className: 'superpi-rules-head' },
        h('span', { className: 'superpi-rules-title' }, t('rulesSection')),
        rules === null ? null : h('span', { className: 'superpi-rules-badge', 'data-tone': 'top' }, t('rulesBadgeTop')),
        rules !== null && rules.isDefault === true ? h('span', { key: 'd', className: 'superpi-rules-badge', 'data-tone': 'default' }, t('rulesBadgeDefault')) : null))
      if (error !== null) {
        children.push(h('div', { key: 'err', className: 'superpi-rules-line', 'data-tone': 'err', role: 'alert' }, t('rulesLoadFailed') + ' · ' + String(error)))
      } else if (rules === null) {
        children.push(h('div', { key: 'loading', className: 'superpi-rules-line', 'data-tone': 'muted' }, t('loading')))
      } else if (rules.empty === true) {
        children.push(h('div', { key: 'empty', className: 'superpi-rules-line', 'data-tone': 'warn' }, t('rulesEmptyState')))
      } else {
        children.push(h('div', { key: 'sum', className: 'superpi-rules-line' }, summary))
        children.push(h('div', { key: 'head-line', className: 'superpi-rules-line', 'data-tone': 'muted' }, head))
      }
      if (rules !== null && rules.drift === true) {
        children.push(h('div', { key: 'drift', className: 'superpi-rules-line', 'data-tone': 'warn' }, t('rulesDrift')))
      }
      if (rules !== null && rules.delivery !== undefined && rules.delivery !== null) {
        children.push(h('div', {
          key: 'cli',
          className: 'superpi-rules-line',
          'data-tone': rules.delivery.extensionInstalled === true ? 'muted' : 'warn',
        }, rules.delivery.extensionInstalled === true ? t('rulesCliReady') : t('rulesCliMissing')))
      }
      var actions = []
      if (error !== null && typeof props.onRetry === 'function') {
        actions.push(h('button', { key: 'retry', type: 'button', className: 'superpi-btn', onClick: props.onRetry }, t('retry')))
      }
      actions.push(h('button', {
        key: 'reset',
        type: 'button',
        className: 'superpi-btn',
        disabled: disabled,
        onClick: function () { props.onReset() },
      }, t('rulesReset')))
      actions.push(h('button', {
        key: 'edit',
        type: 'button',
        className: 'superpi-btn superpi-btn-primary',
        disabled: disabled,
        title: t('rulesEditHint'),
        onClick: function () { props.onEdit() },
      }, t('rulesEdit')))
      children.push(h('div', { key: 'actions', className: 'superpi-rules-actions' }, actions))
      return h('div', { className: 'superpi-rules', 'data-empty': rules !== null && rules.empty === true ? '1' : '0' }, children)
    }

    /** changelog 抽屉：pi 的 CHANGELOG.md 由 host 代读（RPC 面无文件系统能力）。 */
    function TextSheet(props) {
      return h(Sheet, { t: props.t, title: props.title, onClose: props.onClose },
        props.text === '' ? h('div', { className: 'superpi-empty-row' }, props.t('loading')) : h('pre', { className: 'superpi-pre', style: { whiteSpace: 'pre-wrap' } }, props.text))
    }

    /**
     * 面板内文件预览 —— 右栏打不开时的回落，不是主路径。
     *
     * 主路径永远是 ctx.sidebarRight.openResource：DSH 内置 documentpreview 负责渲染
     * markdown / 代码 / 图片，视觉与 DSH 其它文件标签完全一致。只有在「没有正在显示的
     * DSH 会话」「宿主没提供 sidebarRight」这两种情况下才退到这里，而且必须用 notice
     * 说明退化的原因（静默降级 = 用户以为右栏坏了）。
     *
     * 这里只做最保守的三态：文本原样、图片原样、二进制只报大小 —— 不假装能渲染 PDF/Office。
     */
    function FileSheet(props) {
      var t = props.t
      var view = props.view
      var body = null
      if (view.loading === true) {
        body = h('div', { className: 'superpi-empty-row' }, t('loading'))
      } else if (view.error !== null && view.error !== undefined && view.error !== '') {
        body = h('div', { className: 'superpi-alert' }, String(view.error))
      } else if (view.kind === 'image') {
        body = h('img', { className: 'superpi-img', alt: String(view.mimeType), src: 'data:' + String(view.mimeType) + ';base64,' + String(view.data) })
      } else if (view.kind === 'binary') {
        body = h('div', { className: 'superpi-empty-row' }, t('binaryFile').replace('{size}', String(view.size)))
      } else {
        body = h('pre', { className: 'superpi-pre', style: { whiteSpace: 'pre-wrap' } },
          String(view.text === undefined || view.text === null ? '' : view.text) + (view.truncated === true ? '\n' + t('fileTruncated') : ''))
      }
      return h(Sheet, { t: t, title: t('filePreview'), onClose: props.onClose },
        h('div', { className: 'superpi-mono' }, String(view.path)),
        body)
    }

    /**
     * 扩展 UI 弹窗：pi 的 select / confirm / input / editor 四种请求。
     *
     * 为什么要兜底超时：pi 的 createDialogPromise 只在扩展自己传了 timeout 时才收尾，
     * 否则 Promise 永远 pending、该次 prompt 的 response 永不出现（rpc-mode.ts:95-135）。
     * editor 请求连 timeout 字段都没有。所以面板必须无条件自己兜。
     */
    function ExtensionDialog(props) {
      var t = props.t
      var request = props.request
      var stateValue = useState(request.prefill === null ? '' : request.prefill)
      var value = stateValue[0]
      var setValue = stateValue[1]
      var stateLeft = useState(null)
      var left = stateLeft[0]
      var setLeft = stateLeft[1]
      var stateSending = useState(false)
      var sending = stateSending[0]
      var setSending = stateSending[1]
      var stateFailed = useState(false)
      var failed = stateFailed[0]
      var setFailed = stateFailed[1]
      var sendingRef = useRef(false)
      var dialogRef = useRef(null)

      var respond = function (answer) {
        if (sendingRef.current) return
        sendingRef.current = true
        setSending(true)
        setFailed(false)
        Promise.resolve().then(function () {
          return props.onRespond(Object.assign({ id: request.id }, answer))
        }).catch(function () {
          setFailed(true)
        }).finally(function () {
          sendingRef.current = false
          setSending(false)
        })
      }
      var cancel = function () { respond({ cancelled: true }) }

      useEffect(function () {
        if (request.method !== 'input' && dialogRef.current !== null) dialogRef.current.focus()
        var budget = dialogBudgetMs(request)
        var deadline = (request.receivedAt > 0 ? request.receivedAt : Date.now()) + budget
        var update = function () {
          var remain = deadline - Date.now()
          if (remain <= 0) {
            window.clearInterval(timer)
            setLeft(0)
            cancel()
            return
          }
          setLeft(Math.ceil(remain / 1000))
        }
        var timer = window.setInterval(update, 1000)
        update()
        return function () { window.clearInterval(timer) }
      }, [request.id])

      var title = request.title === '' ? t('extSelect') : request.title
      var body = []
      if (request.method === 'confirm') {
        body.push(h('p', { key: 'msg', className: 'superpi-dialog-msg' }, request.message === null ? '' : request.message))
        body.push(h('div', { key: 'act', className: 'superpi-dialog-actions' },
          h('button', { type: 'button', className: 'superpi-btn', disabled: sending, onClick: function () { respond({ confirmed: false }) } }, t('extNo')),
          h('button', { type: 'button', className: 'superpi-btn superpi-btn-primary', disabled: sending, onClick: function () { respond({ confirmed: true }) } }, t('extYes'))))
      } else if (request.method === 'select') {
        body.push(h('div', { key: 'opts', className: 'superpi-dialog-body' }, request.options.map(function (option, index) {
          return h('button', {
            key: 'o' + String(index),
            type: 'button',
            className: 'superpi-opt',
            disabled: sending,
            onClick: function () { respond({ value: option }) },
          }, option)
        })))
        body.push(h('div', { key: 'act', className: 'superpi-dialog-actions' },
          h('button', { type: 'button', className: 'superpi-btn', disabled: sending, onClick: cancel }, t('cancel'))))
      } else if (request.method === 'input') {
        body.push(h('input', {
          key: 'input',
          className: 'superpi-search',
          value: value,
          disabled: sending,
          autoFocus: true,
          'aria-label': title,
          placeholder: request.placeholder === null ? '' : request.placeholder,
          onChange: function (event) { setValue(event.target.value) },
          onKeyDown: function (event) {
            if (event.key === 'Enter' && !(event.nativeEvent && event.nativeEvent.isComposing)) respond({ value: value })
          },
        }))
        body.push(h('div', { key: 'act', className: 'superpi-dialog-actions' },
          h('button', { type: 'button', className: 'superpi-btn', disabled: sending, onClick: cancel }, t('cancel')),
          h('button', { type: 'button', className: 'superpi-btn superpi-btn-primary', disabled: sending, onClick: function () { respond({ value: value }) } }, t('extSubmit'))))
      } else {
        body.push(h('textarea', {
          key: 'ta',
          className: 'superpi-mini-ta',
          value: value,
          disabled: sending,
          onChange: function (event) { setValue(event.target.value) },
        }))
        body.push(h('div', { key: 'act', className: 'superpi-dialog-actions' },
          h('button', { type: 'button', className: 'superpi-btn', disabled: sending, onClick: cancel }, t('cancel')),
          h('button', { type: 'button', className: 'superpi-btn superpi-btn-primary', disabled: sending, onClick: function () { respond({ value: value }) } }, t('extSubmit'))))
      }
      var label = request.method === 'confirm' ? t('extConfirm') : request.method === 'input' ? t('extInput') : request.method === 'editor' ? t('extEditor') : t('extSelect')
      // 点遮罩 = 取消（回 cancelled:true），与右上角 CloseButton、pi 侧 Esc 同一语义。
      // 卡片同时补 aria-modal：这类弹窗会阻塞 pi 的整轮等待，不声明模态读屏会以为面板其余部分仍可操作。
      return h('div', { className: 'superpi-dialog-wrap', onClick: maskHandler(cancel) },
        h('div', {
          className: 'superpi-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, 'aria-busy': sending,
          ref: dialogRef, tabIndex: -1,
          onKeyDown: function (event) {
            if (event.key !== 'Escape' || (event.nativeEvent && event.nativeEvent.isComposing)) return
            event.stopPropagation()
            cancel()
          },
        },
          // 扩展弹窗以前只有底部「取消 / 提交」，没有右上角关闭；这里补一个与抽屉同款的 CloseButton，
          // 语义等于取消（回 cancelled:true），跟 pi 的 Esc 取消一致。
          h('div', { className: 'superpi-dialog-head' },
            h('h3', null, label + ' · ' + title),
            h(CloseButton, { t: t, onClick: cancel })),
          left === null ? null : h('div', { className: 'superpi-mono' }, t('extTimeout').replace('{n}', String(left))),
          body,
          failed ? h('p', { role: 'alert', className: 'superpi-dialog-msg' }, t('extResponseFailed')) : null))
    }

    function ImageOverlay(props) {
      return h('div', { className: 'superpi-img-open', onClick: props.onClose },
        h('img', { alt: props.image.mimeType, src: 'data:' + String(props.image.mimeType) + ';base64,' + String(props.image.data) }))
    }

    // ── 契约消费层 ──────────────────────────────────────────────────────────

    /**
     * 把 GET /contract 下发的原始 JSON 整理成面板好用的形状。
     *
     * 面板**不许自带命令表**：唯一真相源是 src/rpc-contract.mjs，host 原样下发，面板只做索引。
     * 这样 pi 升级后只要契约改了，面板自动跟上，不会出现「面板说支持 A、pi 其实已经改成 B」。
     */
    function buildContract(raw) {
      var source = raw === null || raw === undefined ? {} : raw
      var tui = Array.isArray(source.tuiCommands) ? source.tuiCommands : []
      var bash = Array.isArray(source.bashShortcuts) ? source.bashShortcuts : []
      var byText = Object.create(null)
      for (var i = 0; i < tui.length; i += 1) {
        var entry = tui[i]
        if (entry !== null && typeof entry === 'object' && typeof entry.text === 'string') byText[entry.text] = entry
      }
      return {
        version: typeof source.version === 'string' ? source.version : '',
        piVersion: typeof source.piVersion === 'string' ? source.piVersion : '',
        tui: tui,
        bash: bash,
        byText: byText,
        events: Array.isArray(source.events) ? source.events : [],
        rpcCommands: Array.isArray(source.rpcCommands) ? source.rpcCommands : [],
        assistantEvents: Array.isArray(source.assistantEvents) ? source.assistantEvents : [],
        /**
         * 这里**不再有** `malformed` / `malformedNotice`（0.18.0）。
         *
         * 判读在 host 做，结果随 `message_end.verdict` 到达（含中英文案），
         * 面板只是渲染者。契约只承载 pi 侧的事实（命令 / 事件 / 斜杠 / 输入分类）。
         */
      }
    }

    /**
     * 输入分类器：**算法在面板、表在契约**。
     * 与 src/rpc-contract.mjs 的 classifyInput 一一对应（那边是单一真相源，
     * test/parity.mjs 会用同一批输入同时喂两边对账）。
     */
    function classifyInput(raw, contract) {
      var text = typeof raw === 'string' ? raw : ''
      var trimmed = text.trim()
      if (trimmed === '') return { kind: 'empty' }
      if (trimmed.charAt(0) === '!') {
        var isDouble = trimmed.slice(0, 2) === '!!'
        var command = (isDouble ? trimmed.slice(2) : trimmed.slice(1)).trim()
        if (command === '') return { kind: 'empty' }
        return { kind: 'bash', command: command, excludeFromContext: isDouble, invoked: isDouble ? '!!' : '!' }
      }
      if (trimmed.charAt(0) === '/') {
        var match = /^(\S+)([\s\S]*)$/.exec(trimmed)
        var name = match === null ? trimmed : match[1]
        var args = match === null ? '' : match[2].trim()
        var entry = contract === null ? undefined : contract.byText[name]
        if (entry !== undefined && entry !== null) {
          return { kind: 'slash', name: name, args: args, entry: entry, disposition: entry.disposition, commands: entry.commands }
        }
        return { kind: 'unknown-slash', name: name, args: args }
      }
      return { kind: 'prompt', text: trimmed }
    }

    /**
     * 斜杠菜单的数据源：契约里的 27 条内置命令 + pi 自己报上来的扩展命令。
     * Composer 用 item.name 过滤与显示、用 item.insert 插入，所以这里必须都补齐。
     */
    function slashItems(contract, dynamic) {
      var items = []
      var tui = contract === null ? [] : contract.tui
      for (var i = 0; i < tui.length; i += 1) {
        var entry = tui[i]
        if (entry === null || typeof entry !== 'object' || typeof entry.text !== 'string') continue
        var prefix = entry.match === 'prefix'
        items.push({
          name: entry.text,
          insert: prefix ? entry.text + ' ' : entry.text,
          desc: typeof entry.note === 'string' ? entry.note : '',
          side: typeof entry.disposition === 'string' ? entry.disposition : '',
          tone: entry.disposition === 'cli-only' || entry.disposition === 'unsupported' ? 'warn' : '',
          source: 'builtin',
          disposition: entry.disposition,
        })
      }
      var list = Array.isArray(dynamic) ? dynamic : []
      for (var j = 0; j < list.length; j += 1) {
        var command = list[j]
        if (command === null || typeof command !== 'object' || typeof command.name !== 'string') continue
        items.push({
          name: '/' + command.name,
          insert: '/' + command.name + ' ',
          desc: typeof command.description === 'string' ? command.description : '',
          side: String(command.source === undefined ? '' : command.source),
          tone: '',
          source: 'dynamic',
          disposition: 'prompt',
        })
      }
      return items
    }

    // ── 自检胶囊 / 运行时引导 ──────────────────────────────────────────────

    /**
     * 自检胶囊：插件文件哈希、git 提交、bundle 与 src 的新旧关系都来自 GET /selfcheck。
     * report 为 null 时不渲染（没检查过就别假装健康）。
     */
    function SelfCheckChip(props) {
      var t = props.t
      var report = props.report
      if (report === null || report === undefined || typeof report !== 'object') return null
      var summary = report.summary === undefined || report.summary === null ? {} : report.summary
      var pi = report.pi === undefined || report.pi === null ? {} : report.pi
      var git = report.git === undefined || report.git === null ? {} : report.git
      var staleCode = summary.stale === true
      var staleBuild = pi.buildFresh === false
      var tone = staleCode === true || staleBuild === true ? 'warn' : 'ok'
      var label = staleCode ? t('staleCode') : staleBuild ? t('staleBuild') : t('synced')
      var changed = Array.isArray(summary.changed) ? summary.changed : []
      var missing = Array.isArray(summary.missing) ? summary.missing : []
      var detail = []
      if (typeof summary.hint === 'string' && summary.hint !== '') detail.push(summary.hint)
      if (staleBuild) detail.push('bundle 早于 src，需要重跑 npm run build')
      if (git.available === true && typeof git.commit === 'string' && git.commit !== '') {
        var branch = typeof git.branch === 'string' && git.branch !== '' ? git.branch : 'detached'
        detail.push('git ' + branch + ' @ ' + git.commit.slice(0, 9))
      }
      if (changed.length > 0) detail.push('改动：' + changed.join(', '))
      if (missing.length > 0) detail.push('缺失：' + missing.join(', '))
      detail.push('点一下重新检查')
      return h('button', {
        type: 'button',
        className: 'superpi-chip',
        'data-clickable': '1',
        'data-tone': tone,
        title: detail.join('\n'),
        onClick: function () { if (typeof props.onClick === 'function') props.onClick() },
      }, h('span', { className: 'superpi-chip-name' }, label))
    }

    /** 运行时缺失时的整页引导：一键从公共 npm 装到插件目录。 */
    function RuntimeGate(props) {
      var t = props.t
      var runtime = props.runtime === null || props.runtime === undefined ? {} : props.runtime
      var install = runtime.install === null || runtime.install === undefined ? {} : runtime.install
      var searched = Array.isArray(runtime.searched) ? runtime.searched : []
      var stateBusy = useState(false)
      var busy = stateBusy[0]
      var setBusy = stateBusy[1]
      var stateFailure = useState(null)
      var failure = stateFailure[0]
      var setFailure = stateFailure[1]

      function run() {
        setBusy(true)
        setFailure(null)
        api.install().then(function () {
          setBusy(false)
          if (typeof props.onInstalled === 'function') props.onInstalled()
        }).catch(function (error) {
          setBusy(false)
          setFailure(error.message)
        })
      }

      return h('div', { className: 'superpi-root' },
        h('div', { className: 'superpi-head' },
          h('div', { className: 'superpi-head-main' },
            h(SuperPiIcon, { size: 16 }),
            h('span', { className: 'superpi-brand' }, t('panelTitle')))),
        h('div', { className: 'superpi-gate' },
          h('div', { className: 'superpi-gate-card' },
            h(SuperPiIcon, { size: 30 }),
            h('h3', null, t('runtimeMissing')),
            h('p', { className: 'superpi-empty p' }, t('runtimeMissingHint')),
            failure === null ? null : h('div', { className: 'superpi-alert' }, t('installFailed') + '：' + failure),
            h('div', { className: 'superpi-gate-actions' },
              h('button', { type: 'button', className: 'superpi-btn superpi-btn-primary', disabled: busy, onClick: run }, busy ? t('installing') : t('installRuntime')),
              h('button', { type: 'button', className: 'superpi-btn', onClick: function () { if (typeof props.onRecheck === 'function') props.onRecheck() } }, t('recheck'))),
            install.target === undefined ? null : h('div', { className: 'superpi-gate-path' }, String(install.target)),
            h('div', { className: 'superpi-gate-searched' },
              h('div', null, t('searchedAt') + '：'),
              h('ul', { style: { margin: '0', paddingLeft: '16px' } }, searched.map(function (item, index) {
                var ok = item !== null && item !== undefined && item.ok === true
                return h('li', { key: 's' + String(index) }, (ok ? '✓ ' : '✗ ') + String(item === null || item === undefined ? '' : item.source) + ' · ' + String(item === null || item === undefined ? '' : item.path))
              }))))))
    }

    /** 命名抽屉 = 面板的 /name（无参数时）。 */
    function NameSheet(props) {
      var t = props.t
      var stateValue = useState(props.value === null || props.value === undefined ? '' : props.value)
      var value = stateValue[0]
      var setValue = stateValue[1]
      return h(Sheet, { t: t, title: t('namePrompt'), onClose: props.onClose },
        h('input', {
          className: 'superpi-search',
          value: value,
          placeholder: t('namePrompt'),
          onChange: function (event) { setValue(event.target.value) },
          onKeyDown: function (event) { if (event.key === 'Enter') props.onSet(value) },
        }),
        h('div', { className: 'superpi-dialog-actions' },
          h('button', { type: 'button', className: 'superpi-btn', onClick: props.onClose }, t('cancel')),
          h('button', { type: 'button', className: 'superpi-btn superpi-btn-primary', onClick: function () { props.onSet(value) } }, t('extSubmit'))))
    }

    /**
     * bash 气泡：命令行里的 ! / !! 结果。
     *
     * 为什么必须单独渲染：BashExecutionMessage 是 pi 的自定义消息（role:'bashExecution'），
     * 既不是 toolCall 也不是 toolResult。命令行的 ! 与面板走同一个 RPC bash，
     * 但 pi **不会**为它发 message_start / message_end（agent-session.ts:4236 _flushPendingBashMessages
     * 直接 appendMessage），所以面板只能靠 get_messages 回拉才能看见它。
     */
    function BashBlock(props) {
      var message = props.message
      var bash = message.bash === null || message.bash === undefined
        ? { command: '', output: '', exitCode: null, cancelled: false, truncated: false }
        : message.bash
      // 状态注脚与工具行同一套语汇：失败才染色，成功不占位（成功的 exit 0 没有信息量）。
      var failed = bash.cancelled !== true && typeof bash.exitCode === 'number' && bash.exitCode !== 0
      var note = bash.cancelled === true
        ? props.t('cancel')
        : typeof bash.exitCode === 'number' && bash.exitCode !== 0
          ? 'exit ' + String(bash.exitCode)
          : bash.truncated === true ? 'truncated' : ''
      var attrs = { className: 'superpi-tool' }
      if (failed === true) attrs['data-state'] = 'error'
      return h('details', attrs,
        h('summary', { className: 'superpi-proc-head' }, procHead({
          Icon: TerminalIcon,
          label: props.t('procBash'),
          summary: h('span', { key: 'p', className: 'superpi-proc-text', title: bash.command }, firstLineOf(bash.command)),
          note: note,
          noteTone: failed === true || bash.cancelled === true ? (failed === true ? 'err' : 'warn') : 'warn',
        })),
        h('pre', { className: 'superpi-tool-body' }, bash.output === '' ? '' : bash.output))
    }

    // ── 主面板 ──────────────────────────────────────────────────────────────
    //
    // 对齐原则（docs/parity.md）：命令行 pi 能做的事，面板必须能做；做不到的必须显式说明原因，
    // 绝不允许「静默降级」。所有斜杠命令的分发都在 handleSlash 里，与 src/rpc-contract.mjs 的
    // disposition 一一对应。

    function SuperPiPanel(props) {
      var t = props.t

      var phaseState = useState('loading')
      var phase = phaseState[0]
      var setPhase = phaseState[1]
      var errorState = useState(null)
      var error = errorState[0]
      var setError = errorState[1]
      var metaState = useState(null)
      var meta = metaState[0]
      var setMeta = metaState[1]
      var runtimeState = useState(null)
      var runtime = runtimeState[0]
      var setRuntime = runtimeState[1]
      var verifyState = useState(null)
      var verify = verifyState[0]
      var setVerify = verifyState[1]
      var brokenState = useState(false)
      var broken = brokenState[0]
      var setBroken = brokenState[1]
      var thinkingState = useState('')
      var thinking = thinkingState[0]
      var setThinking = thinkingState[1]
      var levelsState = useState([])
      var levels = levelsState[0]
      var setLevels = levelsState[1]
      var contractState = useState(null)
      var contract = contractState[0]
      var setContract = contractState[1]
      /**
       * 契约加载失败的原因（`null` = 正常）。
       *
       * 为什么要专门记它：契约是畸形判据的**唯一输入**。它没到时判据只能返回
       * `none`，于是“本轮未执行”这个提示就不存在 —— 而用户看不到的东西等于不存在。
       * 把失败原因记下来并在界面上明确说出来，比默默不提示强：
       * 前者是“功能不可用，原因是 X”，后者是“功能不存在”。
       */
      var contractErrorState = useState(null)
      var contractError = contractErrorState[0]
      var setContractError = contractErrorState[1]
      var dynamicState = useState([])
      var dynamic = dynamicState[0]
      var setDynamic = dynamicState[1]
      var imagesState = useState([])
      var images = imagesState[0]
      var setImages = imagesState[1]
      var overlayState = useState(null)
      var overlay = overlayState[0]
      var setOverlay = overlayState[1]
      // 面板内文件预览（FileSheet）的载荷。null = 没开预览。
      // 只在右栏不可用时才被填值 —— 它不是主路径，见 FileSheet 上方注释。
      var fileViewState = useState(null)
      var fileView = fileViewState[0]
      var setFileView = fileViewState[1]
      var drawerState = useState(null)
      var drawer = drawerState[0]
      var setDrawer = drawerState[1]
      // 模型 / 思考档位共用的向上弹层（用户 30427：点左下角模型名向上弹，思考档位放在同一层）。
      // 受控：开合在面板上，Composer 只渲染与转发 —— 这样左下角、+ 菜单、/model、
      // /thinking、以及「按名字找不到模型」的兜底可以共用同一个弹层。
      var pickerState = useState(false)
      var pickerOpen = pickerState[0]
      var setPickerOpen = pickerState[1]
      var moreState = useState(false)
      var moreOpen = moreState[0]
      var setMoreOpen = moreState[1]
      // null | 'compact' | 'reconnect'：压缩上下文与重新连接都要先过二次确认。
      var confirmState = useState(null)
      var confirm = confirmState[0]
      var setConfirm = confirmState[1]
      // ui-prefs（项目名 / 会话名 / 置顶）。0.8.1 起由面板单点持有：顶栏标题要显示当前项目名，
      // 历史会话列表也要用它排「重命名过 / 置顶过」的次序 —— 两处各拉一次就会出现
      // 「列表已改名、顶栏还是旧名」。写入仍由列表发起，成功后把 host 回的全量交回这里。
      var prefsState = useState({ projects: {}, sessions: {} })
      var prefs = prefsState[0]
      var setPrefs = prefsState[1]
      /** 只收 store 真给出的两棵表；缺字段一律当空表，渲染层就不用到处 undefined 判断。 */
      var applyPrefs = function (body) {
        var next = { projects: {}, sessions: {} }
        if (body !== null && body !== undefined) {
          if (body.projects !== undefined && body.projects !== null) next.projects = body.projects
          if (body.sessions !== undefined && body.sessions !== null) next.sessions = body.sessions
        }
        setPrefs(next)
      }
      /**
       * 用户自定义规则（0.10.0）。
       *
       * 三个状态字段而不是一个：rules 是数据（null = 还在路上），rulesError 是**读失败**
       * （与「清空」完全是两件事，不能都表达为 null），rulesEpoch 只是用来在保存/恢复默认后
       * 重建编辑弹窗的初始值（弹窗里的 useState 只在首次挂载时取初值）。
       *
       * 挂载就拉一次，而不是打开设置才拉：它决定设置弹窗里那一行摘要显示什么，
       * 而「打开设置 → 等一下才出内容」就是一次白屏跳变。
       */
      var rulesState = useState(null)
      var rules = rulesState[0]
      var setRules = rulesState[1]
      var rulesErrorState = useState(null)
      var rulesError = rulesErrorState[0]
      var setRulesError = rulesErrorState[1]
      var rulesEpochState = useState(0)
      var rulesEpoch = rulesEpochState[0]
      var setRulesEpoch = rulesEpochState[1]
      /**
       * 模型模态开关（0.13.0）：`{ state, registry }`，来自 host 的 `/modalities`。
       * 与 `models`（来自 pi 的 get_available_models）合并后才是完整的一节：
       * 前者说「用户设了什么」，后者说「这个模型协议上有什么」。
       */
      var modalitiesState = useState(null)
      var modalities = modalitiesState[0]
      var setModalities = modalitiesState[1]
      var modalitiesErrorState = useState(null)
      var modalitiesError = modalitiesErrorState[0]
      var setModalitiesError = modalitiesErrorState[1]
      var modelsState = useState([])
      var models = modelsState[0]
      var setModels = modelsState[1]
      var modelsLoadingState = useState(false)
      var modelsLoading = modelsLoadingState[0]
      var setModelsLoading = modelsLoadingState[1]
      var treeState = useState(null)
      var tree = treeState[0]
      var setTree = treeState[1]
      var forkState = useState([])
      var forkItems = forkState[0]
      var setForkItems = forkState[1]
      var statsState = useState(null)
      var stats = statsState[0]
      var setStats = statsState[1]
      /**
       * 上下文守卫的真实占用（0.12.0）：独立于 pi 的 `contextUsage`。
       * 后者是 usage 派生值，当前上游把 prompt 全记在 cache 且 input=0，会显示成 3.7%；
       * 这个来自守卫每次请求前算的估算（含图片按视觉 token 计），才是能用来做决定的数。
       */
      var guardContextState = useState(null)
      var guardContext = guardContextState[0]
      var setGuardContext = guardContextState[1]
      // 底部统计行用的是一份独立的 stats 快照：抽屉里的 stats 只在打开时拉一次，
      // 而统计行要跟着每一轮结束刷新，两者生命周期不同，共用一份会让关闭抽屉后数据变旧。
      var footerState = useState(null)
      var footerStats = footerState[0]
      var setFooterStats = footerState[1]
      var entriesState = useState(null)
      var entriesReport = entriesState[0]
      var setEntries = entriesState[1]
      var infoState = useState(null)
      var info = infoState[0]
      var setInfo = infoState[1]
      var textState = useState('')
      var sheetText = textState[0]
      var setSheetText = textState[1]
      var renderState = useState(0)
      var bump = renderState[1]

      var viewRef = useRef(null)
      if (viewRef.current === null) viewRef.current = createView()
      var pendingRef = useRef([])
      /**
       * 契约的 ref 副本（0.16.2）。
       *
       * `applyRecord` 在**事件应用**那一拍就需要畸形判定表，而那里不是 React
       * 组件体（是纯函数），拿不到 `contract` 这个 state。三种选择：
       *   ① 把 contract 沿 applyBatch / hydrateFromSnapshot / ingest / resync / attach
       *      四条调用链逐层下传 —— 四个函数签名都要改，下一个人漏传一处就是静默退化；
       *   ② 在面板里内置一份默认表 —— 那就是**又一次分叉**，正是你要消除的毛病；
       *   ③ 一个 ref：写入点只有一个（loadContract 成功那一拍），读取点是只读的。
       * 选③。它不引入隐式全局状态：这个 ref 与 viewRef 同源，生命周期完全跟随会话。
       */
      var contractRef = useRef(null)
      var timerRef = useRef(null)
      var sourceRef = useRef(null)
      var sessionRef = useRef(null)
      var opensRef = useRef(0)
      var scrollRef = useRef(null)
      var pinnedRef = useRef(true)
      var bashRef = useRef(false)
      // 会话内容被替换（switch_session / fork / clone / new_session）时 host 会清空事件缓冲，
      // 历史消息不会以事件形式重放，只能靠 get_messages 对账。busy 期间覆盖会吞掉流式气泡，
      // 所以先挂一笔待办，等 settled 那一拍再补。
      var hydratePendingRef = useRef(false)
      var metaRef = useRef(null)
      var moreRef = useRef(null)
      metaRef.current = meta

      var repaint = function () { bump(function (value) { return value + 1 }) }

      /** 弹出提示：写进 view.notices（最多 5 条），不阻塞任何操作。 */
      var notice = function (text, tone) {
        pushNotice(viewRef.current, text, tone)
        repaint()
      }

      /** 回拉一页历史消息，并以它为准整表重建（等价于命令行 pi 从 jsonl 恢复会话）。
       *
       * 为什么必须有这一步：bash 结果、以及「已落盘但没发事件」的历史消息只有 get_messages 能给。
       * switch_session / fork / clone / new_session 之后 host 会 resetEvents（index.js 的
       * SESSION_REPLACING_COMMANDS），事件缓冲归零，snapshot 里没有任何历史 —— 只重放事件面板
       * 必然是空的。这是 0.4.0 及之前「点开历史会话没有内容」的根因。
       *
       * 0.14.0 改为**分页**（判据见 docs/performance-acceptance.md §1.2 D）：
       * 整个会话一次拉完实测 55.1 MB / 3251 条，其中 88.2% 是图片 base64。
       * 现在只取最近一页（默认 200 条、图片为 image-stub），实测 224 KB、0.3 ms；
       * 更早的历史由「加载更早」按 before 往前翻。
       *
       * 两道防线：
       *  - 会话已经切走（sessionRef 变了）就丢弃结果，避免旧会话的响应污染新会话；
       *  - 正在跑动（busy）就不覆盖列表，改记待办，由 flush 在 settled 那一拍补上，
       *    否则会把正在流式的气泡整条吞掉。
       */
      var refreshMessages = function (before) {
        var id = sessionRef.current
        if (id === null) return Promise.resolve(null)
        var query = typeof before === 'number' && before > 0 ? ('?before=' + String(before)) : ''
        return requestJson('/sessions/' + encodeURIComponent(id) + '/messages' + query).then(function (body) {
          if (sessionRef.current !== id) return null
          if (body === null || typeof body !== 'object' || body.ok === false) return null
          var payload = body.data === undefined ? null : body.data
          var list = payload !== null && payload !== undefined && Array.isArray(payload.messages) ? payload.messages : null
          if (list === null) return null
          var view = viewRef.current
          if (view.busy === true) {
            hydratePendingRef.current = true
            return null
          }
          var next = messagesFromHistory(list)
          if (next === null) return null
          if (typeof payload.total === 'number') view.messageTotal = payload.total
          view.hasEarlier = payload.hasMore === true
          view.nextBefore = typeof payload.nextBefore === 'number' ? payload.nextBefore : 0
          // 往回翻：把新拿到的更早一页拼到现有列表**前面**，并按 seq 去重。
          //
          // 去重不能靠"新的全是更早的"这个假设：翻页期间若有新消息落库，两页在边界上
          // 会重叠。seq 来自 host 分页时写进每条消息的**完整列表下标**，所以它才是
          // 唯一可靠的排序与去重依据。
          if (typeof before === 'number' && before > 0) {
            var existingSeqs = {}
            for (var mi = 0; mi < view.messages.length; mi += 1) existingSeqs[String(view.messages[mi].seq)] = true
            var older = next.filter(function (item) { return existingSeqs[String(item.seq)] !== true })
            view.messages = older.concat(view.messages)
            view.openIndex = -1
            view.streamingIndex = -1
            repaint()
            return null
          }
          view.messages = next
          view.openIndex = -1
          view.streamingIndex = -1
          repaint()
          return null
        }, function () { return null })
      }

      /** 「加载更早」：按 nextBefore 往前翻一页。 */
      var loadEarlier = function () {
        var view = viewRef.current
        if (view.loadingEarlier === true) return Promise.resolve(null)
        if (view.hasEarlier !== true) return Promise.resolve(null)
        view.loadingEarlier = true
        repaint()
        return refreshMessages(view.nextBefore).then(function () {
          viewRef.current.loadingEarlier = false
          repaint()
          return null
        })
      }

      /** 挂载 / 切换会话后对账一次历史消息；busy 时挂待办，settled 时由 flush 补。 */
      var hydrate = function (id) {
        if (id === null || id === undefined) return Promise.resolve(null)
        if (viewRef.current.busy === true) {
          hydratePendingRef.current = true
          return Promise.resolve(null)
        }
        hydratePendingRef.current = false
        return refreshMessages()
      }

      /** busy 期间挂起的历史对账，等这一轮真的结束（视图里 busy 已归 false）再补一次。 */
      var drainHydrate = function () {
        if (hydratePendingRef.current !== true) return
        if (viewRef.current.busy === true) return
        hydratePendingRef.current = false
        refreshMessages()
      }

      var flush = function () {
        timerRef.current = null
        var batch = pendingRef.current
        pendingRef.current = []
        if (batch.length === 0) {
          drainHydrate()
          return
        }
        for (var i = 0; i < batch.length; i += 1) {
          var entry = batch[i]
          var record = entry === null || entry === undefined ? null : entry.record
          if (record === null || record === undefined) continue
          if (record.type === 'bash_execution_update') bashRef.current = true
          if (record.type === 'entry_appended' && record.entry && record.entry.type === 'context_edit') {
            hydratePendingRef.current = true
          }
        }
        applyBatch(viewRef.current, batch)
        repaint()
        var settled = false
        for (var j = 0; j < batch.length; j += 1) {
          var tail = batch[j]
          var kind = tail === null || tail === undefined || tail.record === undefined ? '' : String(tail.record.type)
          if (kind === 'agent_settled' || kind === 'agent_end') settled = true
        }
        // bash 的结果不进事件流，只有 get_messages 能补上；不刷新就等于把 ! 的输出弄丢了。
        if (bashRef.current === true && settled) {
          bashRef.current = false
          refreshMessages()
        }
        // 命令表（扩展命令 / prompt 模板 / skill）是 pi 侧运行时状态：装了新扩展、改了
        // templates 目录、或扩展在本次轮次里注册了新命令，都不会有任何事件通知面板。
        // 不重拉的话斜杠菜单一直是挂载那一刻的快照（0.3.0 之前的真实缺陷：新装的
        // /dsh-ui-probe 在菜单里根本看不到，但直接敲进去 pi 又能执行）。
        // 轮次结束是唯一的自然刷新点：此时 agent 已 idle，多问一次 get_commands 没有副作用。
        if (settled === true) {
          var sid = sessionRef.current
          if (sid !== null) {
            loadCommands(sid)
            // 轮次结束是统计数字唯一变化的时刻（tokens / 缓存读只在 usage 事件里出现），
            // 与命令表共用同一个 settle 点，避免多一次定时器。
            loadFooterStats(sid)
          }
        }
        drainHydrate()
      }

      var ingest = function (entries) {
        if (entries.length === 0) return
        for (var i = 0; i < entries.length; i += 1) pendingRef.current.push(entries[i])
        if (timerRef.current === null) timerRef.current = window.setTimeout(flush, 40)
      }

      var closeStream = function () {
        if (sourceRef.current === null) return
        try { sourceRef.current.close() } catch (failure) { /* 已关闭 */ }
        sourceRef.current = null
      }

      var resync = function (id) {
        return api.snapshot(id, viewRef.current.lastSeq).then(function (snapshot) {
          /**
           * 走与 attach 同一个装配函数（0.16.1）。
           *
           * 注意这里 hydrateFromSnapshot 会把 lastSeq 归零再回放 —— 对 resync 也正确：
           * snapshot 已经按 since=lastSeq 裁过，events 里只有增量；
           * 归零只是让「本函数不依赖调用前的水位」，随后 advanceSeq 补齐到 snapshot.eventSeq。
           * 若 self 的缓冲已把这段丢掉（droppedEvents），水位靠 advanceSeq 前进，
           * 不会永远停在原地、每次重连都重要同一段。
           */
          hydrateFromSnapshot(viewRef.current, snapshot)
          if (snapshot.state === 'busy') markBusy(viewRef.current)
          else markIdle(viewRef.current)
          setMeta(snapshot)
          setBroken(false)
          flush()
          return null
        }, function () { return null })
      }

      var openStream = function (id, since) {
        closeStream()
        var source = new EventSource(API_PREFIX + '/sessions/' + encodeURIComponent(id) + '/events?since=' + String(since))
        sourceRef.current = source
        opensRef.current = 0
        source.onopen = function () {
          opensRef.current += 1
          if (opensRef.current > 1) resync(id)
          else setBroken(false)
        }
        source.onmessage = function (event) {
          var entry = null
          try { entry = JSON.parse(event.data) } catch (failure) { entry = null }
          if (entry === null || typeof entry !== 'object') return
          ingest([entry])
        }
        source.addEventListener('exit', function (event) {
          var detail = null
          try { detail = JSON.parse(event.data) } catch (failure) { detail = null }
          /**
           * 子进程已退出（0.16.1 起 host 会把它从会话池里摘掉，见 index.js 的 exit 处理）。
           *
           * 这里**不再 resync**：会话已经不在池里，snapshot 会 404 ——
           * 继续调只会白跑一次请求、并在控制台留下一个 404。
           * 旧实现正是靠 resync 把界面「修回 idle」，于是用户看到的是
           * 「一切正常但什么都不能做」；真正该说的是「这个会话已经结束了」。
           *
           * 三条信息必须同时给到，缺一条用户就看不出发生了什么：
           *   ① 结果是崩溃（crashed + code）
           *   ② 现在这个会话不可用了（sessionEnded）
           *   ③ 下一步该做什么（重连 / 新会话都在顶栏与更多菜单里，这里只指路）
           */
          markIdle(viewRef.current)
          viewRef.current.notice = detail === null ? t('crashed') : t('crashed') + ' (code ' + String(detail.code) + ')'
          /**
           * 主动关掉一个已经死掉的会话：让「关掉」有明确归属。
           *
           * 不做的话，本地 sessionRef 仍指向那个 id，后续任何 rpc 都会 404；
           * 而「重连」走的是 endSession（内部已经 api.close + 重新 create）——
           * 这里先 close 一次是为了让**点「新会话」**也能立刻工作：
           * 面板是「一个会话一个子进程」的模型，死进程不清掉，
           * 用户点新会话就会又看到一个死会话（0.16.0 的实测现象）。
           * 失败静默（404 = 已经被摘掉了，正是我们想要的结果）。
           */
          if (sessionRef.current === id) {
            sessionRef.current = null
            setPhase('ended')
            api.close(id).catch(function () { return null })
          }
          flush()
        })
        source.onerror = function () {
          if (source.readyState === 2) setBroken(true)
        }
      }

      var attach = function (id) {
        return api.snapshot(id, 0).then(function (snapshot) {
          var view = viewRef.current
          view.messages = []
          view.openIndex = -1
          view.streamingIndex = -1
          /**
           * 事件态整块交给 hydrateFromSnapshot（0.16.1）。
           *
           * 不要在这里再写 `view.lastSeq = ...` 或单独调 applyBatch ——
           * 「先回放后补水位」的顺序已经收进那个函数，这里一旦插手就又有了写错的机会
           * （0.16.0 的 P0 正是这么来的：两行顺序反了，缓冲事件 100% 丢弃）。
           */
          hydrateFromSnapshot(view, snapshot)
          if (snapshot.state === 'busy') markBusy(view)
          else markIdle(view)
          sessionRef.current = id
          setMeta(snapshot)
          setPhase('ready')
          openStream(id, view.lastSeq)
          flush()
          // 底部统计行不能等到下一次 settle：切会话 / 恢复历史会话时这里就是唯一的
          // 首次填充点，不拉的话 dock 在用户发出第一条消息前一直是空的。
          loadFooterStats(id)
          // 挂载即对账：首次进入、以及 switch_session / fork / clone / new_session 之后
          // host 的事件缓冲都是空的，历史消息只能靠 get_messages 拿回来。
          return hydrate(id).then(function () { return null })
        })
      }

      /** 会话内容被替换（new_session / switch_session / fork / clone）后重新挂载。 */
      var reload = function (id) {
        closeStream()
        return attach(id).then(function () { return loadState(id) }).then(function () { return loadLevels(id) }).then(function () { return loadCommands(id) }).then(function () { return loadFooterStats(id) })
      }

      var loadLevels = function (id) {
        return rpc(id, { type: 'get_available_thinking_levels' }).then(function (data) {
          if (data !== null && data !== undefined && Array.isArray(data.levels) && data.levels.length > 0) setLevels(data.levels)
          return null
        }, function () { return null })
      }

      /**
       * 重拉 pi 的命令表（扩展命令 / prompt 模板 / skill）。
       *
       * 返回命令数组（失败返回 null），调用方需要「现在到底有没有这条命令」的判断依据时
       * 直接用返回值，不要去读 state——同一轮里的 setDynamic 还没生效。
       */
      /** 底部统计行的数据源（轮次 / 步数 / tokens / 缓存命中 / 上下文占用）。 */
      var loadFooterStats = function (id) {
        return rpc(id, { type: 'get_session_stats' }).then(function (data) {
          setFooterStats(data !== null && typeof data === 'object' ? data : null)
          return data
        }, function () { return null })
      }

      var loadCommands = function (id) {
        return rpc(id, { type: 'get_commands' }).then(function (data) {
          var list = data !== null && data !== undefined && Array.isArray(data.commands) ? data.commands : []
          setDynamic(list)
          return list
        }, function () { return null })
      }

      /** 命令表里是否有这个名字（name 带前导斜杠）。 */
      var hasDynamic = function (list, name) {
        if (Array.isArray(list) === false) return false
        for (var i = 0; i < list.length; i += 1) {
          var item = list[i]
          if (item !== null && typeof item === 'object' && typeof item.name === 'string' && '/' + item.name === name) return true
        }
        return false
      }

      var loadContract = function () {
        return api.contract().then(function (body) {
          var built = buildContract(body)
          contractRef.current = built
          setContract(built)
          return null
        }, function () { return null })
      }

      /** get_state 是面板唯一可信的会话状态源（RPC 事件流里没有 model / sessionFile 变更）。 */
      var loadState = function (id) {
        return rpc(id, { type: 'get_state' }).then(function (data) {
          if (data === null || typeof data !== 'object') return null
          setInfo(data)
          if (typeof data.thinkingLevel === 'string') setThinking(data.thinkingLevel)
          setMeta(function (prev) {
            return Object.assign({}, prev === null ? {} : prev, {
              model: data.model === undefined ? null : data.model,
              thinkingLevel: data.thinkingLevel === undefined ? null : data.thinkingLevel,
              sessionName: data.sessionName === undefined ? null : data.sessionName,
              sessionFile: data.sessionFile === undefined ? null : data.sessionFile,
            })
          })
          return null
        }, function () { return null })
      }

      /**
       * 起会话。cwd 非空时强制新建（供「选择工作区」用）—— 不能在别的目录里复用已有会话，
       * 那会让用户以为切换成功了但实际还跑在旧 cwd 里。
       */
      var startSession = function (cwd) {
        var target = typeof cwd === 'string' && cwd !== '' ? cwd : null
        setPhase('loading')
        setError(null)
        return api.state().then(function (state) {
          var report = state !== null && state !== undefined && state.runtime !== null && typeof state.runtime === 'object' ? state.runtime : null
          setRuntime(report)
          if (report !== null && report.ok === false) {
            setPhase('missing')
            return null
          }
          var existing = target !== null ? [] : (state !== null && state !== undefined && Array.isArray(state.sessions) ? state.sessions : [])
          if (existing.length > 0) {
            var id = existing[0].id
            return attach(id)
              .then(function () { return loadState(id) })
              .then(function () { return loadLevels(id) })
              .then(function () { return loadCommands(id) })
          }
          return api.create(target === null ? {} : { cwd: target }).then(function (created) {
            var session = created !== null && created !== undefined && created.session !== null && typeof created.session === 'object' ? created.session : null
            if (session === null) throw new Error('host did not return a session')
            return attach(session.id)
              .then(function () { return loadState(session.id) })
              .then(function () { return loadLevels(session.id) })
              .then(function () { return loadCommands(session.id) })
          })
        }).catch(function (failure) {
          setPhase('error')
          setError(String(failure !== null && failure !== undefined && failure.message !== undefined ? failure.message : failure))
        })
      }

      /**
       * 面板启动：**契约仍然先于事件流就位**，但理由已经变了（0.18.0）。
       *
       * ---------------------------------------------------------------------------
       * 0.17.3 的理由（已失效，保留作历史）
       *
       * 那时 `message_end` 的判读要读 `contractRef.current.malformed` —— 契约晚到，
       * 判据只能返回 `none`，而 `message_end` 只处理一次、不会重算，
       * 于是那一轮的畸形提示永久丢失。当时的修法是把启动改成链式（契约先行）。
       *
       * ---------------------------------------------------------------------------
       * 现在的理由：**斜杠命令分派**，与判读无关
       *
       * 判读已经搬到 host（`record.verdict` 随事件到达），面板不需要契约。
       * 但 `classifyInput` 仍要靠契约里的 `tuiCommands` 决定一条斜杠输入怎么走：
       * 拿不到契约时 `/compact` 会被当成普通文本发给模型 —— 那是明确的禁止项
       * （AGENTS.md §5：「禁止把斜杠命令当普通文本发给模型」）。
       * 所以顺序保留，依赖的理由换成了这一条。
       *
       * 契约失败时也不能静默：明确记下原因；面板仍可对话，
       * 丢掉的只是斜杠分派（提示文案已改成这个意思，见 `contractFailed`）。
       */
      useEffect(function () {
        var cancelled = false
        loadContract()
          .catch(function (failure) {
            if (cancelled) return null
            setContractError(String(failure !== null && failure !== undefined && failure.message !== undefined ? failure.message : failure))
            return null
          })
          .then(function () {
            if (cancelled) return null
            return startSession()
          })
        return function () {
          cancelled = true
          closeStream()
          if (timerRef.current !== null) window.clearTimeout(timerRef.current)
        }
      }, [])

      // 自检只读磁盘、不碰 pi 子进程，面板打开时问一次即可；失败静默。
      var runSelfCheck = function () {
        return api.selfcheck().then(function (report) { setVerify(report !== null && typeof report === 'object' ? report : null) }, function () { setVerify(null) })
      }

      useEffect(function () { runSelfCheck() }, [])

      // 偏好只拉一次：它只在重命名 / 置顶时变，而那时写入方会把 host 回的全量交给 applyPrefs。
      // 读不到也不该让面板变红 —— 重命名与置顶是增强项，缺了只是回到默认排序。
      useEffect(function () {
        api.uiPrefs().then(applyPrefs).catch(function () {})
      }, [])

      // 规则也挂载即拉：它决定设置弹窗里那一行摘要显示什么。
      // 失败不报红（loadRules 已经把错误记进 rulesError，设置弹窗里会显示并给重试），
      // 原因：规则是设置项，读不到不该让整张面板进入 error 相。
      useEffect(function () {
        loadRules().catch(function () {})
      }, [])

      useEffect(function () {
        var node = scrollRef.current
        if (node === null || node === undefined) return
        if (pinnedRef.current) node.scrollTop = node.scrollHeight
      })

      var onScroll = function () {
        var node = scrollRef.current
        if (node === null || node === undefined) return
        pinnedRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80
        // 滚到顶自动往前翻一页（0.14.0 窗口化配套）。
        // 只在「已经没有任何已加载的更早内容」时才拉 host —— 本地窗口还有余量就先把
        // 窗口放大（RENDER_WINDOW 每次 +120），避免为一次滚动发一次网络请求。
        if (node.scrollTop > 24) return
        if (viewRef.current.hasEarlier !== true && viewRef.current.messages.length <= 120) return
        if (viewRef.current.loadingEarlier !== true && viewRef.current.hasEarlier === true) {
          loadEarlier()
        }
      }

      // ── 发送 / 中断 ────────────────────────────────────────────────────────

      var sendBody = function (body) {
        var id = sessionRef.current
        if (id === null) return Promise.resolve(null)
        if (viewRef.current.busy === true) body.streamingBehavior = 'steer'
        pinnedRef.current = true
        return rpc(id, body, CHAT_TIMEOUT_MS).then(function (data) {
          return data
        }, function (failure) {
          notice(String(failure !== null && failure !== undefined && failure.message !== undefined ? failure.message : failure), 'err')
          return null
        })
      }

      var continueTurn = function () {
        var current = viewRef.current
        if (current.busy === true || current.verdict === null) return
        var previous = current.verdict
        current.verdict = null
        repaint()
        return sendBody({ type: 'prompt', message: t('verdictRetry') }).then(function (result) {
          if (result === null && viewRef.current === current && current.busy === false && current.verdict === null) {
            current.verdict = previous
            repaint()
          }
        })
      }

      var handleBash = function (parsed) {
        var id = sessionRef.current
        if (id === null) return
        pinnedRef.current = true
        notice(parsed.invoked + ' ' + parsed.command, 'info')
        rpc(id, { type: 'bash', command: parsed.command, excludeFromContext: parsed.excludeFromContext === true }, CHAT_TIMEOUT_MS).then(function (data) {
          var result = data === null || data === undefined ? {} : data
          if (result.cancelled === true) notice(t('cancel'), 'warn')
          return refreshMessages()
        }, function (failure) {
          notice(String(failure !== null && failure !== undefined && failure.message !== undefined ? failure.message : failure), 'err')
        })
      }

      var setLevel = function (level) {
        var id = sessionRef.current
        if (id === null || level === '') return Promise.resolve(null)
        setThinking(level)
        return rpc(id, { type: 'set_thinking_level', level: level }).then(function () {
          return loadState(id)
        }, function (failure) {
          notice(String(failure !== null && failure !== undefined && failure.message !== undefined ? failure.message : failure), 'err')
          return null
        })
      }

      var pickModel = function (model) {
        var id = sessionRef.current
        if (id === null) return Promise.resolve(null)
        setPickerOpen(false)
        return rpc(id, { type: 'set_model', provider: model.provider, modelId: model.id }).then(function (next) {
          setMeta(function (prev) {
            return Object.assign({}, prev === null ? {} : prev, { model: next === null || next === undefined ? model : next })
          })
          return null
        }, function (failure) {
          notice(String(failure !== null && failure !== undefined && failure.message !== undefined ? failure.message : failure), 'err')
          return null
        })
      }

      /**
       * Esc 的语义与 TUI 完全一致（pi-main/packages/coding-agent/src/modes/interactive/interactive-mode.ts:3196-3200）：
       *   ① 自动重试中 → abort_retry（:3873-3878 把 Esc 换成 abortRetry）
       *   ② bash 正在跑 → abort_bash
       *   ③ 正在 streaming → clear_queue 把排队消息还给编辑器，再 abort
       *      （docs/rpc-commands.md:107 原文：send clear_queue before abort, then restore the returned text
       *        in the client editor；abort 会继续执行仍留在会话里的排队消息，所以必须先清）
       *   ④ 空闲 → abort（无害，pi 侧是空操作）
       */
      var stop = function () {
        var id = sessionRef.current
        if (id === null) return
        var view = viewRef.current
        var fail = function (failure) {
          notice(String(failure !== null && failure !== undefined && failure.message !== undefined ? failure.message : failure), 'err')
        }
        if (view.retrying === true) { rpc(id, { type: 'abort_retry' }).catch(fail); return }
        if (bashRef.current === true) { rpc(id, { type: 'abort_bash' }).catch(fail); return }
        if (view.busy !== true) { rpc(id, { type: 'abort' }).catch(fail); return }
        rpc(id, { type: 'clear_queue' }).then(function (data) {
          var steering = data !== null && data !== undefined && Array.isArray(data.steering) ? data.steering : []
          var followUp = data !== null && data !== undefined && Array.isArray(data.followUp) ? data.followUp : []
          var restored = steering.concat(followUp).map(function (item) { return String(item) })
          if (restored.length > 0) {
            var prev = viewRef.current.editorText
            var merged = prev === null || prev === undefined || String(prev) === '' ? restored.join('\n\n') : restored.join('\n\n') + '\n\n' + String(prev)
            viewRef.current.editorText = merged
            viewRef.current.queue = { steering: 0, followUp: 0, steeringText: [], followUpText: [] }
            repaint()
            notice(t('dequeued'), 'ok')
          }
          return rpc(id, { type: 'abort' })
        }, fail).catch(fail)
      }

      /**
       * 运行中追加「本轮之后再做」的消息（TUI 的 Alt+Enter / app.message.followUp，interactive-mode.ts:4676-4683）。
       *
       * 两条路分开走，和 CLI 完全一致：
       *   纯文本 → RPC follow_up（专为此设计的命令，等价 TUI 的 _queueFollowUp）
       *   '/' 开头 → prompt + streamingBehavior:'followUp'，因为 follow_up 会先用
       *              _throwIfExtensionCommand 把扩展命令打回（agent-session.ts:2473-2475），
       *              而 TUI 走的是 prompt()（:4681）→ 先 _tryExecuteExtensionCommand 立即执行（:2313-2320）。
       *              内置斜杠命令在 submit() 里已经分流，走不到这里。
       */
      var followUp = function (text) {
        var id = sessionRef.current
        if (id === null) return
        pinnedRef.current = true
        var head = String(text).trim()
        var body = head.charAt(0) === '/'
          ? { type: 'prompt', message: text, streamingBehavior: 'followUp' }
          : { type: 'follow_up', message: text }
        rpc(id, body, CHAT_TIMEOUT_MS).then(function (data) {
          var disposition = data !== null && data !== undefined && data.disposition !== undefined ? String(data.disposition) : 'queued'
          notice(disposition === 'handled' ? t('send') : t('steerQueued'), 'info')
          return loadState(id)
        }, function (failure) {
          notice(String(failure !== null && failure !== undefined && failure.message !== undefined ? failure.message : failure), 'err')
        })
      }

      /** 取回排队消息（TUI 的 alt+q / app.message.dequeue）。 */
      var dequeue = function () {
        var id = sessionRef.current
        if (id === null) return
        rpc(id, { type: 'clear_queue' }).then(function (data) {
          var steering = data !== null && data !== undefined && Array.isArray(data.steering) ? data.steering : []
          var followUpItems = data !== null && data !== undefined && Array.isArray(data.followUp) ? data.followUp : []
          var restored = steering.concat(followUpItems).map(function (item) { return String(item) })
          if (restored.length === 0) return null
          var prev = viewRef.current.editorText
          viewRef.current.editorText = prev === null || prev === undefined || String(prev) === ''
            ? restored.join('\n\n')
            : restored.join('\n\n') + '\n\n' + String(prev)
          viewRef.current.queue = { steering: 0, followUp: 0, steeringText: [], followUpText: [] }
          repaint()
          notice(t('dequeued'), 'ok')
          return null
        }, function (failure) {
          notice(String(failure !== null && failure !== undefined && failure.message !== undefined ? failure.message : failure), 'err')
        })
      }

      /** 下一个模型（TUI 的 ctrl+p / app.model.cycleForward）。反向循环 RPC 面没有（parity D-08）。 */
      var cycleModel = function () {
        var id = sessionRef.current
        if (id === null) return
        rpc(id, { type: 'cycle_model' }).then(function (data) {
          if (data === null || data === undefined) { notice(t('modelsEmpty'), 'warn'); return null }
          setMeta(function (prev) {
            return Object.assign({}, prev === null ? {} : prev, {
              model: data.model === undefined ? null : data.model,
              thinkingLevel: data.thinkingLevel === undefined ? null : data.thinkingLevel,
            })
          })
          if (typeof data.thinkingLevel === 'string') setThinking(data.thinkingLevel)
          return null
        }, function (failure) {
          notice(String(failure !== null && failure !== undefined && failure.message !== undefined ? failure.message : failure), 'err')
        })
      }

      /** 下一个思考档位（TUI 的 shift+tab / app.thinking.cycle）。模型不支持思考时 RPC 回 null。 */
      var cycleThinking = function () {
        var id = sessionRef.current
        if (id === null) return
        rpc(id, { type: 'cycle_thinking_level' }).then(function (data) {
          if (data === null || data === undefined || data.level === undefined) { notice(t('modelsEmpty'), 'warn'); return null }
          setThinking(String(data.level))
          return loadState(id)
        }, function (failure) {
          notice(String(failure !== null && failure !== undefined && failure.message !== undefined ? failure.message : failure), 'err')
        })
      }

      // ── 斜杠命令分发 ───────────────────────────────────────────────────────

      var runNewSession = function () {
        var id = sessionRef.current
        if (id === null) { startSession(); return }
        rpc(id, { type: 'new_session' }).then(function (data) {
          if (data !== null && data !== undefined && data.cancelled === true) return null
          return reload(id)
        }, function (failure) {
          notice(String(failure !== null && failure !== undefined && failure.message !== undefined ? failure.message : failure), 'err')
          return null
        })
      }

      var endSession = function () {
        var id = sessionRef.current
        closeStream()
        sessionRef.current = null
        var chain = id === null ? Promise.resolve(null) : api.close(id).catch(function () { return null })
        chain.then(function () {
          viewRef.current = createView()
          repaint()
          return startSession()
        })
      }

      /**
       * 切换工作目录：等价于命令行里「退出 pi、cd 到新目录、再启动 pi」。
       * 必须关旧会话 —— 一个 pi 子进程的 cwd 在 spawn 时就定了，改不了。
       */
      var switchDir = function (dir) {
        var target = String(dir).trim()
        if (target === '') return Promise.resolve(null)
        var id = sessionRef.current
        closeStream()
        sessionRef.current = null
        viewRef.current = createView()
        repaint()
        var chain = id === null ? Promise.resolve(null) : api.close(id).catch(function () { return null })
        return chain.then(function () {
          setDrawer(null)
          return startSession(target)
        }).then(function () {
          var current = metaRef.current
          var landed = current !== null && current !== undefined && typeof current.cwd === 'string' ? current.cwd : target
          notice(t('dirSwitched') + ' · ' + landed, 'ok')
          return null
        }, function (failure) {
          notice(String(failure !== null && failure !== undefined && failure.message !== undefined ? failure.message : failure), 'err')
          return null
        })
      }

      var runCompact = function (instructions) {
        var id = sessionRef.current
        if (id === null) return
        var body = { type: 'compact' }
        if (String(instructions).trim() !== '') body.customInstructions = String(instructions).trim()
        notice(t('compacting'), 'info')
        rpc(id, body, 900000).then(function (data) {
          var before = data !== null && data !== undefined && typeof data.tokensBefore === 'number' ? data.tokensBefore : null
          notice(t('compactDone') + (before === null ? '' : ' · ' + String(before) + ' tokens'), 'ok')
          return refreshMessages()
        }, function (failure) {
          notice(String(failure !== null && failure !== undefined && failure.message !== undefined ? failure.message : failure), 'err')
        })
      }

      var runExport = function (path) {
        var id = sessionRef.current
        if (id === null) return
        var target = String(path).trim()
        // pi 的 RPC 面只有 export_html，没有 export jsonl（/export x.jsonl 是 TUI 专属分支）。
        if (/\.jsonl$/i.test(target)) {
          notice('/export ' + target + ' — ' + t('unsupportedDetail'), 'warn')
          return
        }
        var body = { type: 'export_html' }
        if (target !== '') body.outputPath = target
        rpc(id, body, 300000).then(function (data) {
          var file = data !== null && data !== undefined && data.path !== undefined ? String(data.path) : ''
          notice(t('exportDone') + (file === '' ? '' : ': ' + file), 'ok')
        }, function (failure) {
          notice(String(failure !== null && failure !== undefined && failure.message !== undefined ? failure.message : failure), 'err')
        })
      }

      var runCopy = function () {
        var id = sessionRef.current
        if (id === null) return
        rpc(id, { type: 'get_last_assistant_text' }).then(function (data) {
          var text = data !== null && data !== undefined && typeof data.text === 'string' ? data.text : ''
          if (text === '') { notice(t('copyFailed'), 'warn'); return null }
          var clip = typeof navigator === 'undefined' ? undefined : navigator.clipboard
          if (clip === undefined || typeof clip.writeText !== 'function') { notice(t('copyFailed'), 'warn'); return null }
          return clip.writeText(text).then(function () { notice(t('copyDone'), 'ok') }, function () { notice(t('copyFailed'), 'warn') })
        }, function (failure) {
          notice(String(failure !== null && failure !== undefined && failure.message !== undefined ? failure.message : failure), 'err')
        })
      }

      var runSetName = function (name) {
        var id = sessionRef.current
        var value = String(name).trim()
        if (value === '') { setDrawer('name'); return Promise.resolve(null) }
        if (id === null) return Promise.resolve(null)
        return rpc(id, { type: 'set_session_name', name: value }).then(function () {
          setDrawer(null)
          setMeta(function (prev) { return Object.assign({}, prev === null ? {} : prev, { sessionName: value }) })
          notice(t('nameSet') + ': ' + value, 'ok')
          return null
        }, function (failure) {
          notice(String(failure !== null && failure !== undefined && failure.message !== undefined ? failure.message : failure), 'err')
          return null
        })
      }

      var runClone = function () {
        var id = sessionRef.current
        if (id === null) return
        rpc(id, { type: 'clone' }).then(function (data) {
          if (data !== null && data !== undefined && data.cancelled === true) return null
          notice(t('forkDone'), 'ok')
          return reload(id)
        }, function (failure) {
          notice(String(failure !== null && failure !== undefined && failure.message !== undefined ? failure.message : failure), 'err')
        })
      }

      var applyThinkingByName = function (term) {
        var needle = String(term).trim().toLowerCase()
        var match = null
        for (var i = 0; i < levels.length; i += 1) {
          if (String(levels[i]).toLowerCase() === needle) match = levels[i]
        }
        if (match === null) {
          notice(t('thinkingHint') + ': ' + String(term).trim() + ' — ' + t('emptyResult') + ' (' + levels.join(', ') + ')', 'warn')
          setPickerOpen(true)
          return
        }
        setLevel(match)
      }

      var applyModelBySearch = function (term) {
        var id = sessionRef.current
        if (id === null) return
        var needle = String(term).trim().toLowerCase()
        rpc(id, { type: 'get_available_models' }).then(function (data) {
          var list = data !== null && data !== undefined && Array.isArray(data.models) ? data.models : []
          for (var i = 0; i < list.length; i += 1) {
            var model = list[i]
            if (model === null || typeof model !== 'object') continue
            var full = String(model.provider === undefined ? '' : model.provider) + '/' + String(model.id === undefined ? '' : model.id)
            if (full.toLowerCase() === needle || String(model.id === undefined ? '' : model.id).toLowerCase() === needle) {
              pickModel(model)
              return
            }
          }
          setModels(list)
          setPickerOpen(true)
          notice(t('modelHint') + ': ' + String(term).trim() + ' — ' + t('emptyResult'), 'warn')
        }, function (failure) {
          notice(String(failure !== null && failure !== undefined && failure.message !== undefined ? failure.message : failure), 'err')
        })
      }

      // ── 抽屉数据加载 ───────────────────────────────────────────────────────

      /** 打开「模型 + 思考档位」弹层；模型列表每次重拉（可用模型随凭据 / provider 变）。 */
      var openPicker = function () {
        setPickerOpen(true)
        setModelsLoading(true)
        var id = sessionRef.current
        if (id === null) { setModelsLoading(false); return }
        rpc(id, { type: 'get_available_models' }).then(function (data) {
          setModels(data !== null && data !== undefined && Array.isArray(data.models) ? data.models : [])
          setModelsLoading(false)
        }, function () { setModelsLoading(false) })
      }

      /** 左下角模型名的点击：已开就收起（弹层是同一颗按钮开的，再点一下应当关）。 */
      var togglePicker = function () {
        if (pickerOpen === true) { setPickerOpen(false); return }
        openPicker()
      }

      var openTree = function () {
        setDrawer('tree')
        setTree(null)
        var id = sessionRef.current
        if (id === null) return
        rpc(id, { type: 'get_tree' }).then(function (data) {
          setTree({ tree: data !== null && data !== undefined && Array.isArray(data.tree) ? data.tree : [], leafId: data !== null && data !== undefined && data.leafId !== undefined ? data.leafId : null })
        }, function () { setTree({ tree: [], leafId: null }) })
      }

      var openFork = function () {
        setDrawer('fork')
        setForkItems([])
        var id = sessionRef.current
        if (id === null) return
        rpc(id, { type: 'get_fork_messages' }).then(function (data) {
          setForkItems(data !== null && data !== undefined && Array.isArray(data.messages) ? data.messages : [])
        }, function () { setForkItems([]) })
      }

      var openStats = function () {
        setDrawer('stats')
        setStats(null)
        setEntries(null)
        setGuardContext(null)
        var id = sessionRef.current
        if (id === null) return
        rpc(id, { type: 'get_session_stats' }).then(function (data) { setStats(data) }, function () { setStats(null) })
        // 守卫日志是 host 的只读观测面；拿不到就静默不显示，绝不阻塞统计抽屉。
        api.context(id).then(function (body) {
          setGuardContext(body !== null && body !== undefined && body.available === true ? body : null)
        }, function () { setGuardContext(null) })
        rpc(id, { type: 'get_entries' }).then(function (data) { setEntries(data) }, function () { setEntries(null) })
        loadState(id)
      }

      /** 设置开关：四个 set_* 命令都无返回数据，成功后再拉一次 get_state 回填。 */
      var runSetting = function (payload) {
        var id = sessionRef.current
        if (id === null) return
        rpc(id, payload).then(function () {
          return loadState(id)
        }, function (failure) {
          notice(String(failure !== null && failure !== undefined && failure.message !== undefined ? failure.message : failure), 'err')
        })
      }

      var openSettings = function () {
        setDrawer('settings')
        // 规则是设置弹窗里的一节，而且它不依赖会话 —— 即使还没有会话也要拉。
        loadRules()
        // 模态开关同样不依赖会话进程（状态在 host 的 JSON 里），先拉状态；
        // 模型列表要会话（get_available_models），会话不在就只显示状态、不显示模型。
        loadModalities()
        var id = sessionRef.current
        if (id === null) return
        loadState(id)
      }

      /**
       * 读模态开关状态 + 模型清单。
       *
       * 两份数据来自**两个不同的地方**：状态在 host（`GET /modalities`，与 pi 扩展共享的
       * 同一个 JSON），模型清单在 pi 会话（`get_available_models`，带 `input` 声明）。
       * 这里合并，是因为 host 不该持有模型目录 —— 目录是 pi 的知识。
       */
      var loadModalities = function () {
        setModalitiesError(null)
        api.modalities().then(function (body) {
          setModalities(body !== null && typeof body === 'object' ? body : null)
        }, function (failure) {
          setModalities(null)
          setModalitiesError(String(failure !== null && failure !== undefined && failure.message !== undefined ? failure.message : failure))
        })
        var id = sessionRef.current
        if (id === null) return
        rpc(id, { type: 'get_available_models' }).then(function (data) {
          var list = data !== null && data !== undefined && Array.isArray(data.models) ? data.models : []
          setModels(list)
        }, function () {})
      }

      /** 切换某模型某模态。`enabled === null` = 恢复默认。 */
      var setModality = function (model, modality, enabled) {
        var provider = String(model !== null && model !== undefined && model.provider !== undefined ? model.provider : '')
        var id = String(model !== null && model !== undefined && model.id !== undefined ? model.id : '')
        return api.setModality({ provider: provider, id: id, modality: modality, enabled: enabled }).then(function (body) {
          if (body !== null && body !== undefined && body.state !== undefined) {
            setModalities(function (prev) {
              return Object.assign({}, prev === null || prev === undefined ? {} : prev, { state: body.state })
            })
          }
          setModalitiesError(null)
          return body
        }, function (failure) {
          var message = String(failure !== null && failure !== undefined && failure.message !== undefined ? failure.message : failure)
          setModalitiesError(message)
          throw failure
        })
      }

      /**
       * 读规则。不依赖会话、不设超时（host 只读一个小 JSON）。
       *
       * 读失败**保留上一次成功的值**：settings 抽屉开着时点一下重试不该把已经显示的摘要
       * 清成空白（那是「越重试越瘆人」）。首次失败才会是 null + 错误行。
       */
      var loadRules = function () {
        return api.rules().then(function (body) {
          setRules(body !== null && typeof body === 'object' ? body : null)
          setRulesError(null)
          return body
        }, function (failure) {
          var message = String(failure !== null && failure !== undefined && failure.message !== undefined ? failure.message : failure)
          setRulesError(message)
          throw failure
        })
      }

      /**
       * 保存规则。**弹窗关闭与 notice 都由调用方决定**，这里只负责写与同步状态：
       * 失败时把错误抛回去，让 RulesSheet 在弹窗里就地显示（弹窗不能关，否则用户丢内容）。
       */
      var saveRules = function (text) {
        return api.setRules(text).then(function (body) {
          setRules(body !== null && typeof body === 'object' ? body : null)
          setRulesError(null)
          setRulesEpoch(function (value) { return value + 1 })
          notice(t('rulesSaved'), 'ok')
          return body
        })
      }

      /** 恢复默认：走 host 的 /rules/reset（归一与落盘只有一份实现）。 */
      var resetRules = function () {
        return api.resetRules().then(function (body) {
          setRules(body !== null && typeof body === 'object' ? body : null)
          setRulesError(null)
          setRulesEpoch(function (value) { return value + 1 })
          notice(t('rulesResetDone'), 'ok')
          return body
        }, function (failure) {
          notice(String(failure !== null && failure !== undefined && failure.message !== undefined ? failure.message : failure), 'err')
        })
      }

      var openChangelog = function () {
        setDrawer('changelog')
        setSheetText('')
        api.changelog().then(function (body) {
          var text = body !== null && body !== undefined && typeof body.text === 'string' ? body.text : ''
          setSheetText(text)
        }, function () { setSheetText('') })
      }

      /** 切到一条历史会话（等价于命令行 pi 的 /resume 选中某条）。
       *
       * 跨项目切换要处理两件事：
       *  1) 会话自己的 cwd ≠ 子进程 spawn 时的 cwd。pi 的 get_state 不回报 cwd
       *     （rpc-types.ts:96-109），host 在 switch_session 后用会话文件 header 的 cwd
       *     校正 proc.sessionCwd（index.js），snapshot 里带 sessionCwd —— 这里再用列表行
       *     自带的 cwd 兜一层（同一份数据源），保证 meta.sessionCwd 一定是这条会话的目录。
       *  2) 目标目录已被删除时 pi 抛 MissingSessionCwdError，RPC 面没有 cwdOverride 分支
       *     （rpc-mode.ts:624-630 只转调 switchSession），面板只能给出可读提示。
       */
      var pickSession = function (session) {
        var id = sessionRef.current
        if (id === null || session === null || session === undefined) return
        setDrawer(null)
        var targetCwd = typeof session.cwd === 'string' ? session.cwd : ''
        rpc(id, { type: 'switch_session', sessionPath: session.path }).then(function (data) {
          if (data !== null && data !== undefined && data.cancelled === true) return null
          return reload(id).then(function (result) {
            if (targetCwd !== '') {
              setMeta(function (prev) {
                if (prev === null) return prev
                if (String(prev.sessionCwd) === targetCwd) return prev
                return Object.assign({}, prev, { sessionCwd: targetCwd })
              })
            }
            return result
          })
        }, function (failure) {
          var text = String(failure !== null && failure !== undefined && failure.message !== undefined ? failure.message : failure)
          if (text.indexOf('Stored session working directory does not exist') >= 0) {
            var missing = targetCwd
            if (missing === '') {
              var tail = text.replace(/^[\s\S]*?does not exist:\s*/, '')
              missing = tail.split('\n')[0]
            }
            notice(t('sessionCwdMissing').replace('{path}', String(missing)), 'err')
            return null
          }
          notice(text, 'err')
          return null
        })
      }

      var pickFork = function (item) {
        var id = sessionRef.current
        if (id === null || item === null || item === undefined) return
        rpc(id, { type: 'fork', entryId: item.entryId }).then(function (data) {
          setDrawer(null)
          if (data !== null && data !== undefined && data.cancelled === true) return null
          viewRef.current.editorText = data !== null && data !== undefined && typeof data.text === 'string' ? data.text : ''
          repaint()
          notice(t('forkDone'), 'ok')
          return reload(id)
        }, function (failure) {
          notice(String(failure !== null && failure !== undefined && failure.message !== undefined ? failure.message : failure), 'err')
          return null
        })
      }

      var respondUi = function (body) {
        var id = sessionRef.current
        if (id === null) return
        var closeDialog = function () {
          if (sessionRef.current !== id) return
          dropPendingUi(viewRef.current, body.id)
          repaint()
        }
        return api.respond(id, body).then(closeDialog, function (error) {
          // 409 表示宿主已收起这个问题，例如应答已送达但客户端错过了上一次确认。
          if (error !== null && error !== undefined && error.status === 409) { closeDialog(); return }
          throw error
        })
      }

      var consumeEditorText = function () { viewRef.current.editorText = null }

      // ── 输入处理 ───────────────────────────────────────────────────────────

      var searchFiles = function (query) {
        return api.files('', query, 25).then(function (body) {
          var entries = body !== null && body !== undefined && Array.isArray(body.entries) ? body.entries : []
          var items = []
          for (var i = 0; i < entries.length; i += 1) {
            var entry = entries[i]
            if (entry === null || typeof entry !== 'object') continue
            var path = entry.path === undefined ? '' : String(entry.path)
            items.push({
              name: entry.name === undefined ? path : String(entry.name),
              path: path,
              // RPC 模式禁止 @file 参数（main.ts:710），补全只把路径文本插进输入框。
              insert: path,
              side: entry.type === 'dir' ? 'dir' : '',
            })
          }
          return items
        }, function () { return [] })
      }

      var readImage = function (file, sink, done) {
        var reader = new window.FileReader()
        reader.onload = function () {
          var result = typeof reader.result === 'string' ? reader.result : ''
          var comma = result.indexOf(',')
          sink.push({
            name: file.name === undefined ? 'image' : String(file.name),
            mimeType: file.type,
            data: comma >= 0 ? result.slice(comma + 1) : result,
          })
          done()
        }
        reader.onerror = function () { done() }
        reader.readAsDataURL(file)
      }

      var addImages = function (files) {
        var list = files === null || files === undefined ? [] : files
        var added = []
        var pending = 0
        var settle = function () {
          pending -= 1
          if (pending > 0) return
          if (added.length === 0) return
          setImages(function (prev) { return prev.concat(added) })
        }
        for (var i = 0; i < list.length; i += 1) {
          var file = list[i]
          if (file === null || file === undefined || typeof file.type !== 'string' || file.type.indexOf('image/') !== 0) continue
          pending += 1
          readImage(file, added, settle)
        }
      }

      var removeImage = function (index) {
        setImages(function (prev) { return prev.filter(function (item, at) { return at !== index }) })
      }

      var submit = function (text) {
        var parsed = classifyInput(text, contract)
        if (parsed.kind === 'empty') return
        var attached = images.slice()
        setImages([])
        if (parsed.kind === 'bash') { handleBash(parsed); return }
        if (parsed.kind === 'slash') { handleSlash(parsed); return }
        var body = { type: 'prompt', message: parsed.text }
        if (attached.length > 0) {
          body.images = attached.map(function (image) { return { type: 'image', data: image.data, mimeType: image.mimeType } })
        }
        if (parsed.kind !== 'unknown-slash') {
          sendBody(body)
          return
        }
        // 未知斜杠有两种成因，必须分开处理：
        //  ① 面板的命令表过期（pi 在挂载后装了扩展 / 改了 prompt 模板）——重拉一次就能认出；
        //  ② 真的是名字敲错了——照命令行 pi 的行为原样交给 agent（pi 只会拦扩展命令）。
        // 不重拉就直接照发，等于让①静默降级成②：用户明明有这条命令，却看到「未知命令」黄条。
        var sid = sessionRef.current
        var fresh = sid === null ? Promise.resolve(null) : loadCommands(sid)
        fresh.then(function (list) {
          body.message = parsed.name + (parsed.args === '' ? '' : ' ' + parsed.args)
          // 在最新的命令表里：不再提示「未知命令」，但仍按 prompt 发——pi 的
          // agent-session.prompt() 会先过 _tryExecuteExtensionCommand，扩展命令由它执行，
          // prompt 模板 / skill 由它展开。面板不需要（也不该）复制这套语义。
          if (hasDynamic(list, parsed.name) === false) notice(t('notFoundCmd'), 'warn')
          return sendBody(body)
        })
      }

      var handleClientCommand = function (parsed) {
        if (parsed.name === '/settings') { openSettings(); return }
        if (parsed.name === '/scoped-models') { openPicker(); return }
        if (parsed.name === '/session') { openStats(); return }
        if (parsed.name === '/hotkeys') { setDrawer('hotkeys'); return }
        if (parsed.name === '/fork') { openFork(); return }
        if (parsed.name === '/tree') { openTree(); return }
        if (parsed.name === '/resume') { setDrawer('sessions'); return }
        if (parsed.name === '/quit') { endSession(); return }
        notice(parsed.name + ' — ' + t('unsupportedDetail'), 'warn')
      }

      var handleRpcCommand = function (parsed) {
        if (parsed.name === '/model') { if (parsed.args === '') openPicker(); else applyModelBySearch(parsed.args); return }
        if (parsed.name === '/thinking') { if (parsed.args === '') openPicker(); else applyThinkingByName(parsed.args); return }
        if (parsed.name === '/compact') { runCompact(parsed.args); return }
        if (parsed.name === '/export') { runExport(parsed.args); return }
        if (parsed.name === '/copy') { runCopy(); return }
        if (parsed.name === '/name') { if (parsed.args === '') setDrawer('name'); else runSetName(parsed.args); return }
        if (parsed.name === '/clone') { runClone(); return }
        if (parsed.name === '/new') { runNewSession(); return }
        notice(parsed.name + ' — ' + t('unsupportedDetail'), 'warn')
      }

      /**
       * 斜杠命令分发：契约里的 disposition 决定归宿。
       * 面板**绝不**把 /compact 之类当普通消息发给模型（0.2.5 的缺陷），未知命令才照发。
       */
      var handleSlash = function (parsed) {
        if (parsed.disposition === 'cli-only') { notice(parsed.name + ' — ' + t('cliOnlyDetail'), 'warn'); return }
        if (parsed.disposition === 'unsupported') { notice(parsed.name + ' — ' + t('unsupportedDetail'), 'warn'); return }
        if (parsed.disposition === 'local') { openChangelog(); return }
        if (parsed.disposition === 'client') { handleClientCommand(parsed); return }
        handleRpcCommand(parsed)
      }

      // ── 渲染 ───────────────────────────────────────────────────────────────

      var view = viewRef.current
      var state = meta === null ? 'starting' : meta.exit !== null && meta.exit !== undefined ? 'dead' : view.busy === true ? 'busy' : 'ready'
      // 会话自己的目录（不是子进程的 spawn 目录）。跨项目 switch_session 之后两者会不同：
      // host 在 switch_session 成功后用会话文件 header 的 cwd 校正 proc.sessionCwd
      // （index.js 的 readSessionCwd），snapshot 里带 sessionCwd。老 host 没有该字段时回落 cwd。
      var activeCwd = meta === null
        ? ''
        : String(meta.sessionCwd !== undefined && meta.sessionCwd !== null ? meta.sessionCwd : meta.cwd)
      var emptyMeta = meta === null ? null : activeCwd
      var currentModel = meta !== null && meta.model !== null && meta.model !== undefined && typeof meta.model.id === 'string' ? meta.model : null
      var sessionName = meta !== null && typeof meta.sessionName === 'string' && meta.sessionName !== '' ? meta.sessionName : view.title
      // 顶栏标题走项目标题（prefs 重命名优先），无项目时回落品牌名。RuntimeGate 不参与 —— 那个阶段还没有会话。
      var projectTitle = projectTitleOf(prefs, meta)
      var slashEntries = slashItems(contract, dynamic)
      var widgets = []
      for (var widgetKey in view.widgets) {
        if (Object.prototype.hasOwnProperty.call(view.widgets, widgetKey) === false) continue
        var widget = view.widgets[widgetKey]
        widgets.push({ key: widgetKey, lines: Array.isArray(widget.lines) ? widget.lines : [], placement: widget.placement })
      }

      // 顶栏「更多」的两项：压缩上下文、重新连接。两者都是「会打断当前一轮」的动作，
      // 所以菜单只负责选，真正的执行还要过 ConfirmDialog。
      var moreItems = [
        { key: 'compact', label: t('compactNow'), icon: ArchiveIcon, run: function () { setConfirm('compact') } },
        { key: 'reconnect', label: t('reconnect'), icon: RefreshIcon, title: t('reconnectHint'), run: function () { setConfirm('reconnect') } },
      ]
      var pickMore = function (item) {
        setMoreOpen(false)
        item.run()
      }

      // 二次确认的收口：确认之后才真的动手。重新连接会换掉 pi 子进程，压缩会改写会话文件，
      // 两者都不该指望用户「点错了再点回来」。
      var confirmNode = null
      if (confirm === 'compact') {
        confirmNode = h(ConfirmDialog, {
          t: t,
          title: t('confirmCompact'),
          body: t('confirmCompactBody'),
          onCancel: function () { setConfirm(null) },
          onConfirm: function () { setConfirm(null); runCompact('') },
        })
      } else if (confirm === 'reconnect') {
        confirmNode = h(ConfirmDialog, {
          t: t,
          title: t('confirmReconnect'),
          body: t('confirmReconnectBody'),
          onCancel: function () { setConfirm(null) },
          onConfirm: function () { setConfirm(null); endSession() },
        })
      } else if (confirm === 'rulesReset') {
        // 「恢复默认」不可撤销（用户的修改会被替掉），所以走与压缩/重连同一套二次确认。
        confirmNode = h(ConfirmDialog, {
          t: t,
          title: t('rulesResetConfirm'),
          body: t('rulesResetBody'),
          onCancel: function () { setConfirm(null) },
          onConfirm: function () { setConfirm(null); resetRules() },
        })
      }
      var head = h('div', { className: 'superpi-head' },
        h('div', { className: 'superpi-head-main' },
          h(SuperPiIcon, null),
          // 标题 = 当前项目（用户 35984）。title 给完整路径，窄面板里被 ellipsis 截断时还能悬停看全。
          h('span', { className: 'superpi-brand', title: projectTitle === '' ? null : projectTitle }, projectTitle === '' ? t('panelTitle') : projectTitle),
          h('span', { className: 'superpi-dot', 'data-state': state, title: state }),
          sessionName === null || sessionName === '' ? null : h('span', { className: 'superpi-chip', title: t('sessionName') }, String(sessionName))),
        // 模型与推理等级不在这里：它们跟宿主一样落在输入框下沿（见 Composer 的 picker）。
        // 头部的职责是「这是哪个 pi 进程、什么状态」，混进发送相关的开关会让两个区域语义打架。
        h(SelfCheckChip, { t: t, report: verify, onClick: runSelfCheck }),
        h('button', { type: 'button', className: 'superpi-btn superpi-btn-ghost', title: t('stats'), onClick: openStats }, t('stats')),
        h('button', { type: 'button', className: 'superpi-btn superpi-btn-ghost', title: t('sessions'), onClick: function () { setDrawer('sessions') } }, t('sessions')),
        h('button', { type: 'button', className: 'superpi-btn superpi-btn-ghost', title: t('settings'), onClick: openSettings }, t('settings')),
        // 「下一个模型 / 下一个思考档位」两个按钮已删（用户 30427）：顶栏放的是「这是哪个进程、
        // 什么状态」以及不常用的全局动作，切换档位属于 composer 的语义，Ctrl+P / Shift+Tab
        // 两个快捷键照旧保留（见 hotkeyText），按钮只是同一件事的第二种入口，占地方且与
        // 左下角的模型名重复。压缩上下文与重新连接收进「更多」，两者都要二次确认。
        h('span', { className: 'superpi-more-wrap', ref: moreRef },
          h('button', {
            type: 'button',
            className: 'superpi-btn superpi-btn-ghost',
            title: t('moreActions'),
            'aria-haspopup': 'menu',
            'aria-expanded': moreOpen === true ? 'true' : 'false',
            onClick: function () { setMoreOpen(moreOpen !== true) },
          }, h(EllipsisIcon, { size: 16 })),
          moreOpen === true ? h(MoreMenu, { t: t, items: moreItems, anchor: moreRef, onPick: pickMore, onClose: function () { setMoreOpen(false) } }) : null),
        // 「新会话」= 命令行 pi 的 /new：同一个 pi 子进程内换一棵新会话树（保留模型、思考档位、
        // 扩展加载状态），树换完后 reload 重挂数据流。0.3.0 之前这个按钮走 endSession（关掉
        // 子进程再起一个），代价是丢掉进程内一切状态，并且与 /new 的行为不一致 —— 同一件事
        // 有两个入口、两种结果，是 D-03 的实质。换进程的能力单独留成「重连」，它才该被当成
        // 恢复手段（进程卡死、host 侧残留时用）—— 它已收进上方的「更多」，并要过二次确认。
        h('button', { type: 'button', className: 'superpi-btn', title: t('newSessionHint'), onClick: runNewSession }, t('newSession')))

      if (phase === 'loading') {
        return h('div', { className: 'superpi-root' }, h('div', { className: 'superpi-center' }, t('loading')))
      }

      if (phase === 'missing') {
        return h(RuntimeGate, {
          t: t,
          runtime: runtime,
          onRecheck: function () { startSession() },
          onInstalled: function () { startSession() },
        })
      }

      if (phase === 'error') {
        return h('div', { className: 'superpi-root' },
          head,
          h('div', { className: 'superpi-scroll' },
            h('div', { className: 'superpi-inner' },
              h('div', { className: 'superpi-alert' }, String(error)),
              h('div', { className: 'superpi-row2' },
                h('button', { type: 'button', className: 'superpi-btn superpi-btn-primary', onClick: function () { startSession() } }, t('retry')),
                h('button', { type: 'button', className: 'superpi-btn', onClick: function () { startSession() } }, t('reconnect'))))))
      }

      /**
       * 会话已结束（子进程退出，0.16.1）。
       *
       * 为什么必须有这个显式分支：host 现在会把死进程从会话池摘掉（这是修掉
       * 「死会话占满 8 个上限」的正确做法），于是这个会话的 id 不再可用。
       * 若没有这个分支，phase 会落到默认路径、渲染出**一个看起来正常但什么都不能做**
       * 的面板 —— 那正是对抗性审查里点名的「静默失效」：比报错更危险。
       *
       * 三个动作按「最可能有用」排序，且都必须能一次点通：
       *   reconnect = 换一个新子进程（endSession → api.close + startSession）
       *   newSession = 同进程 /new，但进程已死，所以这里同样走 startSession
       * 两者的差别对用户是「要不要保留上下文」，此时已经没有上下文可保留，故并列。
       */
      if (phase === 'ended') {
        return h('div', { className: 'superpi-root' },
          head,
          h('div', { className: 'superpi-scroll' },
            h('div', { className: 'superpi-inner' },
              h('div', { className: 'superpi-alert' }, t('sessionEnded')),
              h('div', { className: 'superpi-notice', 'data-tone': 'warn' }, t('sessionEndedHint')),
              h('div', { className: 'superpi-row2' },
                h('button', { type: 'button', className: 'superpi-btn superpi-btn-primary', onClick: function () { startSession() } }, t('reconnect')),
                h('button', { type: 'button', className: 'superpi-btn', onClick: function () { setDrawer('sessions') } }, t('sessions'))))))
      }

      /**
       * 点文件路径标签之后做什么。
       *
       * 主路径 = DSH 右侧预览区：内置 documentpreview 认领 dsh-resource://file/session/... 地址，
       * markdown / 代码 / 图片都由它渲染，视觉与 DSH 自己的文件引用完全一致。这是唯一正确做法
       * —— 插件里自己造一套预览 UI 只会和宿主不一致。
       *
       * 回落 = 面板内 FileSheet，仅在「当前没有正在显示的会话」「宿主没提供 sidebarRight」
       * 这两种情况下发生，并且必须用 notice 说清原因（静默降级会让用户以为右栏坏了）。
       *
       * 注意 sessionFileAddress 用的是 DSH 会话 ID，不是 pi 的会话 ID：右栏的授权是
       * 按 DSH 会话走的，用错 ID 会以 workspace-file/unknown-workspace 失败。
       */
      var openFile = function (path) {
        var raw = path === undefined || path === null ? '' : String(path)
        if (raw === '') return
        if (typeof props.onOpenFile === 'function' && props.onOpenFile(raw, activeCwd) === true) return
        notice(t('openFileNoSession'), 'warn')
        var target = absolutePathOf(activeCwd, raw)
        var placeholder = { loading: true, path: target, error: null, kind: 'text', mimeType: '', text: '', data: '', size: 0, truncated: false }
        setFileView(placeholder)
        api.file(target).then(function (result) {
          setFileView({
            loading: false,
            path: String(result.path === undefined ? target : result.path),
            error: null,
            kind: String(result.kind === undefined ? 'text' : result.kind),
            mimeType: String(result.mimeType === undefined ? '' : result.mimeType),
            text: result.text === undefined ? '' : String(result.text),
            data: result.data === undefined ? '' : String(result.data),
            size: result.size === undefined ? 0 : result.size,
            truncated: result.truncated === true,
          })
        }, function (failure) {
          var message = failure !== null && failure !== undefined && typeof failure.message === 'string' ? failure.message : String(failure)
          setFileView({
            loading: false,
            path: target,
            error: t('openFileFailed').replace('{path}', raw) + ' · ' + message,
            kind: 'text',
            mimeType: '',
            text: '',
            data: '',
            size: 0,
            truncated: false,
          })
        })
      }

      /**
       * 右键文件标签 → 在系统文件管理器里定位它（host POST /reveal）。
       * 这是唯一一个直接动宿主外壳的动作，失败必须说出来：explorer 被组策略拦掉、
       * 文件已被删都只在这里表现为一条 notice，不静默。
       */
      var revealFile = function (path) {
        var raw = path === undefined || path === null ? '' : String(path)
        if (raw === '') return
        api.reveal(absolutePathOf(activeCwd, raw)).then(function () {
          notice(t('revealFile'), 'ok')
        }, function (failure) {
          var message = failure !== null && failure !== undefined && typeof failure.message === 'string' ? failure.message : String(failure)
          notice(t('revealFileFailed').replace('{path}', raw) + ' · ' + message, 'err')
        })
      }

      // 工具结果按 toolCallId 并进对应的调用行（一次调用 = 一行，输出收在展开区）。
      // pi 把结果作为独立消息送达（另起一条 message_start），所以这里的表是「消息列表的
      // 派生视图」，不是额外状态 —— 刷新历史、整表重建时自动跟着变，不会与 messages 脱节。
      var results = {}
      for (var ri = 0; ri < view.messages.length; ri += 1) {
        var resultMessage = view.messages[ri]
        if (resultMessage.role !== 'toolResult') continue
        if (resultMessage.toolCallId === null) continue
        results[resultMessage.toolCallId] = { text: textOfMessage(resultMessage), isError: resultMessage.isError === true }
      }

      /**
       * 渲染窗口化（0.14.0）。
       *
       * 为什么这么做：面板此前把 `view.messages` 全量 map 成行 —— 一个真实会话 3251 条，
       * 里面有 116 张 `data:` 大图，全部进 DOM 要几百毫秒到数秒，而且每次
       * bash 结束的回拉都会整表重建一次。这就是「一卡好几分钟」的第三个来源。
       *
       * 做法：只渲染尾部 RENDER_WINDOW 条（窗口随「加载更早」增大），更早的由
       * 顶部按钮按 before 往前翻。**不丢能力**：翻到头就是完整历史；
       * 也不破坏滚动锚点：新增的是列表尾部，用户看到的视口内容不变。
       *
       * 为什么不直接上虚拟列表：这个列表的每行高度是内容决定的（展开的工具输出、
       * 图片、markdown），精确测量成本高且容易在流式更新时抖动。分页 + 尾窗
       * 用最少的活动部件解决同一个问题，且与 host 的分页天然对齐。
       */
      var RENDER_WINDOW = 120
      var renderFrom = view.messages.length > RENDER_WINDOW ? view.messages.length - RENDER_WINDOW : 0
      var visibleMessages = renderFrom === 0 ? view.messages : view.messages.slice(renderFrom)
      var earlierNodes = null
      if (view.hasEarlier === true || renderFrom > 0) {
        var hiddenCount = renderFrom + (view.messageTotal > view.messages.length ? view.messageTotal - view.messages.length : 0)
        earlierNodes = h('div', { className: 'superpi-earlier' },
          h('button', {
            type: 'button',
            disabled: view.loadingEarlier === true,
            onClick: function () { loadEarlier() },
          }, view.loadingEarlier === true ? t('sessionsLoading') : t('loadEarlier') + (hiddenCount > 0 ? ' (' + String(hiddenCount) + ')' : '')))
      }

      var rows = visibleMessages.map(function (message, index) {
        var absoluteIndex = renderFrom + index
        return h(MessageRow, {
          key: 'm' + String(message.seq) + '-' + String(absoluteIndex),
          t: t,
          message: message,
          toolStatus: view.toolStatus,
          results: results,
          /**
           * 打开一张图。本轮图片带完整 base64，直接显示；历史图片只有 stubId，
           * 先按需向 host 取回真实像素再显示（0.14.0）。
           *
           * 取图是**点开才发生**的一次请求，失败要给用户看得见的提示 ——
           * 静默失败等于让用户以为图坏了。
           */
          onOpenImage: function (image) {
            if (image !== null && typeof image === 'object' && typeof image.stubId === 'string') {
              var stubId = image.stubId
              setOverlay({ data: '', mimeType: image.mimeType, loading: true })
              var sid = sessionRef.current
              requestJson('/sessions/' + encodeURIComponent(sid) + '/images/' + encodeURIComponent(stubId)).then(function (body) {
                var data = body !== null && typeof body === 'object' && body.ok === true ? body.data : null
                if (data === null) {
                  setOverlay(null)
                  notice(t('imageFailed'), 'err')
                  return
                }
                setOverlay({ data: String(data.data), mimeType: String(data.mimeType === undefined ? image.mimeType : data.mimeType), loading: false })
              }, function () {
                setOverlay(null)
                notice(t('imageFailed'), 'err')
              })
              return
            }
            setOverlay(image)
          },
          // renderFileChip 的 normalizeFileActions 同时接受函数与 {open, reveal}，
          // 这里给对象形态，左键开预览、右键定位文件。
          onOpenFile: { open: openFile, reveal: revealFile },
        })
      })

      // 工作状态行：过程流末尾那条「深度求索中，用时 43分54秒 …」。
      // 它是唯一一处「只在忙的时候存在」的节点 —— 空闲态不占位、不留空行。
      if (view.busy === true) {
        rows = rows.concat([h(WorkingRow, { key: 'working', t: t, since: view.busySince, tool: view.activeTool })])
      }

      var notices = []
      if (error !== null) notices.push(h('div', { key: 'err', className: 'superpi-alert' }, String(error)))
      if (broken === true) notices.push(h('div', { key: 'broken', className: 'superpi-notice', 'data-tone': 'warn' }, t('reconnect')))
      if (view.notice !== null && view.notice !== undefined) {
        var raw = view.notice
        var text = typeof raw === 'string' ? raw : String(raw.text === undefined ? '' : raw.text)
        var detail = typeof raw === 'string' ? '' : String(raw.detail === undefined ? '' : raw.detail)
        var tone = typeof raw === 'string' ? 'err' : String(raw.tone === undefined ? 'warn' : raw.tone)
        notices.push(h('div', { key: 'notice', className: 'superpi-notice', 'data-tone': tone }, detail === '' ? text : text + ' · ' + detail))
      }
      if (view.compacting === true) notices.push(h('div', { key: 'compact', className: 'superpi-notice', 'data-tone': 'warn' }, t('compacting')))
      if (view.retrying === true) notices.push(h('div', { key: 'retry', className: 'superpi-notice', 'data-tone': 'warn' }, t('retrying')))
      /**
       * 契约加载失败 → **必须说出来**（0.17.3）。
       *
       * 契约是畸形判据的唯一输入：它没到，判据就永远返回 `none`，
       * 「本轮未执行」这个提示就不存在。**而用户看不到的东西等于不存在** ——
       * 静默降级与功能没做，对用户是同一件事，但对排查是两件完全不同的事。
       *
       * 用 warn 而不是 error：面板仍可正常对话，丢的只有一项诊断能力。
       */
      if (contractError !== null && contractError !== undefined && contractError !== '') {
        notices.push(h('div', { key: 'contract', className: 'superpi-notice', 'data-tone': 'warn', role: 'status' },
          t('contractFailed') + '：' + String(contractError)))
      }
      // Both live and replayed notices use the verdict produced by the host.
      if (view.verdict !== null && view.verdict !== undefined) {
        notices.push(h(VerdictNotice, {
          key: 'verdict',
          verdict: view.verdict,
          lang: t('verdictLang'),
          retryLabel: t('verdictRetry'),
          detail: t('verdictDetail'),
          busy: view.busy,
          onRetry: continueTurn,
        }))
      }
      for (var n = 0; n < view.notices.length; n += 1) {
        var item = view.notices[n]
        notices.push(h('div', { key: item.id, className: 'superpi-notice', 'data-tone': String(item.tone === undefined ? 'info' : item.tone) }, String(item.text)))
      }

      // 状态栏：扩展 setStatus 的内容（等价于 TUI 底部状态行）。
      // 会话文件不在这里——宿主的 dock 只有用量数字，路径属于「会话统计」抽屉
      // （TextSheet/StatsSheet 里单独一行），塞进 dock 会把数字挤到换行。
      var statusRow = []
      for (var statusKey in view.statuses) {
        if (Object.prototype.hasOwnProperty.call(view.statuses, statusKey) === false) continue
        statusRow.push(h('span', { key: 'st-' + statusKey }, String(view.statuses[statusKey])))
      }
      if (view.queue.steering > 0) statusRow.push(h('span', { key: 'q1' }, String(view.queue.steering) + ' steering'))
      if (view.queue.followUp > 0) statusRow.push(h('span', { key: 'q2' }, String(view.queue.followUp) + ' ' + t('queued')))

      // 统计行 = 宿主的 dock：轮次 / 步数 / tokens / 缓存命中 / 上下文占用。
      // 数据来自 get_session_stats，只在轮次结束时刷新（见 flush 的 settled 分支）——
      // 这些数字在生成过程中不会变，滚动中反复拉取只会给 pi 子进程添无谓的 RPC。
      var dock = []
      if (footerStats !== null && footerStats !== undefined) {
        var turnCount = typeof footerStats.userMessages === 'number' ? footerStats.userMessages : 0
        var stepCount = typeof footerStats.toolCalls === 'number' ? footerStats.toolCalls : 0
        dock.push(h('span', { key: 'd-turns' }, t('footerTurns').replace('{n}', String(turnCount))))
        dock.push(h('span', { key: 'd-steps' }, t('footerSteps').replace('{n}', String(stepCount))))
        var tokenBag = footerStats.tokens !== null && footerStats.tokens !== undefined && typeof footerStats.tokens === 'object' ? footerStats.tokens : null
        if (tokenBag !== null && typeof tokenBag.total === 'number' && tokenBag.total > 0) {
          dock.push(h('span', { key: 'd-tokens' }, t('footerTokens').replace('{n}', fmtCount(tokenBag.total))))
        }
        // 缓存命中率按 pi TUI footer 的同一公式：cacheRead /（input + cacheRead + cacheWrite）。
        var readSum = numOr0(tokenBag === null ? 0 : tokenBag.cacheRead)
        var inSum = numOr0(tokenBag === null ? 0 : tokenBag.input)
        var writeSum = numOr0(tokenBag === null ? 0 : tokenBag.cacheWrite)
        if (readSum + inSum + writeSum > 0) {
          var hitPct = Math.round((readSum / (readSum + inSum + writeSum)) * 100)
          dock.push(h('span', { key: 'd-cache' }, t('footerCache').replace('{pct}', String(hitPct))))
        }
        var usage = footerStats.contextUsage !== null && footerStats.contextUsage !== undefined ? footerStats.contextUsage : null
        if (usage !== null && typeof usage.percent === 'number') {
          dock.push(h('span', { key: 'd-ctx', title: t('contextUsage') + ' · ' + fmtCount(usage.tokens) + ' / ' + fmtCount(usage.contextWindow) }, String(Math.round(usage.percent)) + '%'))
        }
      }

      // 状态文案（steering / 排队 / 会话文件）+ 统计数字合成 composer 的 footer：
      // 同一条行里两套语义，靠中点分隔（宿主的 dock 也是一行）。
      var footerNode = statusRow.length === 0 && dock.length === 0 ? null : h('div', { className: 'superpi-statusbar' },
        statusRow,
        statusRow.length === 0 || dock.length === 0 ? null : h('span', { key: 'd-sep', 'aria-hidden': 'true' }, '·'),
        dock)

      var pending = view.pendingUi.length === 0 ? null : h(ExtensionDialog, {
        key: 'ui-' + String(view.pendingUi[0].id),
        t: t,
        request: view.pendingUi[0],
        onRespond: respondUi,
      })

      var drawerNode = null
      if (drawer === 'sessions') {
        drawerNode = h(SessionsSheet, {
          t: t,
          currentPath: meta === null || meta.sessionFile === undefined ? null : meta.sessionFile,
          prefs: prefs,
          onPrefs: applyPrefs,
          onPick: pickSession,
          onNotice: notice,
          onNewProject: function () { setDrawer('dir') },
          onNewSessionAt: switchDir,
          onClose: function () { setDrawer(null) },
        })
      } else if (drawer === 'tree') {
        drawerNode = h(TreeSheet, {
          t: t,
          tree: tree === null ? [] : tree.tree,
          leafId: tree === null ? null : tree.leafId,
          onClose: function () { setDrawer(null) },
        })
      } else if (drawer === 'fork') {
        drawerNode = h(ForkSheet, { t: t, items: forkItems, onPick: pickFork, onClose: function () { setDrawer(null) } })
      } else if (drawer === 'stats') {
        drawerNode = h(StatsSheet, {
          t: t,
          stats: stats,
          guardContext: guardContext,
          entries: entriesReport,
          state: Object.assign({ cwd: activeCwd }, info === null ? {} : info),
          onClose: function () { setDrawer(null) },
        })
      } else if (drawer === 'settings') {
        drawerNode = h(SettingsSheet, {
          t: t,
          state: Object.assign({}, info === null ? {} : info),
          onClose: function () { setDrawer(null) },
          onAutoCompaction: function (next) { runSetting({ type: 'set_auto_compaction', enabled: next }) },
          onAutoRetry: function (next) { runSetting({ type: 'set_auto_retry', enabled: next }) },
          onSteering: function (mode) { runSetting({ type: 'set_steering_mode', mode: mode }) },
          onFollowUp: function (mode) { runSetting({ type: 'set_follow_up_mode', mode: mode }) },
          rules: rules,
          rulesError: rulesError,
          onEditRules: function () { setDrawer('rules') },
          onResetRules: function () { setConfirm('rulesReset') },
          onLoadRules: function () { loadRules().catch(function () {}) },
          models: models,
          modalities: modalities,
          modalitiesError: modalitiesError,
          onLoadModalities: function () { loadModalities() },
          onToggleModality: function (model, modality, enabled) { setModality(model, modality, enabled).catch(function () {}) },
        })
      } else if (drawer === 'rules') {
        // key 带 rulesEpoch：保存 / 恢复默认之后必须重建弹窗，否则它的 useState
        // 还拿着打开时的初值（React 只在本体变更时重跑 useState）。
        drawerNode = h(RulesSheet, {
          key: 'rules-' + String(rulesEpoch),
          t: t,
          rules: rules,
          error: rulesError,
          onClose: function () { setDrawer('settings') },
          onSave: function (text) {
            return saveRules(text).then(function () { setDrawer('settings') })
          },
        })
      } else if (drawer === 'changelog') {
        drawerNode = h(TextSheet, { t: t, title: 'CHANGELOG', text: sheetText, onClose: function () { setDrawer(null) } })
      } else if (drawer === 'hotkeys') {
        drawerNode = h(TextSheet, { t: t, title: t('commands'), text: hotkeyText(), onClose: function () { setDrawer(null) } })
      } else if (drawer === 'dir') {
        drawerNode = h(DirSheet, {
          t: t,
          startDir: activeCwd === '' ? (runtime !== null && typeof runtime.workspace === 'string' ? runtime.workspace : '') : activeCwd,
          onPick: switchDir,
          onClose: function () { setDrawer(null) },
        })
      } else if (drawer === 'name') {
        drawerNode = h(NameSheet, {
          t: t,
          value: meta === null || meta.sessionName === undefined ? '' : meta.sessionName,
          onSet: runSetName,
          onClose: function () { setDrawer(null) },
        })
      }

      return h('div', { className: 'superpi-root' },
        head,
        h('div', { className: 'superpi-scroll', ref: scrollRef, onScroll: onScroll },
          h('div', { className: 'superpi-inner' },
            notices.length === 0 ? null : notices,
            // 「加载更早」贴在列表顶部：它是唯一能往前翻的入口（0.14.0 窗口化）。
            earlierNodes,
            view.messages.length === 0 ? h(EmptyState, { t: t, meta: emptyMeta, onPickDir: function () { setDrawer('dir') } }) : rows)),
        h(Composer, {
          t: t,
          busy: view.busy === true,
          images: images,
          onRemoveImage: removeImage,
          onSubmit: submit,
          onStop: stop,
          onFollowUp: followUp,
          onDequeue: dequeue,
          onCycleModel: cycleModel,
          onCycleThinking: cycleThinking,
          onImages: addImages,
          onPathsUnavailable: function (count) {
            notice(t('pathUnavailable').replace('{n}', String(count)), 'warn')
          },
          onPickDir: function () { setDrawer('dir') },
          slashEntries: slashEntries,
          editorText: view.editorText,
          widgets: widgets,
          onEditorTextConsumed: consumeEditorText,
          searchFiles: searchFiles,
          // 模型与推理等级以前在 head 里（一行小字 + 原生下拉），现在跟宿主一样落在输入框下沿：
          // 它们影响的是「下一条消息怎么发」，属于 composer 的语义，不属于面板头部。
          model: currentModel,
          thinking: thinking,
          thinkingLevels: levels,
          onSetThinking: setLevel,
          onOpenModels: togglePicker,
          onOpenThinking: togglePicker,
          // 模型 / 思考档位共用同一个向上弹层：开合状态在面板上（受控），Composer 只当锚点。
          pickerOpen: pickerOpen,
          onOpenPicker: togglePicker,
          onClosePicker: function () { setPickerOpen(false) },
          models: models,
          modelsLoading: modelsLoading,
          onPickModel: pickModel,
          onPickThinking: function (level) { setPickerOpen(false); setLevel(level) },
          onOpenSessions: function () { setDrawer('sessions') },
          onOpenStats: openStats,
          onOpenSettings: openSettings,
          onOpenHotkeys: function () { setDrawer('hotkeys') },
          onCompact: function () { setConfirm('compact') },
          onNewSession: runNewSession,
          footer: footerNode,
        }),
        drawerNode,
        // 弹层与确认框都挂在根节点上，盖住面板但不动对话区（不是抽屉，不参与 drawer 状态机）。
        confirmNode,
        pending,
        fileView === null ? null : h(FileSheet, { t: t, view: fileView, onClose: function () { setFileView(null) } }),
        overlay === null ? null : h(ImageOverlay, { image: overlay, onClose: function () { setOverlay(null) } }))
    }

    /** 快捷键说明（/hotkeys 的等价物；宿主的全局快捷键表不在插件可见范围内）。 */
    function hotkeyText() {
      return [
        'Enter — 发送',
        'Shift+Enter — 换行',
        'Alt+Enter — 排队（follow_up）：本次回答结束后再处理',
        'Alt+Q — 把排队消息取回输入框（alt+q / app.message.dequeue）',
        'Ctrl+P — 下一个模型（与 TUI 的 app.model.cycleForward 一致）',
        'Shift+Tab — 下一个思考档位（与 TUI 的 app.thinking.cycle 一致）',
        'Esc — 停止：重试中→取消重试；bash 运行中→中止 bash；生成中→取回排队并中止；否则关补全菜单',
        '/ — 斜杠命令补全',
        '@ — 文件路径补全',
        '! / !! — 直接跑 bash（!! 不进上下文）',
        '↑ / ↓ — 在补全菜单里移动',
        'Tab — 补全当前项',
      ].join('\n')
    }

    // ── 注册 ────────────────────────────────────────────────────────────────
    //
    // 宿主契约：
    //   · sidebar.panellist 注册项的 id 必须与 main 的 key 相同，否则侧栏点了不切面板；
    //   · main 是 root 作用域的 keyed slot；
    //   · slots.inject / locale.register 必须包在 ctx.inject([...]) 里，否则 entry 永久 pending 会卡住 dsh 启动。

    function apply(ctx) {
      var bound = null

      ctx.effect(function () {
        var style = document.createElement('style')
        style.setAttribute('data-plugin', PANEL_ID)
        style.textContent = CSS
        document.head.appendChild(style)
        return function () {
          if (style.parentNode !== null) style.parentNode.removeChild(style)
        }
      }, PANEL_ID + ': styles')

      ctx.inject(['locale'], function (sub) {
        if (!sub.locale) return
        ctx.effect(function () { return sub.locale.register(NS, { zh: ZH, en: EN }) }, PANEL_ID + ': locale')
        var bindable = sub.locale.bind(NS)
        if (bindable) bound = bindable
      })

      var translate = function (key) {
        if (bound !== null) return bound(key)
        return ZH[key] === undefined ? key : ZH[key]
      }

      /**
       * 把「面板里点文件标签」接到 DSH 右侧预览区。
       *
       * 为什么用 ctx.get 而不是写进 exports.inject：
       *   宿主对 inject 声明的服务是硬依赖 —— 任何一个取不到，本插件 entry 会永久停在
       *   pending，直接卡死 dsh 启动。sidebarRight / sessions 是可选增强，必须惰性取，
       *   取不到就返回 false 让面板退到 FileSheet。
       *
       * 为什么地址必须带 DSH 会话 ID：
       *   dsh-resource://file/absolute/... 没有授权会话，读取会以
       *   workspace-file/unknown-workspace 失败；只有 session 作用域会带上 DSH 的
       *   工作区授权。sessionId 取 sidebarRight.mounted —— 就是当前屏幕上那个会话。
       *
       * 返回 true 表示「已经交给右栏」，调用方不要再弹面板内预览。
       */
      var openInSidebar = function (path, cwd) {
        var sidebarRight = null
        try {
          sidebarRight = typeof ctx.get === 'function' ? ctx.get('sidebarRight') : null
        } catch (error) {
          sidebarRight = null
        }
        if (sidebarRight === null || sidebarRight === undefined) return false
        if (typeof sidebarRight.openResource !== 'function') return false
        var mounted = sidebarRight.mounted
        var sessionId = mounted !== null && mounted !== undefined && typeof mounted.getSnapshot === 'function' ? mounted.getSnapshot() : undefined
        if (typeof sessionId !== 'string' || sessionId === '') return false
        var address = sessionFileAddress(sessionId, absolutePathOf(cwd === undefined ? '' : cwd, path))
        try {
          sidebarRight.openResource(address)
        } catch (error) {
          return false
        }
        return true
      }

      ctx.inject(['slots'], function (sub) {
        var slots = sub.slots
        ctx.effect(function () {
          return slots.inject('sidebar.panellist', function () {
            return slots.register({
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 41,
              label: function () { return translate('panelTitle') },
              locale: NS,
            }, function (slotProps) {
              return h(SuperPiIcon, { size: slotProps !== null && slotProps !== undefined && typeof slotProps.size === 'number' ? slotProps.size : 18 })
            })
          })
        }, PANEL_ID + ': sidebar entry')

        ctx.effect(function () {
          return slots.inject('main', function () {
            return slots.register({ name: 'main', key: PANEL_ID, locale: NS }, function (slotProps) {
              return h(SuperPiPanel, {
                t: slotProps !== null && slotProps !== undefined && typeof slotProps.t === 'function' ? slotProps.t : translate,
                onOpenFile: openInSidebar,
              })
            })
          })
        }, PANEL_ID + ': main panel')
      })
    }

    exports.name = NS
    exports.inject = ['slots', 'locale']
    exports.apply = apply
    // 仅供 test/client-render.mjs 与 test/parity.mjs 使用；宿主只读 name / inject / apply。
    exports.__internals = {
      SuperPiPanel: SuperPiPanel,
      Composer: Composer,
      BashBlock: BashBlock,
      ToolBlock: ToolBlock,
      ToolResultRow: ToolResultRow,
      MessageRow: MessageRow,
      WorkingRow: WorkingRow,
      ImageBlock: ImageBlock,
      ThinkingBlock: ThinkingBlock,
      parseToolArgs: parseToolArgs,
      firstLineOf: firstLineOf,
      toolViewOf: toolViewOf,
      primaryToolArg: primaryToolArg,
      procHead: procHead,
      procSummary: procSummary,
      TOOL_VIEWS: TOOL_VIEWS,
      fmtDuration: fmtDuration,
      markBusy: markBusy,
      markIdle: markIdle,
      createView: createView,
      /**
       * 事件摄入层的三个入口（0.16.1 起导出）。
       *
       * 为什么必须导出：0.16.0 的 P0（缓冲事件 100% 丢弃）之所以能活下来，
       * 是因为 `test/client-render.mjs` 只做首帧 SSR，**结构上无法覆盖「事件摄入」**。
       * 不把这三个函数暴露给门禁，「水位会不会吃掉事件」就永远只能靠人肉发现。
       * 宿主只读 name / inject / apply，不碰 __internals。
       */
      applyBatch: applyBatch,
      advanceSeq: advanceSeq,
      hydrateFromSnapshot: hydrateFromSnapshot,
      applyRecord: applyRecord,
      applyExtensionUi: applyExtensionUi,
      pendingUiOf: pendingUiOf,
      addPendingUi: addPendingUi,
      SparkIcon: SparkIcon,
      WhaleTailIcon: WhaleTailIcon,
      TerminalIcon: TerminalIcon,
      ThinkIcon: ThinkIcon,
      SelfCheckChip: SelfCheckChip,
      RuntimeGate: RuntimeGate,
      ExtensionDialog: ExtensionDialog,
      dialogBudgetMs: dialogBudgetMs,
      DirSheet: DirSheet,
      dirPickModel: dirPickModel,
      EmptyState: EmptyState,
      SettingsSheet: SettingsSheet,
      RulesSection: RulesSection,
      ModalitiesSection: ModalitiesSection,
      RulesSheet: RulesSheet,
      SessionsList: SessionsList,
      SessionsSheet: SessionsSheet,
      projectTitleOf: projectTitleOf,
      RenameDialog: RenameDialog,
      pathCrumbs: pathCrumbs,
      buildContract: buildContract,
      messagesFromHistory: messagesFromHistory,
      classifyInput: classifyInput,
      slashItems: slashItems,
      isFilePathToken: isFilePathToken,
      splitFileTokens: splitFileTokens,
      renderFileChip: renderFileChip,
      renderMarkdown: renderMarkdown,
      renderInline: renderInline,
      absolutePathOf: absolutePathOf,
      sessionFileAddress: sessionFileAddress,
      FileSheet: FileSheet,
      fileKindOf: fileKindOf,
      CloseButton: CloseButton,
      CloseIcon: CloseIcon,
      PaperclipIcon: PaperclipIcon,
      PlusIcon: PlusIcon,
      ArrowUpIcon: ArrowUpIcon,
      StopSquareIcon: StopSquareIcon,
      ChevronDownIcon: ChevronDownIcon,
      EllipsisIcon: EllipsisIcon,
      ChevronLeftIcon: ChevronLeftIcon,
      PinIcon: PinIcon,
      AddMenu: AddMenu,
      Sheet: Sheet,
      Dialog: Dialog,
      SidePanel: SidePanel,
      ConfirmDialog: ConfirmDialog,
      MoreMenu: MoreMenu,
      maskHandler: maskHandler,
      isOutsideMenu: isOutsideMenu,
      ModelPicker: ModelPicker,
      VerdictNotice: VerdictNotice,
      fmtCount: fmtCount,
      numOr0: numOr0,
      strings: { zh: ZH, en: EN },
    }

    return module.exports
  },
})








