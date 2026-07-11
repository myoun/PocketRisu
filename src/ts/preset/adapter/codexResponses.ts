import type { ModelPreset } from '../types'
import {
    ModelPresetAdapterError,
    extractErrorMessage,
    normalizeFetchError,
    normalizeHttpStatus,
} from './error'
import { prepareAdapterRequest } from './resolveCredential'
import { parseSseStream } from './sse'
import type {
    AdapterChatMessage,
    AdapterChatOptions,
    AdapterChatResponse,
    AdapterChatStreamDelta,
    AdapterCredential,
    AdapterPreparedRequest,
    AdapterReasoningPart,
    AdapterToolCall,
    AdapterToolDef,
    AdapterUsage,
} from './types'
import { resolveWireModelId } from './wireInvariants'

type CodexInputItem =
    | { role: 'user' | 'assistant'; content: string }
    | { type: 'function_call'; id: string; call_id: string; name: string; arguments: string }
    | { type: 'function_call_output'; call_id: string; output: string }

interface CodexFunctionCall {
    type: 'function_call'
    id?: unknown
    call_id?: unknown
    name?: unknown
    arguments?: unknown
}

/** ChatGPT Codex Responses API adapter. OAuth/session ownership stays in the
 * separate Codex Manager plugin; this module only converts model-preset turns
 * to the Responses wire format and parses its JSON/SSE output. */
export async function sendCodexResponsesRequest(
    preset: ModelPreset,
    options: AdapterChatOptions,
    credential?: AdapterCredential,
): Promise<AdapterChatResponse> {
    // The ChatGPT Codex endpoint rejects non-streaming requests outright
    // ("Stream must be set to true"). For the preset's ordinary/non-streaming
    // mode we therefore consume its SSE response internally and return one
    // assembled AdapterChatResponse.
    const prepared = await prepareCodexBody(preset, options, credential, true)
    const fetchImpl = options.fetchImpl ?? globalThis.fetch
    let response: Response
    try {
        response = await fetchImpl(prepared.url, {
            method: prepared.method,
            headers: prepared.headers,
            body: JSON.stringify(prepared.body),
            signal: options.abortSignal,
        })
    } catch (err) {
        throw normalizeFetchError(err)
    }
    if (!response.ok) throw await deriveHttpError(response)

    if (!response.body) throw new ModelPresetAdapterError('parse', 'Codex Responses stream has no body')
    return collectCodexStreamResponse(response.body)
}

export async function* streamCodexResponsesRequest(
    preset: ModelPreset,
    options: AdapterChatOptions,
    credential?: AdapterCredential,
): AsyncGenerator<AdapterChatStreamDelta, void, void> {
    const prepared = await prepareCodexBody(preset, options, credential, true)
    const fetchImpl = options.fetchImpl ?? globalThis.fetch
    let response: Response
    try {
        response = await fetchImpl(prepared.url, {
            method: prepared.method,
            headers: { ...prepared.headers, Accept: 'text/event-stream' },
            body: JSON.stringify(prepared.body),
            signal: options.abortSignal,
        })
    } catch (err) {
        throw normalizeFetchError(err)
    }
    if (!response.ok) throw await deriveHttpError(response)
    if (!response.body) throw new ModelPresetAdapterError('parse', 'Codex Responses stream has no body')

    try {
        for await (const event of parseSseStream(response.body)) {
            if (event.data === '[DONE]' || event.data.length === 0) continue
            let raw: unknown
            try {
                raw = JSON.parse(event.data)
            } catch (cause) {
                throw new ModelPresetAdapterError('parse', 'Failed to parse Codex Responses stream event', { cause })
            }
            const delta = parseCodexStreamDelta(raw)
            if (delta) yield delta
        }
    } catch (err) {
        if (err instanceof ModelPresetAdapterError) throw err
        throw normalizeFetchError(err)
    }
}

export function previewCodexResponsesRequest(
    preset: ModelPreset,
    options: AdapterChatOptions,
    credential?: AdapterCredential,
): Promise<AdapterPreparedRequest> {
    return prepareCodexBody(preset, options, credential, false)
}

async function prepareCodexBody(
    preset: ModelPreset,
    options: AdapterChatOptions,
    credential: AdapterCredential | undefined,
    stream: boolean,
): Promise<AdapterPreparedRequest> {
    const prepared = await prepareAdapterRequest({ preset, credential, abortSignal: options.abortSignal })
    const { instructions, input } = toCodexInput(options.messages)
    prepared.body.model = resolveWireModelId(preset, { vendorName: 'Codex Responses' })
    prepared.body.input = input
    prepared.body.instructions = instructions || 'You are Codex.'
    prepared.body.stream = stream
    prepared.body.store = false
    if (options.tools && options.tools.length > 0) {
        prepared.body.tools = options.tools.map(toCodexTool)
    } else {
        delete prepared.body.tools
        delete prepared.body.tool_choice
    }
    return prepared
}

function toCodexInput(messages: AdapterChatMessage[]): { instructions: string; input: CodexInputItem[] } {
    const instructionParts: string[] = []
    const input: CodexInputItem[] = []
    for (const message of messages) {
        if (message.role === 'system') {
            if (message.content) instructionParts.push(message.content)
            continue
        }
        if (message.role === 'tool') {
            if (message.toolCallId) input.push({
                type: 'function_call_output', call_id: message.toolCallId, output: message.content,
            })
            continue
        }
        input.push({ role: message.role, content: message.content })
        for (const call of message.toolCalls ?? []) {
            input.push({
                type: 'function_call', id: call.id, call_id: call.id, name: call.name, arguments: call.arguments,
            })
        }
    }
    return { instructions: instructionParts.join('\n\n'), input }
}

