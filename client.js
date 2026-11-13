/**
 * dsh-pi — client half.
 *
 * 侧栏一级入口 + 整页聊天，数据面全部走宿主同源路由 api/dsh-pi/*（host 半区 index.js 注册）。
 * 关键契约（来自 DSH 官方 README 与已装插件产物实证，改动前先回读）：
 *  - 'sidebar.panellist' 注册侧栏图标，id 与 'main' 的 key 相同才能互相对应；
 *  - 'main' 是 root 作用域的 keyed slot，key 非 'conversation' 表示不绑定会话；
 *  - 所有注册都包在 ctx.inject(['slots'|'locale'|'layout'], ...) 里：顶层 inject 声明
 *    组合满足不了的依赖会让 entry 永远 pending，并且会卡死整个 dsh 启动；
 *  - 客户端 bundle 的 require() 只能拿到宿主模块表里的 react / react-dom / jsx-runtime
 *    与 @deepseek-ai/dsh-client-ui-primitives。本文件只 require('react')，
 *    零构建、零依赖、零 JSX（JSX 需要编译步骤，这里刻意不引入构建链）。
 *  - 主题只能用宿主 --dsw-* 变量；明暗判据是 body[data-ds-dark-theme]。
 *  - 插件同源路由不需要 token：相对路径 fetch，不能带前导斜杠。
 */
