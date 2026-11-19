import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { apply } from '../index.js'

const HEADER = { type: 'session', version: 4, id: 'session-unfinished', createdAt: 1000, cwd: 'D:/x' }

/** Start the plugin's routes against a scratch DSH home, the way the host does. */
async function startHost(home) {
  const handlers = new Map()
  const ctx = {
    get: (name) => (name === 'dshHomePath' ? (file) => join(home, file) : undefined),
    effect: (fn) => {
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    inject: (names, fn) => fn({
      effect: (inner) => inner(),
      webServer: {
        register: ({ path, handler }) => {
          handlers.set(path, handler)
          return () => handlers.delete(path)
        },
      },
    }),
  }
  apply(ctx)
  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url ?? '/', 'http://localhost')
    const handler = handlers.get(pathname)
    if (handler === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('not found')
      return
    }
    void handler(request, response)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    base: 'http://127.0.0.1:' + server.address().port,
    routes: [...handlers.keys()],
    close: () => new Promise((resolve) => {
      server.closeAllConnections()
      server.close(resolve)
    }),
  }
}

/** A scratch DSH home holding one interrupted session log, older than the live window. */
async function homeWithUnfinishedTurn() {
  const root = await mkdtemp(join(tmpdir(), 'resume-home-'))
  const dir = join(root, 'sessions', '--D-x--', 'session-unfinished')
  await mkdir(dir, { recursive: true })
  const log = join(dir, 'session.v4.jsonl.zstd')
  await writeFile(log, Buffer.concat([
    zstdCompressSync(Buffer.from(JSON.stringify(HEADER) + '\n', 'utf8')),
    zstdCompressSync(Buffer.from([
      JSON.stringify({ type: 'user/message', time: 1050, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '把报告整理完' }] } }),
      JSON.stringify({ type: 'turn/start', time: 1100, data: { turn: 1 } }),
      JSON.stringify({ type: 'step/start', time: 1110, data: { turn: 1, step: 1 } }),
      JSON.stringify({ type: 'tool/call', time: 1120, data: { turn: 1, step: 1, callId: 'c1', name: 'ops_bash', arguments: '{}' } }),
    ].join('\n') + '\n', 'utf8')),
  ]))
  const old = new Date(Date.now() - 10 * 60 * 1000)
  await utimes(log, old, old)
  return root
}

test('routes answer 200 on the list, 405 on the wrong method, 404 when unregistered', async () => {
  const home = await homeWithUnfinishedTurn()
  const host = await startHost(home)
  try {
    assert.deepEqual([...host.routes].sort(), ['/session-resume/dismiss', '/session-resume/forget', '/session-resume/list'])

    const list = await fetch(host.base + '/session-resume/list')
    assert.equal(list.status, 200)
    const payload = await list.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.items.length, 1)
    assert.equal(payload.items[0].sessionId, 'session-unfinished')
    assert.equal(payload.items[0].task, '把报告整理完')
    assert.equal(payload.items[0].runningTool, 'ops_bash')
    assert.equal(payload.items[0].live, false)

    const missing = await fetch(host.base + '/session-resume/nope')
    assert.equal(missing.status, 404)

    const wrongMethod = await fetch(host.base + '/session-resume/dismiss')
    assert.equal(wrongMethod.status, 405)

    const badBody = await fetch(host.base + '/session-resume/dismiss', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(badBody.status, 400)
  } finally {
    await host.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('a dismissal is written to disk and still hides the item after a host restart', async () => {
  const home = await homeWithUnfinishedTurn()
  const first = await startHost(home)
  let interruptedAt = 0
  try {
    const payload = await (await fetch(first.base + '/session-resume/list')).json()
    interruptedAt = payload.items[0].interruptedAt
    const dismissed = await fetch(first.base + '/session-resume/dismiss', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-unfinished', interruptedAt }),
    })
    assert.equal(dismissed.status, 200)
    const afterDismiss = await (await fetch(first.base + '/session-resume/list')).json()
    assert.equal(afterDismiss.items.length, 0)

    const stored = JSON.parse(await readFile(join(home, 'session-resume.json'), 'utf8'))
    assert.equal(stored.dismissed['session-unfinished'], interruptedAt)
  } finally {
    await first.close()
  }

  // A fresh apply() is what a restart looks like: new store, same file on disk.
  const second = await startHost(home)
  try {
    const afterRestart = await (await fetch(second.base + '/session-resume/list')).json()
    assert.equal(afterRestart.items.length, 0, 'a dismissal must survive the restart')

    const forgotten = await fetch(second.base + '/session-resume/forget', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-unfinished' }),
    })
    assert.equal(forgotten.status, 200)
    const restored = await (await fetch(second.base + '/session-resume/list')).json()
    assert.equal(restored.items.length, 1)
  } finally {
    await second.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('an empty or corrupt log reports nothing instead of failing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'resume-bad-'))
  const project = join(home, 'sessions', '--D-x--')
  const empty = join(project, 'session-empty')
  const corrupt = join(project, 'session-corrupt')
  await mkdir(empty, { recursive: true })
  await mkdir(corrupt, { recursive: true })
  await writeFile(join(empty, 'session.v4.jsonl.zstd'), Buffer.alloc(0))
  await writeFile(join(corrupt, 'session.v4.jsonl.zstd'), Buffer.from('not a zstd frame at all\n{broken json\n', 'utf8'))
  const old = new Date(Date.now() - 10 * 60 * 1000)
  await utimes(join(empty, 'session.v4.jsonl.zstd'), old, old)
  await utimes(join(corrupt, 'session.v4.jsonl.zstd'), old, old)
  const host = await startHost(home)
  try {
    const response = await fetch(host.base + '/session-resume/list')
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.deepEqual(payload.items, [])
  } finally {
    await host.close()
    await rm(home, { recursive: true, force: true })
  }
})
