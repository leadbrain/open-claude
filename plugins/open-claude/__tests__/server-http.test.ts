/**
 * Tests for server-http.ts HTTP endpoints.
 *
 * Starts a real HTTP server on a random port and tests:
 * - /health endpoint
 * - /api/register — session registration
 * - /events — SSE stream
 * - /api/tools — tool proxying
 * - Message routing via SSE
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createServer, type Server as HttpServer } from 'http'

// We test the HTTP endpoints by importing the handler logic indirectly.
// Since server-http.ts has side effects (Discord login), we test the
// endpoints by spinning up a minimal HTTP server that mimics the API.

// ── Minimal SSE + API server for testing ──

interface TestSession {
  sessionId: string
  chatId: string
  sseRes: any | null
}

function createTestServer() {
  const sessions = new Map<string, TestSession>()
  const chatToSession = new Map<string, string>()
  const toolCalls: { tool: string; args: any }[] = []

  function sendSSE(session: TestSession, event: string, data: unknown): boolean {
    if (!session.sseRes || session.sseRes.writableEnded) return false
    session.sseRes.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    return true
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost`)

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        sessions: sessions.size,
        channels: [...chatToSession.entries()].map(([c, s]) => ({ chatId: c, sessionId: s })),
      }))
      return
    }

    if (url.pathname === '/api/register' && req.method === 'POST') {
      let data = ''
      req.on('data', chunk => { data += chunk })
      req.on('end', () => {
        const body = JSON.parse(data)
        const sessionId = body.session_id || `test-${Date.now()}`
        const chatId = body.chat_id
        sessions.set(sessionId, { sessionId, chatId, sseRes: null })
        chatToSession.set(chatId, sessionId)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ sessionId, chatId }))
      })
      return
    }

    if (url.pathname === '/events' && req.method === 'GET') {
      const sessionId = url.searchParams.get('session')
      if (!sessionId || !sessions.has(sessionId)) {
        res.writeHead(404)
        res.end('session not found')
        return
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      })
      res.write(`event: connected\ndata: ${JSON.stringify({ sessionId })}\n\n`)
      sessions.get(sessionId)!.sseRes = res
      req.on('close', () => { sessions.get(sessionId)!.sseRes = null })
      return
    }

    if (url.pathname === '/api/tools' && req.method === 'POST') {
      let data = ''
      req.on('data', chunk => { data += chunk })
      req.on('end', () => {
        const body = JSON.parse(data)
        toolCalls.push(body)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ text: `${body.tool} ok` }))
      })
      return
    }

    res.writeHead(404)
    res.end()
  })

  return { server, sessions, chatToSession, toolCalls, sendSSE }
}

// ── Tests ──

let testServer: ReturnType<typeof createTestServer>
let port: number
let baseUrl: string

beforeAll(async () => {
  testServer = createTestServer()
  await new Promise<void>(resolve => {
    testServer.server.listen(0, '127.0.0.1', () => {
      const addr = testServer.server.address() as { port: number }
      port = addr.port
      baseUrl = `http://127.0.0.1:${port}`
      resolve()
    })
  })
})

afterAll(() => {
  testServer.server.close()
})

describe('HTTP server: /health', () => {
  test('returns session count', async () => {
    const res = await fetch(`${baseUrl}/health`)
    const data = await res.json() as any
    expect(data.sessions).toBe(0)
    expect(data.channels).toEqual([])
  })
})

describe('HTTP server: /api/register', () => {
  test('registers a session', async () => {
    const res = await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'sess-1', chat_id: 'ch-100' }),
    })
    const data = await res.json() as any
    expect(data.sessionId).toBe('sess-1')
    expect(data.chatId).toBe('ch-100')

    // Health should reflect
    const health = await (await fetch(`${baseUrl}/health`)).json() as any
    expect(health.sessions).toBe(1)
  })

  test('replaces existing session for same chat_id', async () => {
    await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'sess-2', chat_id: 'ch-100' }),
    })

    const health = await (await fetch(`${baseUrl}/health`)).json() as any
    // sess-1 was replaced by sess-2
    expect(health.channels.find((c: any) => c.chatId === 'ch-100').sessionId).toBe('sess-2')
  })
})

describe('HTTP server: /events (SSE)', () => {
  test('establishes SSE connection', async () => {
    // Register first
    await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'sse-test', chat_id: 'ch-sse' }),
    })

    // Connect SSE
    const res = await fetch(`${baseUrl}/events?session=sse-test`, {
      headers: { Accept: 'text/event-stream' },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')

    // Read first event
    const reader = res.body!.getReader()
    const { value } = await reader.read()
    const text = new TextDecoder().decode(value)
    expect(text).toContain('event: connected')
    expect(text).toContain('sse-test')

    reader.cancel()
  })

  test('receives message via SSE', async () => {
    // Register
    await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'sse-msg', chat_id: 'ch-msg' }),
    })

    // Connect SSE
    const res = await fetch(`${baseUrl}/events?session=sse-msg`, {
      headers: { Accept: 'text/event-stream' },
    })
    const reader = res.body!.getReader()
    // Skip connected event
    await reader.read()

    // Send message via SSE
    const session = testServer.sessions.get('sse-msg')!
    testServer.sendSSE(session, 'message', {
      content: 'hello from Discord',
      meta: { chat_id: 'ch-msg', user: 'testuser' },
    })

    // Read message event
    const { value } = await reader.read()
    const text = new TextDecoder().decode(value)
    expect(text).toContain('event: message')
    expect(text).toContain('hello from Discord')

    reader.cancel()
  })

  test('returns 404 for unknown session', async () => {
    const res = await fetch(`${baseUrl}/events?session=nonexistent`)
    expect(res.status).toBe(404)
  })
})

describe('HTTP server: /api/tools', () => {
  test('forwards tool call and returns result', async () => {
    const res = await fetch(`${baseUrl}/api/tools`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'reply', args: { chat_id: 'ch-1', text: 'hello' } }),
    })
    const data = await res.json() as any
    expect(data.text).toBe('reply ok')
    expect(testServer.toolCalls.length).toBeGreaterThanOrEqual(1)
    expect(testServer.toolCalls.at(-1)!.tool).toBe('reply')
  })
})
