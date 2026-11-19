import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

const handlers = new Map()
const ctx = {
  get(name) {
    if (name === 'dshHomePath') return (file) => join(homedir(), '.dsh', file)
    return undefined
  },
  effect(fn) {
    const dispose = fn()
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  },
  inject(names, fn) {
    fn({
      effect: (inner) => inner(),
      webServer: {
        register({ path, handler }) {
          handlers.set(path, handler)
          return () => handlers.delete(path)
        },
      },
    })
  },
}

apply(ctx)
console.log('routes:', [...handlers.keys()].join(', '))

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost')
  for (const [path, handler] of handlers) {
    if (url.pathname === path || url.pathname.startsWith(path + '/')) {
      void handler(request, response)
      return
    }
  }
  response.writeHead(404).end('no route')
})
server.listen(4789, '127.0.0.1', () => console.log('listening 4789'))
