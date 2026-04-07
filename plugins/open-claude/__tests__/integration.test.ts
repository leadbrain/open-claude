/**
 * Integration tests — simulate full message flows through the hook pipeline.
 *
 * auto-reply.sh now sends via POST /api/tools to the server.
 * We spin up a mock HTTP server to capture tool calls.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { join } from 'path'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { createServer, type Server as HttpServer } from 'http'
import { gatePure, defaultAccess, type Access, type GateInput } from '../lib.ts'

const FIXTURES_DIR = join(import.meta.dir, 'fixtures')
const HOOKS_DIR = join(import.meta.dir, '..', 'hooks')
const TRACK_SCRIPT = join(HOOKS_DIR, 'track-channel.sh')
const REPLY_SCRIPT = join(HOOKS_DIR, 'auto-reply.sh')

// ── Mock server ──

let mockServer: HttpServer
let mockPort: number
let toolCalls: { tool: string; args: any }[]
let ackClears: string[]

function startMockServer(): Promise<void> {
  toolCalls = []
  ackClears = []
  mockServer = createServer((req, res) => {
    let data = ''
    req.on('data', c => { data += c })
    req.on('end', () => {
      if (req.url === '/api/tools') {
        try { toolCalls.push(JSON.parse(data)) } catch {}
      } else if (req.url === '/api/ack-clear') {
        try { ackClears.push(JSON.parse(data).chat_id) } catch {}
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ text: 'ok' }))
    })
  })
  return new Promise(resolve => {
    mockServer.listen(0, '127.0.0.1', () => {
      mockPort = (mockServer.address() as any).port
      resolve()
    })
  })
}

/** Run a hook script */
async function runHook(
  script: string,
  stdin: string,
  env: Record<string, string>,
): Promise<{ exitCode: number }> {
  const proc = Bun.spawn(['bash', script], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      OPEN_CLAUDE_SERVER: `http://127.0.0.1:${mockPort}`,
      DISCORD_EVENT_LOG: 'false',
      ...env,
    },
  })
  proc.stdin.write(stdin)
  proc.stdin.end()
  const exitCode = await proc.exited
  return { exitCode }
}

function toolCallsToChannel(chatId: string): number {
  return toolCalls.filter(c => c.tool === 'reply' && c.args?.chat_id === chatId).length
}

// ── Helpers ──

let tmpDir: string

