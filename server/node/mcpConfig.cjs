'use strict'

const fs = require('fs')
const path = require('path')

const DEFAULT_CONFIG = Object.freeze({
    enabled: false,
    requireAuth: true,
})

function validationError(message) {
    const error = new Error(message)
    error.code = 'MCP_CONFIG_VALIDATION'
    return error
}

function createMcpConfigStore({ filePath } = {}) {
    if (typeof filePath !== 'string' || !filePath) {
        throw new Error('MCP config store filePath is required')
    }

    let config = { ...DEFAULT_CONFIG }

    function load() {
        if (!fs.existsSync(filePath)) {
            config = { ...DEFAULT_CONFIG }
            return
        }
        try {
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
            if (typeof parsed?.enabled !== 'boolean' || typeof parsed?.requireAuth !== 'boolean') {
                config = { ...DEFAULT_CONFIG }
                return
            }
            config = {
                enabled: parsed.enabled,
                requireAuth: parsed.requireAuth,
            }
        } catch {
            // Invalid configuration fails closed: MCP disabled, auth required.
            config = { ...DEFAULT_CONFIG }
        }
    }

    function persist() {
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        const contents = JSON.stringify(config, null, 2)
        const temporaryPath = `${filePath}.${process.pid}.tmp`
        fs.writeFileSync(temporaryPath, contents, { encoding: 'utf8', mode: 0o600 })
        try {
            fs.renameSync(temporaryPath, filePath)
        } catch {
            fs.writeFileSync(filePath, contents, { encoding: 'utf8', mode: 0o600 })
            try { fs.unlinkSync(temporaryPath) } catch {}
        }
        try { fs.chmodSync(filePath, 0o600) } catch {}
    }

    function get() {
        return { ...config }
    }

    function update(patch = {}) {
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
            throw validationError('MCP configuration must be an object')
        }
        if (Object.hasOwn(patch, 'enabled') && typeof patch.enabled !== 'boolean') {
            throw validationError('enabled must be a boolean')
        }
        if (Object.hasOwn(patch, 'requireAuth') && typeof patch.requireAuth !== 'boolean') {
            throw validationError('requireAuth must be a boolean')
        }
        if (!Object.hasOwn(patch, 'enabled') && !Object.hasOwn(patch, 'requireAuth')) {
            throw validationError('At least one MCP configuration field is required')
        }

        config = {
            enabled: Object.hasOwn(patch, 'enabled') ? patch.enabled : config.enabled,
            requireAuth: Object.hasOwn(patch, 'requireAuth') ? patch.requireAuth : config.requireAuth,
        }
        persist()
        return get()
    }

    load()
    return { get, update }
}

module.exports = {
    DEFAULT_CONFIG,
    createMcpConfigStore,
}
