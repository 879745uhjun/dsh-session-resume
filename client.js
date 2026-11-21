/**
 * dsh-session-resume — browser half.
 *
 * One dialog, opened once per page load: every conversation whose last turn was
 * still running when DSH went away is listed with what it was doing, and one
 * click puts a "pick up where you left off" instruction in that session's
 * composer. Nothing is sent automatically — you read the instruction and press
 * send, so an interrupted tool call is never replayed behind your back.
 *
 * @module dsh-session-resume/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-resume',
  factory(require) {
    /** Show a failure on screen; the console is not always reachable. */
    function guard(fn) {
      return (ctx) => {
        try {
          return fn(ctx)
        } catch (error) {
          reportCrash(error)
        }
      }
    }

    function reportCrash(error) {
      try {
        const box = document.createElement('div')
        box.setAttribute('data-dsh-session-resume-error', '')
        box.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147483647;max-width:520px;padding:10px 12px;border-radius:10px;background:#3a1414;color:#ffd7d7;font:12px/1.5 monospace;border:1px solid #7a2b2b;white-space:pre-wrap'
        box.textContent = 'dsh-session-resume failed: ' + (error && error.message ? error.message : String(error))
        document.body.appendChild(box)
      } catch {}
    }

    let React
    try {
      React = require('react')
    } catch (error) {
      reportCrash(error)
      return { inject: [], apply() {} }
    }
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const NS = 'session-resume'
    const ENDPOINT = '/session-resume'
    /** How long to wait for the composer of a freshly opened session. */
    const COMPOSER_TIMEOUT_MS = 9000
    /** Re-check interval while every known turn still looks live. */
    const RECHECK_MS = 4000
    /** How many re-checks before we stop looking. */
    const RECHECK_LIMIT = 30
    /** Poll interval while waiting for that composer. */
    const COMPOSER_POLL_MS = 120
    /** Second look for a turn that died just before the page opened. */
    const RESCAN_MS = 50000

    const EN = {
      'title': 'Pick up where you left off?',
      'title.many': 'Pick up where you left off?',
      'subtitle': 'This conversation was still running when DSH last closed. Its progress is kept in the log.',
      'subtitle.many': 'These conversations were still running when DSH last closed. Pick one to carry on.',
      'row.interrupted': 'interrupted',
      'row.step': 'step {step}',
      'row.tool': 'was running {tool}',
      'row.task': 'Task',
      'row.progress': 'Last output',
      'resume': 'Resume',
      'resume.tip': 'Open the conversation and put the continuation in the composer',
      'dismiss': 'Ignore',
      'dismiss.all': 'Ignore all',
      'queue.more': '{count} more waiting after this one',
      'close': 'Close',
      'empty': 'Nothing to resume',
      'loading': 'Looking for interrupted turns…',
      'error': 'Could not read the session log',
      'switch.failed': 'Could not confirm the conversation switched; nothing was written. Copy the text below.',
      'composer.failed': 'The conversation opened, but its composer could not be filled in — copy the text below',
      'copy': 'Copy',
      'copied': 'Copied',
      'instruction': 'Carry on from where you were interrupted. Check what is already finished before repeating anything — the last step stopped part way through. Continue with the next unfinished item.',
      'instruction.tool': 'Carry on from where you were interrupted. The last action stopped while running {tool} — check its result before repeating it. Continue with the next unfinished item.',
      'badge.count': '{count} unfinished',
      'time.just': 'just now',
      'time.minutes': '{minutes} min ago',
      'time.hours': '{hours} h ago',
      'time.days': '{days} d ago',
    }

    const ZH = {
      'title': '继续上次中断的任务？',
      'title.many': '这几个任务还没跑完',
      'subtitle': 'DSH 上次关闭时，这个会话还在运行。进度都留在日志里。',
      'subtitle.many': 'DSH 上次关闭时，这些会话还在运行。挑一个接着做。',
      'row.interrupted': '中断',
      'row.step': '第 {step} 步',
      'row.tool': '当时正在跑 {tool}',
      'row.task': '任务',
      'row.progress': '最后输出',
      'resume': '从断点继续',
      'resume.tip': '打开会话，并把续跑指令填进输入框',
      'dismiss': '忽略',
      'dismiss.all': '全部忽略',
      'queue.more': '这条之后还有 {count} 条',
      'close': '关闭',
      'empty': '没有需要恢复的任务',
      'loading': '正在查找没跑完的任务…',
      'error': '读取会话日志失败',
      'switch.failed': '没确认切换到目标会话，为了避免填错会话，这次不自动写入 —— 复制下面这段文字粘贴进去',
      'composer.failed': '会话已打开，但没能自动填进输入框 —— 复制下面这段文字粘贴进去',
      'copy': '复制',
      'copied': '已复制',
      'instruction': '接着上次的进度继续。先核对已经完成的部分，不要重复执行；上一个步骤是中途被打断的，从下一个未完成的项继续。',
      'instruction.tool': '接着上次的进度继续。上一步停在执行 {tool} 的时候，先确认它的结果再决定要不要重跑；从下一个未完成的项继续。',
      'badge.count': '{count} 个未完成',
      'time.just': '刚刚',
      'time.minutes': '{minutes} 分钟前',
      'time.hours': '{hours} 小时前',
      'time.days': '{days} 天前',
    }

    const CSS = [
      '/* The startup resume dialog: a plain overlay card, themed by tokens. */',
      '.dsh-resume-scrim {',
      '  position: fixed;',
      '  inset: 0;',
      '  pointer-events: auto;',
      '  z-index: 2147483000;',
      '  isolation: isolate;',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: center;',
      '  padding: 24px;',
      '  background: rgba(0, 0, 0, 0.52);',
      '  backdrop-filter: blur(2px);',
      '}',
      '.dsh-resume-card {',
      '  pointer-events: auto;',
      '  width: min(600px, 100%);',
      '  max-height: min(620px, 86vh);',
      '  display: flex;',
      '  flex-direction: column;',
      '  border-radius: var(--dsw-radius-lg, 16px);',
      '  border: 1px solid var(--dsw-alias-border-subtle, rgba(255, 255, 255, 0.12));',
      '  background: var(--dsw-alias-bg-elevated, #242427);',
      '  color: var(--dsw-alias-label-primary, #ececee);',
      '  box-shadow: 0 28px 64px rgba(0, 0, 0, 0.55);',
      '  overflow: hidden;',
      '}',
      '.dsh-resume-head {',
      '  display: flex;',
      '  gap: 13px;',
      '  padding: 20px 22px 14px;',
      '}',
      '.dsh-resume-icon {',
      '  flex: 0 0 38px;',
      '  width: 38px;',
      '  height: 38px;',
      '  border-radius: 11px;',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: center;',
      '  font-size: 17px;',
      '  color: #eab35f;',
      '  background: rgba(230, 162, 60, 0.13);',
      '  border: 1px solid rgba(230, 162, 60, 0.3);',
      '}',
      '.dsh-resume-title {',
      '  font-size: 15.5px;',
      '  font-weight: 600;',
      '}',
      '.dsh-resume-sub {',
      '  margin-top: 5px;',
      '  font-size: 12px;',
      '  line-height: 1.65;',
      '  color: var(--dsw-alias-label-secondary, #a8a8b0);',
      '}',
      '.dsh-resume-list {',
      '  padding: 4px 16px 8px;',
      '  overflow-y: auto;',
      '  display: flex;',
      '  flex-direction: column;',
      '  gap: 10px;',
      '}',
      '.dsh-resume-row {',
      '  border: 1px solid var(--dsw-alias-border-subtle, rgba(255, 255, 255, 0.1));',
      '  border-radius: 11px;',
      '  padding: 12px 14px;',
      '  background: var(--dsw-alias-bg-sunken, rgba(0, 0, 0, 0.18));',
      '}',
      '.dsh-resume-row-head {',
      '  display: flex;',
      '  align-items: flex-start;',
      '  gap: 10px;',
      '}',
      '.dsh-resume-name {',
      '  flex: 1;',
      '  min-width: 0;',
      '  font-size: 13px;',
      '  font-weight: 600;',
      '  line-height: 1.5;',
      '  overflow: hidden;',
      '  display: -webkit-box;',
      '  -webkit-line-clamp: 2;',
      '  -webkit-box-orient: vertical;',
      '}',
      '.dsh-resume-chip {',
      '  flex: 0 0 auto;',
      '  font-size: 10.5px;',
      '  line-height: 1.6;',
      '  padding: 1px 7px;',
      '  border-radius: 999px;',
      '  color: #e9b05f;',
      '  background: rgba(230, 162, 60, 0.13);',
      '  border: 1px solid rgba(230, 162, 60, 0.28);',
      '  white-space: nowrap;',
      '}',
      '.dsh-resume-meta {',
      '  margin-top: 6px;',
      '  font-size: 11px;',
      '  color: var(--dsw-alias-label-tertiary, #7d7d88);',
      '  display: flex;',
      '  flex-wrap: wrap;',
      '  gap: 4px 10px;',
      '}',
      '.dsh-resume-line {',
      '  margin-top: 8px;',
      '  font-size: 11.5px;',
      '  line-height: 1.6;',
      '  color: var(--dsw-alias-label-secondary, #b3b3bc);',
      '  display: flex;',
      '  gap: 8px;',
      '}',
      '.dsh-resume-line b {',
      '  flex: 0 0 auto;',
      '  font-weight: 500;',
      '  color: var(--dsw-alias-label-tertiary, #7d7d88);',
      '}',
      '.dsh-resume-line span {',
      '  flex: 1;',
      '  min-width: 0;',
      '  overflow: hidden;',
      '  display: -webkit-box;',
      '  -webkit-line-clamp: 2;',
      '  -webkit-box-orient: vertical;',
      '}',
      '.dsh-resume-actions {',
      '  display: flex;',
      '  gap: 8px;',
      '  margin-top: 10px;',
      '}',
      '.dsh-resume-btn {',
      '  pointer-events: auto;',
      '  position: relative;',
      '  font: inherit;',
      '  font-size: 12px;',
      '  line-height: 1.5;',
      '  padding: 6px 13px;',
      '  border-radius: 8px;',
      '  border: 1px solid transparent;',
      '  cursor: pointer;',
      '}',
      '.dsh-resume-btn.primary {',
      '  color: #fff;',
      '  background: var(--dsw-alias-state-business-primary, #4d6bfe);',
      '}',
      '.dsh-resume-btn.primary:hover {',
      '  filter: brightness(1.08);',
      '}',
      '.dsh-resume-btn.ghost {',
      '  color: var(--dsw-alias-label-secondary, #c9c9d3);',
      '  background: transparent;',
      '  border-color: var(--dsw-alias-border-subtle, rgba(255, 255, 255, 0.14));',
      '}',
      '.dsh-resume-btn.ghost:hover {',
      '  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.14));',
      '}',
      '.dsh-resume-btn:focus-visible {',
      '  outline: 2px solid var(--dsw-alias-state-business-primary, #4d6bfe);',
      '  outline-offset: 1px;',
      '}',
      '.dsh-resume-btn[disabled] {',
      '  opacity: 0.55;',
      '  cursor: default;',
      '}',
      '.dsh-resume-foot {',
      '  display: flex;',
      '  align-items: center;',
      '  gap: 10px;',
      '  padding: 10px 22px 18px;',
      '  font-size: 11.5px;',
      '  color: var(--dsw-alias-label-tertiary, #7d7d88);',
      '}',
      '.dsh-resume-foot .spacer {',
      '  flex: 1;',
      '}',
      '.dsh-resume-note {',
      '  padding: 0 22px 16px;',
      '  font-size: 11px;',
      '  line-height: 1.65;',
      '  color: var(--dsw-alias-label-tertiary, #7d7d88);',
      '}',
      '.dsh-resume-fallback {',
      '  padding: 0 22px 14px;',
      '}',
      '.dsh-resume-fallback-body {',
      '  display: flex;',
      '  gap: 8px;',
      '  align-items: flex-start;',
      '  margin-top: 8px;',
      '}',
      '.dsh-resume-fallback-body code {',
      '  flex: 1;',
      '  min-width: 0;',
      '  max-height: 120px;',
      '  overflow: auto;',
      '  font-size: 11.5px;',
      '  line-height: 1.6;',
      '  padding: 8px 10px;',
      '  border-radius: 8px;',
      '  background: var(--dsw-alias-bg-sunken, rgba(0, 0, 0, 0.22));',
      '  border: 1px solid var(--dsw-alias-border-subtle, rgba(255, 255, 255, 0.1));',
      '  white-space: pre-wrap;',
      '}',
      '.dsh-resume-empty {',
      '  padding: 26px 22px 30px;',
      '  text-align: center;',
      '  font-size: 12px;',
      '  color: var(--dsw-alias-label-tertiary, #7d7d88);',
      '}',
    ].join('\n')

    /** Relative time from a millisecond stamp. */
    function relativeTime(t, at) {
      const minutes = Math.max(0, Math.round((Date.now() - at) / 60000))
      if (minutes < 1) return t('time.just')
      if (minutes < 60) return t('time.minutes', { minutes })
      const hours = Math.round(minutes / 60)
      if (hours < 24) return t('time.hours', { hours })
      return t('time.days', { days: Math.round(hours / 24) })
    }

    /** The continuation text for one item. */
    function instructionFor(t, item) {
      if (typeof item.runningTool === 'string' && item.runningTool !== '') {
        return t('instruction.tool', { tool: item.runningTool })
      }
      return t('instruction')
    }

    /** Set a textarea's value the way a typist would, so React sees it. */
    function writeIntoTextarea(element, text) {
      const descriptor = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
      if (descriptor === undefined || typeof descriptor.set !== 'function') return false
      element.focus()
      descriptor.set.call(element, text)
      element.dispatchEvent(new Event('input', { bubbles: true }))
      element.dispatchEvent(new Event('change', { bubbles: true }))
      return element.value === text
    }

    /** Set a contenteditable composer's text. */
    function writeIntoEditable(element, text) {
      element.focus()
      const range = document.createRange()
      range.selectNodeContents(element)
      const selection = window.getSelection()
      if (selection === null) return false
      selection.removeAllRanges()
      selection.addRange(range)
      const inserted = document.execCommand('insertText', false, text)
      if (!inserted) {
        element.textContent = text
        element.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }))
      }
      return (element.textContent ?? '').includes(text.slice(0, 12))
    }

    /** Find the composer that belongs to the session now on screen. */
    function findComposer() {
      const candidates = [
        'textarea[data-dsh-composer]',
        '[data-composer] textarea',
        'form textarea',
        'textarea',
        '[role="textbox"]',
        '[contenteditable="true"]',
        '.ProseMirror[contenteditable="true"]',
        '[contenteditable]',
      ]
      for (const selector of candidates) {
        const found = document.querySelectorAll(selector)
        for (let index = found.length - 1; index >= 0; index -= 1) {
          const element = found[index]
          if (element === null) continue
          const rect = element.getBoundingClientRect()
          if (rect.width < 40 || rect.height < 12) continue
          if (element.hasAttribute('readonly') || element.hasAttribute('disabled')) continue
          return element
        }
      }
      return null
    }

    /** Is the id part of the address, where the shell records the open session? */
    function sessionInUrl(sessionId) {
      try {
        return String(window.location.href).includes(sessionId)
      } catch {
        return false
      }
    }

    /** Does the document carry a marker naming this session as the open one? */
    function sessionInDom(sessionId) {
      const marked = document.querySelectorAll('[data-session-id]')
      for (const element of marked) {
        if (element.getAttribute('data-session-id') === sessionId) return true
      }
      return false
    }

    /**
     * Wait until the shell really shows the target session. Filling the composer
     * before the switch lands writes the instruction into the wrong conversation.
     */
    async function waitForSwitch(sessionId, before, deadline) {
      for (;;) {
        if (sessionInUrl(sessionId) || sessionInDom(sessionId)) return true
        const composer = findComposer()
        if (composer !== null && before !== null && composer !== before) return true
        if (Date.now() > deadline) return false
        await new Promise((resolve) => {
          window.setTimeout(resolve, COMPOSER_POLL_MS)
        })
      }
    }

    /** Last resort: click the sidebar row for this session, matched by id or title. */
    function clickSessionRow(sessionId, title) {
      const marked = document.querySelectorAll('[data-session-id]')
      if (marked.length > 0) {
        for (const row of marked) {
          if (row.getAttribute('data-session-id') !== sessionId) continue
          try {
            row.click()
          } catch {
            return false
          }
          return true
        }
        return false
      }
      if (typeof title !== 'string' || title.trim() === '') return false
      const needle = title.trim().slice(0, 8)
      const candidates = document.querySelectorAll('[data-sidebar-scrollport] *')
      let target = null
      for (const element of candidates) {
        const text = (element.textContent ?? '').trim()
        if (text.length > 160 || !text.includes(needle)) continue
        // Innermost match only: the outer list container also "contains" the text.
        let inner = false
        for (const child of element.children) {
          if ((child.textContent ?? '').includes(needle)) { inner = true; break }
        }
        if (!inner) { target = element; break }
      }
      if (target === null) return false
      const clickable = target.closest('button, [role="button"], [role="treeitem"], [role="option"], a') ?? target
      try {
        clickable.click()
      } catch {
        return false
      }
      return true
    }

    /** Wait for a freshly opened session's composer, then fill it in. */
    async function fillComposer(text) {
      const deadline = Date.now() + COMPOSER_TIMEOUT_MS
      for (;;) {
        const element = findComposer()
        if (element !== null) {
          const done = element.tagName === 'TEXTAREA'
            ? writeIntoTextarea(element, text)
            : writeIntoEditable(element, text)
          if (done) {
            await new Promise((resolve) => {
              window.setTimeout(resolve, 260)
            })
            const kept = element.tagName === 'TEXTAREA'
              ? element.value.includes(text.slice(0, 12))
              : (element.textContent ?? '').includes(text.slice(0, 12))
            if (kept) return true
          }
        }
        if (Date.now() > deadline) return false
        await new Promise((resolve) => {
          window.setTimeout(resolve, COMPOSER_POLL_MS)
        })
      }
    }

    /** One-shot reader for the host's leftover list. */
    function createSource() {
      let state = { status: 'loading', items: [] }
      const listeners = new Set()
      let inflight = null
      let warned = false

      function publish(next) {
        state = next
        for (const listener of listeners) listener()
      }

      function refresh() {
        if (inflight !== null) return inflight
        inflight = (async () => {
          try {
            const response = await fetch(ENDPOINT + '/list', { headers: { accept: 'application/json' }, cache: 'no-store' })
            if (!response.ok) throw new Error('HTTP ' + response.status)
            const payload = await response.json()
            if (payload?.ok !== true) throw new Error(payload?.error ?? 'invalid response')
            const items = Array.isArray(payload.items) ? payload.items : []
            publish({ status: 'ready', items })
          } catch (error) {
            if (!warned) {
              warned = true
              console.warn('[session-resume] could not read the leftover list:', error)
            }
            publish({ status: 'error', items: [] })
          } finally {
            inflight = null
          }
        })()
        return inflight
      }

      async function dismiss(sessionId, interruptedAt) {
        publish({ status: state.status, items: state.items.filter((item) => item.sessionId !== sessionId) })
        try {
          await fetch(ENDPOINT + '/dismiss', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ sessionId, interruptedAt }),
          })
        } catch (error) {
          console.warn('[session-resume] could not dismiss ' + sessionId + ':', error)
        }
      }

      return {
        refresh,
        dismiss,
        snapshot: () => state,
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
      }
    }

    /** When this page loaded; used to tell a live turn from a stale log. */
    const LOADED_AT = Date.now()

    const source = createSource()
    const dialogState = { open: false }
    const dialogListeners = new Set()
    const publishDialog = () => {
      for (const listener of dialogListeners) listener()
    }

    /** React binding for the one-shot reader. */
    function useSourceState() {
      const [state, setState] = useState(source.snapshot())
      useEffect(() => source.subscribe(() => setState(source.snapshot())), [])
      return state
    }

    /** React binding for "has the dialog been opened on this page load". */
    function useDialogOpen() {
      const [open, setOpen] = useState(dialogState.open)
      useEffect(() => {
        const listener = () => setOpen(dialogState.open)
        dialogListeners.add(listener)
        return () => {
          dialogListeners.delete(listener)
        }
      }, [])
      return open
    }

    /**
     * The startup dialog: one row per conversation whose turn never finished.
     * @param props - slot props with `t` and the injected Client context.
     */
    function ResumeDialog({ t, appCtx }) {
      const tr = typeof t === 'function' ? t : (key) => key
      const state = useSourceState()
      const open = useDialogOpen()
      const [busy, setBusy] = useState('')
      const [failure, setFailure] = useState('')
      const [fallback, setFallback] = useState('')
      const [blockedBy, setBlockedBy] = useState('')
      const scrimRef = useRef(null)
      const resumeBtnRef = useRef(null)
      // Only a turn that produced events AFTER this page loaded is really
      // running. A restart touches log files, so the host's mtime-based flag
      // alone would hide every leftover right after a boot.
      const items = state.items.filter((item) => !(item.live === true && Number(item.interruptedAt) >= LOADED_AT - 2000))

      const close = useCallback(() => {
        dialogState.open = false
        publishDialog()
      }, [])

      useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') close()
        }
        window.addEventListener('keydown', onKey)
        // A host overlay ancestor that is pointer-events:none would swallow every
        // click; hand the chain back to us while the dialog is open.
        const restored = []
        let node = scrimRef.current?.parentElement ?? null
        for (let depth = 0; node !== null && depth < 6; depth += 1, node = node.parentElement) {
          try {
            if (window.getComputedStyle(node).pointerEvents === 'none') {
              restored.push({ node, previous: node.style.pointerEvents })
              node.style.pointerEvents = 'auto'
            }
          } catch {
            /* a detached or exotic node; nothing to restore */
          }
        }
        // Hit-test the primary button once: whatever sits on top of it is the
        // reason a click never arrives, so name it in the dialog.
        const timer = window.setTimeout(() => {
          const button = resumeBtnRef.current
          if (button === null || typeof document.elementFromPoint !== 'function') return
          const rect = button.getBoundingClientRect()
          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
          if (hit === null || hit === button || button.contains(hit)) {
            setBlockedBy('')
            return
          }
          const classes = typeof hit.className === 'string' ? hit.className.split(' ').filter(Boolean).slice(0, 2).join('.') : ''
          setBlockedBy((hit.tagName || '').toLowerCase() + (classes ? '.' + classes : ''))
        }, 80)
        return () => {
          window.removeEventListener('keydown', onKey)
          window.clearTimeout(timer)
          for (const entry of restored) entry.node.style.pointerEvents = entry.previous
        }
      }, [open, close])

      const resume = useCallback(async (item) => {
        setBusy(item.sessionId)
        setFailure('')
        setFallback('')
        try {
          const workspace = typeof appCtx?.get === 'function' ? appCtx.get('uiWorkspace') : undefined
          const before = findComposer()
          const already = sessionInUrl(item.sessionId) || sessionInDom(item.sessionId)
          const text = instructionFor(tr, item)
          const tried = []
          let switched = already
          // Different builds expose the switch under different names; try them all
          // instead of guessing one and silently doing nothing.
          if (!switched && workspace !== undefined) {
            for (const name of ['openSession', 'selectSession', 'focusSession', 'showSession', 'open', 'navigate']) {
              if (typeof workspace[name] !== 'function') continue
              try {
                workspace[name](item.sessionId)
                tried.push(name)
              } catch (error) {
                tried.push(name + '!')
                continue
              }
              switched = await waitForSwitch(item.sessionId, before, Date.now() + 2500)
              if (switched) break
            }
          }
          if (!switched && clickSessionRow(item.sessionId, item.title)) {
            tried.push('row-click')
            switched = await waitForSwitch(item.sessionId, before, Date.now() + 3000)
          }
          if (!switched) {
            const api = workspace === undefined ? 'no uiWorkspace' : Object.keys(workspace).slice(0, 10).join(',')
            setFailure(tr('switch.failed') + ' [' + (tried.join('|') || 'none') + '] api: ' + api)
            setFallback(text)
            return
          }
          const ok = await fillComposer(text)
          if (!ok) {
            // The conversation opened, but this build's composer is not one we
            // recognise: hand the text over instead of silently doing nothing.
            setFailure(tr('composer.failed'))
            setFallback(text)
            return
          }
          await source.dismiss(item.sessionId, item.interruptedAt)
          if (source.snapshot().items.filter((entry) => entry.live !== true).length === 0) close()
        } catch (error) {
          console.warn('[session-resume] resume failed:', error)
          setFailure('resume failed: ' + (error && error.message ? error.message : String(error)))
        } finally {
          // Whatever happened, never leave the buttons disabled forever.
          setBusy('')
        }
      }, [appCtx, tr, close])

      const copyFallback = useCallback(async () => {
        try {
          await navigator.clipboard.writeText(fallback)
          // The text is on the clipboard: the dialog has done its job.
          setFailure(tr('copied'))
          close()
        } catch (error) {
          console.warn('[session-resume] clipboard refused:', error)
          setFailure(tr('copy.failed'))
        }
      }, [fallback, tr, close])

      const ignore = useCallback(async (item) => {
        setBusy(item.sessionId)
        await source.dismiss(item.sessionId, item.interruptedAt)
        setBusy('')
        if (source.snapshot().items.filter((entry) => entry.live !== true).length === 0) close()
      }, [close])

      const ignoreAll = useCallback(async () => {
        for (const item of source.snapshot().items) await source.dismiss(item.sessionId, item.interruptedAt)
        close()
      }, [close])

      if (!open) return null

      const many = items.length > 1
      return h('div', { className: 'dsh-resume-scrim', role: 'presentation', ref: scrimRef },
        h('div', {
          className: 'dsh-resume-card',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': tr(many ? 'title.many' : 'title'),
        },
          h('div', { className: 'dsh-resume-head' },
            h('div', { className: 'dsh-resume-icon', 'aria-hidden': 'true' }, '\u21ba'),
            h('div', { style: { minWidth: 0 } },
              h('div', { className: 'dsh-resume-title' }, tr(many ? 'title.many' : 'title')),
              h('div', { className: 'dsh-resume-sub' }, tr(many ? 'subtitle.many' : 'subtitle')),
            ),
          ),
          state.status === 'loading'
            ? h('div', { className: 'dsh-resume-empty' }, tr('loading'))
            : state.status === 'error'
              ? h('div', { className: 'dsh-resume-empty' }, tr('error'))
              : items.length === 0
                ? h('div', { className: 'dsh-resume-empty' }, tr('empty'))
                : h('div', { className: 'dsh-resume-list' },
                items.slice(0, 1).map((item) => h('div', { className: 'dsh-resume-row', key: item.sessionId },
                  h('div', { className: 'dsh-resume-row-head' },
                    h('div', { className: 'dsh-resume-name' }, item.title || item.sessionId),
                    h('span', { className: 'dsh-resume-chip' },
                      tr('row.interrupted') + ' · ' + relativeTime(tr, item.interruptedAt)),
                  ),
                  h('div', { className: 'dsh-resume-meta' },
                    item.cwd ? h('span', {}, item.cwd) : null,
                    Number.isFinite(item.steps) && item.steps > 0 ? h('span', {}, tr('row.step', { step: item.steps })) : null,
                    item.runningTool ? h('span', {}, tr('row.tool', { tool: item.runningTool })) : null,
                  ),
                  item.task ? h('div', { className: 'dsh-resume-line' },
                    h('b', {}, tr('row.task')), h('span', {}, item.task)) : null,
                  item.progress ? h('div', { className: 'dsh-resume-line' },
                    h('b', {}, tr('row.progress')), h('span', {}, item.progress)) : null,
                  h('div', { className: 'dsh-resume-actions' },
                    h('button', {
                      type: 'button',
                      className: 'dsh-resume-btn primary',
                      ref: resumeBtnRef,
                      title: tr('resume.tip'),
                      onPointerDown: (event) => event.stopPropagation(),
                      onMouseDown: (event) => event.stopPropagation(),
                      disabled: busy !== '',
                      onClick: () => {
                        void resume(item)
                      },
                    }, tr('resume')),
                    h('button', {
                      type: 'button',
                      className: 'dsh-resume-btn ghost',
                      disabled: busy !== '',
                      onPointerDown: (event) => event.stopPropagation(),
                      onMouseDown: (event) => event.stopPropagation(),
                      onClick: () => {
                        void ignore(item)
                      },
                    }, tr('dismiss')),
                  ),
                )),
              ),
          failure !== ''
            ? h('div', { className: 'dsh-resume-fallback' },
              h('div', { className: 'dsh-resume-note' }, failure),
              h('div', { className: 'dsh-resume-fallback-body' },
                h('code', {}, fallback),
                h('button', {
                  type: 'button',
                  className: 'dsh-resume-btn ghost',
                  onClick: () => {
                    void copyFallback()
                  },
                }, tr('copy')),
              ),
            )
            : null,
          blockedBy !== ''
            ? h('div', { className: 'dsh-resume-note' }, 'hit-test: ' + blockedBy + ' is on top of the action buttons')
            : null,
          h('div', { className: 'dsh-resume-foot' },
            h('span', {}, items.length > 1 ? tr('queue.more', { count: items.length - 1 }) : tr('resume.tip')),
            h('span', { className: 'spacer' }),
            items.length > 1 ? h('button', {
              type: 'button',
              className: 'dsh-resume-btn ghost',
              onClick: () => {
                void ignoreAll()
              },
            }, tr('dismiss.all')) : null,
            h('button', {
              type: 'button',
              className: 'dsh-resume-btn ghost',
              onClick: close,
            }, tr('close')),
          ),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply: guard((ctx) => {
        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-dsh-session-resume', '')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'session-resume: styles')

        ctx.effect(() => ctx.locale.register(NS, { en: EN, zh: ZH }), 'session-resume: locale')

        ctx.effect(() => {
          let rescan = 0
          const openIfAny = () => {
            const eligible = source.snapshot().items.filter((item) => !(item.live === true && Number(item.interruptedAt) >= LOADED_AT - 2000))
            if (eligible.length === 0) return false
            dialogState.open = true
            publishDialog()
            return true
          }
          // Right after a restart every log still looks live, because the last
          // write is seconds old. Keep asking until the frozen turn shows up.
          let attempts = 0
          const check = () => {
            if (openIfAny()) return
            if (attempts >= RECHECK_LIMIT) return
            attempts += 1
            rescan = window.setTimeout(() => {
              void source.refresh().then(check)
            }, RECHECK_MS)
          }
          void source.refresh().then(check)
          return () => window.clearTimeout(rescan)
        }, 'session-resume: startup scan')

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'session-resume-dialog',
          order: 55,
          locale: NS,
        }, ResumeDialog))
      }),
    }
  },
})
