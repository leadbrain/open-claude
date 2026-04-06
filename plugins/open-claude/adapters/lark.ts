/**
 * Lark (Feishu) adapter — implements PlatformAdapter using Lark SDK.
 *
 * Uses WebSocket long-connection mode (WSClient) for receiving messages.
 * No public URL required — works behind NAT like Discord.
 *
 * Required env vars:
 *   LARK_APP_ID, LARK_APP_SECRET — from Lark Developer Console
 *
 * Optional:
 *   LARK_DOMAIN — "lark" for international, "feishu" for China (default: lark)
 *
 * Lark Developer Console setup:
 *   1. Create app → get App ID + App Secret
 *   2. Enable bot capability
 *   3. Add permissions: im:message, im:message:send_as_bot, im:resource, im:chat
 *   4. Event subscriptions → select "Use long connection" (WebSocket mode)
 *   5. Add event: im.message.receive_v1
 *   6. Publish app
 */

import { readFileSync, statSync } from 'fs'
import type {
  PlatformAdapter,
  PlatformMessage,
  PlatformAttachment,
  SendOptions,
  FetchedMessage,
} from '../platform.ts'

// Dynamic import — @larksuiteoapi/node-sdk is optional dependency
let LarkSDK: any = null

async function loadSDK() {
  if (LarkSDK) return LarkSDK
  try {
    LarkSDK = await import('@larksuiteoapi/node-sdk')
    return LarkSDK
  } catch {
    throw new Error('Lark SDK not installed. Run: bun add @larksuiteoapi/node-sdk')
  }
}

const LARK_API = 'https://open.larksuite.com/open-apis'
const FEISHU_API = 'https://open.feishu.cn/open-apis'
const MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024

export class LarkAdapter implements PlatformAdapter {
  readonly name = 'lark'
  private client: any = null      // Lark Client (for API calls)
  private wsClient: any = null    // WSClient (for receiving events)
  private botOpenId = ''
  private botName = ''
  private domain: string
  private messageCallback: ((msg: PlatformMessage) => void) | null = null
  private readyCallback: ((botId: string, botName: string) => void) | null = null
  private thinkingMessages = new Map<string, string>()
  private apiBase: string

  constructor() {
    this.domain = process.env.LARK_DOMAIN ?? 'lark'
    this.apiBase = this.domain === 'feishu' ? FEISHU_API : LARK_API
  }

  async login(token: string): Promise<void> {
    const sdk = await loadSDK()
    const appId = process.env.LARK_APP_ID ?? ''
    const appSecret = token || (process.env.LARK_APP_SECRET ?? '')

    if (!appId || !appSecret) {
      throw new Error('LARK_APP_ID and LARK_APP_SECRET are required')
    }

    // Create API client
    this.client = new sdk.Client({
      appId,
      appSecret,
      domain: this.domain === 'feishu' ? sdk.Domain.Feishu : sdk.Domain.Lark,
    })

    // Create event dispatcher
    const eventDispatcher = new sdk.EventDispatcher({})

    // Register message handler
    eventDispatcher.register({
      'im.message.receive_v1': (event: any) => {
        this.handleEvent(event)
      },
    })

    // Create WebSocket client
    this.wsClient = new sdk.WSClient({
      appId,
      appSecret,
      domain: this.domain === 'feishu' ? sdk.Domain.Feishu : sdk.Domain.Lark,
      eventDispatcher,
      autoReconnect: true,
    })

    // Fetch bot info
    await this.fetchBotInfo()

    process.stderr.write(`lark-adapter: connected via WebSocket (${this.domain})\n`)
  }

  async destroy(): Promise<void> {
    // WSClient handles cleanup on GC
    this.wsClient = null
    this.client = null
  }

  onReady(cb: (botId: string, botName: string) => void): void {
    this.readyCallback = cb
    if (this.botOpenId) cb(this.botOpenId, this.botName)
  }

  onMessage(cb: (msg: PlatformMessage) => void): void {
    this.messageCallback = cb
  }

