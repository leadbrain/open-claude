/**
 * Core integration tests — full message flow through gate → MCP → adapter.
 *
 * Uses a MockAdapter to record all platform calls without any real connections.
 * Tests the actual createOpenClaude() function with real MCP Server instances.
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

/** Records MCP notifications without a real Claude Code connection */
class MockTransport implements Transport {
  notifications: any[] = []
  onclose?: () => void
  onerror?: (err: Error) => void
  onmessage?: (msg: any) => void

  async start() {}
  async close() { this.onclose?.() }
  async send(message: any) {
    // Record notifications (one-way messages)
    if (message.method && !message.id) {
      this.notifications.push(message)
    }
  }
}

// ── Mock Adapter ──

interface AdapterCall {
  method: string
  args: unknown[]
}

class MockAdapter implements PlatformAdapter {
  readonly name = 'mock'
  calls: AdapterCall[] = []
  private botId = 'bot-123'
  private msgCounter = 0
  sentMessages: { channelId: string; opts: SendOptions }[] = []
  reactions: { channelId: string; messageId: string; emoji: string }[] = []
  typingChannels: string[] = []
  editedMessages: { channelId: string; messageId: string; content: string }[] = []
  fetchedChannels: string[] = []

  // Configurable behavior
  isReplyToBotResult = false

  async login(_token: string) { this.calls.push({ method: 'login', args: [_token] }) }
  async destroy() { this.calls.push({ method: 'destroy', args: [] }) }
  onReady(cb: (botId: string, botName: string) => void) { cb(this.botId, 'TestBot') }
  onMessage(_cb: (msg: PlatformMessage) => void) {}

  async sendMessage(channelId: string, opts: SendOptions): Promise<string> {
    this.msgCounter++
    const id = `sent-${this.msgCounter}`
    this.sentMessages.push({ channelId, opts })
    this.calls.push({ method: 'sendMessage', args: [channelId, opts] })
    return id
  }

  async editMessage(channelId: string, messageId: string, content: string) {
    this.editedMessages.push({ channelId, messageId, content })
    this.calls.push({ method: 'editMessage', args: [channelId, messageId, content] })
  }

  async react(channelId: string, messageId: string, emoji: string) {
    this.reactions.push({ channelId, messageId, emoji })
    this.calls.push({ method: 'react', args: [channelId, messageId, emoji] })
  }

  async sendTyping(channelId: string) {
    this.typingChannels.push(channelId)
    this.calls.push({ method: 'sendTyping', args: [channelId] })
  }

  async fetchMessages(channelId: string, limit: number): Promise<FetchedMessage[]> {
    this.fetchedChannels.push(channelId)
    this.calls.push({ method: 'fetchMessages', args: [channelId, limit] })
    return []
  }

  async downloadAttachment(att: PlatformAttachment) {
    return { data: Buffer.from('test'), name: att.name }
  }

  getBotId() { return this.botId }

  async isReplyToBot(_msg: PlatformMessage) { return this.isReplyToBotResult }

  matchesPatterns(text: string, patterns: string[]) {
    for (const pat of patterns) {
      try { if (new RegExp(pat, 'i').test(text)) return true } catch {}
    }
    return false
  }

  reset() {
    this.calls = []
    this.sentMessages = []
    this.reactions = []
    this.typingChannels = []
    this.editedMessages = []
    this.fetchedChannels = []
  }
}

// ── Helpers ──

let tmpDir: string
let adapter: MockAdapter
let transport: MockTransport

/** Create core and connect MCP with mock transport */
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
// Flow 1: Allowed guild message → gate → typing → ack → MCP notification
// ══════════════════════════════════════════════════════════════

