'use strict'

const crypto = require('crypto')

const SUPPORTED_PROTOCOLS = new Set(['2025-06-18', '2025-03-26', '2024-11-05'])
const DEFAULT_PROTOCOL = '2025-06-18'

function jsonRpcError(id, code, message, data) {
    const error = { code, message }
    if (data !== undefined) error.data = data
    return { jsonrpc: '2.0', id: id ?? null, error }
}

function jsonRpcResult(id, result) {
    return { jsonrpc: '2.0', id, result }
}

function writeSse(res, data, event) {
    if (event) res.write(`event: ${event}\n`)
    res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`)
    res.flush?.()
}

function beginSse(res) {
    res.status(200)
    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    })
    res.flushHeaders?.()
}

function bearerToken(req) {
    const value = String(req.headers.authorization || '')
    const match = /^Bearer\s+(.+)$/i.exec(value)
    return match?.[1] || null
}

function validateOrigin(req) {
    const origin = req.headers.origin
    if (!origin) return true
    try {
        const parsed = new URL(origin)
        return parsed.host === req.headers.host
    } catch {
        return false
    }
}

function createMcpTransport({
    configStore,
    tokenStore,
    serverName = 'PocketRisu',
    serverVersion = '0.0.0',
    instructions = 'PocketRisu self-hosted AI roleplay server.',
    tools = [],
    sessionTtlMs = 30 * 60 * 1000,
    now = () => Date.now(),
    randomUUID = crypto.randomUUID,
} = {}) {
    if (!configStore || !tokenStore) throw new Error('MCP configStore and tokenStore are required')

    const sessions = new Map()

    function pruneSessions() {
        const cutoff = now() - sessionTtlMs
        for (const [id, session] of sessions) {
            if (session.updatedAt < cutoff) {
                try { session.response?.end() } catch {}
                sessions.delete(id)
            }
        }
    }

    function authenticate(req, requiredScope = 'risu.read') {
        const config = configStore.get()
        if (!config.enabled) return { ok: false, status: 404, message: 'MCP server is disabled' }
        if (!validateOrigin(req)) return { ok: false, status: 403, message: 'Invalid Origin header' }
        if (!config.requireAuth) return { ok: true, principal: null }

        const token = bearerToken(req)
        if (!token) return { ok: false, status: 401, message: 'Bearer token required' }
        const result = tokenStore.authenticate(token, requiredScope)
        if (result.status === 'ok') return { ok: true, principal: result.token }
        if (result.status === 'insufficient_scope') return { ok: false, status: 403, message: 'Insufficient MCP token scope' }
        return { ok: false, status: 401, message: `Invalid MCP token (${result.status})` }
    }

    function rejectAuth(res, auth) {
        if (auth.status === 401) res.set('WWW-Authenticate', 'Bearer')
        res.status(auth.status).json({ error: auth.message })
    }

    function createSession(protocolVersion, principal = null) {
        pruneSessions()
        const id = randomUUID()
        const session = {
            id,
            protocolVersion,
            principal,
            initialized: false,
            response: null,
            updatedAt: now(),
            transport: null,
        }
        sessions.set(id, session)
        return session
    }

    function getSession(req) {
        const id = String(req.headers['mcp-session-id'] || req.query?.sessionId || '')
        if (!id) return null
        const session = sessions.get(id) || null
        if (session) session.updatedAt = now()
        return session
    }

    function toolDefinitionsFor(principal) {
        return tools
            .filter((tool) => !tool.scope || !principal || principal.scopes.includes('risu.admin') || principal.scopes.includes(tool.scope))
            .map(({ handler, scope, ...definition }) => definition)
    }

    async function dispatch(message, context = {}) {
        if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
            return jsonRpcError(message?.id, -32600, 'Invalid Request')
        }

        const id = message.id
        const notification = id === undefined
        const method = message.method

        if (method === 'initialize') {
            const requested = String(message.params?.protocolVersion || DEFAULT_PROTOCOL)
            const protocolVersion = SUPPORTED_PROTOCOLS.has(requested) ? requested : DEFAULT_PROTOCOL
            if (context.session) {
                context.session.protocolVersion = protocolVersion
                context.session.updatedAt = now()
            }
            return notification ? null : jsonRpcResult(id, {
                protocolVersion,
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: serverName, version: serverVersion },
                instructions,
            })
        }

        if (method === 'notifications/initialized') {
            if (context.session) context.session.initialized = true
            return null
        }

        if (method === 'ping') return notification ? null : jsonRpcResult(id, {})

        if (method === 'tools/list') {
            return notification ? null : jsonRpcResult(id, { tools: toolDefinitionsFor(context.principal) })
        }

        if (method === 'tools/call') {
            const name = message.params?.name
            const tool = tools.find((candidate) => candidate.name === name)
            if (!tool) return notification ? null : jsonRpcError(id, -32602, `Unknown tool: ${name}`)
            if (tool.scope && context.principal
                && !context.principal.scopes.includes('risu.admin')
                && !context.principal.scopes.includes(tool.scope)) {
                return notification ? null : jsonRpcError(id, -32001, 'Insufficient MCP token scope')
            }
            try {
                const result = await tool.handler(message.params?.arguments || {}, context)
                return notification ? null : jsonRpcResult(id, result)
            } catch (error) {
                return notification ? null : jsonRpcResult(id, {
                    isError: true,
                    content: [{ type: 'text', text: String(error?.message || error) }],
                })
            }
        }

        return notification ? null : jsonRpcError(id, -32601, `Method not found: ${method}`)
    }

    async function handleMessage(req, res, { legacy = false } = {}) {
        const auth = authenticate(req)
        if (!auth.ok) return rejectAuth(res, auth)

        let session = getSession(req)
        const isInitialize = req.body?.method === 'initialize'
        if (!session && isInitialize) session = createSession(req.body?.params?.protocolVersion || DEFAULT_PROTOCOL, auth.principal)
        if (!session && !legacy) return res.status(400).json(jsonRpcError(req.body?.id, -32000, 'Missing or invalid MCP session'))
        if (!session && legacy) return res.status(404).json(jsonRpcError(req.body?.id, -32000, 'Unknown SSE session'))

        session.principal = auth.principal
        session.updatedAt = now()
        const response = await dispatch(req.body, { req, session, principal: auth.principal })

        if (legacy) {
            if (!session.response) return res.status(409).json(jsonRpcError(req.body?.id, -32000, 'SSE stream is not connected'))
            if (response) writeSse(session.response, response, 'message')
            return res.status(202).end()
        }

        res.set('Mcp-Session-Id', session.id)
        if (!response) return res.status(202).end()

        const acceptsSse = String(req.headers.accept || '').includes('text/event-stream')
        if (acceptsSse) {
            beginSse(res)
            writeSse(res, response, 'message')
            return res.end()
        }
        return res.json(response)
    }

    function attach(app) {
        app.post('/mcp', (req, res, next) => handleMessage(req, res).catch(next))

        app.get('/mcp', (req, res) => {
            const auth = authenticate(req)
            if (!auth.ok) return rejectAuth(res, auth)
            const session = getSession(req)
            if (!session) return res.status(400).json({ error: 'Mcp-Session-Id header required' })
            beginSse(res)
            session.response = res
            session.transport = 'streamable-http'
            session.updatedAt = now()
            req.on('close', () => {
                if (session.response === res) session.response = null
            })
        })

        app.delete('/mcp', (req, res) => {
            const auth = authenticate(req)
            if (!auth.ok) return rejectAuth(res, auth)
            const session = getSession(req)
            if (!session) return res.status(404).json({ error: 'Unknown MCP session' })
            try { session.response?.end() } catch {}
            sessions.delete(session.id)
            res.status(204).end()
        })

        app.get('/sse', (req, res) => {
            const auth = authenticate(req)
            if (!auth.ok) return rejectAuth(res, auth)
            const session = createSession('2024-11-05', auth.principal)
            session.transport = 'legacy-sse'
            session.response = res
            beginSse(res)
            writeSse(res, `/messages?sessionId=${encodeURIComponent(session.id)}`, 'endpoint')
            req.on('close', () => {
                if (session.response === res) session.response = null
                sessions.delete(session.id)
            })
        })

        app.post('/messages', (req, res, next) => handleMessage(req, res, { legacy: true }).catch(next))
    }

    return { attach, dispatch, sessions, authenticate }
}

module.exports = {
    DEFAULT_PROTOCOL,
    SUPPORTED_PROTOCOLS,
    createMcpTransport,
    jsonRpcError,
    jsonRpcResult,
    writeSse,
}