function toCodexTool(tool: AdapterToolDef): Record<string, unknown> {
    return {
        type: 'function',
        name: tool.name,
        description: tool.description ?? `Tool ${tool.name}`,
        parameters: tool.parameters,
    }
}

function parseCodexResponse(raw: unknown): AdapterChatResponse {
    const text = collectText(raw)
    const toolCalls = collectToolCalls(raw)
    const reasoning = collectReasoning(raw)
    return {
        text,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        ...(reasoning.length > 0 ? { reasoning } : {}),
        usage: parseUsage(raw),
        raw,
    }
}

function parseCodexStreamDelta(raw: unknown): AdapterChatStreamDelta | undefined {
    if (!isRecord(raw)) return undefined
    const type = typeof raw.type === 'string' ? raw.type : ''
    const text = typeof raw.delta === 'string' ? raw.delta : ''
    if (type === 'response.output_text.delta' && text) return { textDelta: text, raw }
    if ((type === 'response.reasoning_text.delta' || type === 'response.reasoning_summary_text.delta') && text) {
        return { textDelta: '', reasoningDelta: text, raw }
    }
    if (type === 'response.completed') {
        return { textDelta: '', usage: parseUsage(raw.response ?? raw), raw }
    }
    return undefined
}

async function collectCodexStreamResponse(body: ReadableStream<Uint8Array>): Promise<AdapterChatResponse> {
    let text = ''
    const reasoning: AdapterReasoningPart[] = []
    let completedResponse: unknown
    try {
        for await (const event of parseSseStream(body)) {
            if (event.data === '[DONE]' || event.data.length === 0) continue
            let raw: unknown
            try {
                raw = JSON.parse(event.data)
            } catch (cause) {
                throw new ModelPresetAdapterError('parse', 'Failed to parse Codex Responses stream event', { cause })
            }
            if (isRecord(raw) && raw.type === 'response.completed') {
                completedResponse = raw.response ?? raw
                continue
            }
            const delta = parseCodexStreamDelta(raw)
            if (delta?.textDelta) text += delta.textDelta
            if (delta?.reasoningDelta) reasoning.push({ text: delta.reasoningDelta })
        }
    } catch (err) {
        if (err instanceof ModelPresetAdapterError) throw err
        throw normalizeFetchError(err)
    }

    if (completedResponse !== undefined) {
        const parsed = parseCodexResponse(completedResponse)
        return {
            ...parsed,
            text: parsed.text || text,
            reasoning: parsed.reasoning?.length ? parsed.reasoning : reasoning.length ? reasoning : undefined,
        }
    }
    return { text, ...(reasoning.length ? { reasoning } : {}), raw: undefined }
}

function collectText(node: unknown, seen = new Set<object>()): string {
    const parts: string[] = []
    visit(node, seen, (value) => {
        if (value.type === 'output_text' && typeof value.text === 'string') parts.push(value.text)
        else if (typeof value.output_text === 'string') parts.push(value.output_text)
    })
    return dedupe(parts).join('\n\n').trim()
}

function collectToolCalls(node: unknown, seen = new Set<object>()): AdapterToolCall[] {
    const calls: AdapterToolCall[] = []
    visit(node, seen, (value) => {
        if (value.type !== 'function_call') return
        const call = value as CodexFunctionCall
        const id = typeof call.call_id === 'string' ? call.call_id : typeof call.id === 'string' ? call.id : ''
        if (id && typeof call.name === 'string') {
            calls.push({ id, name: call.name, arguments: typeof call.arguments === 'string' ? call.arguments : '{}' })
        }
    })
    return calls
}

function collectReasoning(node: unknown, seen = new Set<object>()): AdapterReasoningPart[] {
    const parts: AdapterReasoningPart[] = []
    visit(node, seen, (value) => {
        if (value.type === 'reasoning' && typeof value.text === 'string' && value.text) parts.push({ text: value.text })
        if (value.type === 'reasoning' && Array.isArray(value.summary)) {
            for (const item of value.summary) {
                if (isRecord(item) && typeof item.text === 'string' && item.text) parts.push({ text: item.text })
            }
        }
    })
    return parts
}

function parseUsage(node: unknown): AdapterUsage | undefined {
    if (!isRecord(node)) return undefined
    const usage = isRecord(node.usage) ? node.usage : undefined
    if (!usage) return undefined
    const promptTokens = numberValue(usage.input_tokens) ?? numberValue(usage.prompt_tokens)
    const completionTokens = numberValue(usage.output_tokens) ?? numberValue(usage.completion_tokens)
    const totalTokens = numberValue(usage.total_tokens)
    return promptTokens === undefined && completionTokens === undefined && totalTokens === undefined
        ? undefined
        : { promptTokens, completionTokens, totalTokens }
}

function visit(node: unknown, seen: Set<object>, onRecord: (value: Record<string, unknown>) => void): void {
    if (Array.isArray(node)) {
        for (const value of node) visit(value, seen, onRecord)
        return
    }
    if (!isRecord(node) || seen.has(node)) return
    seen.add(node)
    onRecord(node)
    for (const value of Object.values(node)) visit(value, seen, onRecord)
}

function dedupe(values: string[]): string[] {
    return [...new Set(values.filter(Boolean))]
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numberValue(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

async function deriveHttpError(response: Response): Promise<ModelPresetAdapterError> {
    let text = ''
    try { text = await response.text() } catch { /* preserve status fallback */ }
    return new ModelPresetAdapterError(
        normalizeHttpStatus(response.status),
        extractErrorMessage(text) ?? `Codex Responses request failed (${response.status})`,
        { status: response.status },
    )
}
