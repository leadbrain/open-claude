/**
 * Core integration tests — tests for core.ts (MCP tools, gate, handleInbound).
 *
 * In the new architecture, core.ts handles:
 * - MCP tool calls (reply, react, edit, fetch, search)
 * - gate() for access control decisions
 * - handleInbound() for pre-gated message delivery (dedup + typing + notification)
 *
 * Gate, bot filter, scheduler, and routing are server responsibilities (server-http.ts).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { join } from 'path'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { createOpenClaude, AccessManager, type OpenClaudeConfig } from '../core.ts'
import type {
  PlatformAdapter,
  PlatformMessage,
  PlatformAttachment,
  SendOptions,
  FetchedMessage,
} from '../platform.ts'
import { defaultAccess, type Access } from '../lib.ts'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

// ── Mock MCP Transport ──

class MockTransport implements Transport {
  notifications: any[] = []
  onclose?: () => void
  onerror?: (err: Error) => void
  onmessage?: (msg: any) => void

  async start() {}
  async close() { this.onclose?.() }
  async send(message: any) {
    if (message.method && !message.id) {
      this.notifications.push(message)
    }
  }
}

// ── Mock Adapter ──

class MockAdapter implements PlatformAdapter {
  readonly name = 'mock'
  private botId = 'bot-123'
  private msgCounter = 0
  sentMessages: { channelId: string; opts: SendOptions }[] = []
  reactions: { channelId: string; messageId: string; emoji: string }[] = []
  typingChannels: string[] = []
  editedMessages: { channelId: string; messageId: string; content: string }[] = []

  async login(_token: string) {}
  async destroy() {}
  onReady(cb: (botId: string, botName: string) => void) { cb(this.botId, 'TestBot') }
  onMessage(_cb: (msg: PlatformMessage) => void) {}

  async sendMessage(channelId: string, opts: SendOptions): Promise<string> {
    this.msgCounter++
    const id = `sent-${this.msgCounter}`
    this.sentMessages.push({ channelId, opts })
    return id
  }

  async editMessage(channelId: string, messageId: string, content: string) {
    this.editedMessages.push({ channelId, messageId, content })
  }

  async react(channelId: string, messageId: string, emoji: string) {
    this.reactions.push({ channelId, messageId, emoji })
  }

  async sendTyping(channelId: string) {
    this.typingChannels.push(channelId)
  }

  async fetchMessages(_channelId: string, _limit: number): Promise<FetchedMessage[]> {
    return []
  }

  async downloadAttachment(att: PlatformAttachment) {
    return { data: Buffer.from('test'), name: att.name }
  }

  getBotId() { return this.botId }
  async isReplyToBot(_msg: PlatformMessage) { return false }
  matchesPatterns(text: string, patterns: string[]) {
    for (const pat of patterns) {
      try { if (new RegExp(pat, 'i').test(text)) return true } catch {}
    }
    return false
  }
}

// ── Helpers ──

let tmpDir: string
let adapter: MockAdapter
let transport: MockTransport

async function createCore(configOverrides: Partial<OpenClaudeConfig> = {}) {
  const config = makeConfig(configOverrides)
  const core = createOpenClaude(adapter, config)
  transport = new MockTransport()
  await core.mcp.connect(transport)
  return core
}

function makeConfig(overrides: Partial<OpenClaudeConfig> = {}): OpenClaudeConfig {
  return {
    workspace: tmpDir,
    tmuxSession: 'test-session',
    staticMode: false,
    mainChannel: '100000000000',
    logThread: '',
    threadModel: 'sonnet',
    threadChannel: '',
    permissionChannel: '',
    eventLog: false,
    platform: 'mock',
    ...overrides,
  }
}

function makeMessage(overrides: Partial<PlatformMessage> = {}): PlatformMessage {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    channelId: '100000000000',
    authorId: 'user-1',
    authorName: 'TestUser',
    content: 'hello',
    isBot: false,
    isDM: false,
    isThread: false,
    createdAt: new Date(),
    attachments: [],
    mentionsBot: true,
    ...overrides,
  }
}

beforeEach(() => {
  tmpDir = join(import.meta.dir, `.tmp-core-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  mkdirSync(join(tmpDir, '.claude', 'discord', 'dedup'), { recursive: true })
  mkdirSync(join(tmpDir, 'memory', 'threads'), { recursive: true })
  adapter = new MockAdapter()
})

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true })
})

// ══════════════════════════════════════════════════════════════
// handleInbound — pre-gated message delivery
// ══════════════════════════════════════════════════════════════

describe('handleInbound: message delivery', () => {
  test('delivers message: typing + MCP notification', async () => {
    const core = await createCore()
    const msg = makeMessage({ content: 'hello from user' })

    await core.handleInbound(msg)

    expect(adapter.typingChannels).toContain('100000000000')
    expect(transport.notifications.length).toBeGreaterThanOrEqual(1)
    const notif = transport.notifications.find(n => n.method === 'notifications/claude/channel')
    expect(notif).toBeDefined()
    expect(notif.params.content).toBe('hello from user')
    expect(notif.params.meta.chat_id).toBe('100000000000')
  })

  test('dedup: same message ID processed only once', async () => {
    const core = await createCore()
    const msg = makeMessage({ id: 'dedup-test-id' })

    await core.handleInbound(msg)
    const typingAfterFirst = adapter.typingChannels.length

    await core.handleInbound(msg)
    expect(adapter.typingChannels.length).toBe(typingAfterFirst)
  })

  test('includes attachment metadata in notification', async () => {
    const core = await createCore()
    const msg = makeMessage({
      content: 'check this',
      attachments: [{
        id: 'att-1', name: 'report.pdf',
        contentType: 'application/pdf', size: 51200,
        url: 'https://example.com/report.pdf',
      }],
    })

    await core.handleInbound(msg)

    const notif = transport.notifications.find(n => n.method === 'notifications/claude/channel')
    expect(notif.params.meta.attachment_count).toBe('1')
    expect(notif.params.meta.attachments).toContain('report.pdf')
  })
})

// ══════════════════════════════════════════════════════════════
// gate() — access control decisions
// ══════════════════════════════════════════════════════════════

describe('gate: access control', () => {
  test('delivers to allowed DM user', async () => {
    const accessFile = join(tmpDir, '.claude', 'discord', 'access.json')
    writeFileSync(accessFile, JSON.stringify({ ...defaultAccess(), allowFrom: ['user-1'] }))

    const core = await createCore()
    const msg = makeMessage({ isDM: true })
    const result = await core.gate(msg)
    expect(result.action).toBe('deliver')
  })

  test('drops DM from unknown user in allowlist mode', async () => {
    const accessFile = join(tmpDir, '.claude', 'discord', 'access.json')
    writeFileSync(accessFile, JSON.stringify({ ...defaultAccess(), dmPolicy: 'allowlist', allowFrom: ['other'] }))

    const core = await createCore()
    const msg = makeMessage({ isDM: true, authorId: 'stranger' })
    const result = await core.gate(msg)
    expect(result.action).toBe('drop')
  })

  test('returns pair for new DM user in pairing mode', async () => {
    const core = await createCore()
    const msg = makeMessage({ isDM: true, authorId: 'new-user' })
    const result = await core.gate(msg)
    expect(result.action).toBe('pair')
    if (result.action === 'pair') {
      expect(result.code).toMatch(/^[a-f0-9]{6}$/)
    }
  })

  test('drops when DM policy is disabled', async () => {
    const accessFile = join(tmpDir, '.claude', 'discord', 'access.json')
    writeFileSync(accessFile, JSON.stringify({ ...defaultAccess(), dmPolicy: 'disabled' }))

    const core = await createCore()
    const msg = makeMessage({ isDM: true })
    const result = await core.gate(msg)
    expect(result.action).toBe('drop')
  })

  test('delivers guild message with policy and mention', async () => {
    const accessFile = join(tmpDir, '.claude', 'discord', 'access.json')
    const access = defaultAccess()
    access.groups = { '100000000000': { requireMention: true, allowFrom: [] } }
    writeFileSync(accessFile, JSON.stringify(access))

    const core = await createCore()
    const msg = makeMessage({ mentionsBot: true })
    const result = await core.gate(msg)
    expect(result.action).toBe('deliver')
  })

  test('drops guild message without mention when required', async () => {
    const accessFile = join(tmpDir, '.claude', 'discord', 'access.json')
    const access = defaultAccess()
    access.groups = { '100000000000': { requireMention: true, allowFrom: [] } }
    writeFileSync(accessFile, JSON.stringify(access))

    const core = await createCore()
    const msg = makeMessage({ mentionsBot: false })
    const result = await core.gate(msg)
    expect(result.action).toBe('drop')
  })

  test('mention pattern matching works', async () => {
    const accessFile = join(tmpDir, '.claude', 'discord', 'access.json')
    const access = defaultAccess()
    access.groups = { '100000000000': { requireMention: true, allowFrom: [] } }
    access.mentionPatterns = ['\\bclaude\\b']
    writeFileSync(accessFile, JSON.stringify(access))

    const core = await createCore()
    const msg = makeMessage({ content: 'hey claude help', mentionsBot: false })
    const result = await core.gate(msg)
    expect(result.action).toBe('deliver')
  })
})

// ══════════════════════════════════════════════════════════════
// MCP tools
// ══════════════════════════════════════════════════════════════

describe('MCP tool: reply', () => {
  test('sends message via adapter', async () => {
    const core = await createCore()
    const result = await (core.mcp as any)._requestHandlers.get('tools/call')!({
      method: 'tools/call',
      params: { name: 'reply', arguments: { chat_id: 'ch-1', text: 'Hello!' } },
    })
    expect(adapter.sentMessages.length).toBe(1)
    expect(adapter.sentMessages[0].opts.content).toBe('Hello!')
    expect(result.content[0].text).toContain('sent')
  })

  test('long text is chunked', async () => {
    const core = await createCore()
    const result = await (core.mcp as any)._requestHandlers.get('tools/call')!({
      method: 'tools/call',
      params: { name: 'reply', arguments: { chat_id: 'ch-1', text: 'word '.repeat(500) } },
    })
    expect(adapter.sentMessages.length).toBeGreaterThan(1)
    expect(result.content[0].text).toContain('parts')
  })
})

describe('MCP tool: react', () => {
  test('calls adapter.react', async () => {
    const core = await createCore()
    await (core.mcp as any)._requestHandlers.get('tools/call')!({
      method: 'tools/call',
      params: { name: 'react', arguments: { chat_id: 'ch-1', message_id: 'msg-1', emoji: '👍' } },
    })
    expect(adapter.reactions).toEqual([{ channelId: 'ch-1', messageId: 'msg-1', emoji: '👍' }])
  })
})

describe('MCP tool: edit_message', () => {
  test('calls adapter.editMessage', async () => {
    const core = await createCore()
    await (core.mcp as any)._requestHandlers.get('tools/call')!({
      method: 'tools/call',
      params: { name: 'edit_message', arguments: { chat_id: 'ch-1', message_id: 'msg-1', text: 'edited' } },
    })
    expect(adapter.editedMessages).toEqual([{ channelId: 'ch-1', messageId: 'msg-1', content: 'edited' }])
  })
})

describe('MCP tool: unknown', () => {
  test('returns error', async () => {
    const core = await createCore()
    const result = await (core.mcp as any)._requestHandlers.get('tools/call')!({
      method: 'tools/call',
      params: { name: 'nonexistent', arguments: {} },
    })
    expect(result.isError).toBe(true)
  })
})

// ══════════════════════════════════════════════════════════════
// AccessManager
// ══════════════════════════════════════════════════════════════

describe('AccessManager: static mode', () => {
  test('downgrades pairing to allowlist', () => {
    const accessFile = join(tmpDir, '.claude', 'discord', 'access.json')
    writeFileSync(accessFile, JSON.stringify({ ...defaultAccess(), dmPolicy: 'pairing', pending: { abc: { senderId: 'u1', chatId: 'c1', createdAt: 0, expiresAt: 0, replies: 1 } } }))

    const mgr = new AccessManager(makeConfig({ staticMode: true }))
    const loaded = mgr.load()
    expect(loaded.dmPolicy).toBe('allowlist')
    expect(Object.keys(loaded.pending)).toHaveLength(0)
  })

  test('ignores save calls', () => {
    const accessFile = join(tmpDir, '.claude', 'discord', 'access.json')
    writeFileSync(accessFile, JSON.stringify(defaultAccess()))

    const mgr = new AccessManager(makeConfig({ staticMode: true }))
    const access = mgr.load()
    access.allowFrom.push('new-user')
    mgr.save(access)

    const fresh = new AccessManager(makeConfig({ staticMode: true }))
    expect(fresh.load().allowFrom).not.toContain('new-user')
  })
})

// ══════════════════════════════════════════════════════════════
// destroy()
// ══════════════════════════════════════════════════════════════

describe('destroy', () => {
  test('does not throw', async () => {
    const core = await createCore()
    expect(() => core.destroy()).not.toThrow()
  })
})