  async sendMessage(channelId: string, opts: SendOptions): Promise<string> {
    let content: string
    let msgType: string

    if (opts.files && opts.files.length > 0) {
      // Upload first file as image
      const imageKey = await this.uploadFile(opts.files[0])
      msgType = 'post'
      content = JSON.stringify({
        zh_cn: {
          title: '',
          content: [
            [{ tag: 'text', text: opts.content }],
            [{ tag: 'img', image_key: imageKey }],
          ],
        },
      })
    } else {
      msgType = 'text'
      content = JSON.stringify({ text: opts.content })
    }

    const res = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: channelId,
        msg_type: msgType,
        content,
      },
    })

    return res?.data?.message_id ?? ''
  }

  async editMessage(channelId: string, messageId: string, content: string): Promise<void> {
    await this.client.im.message.patch({
      path: { message_id: messageId },
      data: {
        msg_type: 'text',
        content: JSON.stringify({ text: content }),
      },
    })
  }

  async react(channelId: string, messageId: string, emoji: string): Promise<void> {
    await this.client.im.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emoji } },
    })
  }

  async removeReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    // Lark: list reactions then delete the bot's
    try {
      const res = await this.client.im.messageReaction.list({
        path: { message_id: messageId },
        params: { reaction_type: emoji },
      })
      const items = res?.data?.items ?? []
      for (const item of items) {
        if (item.operator?.operator_id === this.botOpenId) {
          await this.client.im.messageReaction.delete({
            path: { message_id: messageId, reaction_id: item.reaction_id },
          })
        }
      }
    } catch {}
  }

  async createThread(channelId: string, name: string, message?: string): Promise<string> {
    const content = message ?? name
    const res = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: channelId,
        msg_type: 'text',
        content: JSON.stringify({ text: content }),
      },
    })
    // Lark threads = message replies. Return message_id as "thread id"
    return res?.data?.message_id ?? ''
  }

  async sendTyping(channelId: string): Promise<void> {
    // Lark has no typing indicator — send/update "thinking..." message
    const existing = this.thinkingMessages.get(channelId)
    if (existing) return

    try {
      const msgId = await this.sendMessage(channelId, { content: '🤔 ...' })
      this.thinkingMessages.set(channelId, msgId)
    } catch {}
  }

  async clearTyping(channelId: string): Promise<void> {
    const msgId = this.thinkingMessages.get(channelId)
    if (!msgId) return
    this.thinkingMessages.delete(channelId)
    try {
      await this.client.im.message.delete({ path: { message_id: msgId } })
    } catch {}
  }

  async fetchMessages(channelId: string, limit: number): Promise<FetchedMessage[]> {
    const res = await this.client.im.message.list({
      params: {
        container_id_type: 'chat',
        container_id: channelId,
        page_size: Math.min(limit, 50),
      },
    })
    const items = res?.data?.items ?? []
    return items.map((m: any) => ({
      id: m.message_id,
      authorId: m.sender?.id ?? '',
      authorName: m.sender?.sender_type === 'user' ? 'user' : 'bot',
      isBot: m.sender?.sender_type === 'app',
      content: this.extractTextContent(m),
      createdAt: new Date(parseInt(m.create_time ?? '0') * 1000),
      attachmentCount: 0,
    }))
  }

  async downloadAttachment(att: PlatformAttachment): Promise<{ data: Buffer; name: string }> {
    const res = await this.client.im.messageResource.get({
      path: { message_id: att.id, file_key: att.url },
      params: { type: 'file' },
    })
    const buf = Buffer.from(await res.arrayBuffer())
    return { data: buf, name: att.name }
  }

  getBotId(): string | undefined {
    return this.botOpenId || undefined
  }

  async isReplyToBot(msg: PlatformMessage): Promise<boolean> {
    return false // Lark doesn't easily expose this
  }

  matchesPatterns(text: string, patterns: string[]): boolean {
    for (const pat of patterns) {
      try { if (new RegExp(pat, 'i').test(text)) return true } catch {}
    }
    return false
  }

  // ── Internal ──

  private async fetchBotInfo(): Promise<void> {
    try {
      const res = await fetch(`${this.apiBase}/bot/v3/info`, {
        headers: { Authorization: `Bearer ${await this.getTenantToken()}` },
      })
      const data = await res.json() as any
      this.botOpenId = data?.bot?.open_id ?? ''
      this.botName = data?.bot?.bot_name ?? 'bot'
    } catch {
      this.botName = 'bot'
    }
    if (this.readyCallback) this.readyCallback(this.botOpenId, this.botName)
  }

  private async getTenantToken(): Promise<string> {
    const res = await fetch(`${this.apiBase}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: process.env.LARK_APP_ID,
        app_secret: process.env.LARK_APP_SECRET,
      }),
    })
    const data = await res.json() as any
    return data.tenant_access_token ?? ''
  }

  private handleEvent(event: any): void {
    const msg = event?.message
    const sender = event?.sender
    if (!msg || !sender) return
    if (sender.sender_type === 'app') return // Skip bot messages

    const content = this.extractTextContent(msg)
    const mentions = msg.mentions ?? []
    const mentionsBot = mentions.some((m: any) => m.id?.open_id === this.botOpenId)

    const chatType = msg.chat_type
    const isDM = chatType === 'p2p'
    const isThread = !!msg.root_id && msg.root_id !== msg.message_id

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
        size: 0,
        url: content.file_key ?? content.image_key ?? '',
      }]
    } catch {
      return []
    }
  }

  private async uploadFile(filePath: string): Promise<string> {
    const stat = statSync(filePath)
    if (stat.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`file too large: ${filePath}`)
    }
    const data = readFileSync(filePath)
    const formData = new FormData()
    formData.append('image_type', 'message')
    formData.append('image', new Blob([data]), filePath.split('/').pop() ?? 'file')

    const token = await this.getTenantToken()
    const res = await fetch(`${this.apiBase}/im/v1/images`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    })
    const json = await res.json() as any
    return json?.data?.image_key ?? ''
  }
}
