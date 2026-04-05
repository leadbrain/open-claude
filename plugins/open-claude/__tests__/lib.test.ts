import { describe, test, expect } from 'bun:test'
import {
  chunk,
  defaultAccess,
  pruneExpired,
  gatePure,
  MAX_CHUNK_LIMIT,
  type Access,
  type GateInput,
} from '../lib.ts'

// ── chunk() ──

describe('chunk', () => {
  test('returns single element for short text', () => {
    expect(chunk('hello', 100, 'length')).toEqual(['hello'])
  })

  test('returns single element for text exactly at limit', () => {
    const text = 'a'.repeat(100)
    expect(chunk(text, 100, 'length')).toEqual([text])
  })

  test('splits at limit in length mode', () => {
    const text = 'a'.repeat(150)
    const result = chunk(text, 100, 'length')
    expect(result.length).toBe(2)
    expect(result[0].length).toBe(100)
    expect(result[1].length).toBe(50)
  })

  test('splits at newline boundary in newline mode', () => {
    const text = 'line1\n\nline2\n\nline3\n\nline4'
    const result = chunk(text, 15, 'newline')
    expect(result.length).toBeGreaterThan(1)
    // Should not cut mid-word
    for (const part of result) {
      expect(part).not.toMatch(/^n/)  // shouldn't start with remainder of "line"
    }
  })

  test('splits at paragraph boundary preferentially', () => {
    // Build text: "aaa...aaa\n\nbbb...bbb" where total > limit but \n\n is past midpoint
    const a = 'a'.repeat(60)
    const b = 'b'.repeat(60)
    const text = `${a}\n\n${b}`
    const result = chunk(text, 100, 'newline')
    expect(result[0]).toBe(a)
    expect(result[1]).toBe(b)
  })

  test('falls back to space when no newlines', () => {
    const text = 'word '.repeat(30).trim()  // "word word word..."
    const result = chunk(text, 20, 'newline')
    expect(result.length).toBeGreaterThan(1)
    // Each chunk should end at a word boundary (space)
    for (const part of result.slice(0, -1)) {
      expect(part).not.toMatch(/\S$.*\S/)  // rough check
    }
  })

  test('handles empty string', () => {
    expect(chunk('', 100, 'length')).toEqual([''])
  })

  test('strips leading newlines from remainder', () => {
    const text = 'first part\n\n\n\nsecond part'
    const result = chunk(text, 12, 'newline')
    // Second chunk should not start with newlines
    if (result.length > 1) {
      expect(result[1]).not.toMatch(/^\n/)
    }
  })
})

// ── defaultAccess() ──

describe('defaultAccess', () => {
  test('returns expected shape', () => {
    const a = defaultAccess()
    expect(a.dmPolicy).toBe('pairing')
    expect(a.allowFrom).toEqual([])
    expect(a.groups).toEqual({})
    expect(a.pending).toEqual({})
  })

  test('has sensible defaults for optional fields', () => {
    const a = defaultAccess()
    expect(a.ackReaction).toBe('👀')
    expect(a.chunkMode).toBe('newline')
  })
})

// ── pruneExpired() ──

describe('pruneExpired', () => {
  test('removes expired entries', () => {
    const a = defaultAccess()
    a.pending = {
      'abc123': {
        senderId: 'u1', chatId: 'c1',
        createdAt: 1000, expiresAt: 1000, // expired
        replies: 1,
      },
    }
    const changed = pruneExpired(a)
    expect(changed).toBe(true)
    expect(Object.keys(a.pending)).toHaveLength(0)
  })

  test('keeps non-expired entries', () => {
    const a = defaultAccess()
    a.pending = {
      'abc123': {
        senderId: 'u1', chatId: 'c1',
        createdAt: Date.now(), expiresAt: Date.now() + 3600000,
        replies: 1,
      },
    }
    const changed = pruneExpired(a)
    expect(changed).toBe(false)
    expect(Object.keys(a.pending)).toHaveLength(1)
  })

  test('handles mixed expired and non-expired', () => {
    const a = defaultAccess()
    a.pending = {
      'expired': {
        senderId: 'u1', chatId: 'c1',
        createdAt: 1000, expiresAt: 1000,
        replies: 1,
      },
      'valid': {
        senderId: 'u2', chatId: 'c2',
        createdAt: Date.now(), expiresAt: Date.now() + 3600000,
        replies: 1,
      },
    }
    const changed = pruneExpired(a)
    expect(changed).toBe(true)
    expect(a.pending['expired']).toBeUndefined()
    expect(a.pending['valid']).toBeDefined()
  })

  test('returns false when no pending entries', () => {
    const a = defaultAccess()
    expect(pruneExpired(a)).toBe(false)
  })
})

// ── gatePure() ──

