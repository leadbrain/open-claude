/**
 * Platform adapter interface — abstracts messaging platform differences.
 * Discord and Lark adapters implement this interface.
 */

export interface PlatformMessage {
  id: string
  channelId: string
  authorId: string
  authorName: string
  content: string
  isBot: boolean
  isDM: boolean
  isThread: boolean
  parentChannelId?: string
  createdAt: Date
  attachments: PlatformAttachment[]
  mentionsBot: boolean
  /** If this is a reply, the referenced message ID */
  reference?: { messageId: string }
}

export interface PlatformAttachment {
  id: string
  name: string
  contentType?: string
  size: number
  url: string
}

export interface SendOptions {
  content: string
  replyTo?: string
  files?: string[]
}

export interface FetchedMessage {
  id: string
  authorId: string
  authorName: string
  isBot: boolean
  content: string
  createdAt: Date
  attachmentCount: number
}

export interface PlatformAdapter {
  /** Platform name identifier */
  readonly name: string

  // ── Lifecycle ──

  login(token: string): Promise<void>
  destroy(): Promise<void>

  // ── Events ──

  onReady(cb: (botId: string, botName: string) => void): void
  onMessage(cb: (msg: PlatformMessage) => void): void

  // ── Channel operations ──

  /** Send a message, returns the sent message ID */
  sendMessage(channelId: string, opts: SendOptions): Promise<string>
  editMessage(channelId: string, messageId: string, content: string): Promise<void>
  react(channelId: string, messageId: string, emoji: string): Promise<void>
  removeReaction?(channelId: string, messageId: string, emoji: string): Promise<void>
  /** Create a thread in a channel, returns thread ID */
  createThread?(channelId: string, name: string, message?: string): Promise<string>
  sendTyping(channelId: string): Promise<void>
  fetchMessages(channelId: string, limit: number): Promise<FetchedMessage[]>
  downloadAttachment(att: PlatformAttachment): Promise<{ data: Buffer; name: string }>

  // ── Identity ──

  getBotId(): string | undefined

  // ── Optional platform-specific ──

  registerSlashCommands?(guildIds: string[]): Promise<void>
  onInteraction?(cb: (interaction: unknown) => void): void

  /** Check if a message is a reply to a message sent by the bot */
  isReplyToBot?(msg: PlatformMessage): Promise<boolean>
  /** Check mention via extra patterns (regex) */
  matchesPatterns?(text: string, patterns: string[]): boolean
}
