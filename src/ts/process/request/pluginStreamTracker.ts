export type PluginStreamOutcome = 'done' | 'failed' | 'aborted'

export interface PluginStreamTrackerOptions {
    signal?: AbortSignal
    onChunk?: (chunk: string) => void
    onFinish?: (outcome: PluginStreamOutcome, error?: unknown) => void
}

// Converts a plugin provider's text stream into the accumulated snapshots used
// by the classic chat renderer while exposing a harmless request-status side
// channel. Keeping the stream lifecycle here makes completion, source errors,
// and consumer cancellation deterministic and independently testable.
export function trackPluginProviderStream(
    source: ReadableStream<string>,
    options: PluginStreamTrackerOptions = {},
): ReadableStream<{ [key: string]: string }> {
    const reader = source.getReader()
    let fullText = ''
    let finished = false

    const finish = (outcome: PluginStreamOutcome, error?: unknown) => {
        if (finished) return
        finished = true
        options.onFinish?.(outcome, error)
    }

    const release = () => {
        try { reader.releaseLock() } catch { /* already released */ }
    }

    return new ReadableStream<{ [key: string]: string }>({
        async pull(controller) {
            try {
                const { done, value } = await reader.read()
                if (done) {
                    finish('done')
                    controller.close()
                    release()
                    return
                }
                const chunk = String(value ?? '')
                fullText += chunk
                options.onChunk?.(chunk)
                controller.enqueue({ "0": fullText })
            } catch (error) {
                finish(options.signal?.aborted ? 'aborted' : 'failed', error)
                controller.error(error)
                release()
            }
        },
        async cancel(reason) {
            finish('aborted')
            try { await reader.cancel(reason) } finally { release() }
        },
    })
}