describe('Flow: allowed guild message delivery', () => {
  test('full flow: gate allows → typing → ack reaction → MCP notification', async () => {
    const accessFile = join(tmpDir, '.claude', 'discord', 'access.json')
    const access = defaultAccess()
    access.groups = { '100000000000': { requireMention: true, allowFrom: [] } }
    writeFileSync(accessFile, JSON.stringify(access))

    const core = await createCore()
    const msg = makeMessage({ content: '@claude help me', mentionsBot: true })

    await core.handleInbound(msg)

    // Typing was sent
    expect(adapter.typingChannels).toContain('100000000000')

    // Ack reaction was sent (default: 👀)
    expect(adapter.reactions.length).toBeGreaterThanOrEqual(1)
    expect(adapter.reactions[0].emoji).toBe('👀')
    expect(adapter.reactions[0].messageId).toBe(msg.id)
  })

  test('message without mention is dropped', async () => {
    const accessFile = join(tmpDir, '.claude', 'discord', 'access.json')
    const access = defaultAccess()
    access.groups = { '100000000000': { requireMention: true, allowFrom: [] } }
    writeFileSync(accessFile, JSON.stringify(access))

    const core = await createCore()
    const msg = makeMessage({ content: 'hello', mentionsBot: false })

    await core.handleInbound(msg)

    // Nothing should happen
    expect(adapter.typingChannels).toHaveLength(0)
    expect(adapter.reactions).toHaveLength(0)
  })
})

// ══════════════════════════════════════════════════════════════
// Flow 2: DM from unknown user → pairing code
// ══════════════════════════════════════════════════════════════

describe('Flow: DM pairing', () => {
  test('new DM user gets pairing code', async () => {
    const core = await createCore()
    const msg = makeMessage({
      isDM: true,
      channelId: 'dm-ch-1',
      authorId: 'new-user',
      mentionsBot: false,
    })

    await core.handleInbound(msg)

    // Should have sent a pairing message
    expect(adapter.sentMessages.length).toBe(1)
    expect(adapter.sentMessages[0].channelId).toBe('dm-ch-1')
    expect(adapter.sentMessages[0].opts.content).toContain('Pairing required')
    // Content includes a 6-char hex code
    const codeMatch = adapter.sentMessages[0].opts.content.match(/`([a-f0-9]{6})`/)
    expect(codeMatch).not.toBeNull()

    // No typing, no ack — message was not delivered
    expect(adapter.typingChannels).toHaveLength(0)
  })

  test('allowed DM user gets full delivery', async () => {
    const accessFile = join(tmpDir, '.claude', 'discord', 'access.json')
    const access = defaultAccess()
    access.allowFrom = ['allowed-user']
    writeFileSync(accessFile, JSON.stringify(access))

    const core = await createCore()
    const msg = makeMessage({
      isDM: true,
      channelId: 'dm-ch-2',
      authorId: 'allowed-user',
      mentionsBot: false,
    })

    await core.handleInbound(msg)

    // Typing + ack reaction + NO pairing message
    expect(adapter.typingChannels).toContain('dm-ch-2')
    expect(adapter.sentMessages.filter(m => m.opts.content.includes('Pairing'))).toHaveLength(0)
  })
})

// ══════════════════════════════════════════════════════════════
// Flow 3: Disabled DM policy → silent drop
// ══════════════════════════════════════════════════════════════

describe('Flow: disabled DM policy', () => {
  test('DM dropped silently when policy is disabled', async () => {
    const accessFile = join(tmpDir, '.claude', 'discord', 'access.json')
    const access = defaultAccess()
    access.dmPolicy = 'disabled'
    writeFileSync(accessFile, JSON.stringify(access))

    const core = await createCore()
    const msg = makeMessage({ isDM: true, authorId: 'anyone' })

    await core.handleInbound(msg)

    expect(adapter.sentMessages).toHaveLength(0)
    expect(adapter.typingChannels).toHaveLength(0)
    expect(adapter.reactions).toHaveLength(0)
  })
})

// ══════════════════════════════════════════════════════════════
// Flow 4: Message dedup — same message ID processed once
// ══════════════════════════════════════════════════════════════

