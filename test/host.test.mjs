import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { internals } from '../index.js'

const HEADER = { type: 'session', version: 4, id: 'session-test', createdAt: 1000, cwd: 'D:/x' }

function event(type, time, data) {
  return JSON.stringify({ type, time, data })
}

/** Write a log the way DSH does: one zstd frame per appended batch. */
async function writeLog(dir, batches) {
  const body = Buffer.concat(batches.map((lines) => zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'))))
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), body)
  return body
}

async function scratch() {
  const root = await mkdtemp(join(tmpdir(), 'resume-'))
  const dir = join(root, 'sessions', '--D-x--', 'session-test')
  await mkdir(dir, { recursive: true })
  return { root, dir }
}

test('a finished turn is not reported', async () => {
  const { root, dir } = await scratch()
  try {
    const size = (await writeLog(dir, [
      [JSON.stringify(HEADER)],
      [event('turn/start', 1100, { turn: 1 }), event('step/start', 1110, { turn: 1, step: 1 })],
      [event('tool/call', 1120, { turn: 1, step: 1, callId: 'c1', name: 'ops_bash', arguments: '{}' })],
      [event('tool/result', 1150, { turn: 1, step: 1, message: { toolCallId: 'c1', content: [] } })],
      [event('turn/end', 1200, { turn: 1 })],
    ])).length
    const parsed = await internals.readLog(join(dir, 'session.v4.jsonl.zstd'), size)
    assert.equal(parsed.header.id, 'session-test')
    assert.equal(internals.summarize('session-test', parsed.events, { project: 'p', path: 'x', size, cwd: 'D:/x' }), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an unfinished turn reports the running tool and the task', async () => {
  const { root, dir } = await scratch()
  try {
    const size = (await writeLog(dir, [
      [JSON.stringify(HEADER)],
      [event('user/message', 1050, { source: { kind: 'user' }, content: [{ type: 'text', text: '做一个插件，当 DSH 关闭后保留记录' }] })],
      [event('user/message', 1055, { source: { kind: 'time-context' }, content: [{ type: 'text', text: 'Time sampled while preparing turn 1, step 2' }] })],
      [event('session/title', 1060, { title: '断点续跑插件' })],
      [event('turn/start', 1100, { turn: 2 }), event('step/start', 1110, { turn: 2, step: 1 })],
      [event('assistant/message', 1125, { turn: 2, step: 1, message: { content: [{ type: 'text', text: '我先看接口。' }] } })],
      [
        event('tool/call', 1140, { turn: 2, step: 1, callId: 'c9', name: 'ops_bash', arguments: '{"description":"x"}' }),
        event('step/start', 1150, { turn: 2, step: 2 }),
      ],
    ])).length
    const parsed = await internals.readLog(join(dir, 'session.v4.jsonl.zstd'), size)
    const item = internals.summarize('session-test', parsed.events, { project: 'p', path: 'x', size, cwd: 'D:/x' })
    assert.ok(item, 'the open turn must produce a resume item')
    assert.equal(item.turn, 2)
    assert.equal(item.steps, 2)
    assert.equal(item.runningTool, 'ops_bash')
    assert.equal(item.title, '断点续跑插件')
    assert.equal(item.task, '做一个插件，当 DSH 关闭后保留记录')
    assert.equal(item.progress, '我先看接口。')
    assert.equal(item.interruptedAt, 1150)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a tail read keeps the open turn from earlier frames', async () => {
  const { root, dir } = await scratch()
  try {
    const filler = []
    for (let index = 0; index < 60; index += 1) {
      filler.push(event('tool/result', 1200 + index, { turn: 1, step: 1, message: { toolCallId: 'c' + index, content: [{ type: 'text', text: 'x'.repeat(9000) }] } }))
    }
    const size = (await writeLog(dir, [
      [JSON.stringify(HEADER)],
      [event('turn/start', 1100, { turn: 1 })],
      filler,
    ])).length
    const parsed = await internals.readLog(join(dir, 'session.v4.jsonl.zstd'), size)
    const item = internals.summarize('session-test', parsed.events, { project: 'p', path: 'x', size, cwd: 'D:/x' })
    assert.ok(item, 'the turn/start lives outside the tail window and must still be found')
    assert.equal(item.turn, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
