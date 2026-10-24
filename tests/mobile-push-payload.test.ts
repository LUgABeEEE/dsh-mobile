import { describe, expect, it } from 'vitest'
import { buildDeclarativePayload } from '../src/mobile-push/payload.js'

describe('declarative Web Push payloads', () => {
  it('constructs a valid localized, same-origin payload for every supported locale', () => {
    const expectations = [
      ['en', 'Input requested', 'A response needs your attention.'],
      ['zh-CN', '需要输入', '有一项回复需要您关注。'],
      ['it', 'Input richiesto', 'Una risposta richiede la tua attenzione.'],
    ] as const
    for (const [locale, title, body] of expectations) {
      const payload = JSON.parse(buildDeclarativePayload('question', locale, '/?mobile-push=opaque-123', 'push-tag-1'))
      expect(payload.web_push).toBe(8030)
      expect(payload.notification.title).toBe(title)
      expect(payload.notification.body).toBe(body)
      expect(payload.notification.lang).toBe(locale)
      expect(payload.notification.navigate).toBe('/?mobile-push=opaque-123')
      expect(payload.notification.tag).toBe('push-tag-1')
      expect(payload).not.toHaveProperty('options')
      expect(payload.notification).not.toHaveProperty('badge')
      expect(payload.notification).not.toHaveProperty('silent')
      expect(JSON.stringify(payload)).not.toMatch(/transcript|excerpt|private conversation/i)
      expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBeLessThanOrEqual(3072)
    }
  })

  it('rejects navigation that could leave the same-origin root query route', () => {
    for (const navigate of [
      'https://attacker.example/?mobile-push=opaque-123',
      '//attacker.example/?mobile-push=opaque-123',
      '/sessions/opaque-123',
      '/?mobile-push=opaque-123&next=https://attacker.example/',
      '/?mobile-push=',
      '/?mobile-push=opaque-123#fragment',
      '?mobile-push=opaque-123',
    ]) {
      expect(() => buildDeclarativePayload('question', 'en', navigate, 'push-tag-1')).toThrow()
    }
  })

  it('rejects oversized or malformed tags instead of emitting unsafe payloads', () => {
    expect(() => buildDeclarativePayload('response', 'en', '/?mobile-push=opaque-123', 'x'.repeat(4000))).toThrow()
    expect(() => buildDeclarativePayload('response', 'en', '/?mobile-push=opaque-123', '')).toThrow()
  })
})
