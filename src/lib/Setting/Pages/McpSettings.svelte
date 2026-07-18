<script lang="ts">
    import {
        CheckIcon,
        ClockIcon,
        CopyIcon,
        KeyRoundIcon,
        LoaderCircleIcon,
        PlusIcon,
        ShieldCheckIcon,
        Trash2Icon,
        TriangleAlertIcon,
    } from "@lucide/svelte";
    import { getCurrentLocale, language } from "src/lang";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import ShAlert from "src/lib/UI/GUI/ShAlert.svelte";
    import ShBadge from "src/lib/UI/GUI/ShBadge.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import ShDialog from "src/lib/UI/GUI/ShDialog.svelte";
    import ShInput from "src/lib/UI/GUI/ShInput.svelte";
    import ShSelect from "src/lib/UI/GUI/ShSelect.svelte";
    import ShSwitch from "src/lib/UI/GUI/ShSwitch.svelte";
    import { alertConfirm, notifyError, notifySuccess } from "src/ts/alert";
    import { forageStorage } from "src/ts/globalApi.svelte";

    type McpScope = 'risu.read' | 'risu.write' | 'risu.admin';
    type McpToken = {
        id: string;
        name: string;
        tokenPrefix: string;
        scopes: McpScope[];
        createdAt: number;
        expiresAt: number | null;
        lastUsedAt: number | null;
        revokedAt: number | null;
    };

    let tokens = $state<McpToken[]>([]);
    let showRevokedTokens = $state(false);
    let visibleTokens = $derived(tokens.filter((token) => showRevokedTokens || token.revokedAt === null));
    let activeTokenCount = $derived(tokens.filter((token) => tokenStatus(token) === 'active').length);
    let expiredTokenCount = $derived(tokens.filter((token) => tokenStatus(token) === 'expired').length);
    let revokedTokenCount = $derived(tokens.filter((token) => tokenStatus(token) === 'revoked').length);
    let loading = $state(true);
    let loadError = $state(false);
    let configLoading = $state(true);
    let configSaving = $state(false);
    let mcpEnabled = $state(false);
    let requireAuth = $state(true);

    let createOpen = $state(false);
    let creating = $state(false);
    let createError = $state('');
    let tokenName = $state('');
    let expiryPreset = $state('90d');
    let customExpiry = $state('');
    let scopeRead = $state(true);
    let scopeWrite = $state(false);
    let scopeAdmin = $state(false);

    let createdToken = $state('');
    let createdTokenOpen = $state(false);
    let copied = $state(false);
    let mcpEndpoint = $state('/mcp');
    let endpointCopied = $state(false);

    async function authHeaders(includeJson = false) {
        const auth = await forageStorage.createAuth();
        return {
            'risu-auth': auth,
            ...(includeJson ? { 'Content-Type': 'application/json' } : {}),
        };
    }

    async function readError(response: Response, fallback: string) {
        const data = await response.json().catch(() => null);
        return typeof data?.error === 'string' ? data.error : fallback;
    }

    async function loadTokens() {
        loading = true;
        loadError = false;
        try {
            const response = await fetch('/api/mcp/tokens', {
                headers: await authHeaders(),
            });
            if (!response.ok) throw new Error(await readError(response, language.mcpTokenLoadFailed));
            const data = await response.json();
            tokens = Array.isArray(data.tokens) ? data.tokens : [];
        } catch (error) {
            loadError = true;
            notifyError(error);
        } finally {
            loading = false;
        }
    }

    async function loadConfig() {
        configLoading = true;
        try {
            const response = await fetch('/api/mcp/config', {
                headers: await authHeaders(),
            });
            if (!response.ok) throw new Error(await readError(response, language.mcpConfigLoadFailed));
            const data = await response.json();
            mcpEnabled = data.enabled === true;
            requireAuth = data.requireAuth !== false;
        } catch (error) {
            notifyError(error);
        } finally {
            configLoading = false;
        }
    }

    async function saveConfig(patch: { enabled?: boolean; requireAuth?: boolean }) {
        const previousEnabled = !('enabled' in patch) ? mcpEnabled : !patch.enabled;
        const previousRequireAuth = !('requireAuth' in patch) ? requireAuth : !patch.requireAuth;
        configSaving = true;
        try {
            const response = await fetch('/api/mcp/config', {
                method: 'PUT',
                headers: await authHeaders(true),
                body: JSON.stringify(patch),
            });
            if (!response.ok) throw new Error(await readError(response, language.mcpConfigSaveFailed));
            const data = await response.json();
            mcpEnabled = data.enabled === true;
            requireAuth = data.requireAuth !== false;
        } catch (error) {
            mcpEnabled = previousEnabled;
            requireAuth = previousRequireAuth;
            notifyError(error);
        } finally {
            configSaving = false;
        }
    }

    async function changeMcpEnabled(enabled: boolean) {
        await saveConfig({ enabled });
    }

    async function changeRequireAuth(enabled: boolean) {
        if (!enabled && !await alertConfirm(language.mcpDisableAuthConfirm)) {
            requireAuth = true;
            return;
        }
        await saveConfig({ requireAuth: enabled });
    }

    function toLocalDateTimeInput(timestamp: number) {
        const date = new Date(timestamp);
        const local = new Date(timestamp - date.getTimezoneOffset() * 60_000);
        return local.toISOString().slice(0, 16);
    }

    function openCreateDialog() {
        tokenName = '';
        expiryPreset = '90d';
        customExpiry = toLocalDateTimeInput(Date.now() + 90 * 24 * 60 * 60 * 1000);
        scopeRead = true;
        scopeWrite = false;
        scopeAdmin = false;
        createError = '';
        createOpen = true;
    }

    function selectedScopes(): McpScope[] {
        const scopes: McpScope[] = [];
        if (scopeRead) scopes.push('risu.read');
        if (scopeWrite) scopes.push('risu.write');
        if (scopeAdmin) scopes.push('risu.admin');
        return scopes;
    }

    function selectedExpiration(): number | null {
        const durations: Record<string, number> = {
            '7d': 7 * 24 * 60 * 60 * 1000,
            '30d': 30 * 24 * 60 * 60 * 1000,
            '90d': 90 * 24 * 60 * 60 * 1000,
            '1y': 365 * 24 * 60 * 60 * 1000,
        };
        if (expiryPreset === 'never') return null;
        if (expiryPreset === 'custom') {
            return customExpiry ? new Date(customExpiry).getTime() : Number.NaN;
        }
        return Date.now() + durations[expiryPreset];
    }

    async function createToken() {
        createError = '';
        const name = tokenName.trim();
        if (!name) {
            createError = language.mcpTokenNameRequired;
            return;
        }
        const scopes = selectedScopes();
        if (scopes.length === 0) {
            createError = language.mcpTokenScopeRequired;
            return;
        }
        const expiresAt = selectedExpiration();
        if (Number.isNaN(expiresAt)) {
            createError = language.mcpTokenExpiryRequired;
            return;
        }
        if (expiresAt !== null && expiresAt <= Date.now()) {
            createError = language.mcpTokenExpiryPast;
            return;
        }

        creating = true;
        try {
            const response = await fetch('/api/mcp/tokens', {
                method: 'POST',
                headers: await authHeaders(true),
                body: JSON.stringify({ name, scopes, expiresAt }),
            });
            if (!response.ok) throw new Error(await readError(response, language.mcpTokenCreateFailed));
            const data = await response.json();
            createdToken = data.token;
            copied = false;
            createOpen = false;
            createdTokenOpen = true;
            await loadTokens();
        } catch (error) {
            createError = error instanceof Error ? error.message : language.mcpTokenCreateFailed;
        } finally {
            creating = false;
        }
    }

    async function writeClipboard(value: string) {
        if (navigator.clipboard) {
            await navigator.clipboard.writeText(value);
            return;
        }
        const textarea = document.createElement('textarea');
        textarea.value = value;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
    }

    async function copyToken() {
        if (!createdToken) return;
        try {
            await writeClipboard(createdToken);
            copied = true;
            notifySuccess(language.mcpTokenCopied);
            setTimeout(() => { copied = false; }, 2000);
        } catch {
            notifyError(language.mcpTokenCopyFailed);
        }
    }

    async function copyEndpoint() {
        try {
            await writeClipboard(mcpEndpoint);
            endpointCopied = true;
            notifySuccess(language.mcpEndpointCopied);
            setTimeout(() => { endpointCopied = false; }, 2000);
        } catch {
            notifyError(language.mcpEndpointCopyFailed);
        }
    }

    function closeCreatedToken() {
        createdTokenOpen = false;
        createdToken = '';
        copied = false;
    }

    async function revokeToken(token: McpToken) {
        if (!await alertConfirm(language.mcpTokenRevokeConfirm(token.name))) return;
        try {
            const response = await fetch(`/api/mcp/tokens/${encodeURIComponent(token.id)}`, {
                method: 'DELETE',
                headers: await authHeaders(),
            });
            if (!response.ok) throw new Error(await readError(response, language.mcpTokenRevokeFailed));
            notifySuccess(language.mcpTokenRevokedSuccess);
            await loadTokens();
        } catch (error) {
            notifyError(error);
        }
    }

    function tokenStatus(token: McpToken): 'active' | 'expired' | 'revoked' {
        if (token.revokedAt !== null) return 'revoked';
        if (token.expiresAt !== null && token.expiresAt <= Date.now()) return 'expired';
        return 'active';
    }

    function formatDate(timestamp: number | null) {
        if (timestamp === null) return language.mcpTokenNever;
        return new Date(timestamp).toLocaleString(getCurrentLocale(), {
            dateStyle: 'medium',
            timeStyle: 'short',
        });
    }

    function scopeLabel(scope: McpScope) {
        if (scope === 'risu.read') return language.mcpScopeRead;
        if (scope === 'risu.write') return language.mcpScopeWrite;
        return language.mcpScopeAdmin;
    }

    $effect(() => {
        if (typeof window !== 'undefined') {
            mcpEndpoint = new URL('/mcp', window.location.origin).toString();
        }
        loadConfig();
        loadTokens();
    });
