import type { Message } from '../storage/database.svelte'

type AutoSuggestionCharacterContext = {
    firstMessage: string
    alternateGreetings?: string[]
}

type AutoSuggestionChatContext = {
    message: Message[]
    fmIndex?: number
}

export function normalizeAutoSuggestionMessageCount(value: number | undefined): number {
    const configured = Math.floor(value ?? 10)
    return Number.isFinite(configured) ? Math.min(100, Math.max(1, configured)) : 10
}

export function normalizeAutoSuggestionCount(value: number | undefined): number {
    const configured = Math.floor(value ?? 5)
    return Number.isFinite(configured) ? Math.min(10, Math.max(1, configured)) : 5
}

function normalizeSuggestions(values: unknown[], limit: number): string[] {
    const seen = new Set<string>()
    const result: string[] = []
    for(const value of values){
        if(typeof value !== 'string') continue
        const normalized = value.trim()
        if(!normalized || seen.has(normalized)) continue
        seen.add(normalized)
        result.push(normalized)
        if(result.length >= limit) break
    }
    return result
}

export function parseAutoSuggestions(raw: string, count: number): string[] {
    const limit = normalizeAutoSuggestionCount(count)
    const trimmed = raw.trim()
    const jsonCandidates = [trimmed]
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
    if(fenced?.[1]) jsonCandidates.unshift(fenced[1].trim())

    for(const candidate of jsonCandidates){
        try{
            const parsed: unknown = JSON.parse(candidate)
            if(Array.isArray(parsed)) return normalizeSuggestions(parsed, limit)
            if(parsed && typeof parsed === 'object' && Array.isArray((parsed as { suggestions?: unknown }).suggestions)){
                return normalizeSuggestions((parsed as { suggestions: unknown[] }).suggestions, limit)
            }
        }
        catch{
            // Legacy list parsing below intentionally preserves existing custom prompts.
        }
    }

    const listItems = trimmed.split(/\r?\n/).flatMap((line) => {
        const match = line.trim().match(/^(?:[-*+•]|\d+[.)])\s+(.+)$/)
        return match?.[1] ? [match[1]] : []
    })
    return normalizeSuggestions(listItems, limit)
}

const LANGUAGE_NAMES: Record<string, string> = {
    en: 'English',
    ko: 'Korean',
    cn: 'Simplified Chinese',
    'zh-Hant': 'Traditional Chinese',
    de: 'German',
    es: 'Spanish',
    vi: 'Vietnamese',
}

export function resolveAutoSuggestionLanguage(
    setting: string | undefined,
    customLanguage: string | undefined,
    risuLanguage: string | undefined,
): string {
    if(setting === 'custom' && customLanguage?.trim()) return customLanguage.trim()
    const selected = !setting || setting === 'risu' || setting === 'custom' ? risuLanguage : setting
    return LANGUAGE_NAMES[selected ?? 'en'] ?? LANGUAGE_NAMES.en
}

export function getAutoSuggestionContextMessages(
    character: AutoSuggestionCharacterContext,
    chat: AutoSuggestionChatContext,
    messageCount: number,
): Message[] {
    if(chat.message.length > 0){
        return chat.message.slice(Math.max(chat.message.length - messageCount, 0))
    }

    const fmIndex = Number.isFinite(chat.fmIndex) ? chat.fmIndex as number : -1
    const greeting = fmIndex === -1
        ? character.firstMessage
        : character.alternateGreetings?.[fmIndex]
    return greeting ? [{ role: 'char', data: greeting }] : []
}

export function hashAutoSuggestionSource(value: string): string {
    let hash = 2166136261
    for(let i = 0; i < value.length; i++){
        hash ^= value.charCodeAt(i)
        hash = Math.imul(hash, 16777619)
    }
    return `v1-${(hash >>> 0).toString(36)}`
}
