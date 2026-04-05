/**
 * Integration tests — simulate full message flows through the hook pipeline.
 *
 * Flow: Discord message → track-channel.sh (session mapping + typing)
 *       → Claude processes → auto-reply.sh (extract + route + send)
 *
 * Uses mock curl to intercept HTTP calls and verify correct routing.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { join } from 'path'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { gatePure, defaultAccess, type Access, type GateInput } from '../lib.ts'

const FIXTURES_DIR = join(import.meta.dir, 'fixtures')
const MOCK_BIN_DIR = join(FIXTURES_DIR, 'bin')
const HOOKS_DIR = join(import.meta.dir, '..', 'hooks')
const TRACK_SCRIPT = join(HOOKS_DIR, 'track-channel.sh')
const REPLY_SCRIPT = join(HOOKS_DIR, 'auto-reply.sh')

/** Run a hook script with given stdin and env, return { exitCode, curlLog } */
async function runHook(
  script: string,
  stdin: string,
  env: Record<string, string>,
): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn(['bash', script], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PATH: `${MOCK_BIN_DIR}:${process.env.PATH}`,
      HOME: process.env.HOME ?? '',
      ...env,
    },
  })
  proc.stdin.write(stdin)
  proc.stdin.end()
  const exitCode = await proc.exited
  const stderr = await new Response(proc.stderr).text()
  return { exitCode, stderr }
}

function readCurlLog(logPath: string): string {
  return existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
}

function curlCallCount(log: string): number {
  return (log.match(/^CALL:/gm) || []).length
}

function curlCallsToChannel(log: string, channelId: string): number {
  const re = new RegExp(`/channels/${channelId}/messages`, 'g')
  return (log.match(re) || []).length
}

// ── Helpers ──

let tmpDir: string
let curlLog: string

