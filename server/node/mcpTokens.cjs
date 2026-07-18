'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const STORE_VERSION = 1
const TOKEN_PREFIX = 'risu_mcp_'
const VALID_SCOPES = Object.freeze(['risu.read', 'risu.write', 'risu.admin'])
const VALID_SCOPE_SET = new Set(VALID_SCOPES)
const MAX_TOKENS = 100
const LAST_USED_WRITE_INTERVAL_MS = 60 * 1000

function validationError(message) {
    const error = new Error(message)
    error.code = 'MCP_TOKEN_VALIDATION'
    return error
}

function hashToken(token) {
    return crypto.createHash('sha256').update(token, 'utf8').digest('hex')
}

function publicToken(record) {
    return {
        id: record.id,
        name: record.name,
        tokenPrefix: record.tokenPrefix,
        scopes: [...record.scopes],
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
        lastUsedAt: record.lastUsedAt,
        revokedAt: record.revokedAt,
    }
}

function normalizeRecord(value) {
    if (!value || typeof value !== 'object') return null
    if (typeof value.id !== 'string' || !value.id) return null
    if (typeof value.name !== 'string' || !value.name) return null
    if (typeof value.tokenPrefix !== 'string' || !value.tokenPrefix) return null
    if (typeof value.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.tokenHash)) return null
    if (!Array.isArray(value.scopes)) return null

    const scopes = [...new Set(value.scopes.filter((scope) => VALID_SCOPE_SET.has(scope)))]
    if (scopes.length === 0) return null

    const createdAt = Number(value.createdAt)
    if (!Number.isFinite(createdAt)) return null

    const nullableTime = (input) => input === null || input === undefined
        ? null
        : (Number.isFinite(Number(input)) ? Number(input) : null)

    return {
        id: value.id,
        name: value.name.slice(0, 80),
        tokenPrefix: value.tokenPrefix,
        tokenHash: value.tokenHash,
        scopes,
        createdAt,
        expiresAt: nullableTime(value.expiresAt),
        lastUsedAt: nullableTime(value.lastUsedAt),
        revokedAt: nullableTime(value.revokedAt),
    }
}

function createMcpTokenStore({
    filePath,
    now = () => Date.now(),
    randomBytes = crypto.randomBytes,
    randomUUID = crypto.randomUUID,
} = {}) {
    if (typeof filePath !== 'string' || !filePath) {
        throw new Error('MCP token store filePath is required')
    }

    let records = []

    function load() {
        if (!fs.existsSync(filePath)) {
            records = []
            return
        }

        try {
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
            const input = Array.isArray(parsed) ? parsed : parsed.tokens
            records = Array.isArray(input)
                ? input.map(normalizeRecord).filter(Boolean)
                : []
        } catch {
            // A malformed credential file must fail closed. Do not overwrite it
            // until an explicit token-management mutation occurs.
            records = []
        }
    }

    function persist() {
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        const contents = JSON.stringify({ version: STORE_VERSION, tokens: records }, null, 2)
        const temporaryPath = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
        fs.writeFileSync(temporaryPath, contents, { encoding: 'utf8', mode: 0o600 })
        try {
            fs.renameSync(temporaryPath, filePath)
        } catch {
            // Some Windows filesystems do not replace an existing destination
            // atomically. Fall back to a direct write without losing the temp.
            fs.writeFileSync(filePath, contents, { encoding: 'utf8', mode: 0o600 })
            try { fs.unlinkSync(temporaryPath) } catch {}
        }
        try { fs.chmodSync(filePath, 0o600) } catch {}
    }

    function list() {
        return records
            .slice()
            .sort((a, b) => b.createdAt - a.createdAt)
            .map(publicToken)
    }

    function create({ name, scopes, expiresAt = null } = {}) {
        const normalizedName = typeof name === 'string' ? name.trim() : ''
        if (!normalizedName || normalizedName.length > 80) {
            throw validationError('Token name must be between 1 and 80 characters')
        }

        if (!Array.isArray(scopes)) {
            throw validationError('At least one valid scope is required')
        }
        const normalizedScopes = [...new Set(scopes.filter((scope) => VALID_SCOPE_SET.has(scope)))]
        if (normalizedScopes.length === 0 || normalizedScopes.length !== new Set(scopes).size) {
            throw validationError('At least one valid scope is required')
        }

        const issuedAt = now()
        let normalizedExpiry = null
        if (expiresAt !== null && expiresAt !== undefined) {
            normalizedExpiry = Number(expiresAt)
            if (!Number.isFinite(normalizedExpiry) || normalizedExpiry <= issuedAt) {
                throw validationError('Token expiration must be in the future')
            }
        }

        const activeCount = records.filter((record) =>
            record.revokedAt === null
            && (record.expiresAt === null || record.expiresAt > issuedAt)
        ).length
        if (activeCount >= MAX_TOKENS) {
            throw validationError(`No more than ${MAX_TOKENS} active tokens are allowed`)
        }

        const token = TOKEN_PREFIX + randomBytes(32).toString('base64url')
        const record = {
            id: randomUUID(),
            name: normalizedName,
            tokenPrefix: token.slice(0, TOKEN_PREFIX.length + 8),
            tokenHash: hashToken(token),
            scopes: normalizedScopes,
            createdAt: issuedAt,
            expiresAt: normalizedExpiry,
            lastUsedAt: null,
            revokedAt: null,
        }

        records.push(record)
        persist()
        return { token, record: publicToken(record) }
    }

    function revoke(id) {
        const record = records.find((item) => item.id === id)
        if (!record) return null
        if (record.revokedAt === null) {
            record.revokedAt = now()
            persist()
        }
        return publicToken(record)
    }

    function authenticate(token, requiredScope = null) {
        if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) {
            return { status: 'invalid' }
        }

        const digest = Buffer.from(hashToken(token), 'hex')
        const record = records.find((item) => {
            const candidate = Buffer.from(item.tokenHash, 'hex')
            return candidate.length === digest.length && crypto.timingSafeEqual(candidate, digest)
        })
        if (!record) return { status: 'invalid' }

        const currentTime = now()
        if (record.revokedAt !== null) return { status: 'revoked' }
        if (record.expiresAt !== null && record.expiresAt <= currentTime) {
            return { status: 'expired' }
        }
        if (requiredScope && !record.scopes.includes('risu.admin') && !record.scopes.includes(requiredScope)) {
            return { status: 'insufficient_scope' }
        }

        if (record.lastUsedAt === null || currentTime - record.lastUsedAt >= LAST_USED_WRITE_INTERVAL_MS) {
            record.lastUsedAt = currentTime
            persist()
        }
        return { status: 'ok', token: publicToken(record) }
    }

    load()
    return { list, create, revoke, authenticate }
}

module.exports = {
    TOKEN_PREFIX,
    VALID_SCOPES,
    createMcpTokenStore,
    hashToken,
}
