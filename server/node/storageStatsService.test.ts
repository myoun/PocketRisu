import { afterEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { createStorageStatsService } = require('./storageStatsService.cjs')

const tempDirs: string[] = []
const services: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.close()))
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeService(options: Record<string, unknown> = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), 'pocketrisu-storage-stats-cache-'))
    tempDirs.push(dir)
    const cachePath = path.join(dir, 'stats.json')
    const service = createStorageStatsService({ cachePath, ...options })
    services.push(service)
    return { service, cachePath }
}

describe('storage stats cache', () => {
    it('persists successful results and restores them after restart', async () => {
        let now = 1_000
        const { service, cachePath } = makeService({ now: () => now, ttlMs: 100 })

        await service.refresh(async () => ({ kvRows: 12 }))
        expect(service.getCached()).toMatchObject({
            stats: { kvRows: 12 },
            cache: { available: true, computedAt: 1_000, stale: false },
        })
        await service.close()
        services.splice(services.indexOf(service), 1)

        now = 1_050
        const restored = createStorageStatsService({ cachePath, now: () => now, ttlMs: 100 })
        services.push(restored)
        expect(restored.getCached()).toMatchObject({
            stats: { kvRows: 12 },
            cache: { available: true, computedAt: 1_000, stale: false },
        })
    })

    it('deduplicates concurrent refreshes and preserves stale data on failure', async () => {
        const { service } = makeService()
        await service.refresh(async () => ({ generation: 1 }))

        let calls = 0
        let release!: () => void
        const gate = new Promise<void>((resolve) => { release = resolve })
        const compute = async () => {
            calls++
            await gate
            return { generation: 2 }
        }
        const first = service.refresh(compute)
        const second = service.refresh(compute)
        expect(calls).toBe(1)
        release()
        await Promise.all([first, second])
        expect(calls).toBe(1)
        expect(service.getCached().stats).toEqual({ generation: 2 })

        await expect(service.refresh(async () => {
            throw new Error('scan failed')
        })).rejects.toThrow('scan failed')
        expect(service.getCached().stats).toEqual({ generation: 2 })
    })

    it('marks cached results stale after a storage write', async () => {
        const { service } = makeService()
        await service.refresh(async () => ({ kvRows: 3 }))
        expect(service.getCached().cache.stale).toBe(false)

        await service.invalidate()

        expect(service.getCached()).toMatchObject({
            stats: { kvRows: 3 },
            cache: { available: true, stale: true },
        })
    })
})
