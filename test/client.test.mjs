import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const SOURCE = await readFile(new URL('../client.js', import.meta.url), 'utf8')

const ReactStub = {
  createElement: () => null,
  useCallback: (fn) => fn,
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
  useState: (value) => [value, () => {}],
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
  const window = {
    __ModuleLoader__: {
      load: ({ id, factory }) => {
        library.id = id
        library.plugin = factory((name) => (name === 'react' ? ReactStub : {}))
      },
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  const document = {
    createElement: () => ({ setAttribute: () => {}, remove: () => {}, style: {}, textContent: '' }),
    head: { appendChild: (node) => styles.push(node) },
    querySelector: () => null,
    querySelectorAll: () => [],
    documentElement: { getAttribute: () => null },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  const library = { id: null, plugin: null }
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
  }
  sandbox.globalThis = sandbox
  vm.runInNewContext(SOURCE, sandbox, { filename: 'client.js' })
  library.plugin.apply(context)
  return { library, registered, fetched, styles }
}

test('the browser half registers one overlay dialog and asks the host once', async () => {
  const run = loadClient({
    items: [
      { sessionId: 'session-a', title: 'A', live: false, interruptedAt: Date.now() - 60000, steps: 3, runningTool: 'ops_bash', task: '整理报告' },
      { sessionId: 'session-b', title: 'B', live: true, interruptedAt: Date.now() - 1000, steps: 1, runningTool: '', task: '还在这跑' },
    ],
  })

  assert.equal(run.library.id, 'dsh-session-resume')
  assert.equal(run.library.plugin.inject.join(','), 'slots,locale')
  assert.equal(run.registered.length, 1)
  assert.equal(run.registered[0].meta.name, 'shell.overlay')
  assert.equal(run.registered[0].meta.id, 'session-resume-dialog')
  assert.equal(typeof run.registered[0].Component, 'function')
  assert.equal(run.styles.length, 1, 'the dialog stylesheet must be installed')

  // Let the startup scan settle.
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(run.fetched.length, 1, 'loading the plugin must not write anything')
  assert.equal(run.fetched[0].method, 'GET')
  assert.match(run.fetched[0].url, /\/session-resume\/list$/)
})

test('the module never sends a message on its own', async () => {
  const run = loadClient({ items: [] })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.ok(run.fetched.every((call) => call.method === 'GET'))
  assert.ok(run.fetched.every((call) => /\/session-resume\/(list)$/.test(call.url)))
})
