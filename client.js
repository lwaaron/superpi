// dsh-pi —— 在 DeepSeek Runtime 侧栏里跑 pi 编码代理（client 半区）
//
// 契约（改动前必读，违反会导致宿主启动卡死或面板空白）：
//   1. sidebar.panellist 的 id 必须与 main slot 的 key 相同（都是 'dsh-pi'），否则点侧栏切不过去。
//   2. main 是 root 作用域 keyed slot：register({ name: 'main', key: PANEL_ID })。
//   3. 所有 slots.inject / locale.register 必须包在 ctx.inject([...]) 里，
//      否则 entry 永久 pending，会卡死整个 dsh 启动。
//   4. 客户端 require 白名单只有 react / react-dom / jsx-runtime / @deepseek-ai/dsh-client-ui-primitives，
//      这个文件只 require('react')，不引任何构建产物。
//   5. 样式只用 --dsw-* 变量，类名统一 .dsh-pi- 前缀，避免污染宿主。
//   6. 同源路由用相对路径（不带前导斜杠），插件路由不需要 token。
//   7. 面板与命令行 pi 必须 100% 对齐（见 AGENTS.md / docs/parity.md）。
//      单一真相源是 src/rpc-contract.mjs：host 用 GET /contract 原样下发，面板在挂载时取回并按它
//      分类输入、生成斜杠菜单。**本文件不许硬编码命令表/事件表**，硬编码就必然与 pi 漂移。
//      要加能力：改 src/rpc-contract.mjs（契约）→ 改 UI（消费契约）→ 跑 test/parity.mjs 对账。
/* eslint-disable */
window.__ModuleLoader__.load({
  id: 'dsh-pi',
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

    var NS = 'dsh-pi'
    var PANEL_ID = 'dsh-pi'
    var API_PREFIX = 'api/dsh-pi'

    // ── 文案（zh / en 必须键集一致，test/client-render.mjs 会断言）─────────────
    var ZH = {
      panelTitle: 'pi',
      newSession: '新会话',
      newSessionHint: '新会话（等价于命令行 pi 的 /new：同一进程内换一棵会话树）',
      reconnectHint: '重连（关掉 pi 子进程再起一个；会话记录不丢）',
      sessions: '历史会话',
      sessionsEmpty: '这个目录下还没有历史会话。',
      sessionsLoading: '正在读取会话…',
      sessionsHint: '点击任意一条即可切换过去（等价于命令行 pi 的 /resume）。',
      current: '当前',
      untitled: '未命名会话',
      messages: '条消息',
      retry: '重试',
      stop: '停止',
      send: '发送',
      queue: '排队',
      composerHint: '给 pi 说点什么…  / 唤起命令，! 直接跑 bash，Enter 发送，Shift+Enter 换行',
      emptyTitle: '和 pi 对话',
      emptyHint: '在目录里读写文件、跑命令，整个会话跑在独立子进程里，出问题不会影响 DSH 本体。',
      thinking: '思考',
      workspace: '目录',
      model: '模型',
      busy: '运行中',
      dead: '已结束',
      loading: '正在连接 pi…',
      error: '出错了',
      reconnect: '重新连接',
      tool: '工具',
      result: '结果',
      failed: '失败',
      thinkingLabel: '思考过程',
      tokens: 'tokens',
      crashed: 'pi 子进程已退出',
      synced: '代码已同步',
      syncedHint: '运行时文件与磁盘一致',
      staleCode: '代码有改动未生效',
      staleBuild: '构建产物过期',
      runtimeMissing: '没找到 pi 运行时',
      runtimeMissingHint: '点一下，从公共 npm 装到插件目录里，不需要开命令行。',
      installRuntime: '安装 pi 运行时',
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
      cliOnlyDetail: '这个命令依赖终端界面或进程生命周期，面板里没法等价实现。请在终端里运行 pi 后使用。',
      unsupported: '面板不支持',
      unsupportedDetail: 'pi 的 RPC 协议里没有对应能力，这里不会假装支持。',
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
      extTimeout: '还剩 {n}s 后自动取消',
      notify: '提示',
      steerQueued: '排队中（steer）',
      autoCompact: '自动压缩',
      autoRetry: '自动重试',
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
      treeHint: 'pi 的会话树（只读，与 /tree 一致）',
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
      nextModel: '下一个模型',
      nextThinking: '下一个思考档位',
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
      dirMissing: '目录还不存在，开会话时会自动创建',
      dirSwitched: '已在新工作区开会话',
      dirInputHint: '输入绝对路径后回车',
      dirPickMark: '已选中',
      dirSwitching: '正在切换…',
      allProjects: '全部项目',
      projectsEmpty: '还没有任何已保存的会话。',
      projectsLoading: '正在读取项目…',
      projectsHint: '选择一个项目，再选其中的会话（等价于命令行 pi 的 /resume）。',
      projectSessions: '{n} 个会话',
      tempTag: '临时',
      sessionCwdMissing: '这个会话原来的目录已不存在：{path}。会话文件还在，可用命令行 pi 打开它并选择换一个目录继续。',
    }
    var EN = {
      panelTitle: 'pi',
      newSession: 'New session',
      newSessionHint: 'New session (same as /new: a fresh session tree in the same process)',
      reconnectHint: 'Reconnect (restart the pi child process; the session files stay)',
      sessions: 'Sessions',
      sessionsEmpty: 'No sessions in this directory yet.',
      sessionsLoading: 'Loading sessions…',
      sessionsHint: 'Click one to switch to it (same as /resume in the CLI).',
      current: 'current',
      untitled: 'Untitled session',
      messages: 'messages',
      retry: 'Retry',
      stop: 'Stop',
      send: 'Send',
      queue: 'Queue',
      composerHint: 'Say something to pi…  / for commands, ! for bash, Enter to send, Shift+Enter for newline',
      emptyTitle: 'Talk to pi',
      emptyHint: 'Read and write files, run commands — the whole session runs in its own child process, so it cannot hurt DSH itself.',
      thinking: 'Thinking',
      workspace: 'Workspace',
      model: 'Model',
      busy: 'Running',
      dead: 'Exited',
      loading: 'Connecting to pi…',
      error: 'Something went wrong',
      reconnect: 'Reconnect',
      tool: 'tool',
      result: 'result',
      failed: 'failed',
      thinkingLabel: 'Thinking',
      tokens: 'tokens',
      crashed: 'pi child process exited',
      synced: 'Code in sync',
      syncedHint: 'Runtime files match disk',
      staleCode: 'Code changed but not loaded',
      staleBuild: 'Build artifact is stale',
      runtimeMissing: 'pi runtime not found',
      runtimeMissingHint: 'One click installs it from public npm into the plugin directory — no terminal needed.',
      installRuntime: 'Install pi runtime',
      installing: 'Installing…',
      installFailed: 'Install failed',
      recheck: 'Re-check',
      runtimeReady: 'Runtime ready',
      searchedAt: 'checked',
      refresh: 'Refresh',
      filter: 'Filter',
      slashHint: '↑↓ select · Tab complete · Enter run · Esc close',
      cliOnly: 'CLI only',
      cliOnlyDetail: 'This command needs the terminal UI or process lifecycle; the panel cannot match it. Run pi in a terminal to use it.',
      unsupported: 'Not supported here',
      unsupportedDetail: 'pi RPC exposes no equivalent capability, so the panel will not fake it.',
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
      extTimeout: 'Auto-cancels in {n}s',
      notify: 'Notice',
      steerQueued: 'Queued (steer)',
      autoCompact: 'Auto-compact',
      autoRetry: 'Auto-retry',
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
      treeHint: 'pi session tree (read-only, same as /tree)',
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
      nextModel: 'Next model',
      nextThinking: 'Next thinking level',
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
      dirMissing: 'This directory does not exist yet — it will be created',
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
      sessionCwdMissing: 'The folder this session lived in no longer exists: {path}. The session file is still there — open it with the pi CLI and pick another folder.',
    }

    // ── 样式（只用 --dsw-* 变量；类名统一 .dsh-pi- 前缀）──────────────────────
    var CSS = [
      // ── 基础 ────────────────────────────────────────────────────────────────
      // 只引用 DSH 设计令牌（--dsw-*）；外部变量（--ds-font-family-code / --dsh-*）
      // 一律带兜底。焦点环走 DSH 自己的 --dsw-focus-ring-color 钩子：DSH 默认把它设成
      // transparent（等于不要环），面板在根节点上把它指回 state-business-primary，
      // 这样键盘可达性不打折，且仍由主题决定具体色值。
      '.dsh-pi-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:var(--dsw-font-s-14-font-size);line-height:var(--dsw-font-s-14-line-height);position:relative;--dsw-focus-ring-color:var(--dsw-alias-state-business-primary);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}',
      '.dsh-pi-root *{box-sizing:border-box}',
      '.dsh-pi-root :is(button,input,select,textarea){font-family:inherit}',
      '.dsh-pi-root :is(button,input,select,textarea,summary,a,[tabindex]):focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',

      // ── 头部 ────────────────────────────────────────────────────────────────
      '.dsh-pi-head{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:.5px solid var(--dsw-alias-border-l3);flex:0 0 auto;flex-wrap:wrap}',
      '.dsh-pi-head-main{display:flex;align-items:center;gap:8px;min-width:0;flex:1 1 auto}',
      '.dsh-pi-brand{display:flex;align-items:center;gap:6px;font-size:var(--dsw-font-s-14-font-size);line-height:var(--dsw-font-s-14-line-height);font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.dsh-pi-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:0 0 auto}',
      '.dsh-pi-dot[data-state="ready"]{background:var(--dsw-alias-state-success-primary)}',
      '.dsh-pi-dot[data-state="busy"]{background:var(--dsw-alias-state-business-primary);animation:dsh-pi-pulse 1.2s ease-in-out infinite}',
      '.dsh-pi-dot[data-state="dead"]{background:var(--dsw-alias-state-error-primary)}',
      '@keyframes dsh-pi-pulse{0%,100%{opacity:1}50%{opacity:.35}}',

      // 胶囊标签：对齐 DSH 的 ._tag（radius 999 / padding 1px 8px / 11px / weight 500），
      // tone 语义与 DSH 的 success(10%) / warning(12%) / danger(10%) color-mix 一致。
      '.dsh-pi-chip{display:inline-flex;align-items:center;gap:5px;height:20px;padding:1px 8px;border:0;border-radius:999px;corner-shape:round;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:var(--dsw-font-xxxs-11-font-size);line-height:var(--dsw-font-xxxs-11-line-height);font-weight:500;white-space:nowrap;max-width:220px;overflow:hidden;text-overflow:ellipsis;transition:background-color .16s ease,color .16s ease}',
      '.dsh-pi-chip[data-clickable="1"]{cursor:pointer}',
      '.dsh-pi-chip[data-clickable="1"]:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dsh-pi-chip[data-tone="ok"]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);color:var(--dsw-alias-state-success-primary)}',
      '.dsh-pi-chip[data-tone="warn"]{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);color:var(--dsw-alias-state-warn-primary)}',
      '.dsh-pi-chip[data-tone="err"]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-state-error-primary)}',
      '.dsh-pi-chip-name{overflow:hidden;text-overflow:ellipsis}',

      // 头部下拉（思考档位）：沿用 DSH 输入框的配方（.5px border-l4 + bg-layer-3 + radius-sm）。
      '.dsh-pi-select{height:28px;padding:0 6px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-size:var(--dsw-font-xxs-12-font-size);line-height:var(--dsw-font-xxs-12-line-height);cursor:pointer;transition:border-color .16s ease}',
      '.dsh-pi-select:hover{border-color:var(--dsw-alias-state-business-primary)}',

      // ── 按钮 ────────────────────────────────────────────────────────────────
      // 基线 = DSH ._button + ._sm（28px / radius-sm / 12px）+ ._outline 的 hairline；
      // -ghost 去掉 hairline 与底色，-primary 用 button-primary-fill/hover 令牌。
      '.dsh-pi-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 10px;border:0;border-radius:var(--dsw-radius-sm);box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l4);background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:var(--dsw-font-xxs-12-font-size);line-height:var(--dsw-font-xxs-12-line-height);cursor:pointer;white-space:nowrap;transition:background-color .16s ease,color .16s ease,box-shadow .16s ease}',
      '.dsh-pi-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-pi-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}',
      '.dsh-pi-btn:disabled{opacity:.4;cursor:not-allowed}',
      '.dsh-pi-btn-primary{box-shadow:none;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);padding:0 14px}',
      '.dsh-pi-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);color:var(--dsw-alias-label-primary-foreground)}',
      '.dsh-pi-btn-primary:active:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
      '.dsh-pi-btn-danger{box-shadow:none;color:var(--dsw-alias-state-error-primary)}',
      '.dsh-pi-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}',
      '.dsh-pi-btn-ghost{box-shadow:none;background:transparent;color:var(--dsw-alias-label-secondary)}',
      '.dsh-pi-btn-ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dsh-pi-btn-icon{width:28px;padding:0}',
      '.dsh-pi-btn svg{width:15px;height:15px}',

      // ── 消息流 ──────────────────────────────────────────────────────────────
      '.dsh-pi-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden}',
      '.dsh-pi-inner{display:flex;flex-direction:column;gap:16px;padding:16px 16px 20px}',
      '.dsh-pi-row{display:flex;gap:8px;min-width:0}',
      '.dsh-pi-row-user{justify-content:flex-end}',
      // 用户气泡 = DSH ._bubble（specific-bubble / radius-xl / 10px 16px / 内容字号可调）
      '.dsh-pi-bubble-user{max-width:82%;padding:10px 16px;border:0;border-radius:var(--dsw-radius-xl);background:var(--dsw-specific-bubble);color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size,var(--dsw-font-s-14-font-size));line-height:calc(22px + var(--dsh-content-font-delta,0px));white-space:pre-wrap;word-break:break-word}',
      '.dsh-pi-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:8px}',
      // 正文 = DSH markdown base（14px/24px，可用 --dsh-content-font-* 缩放）
      '.dsh-pi-prose{font-size:var(--dsh-content-font-size,var(--dsw-font-s-14-font-size));line-height:calc(24px + var(--dsh-content-font-delta,0px));word-break:break-word}',
      '.dsh-pi-prose p{margin:0 0 8px}',
      '.dsh-pi-prose p:last-child{margin-bottom:0}',
      '.dsh-pi-prose ul{margin:0 0 8px;padding-left:20px}',
      '.dsh-pi-prose h3{margin:16px 0 8px;font:var(--dsw-font-markdown-h3)}',
      '.dsh-pi-prose strong{font-weight:600}',
      '.dsh-pi-code-inline{padding:1px 4px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-markdown-inline-code);font:var(--dsw-font-markdown-code-block-small);color:var(--dsw-alias-label-primary)}',
      // 代码块 = DSH ._card / ._header / ._body 三段（banner + body，无边框）
      '.dsh-pi-fence{margin:16px 0;overflow:hidden;border:0;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-markdown-code-block);font:var(--dsw-font-markdown-code-block)}',
      '.dsh-pi-fence-lang{padding:10px 18px 8px 22px;border-bottom:0;background:var(--dsw-alias-markdown-code-block-banner);color:var(--dsw-alias-label-secondary);font-size:var(--dsw-font-xxxs-11-font-size);line-height:18px;font-family:var(--dsw-font-family)}',
      '.dsh-pi-pre{margin:0;padding:6px 22px 20px;overflow-x:auto;font:var(--dsw-font-markdown-code-block);color:var(--dsw-alias-label-primary)}',
      '.dsh-pi-think{border-left:2px solid var(--dsw-alias-border-l3);padding-left:10px;color:var(--dsw-alias-label-tertiary);font-size:var(--dsw-font-xs-13-font-size);line-height:var(--dsw-font-xs-13-line-height)}',
      '.dsh-pi-think summary{cursor:pointer;user-select:none;list-style:none;color:var(--dsw-alias-label-tertiary);padding:2px 0}',
      '.dsh-pi-think summary:hover{color:var(--dsw-alias-label-secondary)}',
      '.dsh-pi-think summary::-webkit-details-marker{display:none}',
      '.dsh-pi-think-body{margin-top:6px;white-space:pre-wrap;word-break:break-word;line-height:calc(22px + var(--dsh-content-font-delta,0px))}',

      // 工具行：过程流里的一次工具调用 / 一次工具结果（含 ! 的 bash 结果）。
      //
      // 这里是「行」不是「卡」：一次任务常常连着十几次工具调用，每行都套圆角框 + hairline
      // 会形成框套框的噪音墙（用户 18994 明确要求去掉圆角框）。DSH 自己的过程流也是平铺行：
      // 只有箭头 + 名称 + 状态，靠行距分组，展开后才出现内容区。
      // 展开区沿用 .dsh-pi-think 的左侧竖线语言，让「附着在一条消息下的补充信息」看起来是一类东西。
      '.dsh-pi-tool{border:0;border-radius:0;background:transparent;box-shadow:none}',
      '.dsh-pi-tool-head{display:flex;align-items:center;gap:8px;padding:3px 0;cursor:pointer;list-style:none;font-size:var(--dsw-font-xxs-12-font-size);line-height:var(--dsw-font-xxs-12-line-height);color:var(--dsw-alias-label-secondary)}',
      // 悬停只提亮文字，不铺底色 —— 铺底色会在没有外框时露出一块矩形色斑。
      '.dsh-pi-tool-head:hover{color:var(--dsw-alias-label-primary)}',
      '.dsh-pi-tool-head:hover .dsh-pi-tool-name{color:var(--dsw-alias-label-primary)}',
      '.dsh-pi-tool-head::-webkit-details-marker{display:none}',
      '.dsh-pi-tool-head::before{content:"\\25B8";color:var(--dsw-alias-label-dimmed);font-size:10px;line-height:1;transition:transform .16s ease}',
      '.dsh-pi-tool[open]>.dsh-pi-tool-head::before{transform:rotate(90deg)}',
      '.dsh-pi-tool-name{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-pi-tool-body{margin:4px 0 0;padding:0 0 0 14px;border-top:0;border-left:1px solid var(--dsw-alias-border-l3);max-height:340px;overflow:auto;font-size:var(--dsw-font-xxxs-11-font-size);line-height:18px;white-space:pre-wrap;word-break:break-word;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);color:var(--dsw-alias-label-secondary)}',

      // 状态标签 = DSH ._tag 的四种 tone（run/success/warning/danger）
      '.dsh-pi-tag{display:inline-flex;align-items:center;height:17px;padding:1px 8px;border:0;border-radius:999px;corner-shape:round;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:var(--dsw-font-xxxs-11-font-size);line-height:var(--dsw-font-xxxs-11-line-height);font-weight:500;white-space:nowrap}',
      '.dsh-pi-tag[data-tone="run"]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent);color:var(--dsw-alias-state-business-primary)}',
      '.dsh-pi-tag[data-tone="ok"]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);color:var(--dsw-alias-state-success-primary)}',
      '.dsh-pi-tag[data-tone="err"]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-state-error-primary)}',
      '.dsh-pi-tag[data-tone="warn"]{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);color:var(--dsw-alias-state-warn-primary)}',
      '.dsh-pi-usage{margin-top:2px;font-size:var(--dsw-font-xxxs-11-font-size);line-height:var(--dsw-font-xxxs-11-line-height);color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums}',
      '.dsh-pi-caret{display:inline-block;width:6px;height:14px;margin-left:2px;background:var(--dsw-alias-label-secondary);animation:dsh-pi-pulse 1s steps(2) infinite;vertical-align:text-bottom}',
      '.dsh-pi-img{max-width:min(100%,360px);max-height:240px;border:0;border-radius:var(--dsw-radius-md);cursor:zoom-in;display:block}',
      '.dsh-pi-img-open{position:fixed;inset:0;z-index:60;background:var(--dsw-alias-bg-mask-photo);display:flex;align-items:center;justify-content:center;padding:40px;cursor:zoom-out}',
      '.dsh-pi-img-open img{max-width:100%;max-height:100%;border-radius:var(--dsw-radius-md)}',

      // ── 空态 / 运行时引导 ───────────────────────────────────────────────────
      '.dsh-pi-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:48px 24px;text-align:center;color:var(--dsw-alias-label-secondary);flex:1 1 auto}',
      '.dsh-pi-empty h2{margin:4px 0 0;font:var(--dsw-font-base-strong-16);color:var(--dsw-alias-label-primary)}',
      '.dsh-pi-empty p{margin:0;max-width:420px;font-size:var(--dsw-font-s-14-font-size);line-height:var(--dsw-font-s-14-line-height);color:var(--dsw-alias-label-secondary)}',
      '.dsh-pi-empty-meta{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:var(--dsw-font-xxs-12-font-size);line-height:var(--dsw-font-xxs-12-line-height);color:var(--dsw-alias-label-caption);word-break:break-all}',
      '.dsh-pi-empty-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:4px}',
      '.dsh-pi-center{flex:1 1 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:32px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-pi-gate{flex:1 1 auto;display:flex;align-items:center;justify-content:center;padding:24px}',
      '.dsh-pi-gate-card{max-width:520px;width:100%;display:flex;flex-direction:column;gap:10px;padding:20px;border:0;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-panel)}',
      '.dsh-pi-gate-card h3{margin:0;font:var(--dsw-font-base-strong-16)}',
      '.dsh-pi-gate-actions{display:flex;gap:8px;flex-wrap:wrap}',
      '.dsh-pi-gate-path{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:var(--dsw-font-xxxs-11-font-size);line-height:18px;color:var(--dsw-alias-label-tertiary);word-break:break-all}',
      '.dsh-pi-gate-searched{display:flex;flex-direction:column;gap:2px;font-size:var(--dsw-font-xxxs-11-font-size);line-height:18px;color:var(--dsw-alias-label-dimmed)}',

      // ── 输入区 ──────────────────────────────────────────────────────────────
      '.dsh-pi-composer{flex:0 0 auto;background:var(--dsw-alias-bg-base);padding:8px 12px 12px;position:relative}',
      '.dsh-pi-composer-inner{display:flex;flex-direction:column;gap:6px}',
      '.dsh-pi-box{position:relative;display:flex;flex-direction:column;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);transition:border-color .16s ease}',
      '.dsh-pi-box:focus-within{border-color:var(--dsw-alias-state-business-primary)}',
      '.dsh-pi-box[data-focus="1"]{border-color:var(--dsw-alias-state-business-primary)}',
      '.dsh-pi-widget{display:flex;flex-direction:column;gap:2px}',
      '.dsh-pi-widget-body{margin:0;padding:6px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:var(--dsw-font-xxxs-11-font-size);line-height:18px;white-space:pre-wrap;word-break:break-word;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);max-height:120px;overflow:auto}',
      '.dsh-pi-statusbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:4px 2px 0;font-size:var(--dsw-font-xxxs-11-font-size);line-height:18px;color:var(--dsw-alias-label-caption)}',
      '.dsh-pi-statusbar span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:240px}',
      '.dsh-pi-ta{width:100%;min-height:52px;max-height:220px;resize:none;border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary);padding:10px 14px 4px;font-family:inherit;font-size:var(--dsw-font-s-14-font-size);line-height:calc(22px + var(--dsh-content-font-delta,0px))}',
      '.dsh-pi-ta::placeholder{color:var(--dsw-alias-label-dimmed)}',
      '.dsh-pi-bar{display:flex;align-items:center;gap:6px;padding:4px 8px 6px 10px}',
      '.dsh-pi-bar-hint{flex:1 1 auto;min-width:0;font-size:var(--dsw-font-xxxs-11-font-size);line-height:18px;color:var(--dsw-alias-label-caption);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-pi-thumbs{display:flex;flex-wrap:wrap;gap:6px;padding:8px 10px 0}',
      '.dsh-pi-thumb{position:relative;width:52px;height:52px;border-radius:var(--dsw-radius-sm);overflow:hidden;box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l3)}',
      '.dsh-pi-thumb img{width:100%;height:100%;object-fit:cover;display:block}',
      '.dsh-pi-thumb-x{position:absolute;top:2px;right:2px;width:16px;height:16px;line-height:16px;text-align:center;border:0;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-mask-1);color:var(--dsw-static-neutral-bluish-00);font-size:11px;cursor:pointer;padding:0}',
      '.dsh-pi-thumb-x:hover{background:var(--dsw-alias-bg-mask-2)}',

      // 弹出菜单 = DSH ._list（padding 4 / radius-lg / specific-menu / 毛玻璃 / elevation-panel）
      '.dsh-pi-menu{position:absolute;left:0;right:0;bottom:calc(100% + 4px);z-index:20;display:flex;flex-direction:column;max-height:min(46vh,360px);overflow:hidden;padding:4px;border:0;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);box-shadow:var(--dsw-elevation-panel);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1)}',
      '.dsh-pi-menu-head{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:0;font-size:var(--dsw-font-xxxs-11-font-size);line-height:var(--dsw-font-xxxs-11-line-height);color:var(--dsw-alias-label-tertiary)}',
      '.dsh-pi-menu-list{overflow-y:auto;min-height:0;padding:0}',
      '.dsh-pi-item{display:flex;align-items:center;gap:6px;width:100%;min-height:34px;padding:6px 8px;border:0;border-radius:var(--dsw-radius-md);background:transparent;cursor:pointer;font-size:var(--dsw-font-xs-13-font-size);line-height:var(--dsw-font-xs-13-line-height);color:var(--dsw-alias-label-primary);text-align:left}',
      '.dsh-pi-item[data-active="1"]{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-pi-item[data-disabled="1"]{opacity:.4;cursor:not-allowed}',
      '.dsh-pi-item-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:0}',
      '.dsh-pi-item-name{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-pi-item-desc{font-size:var(--dsw-font-xxxs-11-font-size);line-height:var(--dsw-font-xxxs-11-line-height);color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-pi-item-side{flex:0 0 auto;font-size:var(--dsw-font-xxxs-11-font-size);line-height:var(--dsw-font-xxxs-11-line-height);color:var(--dsw-alias-label-caption)}',
      '.dsh-pi-empty-row{padding:12px;text-align:center;color:var(--dsw-alias-label-dimmed);font-size:var(--dsw-font-xxs-12-font-size);line-height:var(--dsw-font-xxs-12-line-height)}',

      // ── 提示 ────────────────────────────────────────────────────────────────
      '.dsh-pi-alert{padding:8px 12px;border:0;border-radius:var(--dsw-radius-sm);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-state-error-primary);font-size:var(--dsw-font-xxs-12-font-size);line-height:var(--dsw-font-xxs-12-line-height);white-space:pre-wrap;word-break:break-word}',
      '.dsh-pi-notice{padding:8px 12px;border:0;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:var(--dsw-font-xxs-12-font-size);line-height:var(--dsw-font-xxs-12-line-height)}',
      '.dsh-pi-notice[data-tone="err"]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-state-error-primary)}',
      '.dsh-pi-notice[data-tone="warn"]{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);color:var(--dsw-alias-state-warn-primary)}',
      '.dsh-pi-notice[data-tone="ok"]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);color:var(--dsw-alias-state-success-primary)}',
      '.dsh-pi-queue{display:flex;align-items:center;gap:8px;font-size:var(--dsw-font-xxxs-11-font-size);line-height:18px;color:var(--dsw-alias-label-tertiary)}',

      // ── 抽屉 ────────────────────────────────────────────────────────────────
      // DSH ._float 的配方：bg-layer-2 + radius-panel + elevation-prominent + 局部描边色。
      '.dsh-pi-sheet{position:absolute;inset:0;z-index:30;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base)}',
      '.dsh-pi-sheet-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:.5px solid var(--dsw-alias-border-l2);flex:0 0 auto}',
      '.dsh-pi-sheet-title{flex:1 1 auto;min-width:0;font:var(--dsw-font-base-strong-16);color:var(--dsw-alias-label-primary)}',
      '.dsh-pi-search{height:28px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:var(--dsw-font-xxs-12-font-size);line-height:var(--dsw-font-xxs-12-line-height);outline:0;min-width:0;transition:border-color .16s ease}',
      '.dsh-pi-search:focus{border-color:var(--dsw-alias-state-business-primary)}',
      '.dsh-pi-search::placeholder{color:var(--dsw-alias-label-dimmed)}',
      '.dsh-pi-sheet-body{flex:1 1 auto;min-height:0;overflow-y:auto;padding:12px 14px 16px;display:flex;flex-direction:column;gap:8px}',
      // 项目层与会话层共用一套行视觉（.dsh-pi-proj 只是语义钩子，样式与 .dsh-pi-sess 完全一致）。
      '.dsh-pi-sess,.dsh-pi-proj{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border:0;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l2);cursor:pointer;transition:background-color .16s ease,box-shadow .16s ease}',
      '.dsh-pi-sess:hover,.dsh-pi-proj:hover{background:var(--dsw-alias-bg-layer-2);box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l4)}',
      '.dsh-pi-sess[data-current="1"],.dsh-pi-proj[data-current="1"]{box-shadow:inset 0 0 0 .5px var(--dsw-alias-state-business-primary)}',
      '.dsh-pi-proj[data-temporary="1"] .dsh-pi-sess-title{color:var(--dsw-alias-label-secondary)}',
      '.dsh-pi-sess-top{display:flex;align-items:center;gap:6px;font-size:var(--dsw-font-xxs-12-font-size);line-height:var(--dsw-font-xxs-12-line-height);color:var(--dsw-alias-label-secondary)}',
      '.dsh-pi-sess-title{flex:1 1 auto;min-width:0;font-weight:500;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-pi-sess-line{font-size:var(--dsw-font-xxs-12-font-size);line-height:var(--dsw-font-xxs-12-line-height);color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-pi-mono{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:var(--dsw-font-xxxs-11-font-size);line-height:18px;color:var(--dsw-alias-label-tertiary);word-break:break-all}',
      '.dsh-pi-kv{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:var(--dsw-font-xxs-12-font-size);line-height:var(--dsw-font-xxs-12-line-height)}',
      '.dsh-pi-kv-k{color:var(--dsw-alias-label-tertiary)}',
      '.dsh-pi-kv-v{color:var(--dsw-alias-label-primary);word-break:break-word;font-variant-numeric:tabular-nums}',
      '.dsh-pi-tree{display:flex;flex-direction:column;gap:1px;font-size:var(--dsw-font-xxs-12-font-size);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace)}',
      '.dsh-pi-tree-node{display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:var(--dsw-radius-sm);cursor:default}',
      '.dsh-pi-tree-node[data-clickable="1"]{cursor:pointer}',
      '.dsh-pi-tree-node[data-clickable="1"]:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-pi-tree-node[data-leaf="1"]{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-pi-tree-kind{flex:0 0 auto;color:var(--dsw-alias-label-caption);font-size:var(--dsw-font-xxxs-11-font-size);min-width:56px}',
      '.dsh-pi-tree-text{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary)}',

      // 开关 = DSH ._switch（36x20 胶囊 + 20px 滑块 + aria-checked 驱动）
      '.dsh-pi-switch{position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:999px;corner-shape:round;background:var(--dsw-alias-border-l3);cursor:pointer;transition:background-color .16s ease}',
      '.dsh-pi-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary)}',
      '.dsh-pi-switch:disabled{cursor:default;opacity:.5}',
      '.dsh-pi-switch-thumb{display:block;width:16px;height:16px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-label-primary-foreground);transition:transform .12s ease}',
      '.dsh-pi-switch[aria-checked="false"] .dsh-pi-switch-thumb{background:var(--dsw-alias-switch-thumb)}',
      '.dsh-pi-switch[aria-checked="true"] .dsh-pi-switch-thumb{transform:translate(16px)}',
      '.dsh-pi-switch-row{display:grid;grid-template-columns:1fr auto;align-items:center;gap:12px}',
      '.dsh-pi-switch-label{font-size:var(--dsw-font-s-14-font-size);line-height:var(--dsw-font-s-14-line-height);color:var(--dsw-alias-label-primary)}',

      // ── 工作目录选择（DirSheet）────────────────────────────────────────────
      // 对齐 DSH directory-picker：头部面包屑 + 可编辑路径，主体左「层级」右「子项」两栏。
      '.dsh-pi-dir{display:flex;flex-direction:column;gap:8px;flex:1 1 auto;min-height:0}',
      '.dsh-pi-dir-crumbs{display:flex;align-items:center;gap:2px;flex-wrap:wrap;min-height:20px}',
      '.dsh-pi-dir-crumb{padding:1px 6px;border:0;border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:var(--dsw-font-xxs-12-font-size);line-height:18px;cursor:pointer}',
      '.dsh-pi-dir-crumb:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dsh-pi-dir-crumb[data-last="1"]{color:var(--dsw-alias-label-primary);font-weight:500}',
      '.dsh-pi-dir-sep{color:var(--dsw-alias-label-dimmed);font-size:var(--dsw-font-xxs-12-font-size);line-height:18px}',
      '.dsh-pi-dir-cols{display:flex;gap:1px;flex:1 1 auto;min-height:240px;overflow:hidden;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1)}',
      '.dsh-pi-dir-col{display:flex;flex-direction:column;min-width:0;flex:1 1 0;overflow-y:auto;padding:4px}',
      '.dsh-pi-dir-col+.dsh-pi-dir-col{border-left:.5px solid var(--dsw-alias-border-l2)}',
      '.dsh-pi-dir-item{display:flex;align-items:center;gap:6px;width:100%;min-height:30px;padding:4px 8px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:var(--dsw-font-xs-13-font-size);line-height:var(--dsw-font-xs-13-line-height);text-align:left;cursor:pointer}',
      '.dsh-pi-dir-item:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-pi-dir-item[data-selected="1"]{background:var(--dsw-alias-interactive-bg-active)}',
      '.dsh-pi-dir-item[data-current="1"]{color:var(--dsw-alias-state-business-primary)}',
      '.dsh-pi-dir-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-pi-dir-mark{flex:0 0 auto;color:var(--dsw-alias-state-business-primary);font-size:var(--dsw-font-xxxs-11-font-size)}',
      '.dsh-pi-dir-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dsh-pi-dir-hint{flex:0 0 auto;min-width:0;font-size:var(--dsw-font-xxxs-11-font-size);line-height:18px;color:var(--dsw-alias-label-caption);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-pi-dir-target{flex:1 1 auto;min-width:0;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:var(--dsw-font-xxxs-11-font-size);line-height:18px;color:var(--dsw-alias-label-caption);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      // 弹窗外壳：对齐 DSH directory-picker 的 680x500，用 .dsh-pi-dialog-wrap 提供的遮罩层居中。
      // 高度固定（而不是靠内容撑）是刻意的：Miller 两栏切换时列表高度必须稳定，
      // 否则用户点中一个目录、第二栏冒出来，整个弹窗会跳一下。
      '.dsh-pi-dir-dialog{display:flex;flex-direction:column;width:min(680px,100%);height:min(500px,100%);overflow:hidden;border:0;border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);animation:dsh-pi-modal-in .16s ease-in-out}',
      '.dsh-pi-dir-head{display:flex;align-items:center;gap:8px;flex:0 0 auto;padding:14px 16px 10px 20px}',
      '.dsh-pi-dir-title{flex:1 1 auto;min-width:0;font:var(--dsw-font-base-strong-16);color:var(--dsw-alias-label-primary)}',
      '.dsh-pi-dir-dialog .dsh-pi-dir{flex:1 1 auto;min-height:0;padding:0 20px 16px}',

      // ── 对话框 ──────────────────────────────────────────────────────────────
      // 对齐 DSH ._dialog：radius-panel + bg-layer-2 + elevation-prominent +
      // header(padding 22px 14px 12px 24px) / body / footer(24px) 三段留白。
      '.dsh-pi-dialog-wrap{position:absolute;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-mask-1);padding:20px}',
      '.dsh-pi-dialog{display:flex;flex-direction:column;width:min(440px,100%);max-height:100%;overflow:hidden;border:0;border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);animation:dsh-pi-modal-in .16s ease-in-out}',
      '@keyframes dsh-pi-modal-in{0%{opacity:0}to{opacity:1}}',
      '.dsh-pi-dialog h3{margin:0;padding:22px 24px 0;font:var(--dsw-font-base-strong-16);color:var(--dsw-alias-label-primary)}',
      '.dsh-pi-dialog .dsh-pi-mono{margin:6px 24px 0}',
      '.dsh-pi-dialog-msg{margin:0;padding:10px 24px 0;color:var(--dsw-alias-label-secondary);font-size:var(--dsh-content-font-size,var(--dsw-font-s-14-font-size));line-height:calc(22px + var(--dsh-content-font-delta,0px));white-space:pre-wrap;word-break:break-word}',
      '.dsh-pi-dialog-body{display:flex;flex-direction:column;gap:6px;min-height:0;overflow-y:auto;padding:14px 24px 0}',
      '.dsh-pi-dialog-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;padding:22px 24px 24px}',
      '.dsh-pi-opt{display:flex;align-items:center;gap:8px;width:100%;min-height:34px;padding:6px 10px;border:0;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:var(--dsw-font-xs-13-font-size);line-height:var(--dsw-font-xs-13-line-height);text-align:left;cursor:pointer;transition:background-color .16s ease,box-shadow .16s ease}',
      '.dsh-pi-opt:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-pi-opt[data-active="1"]{box-shadow:inset 0 0 0 .5px var(--dsw-alias-state-business-primary)}',
      '.dsh-pi-mini-ta{width:100%;min-height:84px;max-height:180px;padding:6px 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);resize:vertical;outline:0;transition:border-color .16s ease}',
      '.dsh-pi-mini-ta:focus{border-color:var(--dsw-alias-state-business-primary)}',
      '.dsh-pi-row2{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dsh-pi-spacer{flex:1 1 auto}',
      '.dsh-pi-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}',

      // ── 动效偏好 ────────────────────────────────────────────────────────────
      '@media (prefers-reduced-motion: reduce){.dsh-pi-root *,.dsh-pi-root *::before,.dsh-pi-root *::after{animation-duration:.01ms !important;animation-iteration-count:1 !important;transition-duration:.01ms !important}}',
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
      reset: function (id) { return requestJson('/sessions/' + encodeURIComponent(id) + '/reset', { method: 'POST', body: {}, timeoutMs: 20000 }) },
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
      directories: function (dir, query, limit) {
        var parts = ['limit=' + String(typeof limit === 'number' ? limit : 200)]
        if (typeof dir === 'string' && dir !== '') parts.push('dir=' + encodeURIComponent(dir))
        if (typeof query === 'string' && query !== '') parts.push('query=' + encodeURIComponent(query))
        return requestJson('/directories?' + parts.join('&'))
      },
      changelog: function () { return requestJson('/pi/changelog') },
      selfcheck: function () { return requestJson('/selfcheck') },
      runtime: function () { return requestJson('/runtime') },
      install: function () { return requestJson('/runtime/install', { method: 'POST', body: {}, timeoutMs: 900000 }) },
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
        next.push(makeMessage(raw, next.length))
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

    // ── 极简 markdown（无依赖，绝不拼 HTML 字符串）───────────────────────────

    var FENCE = /^\x60\x60\x60(\S*)\s*$/
    var INLINE = /(\x60[^\x60]+\x60)|(\*\*[^*]+\*\*)/g

    function renderInline(text, prefix) {
      var nodes = []
      var last = 0
      var match = null
      var index = 0
      INLINE.lastIndex = 0
      while ((match = INLINE.exec(text)) !== null) {
        if (match.index > last) nodes.push(text.slice(last, match.index))
        if (match[1] !== undefined) nodes.push(h('code', { key: prefix + '-c' + String(index), className: 'dsh-pi-code-inline' }, match[1].slice(1, -1)))
        else nodes.push(h('strong', { key: prefix + '-b' + String(index) }, match[2].slice(2, -2)))
        index += 1
        last = INLINE.lastIndex
      }
      if (last < text.length) nodes.push(text.slice(last))
      return nodes
    }

    function renderMarkdown(text) {
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
        blocks.push(h('p', { key: 'p' + String(key) }, renderInline(body, 'p' + String(key))))
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
          blocks.push(h('div', { key: 'f' + String(key), className: 'dsh-pi-fence' },
            lang === '' ? null : h('div', { className: 'dsh-pi-fence-lang' }, lang),
            h('pre', { className: 'dsh-pi-pre' }, h('code', null, code.join('\n')))))
          key += 1
          continue
        }
        if (/^#{1,6}\s+/.test(lines[i])) {
          flush()
          blocks.push(h('h3', { key: 'h' + String(key) }, renderInline(lines[i].replace(/^#{1,6}\s+/, ''), 'h' + String(key))))
          key += 1
          i += 1
          continue
        }
        if (/^\s*[-*]\s+/.test(lines[i])) {
          flush()
          var items = []
          while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
            items.push(h('li', { key: 'li' + String(items.length) }, renderInline(lines[i].replace(/^\s*[-*]\s+/, ''), 'li' + String(key) + '-' + String(items.length))))
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

    function createView() {
      return {
        messages: [],
        lastSeq: 0,
        openIndex: -1,
        streamingIndex: -1,
        busy: false,
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
        receivedAt: Date.now(),
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

      if (type === 'agent_start') { view.busy = true; view.lastError = null; return }
      if (type === 'turn_start') { view.busy = true; return }
      if (type === 'turn_end') {
        // 一轮结束：关掉流式指针，但 busy 不归零（agent 可能还有后续轮次）。
        view.openIndex = -1
        view.streamingIndex = -1
        return
      }
      if (type === 'agent_end') {
        // agent 主循环结束。pi 会在此之后 flush _pendingBashMessages（不进事件流），
        // PiPanel 收到 agent_settled 后会重拉 snapshot 把 bash 气泡补上。
        view.openIndex = -1
        view.streamingIndex = -1
        return
      }
      if (type === 'agent_settled') {
        view.busy = false
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
        return
      }
      if (type === 'tool_execution_start') {
        view.toolStatus[String(record.toolCallId)] = { status: 'running', name: String(record.toolName === undefined ? '' : record.toolName), partial: '' }
        return
      }
      if (type === 'tool_execution_update') { applyToolUpdate(view, record); return }
      if (type === 'tool_execution_end') {
        var id = String(record.toolCallId)
        view.toolStatus[id] = {
          status: record.isError === true ? 'error' : 'done',
          name: String(record.toolName === undefined ? '' : record.toolName),
          partial: view.toolStatus[id] === undefined ? '' : view.toolStatus[id].partial,
        }
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

    function applyBatch(view, entries) {
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


    // ── 基础组件 ────────────────────────────────────────────────────────────

    function PiIcon(props) {
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

    /** 目录图标（与 PiIcon 同一描边风格，用 currentColor，不引入图片资源）。 */
    function DirIcon(props) {
      var size = props !== null && props !== undefined && typeof props.size === 'number' ? props.size : 15
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
        style: { flex: '0 0 auto' },
      },
        h('path', { d: 'M3 7.5a1.5 1.5 0 0 1 1.5-1.5h4l2 2.5h8A1.5 1.5 0 0 1 20 10v7.5a1.5 1.5 0 0 1-1.5 1.5h-14A1.5 1.5 0 0 1 3 17.5z' }))
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

    function ThinkingBlock(props) {
      if (props.text === '') return null
      return h('details', { className: 'dsh-pi-think' },
        h('summary', null, props.t('thinkingLabel')),
        h('div', { className: 'dsh-pi-think-body' }, props.text))
    }

    function ToolBlock(props) {
      var tone = props.status === 'running' ? 'run' : props.status === 'error' ? 'err' : props.status === 'done' ? 'ok' : ''
      var label = props.status === 'running' ? props.t('busy') : props.status === 'error' ? props.t('failed') : props.status === 'done' ? props.t('result') : ''
      var body = props.argsText === '' ? '{}' : props.argsText
      if (typeof props.partial === 'string' && props.partial !== '') body = body + '\n\n── live ──\n' + props.partial
      return h('details', { className: 'dsh-pi-tool' },
        h('summary', { className: 'dsh-pi-tool-head' },
          h('span', { className: 'dsh-pi-tag' }, props.t('tool')),
          h('span', { className: 'dsh-pi-tool-name' }, props.name),
          label === '' ? null : h('span', { className: 'dsh-pi-tag', 'data-tone': tone }, label)),
        h('pre', { className: 'dsh-pi-tool-body' }, body))
    }

    function ToolResultRow(props) {
      var message = props.message
      var text = textOfMessage(message)
      return h('div', { className: 'dsh-pi-row', 'data-role': 'toolResult' },
        h('div', { className: 'dsh-pi-body' },
          h('details', { className: 'dsh-pi-tool' },
            h('summary', { className: 'dsh-pi-tool-head' },
              h('span', { className: 'dsh-pi-tag', 'data-tone': message.isError ? 'err' : 'ok' }, message.isError ? props.t('failed') : props.t('result')),
              h('span', { className: 'dsh-pi-tool-name' }, message.toolName === null ? '' : message.toolName)),
            h('pre', { className: 'dsh-pi-tool-body' }, text === '' ? '{}' : text))))
    }

    function usageLine(usage, t) {
      if (usage === null || typeof usage !== 'object') return null
      var parts = []
      if (typeof usage.input === 'number') parts.push('in ' + String(usage.input))
      if (typeof usage.output === 'number') parts.push('out ' + String(usage.output))
      if (typeof usage.cacheRead === 'number' && usage.cacheRead > 0) parts.push('cache ' + String(usage.cacheRead))
      if (typeof usage.totalTokens === 'number') parts.push(String(usage.totalTokens) + ' ' + t('tokens'))
      if (parts.length === 0) return null
      return h('div', { className: 'dsh-pi-usage' }, parts.join(' · '))
    }

    /** 图片块：pi 把图片以 base64 交给模型，面板必须同样显示，不能降级成 "[image png]" 文字。 */
    function ImageBlock(props) {
      var open = props.onOpen
      return h('img', {
        className: 'dsh-pi-img',
        alt: props.mimeType,
        src: 'data:' + String(props.mimeType) + ';base64,' + String(props.data),
        onClick: function () { if (open !== undefined) open({ data: props.data, mimeType: props.mimeType }) },
      })
    }

    function MessageRow(props) {
      var message = props.message
      var t = props.t
      var nodes = []
      var i = 0
      if (message.role === 'user') {
        var userText = textOfMessage(message)
        var userImages = message.blocks.filter(function (block) { return block.type === 'image' })
        return h('div', { className: 'dsh-pi-row dsh-pi-row-user' },
          h('div', { className: 'dsh-pi-bubble-user' },
            userImages.length === 0 ? null : h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: userText === '' ? '0' : '6px' } },
              userImages.map(function (block, index) { return h(ImageBlock, { key: 'ui' + String(index), data: block.data, mimeType: block.mimeType, onOpen: props.onOpenImage }) })),
            userText === '' ? null : userText))
      }
      if (message.role === 'toolResult') return h(ToolResultRow, { message: message, t: t })
      if (message.role === 'bashExecution') {
        return h('div', { className: 'dsh-pi-row' }, h('div', { className: 'dsh-pi-body' }, h(BashBlock, { t: t, message: message })))
      }
      if (message.role !== 'assistant') return null
      for (i = 0; i < message.blocks.length; i += 1) {
        var block = message.blocks[i]
        if (block.type === 'thinking') nodes.push(h(ThinkingBlock, { key: 'k' + String(i), t: t, text: block.text }))
        else if (block.type === 'toolCall') {
          var entry = block.id === null ? undefined : props.toolStatus[block.id]
          nodes.push(h(ToolBlock, {
            key: 'k' + String(i),
            t: t,
            name: block.name,
            argsText: block.argsText,
            status: entry === undefined ? '' : entry.status,
            partial: entry === undefined ? '' : entry.partial,
          }))
        } else if (block.type === 'image') {
          nodes.push(h(ImageBlock, { key: 'k' + String(i), data: block.data, mimeType: block.mimeType, onOpen: props.onOpenImage }))
        } else if (block.type === 'text' && block.text.trim() !== '') {
          nodes.push(h('div', { key: 'k' + String(i), className: 'dsh-pi-prose' }, renderMarkdown(block.text)))
        }
      }
      if (message.streaming) nodes.push(h('span', { key: 'caret', className: 'dsh-pi-caret' }))
      if (message.stopReason === 'error') nodes.push(h('div', { key: 'stop', className: 'dsh-pi-alert' }, t('error')))
      nodes.push(h('div', { key: 'usage' }, usageLine(message.usage, t)))
      return h('div', { className: 'dsh-pi-row' }, h('div', { className: 'dsh-pi-body' }, nodes))
    }

    /**
     * 空态：pi 还没有任何消息时显示。
     * cwd 之后给一个「选择工作区」入口 —— 这是用户在 DSH 里第一次用 pi 时
     * 最想做的事（默认 ~/pi-workspace 不一定是他要的目录），也是 TUI 里
     * 「新建工作目录」的等价物。
     */
    function EmptyState(props) {
      var actions = typeof props.onPickDir !== 'function' ? null : h('div', { className: 'dsh-pi-empty-actions' },
        h('button', { type: 'button', className: 'dsh-pi-btn', title: props.t('dirTitle'), onClick: props.onPickDir },
          h(DirIcon, { size: 14 }),
          h('span', null, props.t('pickDir'))))
      return h('div', { className: 'dsh-pi-empty' },
        h(PiIcon, { size: 30 }),
        h('h2', null, props.t('emptyTitle')),
        h('p', null, props.t('emptyHint')),
        props.meta === null ? null : h('div', { className: 'dsh-pi-empty-meta' }, props.meta),
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
      return h('div', { className: 'dsh-pi-menu' },
        h('div', { className: 'dsh-pi-menu-head' }, props.title),
        h('div', { className: 'dsh-pi-menu-list' },
          items.map(function (item, index) {
            return h('div', {
              key: item.key,
              className: 'dsh-pi-item',
              'data-active': index === active ? 'true' : 'false',
              onMouseDown: function (event) { event.preventDefault(); props.onPick(item) },
              onMouseEnter: function () { props.onHover(index) },
            },
              h('div', { className: 'dsh-pi-item-main' },
                h('div', { className: 'dsh-pi-item-name' }, item.name),
                item.desc === '' ? null : h('div', { className: 'dsh-pi-item-desc' }, item.desc)),
              item.side === '' ? null : h('div', { className: 'dsh-pi-item-side', 'data-tone': item.tone === undefined ? '' : item.tone }, item.side))
          })))
    }

    /**
     * Composer：所有输入的必经之路。
     *
     * 三种提交形态（与 TUI 的 setupEditorSubmitHandler 一一对应）：
     *   1. 斜杠命令 → 由 PiPanel.handleSlash 决定走 RPC 还是面板 UI，**绝不把 /compact 当 prompt 发出去**
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

      function onPaste(event) {
        var data = event.clipboardData
        if (data === null || data === undefined || data.items === undefined) return
        var picked = []
        for (var i = 0; i < data.items.length; i += 1) {
          var item = data.items[i]
          if (item.kind === 'file' && item.type.indexOf('image/') === 0) {
            var file = item.getAsFile()
            if (file !== null) picked.push(file)
          }
        }
        if (picked.length === 0) return
        event.preventDefault()
        props.onImages(picked)
      }

      function pickImage() {
        var input = document.createElement('input')
        input.type = 'file'
        input.accept = 'image/*'
        input.multiple = true
        input.onchange = function () {
          var picked = []
          for (var i = 0; i < input.files.length; i += 1) picked.push(input.files[i])
          if (picked.length > 0) props.onImages(picked)
        }
        input.click()
      }

      var placeholder = t('composerHint')
      var busy = props.busy
      var canSend = text.trim() !== '' || props.images.length > 0
      return h('div', { className: 'dsh-pi-composer' },
        h('div', { className: 'dsh-pi-composer-inner' },
          props.widgets.length === 0 ? null : h('div', { className: 'dsh-pi-widget' },
            props.widgets.map(function (widget, index) { return h('pre', { key: 'w' + String(index), className: 'dsh-pi-widget-body' }, widget.lines.join('\n')) })),
          h('div', { className: 'dsh-pi-box' },
            props.images.length === 0 ? null : h('div', { className: 'dsh-pi-thumbs' },
              props.images.map(function (image, index) {
                return h('div', { key: 't' + String(index), className: 'dsh-pi-thumb' },
                  h('img', { alt: image.name, src: 'data:' + image.mimeType + ';base64,' + image.data }),
                  h('button', { type: 'button', className: 'dsh-pi-thumb-x', title: t('imageRemove'), onClick: function () { props.onRemoveImage(index) } }, '×'))
              })),
            h('textarea', {
              ref: taRef,
              className: 'dsh-pi-ta',
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
            h('div', { className: 'dsh-pi-bar' },
              h('button', { type: 'button', className: 'dsh-pi-btn dsh-pi-btn-ghost', title: t('pickDir'), onClick: props.onPickDir }, h(DirIcon, { size: 14 })),
              h('button', { type: 'button', className: 'dsh-pi-btn dsh-pi-btn-ghost', title: t('attachImage'), onClick: pickImage }, h(PiIcon, { size: 14 })),
              busy ? h('button', { type: 'button', className: 'dsh-pi-btn dsh-pi-btn-ghost', title: t('followUpSend'), onClick: function () { if (text.trim() !== '') { var queued = text; setText(''); setMenu(null); props.onFollowUp(queued) } } }, t('followUpSend')) : null,
              busy ? h('button', { type: 'button', className: 'dsh-pi-btn dsh-pi-btn-danger', onClick: props.onStop }, t('stop')) : null,
              h('span', { className: 'dsh-pi-bar-hint' }, busy ? t('steerHint') : t('slashHint')),
              h('span', { className: 'dsh-pi-spacer' }),
              h('button', {
                type: 'button',
                className: 'dsh-pi-btn dsh-pi-btn-primary',
                disabled: canSend === false,
                onClick: submit,
              }, busy ? t('queue') : t('send')))),
          h('div', { className: 'dsh-pi-sr' }, placeholder)))
    }


    // ── 抽屉（历史会话 / 树 / fork / 统计 / 设置 / changelog）────────────────

    /** 所有抽屉共用外壳：标题栏 + 关闭，body 负责滚动。 */
    function Sheet(props) {
      return h('div', { className: 'dsh-pi-sheet', role: 'dialog', 'aria-label': props.title },
        h('div', { className: 'dsh-pi-sheet-head' },
          h('div', { className: 'dsh-pi-sheet-title' }, props.title),
          props.actions === undefined ? null : props.actions,
          h('button', { type: 'button', className: 'dsh-pi-btn dsh-pi-btn-ghost', onClick: props.onClose, title: props.t('close') }, '×')),
        h('div', { className: 'dsh-pi-sheet-body' }, props.children))
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
     */
    function SessionsList(props) {
      var t = props.t
      var level = props.level
      var project = props.project
      var info = props.info
      var query = props.query

      var needle = query.trim().toLowerCase()
      var isProjects = level === 'projects'
      var rows = []

      if (isProjects) {
        var projects = info.projects
        if (needle !== '') {
          projects = projects.filter(function (entry) {
            return (String(entry.displayPath) + ' ' + String(entry.cwd)).toLowerCase().indexOf(needle) >= 0
          })
        }
        rows = projects.map(function (entry) {
          return h('div', {
            key: 'p-' + String(entry.key),
            className: 'dsh-pi-proj',
            'data-current': entry.isCurrent === true ? '1' : '0',
            'data-temporary': entry.isTemporary === true ? '1' : '0',
            onClick: function () { props.onOpenProject(entry) },
          },
            h('div', { className: 'dsh-pi-sess-top' },
              h('div', { className: 'dsh-pi-sess-title' }, entry.displayPath === '' ? String(entry.cwd) : String(entry.displayPath)),
              entry.isCurrent === true ? h('span', { className: 'dsh-pi-tag', 'data-tone': 'ok' }, t('current')) : null,
              entry.isTemporary === true ? h('span', { className: 'dsh-pi-tag', 'data-tone': 'warn' }, t('tempTag')) : null,
              h('span', null, t('projectSessions').replace('{n}', String(entry.sessionCount)))),
            h('div', { className: 'dsh-pi-mono' }, fmtTime(entry.lastActivity) + ' · ' + String(entry.cwd)))
        })
      } else {
        var sessions = info.sessions
        if (needle !== '') {
          sessions = sessions.filter(function (session) {
            var haystack = [session.name, session.firstMessage, session.lastMessage, session.path].join(' ').toLowerCase()
            return haystack.indexOf(needle) >= 0
          })
        }
        rows = sessions.map(function (session) {
          var current = props.currentPath !== null && props.currentPath === session.path
          return h('div', {
            key: session.path,
            className: 'dsh-pi-sess',
            'data-current': current ? '1' : '0',
            onClick: function () { props.onPick(session) },
          },
            h('div', { className: 'dsh-pi-sess-top' },
              h('div', { className: 'dsh-pi-sess-title' }, session.name === undefined || session.name === '' ? (session.lastMessage || t('untitled')) : session.name),
              current ? h('span', { className: 'dsh-pi-tag', 'data-tone': 'ok' }, t('current')) : null,
              h('span', null, String(session.messageCount) + ' ' + t('messages'))),
            h('div', { className: 'dsh-pi-sess-line' }, session.lastMessage === '' ? t('untitled') : session.lastMessage),
            h('div', { className: 'dsh-pi-mono' }, fmtTime(session.modified) + ' · ' + session.path))
        })
      }

      var title = isProjects ? t('sessions') : String(project === null ? '' : (project.displayPath === '' ? project.cwd : project.displayPath))
      var actions = []
      actions.push(h('input', {
        key: 'q',
        className: 'dsh-pi-search',
        value: query,
        placeholder: t('filter'),
        onChange: function (event) { props.onQuery(event.target.value) },
      }))
      if (isProjects === false) {
        actions.push(h('button', {
          key: 'back',
          type: 'button',
          className: 'dsh-pi-btn dsh-pi-btn-ghost',
          onClick: function () { props.onBack() },
        }, '← ' + t('allProjects')))
      }

      var emptyText = isProjects ? t('projectsEmpty') : t('sessionsEmpty')
      var hintText = isProjects ? t('projectsHint') : t('sessionsHint')
      var loadingText = isProjects ? t('projectsLoading') : t('sessionsLoading')

      return h(Sheet, { t: t, title: title, onClose: props.onClose, actions: actions },
        info.loading ? h('div', { className: 'dsh-pi-empty-row' }, loadingText) : null,
        info.error === null ? null : h('div', { className: 'dsh-pi-alert' }, info.error),
        info.loading === false && info.error === null && rows.length === 0 ? h('div', { className: 'dsh-pi-empty-row' }, emptyText) : null,
        h('div', { className: 'dsh-pi-sess-line' }, hintText),
        rows)
    }

    /**
     * 抽屉的**容器**：只管「现在在哪一层、要哪个 cwd 的数据」，把取数结果交给无状态视图。
     * 之所以拆成 SessionsSheet（容器）+ SessionsList（纯渲染），是因为两级抽屉的渲染分支
     * 全靠 host 返回的数据决定，把取数写在渲染里就只能靠真浏览器验证；拆开之后
     * client-render 可以直接喂假数据断言项目层／会话层两套 DOM，倒计时类断言仍归真浏览器。
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
          setInfo({ loading: false, error: String(error !== null && error !== undefined && error.message !== undefined ? error.message : error), projects: [], sessions: [], total: 0 })
        })
        return function () { stopped = true }
      }, [openCwd])

      return h(SessionsList, {
        t: t,
        level: level,
        project: project,
        info: info,
        query: query,
        currentPath: props.currentPath,
        onQuery: function (next) { setQuery(next) },
        onOpenProject: function (entry) { setProject(entry); setQuery(''); setLevel('sessions') },
        onBack: function () { setQuery(''); setProject(null); setLevel('projects') },
        onPick: props.onPick,
        onClose: props.onClose,
      })
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
      body.push(h('div', { key: 'crumbs', className: 'dsh-pi-dir-crumbs' }, (function () {
        var nodes = []
        for (var i = 0; i < crumbs.length; i += 1) {
          if (i > 0) nodes.push(h('span', { key: 'sep' + String(i), className: 'dsh-pi-dir-sep' }, '›'))
          var crumb = crumbs[i]
          var isLast = i === crumbs.length - 1
          nodes.push(h('button', {
            key: 'c' + String(i),
            type: 'button',
            className: 'dsh-pi-dir-crumb',
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
      body.push(h('div', { key: 'typed', className: 'dsh-pi-row2' },
        h('input', {
          className: 'dsh-pi-search',
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
          className: 'dsh-pi-search',
          style: { width: '160px', flex: '0 0 auto' },
          value: query,
          placeholder: t('filter'),
          onChange: function (event) { setQuery(event.target.value) },
        })))
      body.push(h('div', { key: 'hint', className: 'dsh-pi-dir-hint' },
        rootsView === true ? t('dirPickDrive') : (listing.writable === true ? t('dirHint') : t('dirNotWritable'))))

      var makeRow = function (item, currentPath, activePath, markable) {
        var target = String(item.path === undefined ? '' : item.path)
        var active = target !== '' && target === String(activePath)
        return h('button', {
          type: 'button',
          className: 'dsh-pi-dir-item',
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
          h('span', { className: 'dsh-pi-dir-name' }, String(item.name === undefined ? '' : item.name)),
          markable === true && active ? h('span', { className: 'dsh-pi-dir-mark' }, t('dirPickMark')) : null)
      }

      var rows = []
      if (rootsView === true) {
        // 「此电脑」层：第一行退回刚才浏览的层级（列表已经拿在手里，不必再请求）。
        if (listing.dir !== '') {
          rows.push(h('button', {
            key: 'back',
            type: 'button',
            className: 'dsh-pi-dir-item',
            title: listing.dir,
            onClick: function () { setDeep(null); setSelected(null); setRootsView(false) },
          }, h(DirIcon, { size: 14 }), h('span', { className: 'dsh-pi-dir-name' }, '..  ' + t('dirUp'))))
        }
        for (var r = 0; r < mainEntries.length; r += 1) {
          var drive = mainEntries[r]
          var drivePath = String(drive.path === undefined ? '' : drive.path)
          var driveActive = drivePath !== '' && drivePath === String(selected)
          rows.push(h('button', {
            key: 'root' + String(r),
            type: 'button',
            className: 'dsh-pi-dir-item',
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
            h('span', { className: 'dsh-pi-dir-name' }, String(drive.name === undefined ? '' : drive.name)),
            driveActive ? h('span', { className: 'dsh-pi-dir-mark' }, t('dirPickMark')) : null))
        }
      }
      if (rootsView !== true && listing.parent !== null && listing.parent !== undefined) {
        rows.push(h('button', {
          key: 'up',
          type: 'button',
          className: 'dsh-pi-dir-item',
          title: String(listing.parent),
          onClick: function () { setDeep(null); enter(String(listing.parent)) },
        }, h(DirIcon, { size: 14 }), h('span', { className: 'dsh-pi-dir-name' }, '..  ' + t('dirUp'))))
      }
      if (rootsView !== true && listing.roots.length > 0) {
        // 「此电脑」入口：切到盘符列表。放在「上一级 / 主目录」之后、子目录之前，
        // 与资源管理器里「此电脑」和层级导航同组的直觉一致。
        rows.push(h('button', {
          key: 'pc',
          type: 'button',
          className: 'dsh-pi-dir-item',
          'data-pc': '1',
          title: t('dirThisPc'),
          onClick: function () { setDeep(null); setSelected(null); setRootsView(true) },
        }, h(DriveIcon, { size: 14 }), h('span', { className: 'dsh-pi-dir-name' }, t('dirThisPc'))))
      }
      if (rootsView !== true && listing.home !== '' && listing.home !== listing.dir) {
        rows.push(h('button', {
          key: 'home',
          type: 'button',
          className: 'dsh-pi-dir-item',
          title: listing.home,
          onClick: function () { setDeep(null); enter(listing.home) },
        }, h(DirIcon, { size: 14 }), h('span', { className: 'dsh-pi-dir-name' }, '~  ' + t('dirHome'))))
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
      if (listing.loading === true) listBody = [h('div', { key: 'ld', className: 'dsh-pi-empty-row' }, t('dirLoading'))]
      else if (listing.error !== null) listBody = [h('div', { key: 'er', className: 'dsh-pi-alert' }, String(listing.error))]
      else if (rows.length === 0) listBody = [h('div', { key: 'em', className: 'dsh-pi-empty-row' }, t('dirEmpty'))]

      var cols = [h('div', { key: 'col0', className: 'dsh-pi-dir-col' }, listBody)]
      if (model.showSub === true) {
        var subRows = []
        for (var j = 0; j < subEntries.length; j += 1) {
          subRows.push(h('span', { key: 's' + String(j), style: { display: 'contents' } }, makeRow(subEntries[j], currentCwd, deep, true)))
        }
        var subBody = subRows
        if (sub.loading === true) subBody = [h('div', { key: 'sld', className: 'dsh-pi-empty-row' }, t('dirLoading'))]
        else if (sub.error !== null) subBody = [h('div', { key: 'ser', className: 'dsh-pi-alert' }, String(sub.error))]
        else if (subRows.length === 0) subBody = [h('div', { key: 'sem', className: 'dsh-pi-empty-row' }, t('dirEmpty'))]
        cols.push(h('div', { key: 'col1', className: 'dsh-pi-dir-col' }, subBody))
      }

      body.push(h('div', { key: 'cols', className: 'dsh-pi-dir-cols' }, cols))

      // 「此电脑」层未选盘时 target 为 null：脚注留空、按钮禁用，避免把上一层的目录当成本层目标。
      var targetDir = model.target === null || model.target === undefined ? '' : String(model.target)
      var canAccept = targetDir !== '' && busy !== true && listing.loading !== true
      body.push(h('div', { key: 'foot', className: 'dsh-pi-dir-foot' },
        h('span', { key: 'target', className: 'dsh-pi-dir-target', title: targetDir }, targetDir),
        h('span', { className: 'dsh-pi-spacer' }),
        h('button', {
          type: 'button',
          className: 'dsh-pi-btn dsh-pi-btn-primary',
          disabled: canAccept !== true,
          onClick: function () { accept() },
        }, busy === true ? t('dirSwitching') : t('dirHere'))))

      // 居中弹窗（不是整块抽屉）：选择工作区是一次会打断当前会话的决策，
      // 用模态把面板其余部分压暗，用户不会误以为还能一边聊天一边挑目录。
      // 尺寸对齐 DSH directory-picker 的 680x500。
      return h('div', { className: 'dsh-pi-dialog-wrap' },
        h('div', {
          className: 'dsh-pi-dir-dialog',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': t('dirTitle'),
        },
          h('div', { className: 'dsh-pi-dir-head' },
            h('div', { className: 'dsh-pi-dir-title' }, t('dirTitle')),
            h('button', { type: 'button', className: 'dsh-pi-btn dsh-pi-btn-ghost', title: t('close'), onClick: props.onClose }, '×')),
          h('div', { className: 'dsh-pi-dir' }, body)))
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
        h('div', { className: 'dsh-pi-sess-line' }, t('treeHint')),
        rows.length === 0 ? h('div', { className: 'dsh-pi-empty-row' }, t('treeEmpty')) : null,
        h('div', { className: 'dsh-pi-tree' }, rows.map(function (row, index) {
          var entry = row.node.entry === undefined ? {} : row.node.entry
          var isLeaf = entry.id !== undefined && entry.id === props.leafId
          var label = entry.type === 'message' && entry.message !== undefined
            ? entry.message.role + ': ' + textOfMessage(makeMessage(entry.message, 0)).slice(0, 120)
            : String(entry.type === undefined ? '' : entry.type) + (typeof entry.name === 'string' ? ' · ' + entry.name : '')
          return h('div', {
            key: 'n' + String(index),
            className: 'dsh-pi-tree-node',
            'data-leaf': isLeaf ? '1' : '0',
            style: { paddingLeft: String(6 + row.depth * 14) + 'px' },
          },
            h('span', { className: 'dsh-pi-tree-kind' }, String(entry.type === undefined ? '' : entry.type)),
            h('span', { className: 'dsh-pi-tree-text' }, label),
            isLeaf ? h('span', { className: 'dsh-pi-tag', 'data-tone': 'ok' }, t('current')) : null)
        })))
    }

    /** fork 抽屉 = 面板的 /fork：列出用户消息，选中后 fork{entryId} 并回填文本。 */
    function ForkSheet(props) {
      var t = props.t
      var items = Array.isArray(props.items) ? props.items : []
      return h(Sheet, { t: t, title: t('fork'), onClose: props.onClose },
        h('div', { className: 'dsh-pi-sess-line' }, t('forkHint')),
        items.length === 0 ? h('div', { className: 'dsh-pi-empty-row' }, t('forkEmpty')) : null,
        items.map(function (item, index) {
          return h('div', {
            key: item.entryId === undefined ? 'f' + String(index) : item.entryId,
            className: 'dsh-pi-sess',
            onClick: function () { props.onPick(item) },
          },
            h('div', { className: 'dsh-pi-sess-line' }, String(item.text === undefined ? '' : item.text).slice(0, 400)),
            h('div', { className: 'dsh-pi-mono' }, String(item.entryId === undefined ? '' : item.entryId)))
        }))
    }

    /** 统计抽屉 = 面板的 /session。数据来自 get_session_stats + get_state。 */
    function StatsSheet(props) {
      var t = props.t
      var stats = props.stats
      var state = props.state
      var rows = []
      function push(key, value) { if (value !== undefined && value !== null && String(value) !== '') rows.push([key, String(value)]) }
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
      return h(Sheet, { t: t, title: t('stats'), onClose: props.onClose },
        stats === null ? h('div', { className: 'dsh-pi-empty-row' }, t('loading')) : null,
        stats === null ? null : h('div', { className: 'dsh-pi-kv' }, rows.map(function (row, index) {
          return [h('div', { key: 'k' + String(index), className: 'dsh-pi-kv-k' }, row[0]), h('div', { key: 'v' + String(index), className: 'dsh-pi-kv-v' }, row[1])]
        })))
    }

    /** 设置抽屉 = 面板的 /settings。四个开关全部走 RPC，与 TUI 的 settingsManager 语义一致。 */
    function SettingsSheet(props) {
      var t = props.t
      var state = props.state
      /** 开关：对齐 DSH 的 ._switch_1ik0f_5（36x20 胶囊 + 16px 滑块），不再是文字按钮。 */
      function toggle(key, label, value, onChange) {
        var checked = value === true
        return h('div', { className: 'dsh-pi-switch-row' },
          h('span', { className: 'dsh-pi-switch-label', id: 'dsh-pi-sw-' + key }, label),
          h('button', {
            type: 'button',
            className: 'dsh-pi-switch',
            role: 'switch',
            'aria-checked': checked ? 'true' : 'false',
            'aria-labelledby': 'dsh-pi-sw-' + key,
            onClick: function () { onChange(checked !== true) },
          }, h('span', { className: 'dsh-pi-switch-thumb' })))
      }
      return h(Sheet, { t: t, title: t('settings'), onClose: props.onClose },
        toggle('autoCompaction', t('autoCompact'), state.autoCompactionEnabled, function (next) { props.onAutoCompaction(next) }),
        toggle('autoRetry', t('autoRetry'), state.autoRetryEnabled, function (next) { props.onAutoRetry(next) }),
        h('div', { className: 'dsh-pi-row2' },
          h('span', { className: 'dsh-pi-kv-k', style: { minWidth: '180px' } }, t('steeringMode')),
          h('button', { type: 'button', className: 'dsh-pi-btn', onClick: function () { props.onSteering(state.steeringMode === 'all' ? 'one-at-a-time' : 'all') } }, String(state.steeringMode === undefined ? 'all' : state.steeringMode))),
        h('div', { className: 'dsh-pi-row2' },
          h('span', { className: 'dsh-pi-kv-k', style: { minWidth: '180px' } }, t('followUpMode')),
          h('button', { type: 'button', className: 'dsh-pi-btn', onClick: function () { props.onFollowUp(state.followUpMode === 'all' ? 'one-at-a-time' : 'all') } }, String(state.followUpMode === undefined ? 'all' : state.followUpMode))),
        h('div', { className: 'dsh-pi-sess-line' }, t('autoApprove')))
    }

    /** changelog 抽屉：pi 的 CHANGELOG.md 由 host 代读（RPC 面无文件系统能力）。 */
    function TextSheet(props) {
      return h(Sheet, { t: props.t, title: props.title, onClose: props.onClose },
        props.text === '' ? h('div', { className: 'dsh-pi-empty-row' }, props.t('loading')) : h('pre', { className: 'dsh-pi-pre', style: { whiteSpace: 'pre-wrap' } }, props.text))
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

      useEffect(function () {
        var budget = dialogBudgetMs(request)
        var deadline = Date.now() + budget
        var timer = window.setInterval(function () {
          var remain = deadline - Date.now()
          if (remain <= 0) {
            window.clearInterval(timer)
            props.onRespond({ id: request.id, cancelled: true })
            return
          }
          setLeft(Math.ceil(remain / 1000))
        }, 1000)
        setLeft(Math.ceil(budget / 1000))
        return function () { window.clearInterval(timer) }
      }, [request.id])

      var title = request.title === '' ? t('extSelect') : request.title
      var body = []
      if (request.method === 'confirm') {
        body.push(h('p', { key: 'msg', className: 'dsh-pi-dialog-msg' }, request.message === null ? '' : request.message))
        body.push(h('div', { key: 'act', className: 'dsh-pi-dialog-actions' },
          h('button', { type: 'button', className: 'dsh-pi-btn', onClick: function () { props.onRespond({ id: request.id, confirmed: false }) } }, t('extNo')),
          h('button', { type: 'button', className: 'dsh-pi-btn dsh-pi-btn-primary', onClick: function () { props.onRespond({ id: request.id, confirmed: true }) } }, t('extYes'))))
      } else if (request.method === 'select') {
        body.push(h('div', { key: 'opts', className: 'dsh-pi-dialog-body' }, request.options.map(function (option, index) {
          return h('button', {
            key: 'o' + String(index),
            type: 'button',
            className: 'dsh-pi-opt',
            onClick: function () { props.onRespond({ id: request.id, value: option }) },
          }, option)
        })))
        body.push(h('div', { key: 'act', className: 'dsh-pi-dialog-actions' },
          h('button', { type: 'button', className: 'dsh-pi-btn', onClick: function () { props.onRespond({ id: request.id, cancelled: true }) } }, t('cancel'))))
      } else if (request.method === 'input') {
        body.push(h('input', {
          key: 'input',
          className: 'dsh-pi-search',
          value: value,
          placeholder: request.placeholder === null ? '' : request.placeholder,
          onChange: function (event) { setValue(event.target.value) },
          onKeyDown: function (event) { if (event.key === 'Enter') props.onRespond({ id: request.id, value: value }) },
        }))
        body.push(h('div', { key: 'act', className: 'dsh-pi-dialog-actions' },
          h('button', { type: 'button', className: 'dsh-pi-btn', onClick: function () { props.onRespond({ id: request.id, cancelled: true }) } }, t('cancel')),
          h('button', { type: 'button', className: 'dsh-pi-btn dsh-pi-btn-primary', onClick: function () { props.onRespond({ id: request.id, value: value }) } }, t('extSubmit'))))
      } else {
        body.push(h('textarea', {
          key: 'ta',
          className: 'dsh-pi-mini-ta',
          value: value,
          onChange: function (event) { setValue(event.target.value) },
        }))
        body.push(h('div', { key: 'act', className: 'dsh-pi-dialog-actions' },
          h('button', { type: 'button', className: 'dsh-pi-btn', onClick: function () { props.onRespond({ id: request.id, cancelled: true }) } }, t('cancel')),
          h('button', { type: 'button', className: 'dsh-pi-btn dsh-pi-btn-primary', onClick: function () { props.onRespond({ id: request.id, value: value }) } }, t('extSubmit'))))
      }
      var label = request.method === 'confirm' ? t('extConfirm') : request.method === 'input' ? t('extInput') : request.method === 'editor' ? t('extEditor') : t('extSelect')
      return h('div', { className: 'dsh-pi-dialog-wrap' },
        h('div', { className: 'dsh-pi-dialog', role: 'dialog', 'aria-label': label },
          h('h3', null, label + ' · ' + title),
          left === null ? null : h('div', { className: 'dsh-pi-mono' }, t('extTimeout').replace('{n}', String(left))),
          body))
    }

    function ImageOverlay(props) {
      return h('div', { className: 'dsh-pi-img-open', onClick: props.onClose },
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
        className: 'dsh-pi-chip',
        'data-clickable': '1',
        'data-tone': tone,
        title: detail.join('\n'),
        onClick: function () { if (typeof props.onClick === 'function') props.onClick() },
      }, h('span', { className: 'dsh-pi-chip-name' }, label))
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

      return h('div', { className: 'dsh-pi-root' },
        h('div', { className: 'dsh-pi-head' },
          h('div', { className: 'dsh-pi-head-main' },
            h(PiIcon, { size: 16 }),
            h('span', { className: 'dsh-pi-brand' }, t('panelTitle')))),
        h('div', { className: 'dsh-pi-gate' },
          h('div', { className: 'dsh-pi-gate-card' },
            h(PiIcon, { size: 30 }),
            h('h3', null, t('runtimeMissing')),
            h('p', { className: 'dsh-pi-empty p' }, t('runtimeMissingHint')),
            failure === null ? null : h('div', { className: 'dsh-pi-alert' }, t('installFailed') + '：' + failure),
            h('div', { className: 'dsh-pi-gate-actions' },
              h('button', { type: 'button', className: 'dsh-pi-btn dsh-pi-btn-primary', disabled: busy, onClick: run }, busy ? t('installing') : t('installRuntime')),
              h('button', { type: 'button', className: 'dsh-pi-btn', onClick: function () { if (typeof props.onRecheck === 'function') props.onRecheck() } }, t('recheck'))),
            install.target === undefined ? null : h('div', { className: 'dsh-pi-gate-path' }, String(install.target)),
            h('div', { className: 'dsh-pi-gate-searched' },
              h('div', null, t('searchedAt') + '：'),
              h('ul', { style: { margin: '0', paddingLeft: '16px' } }, searched.map(function (item, index) {
                var ok = item !== null && item !== undefined && item.ok === true
                return h('li', { key: 's' + String(index) }, (ok ? '✓ ' : '✗ ') + String(item === null || item === undefined ? '' : item.source) + ' · ' + String(item === null || item === undefined ? '' : item.path))
              }))))))
    }

    /** 模型抽屉 = 面板的 /model 与 /scoped-models。 */
    function ModelsSheet(props) {
      var t = props.t
      var models = Array.isArray(props.models) ? props.models : []
      var stateQuery = useState('')
      var query = stateQuery[0]
      var setQuery = stateQuery[1]
      var filtered = models
      if (query.trim() !== '') {
        var needle = query.trim().toLowerCase()
        filtered = models.filter(function (model) {
          var haystack = String(model.provider === undefined ? '' : model.provider) + ' ' + String(model.id === undefined ? '' : model.id) + ' ' + String(model.name === undefined ? '' : model.name)
          return haystack.toLowerCase().indexOf(needle) >= 0
        })
      }
      return h(Sheet, { t: t, title: t('models'), onClose: props.onClose, actions: h('input', {
        className: 'dsh-pi-search',
        value: query,
        placeholder: t('filter'),
        onChange: function (event) { setQuery(event.target.value) },
      }) },
        props.loading === true ? h('div', { className: 'dsh-pi-empty-row' }, t('modelsLoading')) : null,
        props.loading === true ? null : filtered.length === 0 ? h('div', { className: 'dsh-pi-empty-row' }, t('modelsEmpty')) : null,
        filtered.map(function (model, index) {
          var current = props.current !== null && props.current !== undefined && props.current.provider === model.provider && props.current.id === model.id
          return h('div', {
            key: String(model.provider) + '/' + String(model.id) + ':' + String(index),
            className: 'dsh-pi-sess',
            'data-current': current ? '1' : '0',
            onClick: function () { props.onPick(model) },
          },
            h('div', { className: 'dsh-pi-sess-top' },
              h('div', { className: 'dsh-pi-sess-title' }, String(model.name === undefined || model.name === '' ? model.id : model.name)),
              current ? h('span', { className: 'dsh-pi-tag', 'data-tone': 'ok' }, t('current')) : null),
            h('div', { className: 'dsh-pi-mono' }, String(model.provider) + ' · ' + String(model.id) + ' · ' + String(model.contextWindow) + ' ctx'))
        }))
    }

    /** 思考档位抽屉 = 面板的 /thinking（无参数时）。 */
    function ThinkingSheet(props) {
      var t = props.t
      var levels = Array.isArray(props.levels) ? props.levels : []
      return h(Sheet, { t: t, title: t('thinkingHint'), onClose: props.onClose },
        levels.length === 0 ? h('div', { className: 'dsh-pi-empty-row' }, t('modelsEmpty')) : null,
        levels.map(function (level, index) {
          return h('div', {
            key: String(level) + ':' + String(index),
            className: 'dsh-pi-sess',
            'data-current': props.current === level ? '1' : '0',
            onClick: function () { props.onPick(level) },
          }, h('div', { className: 'dsh-pi-sess-top' },
            h('div', { className: 'dsh-pi-sess-title' }, String(level)),
            props.current === level ? h('span', { className: 'dsh-pi-tag', 'data-tone': 'ok' }, t('current')) : null))
        }))
    }

    /** 命名抽屉 = 面板的 /name（无参数时）。 */
    function NameSheet(props) {
      var t = props.t
      var stateValue = useState(props.value === null || props.value === undefined ? '' : props.value)
      var value = stateValue[0]
      var setValue = stateValue[1]
      return h(Sheet, { t: t, title: t('namePrompt'), onClose: props.onClose },
        h('input', {
          className: 'dsh-pi-search',
          value: value,
          placeholder: t('namePrompt'),
          onChange: function (event) { setValue(event.target.value) },
          onKeyDown: function (event) { if (event.key === 'Enter') props.onSet(value) },
        }),
        h('div', { className: 'dsh-pi-dialog-actions' },
          h('button', { type: 'button', className: 'dsh-pi-btn', onClick: props.onClose }, t('cancel')),
          h('button', { type: 'button', className: 'dsh-pi-btn dsh-pi-btn-primary', onClick: function () { props.onSet(value) } }, t('extSubmit'))))
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
      var tone = bash.cancelled === true ? 'warn' : bash.exitCode === null ? 'ok' : bash.exitCode === 0 ? 'ok' : 'err'
      var label = bash.cancelled === true ? props.t('cancel') : bash.exitCode === null ? props.t('result') : 'exit ' + String(bash.exitCode)
      return h('details', { className: 'dsh-pi-tool' },
        h('summary', { className: 'dsh-pi-tool-head' },
          h('span', { className: 'dsh-pi-tag' }, '!'),
          h('span', { className: 'dsh-pi-tool-name' }, bash.command),
          bash.truncated === true ? h('span', { className: 'dsh-pi-tag', 'data-tone': 'warn' }, 'truncated') : null,
          h('span', { className: 'dsh-pi-tag', 'data-tone': tone }, label)),
        h('pre', { className: 'dsh-pi-tool-body' }, bash.output === '' ? '' : bash.output))
    }

    // ── 主面板 ──────────────────────────────────────────────────────────────
    //
    // 对齐原则（docs/parity.md）：命令行 pi 能做的事，面板必须能做；做不到的必须显式说明原因，
    // 绝不允许「静默降级」。所有斜杠命令的分发都在 handleSlash 里，与 src/rpc-contract.mjs 的
    // disposition 一一对应。

    function PiPanel(props) {
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
      var dynamicState = useState([])
      var dynamic = dynamicState[0]
      var setDynamic = dynamicState[1]
      var imagesState = useState([])
      var images = imagesState[0]
      var setImages = imagesState[1]
      var overlayState = useState(null)
      var overlay = overlayState[0]
      var setOverlay = overlayState[1]
      var drawerState = useState(null)
      var drawer = drawerState[0]
      var setDrawer = drawerState[1]
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
      metaRef.current = meta

      var repaint = function () { bump(function (value) { return value + 1 }) }

      /** 弹出提示：写进 view.notices（最多 5 条），不阻塞任何操作。 */
      var notice = function (text, tone) {
        pushNotice(viewRef.current, text, tone)
        repaint()
      }

      /** 回拉完整消息列表，并以它为准整表重建（等价于命令行 pi 从 jsonl 恢复会话）。
       *
       * 为什么必须有这一步：bash 结果、以及「已落盘但没发事件」的历史消息只有 get_messages 能给。
       * switch_session / fork / clone / new_session 之后 host 会 resetEvents（index.js 的
       * SESSION_REPLACING_COMMANDS），事件缓冲归零，snapshot 里没有任何历史 —— 只重放事件面板
       * 必然是空的。这是 0.4.0 及之前「点开历史会话没有内容」的根因。
       *
       * 两道防线：
       *  - 会话已经切走（sessionRef 变了）就丢弃结果，避免旧会话的响应污染新会话；
       *  - 正在跑动（busy）就不覆盖列表，改记待办，由 flush 在 settled 那一拍补上，
       *    否则会把正在流式的气泡整条吞掉。
       */
      var refreshMessages = function () {
        var id = sessionRef.current
        if (id === null) return Promise.resolve(null)
        return rpc(id, { type: 'get_messages' }).then(function (data) {
          if (sessionRef.current !== id) return null
          var list = data !== null && data !== undefined && Array.isArray(data.messages) ? data.messages : null
          if (list === null) return null
          var view = viewRef.current
          if (view.busy === true) {
            hydratePendingRef.current = true
            return null
          }
          var next = messagesFromHistory(list)
          if (next === null) return null
          view.messages = next
          view.openIndex = -1
          view.streamingIndex = -1
          repaint()
          return null
        }, function () { return null })
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
          if (sid !== null) loadCommands(sid)
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
          applyBatch(viewRef.current, Array.isArray(snapshot.events) ? snapshot.events : [])
          viewRef.current.busy = snapshot.state === 'busy'
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
          viewRef.current.busy = false
          viewRef.current.notice = detail === null ? t('crashed') : t('crashed') + ' (code ' + String(detail.code) + ')'
          flush()
          resync(id)
        })
        source.onerror = function () {
          if (source.readyState === 2) setBroken(true)
        }
      }

      var attach = function (id) {
        return api.snapshot(id, 0).then(function (snapshot) {
          var view = viewRef.current
          view.messages = []
          view.lastSeq = 0
          view.openIndex = -1
          view.streamingIndex = -1
          view.lastSeq = typeof snapshot.eventSeq === 'number' ? snapshot.eventSeq : 0
          applyBatch(view, Array.isArray(snapshot.events) ? snapshot.events : [])
          view.busy = snapshot.state === 'busy'
          sessionRef.current = id
          setMeta(snapshot)
          setPhase('ready')
          openStream(id, view.lastSeq)
          flush()
          // 挂载即对账：首次进入、以及 switch_session / fork / clone / new_session 之后
          // host 的事件缓冲都是空的，历史消息只能靠 get_messages 拿回来。
          return hydrate(id).then(function () { return null })
        })
      }

      /** 会话内容被替换（new_session / switch_session / fork / clone）后重新挂载。 */
      var reload = function (id) {
        closeStream()
        return attach(id).then(function () { return loadState(id) }).then(function () { return loadLevels(id) }).then(function () { return loadCommands(id) })
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
          setContract(buildContract(body))
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

      useEffect(function () {
        loadContract()
        startSession()
        return function () {
          closeStream()
          if (timerRef.current !== null) window.clearTimeout(timerRef.current)
        }
      }, [])

      // 自检只读磁盘、不碰 pi 子进程，面板打开时问一次即可；失败静默。
      var runSelfCheck = function () {
        return api.selfcheck().then(function (report) { setVerify(report !== null && typeof report === 'object' ? report : null) }, function () { setVerify(null) })
      }

      useEffect(function () { runSelfCheck() }, [])

      useEffect(function () {
        var node = scrollRef.current
        if (node === null || node === undefined) return
        if (pinnedRef.current) node.scrollTop = node.scrollHeight
      })

      var onScroll = function () {
        var node = scrollRef.current
        if (node === null || node === undefined) return
        pinnedRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80
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
        setDrawer(null)
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
          setDrawer('thinking')
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
          setDrawer('models')
          notice(t('modelHint') + ': ' + String(term).trim() + ' — ' + t('emptyResult'), 'warn')
        }, function (failure) {
          notice(String(failure !== null && failure !== undefined && failure.message !== undefined ? failure.message : failure), 'err')
        })
      }

      // ── 抽屉数据加载 ───────────────────────────────────────────────────────

      var openModels = function () {
        setDrawer('models')
        setModelsLoading(true)
        var id = sessionRef.current
        if (id === null) { setModelsLoading(false); return }
        rpc(id, { type: 'get_available_models' }).then(function (data) {
          setModels(data !== null && data !== undefined && Array.isArray(data.models) ? data.models : [])
          setModelsLoading(false)
        }, function () { setModelsLoading(false) })
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
        var id = sessionRef.current
        if (id === null) return
        rpc(id, { type: 'get_session_stats' }).then(function (data) { setStats(data) }, function () { setStats(null) })
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
        var id = sessionRef.current
        if (id === null) return
        loadState(id)
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
        dropPendingUi(viewRef.current, body.id)
        repaint()
        if (id === null) return
        // 会话已经 settled 时 pi 会丢弃未应答请求，host 返回 409 —— 弹窗早已收起，不打扰用户。
        api.respond(id, body).catch(function () { return null })
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
        if (parsed.name === '/scoped-models') { openModels(); return }
        if (parsed.name === '/session') { openStats(); return }
        if (parsed.name === '/hotkeys') { setDrawer('hotkeys'); return }
        if (parsed.name === '/fork') { openFork(); return }
        if (parsed.name === '/tree') { openTree(); return }
        if (parsed.name === '/resume') { setDrawer('sessions'); return }
        if (parsed.name === '/quit') { endSession(); return }
        notice(parsed.name + ' — ' + t('unsupportedDetail'), 'warn')
      }

      var handleRpcCommand = function (parsed) {
        if (parsed.name === '/model') { if (parsed.args === '') openModels(); else applyModelBySearch(parsed.args); return }
        if (parsed.name === '/thinking') { if (parsed.args === '') setDrawer('thinking'); else applyThinkingByName(parsed.args); return }
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
      var slashEntries = slashItems(contract, dynamic)
      var widgets = []
      for (var widgetKey in view.widgets) {
        if (Object.prototype.hasOwnProperty.call(view.widgets, widgetKey) === false) continue
        var widget = view.widgets[widgetKey]
        widgets.push({ key: widgetKey, lines: Array.isArray(widget.lines) ? widget.lines : [], placement: widget.placement })
      }

      var head = h('div', { className: 'dsh-pi-head' },
        h('div', { className: 'dsh-pi-head-main' },
          h(PiIcon, null),
          h('span', { className: 'dsh-pi-brand' }, t('panelTitle')),
          h('span', { className: 'dsh-pi-dot', 'data-state': state, title: state }),
          sessionName === null || sessionName === '' ? null : h('span', { className: 'dsh-pi-chip', title: t('sessionName') }, String(sessionName)),
          h('span', {
            className: 'dsh-pi-chip',
            'data-clickable': '1',
            title: t('modelHint') + ' · ' + (currentModel === null ? '—' : String(currentModel.provider) + '/' + String(currentModel.id)),
            onClick: openModels,
          }, h('span', { className: 'dsh-pi-chip-name' }, currentModel === null ? t('model') : String(currentModel.id)))),
        h(SelfCheckChip, { t: t, report: verify, onClick: runSelfCheck }),
        levels.length === 0 ? null : h('select', {
          className: 'dsh-pi-select',
          value: thinking,
          title: t('thinkingHint'),
          onChange: function (event) { setLevel(event.target.value) },
        }, levels.map(function (level) { return h('option', { key: level, value: level }, String(level)) })),
        h('button', { type: 'button', className: 'dsh-pi-btn dsh-pi-btn-ghost', title: t('nextModel') + ' (Ctrl+P)', onClick: cycleModel }, t('nextModel')),
        h('button', { type: 'button', className: 'dsh-pi-btn dsh-pi-btn-ghost', title: t('nextThinking') + ' (Shift+Tab)', onClick: cycleThinking }, t('nextThinking')),
        h('button', { type: 'button', className: 'dsh-pi-btn dsh-pi-btn-ghost', title: t('stats'), onClick: openStats }, t('stats')),
        h('button', { type: 'button', className: 'dsh-pi-btn dsh-pi-btn-ghost', title: t('sessions'), onClick: function () { setDrawer('sessions') } }, t('sessions')),
        h('button', { type: 'button', className: 'dsh-pi-btn dsh-pi-btn-ghost', title: t('settings'), onClick: openSettings }, t('settings')),
        h('button', { type: 'button', className: 'dsh-pi-btn dsh-pi-btn-ghost', title: t('compactNow'), onClick: function () { runCompact('') } }, t('compactNow')),
        // 「新会话」= 命令行 pi 的 /new：同一个 pi 子进程内换一棵新会话树（保留模型、思考档位、
        // 扩展加载状态），树换完后 reload 重挂数据流。0.3.0 之前这个按钮走 endSession（关掉
        // 子进程再起一个），代价是丢掉进程内一切状态，并且与 /new 的行为不一致 —— 同一件事
        // 有两个入口、两种结果，是 D-03 的实质。换进程的能力单独留成「重连」，它才该被当成
        // 恢复手段（进程卡死、host 侧残留时用）。
        h('button', { type: 'button', className: 'dsh-pi-btn dsh-pi-btn-ghost', title: t('reconnectHint'), onClick: endSession }, t('reconnect')),
        h('button', { type: 'button', className: 'dsh-pi-btn', title: t('newSessionHint'), onClick: runNewSession }, t('newSession')))

      if (phase === 'loading') {
        return h('div', { className: 'dsh-pi-root' }, h('div', { className: 'dsh-pi-center' }, t('loading')))
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
        return h('div', { className: 'dsh-pi-root' },
          head,
          h('div', { className: 'dsh-pi-scroll' },
            h('div', { className: 'dsh-pi-inner' },
              h('div', { className: 'dsh-pi-alert' }, String(error)),
              h('div', { className: 'dsh-pi-row2' },
                h('button', { type: 'button', className: 'dsh-pi-btn dsh-pi-btn-primary', onClick: function () { startSession() } }, t('retry')),
                h('button', { type: 'button', className: 'dsh-pi-btn', onClick: function () { startSession() } }, t('reconnect'))))))
      }

      var rows = view.messages.map(function (message, index) {
        return h(MessageRow, {
          key: 'm' + String(message.seq) + '-' + String(index),
          t: t,
          message: message,
          toolStatus: view.toolStatus,
          onOpenImage: function (image) { setOverlay(image) },
        })
      })

      var notices = []
      if (error !== null) notices.push(h('div', { key: 'err', className: 'dsh-pi-alert' }, String(error)))
      if (broken === true) notices.push(h('div', { key: 'broken', className: 'dsh-pi-notice', 'data-tone': 'warn' }, t('reconnect')))
      if (view.notice !== null && view.notice !== undefined) {
        var raw = view.notice
        var text = typeof raw === 'string' ? raw : String(raw.text === undefined ? '' : raw.text)
        var detail = typeof raw === 'string' ? '' : String(raw.detail === undefined ? '' : raw.detail)
        var tone = typeof raw === 'string' ? 'err' : String(raw.tone === undefined ? 'warn' : raw.tone)
        notices.push(h('div', { key: 'notice', className: 'dsh-pi-notice', 'data-tone': tone }, detail === '' ? text : text + ' · ' + detail))
      }
      if (view.compacting === true) notices.push(h('div', { key: 'compact', className: 'dsh-pi-notice', 'data-tone': 'warn' }, t('compacting')))
      if (view.retrying === true) notices.push(h('div', { key: 'retry', className: 'dsh-pi-notice', 'data-tone': 'warn' }, t('retrying')))
      for (var n = 0; n < view.notices.length; n += 1) {
        var item = view.notices[n]
        notices.push(h('div', { key: item.id, className: 'dsh-pi-notice', 'data-tone': String(item.tone === undefined ? 'info' : item.tone) }, String(item.text)))
      }

      // 状态栏：扩展 setStatus 的内容（等价于 TUI 底部状态行）+ 会话文件
      var statusRow = []
      for (var statusKey in view.statuses) {
        if (Object.prototype.hasOwnProperty.call(view.statuses, statusKey) === false) continue
        statusRow.push(h('span', { key: 'st-' + statusKey }, String(view.statuses[statusKey])))
      }
      if (view.queue.steering > 0) statusRow.push(h('span', { key: 'q1' }, String(view.queue.steering) + ' steering'))
      if (view.queue.followUp > 0) statusRow.push(h('span', { key: 'q2' }, String(view.queue.followUp) + ' ' + t('queued')))
      if (meta !== null && typeof meta.sessionFile === 'string' && meta.sessionFile !== '') statusRow.push(h('span', { key: 'file', title: meta.sessionFile }, String(meta.sessionFile)))

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
          onPick: pickSession,
          onClose: function () { setDrawer(null) },
        })
      } else if (drawer === 'models') {
        drawerNode = h(ModelsSheet, {
          t: t,
          models: models,
          current: currentModel,
          loading: modelsLoading,
          onPick: pickModel,
          onClose: function () { setDrawer(null) },
        })
      } else if (drawer === 'thinking') {
        drawerNode = h(ThinkingSheet, {
          t: t,
          levels: levels,
          current: thinking,
          onPick: function (level) { setDrawer(null); setLevel(level) },
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

      return h('div', { className: 'dsh-pi-root' },
        head,
        h('div', { className: 'dsh-pi-scroll', ref: scrollRef, onScroll: onScroll },
          h('div', { className: 'dsh-pi-inner' },
            notices.length === 0 ? null : notices,
            view.messages.length === 0 ? h(EmptyState, { t: t, meta: emptyMeta, onPickDir: function () { setDrawer('dir') } }) : rows)),
        statusRow.length === 0 ? null : h('div', { className: 'dsh-pi-statusbar', style: { padding: '4px 12px' } }, statusRow),
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
          onPickDir: function () { setDrawer('dir') },
          slashEntries: slashEntries,
          editorText: view.editorText,
          widgets: widgets,
          onEditorTextConsumed: consumeEditorText,
          searchFiles: searchFiles,
        }),
        drawerNode,
        pending,
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
              return h(PiIcon, { size: slotProps !== null && slotProps !== undefined && typeof slotProps.size === 'number' ? slotProps.size : 18 })
            })
          })
        }, PANEL_ID + ': sidebar entry')

        ctx.effect(function () {
          return slots.inject('main', function () {
            return slots.register({ name: 'main', key: PANEL_ID, locale: NS }, function (slotProps) {
              return h(PiPanel, { t: slotProps !== null && slotProps !== undefined && typeof slotProps.t === 'function' ? slotProps.t : translate })
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
      PiPanel: PiPanel,
      Composer: Composer,
      BashBlock: BashBlock,
      ToolBlock: ToolBlock,
      ToolResultRow: ToolResultRow,
      MessageRow: MessageRow,
      SelfCheckChip: SelfCheckChip,
      RuntimeGate: RuntimeGate,
      ExtensionDialog: ExtensionDialog,
      dialogBudgetMs: dialogBudgetMs,
      DirSheet: DirSheet,
      dirPickModel: dirPickModel,
      EmptyState: EmptyState,
      SettingsSheet: SettingsSheet,
      SessionsList: SessionsList,
      SessionsSheet: SessionsSheet,
      pathCrumbs: pathCrumbs,
      buildContract: buildContract,
      messagesFromHistory: messagesFromHistory,
      classifyInput: classifyInput,
      slashItems: slashItems,
      strings: { zh: ZH, en: EN },
    }

    return module.exports
  },
})