</script>

<SettingPage title={language.mcp}>
    <div class="flex flex-col gap-4">
        <p class="text-sm text-textcolor2 leading-relaxed">{language.mcpDesc}</p>

        <div class="flex flex-col divide-y divide-darkborderc rounded-lg border border-darkborderc bg-darkbg">
            <div class="flex items-center justify-between gap-3 p-4">
                <div class="flex min-w-0 flex-col gap-0.5">
                    <span class="font-medium text-textcolor">{language.mcpServerEnabled}</span>
                    <span class="text-xs text-textcolor2">{language.mcpServerEnabledDesc}</span>
                </div>
                <ShSwitch
                    bind:checked={mcpEnabled}
                    disabled={configLoading || configSaving}
                    onCheckedChange={changeMcpEnabled}
                />
            </div>
            <div class="flex items-center justify-between gap-3 p-4">
                <div class="flex min-w-0 flex-col gap-0.5">
                    <span class="font-medium text-textcolor">{language.mcpRequireAuth}</span>
                    <span class="text-xs text-textcolor2">{language.mcpRequireAuthDesc}</span>
                </div>
                <ShSwitch
                    bind:checked={requireAuth}
                    disabled={configLoading || configSaving}
                    onCheckedChange={changeRequireAuth}
                />
            </div>
        </div>

        {#if !requireAuth && !configLoading}
            <ShAlert variant="warning">
                {#snippet icon()}<TriangleAlertIcon />{/snippet}
                {language.mcpAuthDisabledWarning}
            </ShAlert>
        {/if}

        <div class="flex flex-col gap-2 rounded-lg border border-darkborderc bg-darkbg p-4">
            <div class="flex flex-col gap-0.5">
                <span class="font-medium text-textcolor">{language.mcpEndpoint}</span>
                <span class="text-xs text-textcolor2">{language.mcpEndpointDesc}</span>
            </div>
            <div class="flex items-center gap-2">
                <ShInput value={mcpEndpoint} readonly className="font-mono text-sm select-all" />
                <ShButton size="icon" onclick={copyEndpoint} aria-label={language.mcpCopyEndpoint} title={language.mcpCopyEndpoint}>
                    {#if endpointCopied}<CheckIcon size={17} />{:else}<CopyIcon size={17} />{/if}
                </ShButton>
            </div>
        </div>

        <div class="flex items-center justify-between gap-3">
            <div class="flex flex-col gap-0.5">
                <h3 class="font-semibold text-textcolor">{language.mcpAccessTokens}</h3>
                <p class="text-xs text-textcolor2">{language.mcpAccessTokensDesc}</p>
            </div>
            <ShButton variant="primary" size="sm" onclick={openCreateDialog}>
                <PlusIcon size={15} />
                {language.mcpCreateToken}
            </ShButton>
        </div>

        <div class="flex items-center justify-between gap-3 rounded-lg border border-darkborderc bg-darkbg px-3 py-2.5">
            <span class="text-xs text-textcolor2">
                {language.mcpTokenCounts(activeTokenCount, expiredTokenCount, revokedTokenCount)}
            </span>
            <label class="flex cursor-pointer items-center gap-2 text-sm text-textcolor">
                <span>{language.mcpShowRevokedTokens}</span>
                <ShSwitch bind:checked={showRevokedTokens} size="sm" />
            </label>
        </div>

        {#if loading}
            <div class="flex items-center justify-center py-10 text-textcolor2">
                <LoaderCircleIcon class="animate-spin" size={26} />
            </div>
        {:else if loadError}
            <ShAlert variant="destructive">
                {#snippet icon()}<TriangleAlertIcon />{/snippet}
                {#snippet title()}{language.mcpTokenLoadFailed}{/snippet}
                {#snippet action()}
                    <ShButton variant="outline" size="sm" onclick={loadTokens}>{language.mcpRetry}</ShButton>
                {/snippet}
            </ShAlert>
        {:else if tokens.length === 0}
            <div class="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-darkborderc bg-darkbg/40 px-4 py-10 text-center">
                <KeyRoundIcon class="text-textcolor2" size={28} />
                <p class="text-sm font-medium text-textcolor">{language.mcpNoTokens}</p>
                <p class="text-xs text-textcolor2">{language.mcpNoTokensDesc}</p>
            </div>
        {:else if visibleTokens.length === 0}
            <div class="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-darkborderc bg-darkbg/40 px-4 py-10 text-center">
                <KeyRoundIcon class="text-textcolor2" size={28} />
                <p class="text-sm font-medium text-textcolor">{language.mcpNoActiveTokens}</p>
                <p class="text-xs text-textcolor2">{language.mcpNoActiveTokensDesc}</p>
            </div>
        {:else}
            <div class="flex flex-col gap-3">
                {#each visibleTokens as token (token.id)}
                    {@const status = tokenStatus(token)}
                    <div class="rounded-lg border border-darkborderc bg-darkbg p-4">
                        <div class="flex items-start justify-between gap-3">
                            <div class="min-w-0 flex-1">
                                <div class="flex flex-wrap items-center gap-2">
                                    <span class="font-medium text-textcolor truncate">{token.name}</span>
                                    {#if status === 'active'}
                                        <ShBadge variant="success">{language.mcpTokenActive}</ShBadge>
                                    {:else if status === 'expired'}
                                        <ShBadge variant="warning">{language.mcpTokenExpired}</ShBadge>
                                    {:else}
                                        <ShBadge variant="destructive">{language.mcpTokenRevoked}</ShBadge>
                                    {/if}
                                </div>
                                <code class="mt-1 block text-xs text-textcolor2 break-all">{token.tokenPrefix}••••••••</code>
                            </div>
                            {#if status === 'active'}
                                <ShButton
                                    variant="destructive"
                                    size="icon-sm"
                                    onclick={() => revokeToken(token)}
                                    aria-label={language.mcpRevokeToken}
                                    title={language.mcpRevokeToken}
                                >
                                    <Trash2Icon size={15} />
                                </ShButton>
                            {/if}
                        </div>

                        <div class="mt-3 flex flex-wrap gap-1.5">
                            {#each token.scopes as scope}
                                <ShBadge variant="outline">{scopeLabel(scope)}</ShBadge>
                            {/each}
                        </div>

                        <div class="mt-3 grid gap-1.5 text-xs text-textcolor2 sm:grid-cols-2">
                            <div class="flex items-center gap-1.5">
                                <ClockIcon size={13} />
                                <span>{language.mcpTokenCreatedAt}: {formatDate(token.createdAt)}</span>
                            </div>
                            <div class="flex items-center gap-1.5">
                                <ClockIcon size={13} />
                                <span>{language.mcpTokenExpiresAt}: {formatDate(token.expiresAt)}</span>
                            </div>
                            <div class="flex items-center gap-1.5 sm:col-span-2">
                                <ShieldCheckIcon size={13} />
                                <span>
                                    {language.mcpTokenLastUsed}:
                                    {token.lastUsedAt === null ? language.mcpTokenNeverUsed : formatDate(token.lastUsedAt)}
                                </span>
                            </div>
                        </div>
                    </div>
                {/each}
            </div>
        {/if}
    </div>
</SettingPage>

<ShDialog bind:open={createOpen} size="lg" tier="base">
    {#snippet title()}{language.mcpCreateToken}{/snippet}
    {#snippet description()}{language.mcpCreateTokenDesc}{/snippet}

    <div class="flex flex-col gap-4">
        <label class="flex flex-col gap-1.5">
            <span class="text-sm font-medium text-textcolor">{language.mcpTokenName}</span>
            <ShInput
                bind:value={tokenName}
                maxlength={80}
                autocomplete="off"
                placeholder={language.mcpTokenNamePlaceholder}
            />
        </label>

        <div class="flex flex-col gap-2">
            <span class="text-sm font-medium text-textcolor">{language.mcpTokenScopes}</span>
            <div class="flex flex-col divide-y divide-darkborderc rounded-md border border-darkborderc">
                <label class="flex items-center justify-between gap-3 p-3">
                    <span class="flex min-w-0 flex-col">
                        <span class="text-sm text-textcolor">{language.mcpScopeRead}</span>
                        <span class="text-xs text-textcolor2">{language.mcpScopeReadDesc}</span>
                    </span>
                    <ShSwitch bind:checked={scopeRead} />
                </label>
                <label class="flex items-center justify-between gap-3 p-3">
                    <span class="flex min-w-0 flex-col">
                        <span class="text-sm text-textcolor">{language.mcpScopeWrite}</span>
                        <span class="text-xs text-textcolor2">{language.mcpScopeWriteDesc}</span>
                    </span>
                    <ShSwitch bind:checked={scopeWrite} />
                </label>
                <label class="flex items-center justify-between gap-3 p-3">
                    <span class="flex min-w-0 flex-col">
                        <span class="text-sm text-textcolor">{language.mcpScopeAdmin}</span>
                        <span class="text-xs text-textcolor2">{language.mcpScopeAdminDesc}</span>
                    </span>
                    <ShSwitch bind:checked={scopeAdmin} />
                </label>
            </div>
        </div>

        <label class="flex flex-col gap-1.5">
            <span class="text-sm font-medium text-textcolor">{language.mcpTokenExpiration}</span>
            <ShSelect bind:value={expiryPreset}>
                <OptionInput value="7d">{language.mcpExpiry7d}</OptionInput>
                <OptionInput value="30d">{language.mcpExpiry30d}</OptionInput>
                <OptionInput value="90d">{language.mcpExpiry90d}</OptionInput>
                <OptionInput value="1y">{language.mcpExpiry1y}</OptionInput>
                <OptionInput value="custom">{language.mcpExpiryCustom}</OptionInput>
                <OptionInput value="never">{language.mcpExpiryNever}</OptionInput>
            </ShSelect>
        </label>

        {#if expiryPreset === 'custom'}
            <label class="flex flex-col gap-1.5">
                <span class="text-sm font-medium text-textcolor">{language.mcpExpiryCustomDate}</span>
                <ShInput
                    type="datetime-local"
                    bind:value={customExpiry}
                    min={toLocalDateTimeInput(Date.now() + 60_000)}
                />
            </label>
        {:else if expiryPreset === 'never'}
            <ShAlert variant="warning">
                {#snippet icon()}<TriangleAlertIcon />{/snippet}
                {language.mcpExpiryNeverWarning}
            </ShAlert>
        {/if}

        {#if createError}
            <ShAlert variant="destructive">
                {#snippet icon()}<TriangleAlertIcon />{/snippet}
                {createError}
            </ShAlert>
        {/if}
    </div>

    {#snippet footer()}
        <ShButton variant="outline" onclick={() => (createOpen = false)} disabled={creating}>
            {language.cancel}
        </ShButton>
        <ShButton variant="primary" onclick={createToken} disabled={creating}>
            {#if creating}<LoaderCircleIcon class="animate-spin" size={15} />{/if}
            {language.mcpCreateToken}
        </ShButton>
    {/snippet}
</ShDialog>

<ShDialog
    open={createdTokenOpen}
    onOpenChange={(open) => { if (!open) closeCreatedToken(); }}
    closable={false}
    closeOnEscape={false}
    closeOnOutsideClick={false}
>
    {#snippet title()}{language.mcpTokenCreated}{/snippet}
    {#snippet description()}{language.mcpTokenCreatedDesc}{/snippet}

    <ShAlert variant="warning" className="mb-3">
        {#snippet icon()}<TriangleAlertIcon />{/snippet}
        {language.mcpTokenShownOnce}
    </ShAlert>

    <div class="flex items-center gap-2">
        <ShInput value={createdToken} readonly className="font-mono text-sm select-all" />
        <ShButton size="icon" onclick={copyToken} aria-label={language.mcpCopyToken}>
            {#if copied}<CheckIcon size={17} />{:else}<CopyIcon size={17} />{/if}
        </ShButton>
    </div>

    {#snippet footer()}
        <ShButton variant="primary" onclick={closeCreatedToken}>{language.confirm}</ShButton>
    {/snippet}
</ShDialog>