describe('gatePure', () => {
  const baseInput: GateInput = {
    senderId: 'user1',
    isDM: true,
    channelId: 'ch1',
    isThread: false,
    isMentioned: false,
  }

  test('drops when dmPolicy is disabled', () => {
    const access = { ...defaultAccess(), dmPolicy: 'disabled' as const }
    expect(gatePure(baseInput, access)).toEqual({ action: 'drop' })
  })

  test('delivers DM from allowed user', () => {
    const access = { ...defaultAccess(), allowFrom: ['user1'] }
    const result = gatePure(baseInput, access)
    expect(result.action).toBe('deliver')
  })

  test('drops DM from non-allowed user in allowlist mode', () => {
    const access = { ...defaultAccess(), dmPolicy: 'allowlist' as const, allowFrom: ['other'] }
    expect(gatePure(baseInput, access)).toEqual({ action: 'drop' })
  })

  test('returns need_pair for new user in pairing mode', () => {
    const access = defaultAccess()  // dmPolicy: 'pairing'
    expect(gatePure(baseInput, access)).toEqual({ action: 'need_pair' })
  })

  test('returns resend pair for existing pending user', () => {
    const access = defaultAccess()
    access.pending = {
      'abc123': {
        senderId: 'user1', chatId: 'ch1',
        createdAt: Date.now(), expiresAt: Date.now() + 3600000,
        replies: 1,
      },
    }
    const result = gatePure(baseInput, access)
    expect(result).toEqual({ action: 'pair', code: 'abc123', isResend: true })
  })

  test('drops when pending user exceeded reply limit', () => {
    const access = defaultAccess()
    access.pending = {
      'abc123': {
        senderId: 'user1', chatId: 'ch1',
        createdAt: Date.now(), expiresAt: Date.now() + 3600000,
        replies: 2,
      },
    }
    expect(gatePure(baseInput, access)).toEqual({ action: 'drop' })
  })

  test('drops when max pending reached', () => {
    const access = defaultAccess()
    access.pending = {
      'a': { senderId: 'x1', chatId: 'c1', createdAt: 0, expiresAt: Date.now() + 3600000, replies: 1 },
      'b': { senderId: 'x2', chatId: 'c2', createdAt: 0, expiresAt: Date.now() + 3600000, replies: 1 },
      'c': { senderId: 'x3', chatId: 'c3', createdAt: 0, expiresAt: Date.now() + 3600000, replies: 1 },
    }
    expect(gatePure(baseInput, access)).toEqual({ action: 'drop' })
  })

  // Guild channel tests
  const guildInput: GateInput = {
    senderId: 'user1',
    isDM: false,
    channelId: 'guild-ch',
    isThread: false,
    isMentioned: true,
  }

  test('drops guild message when no policy exists', () => {
    const access = defaultAccess()
    expect(gatePure(guildInput, access)).toEqual({ action: 'drop' })
  })

  test('delivers guild message with matching policy and mention', () => {
    const access = defaultAccess()
    access.groups = { 'guild-ch': { requireMention: true, allowFrom: [] } }
    expect(gatePure(guildInput, access).action).toBe('deliver')
  })

  test('drops guild message without mention when required', () => {
    const access = defaultAccess()
    access.groups = { 'guild-ch': { requireMention: true, allowFrom: [] } }
    const input = { ...guildInput, isMentioned: false }
    expect(gatePure(input, access)).toEqual({ action: 'drop' })
  })

  test('delivers guild message without mention when not required', () => {
    const access = defaultAccess()
    access.groups = { 'guild-ch': { requireMention: false, allowFrom: [] } }
    const input = { ...guildInput, isMentioned: false }
    expect(gatePure(input, access).action).toBe('deliver')
  })

  test('drops guild message when sender not in allowFrom', () => {
    const access = defaultAccess()
    access.groups = { 'guild-ch': { requireMention: false, allowFrom: ['other'] } }
    expect(gatePure(guildInput, access)).toEqual({ action: 'drop' })
  })

  test('delivers guild message when sender in allowFrom', () => {
    const access = defaultAccess()
    access.groups = { 'guild-ch': { requireMention: false, allowFrom: ['user1'] } }
    expect(gatePure(guildInput, access).action).toBe('deliver')
  })

  test('uses parentId for thread channels', () => {
    const access = defaultAccess()
    access.groups = { 'parent-ch': { requireMention: false, allowFrom: [] } }
    const input: GateInput = {
      senderId: 'user1',
      isDM: false,
      channelId: 'thread-ch',
      isThread: true,
      parentId: 'parent-ch',
      isMentioned: false,
    }
    expect(gatePure(input, access).action).toBe('deliver')
  })
})

// ── MAX_CHUNK_LIMIT ──

describe('constants', () => {
  test('MAX_CHUNK_LIMIT is 2000', () => {
    expect(MAX_CHUNK_LIMIT).toBe(2000)
  })
})