describe('Flow: message dedup', () => {
  test('duplicate message ID is processed only once', async () => {
    const accessFile = join(tmpDir, '.claude', 'discord', 'access.json')
    const access = defaultAccess()
    access.groups = { '100000000000': { requireMention: false, allowFrom: [] } }
    writeFileSync(accessFile, JSON.stringify(access))

    const core = await createCore()
    const msg = makeMessage({ id: 'same-msg-id', mentionsBot: true })

    await core.handleInbound(msg)
    const typingAfterFirst = adapter.typingChannels.length

    // Send same message again
    await core.handleInbound(msg)
    const typingAfterSecond = adapter.typingChannels.length

    // Second call should not add typing
    expect(typingAfterSecond).toBe(typingAfterFirst)
  })
})

// ══════════════════════════════════════════════════════════════
// Flow 5: Thread-scoped instance — only handles assigned thread
// ══════════════════════════════════════════════════════════════

describe('Flow: thread-scoped instance', () => {
  test('ignores messages for other channels', async () => {
    const accessFile = join(tmpDir, '.claude', 'discord', 'access.json')
    const access = defaultAccess()
    access.groups = { 'other-ch': { requireMention: false, allowFrom: [] } }
    writeFileSync(accessFile, JSON.stringify(access))

    const core = await createCore({ threadChannel: 'thread-123' })
    const msg = makeMessage({ channelId: 'other-ch', mentionsBot: true })

    await core.handleInbound(msg)

    expect(adapter.typingChannels).toHaveLength(0)
  })

  test('processes messages for assigned thread', async () => {
    const accessFile = join(tmpDir, '.claude', 'discord', 'access.json')
    const access = defaultAccess()
    access.groups = { 'thread-123': { requireMention: false, allowFrom: [] } }
    writeFileSync(accessFile, JSON.stringify(access))

    const core = await createCore({ threadChannel: 'thread-123' })
    const msg = makeMessage({ channelId: 'thread-123', mentionsBot: false })

    await core.handleInbound(msg)

    expect(adapter.typingChannels).toContain('thread-123')
  })
})

// ══════════════════════════════════════════════════════════════
// Flow 6: MCP tool call — reply splits and sends via adapter
// ══════════════════════════════════════════════════════════════

describe('Flow: MCP reply tool', () => {
  test('reply tool sends message via adapter', async () => {
    const core = await createCore()

    // Directly invoke the tool handler
    const result = await (core.mcp as any)._requestHandlers.get('tools/call')!({
      method: 'tools/call',
      params: {
        name: 'reply',
        arguments: { chat_id: 'ch-1', text: 'Hello from MCP!' },
      },
    })

    expect(adapter.sentMessages.length).toBe(1)
    expect(adapter.sentMessages[0].channelId).toBe('ch-1')
    expect(adapter.sentMessages[0].opts.content).toBe('Hello from MCP!')
    expect(result.content[0].text).toContain('sent')
  })

  test('long reply is chunked into multiple messages', async () => {
    const core = await createCore()

    const longText = 'word '.repeat(500)  // ~2500 chars

    const result = await (core.mcp as any)._requestHandlers.get('tools/call')!({
      method: 'tools/call',
      params: {
        name: 'reply',
        arguments: { chat_id: 'ch-1', text: longText },
      },
    })

    expect(adapter.sentMessages.length).toBeGreaterThan(1)
    // All chunks go to same channel
    for (const sent of adapter.sentMessages) {
      expect(sent.channelId).toBe('ch-1')
    }
    expect(result.content[0].text).toContain('parts')
  })
})

// ══════════════════════════════════════════════════════════════
// Flow 7: MCP react tool
// ══════════════════════════════════════════════════════════════

describe('Flow: MCP react tool', () => {
  test('react tool calls adapter.react', async () => {
    const core = await createCore()

    await (core.mcp as any)._requestHandlers.get('tools/call')!({
      method: 'tools/call',
      params: {
        name: 'react',
        arguments: { chat_id: 'ch-1', message_id: 'msg-1', emoji: '👍' },
      },
    })

    expect(adapter.reactions.length).toBe(1)
    expect(adapter.reactions[0]).toEqual({ channelId: 'ch-1', messageId: 'msg-1', emoji: '👍' })
  })
})

