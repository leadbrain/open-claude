import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { join } from 'path'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { $ } from 'bun'
import { createServer } from 'http'

const FIXTURES_DIR = join(import.meta.dir, 'fixtures')
const HOOK_SCRIPT = join(import.meta.dir, '..', 'hooks', 'auto-reply.sh')

// ── jq extraction tests (test the jq pipeline directly) ──

describe('jq transcript extraction', () => {
  async function extractWithJq(fixtureName: string): Promise<string> {
    const fixture = join(FIXTURES_DIR, fixtureName)
    const result = await $`cat ${fixture} | jq -s '
      ([.[] | select(.type == "user" and (.toolUseResult | type) == "object" and .toolUseResult.structuredPatch) |
        {key: (.toolUseResult.tool_use_id // ""), value: .toolUseResult}] | from_entries) as $patches |
      [.[] | select(.type == "assistant") | .message.content[]? |
        if .type == "text" then .text
        elif .type == "tool_use" then
          (if .name == "Bash" then
            "> \u0060Bash\u0060 \u0060" + ((.input.command // "") | split("\n")[0] | .[0:80]) + "\u0060"
          elif .name == "Read" then
            "> \u0060Read\u0060 " + ((.input.file_path // "") | split("/") | .[-2:] | join("/"))
          elif .name == "Write" then
            "> \u0060Write\u0060 " + ((.input.file_path // "") | split("/") | last)
          elif .name == "Glob" then
            "> \u0060Glob\u0060 \u0060" + (.input.pattern // "") + "\u0060"
          elif .name == "Grep" then
            "> \u0060Grep\u0060 \u0060" + (.input.pattern // "") + "\u0060" + (if .input.path then " in " + (.input.path | split("/") | last) else "" end)
          elif .name == "Edit" then
            "> \u0060Edit\u0060 " + ((.input.file_path // "") | split("/") | last) +
            ($patches[.id] // null | if . then
              "\n\u0060\u0060\u0060ansi\n" + ([.structuredPatch[].lines[] |
                if startswith("-") then "\u001b[0;31m" + . + "\u001b[0m"
                elif startswith("+") then "\u001b[0;32m" + . + "\u001b[0m"
                else . end] | join("\n")) + "\n\u0060\u0060\u0060"
            else "" end)
          elif .name == "Agent" then
            "> \u0060Agent\u0060 " + (.input.description // .name)
          else
            "> \u0060" + .name + "\u0060"
          end)
        else empty end
      ] | join("\n\n")' -r`.text()
    return result.trim()
  }

  test('extracts text-only transcript', async () => {
    const result = await extractWithJq('transcript-text-only.jsonl')
    expect(result).toBe('Hi there! How can I help you?')
  })

  test('extracts tool_use summaries', async () => {
    const result = await extractWithJq('transcript-with-tools.jsonl')
    expect(result).toContain('Let me check the files.')
    expect(result).toContain('> `Bash` `ls -la src/`')
    expect(result).toContain('> `Read` project/server.ts')
    expect(result).toContain('> `Glob` `**/*.ts`')
    expect(result).toContain('> `Grep` `TODO` in src')
    expect(result).toContain('Found 3 TypeScript files.')
  })

  test('extracts Edit with structuredPatch diff', async () => {
    const result = await extractWithJq('transcript-with-edits.jsonl')
    expect(result).toContain("I'll fix that.")
    expect(result).toContain('> `Edit` server.ts')
    expect(result).toContain('```ansi')
    expect(result).toContain('\x1b[0;31m-const x = 1\x1b[0m')
    expect(result).toContain('\x1b[0;32m+const x = 2\x1b[0m')
    expect(result).toContain('Fixed the bug.')
  })

  test('preserves content order', async () => {
    const result = await extractWithJq('transcript-with-tools.jsonl')
    const textIdx = result.indexOf('Let me check the files.')
    const bashIdx = result.indexOf('> `Bash`')
    const foundIdx = result.indexOf('Found 3 TypeScript files.')
    expect(textIdx).toBeLessThan(bashIdx)
    expect(bashIdx).toBeLessThan(foundIdx)
  })
})

// ── auto-reply.sh integration tests ──
// auto-reply.sh now sends via POST /api/tools to the server.
// We spin up a mock HTTP server to capture the calls.

