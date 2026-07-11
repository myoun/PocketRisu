//@name codex-manager
//@display-name Codex Manager
//@api 3.0
//@version 0.8.0

// Codex Manager deliberately owns OAuth accounts only. Model registration,
// request serialization, streaming, and tool execution live in PocketRisu's
// `codex-responses` model-preset adapter.
(async () => {
  const ISSUER = "https://auth.openai.com";
  const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
  const DEVICE_AUTH_START_URL = `${ISSUER}/api/accounts/deviceauth/usercode`;
  const DEVICE_AUTH_POLL_URL = `${ISSUER}/api/accounts/deviceauth/token`;
  const OAUTH_TOKEN_URL = `${ISSUER}/oauth/token`;
  const DEVICE_REDIRECT_URI = `${ISSUER}/deviceauth/callback`;

  const ACCOUNTS_KEY = "codex_manager.accounts";
  const ACTIVE_ACCOUNT_KEY = "codex_manager.active_account_id";
  const PENDING_LOGIN_KEY = "codex_manager.pending_login";

  function nowMs() { return Date.now(); }

  function trimmed(value, fallback = "") {
    return typeof value === "string" && value.trim() ? value.trim() : fallback;
  }

  function localId(prefix = "acct") {
    if (typeof crypto?.randomUUID === "function") return `${prefix}_${crypto.randomUUID()}`;
    return `${prefix}_${nowMs()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function decodeBase64UrlJson(value) {
    if (typeof value !== "string") return null;
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    try { return JSON.parse(atob(padded)); } catch (_error) { return null; }
  }

  function accountIdFromToken(token) {
    if (typeof token !== "string" || token.split(".").length !== 3) return null;
    const claims = decodeBase64UrlJson(token.split(".")[1]);
    if (!claims || typeof claims !== "object") return null;
    if (typeof claims.chatgpt_account_id === "string" && claims.chatgpt_account_id.trim()) {
      return claims.chatgpt_account_id.trim();
    }
    const openAiAuth = claims["https://api.openai.com/auth"];
    if (openAiAuth && typeof openAiAuth.chatgpt_account_id === "string" && openAiAuth.chatgpt_account_id.trim()) {
      return openAiAuth.chatgpt_account_id.trim();
    }
    const firstOrganization = Array.isArray(claims.organizations) ? claims.organizations[0] : null;
    return typeof firstOrganization?.id === "string" && firstOrganization.id.trim() ? firstOrganization.id.trim() : null;
  }

  function accountIdFromTokens(tokens) {
    return accountIdFromToken(tokens?.id_token) || accountIdFromToken(tokens?.access_token);
  }

  function normalizeAccount(raw, index = 0) {
    if (!raw || typeof raw !== "object") return null;
    const accountId = trimmed(raw.account_id, "") || null;
    return {
      id: trimmed(raw.id, localId()),
      label: trimmed(raw.label, accountId || `Account ${index + 1}`),
      provider: "openai",
      auth_type: "oauth",
      access_token: trimmed(raw.access_token),
      refresh_token: trimmed(raw.refresh_token),
      id_token: trimmed(raw.id_token) || null,
      expires_at: Number.isFinite(Number(raw.expires_at)) ? Number(raw.expires_at) : null,
      account_id: accountId,
      created_at: Number.isFinite(Number(raw.created_at)) ? Number(raw.created_at) : nowMs(),
      updated_at: Number.isFinite(Number(raw.updated_at)) ? Number(raw.updated_at) : nowMs(),
    };
  }

  function normalizeAccounts(raw) {
    const accounts = [];
    const seen = new Set();
    for (const [index, value] of (Array.isArray(raw?.accounts) ? raw.accounts : []).entries()) {
      const account = normalizeAccount(value, index);
      if (!account || seen.has(account.id)) continue;
      seen.add(account.id);
      accounts.push(account);
    }
    return accounts;
  }

  async function saveAccounts(accounts, activeAccountId) {
    const normalized = normalizeAccounts({ accounts });
    const active = normalized.some((account) => account.id === activeAccountId)
      ? activeAccountId
      : normalized[0]?.id || null;
    await Risuai.pluginStorage.setItem(ACCOUNTS_KEY, { version: 2, accounts: normalized });
    if (active) await Risuai.pluginStorage.setItem(ACTIVE_ACCOUNT_KEY, active);
    else await Risuai.pluginStorage.removeItem(ACTIVE_ACCOUNT_KEY);
    return { accounts: normalized, activeAccountId: active };
  }

  async function loadState() {
    const raw = await Risuai.pluginStorage.getItem(ACCOUNTS_KEY);
    const accounts = normalizeAccounts(raw || {});
    const requested = trimmed(await Risuai.pluginStorage.getItem(ACTIVE_ACCOUNT_KEY), "") || null;
    const active = accounts.some((account) => account.id === requested) ? requested : accounts[0]?.id || null;
    if (!raw || requested !== active) return saveAccounts(accounts, active);
    return { accounts, activeAccountId: active };
  }

  async function activeAccount() {
    const state = await loadState();
    return state.accounts.find((account) => account.id === state.activeAccountId) || null;
  }

  async function saveAccount(account, makeActive = true) {
    const state = await loadState();
    const normalized = normalizeAccount(account, state.accounts.length);
    if (!normalized) throw new Error("계정 정보를 저장할 수 없습니다.");
    const accounts = state.accounts.filter((current) => current.id !== normalized.id);
    accounts.push(normalized);
    await saveAccounts(accounts, makeActive ? normalized.id : state.activeAccountId);
    return normalized;
  }

  async function requestTokens(payload, fallbackMessage) {
    const json = await Risuai.nativeFetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      forceProxy: true,
    });
    const jsonText = await json.text();
    let jsonPayload = null;
    try { jsonPayload = jsonText ? JSON.parse(jsonText) : null; } catch (_error) {}
    if (json.ok) return jsonPayload || {};

    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(payload)) {
      if (value != null) form.set(key, String(value));
    }
    const formResponse = await Risuai.nativeFetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      forceProxy: true,
    });
    const formText = await formResponse.text();
    let formPayload = null;
    try { formPayload = formText ? JSON.parse(formText) : null; } catch (_error) {}
    if (!formResponse.ok) {
      throw new Error(formPayload?.error_description || formPayload?.error?.message || formText || jsonPayload?.error_description || fallbackMessage);
    }
    return formPayload || {};
  }

  function accountFromTokens(tokens, previous = {}, fallbackLabel = "Account") {
    const accountId = accountIdFromTokens(tokens) || previous.account_id || null;
    return normalizeAccount({
      ...previous,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || previous.refresh_token,
      id_token: tokens.id_token || previous.id_token,
      expires_at: nowMs() + (Math.max(Number(tokens.expires_in) || 3600, 60) * 1000),
      account_id: accountId,
      label: previous.label || accountId || fallbackLabel,
      updated_at: nowMs(),
    }) || null;
  }

  async function refreshAccount(account) {
    if (!account?.refresh_token) throw new Error("토큰이 만료되었습니다. Codex Manager에서 다시 로그인하세요.");
    const tokens = await requestTokens({
      grant_type: "refresh_token",
      refresh_token: account.refresh_token,
      client_id: CLIENT_ID,
    }, "Codex 토큰 갱신에 실패했습니다.");
    const refreshed = accountFromTokens(tokens, account, account.label);
    if (!refreshed) throw new Error("갱신된 계정 정보를 읽을 수 없습니다.");
    await saveAccount(refreshed, account.id === (await loadState()).activeAccountId);
    return refreshed;
  }

  async function ensureActiveSession() {
    let account = await activeAccount();
    if (!account) throw new Error("저장된 Codex 계정이 없습니다. Codex Manager에서 로그인하세요.");
    if (!account.access_token || !account.account_id || (account.expires_at && account.expires_at <= nowMs() + 60_000)) {
      account = await refreshAccount(account);
    }
    if (!account.access_token || !account.account_id) throw new Error("Codex 세션에 access token 또는 ChatGPT account id가 없습니다.");
    // Never return refresh_token/id_token: the caller only gets the token needed
    // for the imminent model request.
    return { accessToken: account.access_token, accountId: account.account_id, expiresAt: account.expires_at };
  }

  async function startDeviceLogin() {
    const response = await Risuai.nativeFetch(DEVICE_AUTH_START_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: CLIENT_ID }),
      forceProxy: true,
    });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch (_error) {}
    if (!response.ok || !payload?.device_auth_id || !payload?.user_code) {
      throw new Error(payload?.error?.message || text || "기기 인증을 시작할 수 없습니다.");
    }
    const pending = {
      device_auth_id: payload.device_auth_id,
      user_code: payload.user_code,
      code_verifier: payload.code_verifier,
      verify_url: `${ISSUER}/codex/device`,
      expires_at: nowMs() + 10 * 60 * 1000,
    };
    await Risuai.pluginStorage.setItem(PENDING_LOGIN_KEY, pending);
    return pending;
  }

  async function pollDeviceLogin() {
    const pending = await Risuai.pluginStorage.getItem(PENDING_LOGIN_KEY);
    if (!pending?.device_auth_id || !pending?.user_code) throw new Error("대기 중인 기기 인증이 없습니다.");
    if (pending.expires_at && pending.expires_at <= nowMs()) {
      await Risuai.pluginStorage.removeItem(PENDING_LOGIN_KEY);
      throw new Error("기기 인증이 만료되었습니다. 다시 시작하세요.");
    }
    const response = await Risuai.nativeFetch(DEVICE_AUTH_POLL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_auth_id: pending.device_auth_id, user_code: pending.user_code }),
      forceProxy: true,
    });
    if (response.status === 403 || response.status === 404) return { status: "pending", pending };
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch (_error) {}
    if (!response.ok || !payload?.authorization_code) throw new Error(payload?.error?.message || text || "기기 인증 확인에 실패했습니다.");
    const tokens = await requestTokens({
      grant_type: "authorization_code",
      code: payload.authorization_code,
      redirect_uri: DEVICE_REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: payload.code_verifier || pending.code_verifier,
    }, "Codex 토큰 교환에 실패했습니다.");
    const account = accountFromTokens(tokens, {}, "Codex Account");
    if (!account) throw new Error("로그인 토큰을 읽을 수 없습니다.");
    await saveAccount(account, true);
    await Risuai.pluginStorage.removeItem(PENDING_LOGIN_KEY);
    return { status: "authorized", account };
  }

  async function cancelDeviceLogin() {
    await Risuai.pluginStorage.removeItem(PENDING_LOGIN_KEY);
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>\"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]);
  }

  function ensureStyles() {
    if (document.getElementById("codex-manager-style")) return;
    const style = document.createElement("style");
    style.id = "codex-manager-style";
    style.textContent = `
      * { box-sizing: border-box; }
      body { margin: 0; background: #1a202c; }
      .cdx-app { min-height: 100vh; padding: 24px; background: #1a202c; color: #e2e8f0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .cdx-shell { max-width: 780px; margin: 0 auto; }
      .cdx-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 22px; }
      .cdx-title { margin: 0; color: #fff; font-size: 22px; line-height: 1.2; }
      .cdx-subtitle { margin: 7px 0 0; color: #a0aec0; }
      .cdx-card { margin-bottom: 14px; padding: 16px; border: 1px solid #4a5568; border-radius: 8px; background: #2d3748; }
      .cdx-card-title { margin: 0 0 10px; color: #a0aec0; font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
      .cdx-message { margin: 0 0 14px; padding: 11px 12px; border: 1px solid #4a5568; border-radius: 6px; background: #1a202c; color: #cbd5e0; white-space: pre-wrap; overflow-wrap: anywhere; }
      .cdx-login { border-color: #2b6cb0; background: #1e3a5f; }
      .cdx-login code { display: inline-block; padding: 2px 6px; border-radius: 4px; background: #1a202c; color: #f6e05e; font-size: 15px; letter-spacing: .04em; }
      .cdx-actions { display: flex; flex-wrap: wrap; gap: 8px; }
      .cdx-btn { display: inline-flex; align-items: center; justify-content: center; min-height: 34px; padding: 7px 12px; border: 0; border-radius: 5px; background: #3182ce; color: #fff; font: inherit; cursor: pointer; transition: background .15s; }
      .cdx-btn:hover { background: #2b6cb0; }
      .cdx-btn:disabled { cursor: not-allowed; opacity: .55; }
      .cdx-btn-secondary { background: #4a5568; color: #e2e8f0; }
      .cdx-btn-secondary:hover { background: #718096; }
      .cdx-btn-danger { background: #c53030; color: #fff; }
      .cdx-btn-danger:hover { background: #9b2c2c; }
      .cdx-btn-icon { min-width: 34px; padding: 6px 10px; }
      .cdx-account { display: flex; align-items: center; gap: 10px; padding: 12px 0; border-top: 1px solid #4a5568; }
      .cdx-account:first-of-type { border-top: 0; padding-top: 0; }
      .cdx-account:last-child { padding-bottom: 0; }
      .cdx-account-main { min-width: 0; flex: 1; }
      .cdx-account-label { color: #f7fafc; font-weight: 600; overflow-wrap: anywhere; }
      .cdx-account-id { margin-top: 2px; color: #a0aec0; font-size: 12px; overflow-wrap: anywhere; }
      .cdx-radio { width: 16px; height: 16px; accent-color: #4299e1; cursor: pointer; }
      .cdx-badge { display: inline-block; margin-left: 6px; padding: 1px 6px; border-radius: 999px; background: #22543d; color: #9ae6b4; font-size: 11px; font-weight: 600; vertical-align: 1px; }
      .cdx-empty { margin: 0; color: #a0aec0; text-align: center; padding: 20px 8px; }
      .cdx-link { color: #90cdf4; }
      .cdx-field { margin-top: 11px; }
      .cdx-field-label { display: block; margin-bottom: 5px; color: #a0aec0; font-size: 12px; font-weight: 600; }
      .cdx-field-row { display: flex; gap: 8px; }
      .cdx-input { min-width: 0; flex: 1; padding: 7px 9px; border: 1px solid #718096; border-radius: 5px; outline: 0; background: #1a202c; color: #e2e8f0; font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      .cdx-input:focus { border-color: #4299e1; }
      .cdx-session-note { margin: 10px 0 0; color: #a0aec0; font-size: 12px; }
      @media (max-width: 600px) { .cdx-app { padding: 14px; } .cdx-header { align-items: center; } .cdx-title { font-size: 19px; } .cdx-account { align-items: flex-start; flex-wrap: wrap; } .cdx-account .cdx-btn-danger { margin-left: 26px; } }
    `;
    document.head.appendChild(style);
  }

  async function renderSettings(message = "") {
    ensureStyles();
    const state = await loadState();
    const pending = await Risuai.pluginStorage.getItem(PENDING_LOGIN_KEY);
    const active = state.activeAccountId;
    const activeAccount = state.accounts.find((account) => account.id === active) || null;
    document.body.innerHTML = `
      <main class="cdx-app"><div class="cdx-shell">
        <header class="cdx-header"><div><h1 class="cdx-title">Codex Manager</h1><p class="cdx-subtitle">OAuth 계정과 세션 갱신을 관리합니다.</p></div><button id="close" class="cdx-btn cdx-btn-secondary cdx-btn-icon" title="닫기" aria-label="닫기">×</button></header>
        ${message ? `<div class="cdx-message">${escapeHtml(message)}</div>` : ""}
        ${pending ? `<section class="cdx-card cdx-login"><h2 class="cdx-card-title">로그인 진행 중</h2><p>1. <a class="cdx-link" href="${escapeHtml(pending.verify_url)}" target="_blank" rel="noreferrer">${escapeHtml(pending.verify_url)}</a>에서 로그인합니다.</p><p>2. 다음 코드를 입력하세요: <code>${escapeHtml(pending.user_code)}</code></p><div class="cdx-actions"><button id="poll" class="cdx-btn">인증 확인</button><button id="cancel-login" class="cdx-btn cdx-btn-secondary">취소</button></div></section>` : ""}
        <section class="cdx-card"><h2 class="cdx-card-title">작업</h2><div class="cdx-actions"><button id="start" class="cdx-btn">계정 추가</button><button id="refresh" class="cdx-btn cdx-btn-secondary">활성 세션 갱신</button></div></section>
        <section class="cdx-card"><h2 class="cdx-card-title">모델 프리셋 연결 정보</h2>
          ${activeAccount ? `<div class="cdx-field"><label class="cdx-field-label" for="session-account-id">ChatGPT Account ID</label><div class="cdx-field-row"><input id="session-account-id" class="cdx-input" readonly value="${escapeHtml(activeAccount.account_id || "")}"><button class="cdx-btn cdx-btn-secondary" data-copy="session-account-id">복사</button></div></div><div class="cdx-field"><label class="cdx-field-label" for="session-access-token">Access Token</label><div class="cdx-field-row"><input id="session-access-token" class="cdx-input" type="password" readonly value="${escapeHtml(activeAccount.access_token || "")}"><button id="toggle-token" class="cdx-btn cdx-btn-secondary">표시</button><button class="cdx-btn cdx-btn-secondary" data-copy="session-access-token">복사</button></div></div><p class="cdx-session-note">Codex 모델 프리셋은 이 access token과 Account ID를 Codex Manager에서 자동으로 받아 사용합니다. refresh token은 표시하거나 내보내지 않습니다.</p>` : "<p class=\"cdx-empty\">활성 계정을 선택하면 모델 프리셋 연결 정보를 볼 수 있습니다.</p>"}
        </section>
        <section class="cdx-card"><h2 class="cdx-card-title">계정</h2>
          ${state.accounts.length ? state.accounts.map((account) => `<div class="cdx-account"><input class="cdx-radio" type="radio" name="account" value="${escapeHtml(account.id)}" ${account.id === active ? "checked" : ""} aria-label="${escapeHtml(account.label)} 계정 선택"><div class="cdx-account-main"><div class="cdx-account-label">${escapeHtml(account.label)}${account.id === active ? '<span class="cdx-badge">활성</span>' : ''}</div><div class="cdx-account-id">${escapeHtml(account.account_id || "계정 ID 없음")}</div></div><button class="cdx-btn cdx-btn-danger" data-remove="${escapeHtml(account.id)}">삭제</button></div>`).join("") : "<p class=\"cdx-empty\">로그인한 계정이 없습니다.</p>"}
        </section>
      </div></main>`;
    document.getElementById("close")?.addEventListener("click", () => Risuai.hideContainer());
    document.getElementById("start")?.addEventListener("click", async () => {
      try { const login = await startDeviceLogin(); await renderSettings(`기기 인증을 시작했습니다. 코드: ${login.user_code}`); }
      catch (error) { await renderSettings(error?.message || String(error)); }
    });
    document.getElementById("poll")?.addEventListener("click", async () => {
      try { const result = await pollDeviceLogin(); await renderSettings(result.status === "authorized" ? `${result.account.label} 계정으로 로그인했습니다.` : "아직 인증 대기 중입니다."); }
      catch (error) { await renderSettings(error?.message || String(error)); }
    });
    document.getElementById("cancel-login")?.addEventListener("click", async () => {
      await cancelDeviceLogin();
      await renderSettings("기기 인증을 취소했습니다.");
    });
    document.getElementById("toggle-token")?.addEventListener("click", (event) => {
      const input = document.getElementById("session-access-token");
      if (!input) return;
      const visible = input.type === "text";
      input.type = visible ? "password" : "text";
      event.currentTarget.textContent = visible ? "표시" : "숨김";
    });
    document.querySelectorAll("button[data-copy]").forEach((button) => button.addEventListener("click", async () => {
      const input = document.getElementById(button.dataset.copy);
      if (!input?.value) return;
      try {
        if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(input.value);
        else { input.select(); document.execCommand("copy"); }
        button.textContent = "복사됨";
        setTimeout(() => { button.textContent = "복사"; }, 1200);
      } catch (_error) {
        input.type = "text";
        input.select();
      }
    }));
    document.getElementById("refresh")?.addEventListener("click", async () => {
      try { const session = await ensureActiveSession(); await renderSettings(`세션이 준비되었습니다. 만료 시각: ${new Date(session.expiresAt || nowMs()).toLocaleString()}`); }
      catch (error) { await renderSettings(error?.message || String(error)); }
    });
    document.querySelectorAll("input[name=account]").forEach((input) => input.addEventListener("change", async (event) => {
      const next = event.target?.value;
      const stateNow = await loadState();
      await saveAccounts(stateNow.accounts, next);
      await renderSettings("활성 계정을 변경했습니다.");
    }));
    document.querySelectorAll("button[data-remove]").forEach((button) => button.addEventListener("click", async () => {
      const id = button.dataset.remove;
      if (!id || (typeof window.confirm === "function" && !window.confirm("이 계정을 삭제할까요?"))) return;
      const stateNow = await loadState();
      await saveAccounts(stateNow.accounts.filter((account) => account.id !== id), stateNow.activeAccountId);
      await renderSettings("계정을 삭제했습니다.");
    }));
  }

  await Risuai.registerSetting("Codex Manager", async () => {
    await renderSettings();
    await Risuai.showContainer("fullscreen");
  }, "C", "html");
})();
