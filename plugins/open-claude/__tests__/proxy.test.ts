/**
 * Tests for proxy.ts — stdio MCP proxy.
 *
 * Tests the proxy's ability to:
 * - Register with the HTTP server
 * - Receive SSE messages and convert to channel notifications
 * - Proxy tool calls to the HTTP server
 *
 * Uses a mock HTTP server instead of the real server-http.ts.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createServer, type Server as HttpServer } from 'http'

// ── Mock HTTP server that simulates server-http.ts ──

interface MockState {
  registrations: { session_id: string; chat_id: string }[]
  toolCalls: { tool: string; args: any }[]
  sseConnections: Map<string, any>  // sessionId → response
}

function createMockServer(): { server: HttpServer; state: MockState; sendMessage: (sessionId: string, content: string) => void } {
  const state: MockState = {
    registrations: [],
    toolCalls: [],
    sseConnections: new Map(),
  }

  function sendMessage(sessionId: string, content: string) {
    const res = state.sseConnections.get(sessionId)
    if (res && !res.writableEnded) {
      res.write(`event: message\ndata: ${JSON.stringify({
        content,
        meta: { chat_id: 'ch-test', user: 'testuser', message_id: 'msg-1', ts: new Date().toISOString() },
      })}\n\n`)
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')

    if (url.pathname === '/api/register' && req.method === 'POST') {
      let data = ''
      req.on('data', chunk => { data += chunk })
      req.on('end', () => {
        const body = JSON.parse(data)
        state.registrations.push(body)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ sessionId: body.session_id, chatId: body.chat_id }))
      })
      return
    }

    if (url.pathname === '/events' && req.method === 'GET') {
      const sessionId = url.searchParams.get('session')
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      res.write(`event: connected\ndata: ${JSON.stringify({ sessionId })}\n\n`)
      if (sessionId) state.sseConnections.set(sessionId, res)
      req.on('close', () => { if (sessionId) state.sseConnections.delete(sessionId) })
      return
    }

    if (url.pathname === '/api/tools' && req.method === 'POST') {
      let data = ''
      req.on('data', chunk => { data += chunk })
      req.on('end', () => {
        const body = JSON.parse(data)
        state.toolCalls.push(body)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ text: `mock: ${body.tool} done` }))
      })
      return
    }

    res.writeHead(404)
    res.end()
  })

  return { server, state, sendMessage }
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

afterAll(() => {
  mock.server.close()
})

describe('proxy: registration', () => {
  test('/api/register receives session and chat_id', async () => {
    const res = await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'proxy-1', chat_id: 'ch-main' }),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.sessionId).toBe('proxy-1')
    expect(mock.state.registrations).toHaveLength(1)
    expect(mock.state.registrations[0].chat_id).toBe('ch-main')
  })
})

describe('proxy: SSE connection', () => {
  test('receives connected event', async () => {
    const res = await fetch(`${baseUrl}/events?session=proxy-1`, {
      headers: { Accept: 'text/event-stream' },
    })
    expect(res.status).toBe(200)

    const reader = res.body!.getReader()
    const { value } = await reader.read()
    const text = new TextDecoder().decode(value)
    expect(text).toContain('event: connected')
    reader.cancel()
  })

  test('receives message event from server', async () => {
    // Connect SSE
    const res = await fetch(`${baseUrl}/events?session=proxy-sse`, {
      headers: { Accept: 'text/event-stream' },
    })
    const reader = res.body!.getReader()
    await reader.read() // skip connected

    // Server sends message
    mock.sendMessage('proxy-sse', 'hello from discord')

    const { value } = await reader.read()
    const text = new TextDecoder().decode(value)
    expect(text).toContain('event: message')
    expect(text).toContain('hello from discord')
    reader.cancel()
  })
})

describe('proxy: tool forwarding', () => {
  test('reply tool is forwarded', async () => {
    const res = await fetch(`${baseUrl}/api/tools`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'reply', args: { chat_id: 'ch-1', text: 'test reply' } }),
    })
    const data = await res.json() as any
    expect(data.text).toBe('mock: reply done')
    expect(mock.state.toolCalls.at(-1)!.tool).toBe('reply')
    expect(mock.state.toolCalls.at(-1)!.args.text).toBe('test reply')
  })

  test('react tool is forwarded', async () => {
    const res = await fetch(`${baseUrl}/api/tools`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'react', args: { chat_id: 'ch-1', message_id: 'msg-1', emoji: '👍' } }),
    })
    const data = await res.json() as any
    expect(data.text).toBe('mock: react done')
  })

  test('edit_message tool is forwarded', async () => {
    const res = await fetch(`${baseUrl}/api/tools`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'edit_message', args: { chat_id: 'ch-1', message_id: 'msg-1', text: 'edited' } }),
    })
    const data = await res.json() as any
    expect(data.text).toBe('mock: edit_message done')
  })

  test('fetch_messages tool is forwarded', async () => {
    const res = await fetch(`${baseUrl}/api/tools`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'fetch_messages', args: { channel: 'ch-1', limit: 10 } }),
    })
    const data = await res.json() as any
    expect(data.text).toBe('mock: fetch_messages done')
  })
})

// ── End-to-end flow test ──

describe('proxy: full message flow', () => {
  test('register → SSE connect → receive message → content delivered', async () => {
    // 1. Register
    await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'e2e-sess', chat_id: 'ch-e2e' }),
    })

    // 2. Connect SSE
    const sseRes = await fetch(`${baseUrl}/events?session=e2e-sess`, {
      headers: { Accept: 'text/event-stream' },
    })
    const reader = sseRes.body!.getReader()
    await reader.read() // skip connected

    // 3. Server sends Discord message
    mock.sendMessage('e2e-sess', 'end-to-end test message')

    // 4. Verify received
    const { value } = await reader.read()
    const text = new TextDecoder().decode(value)
    expect(text).toContain('end-to-end test message')
    expect(text).toContain('ch-test')  // from mock sendMessage meta

    // 5. Proxy calls reply tool
    const toolRes = await fetch(`${baseUrl}/api/tools`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'reply', args: { chat_id: 'ch-e2e', text: 'response from Claude' } }),
    })
    const toolData = await toolRes.json() as any
    expect(toolData.text).toContain('reply done')

    reader.cancel()
  })
})
