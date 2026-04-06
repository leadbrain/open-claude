/**
 * Lark (Feishu) adapter — implements PlatformAdapter using Lark Open API.
 *
 * Lark uses HTTP webhooks for inbound messages (vs Discord's WebSocket gateway).
 * This adapter runs a lightweight HTTP server to receive event subscriptions.
 *
 * Required env vars:
 *   LARK_APP_ID, LARK_APP_SECRET — from Lark Developer Console
 *   LARK_VERIFICATION_TOKEN — for webhook signature verification
 *   LARK_EVENT_PORT — port for webhook server (default: 9876)
 *
 * Differences from Discord:
 *   - No typing indicator API (uses "thinking..." message instead)
 *   - Message limit is 30KB (vs Discord's 2000 chars)
 *   - File upload is two-step: upload → reference
 *   - Identity uses open_id, not numeric user IDs
 *   - Reactions use emoji_type string, not Unicode
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { readFileSync, statSync } from 'fs'
import type {
  PlatformAdapter,
  PlatformMessage,
  PlatformAttachment,
  SendOptions,
  FetchedMessage,
} from '../platform.ts'

const LARK_API = 'https://open.larksuite.com/open-apis'
const MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024  // Lark allows larger files

interface LarkConfig {
  appId: string
  appSecret: string
  verificationToken: string
  eventPort: number
}

export class LarkAdapter implements PlatformAdapter {
  readonly name = 'lark'
  private config: LarkConfig | null = null
  private tenantToken = ''
  private tokenExpiry = 0
  private botOpenId = ''
  private botName = ''
  private server: ReturnType<typeof createServer> | null = null
  private messageCallback: ((msg: PlatformMessage) => void) | null = null
  private readyCallback: ((botId: string, botName: string) => void) | null = null
  private thinkingMessages = new Map<string, string>()  // channelId → messageId

  async login(token: string): Promise<void> {
    // For Lark, "token" is the app secret. App ID comes from env.
    this.config = {
      appId: process.env.LARK_APP_ID ?? '',
      appSecret: token || (process.env.LARK_APP_SECRET ?? ''),
      verificationToken: process.env.LARK_VERIFICATION_TOKEN ?? '',
      eventPort: parseInt(process.env.LARK_EVENT_PORT ?? '9876', 10),
    }

    if (!this.config.appId || !this.config.appSecret) {
      throw new Error('LARK_APP_ID and LARK_APP_SECRET are required')
    }

    await this.refreshToken()
    await this.fetchBotInfo()
    this.startWebhookServer()
  }

  async destroy(): Promise<void> {
    if (this.server) {
      this.server.close()
      this.server = null
    }
  }

  onReady(cb: (botId: string, botName: string) => void): void {
    this.readyCallback = cb
    // If already logged in, call immediately
    if (this.botOpenId) cb(this.botOpenId, this.botName)
  }

  onMessage(cb: (msg: PlatformMessage) => void): void {
    this.messageCallback = cb
  }

  async sendMessage(channelId: string, opts: SendOptions): Promise<string> {
    await this.ensureToken()

    // Upload files first if any
    let imageKeys: string[] = []
    if (opts.files && opts.files.length > 0) {
      for (const f of opts.files) {
        const key = await this.uploadFile(f)
        imageKeys.push(key)
      }
    }

    // Build message content
    let content: string
    let msgType: string

    if (imageKeys.length > 0) {
      // Use rich text (post) format for messages with files
      msgType = 'post'
      const textLine = [{ tag: 'text', text: opts.content }]
      const imageLines = imageKeys.map(key => [{ tag: 'img', image_key: key }])
      content = JSON.stringify({
        zh_cn: {
          title: '',
          content: [textLine, ...imageLines],
        },
      })
    } else {
      msgType = 'text'
      content = JSON.stringify({ text: opts.content })
    }

    const body: Record<string, unknown> = {
      receive_id: channelId,
      msg_type: msgType,
      content,
    }
    if (opts.replyTo) {
      body.reply_in_thread = true
    }

    const res = await this.api('POST', '/im/v1/messages?receive_id_type=chat_id', body)
    return res?.data?.message_id ?? ''
  }

  async editMessage(channelId: string, messageId: string, content: string): Promise<void> {
    await this.ensureToken()
    await this.api('PUT', `/im/v1/messages/${messageId}`, {
      msg_type: 'text',
      content: JSON.stringify({ text: content }),
    })
  }

  async react(channelId: string, messageId: string, emoji: string): Promise<void> {
    await this.ensureToken()
    await this.api('POST', `/im/v1/messages/${messageId}/reactions`, {
      reaction_type: { emoji_type: emoji },
    })
  }

  async removeReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    await this.ensureToken()
    // Lark: delete reaction by type
    await this.api('DELETE', `/im/v1/messages/${messageId}/reactions`, {
      reaction_type: { emoji_type: emoji },
    })
  }

  async createThread(channelId: string, name: string, message?: string): Promise<string> {
    await this.ensureToken()
    // Lark: create a thread by replying in thread mode
    const content = message ?? name
    const res = await this.api('POST', '/im/v1/messages?receive_id_type=chat_id', {
      receive_id: channelId,
      msg_type: 'text',
      content: JSON.stringify({ text: content }),
      reply_in_thread: true,
    })
    return res?.data?.message_id ?? ''
  }

  async sendTyping(channelId: string): Promise<void> {
    // Lark has no typing indicator. Send/update a "thinking..." message instead.
    const existing = this.thinkingMessages.get(channelId)
    if (existing) return  // Already showing thinking

    try {
      const msgId = await this.sendMessage(channelId, { content: '🤔 ...' })
      this.thinkingMessages.set(channelId, msgId)
    } catch {
      // Ignore — typing is best-effort
    }
  }

  /** Clear the thinking indicator for a channel */
  async clearTyping(channelId: string): Promise<void> {
    const msgId = this.thinkingMessages.get(channelId)
    if (!msgId) return
    this.thinkingMessages.delete(channelId)
    try {
      await this.api('DELETE', `/im/v1/messages/${msgId}`)
    } catch {}
  }

  async fetchMessages(channelId: string, limit: number): Promise<FetchedMessage[]> {
    await this.ensureToken()
    const res = await this.api('GET', `/im/v1/messages?container_id_type=chat&container_id=${channelId}&page_size=${Math.min(limit, 50)}`)
    const items = res?.data?.items ?? []
    return items.map((m: any) => ({
      id: m.message_id,
      authorId: m.sender?.id ?? '',
      authorName: m.sender?.sender_type === 'user' ? (m.sender?.id ?? 'user') : 'bot',
      isBot: m.sender?.sender_type === 'app',
      content: this.extractTextContent(m),
      createdAt: new Date(parseInt(m.create_time ?? '0') * 1000),
      attachmentCount: 0,
    }))
  }

  async downloadAttachment(att: PlatformAttachment): Promise<{ data: Buffer; name: string }> {
    await this.ensureToken()
    const res = await fetch(`${LARK_API}/im/v1/messages/${att.id}/resources/${att.url}?type=file`, {
      headers: { Authorization: `Bearer ${this.tenantToken}` },
    })
    const buf = Buffer.from(await res.arrayBuffer())
    return { data: buf, name: att.name }
  }

  getBotId(): string | undefined {
    return this.botOpenId || undefined
  }

  matchesPatterns(text: string, patterns: string[]): boolean {
    for (const pat of patterns) {
      try { if (new RegExp(pat, 'i').test(text)) return true } catch {}
    }
    return false
  }

  // ── Internal ──

  private async api(method: string, path: string, body?: unknown): Promise<any> {
    const url = `${LARK_API}${path}`
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.tenantToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    }
    const res = await fetch(url, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    return res.json()
  }

  private async refreshToken(): Promise<void> {
    if (!this.config) throw new Error('not configured')
    const res = await fetch(`${LARK_API}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: this.config.appId,
        app_secret: this.config.appSecret,
      }),
    })
    const data = await res.json() as any
    if (data.code !== 0) throw new Error(`Lark auth failed: ${data.msg}`)
    this.tenantToken = data.tenant_access_token
    this.tokenExpiry = Date.now() + (data.expire - 300) * 1000  // refresh 5min early
  }

  private async ensureToken(): Promise<void> {
    if (Date.now() > this.tokenExpiry) await this.refreshToken()
  }

  private async fetchBotInfo(): Promise<void> {
    const res = await this.api('GET', '/bot/v3/info')
    this.botOpenId = res?.bot?.open_id ?? ''
    this.botName = res?.bot?.bot_name ?? 'bot'
    if (this.readyCallback) this.readyCallback(this.botOpenId, this.botName)
  }

  private startWebhookServer(): void {
    if (!this.config) return
    this.server = createServer((req, res) => this.handleWebhook(req, res))
    this.server.listen(this.config.eventPort, () => {
      process.stderr.write(`lark-adapter: webhook server on port ${this.config!.eventPort}\n`)
    })
  }

  private handleWebhook(req: IncomingMessage, res: ServerResponse): void {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      try {
        const data = JSON.parse(body)

        // URL verification challenge
        if (data.type === 'url_verification') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ challenge: data.challenge }))
          return
        }

        // Verify token
        if (this.config?.verificationToken && data.token !== this.config.verificationToken) {
          res.writeHead(403)
          res.end('invalid token')
          return
        }

        res.writeHead(200)
        res.end('ok')

        // Process event
        const event = data.event
        if (!event) return

        const eventType = data.header?.event_type ?? event.type
        if (eventType === 'im.message.receive_v1' && this.messageCallback) {
          this.processInboundMessage(event)
        }
      } catch (err) {
        process.stderr.write(`lark-adapter: webhook error: ${err}\n`)
        res.writeHead(500)
        res.end('error')
      }
    })
  }

  private processInboundMessage(event: any): void {
    const msg = event.message
    const sender = event.sender
    if (!msg || !sender) return

    // Skip bot messages
    if (sender.sender_type === 'app') return

    const content = this.extractTextContent(msg)
    const mentions = msg.mentions ?? []
    const mentionsBot = mentions.some((m: any) => m.id?.open_id === this.botOpenId)

    const chatType = msg.chat_type
    const isDM = chatType === 'p2p'
    const isThread = !!msg.root_id && msg.root_id !== msg.message_id
    const parentId = msg.root_id || undefined

    const platformMsg: PlatformMessage = {
      id: msg.message_id,
      channelId: msg.chat_id,
      authorId: sender.sender_id?.open_id ?? sender.sender_id?.user_id ?? '',
      authorName: sender.sender_id?.open_id ?? 'unknown',
      content,
      isBot: false,
      isDM,
      isThread,
      parentChannelId: isThread ? msg.chat_id : undefined,
      createdAt: new Date(parseInt(msg.create_time ?? '0') * 1000),
      attachments: this.extractAttachments(msg),
      mentionsBot,
      reference: msg.parent_id ? { messageId: msg.parent_id } : undefined,
    }

    this.messageCallback?.(platformMsg)
  }

  private extractTextContent(msg: any): string {
    try {
      const content = JSON.parse(msg.content ?? '{}')
      if (msg.msg_type === 'text') return content.text ?? ''
      if (msg.msg_type === 'post') {
        // Extract text from rich text format
        const langs = content.zh_cn ?? content.en_us ?? content[Object.keys(content)[0]]
        if (!langs?.content) return ''
        return langs.content
          .flat()
          .filter((el: any) => el.tag === 'text')
          .map((el: any) => el.text)
          .join('')
      }
      return content.text ?? ''
    } catch {
      return ''
    }
  }

  private extractAttachments(msg: any): PlatformAttachment[] {
    if (msg.msg_type !== 'file' && msg.msg_type !== 'image') return []
    try {
      const content = JSON.parse(msg.content ?? '{}')
      return [{
        id: msg.message_id,
        name: content.file_name ?? content.image_key ?? 'file',
        contentType: msg.msg_type === 'image' ? 'image/png' : undefined,
        size: 0,  // Lark doesn't expose size in event payload
        url: content.file_key ?? content.image_key ?? '',
      }]
    } catch {
      return []
    }
  }

  private async uploadFile(filePath: string): Promise<string> {
    await this.ensureToken()
    const stat = statSync(filePath)
    if (stat.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`file too large: ${filePath}`)
    }

    const data = readFileSync(filePath)
    const formData = new FormData()
    formData.append('image_type', 'message')
    formData.append('image', new Blob([data]), filePath.split('/').pop() ?? 'file')

    const res = await fetch(`${LARK_API}/im/v1/images`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.tenantToken}` },
      body: formData,
    })
    const json = await res.json() as any
    return json?.data?.image_key ?? ''
  }
}
