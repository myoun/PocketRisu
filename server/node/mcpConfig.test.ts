import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import pkg from './mcpConfig.cjs'

type McpConfig = {
    enabled: boolean
    requireAuth: boolean
}

type ConfigStore = {
    get: () => McpConfig
    update: (patch: Partial<McpConfig>) => McpConfig
}

const { createMcpConfigStore } = pkg as {
    createMcpConfigStore: (options: { filePath: string }) => ConfigStore
}

const tempDirs: string[] = []

function freshStore() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-mcp-config-'))
    tempDirs.push(dir)
    const filePath = path.join(dir, '__mcp_config')
    return { filePath, store: createMcpConfigStore({ filePath }) }
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

describe('MCP server configuration', () => {
    it('defaults to MCP off with authentication on', () => {
        const { store } = freshStore()
        expect(store.get()).toEqual({ enabled: false, requireAuth: true })
    })

    it('persists independent enabled and authentication toggles', () => {
        const { filePath, store } = freshStore()
        expect(store.update({ enabled: true })).toEqual({ enabled: true, requireAuth: true })
        expect(store.update({ requireAuth: false })).toEqual({ enabled: true, requireAuth: false })

        const reloaded = createMcpConfigStore({ filePath })
        expect(reloaded.get()).toEqual({ enabled: true, requireAuth: false })
    })

    it('rejects invalid updates without changing the stored configuration', () => {
        const { store } = freshStore()
        expect(() => store.update({ enabled: 'yes' } as any)).toThrow(/boolean/)
        expect(() => store.update(null as any)).toThrow(/object/)
        expect(() => store.update({})).toThrow(/field/)
        expect(store.get()).toEqual({ enabled: false, requireAuth: true })
    })

    it('fails closed when the configuration file is malformed', () => {
        const { filePath } = freshStore()
        fs.writeFileSync(filePath, '{"enabled":true,"requireAuth":"no"}', 'utf8')
        const reloaded = createMcpConfigStore({ filePath })
        expect(reloaded.get()).toEqual({ enabled: false, requireAuth: true })
    })
})
