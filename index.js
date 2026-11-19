/**
 * dsh-session-resume — Host half.
 *
 * Remembers which conversations were still mid-turn when DSH went away, so the
 * browser half can offer to pick the task up again after a restart. Nothing is
 * guessed at close time: a session log is an append-only event stream, so "the
 * last turn/start has no turn/end after it" is a durable fact that survives a
 * crash, a kill, or a power cut.
 *
 * The browser half reads it through same-origin /session-resume routes.
 *
 * @module dsh-session-resume
 */
import { open, readdir, readFile, rename, stat, writeFile, mkdir } from 'node:fs/promises'
import { zstdDecompressSync } from 'node:zlib'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Cordis plugin name. */
export const name = 'dsh-session-resume'

/** Browser-facing route prefix. */
const ROUTE = '/session-resume'
/** Only sessions touched inside this window are candidates. */
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
/** A log written this recently belongs to a turn that is probably still alive. */
const LIVE_WINDOW_MS = 45 * 1000
/** Bytes read from the tail of one log before falling back to the whole file. */
const TAIL_BYTES = 768 * 1024
/** Cap on log files examined per scan; the newest ones win. */
const MAX_SESSIONS = 500
/** zstd frame magic, little endian. */
const ZSTD_MAGIC = 0xfd2fb528
/** Session log name, e.g. session.v4.jsonl.zstd. */
const LOG_NAME = /^session\.v(\d+)\.jsonl(\.zstd)?$/
/** Longest text snippet handed to the browser per field. */
const SNIPPET = 400
/** Format version of the dismissal file. */
const FILE_VERSION = 1

/** One warning sink that reports each distinct failure once. */
function createLogger() {
  const seen = new Set()
  return (message, error) => {
    const key = error === undefined ? message : message + ': ' + (error?.code ?? error?.message ?? String(error))
    if (seen.has(key)) return
    seen.add(key)
    if (error !== undefined) console.warn('[session-resume] ' + message, error)
    else console.warn('[session-resume] ' + message)
  }
}

/** Walk the zstd container: the log appends one frame per write. */
function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === ZSTD_MAGIC) {
    let cursor = offset + 4
    const descriptor = buffer[cursor]
    cursor += 1
    const contentSizeFlag = descriptor >> 6
    const singleSegment = (descriptor >> 5) & 1
    const checksum = (descriptor >> 2) & 1
    const dictFlag = descriptor & 3
    if (!singleSegment) cursor += 1
    if (dictFlag !== 0) cursor += [0, 1, 2, 4][dictFlag]
    // Frame content size: flag 0 means "absent", except that a single-segment
    // frame always carries one byte; 1, 2 and 3 mean 2, 4 and 8 bytes.
    cursor += contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][contentSizeFlag]
    let end = -1
    for (;;) {
      if (cursor + 3 > buffer.length) break
      const blockHeader = buffer[cursor] | (buffer[cursor + 1] << 8) | (buffer[cursor + 2] << 16)
      cursor += 3
      const last = blockHeader & 1
      const type = (blockHeader >> 1) & 3
      const size = blockHeader >>> 3
      cursor += type === 1 ? 1 : size
      if (cursor > buffer.length) break
      if (last) {
        end = cursor + (checksum ? 4 : 0)
        break
      }
    }
    if (end < 0 || end > buffer.length) break
    frames.push({ start: offset, end })
    offset = end
  }
  return frames
}

/** Decode every complete frame in a buffer into one text body. */
function decodeFrames(raw) {
  const parts = []
  for (const frame of scanZstdFrames(raw)) {
    try {
      parts.push(zstdDecompressSync(raw.subarray(frame.start, frame.end)).toString('utf8'))
    } catch {
      /* a torn final frame while the log is still being written */
    }
  }
  return parts.join('')
}

/** Slide a buffer forward to the first zstd frame boundary. */
function alignToFrame(raw) {
  for (let offset = 0; offset < 64 && offset + 4 <= raw.length; offset += 1) {
    if (raw.readUInt32LE(offset) === ZSTD_MAGIC) return offset === 0 ? raw : raw.subarray(offset)
  }
  return raw
}

/** Parse one body of JSONL events, keeping the well-formed ones. */
function parseEvents(text) {
  const events = []
  let header = null
  for (const line of text.split('\n')) {
    if (line === '') continue
    let value
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    if (value === null || typeof value !== 'object') continue
    if (header === null && value.type === 'session') {
      header = value
      continue
    }
    if (Number.isFinite(value.time)) events.push(value)
  }
  return { header, events }
}