beforeEach(() => {
  tmpDir = join(import.meta.dir, `.tmp-int-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  mkdirSync(join(tmpDir, 'memory', 'threads'), { recursive: true })
  mkdirSync(join(tmpDir, 'memory', 'events'), { recursive: true })
  curlLog = join(tmpDir, 'curl.log')
})

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true })
})

function baseEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    DISCORD_BOT_TOKEN: 'test-token',
    DISCORD_MAIN_CHANNEL: '100000000000',
    OPEN_CLAUDE_WORKSPACE: tmpDir,
    DISCORD_EVENT_LOG: 'false',
    MOCK_CURL_LOG: curlLog,
    OPEN_CLAUDE_PLATFORM: 'discord',
    ...overrides,
  }
}

/** Simulate track-channel.sh receiving a Discord message */
function trackInput(sessionId: string, chatId: string, content: string): string {
  return JSON.stringify({
    session_id: sessionId,
    user_prompt: `<channel source="discord" chat_id="${chatId}" message_id="msg001" user="testuser" ts="2026-04-05T10:00:00.000Z">\n${content}\n</channel>`,
  })
}

/** Simulate auto-reply.sh receiving Stop hook data */
function replyInput(sessionId: string, transcriptPath: string, lastMsg?: string): string {
  return JSON.stringify({
    session_id: sessionId,
    transcript_path: transcriptPath,
    ...(lastMsg ? { last_assistant_message: lastMsg } : {}),
  })
}

/** Write a JSONL transcript file */
function writeTranscript(name: string, lines: object[]): string {
  const path = join(tmpDir, `${name}.jsonl`)
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  return path
}

// ══════════════════════════════════════════���═══════════════════
// Scenario 1: Main channel — simple text response
// ══════��═════════════════════════��═════════════════════════════

describe('Scenario: main channel text response', () => {
  const MAIN_CH = '100000000000'
  const SID = 'sid-main-001'

  test('track-channel creates session mapping, auto-reply routes to main channel', async () => {
    // Step 1: track-channel.sh — records session mapping
    await runHook(TRACK_SCRIPT, trackInput(SID, MAIN_CH, 'hello'), baseEnv())

    // Verify mapping file created
    const threadFile = join(tmpDir, 'memory', 'threads', `${MAIN_CH}.json`)
    expect(existsSync(threadFile)).toBe(true)
    const mapping = JSON.parse(readFileSync(threadFile, 'utf8'))
    expect(mapping.session_id).toBe(SID)

    // Step 2: auto-reply.sh — routes response to main channel
    const transcript = writeTranscript('t1', [
      { type: 'user', message: { content: [{ type: 'text', text: 'hello' }] }, permissionMode: 'default', origin: { kind: 'channel' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hi from Claude!' }] } },
    ])

    await runHook(REPLY_SCRIPT, replyInput(SID, transcript, 'Hi from Claude!'), baseEnv())

    const log = readCurlLog(curlLog)
    expect(curlCallsToChannel(log, MAIN_CH)).toBeGreaterThanOrEqual(1)
    expect(log).toContain('Hi from Claude!')
  })
})

// ════════════════════════════��════════════════════════���════════
// Scenario 2: Thread — separate session, separate routing
// ═════════════════════════════��════════════════════════════════

describe('Scenario: thread message routing', () => {
  const MAIN_CH = '100000000000'
  const THREAD_CH = '200000000000'
  const SID_MAIN = 'sid-main-002'
  const SID_THREAD = 'sid-thread-002'

  test('thread response routes to thread, not main channel', async () => {
    // Set up both mappings
    await runHook(TRACK_SCRIPT, trackInput(SID_MAIN, MAIN_CH, 'main msg'), baseEnv())
    await runHook(TRACK_SCRIPT, trackInput(SID_THREAD, THREAD_CH, 'thread msg'), baseEnv())

    // Verify both mapping files exist
    expect(existsSync(join(tmpDir, 'memory', 'threads', `${MAIN_CH}.json`))).toBe(true)
    expect(existsSync(join(tmpDir, 'memory', 'threads', `${THREAD_CH}.json`))).toBe(true)

    // Thread response
    const transcript = writeTranscript('t2', [
      { type: 'user', message: { content: [{ type: 'text', text: 'thread msg' }] }, permissionMode: 'default' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Thread reply!' }] } },
    ])

    await runHook(REPLY_SCRIPT, replyInput(SID_THREAD, transcript, 'Thread reply!'), baseEnv())

    const log = readCurlLog(curlLog)
    // Should go to thread channel, NOT main
    expect(curlCallsToChannel(log, THREAD_CH)).toBeGreaterThanOrEqual(1)
    expect(curlCallsToChannel(log, MAIN_CH)).toBe(0)
  })
})

// ══════════���════════════���════════════════════════════════��═════
// Scenario 3: Tool usage — response includes tool summaries
// ════════════════════════════��═══════════════════════════════��═

describe('Scenario: tool usage in response', () => {
  const MAIN_CH = '100000000000'
  const SID = 'sid-tools-003'

  test('tool_use entries appear as compact summaries in Discord message', async () => {
    await runHook(TRACK_SCRIPT, trackInput(SID, MAIN_CH, 'fix the bug'), baseEnv())

    const transcript = writeTranscript('t3', [
      { type: 'user', message: { content: [{ type: 'text', text: 'fix the bug' }] }, permissionMode: 'default', origin: { kind: 'channel' } },
      { type: 'assistant', message: { content: [
        { type: 'text', text: 'Let me look at the code.' },
        { type: 'tool_use', id: 'tu_r1', name: 'Read', input: { file_path: '/project/src/app.ts' } },
        { type: 'tool_use', id: 'tu_e1', name: 'Edit', input: { file_path: '/project/src/app.ts', old_string: 'bug', new_string: 'fix' } },
        { type: 'text', text: 'Fixed the bug in app.ts.' },
      ] } },
      { type: 'user', toolUseResult: { tool_use_id: 'tu_r1', content: 'const x = 1' } },
      { type: 'user', toolUseResult: { tool_use_id: 'tu_e1', structuredPatch: [{ lines: [' before', '-bug', '+fix', ' after'] }], filePath: '/project/src/app.ts' } },
    ])

    await runHook(REPLY_SCRIPT, replyInput(SID, transcript, 'Fixed the bug in app.ts.'), baseEnv())

    const log = readCurlLog(curlLog)
    // Verify tool summaries appear
    expect(log).toContain('`Read`')
    expect(log).toContain('`Edit`')
    expect(log).toContain('app.ts')
    // Verify text appears
    expect(log).toContain('Let me look at the code.')
    expect(log).toContain('Fixed the bug')
    // Verify diff appears
    expect(log).toContain('```ansi')
  })
})

