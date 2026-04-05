#!/usr/bin/env bun
/**
 * server-http.ts — Persistent HTTP server for open-claude.
 *
 * Single Discord gateway connection. Exposes:
 *   GET  /events?session=<id>  — SSE stream for proxy to receive Discord messages
 *   POST /api/register         — Proxy registers itself with a session ID + chat_id
 *   POST /api/tools            — Proxy forwards tool calls (reply, react, etc.)
 *   GET  /health               — Server status
 *
 * Proxy (proxy.ts) connects via stdio to Claude Code and bridges:
 *   Discord message → SSE → proxy → claude/channel notification → Claude
 *   Claude tool call → proxy → POST /api/tools → Discord
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { randomUUID } from 'crypto'
import {
  configFromEnv,
  AccessManager,
  loadFeatures,
  matchesCron,
  type OpenClaudeConfig,
} from './core.ts'
import { DiscordAdapter } from './adapters/discord.ts'
import { gatePure, pruneExpired, defaultAccess, chunk, MAX_CHUNK_LIMIT, type GateInput, type Access } from './lib.ts'
import type { PlatformMessage, PlatformAttachment } from './platform.ts'
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

process.on('unhandledRejection', err => {
  process.stderr.write(`open-claude: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`open-claude: uncaught exception: ${err}\n`)
})

// ── Session Registry ──

interface Session {
  sessionId: string
  chatId: string
  messageQueue: unknown[]  // Messages waiting to be polled by proxy
}

const sessions = new Map<string, Session>()
const chatToSession = new Map<string, string>()

// Track ack'd messages so we can remove the reaction on reply
const ackedMessages = new Map<string, { chatId: string; emoji: string }>()  // messageId → { chatId, emoji }

function getSessionByChatId(chatId: string): Session | undefined {
  const sid = chatToSession.get(chatId)
  return sid ? sessions.get(sid) : undefined
}

function enqueueMessage(session: Session, data: unknown): void {
  session.messageQueue.push(data)
  // Cap queue at 100
  if (session.messageQueue.length > 100) session.messageQueue.shift()
}

// ── HTTP Server ──

async function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', chunk => { data += chunk })
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}) }
      catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)

  // ── Health ──
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      sessions: sessions.size,
      channels: [...chatToSession.entries()].map(([c, s]) => ({ chatId: c, sessionId: s.slice(0, 8) })),
    }))
    return
  }

  // ── Register: proxy tells server which chat_id it handles ──
  if (url.pathname === '/api/register' && req.method === 'POST') {
    try {
      const body = await parseBody(req)
      const chatId = body.chat_id as string
      const sessionId = body.session_id as string || randomUUID()

      // Re-register: keep existing queue
      const existing = sessions.get(sessionId)
      if (existing && existing.chatId === chatId) {
        process.stderr.write(`open-claude: re-register session=${sessionId.slice(0, 8)} queue=${existing.messageQueue.length}\n`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ sessionId, chatId, queued: existing.messageQueue.length }))
        return
      }

      // Cleanup old session for this chat_id
      const oldSid = chatToSession.get(chatId)
      if (oldSid && oldSid !== sessionId) {
        sessions.delete(oldSid)
      }

      const session: Session = { sessionId, chatId, messageQueue: [] }
      sessions.set(sessionId, session)
      chatToSession.set(chatId, sessionId)

      process.stderr.write(`open-claude: registered session=${sessionId.slice(0, 8)} chat=${chatId}\n`)

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ sessionId, chatId }))
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: String(err) }))
    }
    return
  }

  // ── Messages: proxy polls for new messages ──
  if (url.pathname === '/api/messages' && req.method === 'GET') {
    const sessionId = url.searchParams.get('session')
    if (!sessionId || !sessions.has(sessionId)) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'session not found' }))
      return
    }
    const session = sessions.get(sessionId)!
    const messages = session.messageQueue.splice(0)  // drain queue
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ messages }))
    return
  }

  // ── Ack clear: Stop hook notifies response was sent ──
  if (url.pathname === '/api/ack-clear' && req.method === 'POST') {
    try {
      const body = await parseBody(req)
      const chatId = body.chat_id as string
      for (const [msgId, ack] of ackedMessages) {
        if (ack.chatId === chatId) {
          adapter.removeReaction(chatId, msgId, ack.emoji).catch(() => {})
          ackedMessages.delete(msgId)
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    } catch {
      res.writeHead(200)
      res.end()
    }
    return
  }

  // ── Tools: proxy forwards Claude's tool calls ──
  if (url.pathname === '/api/tools' && req.method === 'POST') {
    try {
      const body = await parseBody(req)
      const { tool, args } = body as { tool: string; args: Record<string, unknown> }
      const result = await handleToolCall(tool, args)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: String(err) }))
    }
    return
  }

  res.writeHead(404)
  res.end('not found')
})

// ── Tool handler ──

async function handleToolCall(tool: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
  switch (tool) {
    case 'reply': {
      const chatId = args.chat_id as string
      const text = args.text as string
      const replyTo = args.reply_to as string | undefined
      const files = (args.files as string[] | undefined) ?? []

      if (files.length > 10) throw new Error('max 10 attachments')

      const access = accessManager.load()
      const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
      const mode = access.chunkMode ?? 'newline'
      const replyMode = access.replyToMode ?? 'first'
      const chunks = chunk(text, limit, mode)
      const sentIds: string[] = []

      for (let i = 0; i < chunks.length; i++) {
        const shouldReplyTo = replyTo != null && replyMode !== 'off' && (replyMode === 'all' || i === 0)
        const id = await adapter.sendMessage(chatId, {
          content: chunks[i],
          ...(i === 0 && files.length > 0 ? { files } : {}),
          ...(shouldReplyTo ? { replyTo } : {}),
        })
        sentIds.push(id)
      }

      return { text: sentIds.length === 1 ? `sent (id: ${sentIds[0]})` : `sent ${sentIds.length} parts` }
    }

    case 'react': {
      await adapter.react(args.chat_id as string, args.message_id as string, args.emoji as string)
      return { text: 'reacted' }
    }

    case 'edit_message': {
      await adapter.editMessage(args.chat_id as string, args.message_id as string, args.text as string)
      return { text: 'edited' }
    }

    case 'fetch_messages': {
      const channelId = args.channel as string
      const limit = Math.min((args.limit as number) ?? 20, 100)
      const msgs = await adapter.fetchMessages(channelId, limit)
      const me = adapter.getBotId()
      const out = msgs.length === 0
        ? '(no messages)'
        : msgs.map(m => {
            const who = m.authorId === me ? 'me' : m.authorName
            const atts = m.attachmentCount > 0 ? ` +${m.attachmentCount}att` : ''
            const text = m.content.replace(/[\r\n]+/g, ' \u23CE ')
            return `[${m.createdAt.toISOString()}] ${who}: ${text}  (id: ${m.id}${atts})`
          }).join('\n')
      return { text: out }
    }

    case 'search': {
      const qmdPath = '/opt/homebrew/bin/qmd'
      if (!existsSync(qmdPath)) return { text: 'QMD not available', isError: true }
      const query = (args.query as string).replace(/"/g, '\\"')
      const collection = (args.collection as string) ?? 'all'
      const mode = (args.mode as string) ?? 'search'
      const limit = (args.limit as number) ?? 5
      const collectionArg = collection === 'all' ? '' : `-c ${collection}`
      const result = execSync(`${qmdPath} ${mode} ${collectionArg} -n ${limit} "${query}"`, { encoding: 'utf8', timeout: 15000 })
      return { text: result || '(no results)' }
    }

    default:
      return { text: `unknown tool: ${tool}`, isError: true }
  }
}

// ── Discord Message Handler ──

adapter.onMessage(async (msg: PlatformMessage) => {
  process.stderr.write(`open-claude: onMessage from=${msg.authorName} ch=${msg.channelId} isBot=${msg.isBot} isDM=${msg.isDM}\n`)
  // Bot filter — allow own [scheduled] messages only
  if (msg.isBot) {
    if (msg.authorId !== adapter.getBotId() || !msg.content.startsWith('[scheduled]')) return
  }

  // Gate check
  const access = accessManager.load()
  const pruned = pruneExpired(access)
  if (pruned) accessManager.save(access)

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
  process.stderr.write(`open-claude: gate=${result.action} mention=${isMentioned}\n`)

  if (result.action === 'drop') return
  if (result.action === 'need_pair') {
    const { randomBytes } = await import('crypto')
    const code = randomBytes(3).toString('hex')
    const now = Date.now()
    access.pending[code] = {
      senderId: msg.authorId, chatId: msg.channelId,
      createdAt: now, expiresAt: now + 60 * 60 * 1000, replies: 1,
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
    ackedMessages.set(msg.id, { chatId: msg.channelId, emoji: access.ackReaction })
  }

  // Route to session — enqueue for polling
  const session = getSessionByChatId(msg.channelId)
  if (session) {
    adapter.sendTyping(msg.channelId).catch(() => {})

    const atts = msg.attachments.map(att => {
      const kb = (att.size / 1024).toFixed(0)
      return `${att.name} (${att.contentType ?? 'unknown'}, ${kb}KB)`
    })
    const content = msg.content || (atts.length > 0 ? '(attachment)' : '')

    enqueueMessage(session, {
      content,
      meta: {
        chat_id: msg.channelId,
        message_id: msg.id,
        user: msg.authorName,
        user_id: msg.authorId,
        ts: msg.createdAt.toISOString(),
        ...(atts.length > 0 ? { attachment_count: String(atts.length), attachments: atts.join('; ') } : {}),
      },
    })
    process.stderr.write(`open-claude: enqueued for session=${session.sessionId.slice(0, 8)} queue=${session.messageQueue.length}\n`)
    return
  }

  // Thread with no session — spawn
  if (msg.isThread && msg.channelId !== config.mainChannel) {
    spawnThreadSession(msg)
    return
  }

  process.stderr.write(`open-claude: no session for ch=${msg.channelId}, dropping\n`)
})

// ── Thread Spawning ──

function spawnThreadSession(msg: PlatformMessage): void {
  const chatId = msg.channelId
  const tmuxSession = config.tmuxSession
  const windowName = `thread-${chatId}`

  try {
    execSync(
      `tmux has-session -t ${tmuxSession} 2>/dev/null && tmux list-windows -t ${tmuxSession} -F "#{window_name}" | grep -q "^${windowName}$"`,
      { timeout: 3000 },
    )
    return
  } catch {}

  process.stderr.write(`open-claude: spawning thread session for ${chatId}\n`)
  adapter.sendTyping(chatId).catch(() => {})

  const threadsDir = join(config.workspace, 'memory', 'threads')
  mkdirSync(threadsDir, { recursive: true })
  const stateFile = join(threadsDir, `${chatId}.json`)
  let resumeArg = ''
  try {
    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    if (state.session_id) resumeArg = `--resume ${state.session_id}`
  } catch {}

  const promptFile = join(config.workspace, '.claude', 'discord', `prompt-${chatId}.txt`)
  mkdirSync(join(config.workspace, '.claude', 'discord'), { recursive: true })
  const prompt = `<channel source="discord" chat_id="${chatId}" message_id="${msg.id}" user="${msg.authorName}" user_id="${msg.authorId}" ts="${msg.createdAt.toISOString()}">\n${msg.content}\n</channel>`
  writeFileSync(promptFile, prompt)

  // OPEN_CLAUDE_CHAT_ID must NOT be in .mcp.json — set via shell env only
  // so each thread gets its own chat_id while sharing the same .mcp.json
  const envExports = Object.entries(process.env)
    .filter(([k]) => k.startsWith('DISCORD_') || k === 'OPEN_CLAUDE_WORKSPACE' || k === 'OPEN_CLAUDE_PORT')
    .map(([k, v]) => `export ${k}='${(v ?? '').replace(/'/g, "'\\''")}'`)
    .join(' && ')

  const threadModel = config.threadModel
  const cmd = `cd '${config.workspace}' && ${envExports} && export OPEN_CLAUDE_CHAT_ID=${chatId} && claude --dangerously-skip-permissions --dangerously-load-development-channels server:open-claude --model ${threadModel} ${resumeArg} "$(cat '${promptFile}')" && rm -f '${promptFile}'`

  try {
    execSync(`tmux new-window -t ${tmuxSession} -n ${windowName} '${cmd.replace(/'/g, "'\\''")}'`, { timeout: 5000 })
    // Auto-approve development channels prompt
    setTimeout(() => {
      try { execSync(`tmux send-keys -t ${tmuxSession}:${windowName} Enter`, { timeout: 3000 }) } catch {}
    }, 3000)
    process.stderr.write(`open-claude: thread ${chatId} tmux window created\n`)
  } catch (err) {
    process.stderr.write(`open-claude: thread spawn failed: ${err}\n`)
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
    let files: string[]
    try { files = readdirSync(accessManager.approvedDir) } catch { return }
    for (const senderId of files) {
      const file = join(accessManager.approvedDir, senderId)
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
          try { rmSync(threadFile); await interaction.reply({ content: '\u2705 Session reset.' }) }
          catch (err) { await interaction.reply({ content: `\u26A0\uFE0F Reset failed: ${err}`, ephemeral: true }) }
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

    if (['compact', 'enter', 'esc'].includes(commandName) && tmux) {
      const keyMap: Record<string, string> = { compact: '"/compact" Enter', enter: 'Enter', esc: 'Escape' }
      try {
        execSync(`tmux send-keys -t ${tmux} ${keyMap[commandName]}`, { timeout: 5000 })
        await interaction.reply({ content: `\u2705 Sent ${commandName}.` })
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
  httpServer.close()
  setTimeout(() => process.exit(0), 2000)
  void adapter.destroy().finally(() => process.exit(0))
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// ── Start ──

adapter.onReady((botId, botName) => {
  process.stderr.write(`open-claude: Discord connected as ${botName}\n`)
  const discordAdapter = adapter as any
  if (discordAdapter.registerSlashCommands && discordAdapter.getClient) {
    const client = discordAdapter.getClient()
    const guildIds = [...client.guilds.cache.keys()]
    discordAdapter.registerSlashCommands(guildIds).catch((err: Error) => {
      process.stderr.write(`open-claude: slash command registration failed: ${err}\n`)
    })
  }
})

httpServer.listen(PORT, '127.0.0.1', () => {
  process.stderr.write(`open-claude: HTTP server on http://127.0.0.1:${PORT}\n`)
})

await adapter.login(TOKEN)
