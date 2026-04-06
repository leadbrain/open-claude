/**
 * Lark (Feishu) adapter — based on OpenClaw's production feishu extension.
 *
 * Uses @larksuiteoapi/node-sdk WSClient for WebSocket long-connection.
 * No public URL required — works behind NAT like Discord.
 *
 * Core logic (client creation, domain resolution, event parsing) extracted
 * from OpenClaw's feishu extension (extensions/feishu/src/).
 *
 * Required env:
 *   LARK_APP_ID, LARK_APP_SECRET
 * Optional:
 *   LARK_DOMAIN — "feishu" (default, China) or "lark" (international)
 *   LARK_ENCRYPT_KEY — for event decryption
 *   LARK_VERIFICATION_TOKEN — for event verification
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
let Lark: any = null

async function loadSDK() {
  if (Lark) return Lark
  try {
    Lark = await import('@larksuiteoapi/node-sdk')
    return Lark
  } catch {
    throw new Error('Lark SDK not installed. Run: bun add @larksuiteoapi/node-sdk')
  }
}

// ── Domain resolution (from OpenClaw client.ts) ──

type FeishuDomain = 'feishu' | 'lark' | (string & {})

function resolveDomain(sdk: any, domain: FeishuDomain | undefined): any {
  if (domain === 'lark') return sdk.Domain.Lark
  if (domain === 'feishu' || !domain) return sdk.Domain.Feishu
  return domain.replace(/\/+$/, '')  // Custom URL for private deployment
}

// ── Event types (from OpenClaw bot.ts) ──

type FeishuMessageEvent = {
  sender: {
    sender_id: {
      open_id?: string
      user_id?: string
      union_id?: string
    }
    sender_type?: string
    tenant_key?: string
  }
  message: {
    message_id: string
    root_id?: string
    parent_id?: string
    chat_id: string
    chat_type: 'p2p' | 'group'
    message_type: string
    content: string
    mentions?: Array<{
      key: string
      id: { open_id?: string; user_id?: string; union_id?: string }
      name: string
      tenant_key?: string
    }>
  }
}

// ── Message content parsing (from OpenClaw bot.ts) ──

function parseMessageContent(content: string, messageType: string): string {
  try {
    const parsed = JSON.parse(content)
    if (messageType === 'text') return parsed.text || ''
    if (messageType === 'post') {
      // Extract text from rich text post — flatten all content blocks
      const lang = parsed.zh_cn ?? parsed.en_us ?? parsed[Object.keys(parsed)[0]]
      if (!lang?.content) return ''
      return lang.content
        .flat()
        .filter((el: any) => el.tag === 'text')
        .map((el: any) => el.text)
        .join('')
    }
    return content
  } catch {
    return content
  }
}

function checkBotMentioned(event: FeishuMessageEvent, botOpenId?: string): boolean {
  const mentions = event.message.mentions ?? []
  if (mentions.length === 0) return false
  if (!botOpenId) return mentions.length > 0
  return mentions.some(m => m.id.open_id === botOpenId)
}

// ── Adapter ──

export class LarkAdapter implements PlatformAdapter {
  readonly name = 'lark'
  private client: any = null
  private wsClient: any = null
  private botOpenId = ''
  private botName = ''
  private domain: FeishuDomain
  private messageCallback: ((msg: PlatformMessage) => void) | null = null
  private readyCallback: ((botId: string, botName: string) => void) | null = null
  private thinkingMessages = new Map<string, string>()

  constructor() {
    this.domain = (process.env.LARK_DOMAIN as FeishuDomain) ?? 'feishu'
  }

  async login(token: string): Promise<void> {
    const sdk = await loadSDK()
    const appId = process.env.LARK_APP_ID ?? ''
    const appSecret = token || (process.env.LARK_APP_SECRET ?? '')

    if (!appId || !appSecret) {
      throw new Error('LARK_APP_ID and LARK_APP_SECRET are required')
    }

    const resolvedDomain = resolveDomain(sdk, this.domain)

    // API client (from OpenClaw client.ts — createFeishuClient)
    this.client = new sdk.Client({
      appId,
      appSecret,
      appType: sdk.AppType.SelfBuild,
      domain: resolvedDomain,
    })

    // Event dispatcher (from OpenClaw client.ts — createEventDispatcher)
    const eventDispatcher = new sdk.EventDispatcher({
      encryptKey: process.env.LARK_ENCRYPT_KEY,
      verificationToken: process.env.LARK_VERIFICATION_TOKEN,
    })

    // Register message handler
    eventDispatcher.register({
      'im.message.receive_v1': (data: unknown) => {
        const event = data as FeishuMessageEvent
        process.stderr.write(`lark-adapter: message from ${event?.sender?.sender_id?.open_id} in ${event?.message?.chat_id}\n`)
        this.handleEvent(event)
      },
    })

    // WebSocket client (from OpenClaw client.ts — createFeishuWSClient)
    this.wsClient = new sdk.WSClient({
      appId,
      appSecret,
      domain: resolvedDomain,
      loggerLevel: sdk.LoggerLevel.info,
    })

    // Start with event dispatcher (from OpenClaw monitor.ts)
    this.wsClient.start({ eventDispatcher })

    // Fetch bot info
    await this.fetchBotInfo(sdk, resolvedDomain, appId, appSecret)

    process.stderr.write(`lark-adapter: connected via WebSocket (${this.domain})\n`)
  }

  async destroy(): Promise<void> {
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
    const res = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: channelId,
        msg_type: 'text',
        content: JSON.stringify({ text: opts.content }),
      },
    })
    return res?.data?.message_id ?? ''
  }

  async editMessage(_channelId: string, messageId: string, content: string): Promise<void> {
    await this.client.im.message.patch({
      path: { message_id: messageId },
      data: {
        msg_type: 'text',
        content: JSON.stringify({ text: content }),
      },
    })
  }

  async react(_channelId: string, messageId: string, emoji: string): Promise<void> {
    try {
      await this.client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emoji } },
      })
    } catch {}
  }

  async removeReaction(_channelId: string, messageId: string, emoji: string): Promise<void> {
    try {
      const res = await this.client.im.messageReaction.list({
        path: { message_id: messageId },
        params: { reaction_type: emoji },
      })
      for (const item of res?.data?.items ?? []) {
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
    return res?.data?.message_id ?? ''
  }

  async sendTyping(channelId: string): Promise<void> {
    const existing = this.thinkingMessages.get(channelId)
    if (existing) return
    try {
      const msgId = await this.sendMessage(channelId, { content: '🤔 ...' })
      this.thinkingMessages.set(channelId, msgId)
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
    return (res?.data?.items ?? []).map((m: any) => ({
      id: m.message_id,
      authorId: m.sender?.id ?? '',
      authorName: m.sender?.sender_type === 'user' ? 'user' : 'bot',
      isBot: m.sender?.sender_type === 'app',
      content: parseMessageContent(m.content ?? '{}', m.msg_type ?? 'text'),
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

  async isReplyToBot(_msg: PlatformMessage): Promise<boolean> {
    return false
  }

  matchesPatterns(text: string, patterns: string[]): boolean {
    for (const pat of patterns) {
      try { if (new RegExp(pat, 'i').test(text)) return true } catch {}
    }
    return false
  }

  // ── Internal ──

  private async fetchBotInfo(sdk: any, domain: any, appId: string, appSecret: string): Promise<void> {
    try {
      // Use tenant token to get bot info
      const tokenRes = await fetch(
        `${domain === sdk.Domain.Lark ? 'https://open.larksuite.com' : 'https://open.feishu.cn'}/open-apis/auth/v3/tenant_access_token/internal`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
        },
      )
      const tokenData = await tokenRes.json() as any
      const tenantToken = tokenData.tenant_access_token

      if (tenantToken) {
        const botRes = await fetch(
          `${domain === sdk.Domain.Lark ? 'https://open.larksuite.com' : 'https://open.feishu.cn'}/open-apis/bot/v3/info`,
          { headers: { Authorization: `Bearer ${tenantToken}` } },
        )
        const botData = await botRes.json() as any
        this.botOpenId = botData?.bot?.open_id ?? ''
        this.botName = botData?.bot?.bot_name ?? 'bot'
      }
    } catch {
      this.botName = 'bot'
    }
    if (this.readyCallback) this.readyCallback(this.botOpenId, this.botName)
  }

  private handleEvent(event: FeishuMessageEvent): void {
    const sender = event?.sender
    const msg = event?.message
    if (!msg || !sender) return
    if (sender.sender_type === 'app') return

    const content = parseMessageContent(msg.content, msg.message_type)
    const mentionsBot = checkBotMentioned(event, this.botOpenId)
    const isDM = msg.chat_type === 'p2p'
    const isThread = !!msg.root_id && msg.root_id !== msg.message_id

    const platformMsg: PlatformMessage = {
      id: msg.message_id,
      channelId: msg.chat_id,
      authorId: sender.sender_id.open_id ?? sender.sender_id.user_id ?? '',
      authorName: sender.sender_id.open_id ?? 'unknown',
      content,
      isBot: false,
      isDM,
      isThread,
      parentChannelId: isThread ? msg.chat_id : undefined,
      createdAt: new Date(),
      attachments: this.extractAttachments(msg),
      mentionsBot,
      reference: msg.parent_id ? { messageId: msg.parent_id } : undefined,
    }

    this.messageCallback?.(platformMsg)
  }

  private extractAttachments(msg: FeishuMessageEvent['message']): PlatformAttachment[] {
    if (msg.message_type !== 'file' && msg.message_type !== 'image') return []
    try {
      const content = JSON.parse(msg.content ?? '{}')
      return [{
        id: msg.message_id,
        name: content.file_name ?? content.image_key ?? 'file',
        contentType: msg.message_type === 'image' ? 'image/png' : undefined,
        size: 0,
        url: content.file_key ?? content.image_key ?? '',
      }]
    } catch {
      return []
    }
  }
}
