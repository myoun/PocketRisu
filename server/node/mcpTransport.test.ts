import { afterEach, describe, expect, it } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import pkg from './mcpTransport.cjs'

const { createMcpTransport } = pkg as any

const servers: Server[] = []

afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

function createTestServer(options: { enabled?: boolean; requireAuth?: boolean } = {}) {
    const config = { enabled: options.enabled ?? true, requireAuth: options.requireAuth ?? true }
    const token = { id: 'token-1', scopes: ['risu.read'], name: 'test' }
    const app = express()
    app.use(express.json())
    const transport = createMcpTransport({
        configStore: { get: () => ({ ...config }) },
        tokenStore: {
            authenticate: (raw: string, scope: string) => raw === 'good-token' && scope === 'risu.read'
                ? { status: 'ok', token }
                : { status: 'invalid' },
        },
        serverName: 'PocketRisu Test',
        serverVersion: '1.2.3',
        randomUUID: (() => {
            let n = 0
            return () => `session-${++n}`
        })(),
        tools: [{
            name: 'test.echo',
            description: 'Echo input',
            inputSchema: { type: 'object' },
            scope: 'risu.read',
            handler: async (args: unknown) => ({
                content: [{ type: 'text', text: JSON.stringify(args) }],
            }),
        }],
    })
    transport.attach(app)
    const server = app.listen(0)
    servers.push(server)
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No test address')
    return { base: `http://127.0.0.1:${address.port}`, transport }
}

async function initialize(base: string, accept = 'application/json') {
    const response = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
            Authorization: 'Bearer good-token',
            Accept: accept,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
        }),
    })
    return response
}

describe('external MCP transports', () => {
    it('serves Streamable HTTP JSON and SSE responses on /mcp', async () => {
        const { base } = createTestServer()
        const init = await initialize(base)
        expect(init.status).toBe(200)
        expect(init.headers.get('mcp-session-id')).toBe('session-1')
        expect((await init.json() as any).result.protocolVersion).toBe('2025-06-18')

        const sessionId = init.headers.get('mcp-session-id')!
        const list = await fetch(`${base}/mcp`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer good-token',
                Accept: 'text/event-stream',
                'Content-Type': 'application/json',
                'Mcp-Session-Id': sessionId,
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
        })
        expect(list.status).toBe(200)
        expect(list.headers.get('content-type')).toContain('text/event-stream')
        const body = await list.text()
        expect(body).toContain('event: message')
        expect(body).toContain('test.echo')
    })

    it('supports legacy GET /sse plus POST /messages', async () => {
        const { base } = createTestServer()
        const controller = new AbortController()
        const connection = await fetch(`${base}/sse`, {
            headers: { Authorization: 'Bearer good-token' },
            signal: controller.signal,
        })
        expect(connection.status).toBe(200)
        const reader = connection.body!.getReader()
        const first = await reader.read()
        const opening = new TextDecoder().decode(first.value)
        expect(opening).toContain('event: endpoint')
        expect(opening).toContain('/messages?sessionId=session-1')

        const post = await fetch(`${base}/messages?sessionId=session-1`, {
            method: 'POST',
            headers: { Authorization: 'Bearer good-token', 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0', id: 10, method: 'initialize',
                params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'legacy', version: '1' } },
            }),
        })
        expect(post.status).toBe(202)
        const second = await reader.read()
        const message = new TextDecoder().decode(second.value)
        expect(message).toContain('event: message')
        expect(message).toContain('2024-11-05')
        controller.abort()
    })

    it('fails closed when disabled or missing authentication', async () => {
        const disabled = createTestServer({ enabled: false })
        expect((await initialize(disabled.base)).status).toBe(404)

        const enabled = createTestServer()
        const response = await fetch(`${enabled.base}/mcp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
        })
        expect(response.status).toBe(401)
        expect(response.headers.get('www-authenticate')).toBe('Bearer')
    })
})