// ══════════════════════════════════════════════════════════════
// Scenario 4: Cron job — response copied to log thread
// ═══════��══════════════════════════════════════════════════════

describe('Scenario: cron job with log thread copy', () => {
  const CRON_THREAD = '300000000000'
  const LOG_THREAD = '400000000000'
  const SID = 'sid-cron-004'

  test('cron response sent to target thread AND copied to log thread', async () => {
    // Set up cron session mapping
    await runHook(TRACK_SCRIPT, trackInput(SID, CRON_THREAD, 'weather briefing'), baseEnv({
      DISCORD_LOG_THREAD: LOG_THREAD,
    }))

    // Create cron marker
    writeFileSync(`/tmp/cron-marker-${SID}`, '')

    const transcript = writeTranscript('t4', [
      { type: 'user', message: { content: [{ type: 'text', text: 'weather briefing' }] }, permissionMode: 'default' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Seoul: 15°C, sunny' }] } },
    ])

    await runHook(REPLY_SCRIPT, replyInput(SID, transcript, 'Seoul: 15°C, sunny'), baseEnv({
      DISCORD_LOG_THREAD: LOG_THREAD,
    }))

    const log = readCurlLog(curlLog)
    // Sent to cron thread
    expect(curlCallsToChannel(log, CRON_THREAD)).toBeGreaterThanOrEqual(1)
    // Copied to log thread
    expect(curlCallsToChannel(log, LOG_THREAD)).toBeGreaterThanOrEqual(1)
    expect(log).toContain(`cron`)
    // Cron marker cleaned up
    expect(existsSync(`/tmp/cron-marker-${SID}`)).toBe(false)
  })
})

// ══════��═══════════════════════════════════════════════════════
// Scenario 5: No session mapping — fallback to log thread
// ═══════════════════��══════════════════════════════════════════

describe('Scenario: unknown session fallback', () => {
  const LOG_THREAD = '400000000000'

  test('unmatched session_id falls back to log thread', async () => {
    const transcript = writeTranscript('t5', [
      { type: 'user', message: { content: [{ type: 'text', text: 'orphan' }] }, permissionMode: 'default' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Orphan response' }] } },
    ])

    await runHook(REPLY_SCRIPT, replyInput('sid-unknown', transcript, 'Orphan response'), baseEnv({
      DISCORD_LOG_THREAD: LOG_THREAD,
    }))

    const log = readCurlLog(curlLog)
    expect(curlCallsToChannel(log, LOG_THREAD)).toBeGreaterThanOrEqual(1)
  })

  test('unmatched session + no log thread → silent exit', async () => {
    const transcript = writeTranscript('t5b', [
      { type: 'user', message: { content: [{ type: 'text', text: 'orphan' }] }, permissionMode: 'default' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Orphan' }] } },
    ])

    const { exitCode } = await runHook(REPLY_SCRIPT, replyInput('sid-unknown', transcript, 'Orphan'), baseEnv({
      DISCORD_LOG_THREAD: '',
    }))

    expect(exitCode).toBe(0)
    expect(readCurlLog(curlLog)).toBe('')
  })
})

// ═══════════════════════════════════��══════════════════════════
// Scenario 6: Long response — chunking
// ═════════════════════════════════════���════════════════════════

describe('Scenario: long response chunking', () => {
  const MAIN_CH = '100000000000'
  const SID = 'sid-chunk-006'

  test('response >2000 chars split into multiple messages', async () => {
    await runHook(TRACK_SCRIPT, trackInput(SID, MAIN_CH, 'long question'), baseEnv())

    const longText = 'A'.repeat(1000) + '\n\n' + 'B'.repeat(1000) + '\n\n' + 'C'.repeat(500)
    const transcript = writeTranscript('t6', [
      { type: 'user', message: { content: [{ type: 'text', text: 'long question' }] }, permissionMode: 'default', origin: { kind: 'channel' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: longText }] } },
    ])

    await runHook(REPLY_SCRIPT, replyInput(SID, transcript, longText), baseEnv())

    const log = readCurlLog(curlLog)
    // Should have multiple CALL entries (chunked)
    expect(curlCallCount(log)).toBeGreaterThan(1)
    expect(curlCallsToChannel(log, MAIN_CH)).toBeGreaterThan(1)
  })
})

// ══════════��══════════════════���══════════════════════════════��═
// Scenario 7: Gate + hook pipeline — DM access control
// ═════��═══════════════════════════��═══════════════════════════���

describe('Scenario: access control → hook pipeline', () => {
  test('allowed DM user: gate delivers, hooks route response', async () => {
    const access = defaultAccess()
    access.allowFrom = ['user-allowed']
    const input: GateInput = {
      senderId: 'user-allowed', isDM: true,
      channelId: 'dm-ch', isThread: false, isMentioned: false,
    }

    // Gate check
    const result = gatePure(input, access)
    expect(result.action).toBe('deliver')

    // If delivered, track + reply pipeline runs
    const SID = 'sid-dm-007'
    await runHook(TRACK_SCRIPT, trackInput(SID, 'dm-ch', 'hi from DM'), baseEnv())

    const transcript = writeTranscript('t7', [
      { type: 'user', message: { content: [{ type: 'text', text: 'hi from DM' }] }, permissionMode: 'default' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello via DM!' }] } },
    ])

    await runHook(REPLY_SCRIPT, replyInput(SID, transcript, 'Hello via DM!'), baseEnv())

    const log = readCurlLog(curlLog)
    expect(curlCallsToChannel(log, 'dm-ch')).toBeGreaterThanOrEqual(1)
  })

  test('blocked DM user: gate drops, no hooks run', () => {
    const access: Access = { ...defaultAccess(), dmPolicy: 'allowlist', allowFrom: ['other'] }
    const input: GateInput = {
      senderId: 'blocked-user', isDM: true,
      channelId: 'dm-ch', isThread: false, isMentioned: false,
    }

    const result = gatePure(input, access)
    expect(result.action).toBe('drop')
    // No hooks run → no curl calls
  })

  test('guild message without mention: gate drops', () => {
    const access = defaultAccess()
    access.groups = { 'guild-ch': { requireMention: true, allowFrom: [] } }
    const input: GateInput = {
      senderId: 'user1', isDM: false,
      channelId: 'guild-ch', isThread: false, isMentioned: false,
    }

    expect(gatePure(input, access).action).toBe('drop')
  })

  test('guild message with mention: gate delivers, hooks route', async () => {
    const access = defaultAccess()
    access.groups = { 'guild-ch': { requireMention: true, allowFrom: [] } }
    const input: GateInput = {
      senderId: 'user1', isDM: false,
      channelId: 'guild-ch', isThread: false, isMentioned: true,
    }

    expect(gatePure(input, access).action).toBe('deliver')

    // Hooks pipeline
    const SID = 'sid-guild-007'
    await runHook(TRACK_SCRIPT, trackInput(SID, 'guild-ch', '@claude help'), baseEnv())

    const transcript = writeTranscript('t7b', [
      { type: 'user', message: { content: [{ type: 'text', text: '@claude help' }] }, permissionMode: 'default', origin: { kind: 'channel' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Here to help!' }] } },
    ])

    await runHook(REPLY_SCRIPT, replyInput(SID, transcript, 'Here to help!'), baseEnv())

    const log = readCurlLog(curlLog)
    expect(curlCallsToChannel(log, 'guild-ch')).toBeGreaterThanOrEqual(1)
  })
})

// ════════════════��═════════════════════════════════════════════
// Scenario 8: Re-entry guard
// ══════════════════════════════════════════���═══════════════════

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

    expect(readCurlLog(curlLog)).toBe('')
  })
})
