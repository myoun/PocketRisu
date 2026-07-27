import { afterEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')
const {
    CHUNK_MARKER,
    DB_BLOB_KEY,
    createStorageStatsReader,
} = require('./storageStatsWorker.cjs')

const tempDirs: string[] = []
const databases: Array<{ close: () => void }> = []

afterEach(() => {
    for (const database of databases.splice(0)) database.close()
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('storage stats worker aggregation', () => {
    it('uses indexed prefix ranges and reports logical chunked sizes', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'pocketrisu-storage-stats-worker-'))
        tempDirs.push(dir)
        const database = new Database(path.join(dir, 'risuai.db'))
        databases.push(database)
        database.exec(`
            CREATE TABLE kv (key TEXT PRIMARY KEY, value BLOB NOT NULL);
            CREATE TABLE chunks (hash TEXT PRIMARY KEY, data BLOB NOT NULL);
            CREATE TABLE manifest_chunks (
                manifest_key TEXT NOT NULL,
                seq INTEGER NOT NULL,
                hash TEXT NOT NULL,
                PRIMARY KEY (manifest_key, seq)
            );
        `)

        const insertKv = database.prepare('INSERT INTO kv (key, value) VALUES (?, ?)')
        insertKv.run(DB_BLOB_KEY, CHUNK_MARKER)
        insertKv.run('database/dbbackup-17000000000.bin', Buffer.alloc(13))
        insertKv.run('assets/kept.png', Buffer.alloc(3))
        insertKv.run('assets/orphan.png', Buffer.alloc(5))
        insertKv.run('inlay_meta/entry', Buffer.alloc(7))
        insertKv.run('remotes/character.local.bin', Buffer.alloc(2))
        database.prepare('INSERT INTO chunks (hash, data) VALUES (?, ?)').run('live', Buffer.alloc(11))
        database.prepare('INSERT INTO chunks (hash, data) VALUES (?, ?)').run('orphan', Buffer.alloc(17))
        database.prepare('INSERT INTO manifest_chunks (manifest_key, seq, hash) VALUES (?, ?, ?)')
            .run(DB_BLOB_KEY, 0, 'live')

        const stats = createStorageStatsReader(database).compute({
            referencedAssets: ['kept.png'],
        })

        expect(stats.prefixes['assets/']).toEqual({ count: 2, totalSize: 8 })
        expect(stats.prefixes[DB_BLOB_KEY]).toEqual({ count: 1, totalSize: 11 })
        expect(stats.prefixes['database/dbbackup-']).toEqual({ count: 1, totalSize: 13 })
        expect(stats.prefixes['inlay_meta/']).toEqual({ count: 1, totalSize: 7 })
        expect(stats.backups).toEqual({
            count: 1,
            totalSize: 13,
            oldest: 1_700_000_000_000,
            newest: 1_700_000_000_000,
        })
        expect(stats.orphan).toEqual({ count: 1, totalSize: 5, available: true })
        expect(stats.chunks).toMatchObject({
            count: 2,
            bytes: 28,
            orphanBytes: 17,
            liveChunked: true,
        })
    })
})
