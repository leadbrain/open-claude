#!/usr/bin/env bun
/**
 * server-http.ts — Single persistent HTTP MCP server for open-claude.
 *
 * One Discord gateway connection. Claude Code sessions connect via
 * StreamableHTTPServerTransport (SSE). Server handles gate, routing,
 * scheduling, thread management, and slash commands.
 *
 * Start: bun run start:http
 * Connect: .mcp.json → { "url": "http://localhost:3100/mcp" }
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { randomUUID } from 'crypto'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import {
  createOpenClaude,
  configFromEnv,
  AccessManager,
  loadFeatures,
  matchesCron,
  type OpenClaudeCore,
  type OpenClaudeConfig,
} from './core.ts'
import { DiscordAdapter } from './adapters/discord.ts'
import { gatePure, pruneExpired, type GateInput } from './lib.ts'
import type { PlatformMessage } from './platform.ts'
import {
  readFileSync, writeFileSync, mkdirSync, existsSync,
  readdirSync, rmSync,
} from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'

// ── Configuration ──

const TOKEN = process.env.DISCORD_BOT_TOKEN
if (!TOKEN) {
  process.stderr.write('open-claude: DISCORD_BOT_TOKEN required\n')
  process.exit(1)
}

const PORT = parseInt(process.env.OPEN_CLAUDE_PORT ?? '3100', 10)
const config = configFromEnv()
const adapter = new DiscordAdapter()
const accessManager = new AccessManager(config)

// Safety net
process.on('unhandledRejection', err => {
  process.stderr.write(`open-claude: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`open-claude: uncaught exception: ${err}\n`)
})

// ── Session Registry ──

const transports = new Map<string, StreamableHTTPServerTransport>()
const cores = new Map<string, OpenClaudeCore>()
const chatToSession = new Map<string, string>()
const sessionToChat = new Map<string, string>()
const pendingThreads: string[] = []
let mainSessionId: string | null = null

// ── HTTP Server ──

async function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', chunk => { data += chunk })
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : undefined) }
      catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  // CORS headers for local development
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  // Health check
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      sessions: transports.size,
      mainSession: mainSessionId ? 'connected' : 'waiting',
      channels: [...chatToSession.keys()],
    }))
    return
  }

  if (!req.url?.startsWith('/mcp')) {
    res.writeHead(404)
    res.end('not found')
    return
  }

  try {
    const body = await parseBody(req)
    const sessionId = req.headers['mcp-session-id'] as string | undefined

    // New session initialization
    if (!sessionId && isInitializeRequest(body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          transports.set(sid, transport)

          // Bind to channel: first connection = main, pending threads = thread
          if (!mainSessionId) {
            mainSessionId = sid
            chatToSession.set(config.mainChannel, sid)
            sessionToChat.set(sid, config.mainChannel)
            process.stderr.write(`open-claude: main session connected (${sid.slice(0, 8)})\n`)
          } else if (pendingThreads.length > 0) {
            const chatId = pendingThreads.shift()!
            chatToSession.set(chatId, sid)
            sessionToChat.set(sid, chatId)
            process.stderr.write(`open-claude: thread ${chatId} session connected (${sid.slice(0, 8)})\n`)
          } else {
            process.stderr.write(`open-claude: extra session connected (${sid.slice(0, 8)}), unbound\n`)
          }
        },
        onsessionclosed: (sid: string) => {
          const chatId = sessionToChat.get(sid)
          if (chatId) chatToSession.delete(chatId)
          sessionToChat.delete(sid)
          transports.delete(sid)
          cores.get(sid)?.destroy()
          cores.delete(sid)
          if (mainSessionId === sid) mainSessionId = null
          process.stderr.write(`open-claude: session closed (${sid.slice(0, 8)}, channel: ${chatId ?? 'unbound'})\n`)
        },
      })

      const core = createOpenClaude(adapter, config)
      await core.mcp.connect(transport)

      // Register after connect — sessionId is set by transport
      const sid = transport.sessionId
      if (sid) cores.set(sid, core)

      await transport.handleRequest(req, res, body)
      return
    }

    // Existing session request
    if (sessionId && transports.has(sessionId)) {
      await transports.get(sessionId)!.handleRequest(req, res, body)
      return
    }

    // Session not found
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'invalid or missing session' }))
  } catch (err) {
    process.stderr.write(`open-claude: HTTP error: ${err}\n`)
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'internal error' }))
    }
  }
})

// ── Discord Message Handler ──

adapter.onMessage(async (msg: PlatformMessage) => {
  // Bot filter — allow own [scheduled] messages only
  if (msg.isBot) {
    if (msg.authorId !== adapter.getBotId() || !msg.content.startsWith('[scheduled]')) return
  }

  // Gate check (single point of access control)
  const access = accessManager.load()
  const pruned = pruneExpired(access)
  if (pruned) accessManager.save(access)

  // Mention detection
  let isMentioned = msg.mentionsBot
  if (!isMentioned && msg.reference?.messageId) {
    if (adapter.isReplyToBot) isMentioned = await adapter.isReplyToBot(msg)
  }
  if (!isMentioned && access.mentionPatterns?.length) {
    isMentioned = adapter.matchesPatterns?.(msg.content, access.mentionPatterns) ?? false
  }

  const gateInput: GateInput = {
    senderId: msg.authorId,
    isDM: msg.isDM,
    channelId: msg.channelId,
    isThread: msg.isThread,
    parentId: msg.parentChannelId,
    isMentioned,
  }

  const result = gatePure(gateInput, access)

  if (result.action === 'drop') return
  if (result.action === 'need_pair') {
    const { randomBytes } = await import('crypto')
    const code = randomBytes(3).toString('hex')
    const now = Date.now()
    access.pending[code] = {
      senderId: msg.authorId,
      chatId: msg.channelId,
      createdAt: now,
      expiresAt: now + 60 * 60 * 1000,
      replies: 1,
    }
    accessManager.save(access)
    try {
      await adapter.sendMessage(msg.channelId, {
        content: `Pairing required — approve from your terminal with the code:\n\n\`${code}\``,
        replyTo: msg.id,
      })
    } catch {}
    return
  }
  if (result.action === 'pair') {
    const pending = access.pending[result.code]
    if (pending) {
      pending.replies = (pending.replies ?? 1) + 1
      accessManager.save(access)
    }
    try {
      await adapter.sendMessage(msg.channelId, {
        content: `Still pending — approve code \`${result.code}\` from your terminal.`,
        replyTo: msg.id,
      })
    } catch {}
    return
  }

  // Ack reaction
  if (access.ackReaction) {
    adapter.react(msg.channelId, msg.id, access.ackReaction).catch(() => {})
  }

  // Route to session
  const sessionId = chatToSession.get(msg.channelId)
  if (sessionId && cores.has(sessionId)) {
    await cores.get(sessionId)!.handleInbound(msg).catch(err => {
      process.stderr.write(`open-claude: handleInbound failed: ${err}\n`)
    })
    return
  }

  // Thread with no session — spawn
  if (msg.isThread && msg.channelId !== config.mainChannel) {
    spawnThreadSession(msg)
    return
  }

  // Main channel but no session yet ��� ignore (waiting for Claude to connect)
  if (!mainSessionId) {
    process.stderr.write(`open-claude: no main session, dropping message from ${msg.authorName}\n`)
  }
})

// ── Thread Spawning ──

function spawnThreadSession(msg: PlatformMessage): void {
  const chatId = msg.channelId
  const tmuxSession = config.tmuxSession
  const windowName = `thread-${chatId}`

  // Check if tmux window already exists
  try {
    execSync(
      `tmux has-session -t ${tmuxSession} 2>/dev/null && tmux list-windows -t ${tmuxSession} -F "#{window_name}" | grep -q "^${windowName}$"`,
      { timeout: 3000 },
    )
    return // Already exists
  } catch {}

  process.stderr.write(`open-claude: spawning thread session for ${chatId}\n`)
  adapter.sendTyping(chatId).catch(() => {})

  // Check for existing session to resume
  const threadsDir = join(config.workspace, 'memory', 'threads')
  mkdirSync(threadsDir, { recursive: true })
  const stateFile = join(threadsDir, `${chatId}.json`)
  let resumeArg = ''
  try {
    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    if (state.session_id) resumeArg = `--resume ${state.session_id}`
  } catch {}

  // Write first prompt to file
  const promptFile = join(config.workspace, '.claude', 'discord', `prompt-${chatId}.txt`)
  mkdirSync(join(config.workspace, '.claude', 'discord'), { recursive: true })
  const prompt = `<channel source="discord" chat_id="${chatId}" message_id="${msg.id}" user="${msg.authorName}" user_id="${msg.authorId}" ts="${msg.createdAt.toISOString()}">\n${msg.content}\n</channel>`
  writeFileSync(promptFile, prompt)

  // Export env vars for hooks
  const envExports = Object.entries(process.env)
    .filter(([k]) => k.startsWith('DISCORD_') || k === 'OPEN_CLAUDE_WORKSPACE')
    .map(([k, v]) => `export ${k}='${(v ?? '').replace(/'/g, "'\\''")}'`)
    .join(' && ')

  const threadModel = config.threadModel
  const cmd = `cd '${config.workspace}' && ${envExports} && claude --dangerously-load-development-channels plugin:open-claude@open-claude --model ${threadModel} ${resumeArg} "$(cat '${promptFile}')" && rm -f '${promptFile}'`

  try {
    execSync(`tmux new-window -t ${tmuxSession} -n ${windowName} '${cmd.replace(/'/g, "'\\''")}'`, { timeout: 5000 })
    pendingThreads.push(chatId)
    process.stderr.write(`open-claude: thread ${chatId} tmux window created\n`)
  } catch (err) {
    process.stderr.write(`open-claude: thread spawn failed: ${err}\n`)
    adapter.sendMessage(chatId, {
      content: `\u26A0\uFE0F Failed to create thread session.`,
    }).catch(() => {})
  }
}

// ── Scheduler ──

setInterval(() => {
  const features = loadFeatures(config.workspace)
  const now = new Date()
  for (const [name, feat] of Object.entries(features)) {
    if (!feat.enabled || !feat.schedule || !feat.targetChannel) continue
    if (!matchesCron(feat.schedule, now)) continue

    adapter.sendMessage(feat.targetChannel, {
      content: `[scheduled] /${name}`,
    }).catch(err => {
      process.stderr.write(`open-claude: scheduler ${name} failed: ${err}\n`)
    })
  }
}, 60_000).unref()

// ── Approval Polling ──

if (!config.staticMode) {
  setInterval(() => {
    const approvedDir = accessManager.approvedDir
    let files: string[]
    try { files = readdirSync(approvedDir) } catch { return }
    for (const senderId of files) {
      const file = join(approvedDir, senderId)
      let dmChannelId: string
      try { dmChannelId = readFileSync(file, 'utf8').trim() } catch {
        rmSync(file, { force: true }); continue
      }
      if (!dmChannelId) { rmSync(file, { force: true }); continue }

      adapter.sendMessage(dmChannelId, { content: "Paired! Say hi to Claude." })
        .then(() => rmSync(file, { force: true }))
        .catch(() => rmSync(file, { force: true }))
    }
  }, 5000).unref()
}

// ── Slash Commands ──

if (adapter.onInteraction) {
  adapter.onInteraction(async (interaction: any) => {
    if (!interaction.isChatInputCommand?.()) return
    const { commandName } = interaction
    const tmux = config.tmuxSession

    if (commandName === 'clear') {
      const ch = interaction.channel
      const isThread = ch && 'isThread' in ch && ch.isThread()
      if (isThread) {
        const chatId = interaction.channelId
        const threadFile = join(config.workspace, 'memory', 'threads', `${chatId}.json`)
        if (existsSync(threadFile)) {
          try {
            rmSync(threadFile)
            await interaction.reply({ content: '\u2705 Session reset.' })
          } catch (err) {
            await interaction.reply({ content: `\u26A0\uFE0F Reset failed: ${err}`, ephemeral: true })
          }
        } else {
          await interaction.reply({ content: '\u2139\uFE0F No active session.', ephemeral: true })
        }
      } else if (tmux) {
        try {
          execSync(`tmux send-keys -t ${tmux} "/clear" Enter`, { timeout: 5000 })
          await interaction.reply({ content: '\u2705 Sent /clear to main session.' })
        } catch (err) {
          await interaction.reply({ content: `\u26A0\uFE0F Failed: ${err}`, ephemeral: true })
        }
      }
      return
    }

    if (['compact', 'restart', 'enter', 'esc'].includes(commandName) && tmux) {
      const keyMap: Record<string, string> = {
        compact: '"/compact" Enter',
        enter: 'Enter',
        esc: 'Escape',
      }
      if (commandName === 'restart') {
        try {
          const panePid = execSync(`tmux list-panes -t ${tmux} -F "#{pane_pid}" | head -1`, { timeout: 5000 }).toString().trim()
          const cmd = execSync(`ps -p ${panePid} -o command=`, { timeout: 5000 }).toString().trim()
          await interaction.reply({ content: `\uD83D\uDD04 Restarting...\n\`\`\`\n${cmd}\n\`\`\`` })
          setTimeout(() => {
            try { execSync(`tmux respawn-pane -k -t ${tmux} '${cmd.replace(/'/g, "'\\''")}'`, { timeout: 5000 }) } catch {}
          }, 1500)
        } catch (err) {
          await interaction.reply({ content: `\u26A0\uFE0F Failed: ${err}`, ephemeral: true })
        }
        return
      }
      try {
        execSync(`tmux send-keys -t ${tmux} ${keyMap[commandName]}`, { timeout: 5000 })
        await interaction.reply({ content: `\u2705 Sent ${commandName} to main session.` })
      } catch (err) {
        await interaction.reply({ content: `\u26A0\uFE0F Failed: ${err}`, ephemeral: true })
      }
    }
  })
}

// ── Shutdown ──

let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write('open-claude: shutting down HTTP server\n')
  for (const [, core] of cores) core.destroy()
  httpServer.close()
  setTimeout(() => process.exit(0), 2000)
  void adapter.destroy().finally(() => process.exit(0))
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// ── Start ──

adapter.onReady((botId, botName) => {
  process.stderr.write(`open-claude: Discord connected as ${botName}\n`)
  // Register slash commands
  const discordAdapter = adapter as any
  if (discordAdapter.registerSlashCommands && discordAdapter.getClient) {
    const client = discordAdapter.getClient()
    const guildIds = [...client.guilds.cache.keys()]
    discordAdapter.registerSlashCommands(guildIds).catch((err: Error) => {
      process.stderr.write(`open-claude: slash command registration failed: ${err}\n`)
    })
  }
})

// Start HTTP server first (Claude Code expects immediate handshake)
httpServer.listen(PORT, '127.0.0.1', () => {
  process.stderr.write(`open-claude: HTTP MCP server on http://127.0.0.1:${PORT}/mcp\n`)
})

// Then connect Discord
await adapter.login(TOKEN)
