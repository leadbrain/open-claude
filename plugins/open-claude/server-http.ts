#!/usr/bin/env bun
/**
 * server-http.ts — Persistent HTTP server for open-claude.
 *
 * Supports simultaneous Discord + Lark connections. Each platform adapter
 * runs independently; channels are auto-mapped to their platform.
 *
 * Exposes:
 *   POST /api/register         — Proxy registers with session ID + chat_id
 *   GET  /api/messages         — Proxy polls for new messages
 *   POST /api/tools            — Proxy forwards tool calls
 *   POST /api/ack-clear        — Stop hook clears ack reactions
 *   GET  /health               — Server status
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { randomUUID } from 'crypto'
import {
  configFromEnv,
  AccessManager,
  loadJobs,
  matchesCron,
  type OpenClaudeConfig,
} from './core.ts'
import { DiscordAdapter } from './adapters/discord.ts'
import { LarkAdapter } from './adapters/lark.ts'
import type { PlatformAdapter, PlatformMessage } from './platform.ts'
import { gatePure, pruneExpired, chunk, MAX_CHUNK_LIMIT, type GateInput } from './lib.ts'
import {
  readFileSync, writeFileSync, mkdirSync, existsSync,
  readdirSync, rmSync,
} from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'

// ── Configuration ──

const PORT = parseInt(process.env.OPEN_CLAUDE_PORT ?? '3100', 10)
const config = configFromEnv()
const accessManager = new AccessManager(config)

process.on('unhandledRejection', err => {
  process.stderr.write(`open-claude: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`open-claude: uncaught exception: ${err}\n`)
})

// ── Multi-platform adapters ──

const adapters: Record<string, PlatformAdapter> = {}
const channelPlatform = new Map<string, string>()  // chatId → platform name

// Initialize adapters based on available credentials
const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN
const LARK_SECRET = process.env.LARK_APP_SECRET

if (!DISCORD_TOKEN && !LARK_SECRET) {
  process.stderr.write('open-claude: at least one platform required (DISCORD_BOT_TOKEN or LARK_APP_SECRET)\n')
  process.exit(1)
}

if (DISCORD_TOKEN) {
  adapters.discord = new DiscordAdapter()
}
if (LARK_SECRET && process.env.LARK_APP_ID) {
  adapters.lark = new LarkAdapter()
}

/** Get the adapter for a given channel. Falls back to first available. */
function getAdapter(chatId?: string): PlatformAdapter {
  if (chatId) {
    const platform = channelPlatform.get(chatId)
    if (platform && adapters[platform]) return adapters[platform]
  }
  return Object.values(adapters)[0]
}

/** Get all bot IDs across platforms */
function isSelfBot(authorId: string): boolean {
  return Object.values(adapters).some(a => a.getBotId() === authorId)
}

// ── Session Registry ──

interface QueuedMessage {
  seq: number
  data: unknown
}

interface Session {
  sessionId: string
  chatId: string
  messageQueue: QueuedMessage[]
  nextSeq: number
}

const sessions = new Map<string, Session>()
const chatToSession = new Map<string, string>()
const ackedMessages = new Map<string, { chatId: string; emoji: string }>()
const typingIntervals = new Map<string, ReturnType<typeof setInterval>>()  // chatId → interval

function startTyping(chatId: string): void {
  if (typingIntervals.has(chatId)) return
  getAdapter(chatId).sendTyping(chatId).catch(() => {})
  const interval = setInterval(() => {
    getAdapter(chatId).sendTyping(chatId).catch(() => {})
  }, 8000)
  typingIntervals.set(chatId, interval)
}

function stopTyping(chatId: string): void {
  const interval = typingIntervals.get(chatId)
  if (interval) {
    clearInterval(interval)
    typingIntervals.delete(chatId)
  }
}

function getSessionByChatId(chatId: string): Session | undefined {
  const sid = chatToSession.get(chatId)
  return sid ? sessions.get(sid) : undefined
}

function enqueueToSession(session: Session, msg: PlatformMessage): void {
  startTyping(msg.channelId)

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
}