/** Read the tail of one log, falling back to the whole file when needed. */
async function readLog(path, size) {
  if (size <= TAIL_BYTES) {
    const parsed = parseEvents(decodeFrames(await readFile(path)))
    if (parsed.header !== null || parsed.events.length > 0) return parsed
  } else {
    const from = size - TAIL_BYTES
    const handle = await open(path, 'r')
    let slice
    try {
      const buffer = Buffer.alloc(size - from)
      const read = await handle.read(buffer, 0, buffer.length, from)
      slice = buffer.subarray(0, read.bytesRead)
    } finally {
      await handle.close()
    }
    const parsed = parseEvents(decodeFrames(alignToFrame(slice)))
    // A tail that lost the header cannot report the session's own facts; a tail
    // that lost the open turn/start would report a false "finished".
    if (parsed.header !== null && parsed.events.some((event) => event.type === 'turn/start')) return parsed
  }
  return parseEvents(decodeFrames(await readFile(path)))
}

/** Flatten a message content array into one plain sentence. */
function textOfContent(content, limit) {
  if (typeof content === 'string') return content.slice(0, limit)
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim().slice(0, limit)
}

/** The last user message body of an event. */
function userText(event) {
  return textOfContent(event.data?.content, SNIPPET)
}

/** The last assistant message body of an event. */
function assistantText(event) {
  const message = event.data?.message
  if (message !== undefined && message !== null) return textOfContent(message.content, SNIPPET)
  return textOfContent(event.data?.content, SNIPPET)
}

/** A short, human-usable name for a tool call. */
function toolLabel(name) {
  if (typeof name !== 'string' || name === '') return ''
  return name.length > 40 ? name.slice(0, 40) : name
}

/**
 * Reduce one session's events to the facts the resume dialog shows.
 * @returns null when the session is not waiting mid-turn.
 */
function summarize(sessionId, events, meta) {
  let openTurn = null
  let openTurnStart = 0
  let openSteps = 0
  let title = ''
  let firstUser = ''
  let lastUser = ''
  let lastAssistant = ''
  let lastEventTime = 0
  let lastEventType = ''
  let pending = new Map()
  let lastTool = ''
  let lastToolTime = 0
  let closedAt = 0

  for (const event of events) {
    if (event.time > lastEventTime) {
      lastEventTime = event.time
      lastEventType = event.type
    }
    switch (event.type) {
      case 'turn/start':
        openTurn = event.data?.turn ?? null
        openTurnStart = event.time
        openSteps = 0
        pending = new Map()
        break
      case 'turn/end':
        openTurn = null
        closedAt = event.time
        pending = new Map()
        break
      case 'step/start':
        if (openTurn !== null) openSteps += 1
        break
      case 'session/title': {
        const value = event.data?.title
        if (typeof value === 'string' && value.trim() !== '') title = value.trim()
        break
      }
      case 'user/message': {
        // Only the person's own messages count: DSH appends its own context
        // (runtime notes, step tails, skill catalogues) under other sources.
        if (event.data?.source?.kind !== 'user') break
        const text = userText(event)
        if (text === '') break
        if (firstUser === '') firstUser = text
        lastUser = text
        break
      }
      case 'assistant/message':
        lastAssistant = assistantText(event) || lastAssistant
        break
      case 'tool/call': {
        const name = toolLabel(event.data?.name)
        lastTool = name
        lastToolTime = event.time
        const callId = event.data?.callId
        if (typeof callId === 'string') pending.set(callId, name)
        break
      }
      case 'tool/result': {
        const callId = event.data?.message?.toolCallId ?? event.data?.toolCallId
        if (typeof callId === 'string') pending.delete(callId)
        break
      }
      default:
        break
    }
  }

  if (openTurn === null || lastEventTime === 0) return null

  const runningTool = pending.size > 0 ? [...pending.values()][pending.size - 1] : ''
  return {
    sessionId,
    title: title || (firstUser ? firstUser.slice(0, 60) : ''),
    task: firstUser,
    lastMessage: lastUser,
    progress: lastAssistant,
    turn: openTurn,
    steps: openSteps,
    interruptedAt: lastEventTime,
    turnStartedAt: openTurnStart,
    lastEventType,
    lastTool,
    lastToolAt: lastToolTime,
    runningTool,
    project: meta.project,
    cwd: meta.cwd ?? '',
    path: meta.path,
    size: meta.size,
    closedAt: closedAt || 0,
  }
}