beforeEach(async () => {
  tmpDir = join(import.meta.dir, `.tmp-int-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  mkdirSync(join(tmpDir, 'memory', 'threads'), { recursive: true })
  mkdirSync(join(tmpDir, 'memory', 'events'), { recursive: true })
  await startMockServer()
})

afterEach(() => {
  mockServer.close()
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true })
})

function baseEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    DISCORD_BOT_TOKEN: 'test-token',
    DISCORD_MAIN_CHANNEL: '100000000000',
    OPEN_CLAUDE_WORKSPACE: tmpDir,
    ...overrides,
  }
}

function trackInput(sessionId: string, chatId: string, content: string): string {
  return JSON.stringify({
    session_id: sessionId,
    user_prompt: `<channel source="discord" chat_id="${chatId}" message_id="msg001" user="testuser" ts="2026-04-05T10:00:00.000Z">\n${content}\n</channel>`,
  })
}

function replyInput(sessionId: string, transcriptPath: string, lastMsg?: string): string {
  return JSON.stringify({
    session_id: sessionId,
    transcript_path: transcriptPath,
    ...(lastMsg ? { last_assistant_message: lastMsg } : {}),
  })
}

function writeTranscript(name: string, lines: object[]): string {
  const path = join(tmpDir, `${name}.jsonl`)
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  return path
}

// ── Scenario 1: Main channel text response ──

describe('Scenario: main channel text response', () => {
  test('track-channel creates session mapping, auto-reply routes to main channel', async () => {
    const MAIN_CH = '100000000000'
    const SID = 'sid-main-001'

    await runHook(TRACK_SCRIPT, trackInput(SID, MAIN_CH, 'hello'), baseEnv())

    const threadFile = join(tmpDir, 'memory', 'threads', `${MAIN_CH}.json`)
    expect(existsSync(threadFile)).toBe(true)

    const transcript = writeTranscript('t1', [
      { type: 'user', message: { content: [{ type: 'text', text: 'hello' }] }, permissionMode: 'default', origin: { kind: 'channel' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hi from Claude!' }] } },
    ])

    await runHook(REPLY_SCRIPT, replyInput(SID, transcript, 'Hi from Claude!'), baseEnv())
    await new Promise(r => setTimeout(r, 500))

    expect(toolCallsToChannel(MAIN_CH)).toBeGreaterThanOrEqual(1)
  })
})

// ── Scenario 2: Thread routing ──

describe('Scenario: thread message routing', () => {
  test('thread response routes to thread, not main channel', async () => {
    const MAIN_CH = '100000000000'
    const THREAD_CH = '200000000000'
    const SID_MAIN = 'sid-main-002'
    const SID_THREAD = 'sid-thread-002'

    await runHook(TRACK_SCRIPT, trackInput(SID_MAIN, MAIN_CH, 'main msg'), baseEnv())
    await runHook(TRACK_SCRIPT, trackInput(SID_THREAD, THREAD_CH, 'thread msg'), baseEnv())

    const transcript = writeTranscript('t2', [
      { type: 'user', message: { content: [{ type: 'text', text: 'thread msg' }] }, permissionMode: 'default' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Thread reply!' }] } },
    ])

    await runHook(REPLY_SCRIPT, replyInput(SID_THREAD, transcript, 'Thread reply!'), baseEnv())
    await new Promise(r => setTimeout(r, 500))

    expect(toolCallsToChannel(THREAD_CH)).toBeGreaterThanOrEqual(1)
    expect(toolCallsToChannel(MAIN_CH)).toBe(0)
  })
})

// ── Scenario 3: Cron job with log thread copy ──

describe('Scenario: cron job with log thread copy', () => {
  test('cron response sent to target thread AND copied to log thread', async () => {
    const CRON_THREAD = '300000000000'
    const LOG_THREAD = '400000000000'
    const SID = 'sid-cron-004'

    await runHook(TRACK_SCRIPT, trackInput(SID, CRON_THREAD, 'weather briefing'), baseEnv({ DISCORD_LOG_THREAD: LOG_THREAD }))
    writeFileSync(`/tmp/cron-marker-${SID}`, '')

    const transcript = writeTranscript('t4', [
      { type: 'user', message: { content: [{ type: 'text', text: 'weather briefing' }] }, permissionMode: 'default' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Seoul: 15°C, sunny' }] } },
    ])

    await runHook(REPLY_SCRIPT, replyInput(SID, transcript, 'Seoul: 15°C, sunny'), baseEnv({ DISCORD_LOG_THREAD: LOG_THREAD }))
    await new Promise(r => setTimeout(r, 500))

    expect(toolCallsToChannel(CRON_THREAD)).toBeGreaterThanOrEqual(1)
    expect(toolCallsToChannel(LOG_THREAD)).toBeGreaterThanOrEqual(1)
    expect(existsSync(`/tmp/cron-marker-${SID}`)).toBe(false)
  })
})

// ── Scenario 4: Unknown session fallback ──

describe('Scenario: unknown session fallback', () => {
  test('unmatched session_id falls back to log thread', async () => {
    const LOG_THREAD = '400000000000'
    const transcript = writeTranscript('t5', [
      { type: 'user', message: { content: [{ type: 'text', text: 'orphan' }] }, permissionMode: 'default' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Orphan response' }] } },
    ])

    await runHook(REPLY_SCRIPT, replyInput('sid-unknown', transcript, 'Orphan response'), baseEnv({ DISCORD_LOG_THREAD: LOG_THREAD }))
    await new Promise(r => setTimeout(r, 500))

    expect(toolCallsToChannel(LOG_THREAD)).toBeGreaterThanOrEqual(1)
  })

  test('unmatched session + no log thread → silent exit', async () => {
    const transcript = writeTranscript('t5b', [
      { type: 'user', message: { content: [{ type: 'text', text: 'orphan' }] }, permissionMode: 'default' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Orphan' }] } },
    ])

    await runHook(REPLY_SCRIPT, replyInput('sid-unknown', transcript, 'Orphan'), baseEnv({ DISCORD_LOG_THREAD: '' }))
    await new Promise(r => setTimeout(r, 300))

    expect(toolCalls).toHaveLength(0)
  })
})

// ── Scenario 5: Long response chunking ──

describe('Scenario: long response chunking', () => {
  test('response >2000 chars split into multiple messages', async () => {
    const MAIN_CH = '100000000000'
    const SID = 'sid-chunk-006'

    await runHook(TRACK_SCRIPT, trackInput(SID, MAIN_CH, 'long question'), baseEnv())

    const longText = 'A'.repeat(1000) + '\n\n' + 'B'.repeat(1000) + '\n\n' + 'C'.repeat(500)
    const transcript = writeTranscript('t6', [
      { type: 'user', message: { content: [{ type: 'text', text: 'long question' }] }, permissionMode: 'default', origin: { kind: 'channel' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: longText }] } },
    ])

    await runHook(REPLY_SCRIPT, replyInput(SID, transcript, longText), baseEnv())
    await new Promise(r => setTimeout(r, 500))

    expect(toolCallsToChannel(MAIN_CH)).toBeGreaterThan(1)
  })
})

// ── Scenario 6: Gate + hook pipeline ──

describe('Scenario: access control → hook pipeline', () => {
  test('allowed DM user: gate delivers, hooks route response', async () => {
    const access = defaultAccess()
    access.allowFrom = ['user-allowed']
    const input: GateInput = {
      senderId: 'user-allowed', isDM: true,
      channelId: 'dm-ch', isThread: false, isMentioned: false,
    }
    const result = gatePure(input, access)
    expect(result.action).toBe('deliver')

    const SID = 'sid-dm-007'
    await runHook(TRACK_SCRIPT, trackInput(SID, 'dm-ch', 'hi from DM'), baseEnv())

    const transcript = writeTranscript('t7', [
      { type: 'user', message: { content: [{ type: 'text', text: 'hi from DM' }] }, permissionMode: 'default' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello via DM!' }] } },
    ])

    await runHook(REPLY_SCRIPT, replyInput(SID, transcript, 'Hello via DM!'), baseEnv())
    await new Promise(r => setTimeout(r, 500))

    expect(toolCallsToChannel('dm-ch')).toBeGreaterThanOrEqual(1)
  })

  test('blocked DM user: gate drops, no hooks run', () => {
    const access: Access = { ...defaultAccess(), dmPolicy: 'allowlist', allowFrom: ['other'] }
    const input: GateInput = {
      senderId: 'blocked-user', isDM: true,
      channelId: 'dm-ch', isThread: false, isMentioned: false,
    }
    expect(gatePure(input, access).action).toBe('drop')
  })
})

// ── Scenario 7: Re-entry guard ──

describe('Scenario: re-entry guard', () => {
  test('auto-reply skips when CLAUDE_HOOK_NOREENTRY=1', async () => {
    const MAIN_CH = '100000000000'
    const SID = 'sid-reentry-008'
    await runHook(TRACK_SCRIPT, trackInput(SID, MAIN_CH, 'msg'), baseEnv())

    const transcript = writeTranscript('t8', [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'should not send' }] } },
    ])

    await runHook(REPLY_SCRIPT, replyInput(SID, transcript, 'should not send'), {
      ...baseEnv(),
      CLAUDE_HOOK_NOREENTRY: '1',
    })
    await new Promise(r => setTimeout(r, 300))

    expect(toolCalls).toHaveLength(0)
  })
})
