<script lang="ts">
	import { requestChatData } from "src/ts/process/request/request";
    import { doingChat, type OpenAIChat } from "../../ts/process/index.svelte";
	import { type character, type Message, type Chat } from "../../ts/storage/database.svelte";
	import { DBState } from 'src/ts/stores.svelte';
    import { selectedCharID } from "../../ts/stores.svelte";
	import { RefreshCcwIcon } from "@lucide/svelte";
    import { alertConfirm } from "src/ts/alert";
    import { language } from "src/lang";
    import { getUserName, replacePlaceholders } from "../../ts/util";
    import { onDestroy, tick } from 'svelte';
    import { get } from 'svelte/store';
    import { ParseMarkdown } from "src/ts/parser/parser.svelte";
    import {defaultAutoSuggestPrompt} from "../../ts/storage/defaultPrompts.js";
    import {
        getAutoSuggestionContextMessages,
        hashAutoSuggestionSource,
        normalizeAutoSuggestionCount,
        normalizeAutoSuggestionMessageCount,
        parseAutoSuggestions,
        resolveAutoSuggestionLanguage,
    } from '../../ts/process/autoSuggestion';
    import { legacyDefaultAutoSuggestPrompt } from '../../ts/storage/defaultPrompts';

    interface Props {
        messageInput: (string:string) => any;
        generationSignal?: {
            token: number;
            success: boolean;
            characterId: string;
            chatId?: string;
            chatPage: number;
        } | null;
    }

	let { messageInput, generationSignal = null }: Props = $props();
    let suggestMessages:string[] = $state([])
    let progress:boolean = $state();
    let errorMessage = $state('')
    let formatWarning = $state(false)
    let abortController:AbortController | undefined;
    let requestSerial = 0
    let observedTargetKey = ''
    let observedSourceKey = ''
    let handledGenerationToken = 0
    let destroyed = false

    type SuggestionTarget = {
        characterIndex: number;
        chatPage: number;
        character: character;
        chat: Chat;
        targetKey: string;
    }

    function getCurrentTarget(): SuggestionTarget | null {
        const characterIndex = $selectedCharID
        if(characterIndex < 0) return null
        const currentCharacter = DBState.db.characters[characterIndex]
        if(!currentCharacter) return null
        const chatPage = currentCharacter.chatPage
        const chat = currentCharacter.chats?.[chatPage]
        if(!chat || chat._placeholder) return null
        return {
            characterIndex,
            chatPage,
            character: currentCharacter,
            chat,
            targetKey: `${currentCharacter.chaId}:${chat.id ?? `page-${chatPage}`}`,
        }
    }

    function normalizedMessageCount(): number {
        return normalizeAutoSuggestionMessageCount(DBState.db.autoSuggestMessageCount)
    }

    function configuredPrompt(): string {
        const value = DBState.db.useGlobalAutoSuggestPrompt
            ? DBState.db.globalAutoSuggestPrompt
            : DBState.db.autoSuggestPrompt
        if(!value?.trim()) return defaultAutoSuggestPrompt
        return value.replace(/\r\n/g, '\n').trim() === legacyDefaultAutoSuggestPrompt.trim()
            ? defaultAutoSuggestPrompt
            : value
    }

    function suggestionCount(): number {
        return normalizeAutoSuggestionCount(DBState.db.autoSuggestCount)
    }

    function resolvedLanguage(): string {
        return resolveAutoSuggestionLanguage(
            DBState.db.autoSuggestLanguage,
            DBState.db.autoSuggestCustomLanguage,
            DBState.db.language,
        )
    }

    function resolvedPrompt(): string {
        const count = suggestionCount()
        return configuredPrompt()
            .replaceAll('{{suggestion_count}}', String(count))
            + `\n\nGenerate exactly ${count} suggestions. Return every suggestion in ${resolvedLanguage()}. These instructions take precedence over conflicting count or output-language instructions above.`
    }

    function sanitizeFailureReason(reason: unknown): string {
        const raw = typeof reason === 'string' ? reason : ''
        if(!raw.trim()) return language.autoSuggestFailed
        return raw
            .replace(/(?:bearer\s+)[^\s,;]+/gi, 'Bearer [redacted]')
            .replace(/\bsk-[a-z0-9_-]{8,}\b/gi, '[redacted]')
            .replace(/([?&](?:key|token|api_key)=)[^&\s]+/gi, '$1[redacted]')
            .replace(/https?:\/\/[^\s]+/gi, '[URL]')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 240)
    }

    function contextMessages(target: SuggestionTarget, messageCount: number): Message[] {
        return getAutoSuggestionContextMessages(target.character, target.chat, messageCount)
    }

    function sourceKey(target: SuggestionTarget, messages: Message[], prompt: string, messageCount: number): string {
        return hashAutoSuggestionSource(JSON.stringify({
            target: target.targetKey,
            characterName: target.character.name,
            userName: getUserName(),
            prompt,
            messageCount,
            subModel: DBState.db.subModel,
            modelBinding: target.chat.useModelPreset ? target.chat.modelBinding : undefined,
            messages: messages.map(({ role, data, saying, chatId, disabled, isComment }) => ({
                role, data, saying, chatId, disabled, isComment,
            })),
        }))
    }

    function isEligibleForAutomaticGeneration(target: SuggestionTarget, messages: Message[]): boolean {
        if(messages.length === 0) return false
        if(target.chat.message.length === 0) return true
        return messages[messages.length - 1].role === 'char'
    }

    function isStillAttached(target: SuggestionTarget): boolean {
        const currentCharacter = DBState.db.characters[target.characterIndex]
        if(!currentCharacter || currentCharacter.chaId !== target.character.chaId) return false
        const currentChat = currentCharacter.chats?.[target.chatPage]
        if(!currentChat) return false
        return target.chat.id ? currentChat.id === target.chat.id : currentChat === target.chat
    }

    function isCurrentTarget(target: SuggestionTarget): boolean {
        const current = getCurrentTarget()
        return current?.targetKey === target.targetKey
    }

    function cancelSuggestionRequest() {
        requestSerial += 1
        abortController?.abort()
        abortController = undefined
        progress = false
    }

    function invalidateTarget(target: SuggestionTarget) {
        cancelSuggestionRequest()
        target.chat.suggestMessages = []
        target.chat.suggestMessagesCacheKey = undefined
        target.chat.suggestMessagesCacheStatus = undefined
        if(isCurrentTarget(target)) suggestMessages = []
        errorMessage = ''
        formatWarning = false
    }

    async function generateSuggestions(force = false) {
        if(destroyed || get(doingChat)) return
        const target = getCurrentTarget()
        if(!target) return

        const messageCount = normalizedMessageCount()
        const messages = contextMessages(target, messageCount)
        if(messages.length === 0) {
            invalidateTarget(target)
            return
        }
        if(!force && !isEligibleForAutomaticGeneration(target, messages)) return

        const prompt = resolvedPrompt()
        const cacheKey = sourceKey(target, messages, prompt, messageCount)
        if(!force && target.chat.suggestMessagesCacheKey === cacheKey){
            if(isCurrentTarget(target)) suggestMessages = target.chat.suggestMessages ?? []
            formatWarning = target.chat.suggestMessagesCacheStatus === 'format'
            errorMessage = ''
            return
        }

        cancelSuggestionRequest()
        const serial = ++requestSerial
        const controller = new AbortController()
        abortController = controller
        progress = true
        errorMessage = ''
        formatWarning = false

        let promptbody:OpenAIChat[] = [
            {
                role:'system',
                content: replacePlaceholders(prompt, target.character.name)
            }
            ,{
                role: 'user', 
                content: messages.map(b=>(b.role==='char'? target.character.name : getUserName())+":"+b.data).reduce((a,b)=>a+','+b)
            }
        ]

        if(DBState.db.subModel === "textgen_webui" || DBState.db.subModel === 'mancer' || DBState.db.subModel.startsWith('local_')){
            promptbody = [
                {
                    role: 'system',
                    content: replacePlaceholders(prompt, target.character.name)
                },
                ...messages.map(({ role, data }) => ({
                    role: role === "user" ? "user" as const : "assistant" as const,
                    content: data,
                })),
            ]
        }

        try {
            const response = await requestChatData({
                formated: promptbody,
                bias: {},
                currentChar: target.character,
            }, 'submodel', controller.signal)

            if(destroyed || controller.signal.aborted || serial !== requestSerial || !isStillAttached(target)) return
            if(response.type === 'fail'){
                if(isCurrentTarget(target)) errorMessage = sanitizeFailureReason(response.result)
                return
            }
            if(response.type !== 'streaming' && response.type !== 'multiline'){
                const newSuggestions = parseAutoSuggestions(response.result, suggestionCount())
                target.chat.suggestMessages = newSuggestions
                target.chat.suggestMessagesCacheKey = cacheKey
                target.chat.suggestMessagesCacheStatus = newSuggestions.length ? 'success' : 'format'
                if(isCurrentTarget(target)){
                    suggestMessages = newSuggestions
                    formatWarning = newSuggestions.length === 0
                }
            }
            else if(isCurrentTarget(target)){
                errorMessage = ''
                formatWarning = true
            }
        }
        catch(error){
            if(!controller.signal.aborted && serial === requestSerial && isStillAttached(target) && isCurrentTarget(target)){
                errorMessage = sanitizeFailureReason(error instanceof Error ? error.message : error)
            }
        }
        finally {
            if(serial === requestSerial){
                progress = false
                abortController = undefined
            }
        }
    }

    const unsub = doingChat.subscribe((value) => {
        if(value) cancelSuggestionRequest()
    })

    onDestroy(() => {
        destroyed = true
        cancelSuggestionRequest()
        unsub()
    })

    $effect(() => {
        const target = getCurrentTarget()
        if(!target){
            observedTargetKey = ''
            observedSourceKey = ''
            suggestMessages = []
            errorMessage = ''
            formatWarning = false
            return
        }

        const messageCount = normalizedMessageCount()
        const messages = contextMessages(target, messageCount)
        const prompt = resolvedPrompt()
        const nextSourceKey = sourceKey(target, messages, prompt, messageCount)
        const targetChanged = target.targetKey !== observedTargetKey
        const sourceChanged = nextSourceKey !== observedSourceKey
        observedTargetKey = target.targetKey
        observedSourceKey = nextSourceKey

        if(targetChanged || sourceChanged){
            cancelSuggestionRequest()
        }

        if(target.chat.suggestMessagesCacheKey === nextSourceKey){
            suggestMessages = target.chat.suggestMessages ?? []
            formatWarning = target.chat.suggestMessagesCacheStatus === 'format'
            errorMessage = ''
            return
        }

        if(sourceChanged){
            target.chat.suggestMessages = []
            target.chat.suggestMessagesCacheKey = undefined
            target.chat.suggestMessagesCacheStatus = undefined
            suggestMessages = []
            errorMessage = ''
            formatWarning = false
        }

        if(targetChanged && !get(doingChat) && isEligibleForAutomaticGeneration(target, messages)){
            void generateSuggestions()
        }
    })

    $effect(() => {
        const signal = generationSignal
        if(!signal || signal.token === handledGenerationToken) return
        handledGenerationToken = signal.token
        void (async () => {
            await tick()
            if(destroyed || generationSignal?.token !== signal.token) return
            const target = getCurrentTarget()
            if(!target) return
            const signalMatchesTarget = signal.characterId === target.character.chaId
                && (signal.chatId ? signal.chatId === target.chat.id : signal.chatPage === target.chatPage)
            if(!signalMatchesTarget) return

            if(signal.success){
                await generateSuggestions()
            }
            else{
                invalidateTarget(target)
            }
        })()
    })