describe('auto-reply.sh', () => {
  let tmpDir: string
  let mockServer: ReturnType<typeof createServer>
  let mockPort: number
  let toolCalls: { tool: string; args: any }[]

  beforeEach(async () => {
    tmpDir = join(import.meta.dir, '.tmp-test-' + Date.now())
    mkdirSync(join(tmpDir, 'memory', 'threads'), { recursive: true })
    toolCalls = []

    // Mock server for /api/tools and /api/ack-clear
    mockServer = createServer((req, res) => {
      let data = ''
      req.on('data', c => { data += c })
      req.on('end', () => {
        if (req.url === '/api/tools') {
          try { toolCalls.push(JSON.parse(data)) } catch {}
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ text: 'ok' }))
      })
    })
    await new Promise<void>(resolve => {
      mockServer.listen(0, '127.0.0.1', () => {
        mockPort = (mockServer.address() as any).port
        resolve()
      })
    })
  })

  afterEach(() => {
    mockServer.close()
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true })
  })

  function runHook(input: string, env: Record<string, string>) {
    return Bun.spawn(['bash', HOOK_SCRIPT], {
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
  }

  test('exits silently without BOT_TOKEN', async () => {
    const input = JSON.stringify({
      session_id: 'sid-1',
      transcript_path: join(FIXTURES_DIR, 'transcript-text-only.jsonl'),
    })
    const proc = runHook(input, { DISCORD_BOT_TOKEN: '', OPEN_CLAUDE_WORKSPACE: tmpDir })
    proc.stdin.write(input)
    proc.stdin.end()
    await proc.exited
    await new Promise(r => setTimeout(r, 300))
    expect(toolCalls).toHaveLength(0)
  })

  test('routes to correct channel via session_id lookup', async () => {
    const chatId = '123456789'
    writeFileSync(
      join(tmpDir, 'memory', 'threads', `${chatId}.json`),
      JSON.stringify({ session_id: 'sid-test', last_active: new Date().toISOString() }),
    )

    const input = JSON.stringify({
      session_id: 'sid-test',
      transcript_path: join(FIXTURES_DIR, 'transcript-text-only.jsonl'),
      last_assistant_message: 'Hi there! How can I help you?',
    })

    const proc = runHook(input, {
      DISCORD_BOT_TOKEN: 'fake-token',
      DISCORD_MAIN_CHANNEL: chatId,
      OPEN_CLAUDE_WORKSPACE: tmpDir,
    })
    proc.stdin.write(input)
    proc.stdin.end()
    await proc.exited
    await new Promise(r => setTimeout(r, 500))

    expect(toolCalls.length).toBeGreaterThanOrEqual(1)
    expect(toolCalls[0].tool).toBe('reply')
    expect(toolCalls[0].args.chat_id).toBe(chatId)
  })

  test('falls back to log thread when no session mapping', async () => {
    const logThread = '987654321'
    const input = JSON.stringify({
      session_id: 'unknown-sid',
      transcript_path: join(FIXTURES_DIR, 'transcript-text-only.jsonl'),
      last_assistant_message: 'Hi there! How can I help you?',
    })

    const proc = runHook(input, {
      DISCORD_BOT_TOKEN: 'fake-token',
      DISCORD_LOG_THREAD: logThread,
      OPEN_CLAUDE_WORKSPACE: tmpDir,
    })
    proc.stdin.write(input)
    proc.stdin.end()
    await proc.exited
    await new Promise(r => setTimeout(r, 500))

    expect(toolCalls.length).toBeGreaterThanOrEqual(1)
    expect(toolCalls[0].args.chat_id).toBe(logThread)
  })

  test('exits when no route found and no log thread', async () => {
    const input = JSON.stringify({
      session_id: 'unknown-sid',
      transcript_path: join(FIXTURES_DIR, 'transcript-text-only.jsonl'),
    })
    const proc = runHook(input, {
      DISCORD_BOT_TOKEN: 'fake-token',
      OPEN_CLAUDE_WORKSPACE: tmpDir,
    })
    proc.stdin.write(input)
    proc.stdin.end()
    await proc.exited
    await new Promise(r => setTimeout(r, 300))
    expect(toolCalls).toHaveLength(0)
  })

  test('skips when CLAUDE_HOOK_NOREENTRY=1', async () => {
    const input = JSON.stringify({ session_id: 'sid-1' })
    const proc = runHook(input, {
      CLAUDE_HOOK_NOREENTRY: '1',
      DISCORD_BOT_TOKEN: 'fake-token',
    })
    proc.stdin.write(input)
    proc.stdin.end()
    await proc.exited
    await new Promise(r => setTimeout(r, 300))
    expect(toolCalls).toHaveLength(0)
  })
})