/** Parse the dismissal file. */
function normalizeDismissed(raw) {
  const dismissed = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return dismissed
  for (const [sessionId, value] of Object.entries(raw)) {
    if (typeof sessionId !== 'string' || sessionId === '') continue
    const interruptedAt = Number(value)
    if (!Number.isFinite(interruptedAt)) continue
    dismissed[sessionId] = interruptedAt
  }
  return dismissed
}

/** One durable map of "I already dismissed this interruption". */
function createDismissStore(file, log) {
  let dismissed = {}
  let loaded = null
  let chain = Promise.resolve()

  function load() {
    if (loaded !== null) return loaded
    loaded = (async () => {
      try {
        dismissed = normalizeDismissed(JSON.parse(await readFile(file, 'utf8'))?.dismissed)
      } catch (error) {
        if (error?.code !== 'ENOENT') log('could not read ' + file, error)
      }
    })()
    return loaded
  }

  function persist() {
    const body = JSON.stringify({ version: FILE_VERSION, updatedAt: Date.now(), dismissed }, null, 2)
    chain = chain
      .then(async () => {
        await mkdir(dirname(file), { recursive: true })
        const temporary = file + '.' + process.pid + '.' + Date.now() + '.tmp'
        await writeFile(temporary, body, 'utf8')
        await rename(temporary, file)
      })
      .catch((error) => log('could not write ' + file, error))
    return chain
  }

  return {
    load,
    snapshot: () => ({ ...dismissed }),
    async dismiss(sessionId, interruptedAt) {
      await load()
      dismissed[sessionId] = Number.isFinite(interruptedAt) ? interruptedAt : Date.now()
      await persist()
      return { ...dismissed }
    },
    async forget(sessionId) {
      await load()
      if (sessionId in dismissed) {
        delete dismissed[sessionId]
        await persist()
      }
      return { ...dismissed }
    },
  }
}

