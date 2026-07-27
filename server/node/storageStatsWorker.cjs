'use strict';

const { isMainThread, parentPort, workerData } = require('worker_threads');
const Database = require('better-sqlite3');

const DB_BLOB_KEY = 'database/database.bin';
const DB_BACKUP_PREFIX = 'database/dbbackup-';
const ASSET_PREFIXES = ['assets/', 'remotes/', 'inlay/', 'inlay_thumb/', 'inlay_meta/', 'inlay_info/', 'coldstorage/'];
const CHUNK_MARKER = Buffer.from('\x00RISUCHUNKED\x00', 'binary');

function prefixUpperBound(prefix) {
    if (!prefix) throw new Error('Prefix must not be empty');
    const last = prefix.charCodeAt(prefix.length - 1);
    if (last >= 0xffff) return `${prefix}\u0000`;
    return `${prefix.slice(0, -1)}${String.fromCharCode(last + 1)}`;
}

function basename(value) {
    if (!value) return '';
    return String(value).replace(/\\/g, '/').split('/').pop();
}

function createStorageStatsReader(db) {
    const prefixRows = db.prepare(`
        SELECT key, LENGTH(value) AS size
        FROM kv
        WHERE key >= ? AND key < ?
    `);
    const prefixAggregate = db.prepare(`
        SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(value)), 0) AS totalSize
        FROM kv
        WHERE key >= ? AND key < ?
    `);
    const backupRows = db.prepare(`
        SELECT key, LENGTH(value) AS rawSize, value = ? AS chunked
        FROM kv
        WHERE key >= ? AND key < ?
    `);
    const valueInfo = db.prepare('SELECT LENGTH(value) AS rawSize, value = ? AS chunked FROM kv WHERE key = ?');
    const chunkedSize = db.prepare(`
        SELECT COALESCE(SUM(LENGTH(c.data)), 0) AS size
        FROM manifest_chunks m
        JOIN chunks c ON c.hash = m.hash
        WHERE m.manifest_key = ?
    `);
    const manifestExists = db.prepare('SELECT 1 AS present FROM manifest_chunks WHERE manifest_key = ? LIMIT 1');
    const chunkTotals = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM chunks');
    const reclaimableChunks = db.prepare(`
        SELECT COALESCE(SUM(LENGTH(data)), 0) AS bytes
        FROM chunks
        WHERE hash NOT IN (
            SELECT hash
            FROM manifest_chunks mc
            WHERE EXISTS (
                SELECT 1 FROM kv WHERE kv.key = mc.manifest_key AND kv.value = ?
            )
        )
    `);
    const kvTotals = db.prepare('SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(value)), 0) AS bytes FROM kv');

    function logicalValueSize(key, info) {
        if (!info) return 0;
        return info.chunked ? chunkedSize.get(key).size : info.rawSize;
    }

    function compute({ referencedAssets = [] } = {}) {
        const references = new Set(Array.isArray(referencedAssets) ? referencedAssets : []);
        const prefixes = {};

        const assetPrefix = 'assets/';
        const assets = prefixRows.all(assetPrefix, prefixUpperBound(assetPrefix));
        let assetBytes = 0;
        let orphanCount = 0;
        let orphanBytes = 0;
        for (const asset of assets) {
            assetBytes += asset.size;
            if (!references.has(basename(asset.key))) {
                orphanCount++;
                orphanBytes += asset.size;
            }
        }
        prefixes[assetPrefix] = { totalSize: assetBytes, count: assets.length };

        for (const prefix of ASSET_PREFIXES) {
            if (prefix === assetPrefix) continue;
            prefixes[prefix] = prefixAggregate.get(prefix, prefixUpperBound(prefix));
        }

        const databaseInfo = valueInfo.get(CHUNK_MARKER, DB_BLOB_KEY);
        const dbBlobSize = logicalValueSize(DB_BLOB_KEY, databaseInfo);
        prefixes[DB_BLOB_KEY] = { totalSize: dbBlobSize, count: databaseInfo ? 1 : 0 };

        const backupItems = backupRows.all(
            CHUNK_MARKER,
            DB_BACKUP_PREFIX,
            prefixUpperBound(DB_BACKUP_PREFIX),
        );
        let backupTotal = 0;
        let backupOldest = null;
        let backupNewest = null;
        for (const item of backupItems) {
            backupTotal += logicalValueSize(item.key, item);
            const timestampPart = item.key.slice(DB_BACKUP_PREFIX.length, -4);
            const parsed = Number.parseInt(timestampPart, 10);
            if (!Number.isFinite(parsed)) continue;
            const timestamp = parsed * 100;
            if (backupOldest === null || timestamp < backupOldest) backupOldest = timestamp;
            if (backupNewest === null || timestamp > backupNewest) backupNewest = timestamp;
        }
        prefixes[DB_BACKUP_PREFIX] = { totalSize: backupTotal, count: backupItems.length };

        const pageSize = db.pragma('page_size', { simple: true });
        const pageCount = db.pragma('page_count', { simple: true });
        const freelistCount = db.pragma('freelist_count', { simple: true });
        const journalMode = db.pragma('journal_mode', { simple: true });
        const autoVacuum = db.pragma('auto_vacuum', { simple: true });
        const chunks = chunkTotals.get();
        const reclaimable = reclaimableChunks.get(CHUNK_MARKER);
        const kv = kvTotals.get();
        const liveChunked = !!databaseInfo?.chunked && !!manifestExists.get(DB_BLOB_KEY);

        return {
            sqlite: {
                pageSize,
                pageCount,
                freelistCount,
                reclaimable: freelistCount * pageSize,
                journalMode,
                autoVacuum,
            },
            chunks: {
                count: chunks.count,
                bytes: chunks.bytes,
                orphanBytes: reclaimable.bytes,
                liveChunked,
            },
            prefixes,
            kvRows: kv.rows,
            kvTotalBytes: kv.bytes,
            dbBlobSize,
            assetBytes,
            inlayMetaBytes: prefixes['inlay_meta/']?.totalSize ?? 0,
            backups: {
                count: backupItems.length,
                totalSize: backupTotal,
                oldest: backupOldest,
                newest: backupNewest,
            },
            orphan: {
                count: orphanCount,
                totalSize: orphanBytes,
                available: true,
            },
        };
    }

    return { compute };
}

function openReadonlyDatabase(dbPath) {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma('query_only = ON');
    db.pragma('busy_timeout = 5000');
    db.pragma('mmap_size = 268435456');
    return db;
}

if (!isMainThread) {
    const db = openReadonlyDatabase(workerData.dbPath);
    const reader = createStorageStatsReader(db);
    parentPort.on('message', ({ id, input }) => {
        try {
            parentPort.postMessage({ id, result: reader.compute(input) });
        } catch (error) {
            parentPort.postMessage({
                id,
                error: {
                    message: error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : undefined,
                },
            });
        }
    });
}

module.exports = {
    ASSET_PREFIXES,
    DB_BACKUP_PREFIX,
    DB_BLOB_KEY,
    CHUNK_MARKER,
    prefixUpperBound,
    createStorageStatsReader,
    openReadonlyDatabase,
};
