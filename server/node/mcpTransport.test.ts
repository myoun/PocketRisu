import { afterEach, describe, expect, it } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import pkg from './mcpTransport.cjs'

const { createMcpTransport } = pkg as any

const servers: Server[] = []

afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

function createTestServer(options: { enabled?: boolean; requireAuth?: boolean; jsonLimit?: string } = {}) {
    const config = { enabled: options.enabled ?? true, requireAuth: options.requireAuth ?? true }
    const tokens: Record<string, { id: string; scopes: string[]; name: string }> = {
        'good-token': { id: 'token-read', scopes: ['risu.read'], name: 'reader' },
        'write-token': { id: 'token-write', scopes: ['risu.write'], name: 'writer' },
    }
    const app = express()
    const transport = createMcpTransport({
        configStore: { get: () => ({ ...config }) },
        tokenStore: {
            authenticate: (raw: string, scope: string | null) => {
                const token = tokens[raw]
                if (!token) return { status: 'invalid' }
                if (scope && !token.scopes.includes('risu.admin') && !token.scopes.includes(scope)) {
                    return { status: 'insufficient_scope' }
                }
                return { status: 'ok', token }
            },
        },
        serverName: 'PocketRisu Test',
        serverVersion: '1.2.3',
        randomUUID: (() => {
            let n = 0
            return () => `session-${++n}`
        })(),
        tools: [
            {
                name: 'test.echo',
                description: 'Echo input',
                inputSchema: { type: 'object' },
                scope: 'risu.read',
                handler: async (args: unknown) => ({
                    content: [{ type: 'text', text: JSON.stringify(args) }],
                }),
            },
            {
                name: 'test.write',
                description: 'Write input',
                inputSchema: { type: 'object' },
                scope: 'risu.write',
                handler: async () => ({ content: [{ type: 'text', text: 'written' }] }),
            },
        ],
    })
    transport.attach(app, {
        jsonParser: express.json({ limit: options.jsonLimit ?? '1kb' }),
    })
    app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(error?.status || 500).json({ error: String(error?.message || error) })
    })
    const server = app.listen(0)
    servers.push(server)
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No test address')
    return { base: `http://127.0.0.1:${address.port}`, transport }
}

async function initialize(
    base: string,
    options: { accept?: string; token?: string; protocolVersion?: string; protocolHeader?: string } = {},
) {
    const headers: Record<string, string> = {
        Authorization: `Bearer ${options.token ?? 'good-token'}`,
        Accept: options.accept ?? 'application/json',
        'Content-Type': 'application/json',
    }
    if (options.protocolHeader !== undefined) headers['Mcp-Protocol-Version'] = options.protocolHeader
    return fetch(`${base}/mcp`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: options.protocolVersion ?? '2025-11-25',
                capabilities: {},
                clientInfo: { name: 'test', version: '1' },
            },
        }),
    })
}

function sessionHeaders(sessionId: string, token = 'good-token') {
    return {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        'Mcp-Session-Id': sessionId,
        'Mcp-Protocol-Version': '2025-11-25',
    }
}

describe('external MCP transports', () => {
    it('serves Streamable HTTP JSON and SSE responses on /mcp', async () => {
        const { base } = createTestServer()
        const init = await initialize(base)
        expect(init.status).toBe(200)
        expect(init.headers.get('mcp-session-id')).toBe('session-1')
        expect((await init.json() as any).result.protocolVersion).toBe('2025-11-25')

        const sessionId = init.headers.get('mcp-session-id')!
        const list = await fetch(`${base}/mcp`, {
            method: 'POST',
            headers: {
                ...sessionHeaders(sessionId),
                Accept: 'text/event-stream',
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

    it('returns 400 for a missing session ID and 404 for an unknown session ID', async () => {
        const { base } = createTestServer()
        const body = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })

        const missing = await fetch(`${base}/mcp`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer good-token',
                'Content-Type': 'application/json',
                'Mcp-Protocol-Version': '2025-11-25',
            },
            body,
        })
        expect(missing.status).toBe(400)

        const unknown = await fetch(`${base}/mcp`, {
            method: 'POST',
            headers: sessionHeaders('lost-session'),
            body,
        })
        expect(unknown.status).toBe(404)
    })

    it('rejects unsupported protocol headers and supports the latest stable version', async () => {
        const { base } = createTestServer()
        const invalid = await initialize(base, { protocolHeader: '2099-01-01' })
        expect(invalid.status).toBe(400)

        const latest = await initialize(base, { protocolVersion: '2025-11-25' })
        expect(latest.status).toBe(200)
        expect((await latest.json() as any).result.protocolVersion).toBe('2025-11-25')
    })

    it('allows a write-only token to connect and exposes only write-scoped tools', async () => {
        const { base } = createTestServer()
        const init = await initialize(base, { token: 'write-token' })
        expect(init.status).toBe(200)
        const sessionId = init.headers.get('mcp-session-id')!

        const list = await fetch(`${base}/mcp`, {
            method: 'POST',
            headers: { ...sessionHeaders(sessionId, 'write-token'), Accept: 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
        })
        expect(list.status).toBe(200)
        const payload = await list.json() as any
        expect(payload.result.tools.map((tool: any) => tool.name)).toEqual(['test.write'])
    })

    it('authenticates before parsing and enforces the MCP-specific body limit', async () => {
        const { base } = createTestServer({ jsonLimit: '1kb' })
        const oversizedBody = JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: '2025-11-25', padding: 'x'.repeat(4_000) },
        })

        const unauthorized = await fetch(`${base}/mcp`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer bad-token',
                'Content-Type': 'application/json',
            },
            body: oversizedBody,
        })
        expect(unauthorized.status).toBe(401)

        const authorized = await fetch(`${base}/mcp`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer good-token',
                'Content-Type': 'application/json',
            },
            body: oversizedBody,
        })
        expect(authorized.status).toBe(413)
    })
})
