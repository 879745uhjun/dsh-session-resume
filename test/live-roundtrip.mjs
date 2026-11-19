import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.RESUME_BASE ?? 'http://127.0.0.1:58214'
const file = join(homedir(), '.dsh', 'session-resume.json')

async function list() {
  const response = await fetch(BASE + '/session-resume/list', { headers: { accept: 'application/json' }, cache: 'no-store' })
  const payload = await response.json()
  return { status: response.status, items: payload.items ?? [], total: payload.total }
}

const first = await list()
console.log('GET /list      :', first.status, 'items=' + first.items.length)
for (const item of first.items) {
  console.log('  -', item.sessionId.slice(0, 20), 'live=' + item.live, 'steps=' + item.steps, 'tool=' + (item.runningTool || '-'))
}

const target = first.items.find((item) => item.live !== true)
if (target === undefined) {
  console.log('no non-live item to exercise; nothing else touched')
  process.exit(0)
}

const dismissResponse = await fetch(BASE + '/session-resume/dismiss', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: target.sessionId, interruptedAt: target.interruptedAt }),
})
console.log('POST /dismiss  :', dismissResponse.status, JSON.stringify(await dismissResponse.json()).slice(0, 120))

const afterDismiss = await list()
console.log('after dismiss  :', afterDismiss.status, 'items=' + afterDismiss.items.length,
  'hidden=' + !afterDismiss.items.some((item) => item.sessionId === target.sessionId))

const stored = JSON.parse(await readFile(file, 'utf8'))
console.log('file on disk   :', file, 'has entry=' + Object.hasOwn(stored.dismissed ?? {}, target.sessionId),
  JSON.stringify(stored.dismissed ?? {}).slice(0, 120))

const forgetResponse = await fetch(BASE + '/session-resume/forget', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: target.sessionId }),
})
console.log('POST /forget   :', forgetResponse.status)

const afterForget = await list()
console.log('after forget   :', afterForget.status, 'items=' + afterForget.items.length,
  'restored=' + afterForget.items.some((item) => item.sessionId === target.sessionId))
