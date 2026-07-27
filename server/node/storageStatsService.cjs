'use strict';

const { Worker } = require('worker_threads');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const CACHE_VERSION = 1;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_STALE_MS = 24 * 60 * 60 * 1000;

function validCacheEntry(value) {
    return !!value
        && value.version === CACHE_VERSION
        && Number.isFinite(value.computedAt)
        && value.computedAt > 0
        && value.stats
        && typeof value.stats === 'object';
}

function loadCacheFile(cachePath) {
    try {
        const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        return validCacheEntry(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function createStorageStatsService({
    cachePath = path.join(process.cwd(), 'save', '__storage_stats_cache.json'),
    workerPath = path.join(__dirname, 'storageStatsWorker.cjs'),
    dbPath = path.join(process.cwd(), 'save', 'risuai.db'),
    ttlMs = DEFAULT_TTL_MS,
    maxStaleMs = DEFAULT_MAX_STALE_MS,
    now = () => Date.now(),
    workerFactory = (filename, options) => new Worker(filename, options),
    onPersistError = () => {},
} = {}) {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });

    let cached = loadCacheFile(cachePath);
    let inflightRefresh = null;
    let worker = null;
    let nextWorkerRequestId = 1;
    let invalidationRevision = 0;
    let persistQueue = Promise.resolve();
    const workerRequests = new Map();
    let closed = false;

    function cacheState() {
        const computedAt = cached?.computedAt ?? null;
        const ageMs = computedAt === null ? null : Math.max(0, now() - computedAt);
        return {
            available: !!cached,
            computedAt,
            stale: ageMs === null || ageMs >= ttlMs || cached?.invalidated === true,
            expired: ageMs === null || ageMs >= maxStaleMs,
            refreshing: !!inflightRefresh,
        };
    }

    function getCached() {
        return {
            stats: cached?.stats ?? null,
            cache: cacheState(),
        };
    }

    function rejectWorkerRequests(error, targetWorker = null) {
        for (const [id, pending] of workerRequests) {
            if (targetWorker && pending.worker !== targetWorker) continue;
            workerRequests.delete(id);
            pending.reject(error);
        }
    }

    function ensureWorker() {
        if (closed) throw new Error('Storage stats service is closed');
        if (worker) return worker;

        const createdWorker = workerFactory(workerPath, { workerData: { dbPath } });
        worker = createdWorker;
        createdWorker.unref?.();
        createdWorker.on('message', (message) => {
            const pending = workerRequests.get(message?.id);
            if (!pending || pending.worker !== createdWorker) return;
            workerRequests.delete(message.id);
            if (message.error) {
                const error = new Error(message.error.message || 'Storage stats worker failed');
                if (message.error.stack) error.stack = message.error.stack;
                pending.reject(error);
                return;
            }
            pending.resolve(message.result);
        });
        createdWorker.on('error', (error) => {
            rejectWorkerRequests(error, createdWorker);
            if (worker === createdWorker) worker = null;
        });
        createdWorker.on('exit', (code) => {
            if (code !== 0) {
                rejectWorkerRequests(
                    new Error(`Storage stats worker exited with code ${code}`),
                    createdWorker,
                );
            }
            if (worker === createdWorker) worker = null;
        });
        return createdWorker;
    }

    function computeDatabaseStats(input = {}) {
        const activeWorker = ensureWorker();
        const id = nextWorkerRequestId++;
        return new Promise((resolve, reject) => {
            workerRequests.set(id, { resolve, reject, worker: activeWorker });
            activeWorker.postMessage({ id, input });
        });
    }

    function persist(entry) {
        const serialized = JSON.stringify(entry);
        persistQueue = persistQueue.then(async () => {
            const tempPath = `${cachePath}.tmp`;
            try {
                await fsp.writeFile(tempPath, serialized, 'utf8');
                await fsp.rename(tempPath, cachePath);
            } catch (error) {
                try { await fsp.unlink(tempPath); } catch { /* no temp file */ }
                onPersistError(error);
            }
        });
        return persistQueue;
    }

    async function invalidate() {
        invalidationRevision++;
        if (!cached) return;
        cached = { ...cached, invalidated: true };
        await persist(cached);
    }

    function refresh(computeFresh) {
        if (closed) return Promise.reject(new Error('Storage stats service is closed'));
        if (inflightRefresh) return inflightRefresh;

        const refreshRevision = invalidationRevision;
        inflightRefresh = (async () => {
            const stats = await computeFresh();
            const entry = {
                version: CACHE_VERSION,
                computedAt: now(),
                invalidated: refreshRevision !== invalidationRevision,
                stats,
            };
            cached = entry;
            await persist(entry);
            return getCached();
        })().finally(() => {
            inflightRefresh = null;
        });

        return inflightRefresh;
    }

    async function close() {
        closed = true;
        rejectWorkerRequests(new Error('Storage stats service closed'));
        const activeWorker = worker;
        worker = null;
        if (activeWorker) await activeWorker.terminate();
    }

    return {
        getCached,
        refresh,
        invalidate,
        computeDatabaseStats,
        close,
    };
}

module.exports = {
    CACHE_VERSION,
    DEFAULT_TTL_MS,
    DEFAULT_MAX_STALE_MS,
    createStorageStatsService,
};