function enqueueMessage(session: Session, data: unknown): void {
  session.messageQueue.push({ seq: session.nextSeq++, data })
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

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      platforms: Object.keys(adapters),
      sessions: sessions.size,
      channels: [...chatToSession.entries()].map(([c, s]) => ({
        chatId: c, sessionId: s.slice(0, 8), platform: channelPlatform.get(c) ?? 'unknown',
      })),
    }))
    return
  }

  if (url.pathname === '/api/register' && req.method === 'POST') {
    try {
      const body = await parseBody(req)
      const chatId = body.chat_id as string
      const sessionId = body.session_id as string || randomUUID()

      const existing = sessions.get(sessionId)
      if (existing && existing.chatId === chatId) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ sessionId, chatId, queued: existing.messageQueue.length }))
        return
      }

      const oldSid = chatToSession.get(chatId)
      if (oldSid && oldSid !== sessionId) sessions.delete(oldSid)

      sessions.set(sessionId, { sessionId, chatId, messageQueue: [], nextSeq: 0 })
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

  if (url.pathname === '/api/messages' && req.method === 'GET') {
    const sessionId = url.searchParams.get('session')
    if (!sessionId || !sessions.has(sessionId)) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'session not found' }))
      return
    }
    const session = sessions.get(sessionId)!
    // Peek — don't drain. Proxy calls /api/messages/ack after successful delivery.
    const messages = session.messageQueue.map(m => ({ seq: m.seq, ...m.data as object }))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ messages }))
    return
  }

  // ── Messages ack: proxy confirms delivery, server removes from queue ──
  if (url.pathname === '/api/messages/ack' && req.method === 'POST') {
    try {
      const body = await parseBody(req)
      const sessionId = body.session as string
      const ackSeq = body.seq as number  // ack all messages up to this seq
      const session = sessions.get(sessionId)
      if (session) {
        session.messageQueue = session.messageQueue.filter(m => m.seq > ackSeq)
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    } catch {
      res.writeHead(200)
      res.end()
    }
    return
  }

  if (url.pathname === '/api/ack-clear' && req.method === 'POST') {
    try {
      const body = await parseBody(req)
      const chatId = body.chat_id as string
      stopTyping(chatId)
      const adapter = getAdapter(chatId)
      for (const [msgId, ack] of ackedMessages) {
        if (ack.chatId === chatId) {
          adapter.removeReaction?.(chatId, msgId, ack.emoji)?.catch(() => {})
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
  const chatId = (args.chat_id ?? args.channel_id ?? args.channel) as string | undefined
  const adapter = getAdapter(chatId)

  switch (tool) {
    case 'reply': {
      const id = args.chat_id as string
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
        const sentId = await adapter.sendMessage(id, {
          content: chunks[i],
          ...(i === 0 && files.length > 0 ? { files } : {}),
          ...(shouldReplyTo ? { replyTo } : {}),
        })
        sentIds.push(sentId)
      }
      return { text: sentIds.length === 1 ? `sent (id: ${sentIds[0]})` : `sent ${sentIds.length} parts` }
    }

    case 'react':
      await adapter.react(args.chat_id as string, args.message_id as string, args.emoji as string)
      return { text: 'reacted' }

    case 'edit_message':
      await adapter.editMessage(args.chat_id as string, args.message_id as string, args.text as string)
      return { text: 'edited' }

    case 'fetch_messages': {
      const channelId = args.channel as string
      const fetchLimit = Math.min((args.limit as number) ?? 20, 100)
      const msgs = await adapter.fetchMessages(channelId, fetchLimit)
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

    case 'create_thread': {
      if (!adapter.createThread) return { text: 'create_thread not supported on this platform', isError: true }
      const chId = args.channel_id as string ?? config.mainChannel
      const threadId = await adapter.createThread(chId, args.name as string, args.message as string | undefined)
      return { text: `created thread (id: ${threadId})` }
    }

    case 'search': {
      const qmdPath = '/opt/homebrew/bin/qmd'
      if (!existsSync(qmdPath)) return { text: 'QMD not available', isError: true }
      const query = (args.query as string).replace(/"/g, '\\"')
      const collection = (args.collection as string) ?? 'all'
      const searchMode = (args.mode as string) ?? 'search'
      const searchLimit = (args.limit as number) ?? 5
      const collectionArg = collection === 'all' ? '' : `-c ${collection}`
      const result = execSync(`${qmdPath} ${searchMode} ${collectionArg} -n ${searchLimit} "${query}"`, { encoding: 'utf8', timeout: 15000 })
      return { text: result || '(no results)' }
    }

    default:
      return { text: `unknown tool: ${tool}`, isError: true }
  }
}

// ── Shared message handler (called by all platform adapters) ──

async function handleMessage(msg: PlatformMessage, platformName: string): Promise<void> {
  // Record which platform this channel belongs to
  channelPlatform.set(msg.channelId, platformName)

  // Bot filter — allow own [scheduled] messages only
  if (msg.isBot) {
    if (!isSelfBot(msg.authorId) || !msg.content.startsWith('[scheduled]')) return
  }

  // Gate check
  const access = accessManager.load()
  const pruned = pruneExpired(access)
  if (pruned) accessManager.save(access)

  let isMentioned = msg.mentionsBot
  if (!isMentioned && msg.reference?.messageId) {
    const adapter = getAdapter(msg.channelId)
    if (adapter.isReplyToBot) isMentioned = await adapter.isReplyToBot(msg)
  }
  if (!isMentioned && access.mentionPatterns?.length) {
    const adapter = getAdapter(msg.channelId)
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
      senderId: msg.authorId, chatId: msg.channelId,
      createdAt: now, expiresAt: now + 60 * 60 * 1000, replies: 1,
    }
    accessManager.save(access)
    try {
      await getAdapter(msg.channelId).sendMessage(msg.channelId, {
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
      await getAdapter(msg.channelId).sendMessage(msg.channelId, {
        content: `Still pending — approve code \`${result.code}\` from your terminal.`,
        replyTo: msg.id,
      })
    } catch {}
    return
  }

  // Ack reaction
  if (access.ackReaction) {
    getAdapter(msg.channelId).react(msg.channelId, msg.id, access.ackReaction).catch(() => {})
    ackedMessages.set(msg.id, { chatId: msg.channelId, emoji: access.ackReaction })
  }

  // Thread check — spawn dedicated session before routing to main
  if (msg.isThread && msg.channelId !== config.mainChannel) {
    const threadSession = getSessionByChatId(msg.channelId)
    if (threadSession) {
      enqueueToSession(threadSession, msg)
      return
    }
    spawnThreadSession(msg)
    return
  }

  // Route to session
  const session = getSessionByChatId(msg.channelId)
  if (session) {
    enqueueToSession(session, msg)
    return
  }

  process.stderr.write(`open-claude: no session for ch=${msg.channelId} (${platformName}), dropping\n`)
}

// ── Register message handlers for all adapters ──

for (const [name, adapter] of Object.entries(adapters)) {
  adapter.onMessage((msg: PlatformMessage) => {
    handleMessage(msg, name).catch(err => {
      process.stderr.write(`open-claude: handleMessage failed (${name}): ${err}\n`)
    })
  })
}

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
  startTyping(chatId)

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
  const prompt = `<channel source="${channelPlatform.get(chatId) ?? 'discord'}" chat_id="${chatId}" message_id="${msg.id}" user="${msg.authorName}" user_id="${msg.authorId}" ts="${msg.createdAt.toISOString()}">\n${msg.content}\n</channel>`
  writeFileSync(promptFile, prompt)

  const envExports = Object.entries(process.env)
    .filter(([k]) => k.startsWith('DISCORD_') || k.startsWith('LARK_') || k === 'OPEN_CLAUDE_WORKSPACE' || k === 'OPEN_CLAUDE_PORT')
    .map(([k, v]) => `export ${k}='${(v ?? '').replace(/'/g, "'\\''")}'`)
    .join(' && ')

  const threadModel = config.threadModel
  const cmd = `cd '${config.workspace}' && ${envExports} && export OPEN_CLAUDE_CHAT_ID=${chatId} && claude --dangerously-skip-permissions --dangerously-load-development-channels server:open-claude --model ${threadModel} ${resumeArg} "$(cat '${promptFile}')" && rm -f '${promptFile}'`

  try {
    execSync(`tmux new-window -t ${tmuxSession} -n ${windowName} '${cmd.replace(/'/g, "'\\''")}'`, { timeout: 5000 })
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
  const jobs = loadJobs(config.workspace)
  const now = new Date()
  for (const [name, job] of Object.entries(jobs)) {
    if (!job.enabled || !job.schedule || !job.targetChannel) continue
    if (!matchesCron(job.schedule, now)) continue
    getAdapter(job.targetChannel).sendMessage(job.targetChannel, {
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
      getAdapter(dmChannelId).sendMessage(dmChannelId, { content: "Paired! Say hi to Claude." })
        .then(() => rmSync(file, { force: true }))
        .catch(() => rmSync(file, { force: true }))
    }
  }, 5000).unref()
}

// ── Slash Commands (Discord-specific) ──

if (adapters.discord?.onInteraction) {
  adapters.discord.onInteraction(async (interaction: any) => {
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
  process.stderr.write('open-claude: shutting down\n')
  httpServer.close()
  const destroyPromises = Object.values(adapters).map(a => a.destroy())
  setTimeout(() => process.exit(0), 2000)
  void Promise.all(destroyPromises).finally(() => process.exit(0))
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// ── Start ──

// Register ready handlers
for (const [name, adapter] of Object.entries(adapters)) {
  adapter.onReady((botId, botName) => {
    process.stderr.write(`open-claude: ${name} connected as ${botName}\n`)
    if (name === 'discord') {
      const da = adapter as any
      if (da.registerSlashCommands && da.getClient) {
        const client = da.getClient()
        const guildIds = [...client.guilds.cache.keys()]
        da.registerSlashCommands(guildIds).catch((err: Error) => {
          process.stderr.write(`open-claude: slash command registration failed: ${err}\n`)
        })
      }
    }
  })
}

// Start HTTP server
httpServer.listen(PORT, '127.0.0.1', () => {
  process.stderr.write(`open-claude: HTTP server on http://127.0.0.1:${PORT}\n`)
})

// Login all adapters
const loginPromises: Promise<void>[] = []
if (adapters.discord && DISCORD_TOKEN) {
  loginPromises.push(adapters.discord.login(DISCORD_TOKEN))
}
if (adapters.lark && LARK_SECRET) {
  loginPromises.push(adapters.lark.login(LARK_SECRET))
}
await Promise.all(loginPromises)
