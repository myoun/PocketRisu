import { describe, expect, it } from 'vitest'
import {
    getAutoSuggestionContextMessages,
    hashAutoSuggestionSource,
    normalizeAutoSuggestionCount,
    normalizeAutoSuggestionMessageCount,
    parseAutoSuggestions,
    resolveAutoSuggestionLanguage,
} from './autoSuggestion'

describe('auto suggestion context', () => {
    it('uses only the configured number of recent messages', () => {
        const messages = Array.from({ length: 5 }, (_, index) => ({
            role: index % 2 === 0 ? 'user' as const : 'char' as const,
            data: `message-${index}`,
        }))

        expect(getAutoSuggestionContextMessages({ firstMessage: 'hello' }, { message: messages }, 2))
            .toEqual(messages.slice(-2))
    })

    it('uses the active first message when a chat has no messages', () => {
        expect(getAutoSuggestionContextMessages(
            { firstMessage: 'default', alternateGreetings: ['alternate'] },
            { message: [], fmIndex: 0 },
            10,
        )).toEqual([{ role: 'char', data: 'alternate' }])
    })

    it('falls back to the default first message', () => {
        expect(getAutoSuggestionContextMessages(
            { firstMessage: 'default', alternateGreetings: ['alternate'] },
            { message: [], fmIndex: -1 },
            10,
        )).toEqual([{ role: 'char', data: 'default' }])
    })
})

describe('auto suggestion cache inputs', () => {
    it('normalizes invalid and out-of-range message counts', () => {
        expect(normalizeAutoSuggestionMessageCount(Number.NaN)).toBe(10)
        expect(normalizeAutoSuggestionMessageCount(0)).toBe(1)
        expect(normalizeAutoSuggestionMessageCount(101)).toBe(100)
    })

    it('changes the cache hash when its source changes', () => {
        expect(hashAutoSuggestionSource('one')).not.toBe(hashAutoSuggestionSource('two'))
    })

    it('normalizes invalid suggestion counts', () => {
        expect(normalizeAutoSuggestionCount(Number.NaN)).toBe(5)
        expect(normalizeAutoSuggestionCount(0)).toBe(1)
        expect(normalizeAutoSuggestionCount(20)).toBe(10)
    })
})

describe('auto suggestion response parsing', () => {
    it('prefers the JSON object format', () => {
        expect(parseAutoSuggestions('{"suggestions":[" one ","two","one"]}', 5))
            .toEqual(['one', 'two'])
    })

    it('accepts fenced arrays and legacy lists', () => {
        expect(parseAutoSuggestions('```json\n["one", "two"]\n```', 5)).toEqual(['one', 'two'])
        expect(parseAutoSuggestions('- one\n* two\n3. three', 2)).toEqual(['one', 'two'])
    })

    it('resolves Risu and custom languages with a safe fallback', () => {
        expect(resolveAutoSuggestionLanguage('risu', '', 'ko')).toBe('Korean')
        expect(resolveAutoSuggestionLanguage('custom', 'Klingon', 'en')).toBe('Klingon')
        expect(resolveAutoSuggestionLanguage('custom', '', 'vi')).toBe('Vietnamese')
    })
})
