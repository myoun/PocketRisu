import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import pkg from './mcpTokens.cjs'

type Scope = 'risu.read' | 'risu.write' | 'risu.admin'
type PublicToken = {
    id: string
    name: string
    tokenPrefix: string
    scopes: Scope[]
    createdAt: number
    expiresAt: number | null
    lastUsedAt: number | null
    revokedAt: number | null
}

type TokenStore = {
    list: () => PublicToken[]
    create: (input: { name: string; scopes: Scope[]; expiresAt?: number | null }) => {
        token: string
        record: PublicToken
    }
    revoke: (id: string) => PublicToken | null
    authenticate: (
        token: string,
        requiredScope?: Scope | null,
    ) => { status: string; token?: PublicToken }
}

const { createMcpTokenStore } = pkg as {
    createMcpTokenStore: (options: {
        filePath: string
        now?: () => number
    }) => TokenStore
}

const tempDirs: string[] = []

function freshStore(now: () => number = () => Date.now()) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-mcp-'))
    tempDirs.push(dir)
    const filePath = path.join(dir, '__mcp_tokens')
    return { filePath, store: createMcpTokenStore({ filePath, now }) }
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

describe('MCP token storage', () => {
    it('stores only a hash and returns the raw token exactly once', () => {
        const { filePath, store } = freshStore(() => 1_000)
        const created = store.create({
            name: 'Claude Desktop',
            scopes: ['risu.read'],
            expiresAt: 10_000,
        })

        expect(created.token).toMatch(/^risu_mcp_[A-Za-z0-9_-]{43}$/)
        expect(created.record).not.toHaveProperty('tokenHash')

        const persisted = fs.readFileSync(filePath, 'utf8')
        expect(persisted).not.toContain(created.token)
        expect(persisted).toMatch(/"tokenHash":\s*"[0-9a-f]{64}"/)
    })

    it('respects issuer-selected expiration including no expiration', () => {
        const { store } = freshStore(() => 1_000)
        const dated = store.create({
            name: '30 day token',
            scopes: ['risu.read'],
            expiresAt: 50_000,
        })
        const permanent = store.create({
            name: 'No expiry token',
            scopes: ['risu.admin'],
            expiresAt: null,
        })

        expect(dated.record.expiresAt).toBe(50_000)
        expect(permanent.record.expiresAt).toBeNull()
        expect(() => store.create({
            name: 'Expired',
            scopes: ['risu.read'],
            expiresAt: 999,
        })).toThrow(/future/)
    })

    it('enforces scopes, expiry, revocation, and admin scope inheritance', () => {
        let currentTime = 1_000
        const { store } = freshStore(() => currentTime)
        const readOnly = store.create({
            name: 'Reader',
            scopes: ['risu.read'],
            expiresAt: 2_000,
        })
        const admin = store.create({
            name: 'Admin',
            scopes: ['risu.admin'],
            expiresAt: null,
        })

        expect(store.authenticate(readOnly.token, 'risu.read').status).toBe('ok')
        expect(store.authenticate(readOnly.token, 'risu.write').status).toBe('insufficient_scope')
        expect(store.authenticate(admin.token, 'risu.write').status).toBe('ok')

        currentTime = 2_000
        expect(store.authenticate(readOnly.token, 'risu.read').status).toBe('expired')

        store.revoke(admin.record.id)
        expect(store.authenticate(admin.token, 'risu.read').status).toBe('revoked')
        expect(store.authenticate('risu_mcp_not-a-token', 'risu.read').status).toBe('invalid')
    })

    it('reloads metadata while keeping raw tokens unavailable', () => {
        const { filePath, store } = freshStore(() => 1_000)
        const created = store.create({
            name: 'Persistent token',
            scopes: ['risu.read', 'risu.write'],
            expiresAt: null,
        })

        const reloaded = createMcpTokenStore({ filePath, now: () => 1_500 })
        expect(reloaded.list()).toEqual([created.record])
        expect(reloaded.authenticate(created.token, 'risu.write').status).toBe('ok')
        expect(reloaded.list()[0].lastUsedAt).toBe(1_500)
    })
})
