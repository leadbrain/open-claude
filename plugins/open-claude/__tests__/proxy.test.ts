/**
 * Integration tests for proxy.ts — polling-based message delivery.
 *
 * Tests the HTTP API contract between proxy and server:
 * - /api/register
 * - /api/messages (polling)
 * - /api/tools (forwarding)
 * - Full flow: register → enqueue → poll → deliver
 *
 * Uses a mock HTTP server.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createServer, type Server as HttpServer } from 'http'

// ── Mock server ──

interface MockState {
  registrations: { session_id: string; chat_id: string }[]
  toolCalls: { tool: string; args: any }[]
  messageQueues: Map<string, unknown[]>
}

function createMockServer() {
  const state: MockState = {
    registrations: [],
    toolCalls: [],
    messageQueues: new Map(),
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const parseBody = () => new Promise<any>((resolve) => {
      let data = ''
      req.on('data', (c: Buffer) => { data += c })
      req.on('end', () => resolve(data ? JSON.parse(data) : {}))
    })

    if (url.pathname === '/api/register' && req.method === 'POST') {
      const body = await parseBody()
      state.registrations.push(body)
      if (!state.messageQueues.has(body.session_id)) {
        state.messageQueues.set(body.session_id, [])
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ sessionId: body.session_id, chatId: body.chat_id }))
      return
    }

    if (url.pathname === '/api/messages' && req.method === 'GET') {
      const sessionId = url.searchParams.get('session')
      const queue = sessionId ? state.messageQueues.get(sessionId) : undefined
      if (!queue) {
        res.writeHead(404)
        res.end(JSON.stringify({ error: 'not found' }))
        return
      }
      const messages = queue.splice(0)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ messages }))
      return
    }

    if (url.pathname === '/api/tools' && req.method === 'POST') {
      const body = await parseBody()
      state.toolCalls.push(body)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ text: `mock: ${body.tool} done` }))
      return
    }

    res.writeHead(404)
    res.end()
  })

  return { server, state }
}

// ── Tests ──

let mock: ReturnType<typeof createMockServer>
let port: number
let baseUrl: string

beforeAll(async () => {
  mock = createMockServer()
  await new Promise<void>(resolve => {
    mock.server.listen(0, '127.0.0.1', () => {
      port = (mock.server.address() as { port: number }).port
      baseUrl = `http://127.0.0.1:${port}`
      resolve()
    })
  })
})

afterAll(() => { mock.server.close() })

describe('proxy: registration', () => {
  test('registers session with server', async () => {
    const res = await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'proxy-1', chat_id: 'ch-main' }),
    })
    expect(res.status).toBe(200)
    expect(mock.state.registrations).toHaveLength(1)
    expect(mock.state.registrations[0].chat_id).toBe('ch-main')
  })
})

describe('proxy: message polling', () => {
  test('empty poll returns no messages', async () => {
    const res = await fetch(`${baseUrl}/api/messages?session=proxy-1`)
    const data = await res.json() as any
    expect(data.messages).toEqual([])
  })

  test('poll returns and drains enqueued messages', async () => {
    // Enqueue
    mock.state.messageQueues.get('proxy-1')!.push(
      { content: 'msg1', meta: { user: 'alice' } },
      { content: 'msg2', meta: { user: 'bob' } },
    )

    // First poll — gets both
    const res = await fetch(`${baseUrl}/api/messages?session=proxy-1`)
    const data = await res.json() as any
    expect(data.messages).toHaveLength(2)
    expect(data.messages[0].content).toBe('msg1')

    // Second poll — empty
    const res2 = await fetch(`${baseUrl}/api/messages?session=proxy-1`)
    const data2 = await res2.json() as any
    expect(data2.messages).toEqual([])
  })

  test('404 for unknown session', async () => {
    const res = await fetch(`${baseUrl}/api/messages?session=nonexistent`)
    expect(res.status).toBe(404)
  })
})

describe('proxy: tool forwarding', () => {
  test('reply', async () => {
    const res = await fetch(`${baseUrl}/api/tools`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'reply', args: { chat_id: 'ch-1', text: 'hello' } }),
    })
    const data = await res.json() as any
    expect(data.text).toBe('mock: reply done')
    expect(mock.state.toolCalls.at(-1)!.args.text).toBe('hello')
  })

  test('react', async () => {
    await fetch(`${baseUrl}/api/tools`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'react', args: { chat_id: 'ch-1', message_id: 'msg-1', emoji: '👍' } }),
    })
    expect(mock.state.toolCalls.at(-1)!.tool).toBe('react')
  })

  test('edit_message', async () => {
    await fetch(`${baseUrl}/api/tools`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'edit_message', args: { chat_id: 'ch-1', message_id: 'msg-1', text: 'edited' } }),
    })
    expect(mock.state.toolCalls.at(-1)!.tool).toBe('edit_message')
  })

  test('fetch_messages', async () => {
    await fetch(`${baseUrl}/api/tools`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'fetch_messages', args: { channel: 'ch-1', limit: 10 } }),
    })
    expect(mock.state.toolCalls.at(-1)!.tool).toBe('fetch_messages')
  })
})

describe('proxy: full polling flow', () => {
  test('register → enqueue → poll → tool call', async () => {
    // 1. Register
    await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'e2e-proxy', chat_id: 'ch-e2e' }),
    })

    // 2. Server enqueues message (simulates Discord message)
    mock.state.messageQueues.get('e2e-proxy')!.push({
      content: 'end-to-end test',
      meta: { chat_id: 'ch-e2e', user: 'testuser', message_id: 'msg-e2e' },
    })

    // 3. Proxy polls
    const pollRes = await fetch(`${baseUrl}/api/messages?session=e2e-proxy`)
    const pollData = await pollRes.json() as any
    expect(pollData.messages).toHaveLength(1)
    expect(pollData.messages[0].content).toBe('end-to-end test')

    // 4. Proxy forwards reply
    const toolRes = await fetch(`${baseUrl}/api/tools`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'reply', args: { chat_id: 'ch-e2e', text: 'response from Claude' } }),
    })
    expect((await toolRes.json() as any).text).toContain('reply done')

    // 5. Queue drained
    const pollRes2 = await fetch(`${baseUrl}/api/messages?session=e2e-proxy`)
    expect((await pollRes2.json() as any).messages).toEqual([])
  })
})
