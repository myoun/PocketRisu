import { describe, expect, test, vi } from 'vitest'
import { trackPluginProviderStream } from './pluginStreamTracker'

describe('trackPluginProviderStream', () => {
    test('reports every chunk and completes after emitting accumulated snapshots', async () => {
        const onChunk = vi.fn()
        const onFinish = vi.fn()
        const source = new ReadableStream<string>({
            start(controller) {
                controller.enqueue('a')
                controller.enqueue('b')
                controller.close()
            },
        })

        const chunks: Array<{ [key: string]: string }> = []
        for await (const chunk of trackPluginProviderStream(source, { onChunk, onFinish })) chunks.push(chunk)

        expect(chunks).toEqual([{ '0': 'a' }, { '0': 'ab' }])
        expect(onChunk.mock.calls).toEqual([['a'], ['b']])
        expect(onFinish).toHaveBeenCalledTimes(1)
        expect(onFinish).toHaveBeenCalledWith('done', undefined)
    })

    test('reports a source error as failed and preserves the stream error', async () => {
        const onFinish = vi.fn()
        const boom = new Error('boom')
        const source = new ReadableStream<string>({
            start(controller) { controller.error(boom) },
        })

        const reader = trackPluginProviderStream(source, { onFinish }).getReader()
        await expect(reader.read()).rejects.toBe(boom)
        expect(onFinish).toHaveBeenCalledTimes(1)
        expect(onFinish).toHaveBeenCalledWith('failed', boom)
    })

    test('reports consumer cancellation as aborted exactly once', async () => {
        const onFinish = vi.fn()
        const cancel = vi.fn()
        const source = new ReadableStream<string>({ cancel })
        const tracked = trackPluginProviderStream(source, { onFinish })

        await tracked.cancel('stop')

        expect(cancel).toHaveBeenCalledWith('stop')
        expect(onFinish).toHaveBeenCalledTimes(1)
        expect(onFinish).toHaveBeenCalledWith('aborted', undefined)
    })

    test('classifies a source error after abort as aborted', async () => {
        const abortController = new AbortController()
        const onFinish = vi.fn()
        let fail!: (error: Error) => void
        const source = new ReadableStream<string>({
            start(controller) { fail = (error) => controller.error(error) },
        })
        const reader = trackPluginProviderStream(source, { signal: abortController.signal, onFinish }).getReader()
        abortController.abort()
        const boom = new Error('aborted source')
        fail(boom)

        await expect(reader.read()).rejects.toBe(boom)
        expect(onFinish).toHaveBeenCalledWith('aborted', boom)
    })
})