</script>

<section class="overflow-hidden rounded-2xl border border-darkborderc bg-darkbg/60 text-textcolor shadow-xs">
    <div class="flex min-h-11 items-center justify-between gap-2 px-3 py-1.5">
        <span class="text-sm font-medium">{language.autoSuggest}</span>
        <button
            type="button"
            class="flex size-8 shrink-0 items-center justify-center rounded-full text-textcolor2 transition-colors hover:bg-primary/15 hover:text-textcolor focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
            class:cursor-not-allowed={$doingChat || progress}
            class:opacity-50={$doingChat || progress}
            disabled={$doingChat || progress}
            aria-label={language.askReRollAutoSuggestions}
            title={language.askReRollAutoSuggestions}
            onclick={() => {
                alertConfirm(language.askReRollAutoSuggestions).then((result) => {
                    if(result) {
                        void generateSuggestions(true)
                    }
                })
            }}
        >
            <RefreshCcwIcon size={18}/>
        </button>
    </div>

    {#if progress}
        <div class="flex min-h-14 items-center gap-3 border-t border-darkborderc px-4 py-3 text-sm text-textcolor2">
            <div class="loadmove"></div>
            <div>{language.creatingSuggestions}</div>
        </div>
    {:else if errorMessage}
        <div class="border-t border-darkborderc px-4 py-3 text-sm leading-5 text-red-500">
            {language.autoSuggestFailed}{errorMessage === language.autoSuggestFailed ? '' : `: ${errorMessage}`}
        </div>
    {:else if formatWarning}
        <div class="border-t border-darkborderc px-4 py-3 text-sm leading-5 text-textcolor2">
            {language.autoSuggestFormatMismatch}
        </div>
    {:else if !$doingChat}
        {#each suggestMessages??[] as suggest}
            <button
                type="button"
                class="suggestion-row block w-full border-t border-darkborderc px-4 py-3 text-left text-sm font-normal leading-6 text-textcolor transition-colors hover:bg-primary/10 focus-visible:relative focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50"
                aria-label={`${suggest}`}
                onclick={() => {
                    messageInput(suggest)
                }}
            >
                {#await ParseMarkdown(suggest) then md}
                    {@html md}
                {/await}
            </button>
        {/each}
    {/if}
</section>

<style>
    .suggestion-row :global(p) {
        margin: 0;
    }

    .suggestion-row :global(mark) {
        background: transparent;
        color: inherit;
    }
    
    .loadmove {
        animation: spin 1s linear infinite;
        border-radius: 50%;
        border: 0.4rem solid rgba(0,0,0,0);
        width: 1rem;
        height: 1rem;
        border-top: 0.4rem solid var(--risu-theme-textcolor);
        border-left: 0.4rem solid var(--risu-theme-textcolor);
    }

    @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
    }
</style>

