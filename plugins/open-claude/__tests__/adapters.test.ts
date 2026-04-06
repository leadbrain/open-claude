/**
 * Adapter tests — verify adapters can be imported and instantiated without errors.
 * Also tests platform-specific logic that doesn't require real connections.
 */

import { describe, test, expect } from 'bun:test'

describe('Discord adapter', () => {
  test('imports and instantiates', async () => {
    const { DiscordAdapter } = await import('../adapters/discord.ts')
    const adapter = new DiscordAdapter()
    expect(adapter.name).toBe('discord')
    expect(adapter.getBotId()).toBeUndefined()
  })

  test('matchesPatterns works', async () => {
    const { DiscordAdapter } = await import('../adapters/discord.ts')
    const adapter = new DiscordAdapter()
    expect(adapter.matchesPatterns('hey claude help', ['\\bclaude\\b'])).toBe(true)
    expect(adapter.matchesPatterns('hello world', ['\\bclaude\\b'])).toBe(false)
    expect(adapter.matchesPatterns('CLAUDE please', ['\\bclaude\\b'])).toBe(true) // case insensitive
  })
})

describe('Lark adapter', () => {
  test('imports and instantiates', async () => {
    const { LarkAdapter } = await import('../adapters/lark.ts')
    const adapter = new LarkAdapter()
    expect(adapter.name).toBe('lark')
    expect(adapter.getBotId()).toBeUndefined()
  })

  test('matchesPatterns works', async () => {
    const { LarkAdapter } = await import('../adapters/lark.ts')
    const adapter = new LarkAdapter()
    expect(adapter.matchesPatterns('hey claude help', ['\\bclaude\\b'])).toBe(true)
    expect(adapter.matchesPatterns('hello world', ['\\bclaude\\b'])).toBe(false)
  })

  test('login fails without credentials', async () => {
    const { LarkAdapter } = await import('../adapters/lark.ts')
    const adapter = new LarkAdapter()
    // No LARK_APP_ID set → should throw
    const origId = process.env.LARK_APP_ID
    delete process.env.LARK_APP_ID
    try {
      await expect(adapter.login('')).rejects.toThrow('LARK_APP_ID')
    } finally {
      if (origId) process.env.LARK_APP_ID = origId
    }
  })
})

describe('Platform interface compliance', () => {
  test('Discord adapter has all required methods', async () => {
    const { DiscordAdapter } = await import('../adapters/discord.ts')
    const adapter = new DiscordAdapter()
    expect(typeof adapter.login).toBe('function')
    expect(typeof adapter.destroy).toBe('function')
    expect(typeof adapter.onReady).toBe('function')
    expect(typeof adapter.onMessage).toBe('function')
    expect(typeof adapter.sendMessage).toBe('function')
    expect(typeof adapter.editMessage).toBe('function')
    expect(typeof adapter.react).toBe('function')
    expect(typeof adapter.removeReaction).toBe('function')
    expect(typeof adapter.sendTyping).toBe('function')
    expect(typeof adapter.fetchMessages).toBe('function')
    expect(typeof adapter.downloadAttachment).toBe('function')
    expect(typeof adapter.getBotId).toBe('function')
  })

  test('Lark adapter has all required methods', async () => {
    const { LarkAdapter } = await import('../adapters/lark.ts')
    const adapter = new LarkAdapter()
    expect(typeof adapter.login).toBe('function')
    expect(typeof adapter.destroy).toBe('function')
    expect(typeof adapter.onReady).toBe('function')
    expect(typeof adapter.onMessage).toBe('function')
    expect(typeof adapter.sendMessage).toBe('function')
    expect(typeof adapter.editMessage).toBe('function')
    expect(typeof adapter.react).toBe('function')
    expect(typeof adapter.removeReaction).toBe('function')
    expect(typeof adapter.sendTyping).toBe('function')
    expect(typeof adapter.fetchMessages).toBe('function')
    expect(typeof adapter.downloadAttachment).toBe('function')
    expect(typeof adapter.getBotId).toBe('function')
  })
})
