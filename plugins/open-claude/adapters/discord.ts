/**
 * Discord adapter — implements PlatformAdapter using discord.js.
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  REST,
  Routes,
  SlashCommandBuilder,
  type Message,
} from 'discord.js'
import { statSync } from 'fs'
import type {
  PlatformAdapter,
  PlatformMessage,
  PlatformAttachment,
  SendOptions,
  FetchedMessage,
} from '../platform.ts'

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

function toAttachment(att: { id: string; name: string | null; contentType: string | null; size: number; url: string }): PlatformAttachment {
  return {
    id: att.id,
    name: att.name ?? att.id,
    contentType: att.contentType ?? undefined,
    size: att.size,
    url: att.url,
  }
}

function toPlatformMessage(msg: Message, botId?: string): PlatformMessage {
  const atts: PlatformAttachment[] = []
  for (const att of msg.attachments.values()) {
    atts.push(toAttachment(att))
  }

  return {
    id: msg.id,
    channelId: msg.channelId,
    authorId: msg.author.id,
    authorName: msg.author.username,
    content: msg.content,
    isBot: msg.author.bot,
    isDM: msg.channel.type === ChannelType.DM,
    isThread: msg.channel.isThread(),
    parentChannelId: msg.channel.isThread() ? (msg.channel.parentId ?? undefined) : undefined,
    createdAt: msg.createdAt,
    attachments: atts,
    mentionsBot: botId ? msg.mentions.has(botId) : false,
    reference: msg.reference?.messageId ? { messageId: msg.reference.messageId } : undefined,
  }
}

export class DiscordAdapter implements PlatformAdapter {
  readonly name = 'discord'
  private client: Client
  private token = ''
  private recentSentIds = new Set<string>()
  private readonly RECENT_SENT_CAP = 200

  constructor() {
    this.client = new Client({
      intents: [
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel, Partials.Message],
    })

    this.client.on('error', err => {
      process.stderr.write(`discord-adapter: client error: ${err}\n`)
    })
  }

  async login(token: string): Promise<void> {
    this.token = token
    await this.client.login(token)
  }

  async destroy(): Promise<void> {
    await this.client.destroy()
  }

  onReady(cb: (botId: string, botName: string) => void): void {
    this.client.once('ready', c => {
      cb(c.user.id, c.user.tag)
    })
  }

  onMessage(cb: (msg: PlatformMessage) => void): void {
    // DM workaround: discord.js v14 may not emit messageCreate for DMs
    // if the DM channel is not in cache. Catch via raw event and fetch.
    this.client.on('raw', async (event: { t: string; d: any }) => {
      if (event.t === 'MESSAGE_CREATE' && event.d?.channel_type === 1 && !event.d?.author?.bot) {
        try {
          const ch = await this.client.channels.fetch(event.d.channel_id)
          if (ch && 'messages' in ch) {
            const msg = await (ch as any).messages.fetch(event.d.id)
            if (msg && !msg.author.bot) {
              cb(toPlatformMessage(msg, this.client.user?.id))
            }
          }
        } catch {}
      }
    })

    this.client.on('messageCreate', msg => {
      if (msg.author.bot) return
      cb(toPlatformMessage(msg, this.client.user?.id))
    })
  }

  onInteraction(cb: (interaction: unknown) => void): void {
    this.client.on('interactionCreate', cb)
  }

  private noteSent(id: string): void {
    this.recentSentIds.add(id)
    if (this.recentSentIds.size > this.RECENT_SENT_CAP) {
      const first = this.recentSentIds.values().next().value
      if (first) this.recentSentIds.delete(first)
    }
  }

  private async fetchTextChannel(id: string) {
    const ch = await this.client.channels.fetch(id)
    if (!ch || !ch.isTextBased()) throw new Error(`channel ${id} not found or not text-based`)
    return ch
  }

  async sendMessage(channelId: string, opts: SendOptions): Promise<string> {
    const ch = await this.fetchTextChannel(channelId)
    if (!('send' in ch)) throw new Error('channel is not sendable')

    const payload: Record<string, unknown> = { content: opts.content }
    if (opts.files && opts.files.length > 0) {
      for (const f of opts.files) {
        const st = statSync(f)
        if (st.size > MAX_ATTACHMENT_BYTES) {
          throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 25MB)`)
        }
      }
      if (opts.files.length > 10) throw new Error('max 10 attachments per message')
      payload.files = opts.files
    }
    if (opts.replyTo) {
      payload.reply = { messageReference: opts.replyTo, failIfNotExists: false }
    }

    const sent = await ch.send(payload as any)
    this.noteSent(sent.id)
    return sent.id
  }

  async editMessage(channelId: string, messageId: string, content: string): Promise<void> {
    const ch = await this.fetchTextChannel(channelId)
    const msg = await ch.messages.fetch(messageId)
    await msg.edit(content)
  }

  async react(channelId: string, messageId: string, emoji: string): Promise<void> {
    const ch = await this.fetchTextChannel(channelId)
    const msg = await ch.messages.fetch(messageId)
    await msg.react(emoji)
  }

  async sendTyping(channelId: string): Promise<void> {
    const ch = await this.fetchTextChannel(channelId)
    if ('sendTyping' in ch) await (ch as any).sendTyping()
  }

  async fetchMessages(channelId: string, limit: number): Promise<FetchedMessage[]> {
    const ch = await this.fetchTextChannel(channelId)
    const msgs = await ch.messages.fetch({ limit })
    return [...msgs.values()].reverse().map(m => ({
      id: m.id,
      authorId: m.author.id,
      authorName: m.author.username,
      isBot: m.author.bot,
      content: m.content,
      createdAt: m.createdAt,
      attachmentCount: m.attachments.size,
    }))
  }

  async downloadAttachment(att: PlatformAttachment): Promise<{ data: Buffer; name: string }> {
    if (att.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`attachment too large: ${(att.size / 1024 / 1024).toFixed(1)}MB, max ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB`)
    }
    const res = await fetch(att.url)
    const buf = Buffer.from(await res.arrayBuffer())
    return { data: buf, name: att.name }
  }

  getBotId(): string | undefined {
    return this.client.user?.id
  }

  async isReplyToBot(msg: PlatformMessage): Promise<boolean> {
    if (!msg.reference?.messageId) return false
    if (this.recentSentIds.has(msg.reference.messageId)) return true
    try {
      const ch = await this.fetchTextChannel(msg.channelId)
      const ref = await ch.messages.fetch(msg.reference.messageId)
      return ref.author.id === this.client.user?.id
    } catch {
      return false
    }
  }

  matchesPatterns(text: string, patterns: string[]): boolean {
    for (const pat of patterns) {
      try { if (new RegExp(pat, 'i').test(text)) return true } catch {}
    }
    return false
  }

  async registerSlashCommands(guildIds: string[]): Promise<void> {
    if (!this.token) return
    const rest = new REST({ version: '10' }).setToken(this.token)
    const commands = [
      new SlashCommandBuilder().setName('clear').setDescription('Main: clear context / Thread: reset session').toJSON(),
      new SlashCommandBuilder().setName('compact').setDescription('Compact main session context').toJSON(),
      new SlashCommandBuilder().setName('restart').setDescription('Restart main session').toJSON(),
      new SlashCommandBuilder().setName('enter').setDescription('Send Enter key to main session').toJSON(),
      new SlashCommandBuilder().setName('esc').setDescription('Send Esc key to main session').toJSON(),
    ]
    const botId = this.client.user?.id
    if (!botId) return
    for (const guildId of guildIds) {
      await rest.put(Routes.applicationGuildCommands(botId, guildId), { body: commands })
    }
  }

  /** Access underlying Discord.js client for advanced use */
  getClient(): Client {
    return this.client
  }
}
