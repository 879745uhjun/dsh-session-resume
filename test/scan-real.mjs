import { homedir } from 'node:os'
import { join } from 'node:path'
import { internals } from '../index.js'
const home = join(homedir(), '.dsh')
const scanner = internals.createScanner(home, () => ({}), (m, e) => console.warn('[warn]', m, e?.message ?? ''))
const items = await scanner.scan()
console.log(JSON.stringify({ count: items.length, items: items.map((i) => ({ id: i.sessionId, live: i.live, steps: i.steps, tool: i.runningTool, title: i.title.slice(0, 24), at: i.interruptedAt })) }, null, 1))
