import { describe, expect, test } from 'vitest'
import { sendCodexResponsesRequest, streamCodexResponsesRequest } from './codexResponses'
import type { AdapterChatOptions } from './types'
import type { ModelPreset } from '../types'

function preset(): ModelPreset {
    return {
        id: 'preset-codex', name: 'Codex', createdAt: 1, updatedAt: 1, userValues: { modelId: 'gpt-test' },
        profileSnapshot: {
            profileId: 'codex:test', profileVersion: 1, providerBaseId: 'codex', providerBaseVersion: 1,
            adapterKind: 'codex-responses', auth: { kind: 'bearer', fields: ['apiKey'] },
            endpoint: { kind: 'static', url: 'https://codex.test/responses' }, modelId: 'gpt-test',
            schema: [{ key: 'modelId', type: 'string', label: 'Model', mapsTo: { target: 'body', path: 'model' } }],
            uiSchema: { groups: [], fields: [] }, defaults: {}, headerTemplate: { 'Content-Type': 'application/json' }, capabilities: ['streaming', 'tools'],
        },
    }
}

function options(fetchImpl: typeof fetch): AdapterChatOptions {
    return { messages: [{ role: 'system', content: 'be precise' }, { role: 'user', content: 'hello' }], fetchImpl }
}

describe('Codex Responses adapter', () => {
    test('maps instructions, input, tools, and output text', async () => {
        const fetchImpl = async (_url: RequestInfo | URL, init?: RequestInit) => {
            expect(init?.headers).toMatchObject({ Authorization: 'Bearer access', 'Content-Type': 'application/json' })
            expect(JSON.parse(String(init?.body))).toMatchObject({
                model: 'gpt-test', instructions: 'be precise', input: [{ role: 'user', content: 'hello' }], stream: true, store: false,
            })
            return new Response(
                'data: {"type":"response.output_text.delta","delta":"Hi there"}\n\n'
                + 'data: {"type":"response.completed","response":{"output":[{"type":"output_text","text":"Hi there"}],"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}\n\n'
                + 'data: [DONE]\n\n',
                { headers: { 'Content-Type': 'text/event-stream' } },
            )
        }
        const result = await sendCodexResponsesRequest(preset(), options(fetchImpl as typeof fetch), { apiKey: 'access' })
        expect(result.text).toBe('Hi there')
        expect(result.usage).toEqual({ promptTokens: 3, completionTokens: 2, totalTokens: 5 })
    })

    test('parses output and reasoning SSE deltas', async () => {
        const body = 'data: {"type":"response.reasoning_text.delta","delta":"thinking"}\n\n'
            + 'data: {"type":"response.output_text.delta","delta":"hello"}\n\n'
            + 'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n'
            + 'data: [DONE]\n\n'
        const fetchImpl = async () => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
        const deltas = []
        for await (const delta of streamCodexResponsesRequest(preset(), options(fetchImpl as typeof fetch), { apiKey: 'access' })) deltas.push(delta)
        expect(deltas).toEqual([
            expect.objectContaining({ reasoningDelta: 'thinking' }),
            expect.objectContaining({ textDelta: 'hello' }),
            expect.objectContaining({ usage: { promptTokens: 1, completionTokens: 1 } }),
        ])
    })
})
