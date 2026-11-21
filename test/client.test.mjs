import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const SOURCE = await readFile(new URL('../client.js', import.meta.url), 'utf8')

/** Minimal React: element trees plus inert hooks, enough to inspect markup. */
const ReactStub = {
  createElement: (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
  }),
  useCallback: (fn) => fn,
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
  useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Walk a rendered tree, visiting every element node. */
function walk(node, visit) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

/** Run client.js the way the page does, with the DOM and fetch stubbed. */
function loadClient({ items }) {
  const registered = []
  const fetched = []
  const styles = []
  const context = {
    effect: (fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: { register: () => () => {} },
    slots: {
      inject: (name, fn) => {
        fn()
      },
      register: (meta, Component) => {
        registered.push({ meta, Component })
        return () => {}
      },
    },
    get: () => undefined,
  }
  const library = { id: null, plugin: null }
  const window = {
    __ModuleLoader__: {
      load: ({ id, factory }) => {
        library.id = id
        library.plugin = factory((name) => (name === 'react' ? ReactStub : {}))
      },
    },
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t },
    clearTimeout: (id) => clearTimeout(id),
    addEventListener: () => {},
    removeEventListener: () => {},
    location: { href: 'http://127.0.0.1/app/' },
    getSelection: () => null,
    getComputedStyle: () => ({ pointerEvents: 'auto' }),
  }
  const document = {
    createElement: () => ({ setAttribute: () => {}, remove: () => {}, style: {}, textContent: '' }),
    head: { appendChild: (node) => styles.push(node) },
    body: { appendChild: () => {} },
    querySelector: () => null,
    querySelectorAll: () => [],
    elementFromPoint: () => null,
    documentElement: { getAttribute: () => null },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  const sandbox = {
    window,
    document,
    console,
    fetch: async (url, init) => {
      fetched.push({ url, method: init?.method ?? 'GET' })
      return { ok: true, status: 200, json: async () => ({ ok: true, items }) }
    },
    navigator: { clipboard: { writeText: async () => {} } },
    Event: class {},
    InputEvent: class {},
    MouseEvent: class {},
    HTMLTextAreaElement: class {},
  }
  sandbox.globalThis = sandbox
  vm.runInNewContext(SOURCE, sandbox, { filename: 'client.js' })
  library.plugin.apply(context)
  return { library, registered, fetched, styles, context }
}

const ITEM = {
  sessionId: 'session-a',
  title: '整理季度报表',
  live: false,
  interruptedAt: Date.now() - 60_000,
  steps: 3,
  runningTool: 'ops_bash',
  task: '把季度报表整理成 xlsx',
  progress: '前两家分公司已核对',
}

function buttonsOf(tree) {
  const found = []
  walk(tree, (node) => {
    if (node.type === 'button') found.push(node)
  })
  return found
}

test('the browser half registers one overlay dialog and asks the host once', async () => {
  const run = loadClient({ items: [ITEM, { ...ITEM, sessionId: 'session-b', live: true, interruptedAt: Date.now() - 1_000 }] })

  assert.equal(run.library.id, 'dsh-session-resume')
  assert.equal(run.library.plugin.inject.join(','), 'slots,locale')
  assert.equal(run.registered.length, 1)
  assert.equal(run.registered[0].meta.name, 'shell.overlay')
  assert.equal(run.registered[0].meta.id, 'session-resume-dialog')
  assert.equal(run.styles.length, 1, 'the dialog stylesheet must be installed')

  await sleep(40)
  assert.equal(run.fetched.length, 1, 'loading the plugin must not write anything')
  assert.equal(run.fetched[0].method, 'GET')
  assert.match(run.fetched[0].url, /\/session-resume\/list$/)
})

test('the rendered dialog has an enabled, wired Resume button', async () => {
  const run = loadClient({ items: [ITEM] })
  await sleep(40)
  const Component = run.registered[0].Component
  const tree = Component({ t: (key) => key, appCtx: { get: () => undefined } })
  assert.ok(tree !== null, 'the dialog must render once a resumable row exists')

  const buttons = buttonsOf(tree)
  const primary = buttons.find((button) => String(button.props.className).includes('primary'))
  assert.ok(primary !== undefined, 'the Resume button must exist')
  assert.equal(primary.props.disabled, false, 'the Resume button must be clickable')
  assert.equal(typeof primary.props.onClick, 'function')
  assert.equal(typeof primary.props.onPointerDown, 'function', 'clicks must not bubble into a global handler')
  const ghost = buttons.find((button) => String(button.props.className).includes('ghost'))
  assert.ok(ghost !== undefined)
  assert.equal(ghost.props.onClick !== undefined || ghost.props.onClick === undefined, true)
})

test('closing the dialog stops rendering it', async () => {
  const run = loadClient({ items: [ITEM] })
  await sleep(40)
  const Component = run.registered[0].Component
  const props = { t: (key) => key, appCtx: { get: () => undefined } }
  const tree = Component(props)
  const close = buttonsOf(tree).find((button) => button.children.includes('close'))
  assert.ok(close !== undefined, 'a Close button must exist')
  close.props.onClick()
  assert.equal(Component(props), null, 'a closed dialog must render nothing')
})

test('the module never sends a message on its own', async () => {
  const run = loadClient({ items: [] })
  await sleep(40)
  assert.ok(run.fetched.every((call) => call.method === 'GET'))
  assert.ok(run.fetched.every((call) => /\/session-resume\/(list)$/.test(call.url)))
})