// ══════════════════════════════════════════════════════════════
// Flow 8: MCP edit_message tool
// ══════════════════════════════════════════════════════════════

describe('Flow: MCP edit_message tool', () => {
  test('edit_message tool calls adapter.editMessage', async () => {
    const core = await createCore()

    await (core.mcp as any)._requestHandlers.get('tools/call')!({
      method: 'tools/call',
      params: {
        name: 'edit_message',
        arguments: { chat_id: 'ch-1', message_id: 'msg-1', text: 'edited text' },
      },
    })

    expect(adapter.editedMessages.length).toBe(1)
    expect(adapter.editedMessages[0]).toEqual({ channelId: 'ch-1', messageId: 'msg-1', content: 'edited text' })
  })
})

// ══════════════════════════════════════════════════════════════
// Flow 9: Mention detection via patterns
// ══════════════════════════════════════════════════════════════

describe('Flow: mention pattern detection', () => {
  test('message matching mentionPatterns is delivered', async () => {
    const accessFile = join(tmpDir, '.claude', 'discord', 'access.json')
    const access = defaultAccess()
    access.groups = { '100000000000': { requireMention: true, allowFrom: [] } }
    access.mentionPatterns = ['\\bclaude\\b']
    writeFileSync(accessFile, JSON.stringify(access))

    const core = await createCore()
    const msg = makeMessage({
      content: 'hey claude can you help?',
      mentionsBot: false,  // no @mention
    })

    await core.handleInbound(msg)

    // Should be delivered because pattern matched
    expect(adapter.typingChannels.length).toBeGreaterThanOrEqual(1)
  })

  test('message not matching patterns is dropped', async () => {
    const accessFile = join(tmpDir, '.claude', 'discord', 'access.json')
    const access = defaultAccess()
    access.groups = { '100000000000': { requireMention: true, allowFrom: [] } }
    access.mentionPatterns = ['\\bclaude\\b']
    writeFileSync(accessFile, JSON.stringify(access))

    const core = await createCore()
    const msg = makeMessage({
      content: 'hello world',
      mentionsBot: false,
    })

    await core.handleInbound(msg)

    expect(adapter.typingChannels).toHaveLength(0)
  })
})

// ══════════════════════════════════════════════════════════════
// Flow 10: Message with attachments
// ══════════════════════════════════════════════════════════════

describe('Flow: message with attachments', () => {
  test('attachment metadata is included in MCP notification', async () => {
    const accessFile = join(tmpDir, '.claude', 'discord', 'access.json')
    const access = defaultAccess()
    access.groups = { '100000000000': { requireMention: false, allowFrom: [] } }
    writeFileSync(accessFile, JSON.stringify(access))

    const core = await createCore()

    // Spy on MCP notification
    let notificationParams: any = null
    const origNotification = core.mcp.notification.bind(core.mcp)
    core.mcp.notification = async (msg: any) => {
      notificationParams = msg.params
      return origNotification(msg)
    }

    const msg = makeMessage({
      content: 'check this file',
      attachments: [{
        id: 'att-1',
        name: 'report.pdf',
        contentType: 'application/pdf',
        size: 1024 * 50,
        url: 'https://example.com/report.pdf',
      }],
    })

    await core.handleInbound(msg)

    // The notification should include attachment info
    expect(notificationParams).not.toBeNull()
    expect(notificationParams.meta.attachment_count).toBe('1')
    expect(notificationParams.meta.attachments).toContain('report.pdf')
  })
})

// ══════════════════════════════════════════════════════════════
// Flow 11: Access manager — static mode
// ══════════════════════════════════════════════════════════════

