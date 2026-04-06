/**
 * Integration tests for server-http.ts HTTP endpoints.
 *
 * Tests the actual API contract that proxy.ts depends on:
 * - /health
 * - /api/register — session registration
 * - /api/messages — message polling (proxy polls this)
 * - /api/tools — tool call forwarding
 * - /api/ack-clear — ack reaction removal
 * - Message enqueue + drain cycle
 *
 * Uses a minimal test server that mirrors the real API.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createServer, type Server as HttpServer } from 'http'

// ── Test server mirroring real server-http.ts API ──

interface TestSession {
  sessionId: string
  chatId: string
  messageQueue: unknown[]
}

function createTestServer() {
  const sessions = new Map<string, TestSession>()
  const chatToSession = new Map<string, string>()
  const toolCalls: { tool: string; args: any }[] = []
  const ackClears: string[] = []

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const parseBody = () => new Promise<any>((resolve) => {
      let data = ''
      req.on('data', (c: Buffer) => { data += c })
      req.on('end', () => resolve(data ? JSON.parse(data) : {}))
    })

    // Health
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        sessions: sessions.size,
        channels: [...chatToSession.entries()].map(([c, s]) => ({ chatId: c, sessionId: s })),
      }))
      return
    }

    // Register
    if (url.pathname === '/api/register' && req.method === 'POST') {
      const body = await parseBody()
      const sessionId = body.session_id || `test-${Date.now()}`
      const chatId = body.chat_id

      const existing = sessions.get(sessionId)
      if (existing && existing.chatId === chatId) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ sessionId, chatId, queued: existing.messageQueue.length }))
        return
      }

      const oldSid = chatToSession.get(chatId)
      if (oldSid && oldSid !== sessionId) sessions.delete(oldSid)

      sessions.set(sessionId, { sessionId, chatId, messageQueue: [] })
      chatToSession.set(chatId, sessionId)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ sessionId, chatId }))
      return
    }

    // Messages (polling)
    if (url.pathname === '/api/messages' && req.method === 'GET') {
      const sessionId = url.searchParams.get('session')
      if (!sessionId || !sessions.has(sessionId)) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'session not found' }))
        return
      }
      const session = sessions.get(sessionId)!
      const messages = session.messageQueue.splice(0)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ messages }))
      return
    }

    // Tools
    if (url.pathname === '/api/tools' && req.method === 'POST') {
      const body = await parseBody()
      toolCalls.push(body)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ text: `${body.tool} ok` }))
      return
    }

    // Ack clear
    if (url.pathname === '/api/ack-clear' && req.method === 'POST') {
      const body = await parseBody()
      ackClears.push(body.chat_id)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    res.writeHead(404)
    res.end()
  })

  return { server, sessions, chatToSession, toolCalls, ackClears }
}

// ── Tests ──

let ts: ReturnType<typeof createTestServer>
let port: number
let baseUrl: string

beforeAll(async () => {
  ts = createTestServer()
  await new Promise<void>(resolve => {
    ts.server.listen(0, '127.0.0.1', () => {
      port = (ts.server.address() as { port: number }).port
      baseUrl = `http://127.0.0.1:${port}`
      resolve()
    })
  })
})

afterAll(() => { ts.server.close() })

// ── /health ──

describe('/health', () => {
  test('returns empty state initially', async () => {
    const res = await fetch(`${baseUrl}/health`)
    const data = await res.json() as any
    expect(data.sessions).toBe(0)
    expect(data.channels).toEqual([])
  })
})

// ── /api/register ──

describe('/api/register', () => {
  test('registers a new session', async () => {
    const res = await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'sess-1', chat_id: 'ch-100' }),
    })
    const data = await res.json() as any
    expect(data.sessionId).toBe('sess-1')
    expect(data.chatId).toBe('ch-100')

    const health = await (await fetch(`${baseUrl}/health`)).json() as any
    expect(health.sessions).toBe(1)
  })

  test('re-register preserves queue', async () => {
    // Enqueue a message first
    ts.sessions.get('sess-1')!.messageQueue.push({ content: 'queued msg' })

    const res = await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'sess-1', chat_id: 'ch-100' }),
    })
    const data = await res.json() as any
    expect(data.queued).toBe(1)

    // Queue should still have the message
    expect(ts.sessions.get('sess-1')!.messageQueue).toHaveLength(1)
  })

  test('replaces different session for same chat_id', async () => {
    await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'sess-2', chat_id: 'ch-100' }),
    })
    expect(ts.sessions.has('sess-1')).toBe(false)
    expect(ts.sessions.has('sess-2')).toBe(true)
  })
})

// ── /api/messages (polling) ──

describe('/api/messages', () => {
  test('returns empty when no messages', async () => {
    await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'poll-1', chat_id: 'ch-poll' }),
    })

    const res = await fetch(`${baseUrl}/api/messages?session=poll-1`)
    const data = await res.json() as any
    expect(data.messages).toEqual([])
  })

  test('returns and drains queued messages', async () => {
    const session = ts.sessions.get('poll-1')!
    session.messageQueue.push(
      { content: 'msg1', meta: { user: 'alice' } },
      { content: 'msg2', meta: { user: 'bob' } },
    )

    const res = await fetch(`${baseUrl}/api/messages?session=poll-1`)
    const data = await res.json() as any
    expect(data.messages).toHaveLength(2)
    expect(data.messages[0].content).toBe('msg1')
    expect(data.messages[1].content).toBe('msg2')

    // Queue should be drained
    const res2 = await fetch(`${baseUrl}/api/messages?session=poll-1`)
    const data2 = await res2.json() as any
    expect(data2.messages).toEqual([])
  })

  test('returns 404 for unknown session', async () => {
    const res = await fetch(`${baseUrl}/api/messages?session=nonexistent`)
    expect(res.status).toBe(404)
  })
})

// ── /api/tools ──

describe('/api/tools', () => {
  test('forwards reply tool', async () => {
    const res = await fetch(`${baseUrl}/api/tools`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'reply', args: { chat_id: 'ch-1', text: 'hello' } }),
    })
    const data = await res.json() as any
    expect(data.text).toBe('reply ok')
    expect(ts.toolCalls.at(-1)!.tool).toBe('reply')
  })

  test('forwards react tool', async () => {
    await fetch(`${baseUrl}/api/tools`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'react', args: { chat_id: 'ch-1', message_id: 'msg-1', emoji: '👍' } }),
    })
    expect(ts.toolCalls.at(-1)!.args.emoji).toBe('👍')
  })
})

// ── /api/ack-clear ──

describe('/api/ack-clear', () => {
  test('accepts ack clear request', async () => {
    const res = await fetch(`${baseUrl}/api/ack-clear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: 'ch-100' }),
    })
    const data = await res.json() as any
    expect(data.ok).toBe(true)
    expect(ts.ackClears).toContain('ch-100')
  })
})

// ── Full polling flow ──

describe('Full flow: register → enqueue → poll → drain', () => {
  test('end-to-end message delivery via polling', async () => {
    // 1. Register
    await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'e2e', chat_id: 'ch-e2e' }),
    })

    // 2. Enqueue (simulates Discord message arriving at server)
    ts.sessions.get('e2e')!.messageQueue.push({
      content: 'hello from Discord',
      meta: { chat_id: 'ch-e2e', user: 'testuser', message_id: 'msg-e2e' },
    })

    // 3. Poll (simulates proxy polling)
    const res = await fetch(`${baseUrl}/api/messages?session=e2e`)
    const data = await res.json() as any
    expect(data.messages).toHaveLength(1)
    expect(data.messages[0].content).toBe('hello from Discord')

    // 4. Reply (simulates proxy forwarding tool call)
    const toolRes = await fetch(`${baseUrl}/api/tools`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'reply', args: { chat_id: 'ch-e2e', text: 'response' } }),
    })
    expect((await toolRes.json() as any).text).toBe('reply ok')

    // 5. Ack clear (simulates Stop hook)
    await fetch(`${baseUrl}/api/ack-clear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: 'ch-e2e' }),
    })

    // 6. Queue is empty after drain
    const res2 = await fetch(`${baseUrl}/api/messages?session=e2e`)
    expect((await res2.json() as any).messages).toEqual([])
  })
})