/** Enumerate every session log under the DSH home, newest first. */
async function listLogs(home) {
  const root = join(home, 'sessions')
  const rows = []
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch {
    return rows
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    let sessions
    try {
      sessions = await readdir(join(root, project.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const dir = join(root, project.name, session.name)
      let files
      try {
        files = await readdir(dir)
      } catch {
        continue
      }
      const log = files.find((file) => LOG_NAME.test(file))
      if (log === undefined) continue
      const path = join(dir, log)
      try {
        const stats = await stat(path)
        rows.push({ sessionId: session.name, project: project.name, path, size: stats.size, mtime: stats.mtimeMs })
      } catch {
        /* vanished between listing and stat */
      }
    }
  }
  rows.sort((left, right) => right.mtime - left.mtime)
  return rows.slice(0, MAX_SESSIONS)
}

/** Cached per-log summaries; a log is re-read only when it grew. */
function createScanner(home, dismissed, log) {
  const cache = new Map()
  let inFlight = null

  function isDismissed(row) {
    const stamp = dismissed()[row.sessionId]
    return Number.isFinite(stamp) && stamp >= Math.floor(row.mtime)
  }

  async function readOne(row) {
    const key = row.path
    const cached = cache.get(key)
    if (cached !== undefined && cached.size === row.size && cached.mtime === row.mtime) return cached.result
    const parsed = await readLog(row.path, row.size)
    const meta = {
      project: row.project,
      cwd: typeof parsed.header?.cwd === 'string' ? parsed.header.cwd : '',
      path: row.path,
      size: row.size,
      createdAt: Number(parsed.header?.createdAt) || 0,
    }
    const result = summarize(row.sessionId, parsed.events, meta)
    cache.set(key, { size: row.size, mtime: row.mtime, result })
    return result
  }

  return {
    async scan() {
      const now = Date.now()
      const rows = await listLogs(home)
      const items = []
      for (const row of rows) {
        if (now - row.mtime > MAX_AGE_MS) continue
        if (isDismissed(row)) continue
        let result
        try {
          result = await readOne(row)
        } catch (error) {
          log('could not read ' + row.path, error)
          continue
        }
        if (result === null) continue
        // A log that is still being appended to is a live turn, not a leftover.
        const live = now - row.mtime < LIVE_WINDOW_MS
        items.push({ ...result, live, archived: false })
      }
      items.sort((left, right) => right.interruptedAt - left.interruptedAt)
      return items
    },
    async once() {
      if (inFlight === null) {
        inFlight = this.scan().finally(() => {
          inFlight = null
        })
      }
      return inFlight
    },
  }
}

/** Answer one JSON response. */
function sendJson(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}

/** Refuse a browser-marked cross-site call. */
function isAcceptableOrigin(request) {
  const origin = request.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  const host = request.headers.host
  if (typeof host !== 'string') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** Read a bounded UTF-8 request body. */
function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body is too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

/** Remember who asked, for /session-resume/diag. */
function recordHit(request, path) {
  RECENT_HITS.unshift({
    at: Date.now(),
    path,
    origin: request.headers.origin ?? null,
    referer: request.headers.referer ?? null,
    agent: String(request.headers['user-agent'] ?? '').slice(0, 60),
  })
  if (RECENT_HITS.length > RECENT_LIMIT) RECENT_HITS.length = RECENT_LIMIT
}

/** The browser-facing endpoints: one handler per exact route. */
function createHandlers(scanner, store, log) {
  /** Shared guard: same-origin check and one 500 fallback. */
  function guarded(run) {
    return async function handle(request, response) {
      try {
        if (!isAcceptableOrigin(request)) {
          sendJson(response, 403, { ok: false, error: 'cross-origin request refused' })
          return
        }
        await run(request, response)
      } catch (error) {
        log('request failed', error)
        try {
          sendJson(response, 500, { ok: false, error: 'internal error' })
        } catch {
          response.destroy()
        }
      }
    }
  }

  function methodNotAllowed(response) {
    response.writeHead(405, { allow: 'GET, POST', 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
  }

  const list = guarded(async (request, response) => {
    if (request.method !== 'GET') {
      methodNotAllowed(response)
      return
    }
    // The dismissal table lives in a file; a freshly started host has it in
    // memory only after load(), or every dismissal would reappear once.
    await store.load()
    const items = await scanner.once()
    const dismissed = store.snapshot()
    sendJson(response, 200, {
      ok: true,
      items: items.filter((item) => !(Number.isFinite(dismissed[item.sessionId]) && dismissed[item.sessionId] >= item.interruptedAt)),
      total: items.length,
    })
  })

  const mutation = (forget) => guarded(async (request, response) => {
    if (request.method !== 'POST') {
      methodNotAllowed(response)
      return
    }
    let payload
    try {
      payload = JSON.parse(await readBody(request, 8 * 1024))
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error.message === 'request body is too large' ? error.message : 'invalid JSON body' })
      return
    }
    const sessionId = payload?.sessionId
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      sendJson(response, 400, { ok: false, error: 'sessionId must be a non-empty string' })
      return
    }
    const dismissed = forget
      ? await store.forget(sessionId.trim())
      : await store.dismiss(sessionId.trim(), Number(payload?.interruptedAt))
    sendJson(response, 200, { ok: true, dismissed })
  })

  return { list, dismiss: mutation(false), forget: mutation(true) }
}

/** Internals exposed for the test suite; not part of the plugin contract. */
export const internals = { scanZstdFrames, decodeFrames, parseEvents, summarize, readLog, listLogs, createScanner, createDismissStore, createHandlers }

/**
 * Register the scanner and its browser routes.
 * @param ctx - Host context carrying the DSH home path.
 */
export function apply(ctx) {
  const homePath = ctx.get('dshHomePath')
  // dshHomePath names a file inside the DSH home; the directory is its parent.
  const home = typeof homePath === 'function' ? dirname(homePath('probe')) : join(homedir(), '.dsh')
  const log = createLogger()
  const store = createDismissStore(join(home, 'session-resume.json'), log)
  const scanner = createScanner(home, () => store.snapshot(), log)
  const handlers = createHandlers(scanner, store, log)

  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => {
      const remove = [
        scope.webServer.register({ kind: 'exact', path: ROUTE + '/list', handler: handlers.list }),
        scope.webServer.register({ kind: 'exact', path: ROUTE + '/dismiss', handler: handlers.dismiss }),
        scope.webServer.register({ kind: 'exact', path: ROUTE + '/forget', handler: handlers.forget }),,
      ]
      return () => {
        for (const off of remove) off()
      }
    }, 'session-resume: browser routes')
  })
}