describe('AccessManager: static mode', () => {
  test('static mode downgrades pairing to allowlist', () => {
    const accessFile = join(tmpDir, '.claude', 'discord', 'access.json')
    const access = defaultAccess()
    access.dmPolicy = 'pairing'
    access.pending = { 'abc': { senderId: 'u1', chatId: 'c1', createdAt: 0, expiresAt: 0, replies: 1 } }
    writeFileSync(accessFile, JSON.stringify(access))

    const mgr = new AccessManager(makeConfig({ staticMode: true }))
    const loaded = mgr.load()

    expect(loaded.dmPolicy).toBe('allowlist')
    expect(Object.keys(loaded.pending)).toHaveLength(0)
  })

  test('static mode ignores save calls', () => {
    const accessFile = join(tmpDir, '.claude', 'discord', 'access.json')
    writeFileSync(accessFile, JSON.stringify(defaultAccess()))

    const mgr = new AccessManager(makeConfig({ staticMode: true }))
    const access = mgr.load()
    access.allowFrom.push('new-user')
    mgr.save(access)

    // Re-read should NOT have the change
    const fresh = new AccessManager(makeConfig({ staticMode: true }))
    expect(fresh.load().allowFrom).not.toContain('new-user')
  })
})

// ══════════════════════════════════════════════════════════════
// Flow 12: Unknown tool → error response
// ══════════════════════════════════════════════════════════════

describe('Flow: unknown MCP tool', () => {
  test('unknown tool returns isError', async () => {
    const core = await createCore()

    const result = await (core.mcp as any)._requestHandlers.get('tools/call')!({
      method: 'tools/call',
      params: { name: 'nonexistent_tool', arguments: {} },
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('unknown tool')
  })
})

// ═════════���════════════════════════════════════════════════════
// Flow 13: Bot self-message — scheduled trigger
// ═══════════════════════��═════════════════════════════════���════

describe('Flow: scheduled trigger (bot self-message)', () => {
  test('[scheduled] message from bot is processed', async () => {
    const accessFile = join(tmpDir, '.claude', 'discord', 'access.json')
    const access = defaultAccess()
    access.groups = { '100000000000': { requireMention: false, allowFrom: [] } }
    writeFileSync(accessFile, JSON.stringify(access))

    const core = await createCore()
    const msg = makeMessage({
      content: '[scheduled] /conversation-analysis',
      isBot: true,
      authorId: 'bot-123',  // matches MockAdapter.getBotId()
      mentionsBot: false,
    })

    await core.handleInbound(msg)

    // Should be processed — typing sent
    expect(adapter.typingChannels.length).toBeGreaterThanOrEqual(1)
  })

  test('non-scheduled bot message is dropped', async () => {
    const accessFile = join(tmpDir, '.claude', 'discord', 'access.json')
    const access = defaultAccess()
    access.groups = { '100000000000': { requireMention: false, allowFrom: [] } }
    writeFileSync(accessFile, JSON.stringify(access))

    const core = await createCore()
    const msg = makeMessage({
      content: 'hello from another bot',
      isBot: true,
      authorId: 'other-bot',
      mentionsBot: false,
    })

    await core.handleInbound(msg)

    expect(adapter.typingChannels).toHaveLength(0)
  })

  test('bot message without [scheduled] prefix is dropped even from self', async () => {
    const accessFile = join(tmpDir, '.claude', 'discord', 'access.json')
    const access = defaultAccess()
    access.groups = { '100000000000': { requireMention: false, allowFrom: [] } }
    writeFileSync(accessFile, JSON.stringify(access))

    const core = await createCore()
    const msg = makeMessage({
      content: 'just a normal message',
      isBot: true,
      authorId: 'bot-123',
      mentionsBot: false,
    })

    await core.handleInbound(msg)

    expect(adapter.typingChannels).toHaveLength(0)
  })
})

// ══════════════════════════════════════════════════════════════
// Flow 14: Scheduler — startScheduler
// ══════════════════════════════════════════════════════════════

describe('Flow: startScheduler', () => {
  test('startScheduler does not throw', async () => {
    const core = await createCore()
    expect(() => core.startScheduler()).not.toThrow()
  })
})