window.__ModuleLoader__.load({
  id: 'dsh-pi',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useRef = React.useRef
    var useCallback = React.useCallback

    var NS = 'dsh-pi'
    var PANEL_ID = NS
    var API_PREFIX = 'api/dsh-pi'

    // ── 文案 ────────────────────────────────────────────────────────────────

    var ZH = {
      panelTitle: 'pi',
      newSession: '新会话',
      retry: '重试',
      stop: '停止',
      send: '发送',
      queue: '排队',
      composerHint: 'Enter 发送，Shift+Enter 换行，Esc 打断',
      emptyTitle: '和 pi 对话',
      emptyHint: 'pi 在你的工作目录里读写文件、跑命令，整个会话跑在独立子进程里，出问题不会影响 DSH 本体。',
      thinking: '思考档位',
      workspace: '工作目录',
      model: '模型',
      busy: '生成中',
      dead: '已退出',
      loading: '正在启动 pi 会话…',
      error: '出错了',
      reconnect: '数据流断开，正在重连…',
      tool: '工具',
      result: '结果',
      failed: '失败',
      thinkingLabel: '思考过程',
      tokens: 'tokens',
      crashed: 'pi 进程已退出',
      synced: '代码已同步',
      syncedHint: '内存中的插件代码与磁盘一致',
      staleCode: '代码已更新 · 待重启',
      staleBuild: 'pi 需重新构建',
    }

    var EN = {
      panelTitle: 'pi',
      newSession: 'New session',
      retry: 'Retry',
      stop: 'Stop',
      send: 'Send',
      queue: 'Queue',
      composerHint: 'Enter to send, Shift+Enter for newline, Esc to interrupt',
      emptyTitle: 'Talk to pi',
      emptyHint: 'pi reads and writes files and runs commands in your workspace. It runs in a separate process, so nothing it does can destabilize DSH.',
      thinking: 'Thinking',
      workspace: 'Workspace',
      model: 'Model',
      busy: 'Generating',
      dead: 'Exited',
      loading: 'Starting a pi session…',
      error: 'Something went wrong',
      reconnect: 'Stream lost, reconnecting…',
      tool: 'Tool',
      result: 'Result',
      failed: 'failed',
      thinkingLabel: 'Thinking',
      tokens: 'tokens',
      crashed: 'The pi process exited',
      synced: 'Up to date',
      syncedHint: 'Loaded plugin code matches disk',
      staleCode: 'Code changed · restart',
      staleBuild: 'pi needs a rebuild',
    }

    // ── 样式 ────────────────────────────────────────────────────────────────

    var CSS = [
      '.dsh-pi-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);font-size:var(--dsw-font-s-14-font-size,14px);line-height:var(--dsw-font-s-14-line-height,1.6);}',
      '.dsh-pi-root *{box-sizing:border-box;}',
      '.dsh-pi-head{display:flex;align-items:center;gap:8px;flex:0 0 auto;padding:10px 16px;min-height:52px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));}',
      '.dsh-pi-head-main{display:flex;align-items:center;gap:8px;min-width:0;flex:1 1 auto;}',
      '.dsh-pi-brand{font-weight:600;font-size:var(--dsw-font-s-14-font-size,14px);white-space:nowrap;}',
      '.dsh-pi-chip{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.04));color:var(--dsw-alias-label-secondary,#555);font-size:var(--dsw-font-xxs-12-font-size,12px);white-space:nowrap;max-width:280px;overflow:hidden;text-overflow:ellipsis;}',
      '.dsh-pi-select{appearance:none;height:22px;border:1px solid transparent;border-radius:999px;padding:0 6px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.04));color:var(--dsw-alias-label-secondary,#555);font:inherit;font-size:var(--dsw-font-xxs-12-font-size,12px);cursor:pointer;}',
      '.dsh-pi-select:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));}',
      '.dsh-pi-verify{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border-radius:999px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-tertiary,#999);font:inherit;font-size:var(--dsw-font-xxs-12-font-size,12px);cursor:pointer;white-space:nowrap;flex:0 0 auto;}',
      '.dsh-pi-verify::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;flex:0 0 auto;}',
      '.dsh-pi-verify:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));}',
      '.dsh-pi-verify[data-tone="warn"]{color:var(--dsw-alias-state-warning-primary,#b54708);background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.04));}',
      '.dsh-pi-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;background:var(--dsw-alias-label-tertiary,#bbb);}',
      '.dsh-pi-dot[data-state="ready"]{background:var(--dsw-alias-state-success-primary,#22a06b);}',
      '.dsh-pi-dot[data-state="busy"]{background:var(--dsw-alias-state-business-primary,#3b82f6);animation:dsh-pi-pulse 1.2s ease-in-out infinite;}',
      '.dsh-pi-dot[data-state="dead"]{background:var(--dsw-alias-state-error-primary,#d92d20);}',
      '@keyframes dsh-pi-pulse{0%,100%{opacity:1}50%{opacity:.3}}',
      '.dsh-pi-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:28px;padding:0 10px;border-radius:var(--dsw-radius-sm,6px);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));background:transparent;color:var(--dsw-alias-label-primary,#111);font:inherit;font-size:var(--dsw-font-xs-13-font-size,13px);cursor:pointer;white-space:nowrap;}',
      '.dsh-pi-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));}',
      '.dsh-pi-btn:disabled{opacity:.4;cursor:default;}',
      '.dsh-pi-btn-primary{background:var(--dsw-alias-brand-primary,#111);border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff);}',
      '.dsh-pi-btn-primary:hover{background:var(--dsw-alias-brand-primary,#111);opacity:.88;}',
      '.dsh-pi-btn-danger{border-color:var(--dsw-alias-border-l3,rgba(0,0,0,.14));color:var(--dsw-alias-state-error-primary,#d92d20);}',
      '.dsh-pi-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;padding:20px 0 8px;}',
      '.dsh-pi-inner{max-width:820px;margin:0 auto;padding:0 20px;display:flex;flex-direction:column;gap:16px;}',
      '.dsh-pi-row{display:flex;gap:10px;min-width:0;}',
      '.dsh-pi-row-user{justify-content:flex-end;}',
      '.dsh-pi-bubble-user{max-width:min(78%,640px);background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05));border-radius:var(--dsw-radius-lg,12px);padding:9px 13px;white-space:pre-wrap;word-break:break-word;}',
      '.dsh-pi-body{display:flex;flex-direction:column;gap:8px;min-width:0;flex:1 1 auto;}',
      '.dsh-pi-prose{word-break:break-word;}',
      '.dsh-pi-prose p{margin:0 0 10px;}',
      '.dsh-pi-prose p:last-child{margin-bottom:0;}',
      '.dsh-pi-prose ul{margin:0 0 10px;padding-left:20px;}',
      '.dsh-pi-prose li{margin:2px 0;}',
      '.dsh-pi-prose h3{margin:14px 0 8px;font-size:inherit;font-weight:600;}',
      '.dsh-pi-code-inline{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em;background:var(--dsw-alias-markdown-code-block,rgba(0,0,0,.06));padding:1px 5px;border-radius:var(--dsw-radius-xs,4px);}',
      '.dsh-pi-fence{margin:0 0 10px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.09));border-radius:var(--dsw-radius-md,8px);overflow:hidden;background:var(--dsw-alias-markdown-code-block,rgba(0,0,0,.035));}',
      '.dsh-pi-fence-lang{padding:4px 10px;font-size:var(--dsw-font-xxxs-11-font-size,11px);color:var(--dsw-alias-label-tertiary,#999);border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.07));font-family:ui-monospace,Menlo,Consolas,monospace;}',
      '.dsh-pi-pre{margin:0;padding:10px 12px;overflow-x:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:var(--dsw-font-markdown-code-block-small,12.5px);line-height:1.55;}',
      '.dsh-pi-think{border-left:2px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));padding-left:10px;color:var(--dsw-alias-label-tertiary,#888);font-size:var(--dsw-font-xs-13-font-size,13px);}',
      '.dsh-pi-think>summary{cursor:pointer;list-style:none;user-select:none;outline:none;}',
      '.dsh-pi-think>summary::-webkit-details-marker{display:none;}',
      '.dsh-pi-think-body{margin-top:6px;white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto;}',
      '.dsh-pi-tool{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.09));border-radius:var(--dsw-radius-md,8px);overflow:hidden;background:var(--dsw-alias-bg-layer-1,transparent);}',
      '.dsh-pi-tool-head{display:flex;align-items:center;gap:8px;padding:7px 10px;font-size:var(--dsw-font-xs-13-font-size,13px);cursor:pointer;list-style:none;user-select:none;outline:none;}',
      '.dsh-pi-tool-head::-webkit-details-marker{display:none;}',
      '.dsh-pi-tool-name{font-family:ui-monospace,Menlo,Consolas,monospace;font-weight:500;}',
      '.dsh-pi-tool-body{margin:0;padding:8px 10px;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.07));white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:var(--dsw-font-xxs-12-font-size,12px);color:var(--dsw-alias-label-secondary,#555);max-height:300px;overflow:auto;}',
      '.dsh-pi-tag{font-size:var(--dsw-font-xxxs-11-font-size,11px);padding:1px 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05));color:var(--dsw-alias-label-tertiary,#888);flex:0 0 auto;}',
      '.dsh-pi-tag[data-tone="run"]{color:var(--dsw-alias-state-business-primary,#2563eb);}',
      '.dsh-pi-tag[data-tone="ok"]{color:var(--dsw-alias-state-success-primary,#1a7f5a);}',
      '.dsh-pi-tag[data-tone="err"]{color:var(--dsw-alias-state-error-primary,#d92d20);}',
      '.dsh-pi-usage{font-size:var(--dsw-font-xxxs-11-font-size,11px);color:var(--dsw-alias-label-dimmed,#aaa);}',
      '.dsh-pi-caret{display:inline-block;width:7px;height:14px;vertical-align:-2px;margin-left:2px;background:var(--dsw-alias-label-primary,#111);opacity:.45;animation:dsh-pi-pulse 1s steps(2,end) infinite;}',
      '.dsh-pi-empty{max-width:560px;margin:min(12vh,90px) auto 0;text-align:center;color:var(--dsw-alias-label-secondary,#555);}',
      '.dsh-pi-empty h2{margin:12px 0 8px;font-size:var(--dsw-font-base-16-font-size,16px);font-weight:600;color:var(--dsw-alias-label-primary,#111);}',
      '.dsh-pi-empty p{margin:0;font-size:var(--dsw-font-xs-13-font-size,13px);line-height:1.7;color:var(--dsw-alias-label-tertiary,#888);}',
      '.dsh-pi-empty-meta{margin-top:16px;font-size:var(--dsw-font-xxs-12-font-size,12px);color:var(--dsw-alias-label-dimmed,#aaa);word-break:break-all;font-family:ui-monospace,Menlo,Consolas,monospace;}',
      '.dsh-pi-composer{flex:0 0 auto;padding:8px 20px 18px;}',
      '.dsh-pi-composer-inner{max-width:820px;margin:0 auto;}',
      '.dsh-pi-box{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:var(--dsw-radius-lg,12px);padding:10px 12px 8px;background:var(--dsw-alias-bg-base,#fff);transition:border-color .15s;}',
      '.dsh-pi-box:focus-within{border-color:var(--dsw-alias-border-l4,rgba(0,0,0,.3));}',
      '.dsh-pi-ta{width:100%;min-height:44px;max-height:220px;border:0;outline:none;resize:none;background:transparent;color:inherit;font:inherit;line-height:1.6;padding:2px 0;}',
      '.dsh-pi-ta::placeholder{color:var(--dsw-alias-label-dimmed,#aaa);}',
      '.dsh-pi-bar{display:flex;align-items:center;gap:8px;}',
      '.dsh-pi-bar-hint{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--dsw-font-xxxs-11-font-size,11px);color:var(--dsw-alias-label-dimmed,#aaa);}',
      '.dsh-pi-alert{margin:0;padding:9px 12px;border-radius:var(--dsw-radius-md,8px);border:1px solid var(--dsw-alias-state-error-primary,#d92d20);color:var(--dsw-alias-state-error-primary,#d92d20);font-size:var(--dsw-font-xs-13-font-size,13px);word-break:break-word;}',
      '.dsh-pi-notice{margin:0;padding:7px 12px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.04));color:var(--dsw-alias-label-secondary,#555);font-size:var(--dsw-font-xxs-12-font-size,12px);}',
      '.dsh-pi-center{display:flex;align-items:center;justify-content:center;height:100%;color:var(--dsw-alias-label-tertiary,#888);font-size:var(--dsw-font-xs-13-font-size,13px);}',
    ].join('')

    // ── HTTP 面 ────────────────────────────────────────────────────────────

    function errorOf(status, body) {
      var text = body !== null && typeof body === 'object' && typeof body.error === 'string' ? body.error : ''
      var error = new Error(text === '' ? 'HTTP ' + String(status) : text)
      error.status = status
      return error
    }

    function requestJson(path, init) {
      var options = init === undefined ? {} : init
      var timeoutMs = options.timeoutMs === undefined ? 20000 : options.timeoutMs
      var controller = new AbortController()
      var timer = setTimeout(function () {
        controller.abort(new DOMException('request timed out', 'TimeoutError'))
      }, timeoutMs)
      var headers = options.body === undefined ? undefined : { 'content-type': 'application/json' }
      return fetch(API_PREFIX + path, {
        method: options.method === undefined ? 'GET' : options.method,
        headers: headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
        cache: 'no-store',
        redirect: 'error',
      }).then(function (res) {
        return res.text().then(function (text) {
          var parsed = null
          if (text !== '') {
            try { parsed = JSON.parse(text) } catch (error) { parsed = null }
          }
          if (res.ok === false) throw errorOf(res.status, parsed)
          if (parsed === null) throw new Error('response is not JSON')
          return parsed
        })
      }).then(function (value) {
        clearTimeout(timer)
        return value
      }, function (error) {
        clearTimeout(timer)
        throw error
      })
    }

    var api = {
      state: function () { return requestJson('/state') },
      create: function (body) { return requestJson('/sessions', { method: 'POST', body: body === undefined ? {} : body }) },
      snapshot: function (id, since) { return requestJson('/sessions/' + encodeURIComponent(id) + '/snapshot?since=' + String(since)) },
      command: function (id, body) { return requestJson('/sessions/' + encodeURIComponent(id) + '/command', { method: 'POST', body: body, timeoutMs: 90000 }) },
      close: function (id) { return requestJson('/sessions/' + encodeURIComponent(id), { method: 'DELETE' }) },
      selfcheck: function () { return requestJson('/selfcheck') },
    }

    // ── 事件 → 视图 ────────────────────────────────────────────────────────

    function stringifyArgs(value) {
      if (value === undefined || value === null) return ''
      if (typeof value === 'string') return value
      try { return JSON.stringify(value, null, 2) } catch (error) { return String(value) }
    }

    function normalizeBlock(block) {
      if (block === null || typeof block !== 'object') return { type: 'text', text: String(block === undefined ? '' : block) }
      if (block.type === 'text') return { type: 'text', text: String(block.text === undefined ? '' : block.text) }
      if (block.type === 'thinking') return { type: 'thinking', text: String(block.thinking === undefined ? '' : block.thinking) }
      if (block.type === 'toolCall') {
        return {
          type: 'toolCall',
          id: block.id === undefined ? null : block.id,
          name: String(block.name === undefined ? 'tool' : block.name),
          argsText: stringifyArgs(block.arguments),
        }
      }
      if (block.type === 'image') return { type: 'text', text: '[image ' + String(block.mimeType) + ']' }
      return { type: 'text', text: stringifyArgs(block) }
    }

    function blocksOf(content) {
      if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }]
      if (Array.isArray(content) === false) return []
      var out = []
      for (var i = 0; i < content.length; i += 1) out.push(normalizeBlock(content[i]))
      return out
    }

    function makeMessage(raw, seq) {
      return {
        seq: seq,
        role: String(raw.role === undefined ? 'assistant' : raw.role),
        blocks: blocksOf(raw.content),
        streaming: false,
        stopReason: raw.stopReason === undefined ? null : raw.stopReason,
        usage: raw.usage === undefined ? null : raw.usage,
        toolName: raw.toolName === undefined ? null : raw.toolName,
        isError: raw.isError === true,
        timestamp: raw.timestamp === undefined ? Date.now() : raw.timestamp,
      }
    }

    function createView() {
      return {
        messages: [],
        lastSeq: 0,
        openIndex: -1,
        streamingIndex: -1,
        busy: false,
        toolStatus: {},
        queue: { steering: 0, followUp: 0 },
        notice: null,
      }
    }

    function applyAssistantEvent(message, event) {
      var kind = String(event.type === undefined ? '' : event.type)
      var index = typeof event.contentIndex === 'number' ? event.contentIndex : -1
      var block = index >= 0 ? message.blocks[index] : undefined
      var text = ''
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
        message.blocks[index] = { type: 'toolCall', id: event.id === undefined ? null : event.id, name: String(event.toolName === undefined ? 'tool' : event.toolName), argsText: '' }
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
        text = event.error === undefined ? 'error' : String(event.error)
        message.blocks.push({ type: 'text', text: text })
      }
    }

    function applyRecord(view, record) {
      var type = String(record.type === undefined ? '' : record.type)
      var started = null
      var message = null
      var current = null
      if (type === 'agent_start') { view.busy = true; return }
      if (type === 'turn_start') { view.busy = true; return }
      if (type === 'agent_settled') { view.busy = false; view.openIndex = -1; view.streamingIndex = -1; return }
      if (type === 'message_start') {
        started = record.message
        if (started === null || typeof started !== 'object') return
        if (started.role === 'system') return
        message = makeMessage(started, view.messages.length)
        message.streaming = message.role === 'assistant'
        view.messages.push(message)
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
          view.messages[view.openIndex] = message
        } else {
          message = makeMessage(record.message, view.messages.length)
          message.streaming = false
          view.messages.push(message)
        }
        view.openIndex = -1
        view.streamingIndex = -1
        return
      }
      if (type === 'tool_execution_start') {
        view.toolStatus[String(record.toolCallId)] = { status: 'running', name: String(record.toolName === undefined ? '' : record.toolName) }
        return
      }
      if (type === 'tool_execution_end') {
        view.toolStatus[String(record.toolCallId)] = { status: record.isError === true ? 'error' : 'done', name: String(record.toolName === undefined ? '' : record.toolName) }
        return
      }
      if (type === 'thinking_level_changed') { view.thinkingLevel = String(record.level === undefined ? '' : record.level); return }
      if (type === 'queue_update') {
        view.queue = {
          steering: Array.isArray(record.steering) ? record.steering.length : 0,
          followUp: Array.isArray(record.followUp) ? record.followUp.length : 0,
        }
        return
      }
      if (type === 'compaction_start') { view.notice = 'compacting context…'; return }
      if (type === 'compaction_end') { view.notice = null; return }
      if (type === 'auto_retry_start') { view.notice = 'retry ' + String(record.attempt) + '/' + String(record.maxAttempts); return }
      if (type === 'auto_retry_end') { view.notice = null; return }
      if (type === 'extension_error') { view.notice = 'extension error: ' + String(record.error === undefined ? '' : record.error); return }
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

    // ── 组件 ────────────────────────────────────────────────────────────────

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

    function ThinkingBlock(props) {
      if (props.text === '') return null
      return h('details', { className: 'dsh-pi-think' },
        h('summary', null, props.t('thinkingLabel')),
        h('div', { className: 'dsh-pi-think-body' }, props.text))
    }

    function ToolBlock(props) {
      var tone = props.status === 'running' ? 'run' : props.status === 'error' ? 'err' : props.status === 'done' ? 'ok' : ''
      var label = props.status === 'running' ? props.t('busy') : props.status === 'error' ? props.t('failed') : props.status === 'done' ? props.t('result') : ''
      return h('details', { className: 'dsh-pi-tool' },
        h('summary', { className: 'dsh-pi-tool-head' },
          h('span', { className: 'dsh-pi-tag' }, props.t('tool')),
          h('span', { className: 'dsh-pi-tool-name' }, props.name),
          label === '' ? null : h('span', { className: 'dsh-pi-tag', 'data-tone': tone }, label)),
        h('pre', { className: 'dsh-pi-tool-body' }, props.argsText === '' ? '{}' : props.argsText))
    }

    function ToolResultRow(props) {
      var message = props.message
      var text = message.blocks.filter(function (block) { return block.type === 'text' }).map(function (block) { return block.text }).join('\n')
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
      if (typeof usage.totalTokens === 'number') parts.push(String(usage.totalTokens) + ' ' + t('tokens'))
      if (parts.length === 0) return null
      return h('div', { className: 'dsh-pi-usage' }, parts.join(' · '))
    }

    function MessageRow(props) {
      var message = props.message
      var t = props.t
      var nodes = []
      var i = 0
      if (message.role === 'user') {
        var userText = message.blocks.filter(function (block) { return block.type === 'text' }).map(function (block) { return block.text }).join('\n')
        return h('div', { className: 'dsh-pi-row dsh-pi-row-user' },
          h('div', { className: 'dsh-pi-bubble-user' }, userText === '' ? '…' : userText))
      }
      if (message.role === 'toolResult') return h(ToolResultRow, { message: message, t: t })
      if (message.role !== 'assistant') return null
      for (i = 0; i < message.blocks.length; i += 1) {
        var block = message.blocks[i]
        if (block.type === 'thinking') nodes.push(h(ThinkingBlock, { key: 'k' + String(i), t: t, text: block.text }))
        else if (block.type === 'toolCall') {
          var entry = block.id === null ? undefined : props.toolStatus[block.id]
          nodes.push(h(ToolBlock, { key: 'k' + String(i), t: t, name: block.name, argsText: block.argsText, status: entry === undefined ? '' : entry.status }))
        } else if (block.type === 'text' && block.text.trim() !== '') {
          nodes.push(h('div', { key: 'k' + String(i), className: 'dsh-pi-prose' }, renderMarkdown(block.text)))
        }
      }
      if (message.streaming) nodes.push(h('span', { key: 'caret', className: 'dsh-pi-caret' }))
      if (message.stopReason === 'error') nodes.push(h('div', { key: 'stop', className: 'dsh-pi-alert' }, t('error')))
      nodes.push(h('div', { key: 'usage' }, usageLine(message.usage, t)))
      return h('div', { className: 'dsh-pi-row' }, h('div', { className: 'dsh-pi-body' }, nodes))
    }

    function Composer(props) {
      var state = useState('')
      var value = state[0]
      var setValue = state[1]
      var areaRef = useRef(null)
      var t = props.t

      var resize = function () {
        var node = areaRef.current
        if (node === null) return
        node.style.height = 'auto'
        node.style.height = String(Math.min(node.scrollHeight, 220)) + 'px'
      }

      var submit = function () {
        var text = value.trim()
        if (text === '' || props.disabled) return
        setValue('')
        resize()
        props.onSend(text, props.busy)
      }

      var onKeyDown = function (event) {
        if (event.key === 'Escape' && props.busy) { event.preventDefault(); props.onStop(); return }
        if (event.key === 'Enter' && event.shiftKey === false) {
          event.preventDefault()
          submit()
        }
      }

      return h('div', { className: 'dsh-pi-composer' },
        h('div', { className: 'dsh-pi-composer-inner' },
          h('div', { className: 'dsh-pi-box' },
            h('textarea', {
              ref: areaRef,
              className: 'dsh-pi-ta',
              value: value,
              rows: 2,
              placeholder: t('composerHint'),
              spellCheck: false,
              onChange: function (event) { setValue(event.target.value); resize() },
              onKeyDown: onKeyDown,
            }),
            h('div', { className: 'dsh-pi-bar' },
              h('span', { className: 'dsh-pi-bar-hint' }, props.hint),
              props.busy ? h('button', { key: 'stop', type: 'button', className: 'dsh-pi-btn dsh-pi-btn-danger', onClick: props.onStop }, t('stop')) : null,
              h('button', {
                key: 'send',
                type: 'button',
                className: 'dsh-pi-btn dsh-pi-btn-primary',
                disabled: props.disabled || value.trim() === '',
                onClick: submit,
              }, props.busy ? t('queue') : t('send'))))))
    }

    function EmptyState(props) {
      return h('div', { className: 'dsh-pi-empty' },
        h(PiIcon, { size: 30 }),
        h('h2', null, props.t('emptyTitle')),
        h('p', null, props.t('emptyHint')),
        props.meta === null ? null : h('div', { className: 'dsh-pi-empty-meta' }, props.meta))
    }

    // ── 自检徽标 ────────────────────────────────────────────────────────────

    /**
     * 一眼看出「现在跑的是不是磁盘上那份代码」。
     * 三种状态：一致 / 磁盘改了待重启 / pi 需要重新构建。
     * 拿不到自检结果（老版本没有这个路由、或请求失败）就不渲染 —— 宁可少一个胶囊也不要误报绿点。
     */
    function SelfCheckChip(props) {
      var report = props.report
      if (report === null || typeof report !== 'object') return null
      var t = props.t
      var summary = report.summary !== null && typeof report.summary === 'object' ? report.summary : {}
      var staleCode = summary.stale === true
      var staleBuild = report.pi !== null && typeof report.pi === 'object' && report.pi.buildFresh === false
      var tone = staleCode || staleBuild ? 'warn' : 'ok'
      var label = staleCode ? t('staleCode') : staleBuild ? t('staleBuild') : t('synced')
      var detail = []
      if (typeof summary.hint === 'string' && summary.hint !== '') detail.push(summary.hint)
      if (staleBuild) detail.push('bundle 早于 src，需要重跑 npm run build')
      if (report.git !== null && typeof report.git === 'object' && report.git.available === true && typeof report.git.commit === 'string') {
        detail.push('git ' + String(report.git.branch === null ? 'detached' : report.git.branch) + ' @ ' + report.git.commit.slice(0, 9))
      }
      if (Array.isArray(summary.missing) && summary.missing.length > 0) detail.push('缺失：' + summary.missing.join(', '))
      detail.push('点一下重新检查')
      return h('button', {
        type: 'button',
        className: 'dsh-pi-verify',
        'data-tone': tone,
        title: detail.join('\n'),
        onClick: function () { if (typeof props.onRecheck === 'function') props.onRecheck() },
      }, label)
    }

    // ── 主面板 ──────────────────────────────────────────────────────────────

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
      var thinkingState = useState('')
      var thinking = thinkingState[0]
      var setThinking = thinkingState[1]
      var levelState = useState([])
      var levels = levelState[0]
      var setLevels = levelState[1]
      var brokenState = useState(false)
      var broken = brokenState[0]
      var setBroken = brokenState[1]
      var verifyState = useState(null)
      var verify = verifyState[0]
      var setVerify = verifyState[1]
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

      var flush = function () {
        timerRef.current = null
        var batch = pendingRef.current
        pendingRef.current = []
        if (batch.length === 0) return
        applyBatch(viewRef.current, batch)
        bump(function (value) { return value + 1 })
      }

      var ingest = function (entries) {
        if (entries.length === 0) return
        for (var i = 0; i < entries.length; i += 1) pendingRef.current.push(entries[i])
        if (timerRef.current === null) timerRef.current = setTimeout(flush, 40)
      }

      var closeStream = function () {
        if (sourceRef.current === null) return
        try { sourceRef.current.close() } catch (error) { /* already closed */ }
        sourceRef.current = null
      }

      var resync = function (id) {
        api.snapshot(id, viewRef.current.lastSeq).then(function (snapshot) {
          applyBatch(viewRef.current, Array.isArray(snapshot.events) ? snapshot.events : [])
          viewRef.current.busy = snapshot.state === 'busy'
          setMeta(snapshot)
          setBroken(false)
          flush()
        }, function () { /* 保留现有视图，EventSource 会自己重连 */ })
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
          try { entry = JSON.parse(event.data) } catch (error) { entry = null }
          if (entry === null || typeof entry !== 'object') return
          ingest([entry])
        }
        source.addEventListener('exit', function (event) {
          var info = null
          try { info = JSON.parse(event.data) } catch (error) { info = null }
          viewRef.current.busy = false
          viewRef.current.notice = info === null ? t('crashed') : t('crashed') + ' (code ' + String(info.code) + ')'
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
        })
      }

      var loadLevels = function (id) {
        return api.command(id, { type: 'get_available_thinking_levels' }).then(function (response) {
          var data = response.data
          if (data !== null && typeof data === 'object' && Array.isArray(data.levels) && data.levels.length > 0) setLevels(data.levels)
          if (data !== null && typeof data === 'object' && typeof data.current === 'string') setThinking(data.current)
        }, function () { /* 档位列表取不到不影响对话 */ })
      }

      var startSession = function () {
        setPhase('loading')
        setError(null)
        return api.state().then(function (state) {
          var existing = Array.isArray(state.sessions) ? state.sessions : []
          if (existing.length > 0) {
            return attach(existing[0].id).then(function () {
              return api.command(existing[0].id, { type: 'get_state' }).then(function (response) {
                var data = response.data
                if (data === null || typeof data !== 'object') return null
                if (typeof data.thinkingLevel === 'string') setThinking(data.thinkingLevel)
                setMeta(function (prev) {
                  return Object.assign({}, prev, {
                    model: data.model === undefined ? null : data.model,
                    thinkingLevel: data.thinkingLevel === undefined ? null : data.thinkingLevel,
                    sessionName: data.sessionName === undefined ? null : data.sessionName,
                  })
                })
                return null
              }, function () { return null })
            }).then(function () { return loadLevels(existing[0].id) })
          }
          return api.create({}).then(function (created) {
            var session = created.session
            return attach(session.id).then(function () { return loadLevels(session.id) })
          })
        }).catch(function (failure) {
          setPhase('error')
          setError(String(failure && failure.message ? failure.message : failure))
        })
      }

      useEffect(function () {
        startSession()
        return function () {
          closeStream()
          if (timerRef.current !== null) clearTimeout(timerRef.current)
        }
      }, [])

      // 自检：只读磁盘，不碰 pi 子进程，所以可以在面板打开时就问一次。
      // 失败静默——自检不该让主流程多看一个红条。
      var runSelfCheck = function () {
        return api.selfcheck().then(function (report) {
          setVerify(report !== null && typeof report === 'object' ? report : null)
        }, function () { setVerify(null) })
      }

      useEffect(function () { runSelfCheck() }, [])

      useEffect(function () {
        var node = scrollRef.current
        if (node === null) return
        if (pinnedRef.current) node.scrollTop = node.scrollHeight
      })

      var onScroll = function () {
        var node = scrollRef.current
        if (node === null) return
        pinnedRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80
      }

      var send = function (text, busy) {
        var id = sessionRef.current
        if (id === null) return
        var body = { type: 'prompt', message: text }
        if (busy) body.streamingBehavior = 'followUp'
        pinnedRef.current = true
        api.command(id, body).catch(function (failure) {
          setError(String(failure && failure.message ? failure.message : failure))
        })
      }

      var stop = function () {
        var id = sessionRef.current
        if (id === null) return
        api.command(id, { type: 'abort' }).catch(function (failure) {
          setError(String(failure && failure.message ? failure.message : failure))
        })
      }

      var setLevel = function (level) {
        var id = sessionRef.current
        if (id === null || level === '') return
        setThinking(level)
        api.command(id, { type: 'set_thinking_level', level: level }).catch(function (failure) {
          setError(String(failure && failure.message ? failure.message : failure))
        })
      }

      var newSession = function () {
        var id = sessionRef.current
        var chain = Promise.resolve(null)
        if (id !== null) {
          closeStream()
          chain = api.close(id).catch(function () { return null })
        }
        chain.then(function () {
          sessionRef.current = null
          viewRef.current = createView()
          bump(function (value) { return value + 1 })
          return startSession()
        })
      }

      var view = viewRef.current
      var state = meta === null ? 'starting' : meta.exit !== null && meta.exit !== undefined ? 'dead' : view.busy ? 'busy' : 'ready'
      var hint = view.queue.steering > 0 || view.queue.followUp > 0
        ? String(view.queue.steering) + ' steering · ' + String(view.queue.followUp) + ' queued'
        : t('composerHint')
      var emptyMeta = meta === null ? null : String(meta.cwd)

      if (phase === 'loading') return h('div', { className: 'dsh-pi-root' }, h('div', { className: 'dsh-pi-center' }, t('loading')))

      var verifyChip = h(SelfCheckChip, { t: t, report: verify, onRecheck: runSelfCheck })

      var header = h('div', { className: 'dsh-pi-head' },
        h('div', { className: 'dsh-pi-head-main' },
          h(PiIcon, null),
          h('span', { className: 'dsh-pi-brand' }, t('panelTitle')),
          h('span', { className: 'dsh-pi-dot', 'data-state': state, title: state }),
          meta !== null && meta.model !== null && meta.model !== undefined && typeof meta.model.id === 'string'
            ? h('span', { className: 'dsh-pi-chip', title: t('model') }, meta.model.id)
            : null),
        verifyChip,
        levels.length === 0 ? null : h('select', {
          className: 'dsh-pi-select',
          value: thinking,
          title: t('thinking'),
          onChange: function (event) { setLevel(event.target.value) },
        }, levels.map(function (level) { return h('option', { key: level, value: level }, String(level)) })),
        h('button', { type: 'button', className: 'dsh-pi-btn', onClick: newSession }, t('newSession')))

      if (phase === 'error') {
        return h('div', { className: 'dsh-pi-root' },
          header,
          h('div', { className: 'dsh-pi-scroll' },
            h('div', { className: 'dsh-pi-inner' },
              h('div', { className: 'dsh-pi-alert' }, error),
              h('div', null, h('button', { type: 'button', className: 'dsh-pi-btn dsh-pi-btn-primary', onClick: newSession }, t('retry'))))))
      }

      var rows = view.messages.map(function (message, index) {
        return h(MessageRow, {
          key: 'm' + String(message.seq) + '-' + String(index),
          t: t,
          message: message,
          toolStatus: view.toolStatus,
        })
      })

      return h('div', { className: 'dsh-pi-root' },
        header,
        h('div', { className: 'dsh-pi-scroll', ref: scrollRef, onScroll: onScroll },
          h('div', { className: 'dsh-pi-inner' },
            error === null ? null : h('div', { className: 'dsh-pi-alert' }, error),
            broken ? h('div', { className: 'dsh-pi-notice' }, t('reconnect')) : null,
            view.notice === null ? null : h('div', { className: 'dsh-pi-notice' }, String(view.notice)),
            view.messages.length === 0 ? h(EmptyState, { t: t, meta: emptyMeta }) : rows)),
        h(Composer, {
          t: t,
          busy: view.busy,
          disabled: state === 'dead',
          hint: hint,
          onSend: send,
          onStop: stop,
        }))
    }

    // ── 注册 ────────────────────────────────────────────────────────────────

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
    // 仅供 test/client-render.mjs 使用；宿主只读 name / inject / apply，多挂一个键无副作用。
    exports.__internals = { SelfCheckChip: SelfCheckChip, PiPanel: PiPanel, strings: { zh: ZH, en: EN } }

    return module.exports
  },
})
