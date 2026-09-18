/**
 * AI 提供商设置页
 */

function providerSupportsCapability(provider, capability) {
    return provider.enabled && provider[`supports_${capability}`] === true;
}

function shouldShowImageGenerationMode(protocol, supportsImage) {
    return protocol === "openai_compatible" && supportsImage === true;
}

function providerTestCapabilities(provider) {
    return ["text", "image"].filter(
        capability => provider?.[`supports_${capability}`] === true
    );
}

function maskedKeyPlaceholder(provider) {
    if (!provider || !provider.has_api_key || !provider.api_key_masked) {
        return "未保存 API Key";
    }
    return `已保存：${provider.api_key_masked}`;
}

function maskedCrawlerKeyPlaceholder(crawler) {
    if (!crawler || !crawler.has_api_key || !crawler.api_key_masked) {
        return "未配置 API Key";
    }
    return `已保存：${crawler.api_key_masked}`;
}

function buildCrawlerPayload(values = {}) {
    return {
        api_key: typeof values.api_key === "string" ? values.api_key.trim() : "",
        api_url: typeof values.api_url === "string" && values.api_url.trim()
            ? values.api_url.trim().replace(/\/+$/, "")
            : "https://api.firecrawl.dev/v1/scrape"
    };
}

function buildProviderPayload(values) {
    const imageGenerationMode = ["text_to_image", "image_to_image"].includes(
        values.image_generation_mode
    ) ? values.image_generation_mode : "image_to_image";
    const payload = {
        name: String(values.name || "").trim(),
        protocol: values.protocol,
        base_url: String(values.base_url || "").trim().replace(/\/+$/, "") || null,
        api_key: String(values.api_key || "").trim() || null,
        supports_text: values.supports_text === true,
        supports_image: values.supports_image === true,
        image_generation_mode: imageGenerationMode,
        timeout_seconds: Number.parseInt(values.timeout_seconds, 10),
        max_retries: Number.parseInt(values.max_retries, 10),
        enabled: values.enabled === true
    };

    [
        "vertex_project_id",
        "vertex_location",
        "vertex_key_path",
        "text_model",
        "image_model"
    ].forEach(field => {
        if (Object.prototype.hasOwnProperty.call(values, field)) {
            payload[field] = String(values[field] || "").trim() || null;
        }
    });

    return payload;
}

function buildProviderTestRequestBody(providerId, draft, capability) {
    const request = { draft, capability };
    if (providerId !== null && providerId !== undefined) {
        request.provider_id = Number(providerId);
    }
    return request;
}

function replaceProviderInList(providers, updatedProvider) {
    const exists = providers.some(
        provider => Number(provider.id) === Number(updatedProvider.id)
    );
    if (!exists) return [...providers, updatedProvider];
    return providers.map(provider => (
        Number(provider.id) === Number(updatedProvider.id)
            ? updatedProvider
            : provider
    ));
}

function removeProviderFromList(providers, providerId) {
    return providers.filter(provider => Number(provider.id) !== Number(providerId));
}

function replaceBindingInList(bindings, updatedBinding) {
    const exists = bindings.some(
        binding => binding.capability === updatedBinding.capability
    );
    if (!exists) return [...bindings, updatedBinding];
    return bindings.map(binding => (
        binding.capability === updatedBinding.capability
            ? updatedBinding
            : binding
    ));
}

function logMatchesFilters(entry, filters) {
    return ["level", "source", "capability"].every(field => {
        const selected = filters?.[field] || "all";
        return selected === "all" || entry?.[field] === selected;
    });
}

function appendBoundedSettingsLog(logs, entry, limit = 200) {
    return [...logs, entry].slice(-limit);
}

const SETTINGS_LOG_FIELDS = [
    "timestamp",
    "level",
    "source",
    "message",
    "capability",
    "provider",
    "model",
    "duration_ms",
    "retry",
    "image_generation_mode",
    "image_endpoint"
];

function settingsLogId(entry) {
    return Number.isSafeInteger(entry?.id) && entry.id > 0
        ? entry.id
        : null;
}

function settingsLogSessionId(entry) {
    return typeof entry?.session_id === "string"
        && entry.session_id.length > 0
        ? entry.session_id
        : null;
}

function settingsLogKey(entry) {
    const sessionId = settingsLogSessionId(entry);
    const sequenceId = settingsLogId(entry);
    return sessionId !== null && sequenceId !== null
        ? `${sessionId}:${sequenceId}`
        : null;
}

function mergeSettingsLogSnapshot(snapshot, buffered, limit = 200) {
    const combined = [...snapshot, ...buffered];
    let currentSession = null;
    const sessionCandidates = snapshot.length ? snapshot : buffered;
    sessionCandidates.forEach(entry => {
        currentSession = settingsLogSessionId(entry) || currentSession;
    });

    const seen = new Set();
    const legacyEntries = [];
    const currentEntries = [];
    combined.forEach(entry => {
        const key = settingsLogKey(entry);
        if (key === null) {
            legacyEntries.push(entry);
            return;
        }
        if (settingsLogSessionId(entry) !== currentSession || seen.has(key)) {
            return;
        }
        seen.add(key);
        currentEntries.push(entry);
    });
    currentEntries.sort((left, right) => (
        settingsLogId(left) - settingsLogId(right)
    ));
    return [...legacyEntries, ...currentEntries].slice(-limit);
}

function formatSettingsLogLine(entry) {
    const fields = SETTINGS_LOG_FIELDS.map(field => {
        const value = field === "message"
            ? settingsLogSummary(entry)
            : entry?.[field] ?? "—";
        return `${field}=${value}`;
    });
    const diagnostic = entry?.message?.diagnostic;
    if (diagnostic && typeof diagnostic === "object" && !Array.isArray(diagnostic)) {
        fields.push(`diagnostic=${settingsLogDetailValue(diagnostic)}`);
    }
    return fields.join(" ");
}

function settingsLogSummary(entry) {
    const message = entry?.message;
    if (message && typeof message === "object" && !Array.isArray(message)) {
        return String(message.summary ?? "—");
    }
    return String(message ?? "—");
}

function settingsLogDetailValue(value) {
    if (typeof value === "string") return value;
    if (value && typeof value === "object") {
        try {
            return JSON.stringify(value);
        } catch (_) {
            return "[Unserializable object]";
        }
    }
    return String(value);
}

function settingsLogDetails(entry) {
    const message = entry?.message;
    if (!message || typeof message !== "object" || Array.isArray(message)) {
        return [];
    }

    const diagnostic = message.diagnostic;
    if (!diagnostic || typeof diagnostic !== "object" || Array.isArray(diagnostic)) {
        return [];
    }

    const details = [
        ["分类", diagnostic.category],
        ["HTTP 状态", diagnostic.http_status],
        ["提供商代码", diagnostic.provider_code],
        ["异常类型", diagnostic.exception_type],
        ["请求 ID", diagnostic.request_id],
        ["上游消息", diagnostic.upstream_message],
        ["响应正文", diagnostic.response_body]
    ].filter(([, value]) => value !== null && value !== undefined && value !== "")
        .map(([label, value]) => [label, settingsLogDetailValue(value)]);

    if (message.attempt !== null && message.attempt !== undefined) {
        const attempt = message.max_attempts !== null && message.max_attempts !== undefined
            ? `${message.attempt} / ${message.max_attempts}`
            : message.attempt;
        details.push(["尝试", settingsLogDetailValue(attempt)]);
    }
    return details;
}

function shouldConnectSettingsLogs(state) {
    return !state.logSource && !state.logConnecting;
}

function closeSettingsLogSource(source) {
    source?.close();
    return null;
}

function replaceSettingsLogs(state, logs) {
    state.logs = mergeSettingsLogSnapshot([], logs);
    state.logSessionId = null;
    state.logs.forEach(entry => {
        state.logSessionId = settingsLogSessionId(entry)
            || state.logSessionId;
    });
    state.logSeenIds = new Set(
        state.logs
            .map(settingsLogKey)
            .filter(key => key !== null)
    );
}

const settingsState = {
    initialized: false,
    activeTab: "ai",
    providerFilterProtocol: "all",
    providers: [],
    bindings: { items: [] },
    crawler: null,
    storageConfigs: [],
    activeStorageTarget: "wordpress",
    activeWpConfigId: 0,
    activeShopifyConfigId: 0,
    editingProviderId: null,
    logs: [],
    logSeenIds: new Set(),
    logSessionId: null,
    logSource: null,
    logConnecting: null,
    logConnectionCancel: null,
    logGeneration: 0,
    logsPaused: false,
    logFilters: {
        level: "all",
        source: "all",
        capability: "all"
    },
    logAutoScroll: true
};

const SETTINGS_PROTOCOL_LABELS = {
    gemini: "Gemini API",
    vertex: "Vertex AI",
    openai_compatible: "OpenAI Compatible"
};

function settingsElement(id) {
    if (typeof document === "undefined") return null;
    return document.getElementById(id);
}

function escapeSettingsHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function settingsToast(message, type = "info") {
    if (typeof showToast === "function") {
        showToast(message, type);
        return;
    }
    console[type === "error" ? "error" : "log"](message);
}

function setLogConnection(status) {
    const badge = settingsElement("settingsLogConnection");
    if (badge) {
        const labels = {
            connecting: "连接中",
            connected: "已连接",
            reconnecting: "重连中",
            disconnected: "已断开"
        };
        badge.dataset.status = status;
        badge.textContent = labels[status] || status;
    }

    const streamVal = settingsElement("settingsKpiStreamVal");
    const streamDot = settingsElement("settingsKpiStreamDot");
    if (streamVal) {
        const kpiLabels = {
            connecting: "连接中",
            connected: "实时在线",
            reconnecting: "重连中",
            disconnected: "已离线"
        };
        streamVal.textContent = kpiLabels[status] || status;
    }
    if (streamDot) {
        streamDot.className = `settings-overview-status ${status === "connected" ? "is-live" : status === "disconnected" ? "is-offline" : "is-unbound"}`;
    }
}

function currentSettingsLogFilters() {
    return {
        level: settingsElement("settingsLogLevel")?.value || "all",
        source: settingsElement("settingsLogSource")?.value || "all",
        capability: settingsElement("settingsLogCapability")?.value || "all"
    };
}

function visibleSettingsLogs(state = settingsState) {
    return (state.logs || []).filter(entry => (
        logMatchesFilters(entry, state.logFilters || {})
    ));
}

function createSettingsLogElement(tagName, className, text) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    element.textContent = String(text ?? "—");
    return element;
}

function appendSettingsLogField(container, label, value, className = "") {
    const field = createSettingsLogElement(
        "span",
        `settings-log-field ${className}`.trim(),
        ""
    );
    field.appendChild(createSettingsLogElement(
        "span",
        "settings-log-field-label",
        `${label}=`
    ));
    field.appendChild(createSettingsLogElement(
        "span",
        "settings-log-field-value",
        value
    ));
    container.appendChild(field);
}

function renderSettingsLogs() {
    const container = settingsElement("settingsLogEntries");
    if (!container) return;

    const visible = visibleSettingsLogs();
    container.replaceChildren();

    if (!visible.length) {
        const empty = createSettingsLogElement(
            "div",
            "settings-log-empty",
            settingsState.logs.length
                ? "当前筛选条件下没有日志。"
                : "暂无运行日志，等待新的应用事件。"
        );
        container.appendChild(empty);
    } else {
        visible.forEach(entry => {
            const row = createSettingsLogElement("article", "settings-log-entry", "");
            const level = ["error", "warning", "success", "info", "debug"]
                .includes(entry?.level)
                ? entry.level
                : "default";
            row.dataset.level = level;

            const head = createSettingsLogElement("div", "settings-log-entry-head", "");
            appendSettingsLogField(head, "timestamp", entry?.timestamp, "is-timestamp");
            appendSettingsLogField(head, "level", entry?.level, "is-level");
            appendSettingsLogField(head, "source", entry?.source, "is-source");
            row.appendChild(head);

            const message = createSettingsLogElement("div", "settings-log-message", "");
            appendSettingsLogField(message, "message", settingsLogSummary(entry));
            row.appendChild(message);

            const meta = createSettingsLogElement("div", "settings-log-meta", "");
            appendSettingsLogField(meta, "capability", entry?.capability);
            appendSettingsLogField(meta, "provider", entry?.provider);
            appendSettingsLogField(meta, "model", entry?.model);
            appendSettingsLogField(meta, "duration_ms", entry?.duration_ms);
            appendSettingsLogField(meta, "retry", entry?.retry);
            row.appendChild(meta);

            const detailRows = settingsLogDetails(entry);
            if (detailRows.length) {
                const details = createSettingsLogElement(
                    "details",
                    "settings-log-details",
                    ""
                );
                details.appendChild(createSettingsLogElement(
                    "summary",
                    "settings-log-details-summary",
                    "查看错误详情"
                ));

                const content = createSettingsLogElement(
                    "div",
                    "settings-log-details-content",
                    ""
                );
                detailRows.forEach(([label, value]) => {
                    const detail = createSettingsLogElement(
                        "div",
                        "settings-log-detail-row",
                        ""
                    );
                    detail.appendChild(createSettingsLogElement(
                        "span",
                        "settings-log-detail-label",
                        label
                    ));
                    detail.appendChild(createSettingsLogElement(
                        "span",
                        "settings-log-detail-value",
                        value
                    ));
                    content.appendChild(detail);
                });
                details.appendChild(content);
                row.appendChild(details);
            }
            container.appendChild(row);
        });
    }

    const count = settingsElement("settingsLogCount");
    if (count) count.textContent = `${visible.length} / ${settingsState.logs.length}`;
    if (settingsState.logAutoScroll) {
        container.scrollTop = container.scrollHeight;
    }
}

function filterSettingsLogs() {
    settingsState.logFilters = currentSettingsLogFilters();
    renderSettingsLogs();
    return visibleSettingsLogs();
}

function toggleSettingsLogsPaused() {
    settingsState.logsPaused = !settingsState.logsPaused;
    const button = settingsElement("settingsLogPause");
    if (button) {
        button.setAttribute("aria-pressed", settingsState.logsPaused ? "true" : "false");
        button.textContent = settingsState.logsPaused ? "继续" : "暂停";
    }
    if (!settingsState.logsPaused) renderSettingsLogs();
}

function setSettingsLogAutoScroll(enabled) {
    settingsState.logAutoScroll = enabled === true;
    if (settingsState.logAutoScroll) renderSettingsLogs();
}

function clearVisibleSettingsLogs() {
    replaceSettingsLogs(settingsState, []);
    renderSettingsLogs();
}

function copyVisibleSettingsLogs() {
    const text = visibleSettingsLogs()
        .map(formatSettingsLogLine)
        .join("\n");
    if (!text) {
        settingsToast("当前没有可复制的日志", "warning");
        return;
    }

    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.setAttribute("readonly", "");
    textArea.className = "settings-clipboard-buffer";
    document.body.appendChild(textArea);
    textArea.select();
    try {
        document.execCommand("copy");
        settingsToast("已复制当前筛选日志", "success");
    } catch (_error) {
        settingsToast("复制失败", "error");
    } finally {
        document.body.removeChild(textArea);
    }
}

function appendSettingsLog(entry, options = {}) {
    const state = options.state || settingsState;
    const render = options.render || renderSettingsLogs;
    if (
        !(state.logSeenIds instanceof Set)
        || state.logSessionId === undefined
    ) {
        replaceSettingsLogs(state, state.logs || []);
    }
    const sessionId = settingsLogSessionId(entry);
    const key = settingsLogKey(entry);
    if (
        sessionId !== null
        && state.logSessionId !== null
        && state.logSessionId !== sessionId
    ) {
        replaceSettingsLogs(state, []);
    }
    if (key !== null && state.logSeenIds.has(key)) return false;
    const nextLogs = key === null
        ? appendBoundedSettingsLog(state.logs || [], entry)
        : mergeSettingsLogSnapshot(state.logs || [], [entry]);
    replaceSettingsLogs(state, nextLogs);
    if (!state.logsPaused) render();
    return true;
}

function connectSettingsLogs(options = {}) {
    const state = options.state || settingsState;
    if (!shouldConnectSettingsLogs(state)) return state.logConnecting;

    const baseUrl = options.baseUrl !== undefined
        ? options.baseUrl
        : (typeof API_BASE !== "undefined" ? API_BASE : "");
    const request = options.request || (url => settingsRequest(url));
    const EventSourceClass = options.EventSourceClass
        || (typeof EventSource !== "undefined" ? EventSource : null);
    const render = options.render || renderSettingsLogs;
    const setConnection = options.setConnection || setLogConnection;
    const onError = options.onError || (error => settingsToast(error.message, "error"));
    const generation = state.logGeneration || 0;

    setConnection("connecting");
    if (!EventSourceClass) {
        const error = new Error("当前浏览器不支持实时日志连接");
        setConnection("disconnected");
        onError(error);
        return Promise.resolve(null);
    }

    let settleConnection;
    let settled = false;
    const connection = new Promise(resolve => {
        settleConnection = resolve;
    });
    const settle = value => {
        if (settled) return;
        settled = true;
        if (state.logConnecting === connection) state.logConnecting = null;
        if (state.logConnectionCancel === cancelConnection) {
            state.logConnectionCancel = null;
        }
        settleConnection(value);
    };
    const cancelConnection = () => settle(null);
    state.logConnecting = connection;
    state.logConnectionCancel = cancelConnection;

    let source;
    try {
        source = new EventSourceClass(`${baseUrl}/api/settings/logs/stream`);
    } catch (error) {
        if ((state.logGeneration || 0) === generation) {
            setConnection("disconnected");
            try {
                onError(error);
            } finally {
                settle(null);
            }
        } else {
            settle(null);
        }
        return connection;
    }

    state.logSource = source;
    let snapshotStarted = false;
    let snapshotReady = false;
    let bufferedEvents = [];
    const isCurrent = () => (
        (state.logGeneration || 0) === generation
        && state.logSource === source
    );

    const startSnapshot = async () => {
        if (snapshotStarted || !isCurrent()) return;
        snapshotStarted = true;
        try {
            const recent = await request(`${baseUrl}/api/settings/logs/recent`);
            if (!isCurrent()) {
                settle(null);
                return;
            }
            const items = Array.isArray(recent?.items) ? recent.items : [];
            replaceSettingsLogs(
                state,
                mergeSettingsLogSnapshot(items, bufferedEvents)
            );
            bufferedEvents = [];
            snapshotReady = true;
            if (!state.logsPaused) render();
            settle(source);
        } catch (error) {
            if (!isCurrent()) {
                settle(null);
                return;
            }
            replaceSettingsLogs(
                state,
                mergeSettingsLogSnapshot(
                    state.logs || [],
                    bufferedEvents
                )
            );
            bufferedEvents = [];
            snapshotReady = true;
            if (!state.logsPaused) render();
            try {
                onError(error);
            } finally {
                settle(source);
            }
        }
    };

    source.onopen = () => {
        if (!isCurrent()) return;
        setConnection("connected");
        startSnapshot();
    };
    source.onerror = () => {
        if (!isCurrent()) return;
        setConnection("reconnecting");
        startSnapshot();
    };
    source.onmessage = event => {
        if (!isCurrent()) return;
        let entry;
        try {
            entry = JSON.parse(event.data);
        } catch (_error) {
            onError(new Error("收到无法解析的日志事件"));
            return;
        }
        if (!snapshotReady) {
            bufferedEvents = appendBoundedSettingsLog(
                bufferedEvents,
                entry
            );
            return;
        }
        appendSettingsLog(entry, { state, render });
    };
    return connection;
}

function disconnectSettingsLogs(options = {}) {
    const state = options.state || settingsState;
    const setConnection = options.setConnection || setLogConnection;
    state.logGeneration = (state.logGeneration || 0) + 1;
    const cancelConnection = state.logConnectionCancel;
    state.logConnectionCancel = null;
    cancelConnection?.();
    state.logSource = closeSettingsLogSource(state.logSource);
    state.logConnecting = null;
    setConnection("disconnected");
}

function settingsBindings() {
    return Array.isArray(settingsState.bindings?.items)
        ? settingsState.bindings.items
        : [];
}

function boundCapabilitiesForProvider(providerId) {
    return settingsBindings()
        .filter(binding => Number(binding.provider_config_id) === Number(providerId))
        .map(binding => binding.capability);
}

function settingsErrorMessage(data, fallback) {
    if (typeof data?.detail === "string") return data.detail;
    if (Array.isArray(data?.detail)) {
        return data.detail
            .map(item => item?.msg || String(item))
            .filter(Boolean)
            .join("；");
    }
    if (typeof data?.message === "string") return data.message;
    return fallback;
}

async function settingsRequest(url, options = {}) {
    let response;
    try {
        response = await fetch(url, options);
    } catch (error) {
        throw new Error(`网络请求失败：${error.message}`);
    }

    let data = {};
    try {
        data = await response.json();
    } catch (_error) {
        data = {};
    }

    if (!response.ok) {
        const error = new Error(settingsErrorMessage(data, `请求失败（${response.status}）`));
        error.status = response.status;
        throw error;
    }
    return data;
}

function setSettingsButtonBusy(button, isBusy) {
    if (!button) return;
    button.disabled = isBusy;
    button.setAttribute("aria-busy", isBusy ? "true" : "false");
}

async function refreshSettingsAfterSuccess(
    result,
    refresh = loadSettingsData,
    warn = message => settingsToast(message, "warning"),
    refreshRoutes = async () => {
        if (typeof refreshPublicAIRoutes === "function") {
            await refreshPublicAIRoutes();
        }
    }
) {
    let refreshError = null;
    let routeRefreshError = null;
    try {
        await refresh();
    } catch (error) {
        refreshError = error;
        warn(`操作成功，但刷新失败：${error.message}`);
    }
    try {
        await refreshRoutes();
    } catch (error) {
        routeRefreshError = error;
        warn(`操作成功，但 AI 路由刷新失败：${error.message}`);
    }
    return {
        result,
        refreshed: refreshError === null,
        refreshError,
        routesRefreshed: routeRefreshError === null,
        routeRefreshError
    };
}

async function initSettings() {
    if (settingsState.initialized) return;
    settingsState.initialized = true;

    const editor = settingsElement("settingsProviderEditor");
    if (editor) {
        editor.addEventListener("click", event => {
            if (event.target === editor) closeProviderEditor();
        });
    }

    const storageEditor = settingsElement("settingsStorageEditor");
    if (storageEditor) {
        storageEditor.addEventListener("click", event => {
            if (event.target === storageEditor) closeStorageEditor();
        });
    }

    document.addEventListener("keydown", event => {
        if (event.key === "Escape") {
            if (storageEditor && !storageEditor.classList.contains("hidden")) {
                closeStorageEditor();
            } else if (editor && !editor.classList.contains("hidden")) {
                closeProviderEditor();
            }
        }
    });

    const crawlerKeyInput = settingsElement("settingsFirecrawlApiKey");
    const crawlerUrlInput = settingsElement("settingsFirecrawlApiUrl");
    [crawlerKeyInput, crawlerUrlInput].forEach(input => {
        input?.addEventListener("keydown", event => {
            if (event.key === "Enter") {
                event.preventDefault();
                const saveBtn = settingsElement("settingsSaveCrawlerBtn");
                if (saveBtn) saveCrawlerSettings(saveBtn);
            }
        });
    });

    try {
        await loadSettingsData();
    } catch (error) {
        renderSettingsLoadError(error.message);
        settingsToast(error.message, "error");
    }
}

async function loadSettingsData() {
    const [providersData, bindingsData, crawlerData, storageConfigsData] = await Promise.all([
        settingsRequest(`${API_BASE}/api/settings/ai/providers`),
        settingsRequest(`${API_BASE}/api/settings/ai/bindings`),
        settingsRequest(`${API_BASE}/api/settings/crawler`).catch(error => {
            console.warn("Failed to load crawler settings:", error);
            return null;
        }),
        settingsRequest(`${API_BASE}/api/storage/configs`).catch(error => {
            console.warn("Failed to load storage configs:", error);
            return [];
        })
    ]);

    settingsState.providers = Array.isArray(providersData?.items)
        ? providersData.items
        : [];
    settingsState.bindings = {
        ...bindingsData,
        items: Array.isArray(bindingsData?.items) ? bindingsData.items : []
    };
    settingsState.crawler = crawlerData;
    settingsState.storageConfigs = Array.isArray(storageConfigsData) ? storageConfigsData : [];
    renderCapabilityBindings();
    renderProviderList();
    renderCrawlerSettings();
    renderStorageIntegrations();
}

async function refreshSettings(button) {
    setSettingsButtonBusy(button, true);
    try {
        await loadSettingsData();
        settingsToast("设置已刷新", "success");
    } catch (error) {
        settingsToast(error.message, "error");
    } finally {
        setSettingsButtonBusy(button, false);
    }
}

function renderSettingsLoadError(message) {
    const list = settingsElement("settingsProviderList");
    if (!list) return;
    list.innerHTML = `
        <div class="settings-empty-state">
            <i class="ph ph-warning-circle"></i>
            <p>${escapeSettingsHtml(message || "设置加载失败")}</p>
        </div>
    `;
}

function renderCapabilityBindings() {
    [
        {
            capability: "text",
            selectId: "settingsTextProvider",
            buttonId: "settingsSaveTextBinding",
            modelField: "text_model"
        },
        {
            capability: "image",
            selectId: "settingsImageProvider",
            buttonId: "settingsSaveImageBinding",
            modelField: "image_model"
        }
    ].forEach(config => {
        const select = settingsElement(config.selectId);
        const button = settingsElement(config.buttonId);
        if (!select) return;

        const binding = settingsBindings()
            .find(item => item.capability === config.capability);
        const available = settingsState.providers
            .filter(provider => providerSupportsCapability(provider, config.capability));
        const boundProvider = settingsState.providers
            .find(provider => Number(provider.id) === Number(binding?.provider_config_id));

        select.replaceChildren();
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = available.length ? "请选择线路" : "没有可用线路";
        select.appendChild(placeholder);

        if (
            boundProvider
            && !available.some(provider => Number(provider.id) === Number(boundProvider.id))
        ) {
            available.unshift(boundProvider);
        }

        available.forEach(provider => {
            const option = document.createElement("option");
            option.value = String(provider.id);
            const model = provider[config.modelField] || "未配置模型";
            const unavailable = !providerSupportsCapability(provider, config.capability);
            option.textContent = `${provider.name} · ${model}${unavailable ? "（当前不可用）" : ""}`;
            option.disabled = unavailable;
            select.appendChild(option);
        });

        select.value = binding ? String(binding.provider_config_id) : "";
        select.disabled = available.length === 0;
        if (button) button.disabled = available.length === 0;
    });
    updateSettingsOverviewKpis();
}

function updateSettingsOverviewKpis() {
    // 1. Text AI KPI
    const textBinding = settingsBindings().find(item => item.capability === "text");
    const textProvider = settingsState.providers.find(
        p => Number(p.id) === Number(textBinding?.provider_config_id)
    );
    const textValEl = settingsElement("settingsKpiTextVal");
    const textDotEl = settingsElement("settingsKpiTextDot");
    if (textValEl) {
        if (textProvider && textProvider.enabled) {
            textValEl.textContent = textProvider.name || "已就绪";
            textValEl.title = `${textProvider.name} (${textProvider.text_model || "未设模型"})`;
            if (textDotEl) {
                textDotEl.className = "settings-overview-status is-active";
                textDotEl.title = "正常运行";
            }
        } else {
            textValEl.textContent = "未绑定线路";
            textValEl.title = "请选择并绑定文本 AI 线路";
            if (textDotEl) {
                textDotEl.className = "settings-overview-status is-unbound";
                textDotEl.title = "未绑定";
            }
        }
    }

    // 2. Image AI KPI
    const imageBinding = settingsBindings().find(item => item.capability === "image");
    const imageProvider = settingsState.providers.find(
        p => Number(p.id) === Number(imageBinding?.provider_config_id)
    );
    const imageValEl = settingsElement("settingsKpiImageVal");
    const imageDotEl = settingsElement("settingsKpiImageDot");
    if (imageValEl) {
        if (imageProvider && imageProvider.enabled) {
            imageValEl.textContent = imageProvider.name || "已就绪";
            imageValEl.title = `${imageProvider.name} (${imageProvider.image_model || "未设模型"})`;
            if (imageDotEl) {
                imageDotEl.className = "settings-overview-status is-active";
                imageDotEl.title = "正常运行";
            }
        } else {
            imageValEl.textContent = "未绑定线路";
            imageValEl.title = "请选择并绑定图片 AI 线路";
            if (imageDotEl) {
                imageDotEl.className = "settings-overview-status is-unbound";
                imageDotEl.title = "未绑定";
            }
        }
    }

    // 3. Crawler KPI
    const crawler = settingsState.crawler;
    const crawlerValEl = settingsElement("settingsKpiCrawlerVal");
    const crawlerDotEl = settingsElement("settingsKpiCrawlerDot");
    if (crawlerValEl) {
        if (!crawler || !crawler.has_api_key) {
            crawlerValEl.textContent = "未配置 Key";
            if (crawlerDotEl) {
                crawlerDotEl.className = "settings-overview-status is-unbound";
                crawlerDotEl.title = "未配置 Key";
            }
        } else if (crawler.last_test_status === "success") {
            crawlerValEl.textContent = "服务正常";
            if (crawlerDotEl) {
                crawlerDotEl.className = "settings-overview-status is-active";
                crawlerDotEl.title = "连通测试正常";
            }
        } else if (crawler.last_test_status === "error" || crawler.last_test_status === "failed") {
            crawlerValEl.textContent = "连接异常";
            if (crawlerDotEl) {
                crawlerDotEl.className = "settings-overview-status is-error";
                crawlerDotEl.title = "连接异常";
            }
        } else {
            crawlerValEl.textContent = "已配置 Key";
            if (crawlerDotEl) {
                crawlerDotEl.className = "settings-overview-status is-active";
                crawlerDotEl.title = "已配置 Key";
            }
        }
    }

    // 4. Provider count badge
    const total = settingsState.providers.length;
    const enabled = settingsState.providers.filter(p => p.enabled).length;
    const countBadge = settingsElement("settingsProviderCountBadge");
    if (countBadge) {
        countBadge.textContent = `共 ${total} 条线路 · ${enabled} 条启用`;
    }
    const tabAiCount = settingsElement("settingsTabAiCount");
    if (tabAiCount) {
        tabAiCount.textContent = `${enabled}/${total} 启用`;
    }
}

function renderCurrentSettingsState() {
    renderCapabilityBindings();
    renderProviderList();
}

function applyLocalProvider(updatedProvider) {
    settingsState.providers = replaceProviderInList(
        settingsState.providers,
        updatedProvider
    );
    renderCurrentSettingsState();
}

function applyLocalBinding(updatedBinding) {
    settingsState.bindings = {
        ...settingsState.bindings,
        items: replaceBindingInList(settingsBindings(), updatedBinding)
    };
    renderCurrentSettingsState();
}

function removeLocalProvider(providerId) {
    settingsState.providers = removeProviderFromList(
        settingsState.providers,
        providerId
    );
    renderCurrentSettingsState();
}

function providerProtocolIcon(protocol) {
    if (protocol === "vertex") return "ph-cloud";
    if (protocol === "openai_compatible") return "ph-arrows-left-right";
    return "ph-sparkle";
}

function providerTestStatusMarkup(provider) {
    const status = provider.last_test_status;
    if (!status) {
        return `
            <span class="settings-test-status">
                <i class="ph ph-minus-circle"></i> 未测试
            </span>
        `;
    }
    const success = status === "success";
    const message = provider.last_test_message || (success ? "连接成功" : "连接失败");
    const capabilityLabel = {
        text: "文本",
        image: "图片"
    }[provider.last_test_capability] || "";
    const displayMessage = capabilityLabel
        ? `${capabilityLabel} · ${message}`
        : message;
    return `
        <span class="settings-test-status ${success ? "is-success" : "is-error"}"
            title="${escapeSettingsHtml(displayMessage)}">
            <i class="ph ${success ? "ph-check-circle" : "ph-warning-circle"}"></i>
            <span class="settings-test-message">${capabilityLabel
                ? `<span class="settings-test-capability">${capabilityLabel}</span> · `
                : ""}${escapeSettingsHtml(message)}</span>
        </span>
    `;
}

function providerTestActionsMarkup(provider) {
    const capabilities = providerTestCapabilities(provider);
    if (!capabilities.length) {
        return `
            <button type="button"
                class="settings-provider-action settings-provider-test-action"
                title="未声明可测试能力" aria-label="未声明可测试能力"
                disabled>
                <i class="ph ph-plugs"></i><span>不可测试</span>
            </button>
        `;
    }
    return capabilities.map(capability => {
        const label = capability === "text" ? "文本" : "图片";
        const icon = capability === "text" ? "ph-text-aa" : "ph-image";
        return `
            <button type="button"
                class="settings-provider-action settings-provider-test-action"
                title="测试${label}连接"
                aria-label="测试${label} ${escapeSettingsHtml(provider.name)}"
                onclick="testSavedProvider(${Number(provider.id)}, '${capability}', this)">
                <i class="ph ${icon}"></i><span>测试${label}</span>
            </button>
        `;
    }).join("");
}

function providerImageModeBadgeMarkup(provider) {
    if (!shouldShowImageGenerationMode(
        provider?.protocol,
        provider?.supports_image === true
    )) {
        return "";
    }
    const isTextToImage = provider.image_generation_mode === "text_to_image";
    return `
        <span class="settings-badge settings-badge-image-mode">
            <i class="ph ${isTextToImage ? "ph-text-t" : "ph-image-square"}"></i>
            ${isTextToImage ? "文生图" : "图生图"}
        </span>
    `;
}

function switchSettingsTab(tabKey) {
    const validTabs = ["ai", "integrations", "logs"];
    const activeTab = validTabs.includes(tabKey) ? tabKey : "ai";
    settingsState.activeTab = activeTab;

    const tabMap = {
        ai: { btn: settingsElement("settingsTabBtnAi"), pane: settingsElement("settingsPaneAi") },
        integrations: { btn: settingsElement("settingsTabBtnIntegrations"), pane: settingsElement("settingsPaneIntegrations") },
        logs: { btn: settingsElement("settingsTabBtnLogs"), pane: settingsElement("settingsPaneLogs") }
    };

    Object.keys(tabMap).forEach(key => {
        const item = tabMap[key];
        if (item.btn) {
            item.btn.classList.toggle("is-active", key === activeTab);
            item.btn.setAttribute("aria-selected", key === activeTab ? "true" : "false");
        }
        if (item.pane) {
            if (key === activeTab) {
                item.pane.classList.remove("hidden");
                item.pane.classList.add("is-active");
            } else {
                item.pane.classList.add("hidden");
                item.pane.classList.remove("is-active");
            }
        }
    });

    if (activeTab === "logs" && settingsState.logAutoScroll && typeof scrollSettingsLogsToBottom === "function") {
        scrollSettingsLogsToBottom();
    }
}

function filterSettingsProviders(protocol, chipEl) {
    settingsState.providerFilterProtocol = protocol || "all";
    const container = settingsElement("settingsProviderFilters");
    if (container) {
        const chips = container.querySelectorAll(".settings-filter-chip");
        chips.forEach(chip => {
            const match = (chip === chipEl) || (chip.getAttribute("data-protocol") === protocol);
            chip.classList.toggle("is-active", match);
        });
    }
    renderProviderList();
}

async function quickBindCapability(providerId, capability, btnEl) {
    const select = settingsElement(capability === "text" ? "settingsTextProvider" : "settingsImageProvider");
    if (select) {
        select.value = String(providerId);
    }
    await saveCapabilityBinding(capability, btnEl);
}

function renderProviderList() {
    const list = settingsElement("settingsProviderList");
    if (!list) return;

    if (!settingsState.providers.length) {
        list.innerHTML = `
            <div class="settings-empty-state">
                <i class="ph ph-plugs"></i>
                <p>还没有 AI 线路。点击“新增线路”开始配置。</p>
            </div>
        `;
        return;
    }

    let providers = settingsState.providers;
    if (settingsState.providerFilterProtocol && settingsState.providerFilterProtocol !== "all") {
        providers = providers.filter(p => p.protocol === settingsState.providerFilterProtocol);
    }

    if (!providers.length) {
        list.innerHTML = `
            <div class="settings-empty-state">
                <i class="ph ph-funnel"></i>
                <p>未找到符合当前协议筛选条件的线路</p>
            </div>
        `;
        return;
    }

    list.innerHTML = providers.map(provider => {
        const boundCapabilities = boundCapabilitiesForProvider(provider.id);
        const inUse = boundCapabilities.length > 0;
        const isBoundText = boundCapabilities.includes("text");
        const isBoundImage = boundCapabilities.includes("image");

        const capabilityBadges = [
            provider.supports_text
                ? '<span class="settings-badge settings-badge-capability"><i class="ph ph-text-aa"></i> 文本</span>'
                : "",
            provider.supports_image
                ? '<span class="settings-badge settings-badge-capability"><i class="ph ph-image"></i> 图片</span>'
                : "",
            providerImageModeBadgeMarkup(provider),
            ...boundCapabilities.map(capability => `
                <span class="settings-binding-pill ${capability === "text" ? "is-text" : "is-image"}">
                    <i class="ph-bold ph-check"></i>
                    ${capability === "text" ? "文本主线路" : "图片主线路"}
                </span>
            `),
            !provider.enabled
                ? '<span class="settings-badge settings-badge-disabled">已停用</span>'
                : ""
        ].join("");
        const conflictTitle = inUse
            ? "该线路正在使用，请先切换能力绑定"
            : "";
        const protocolClass = `settings-avatar-${provider.protocol || "gemini"}`;
        const modelTags = [
            provider.supports_text && provider.text_model
                ? `<span class="settings-model-tag" title="文本模型: ${escapeSettingsHtml(provider.text_model)}"><i class="ph ph-cpu"></i> ${escapeSettingsHtml(provider.text_model)}</span>`
                : "",
            provider.supports_image && provider.image_model
                ? `<span class="settings-model-tag settings-model-tag-image" title="图片模型: ${escapeSettingsHtml(provider.image_model)}"><i class="ph ph-sparkle"></i> ${escapeSettingsHtml(provider.image_model)}</span>`
                : ""
        ].filter(Boolean).join("");

        const quickBindActions = [
            provider.enabled && provider.supports_text && !isBoundText
                ? `<button type="button" class="settings-provider-action settings-provider-quick-bind"
                    title="设为当前文本 AI 主线路" aria-label="设为文本 AI 主线路"
                    onclick="quickBindCapability(${Number(provider.id)}, 'text', this)">
                    <i class="ph ph-text-aa"></i><span>设为文本主选</span>
                </button>`
                : "",
            provider.enabled && provider.supports_image && !isBoundImage
                ? `<button type="button" class="settings-provider-action settings-provider-quick-bind"
                    title="设为当前图片 AI 主线路" aria-label="设为图片 AI 主线路"
                    onclick="quickBindCapability(${Number(provider.id)}, 'image', this)">
                    <i class="ph ph-image"></i><span>设为图片主选</span>
                </button>`
                : ""
        ].filter(Boolean).join("");

        return `
            <article class="settings-provider-item ${provider.enabled ? "" : "is-disabled"}">
                <div class="settings-provider-main">
                    <div class="settings-provider-heading">
                        <span class="settings-provider-avatar ${protocolClass}">
                            <i class="ph ${providerProtocolIcon(provider.protocol)}"></i>
                        </span>
                        <div>
                            <div class="settings-provider-title-row">
                                <h3 class="settings-provider-name">${escapeSettingsHtml(provider.name)}</h3>
                                ${inUse ? '<span class="settings-active-pulse-dot" title="活跃使用中"></span>' : ''}
                            </div>
                            <div class="settings-provider-subinfo">
                                <span class="settings-provider-protocol">
                                    ${escapeSettingsHtml(SETTINGS_PROTOCOL_LABELS[provider.protocol] || provider.protocol)}
                                </span>
                                ${modelTags}
                            </div>
                        </div>
                    </div>
                    <div class="settings-provider-actions">
                        ${quickBindActions}
                        <button type="button" class="settings-provider-action"
                            title="编辑线路" aria-label="编辑 ${escapeSettingsHtml(provider.name)}"
                            onclick="openProviderEditor(${Number(provider.id)})">
                            <i class="ph ph-pencil-simple"></i>
                        </button>
                        ${providerTestActionsMarkup(provider)}
                        <button type="button" class="settings-provider-action"
                            title="${escapeSettingsHtml(conflictTitle || (provider.enabled ? "停用线路" : "启用线路"))}"
                            aria-label="${provider.enabled ? "停用" : "启用"} ${escapeSettingsHtml(provider.name)}"
                            onclick="toggleProviderEnabled(${Number(provider.id)}, this)"
                            ${inUse && provider.enabled ? "disabled" : ""}>
                            <i class="ph ${provider.enabled ? "ph-pause-circle" : "ph-play-circle"}"></i>
                        </button>
                        <button type="button" class="settings-provider-action is-danger"
                            title="${escapeSettingsHtml(conflictTitle || "删除线路")}"
                            aria-label="删除 ${escapeSettingsHtml(provider.name)}"
                            onclick="deleteProvider(${Number(provider.id)}, this)"
                            ${inUse ? "disabled" : ""}>
                            <i class="ph ph-trash"></i>
                        </button>
                    </div>
                </div>
                <div class="settings-provider-meta">
                    <div class="settings-provider-badges">${capabilityBadges}</div>
                    ${providerTestStatusMarkup(provider)}
                </div>
            </article>
        `;
    }).join("");
    updateSettingsOverviewKpis();
}

function openProviderEditor(id) {
    const numericId = id === undefined || id === null || id === ""
        ? null
        : Number(id);
    const provider = numericId === null
        ? null
        : settingsState.providers.find(item => Number(item.id) === numericId);

    if (numericId !== null && !provider) {
        settingsToast("未找到要编辑的 AI 线路", "error");
        return;
    }

    settingsState.editingProviderId = provider?.id ?? null;
    settingsElement("settingsProviderId").value = provider?.id ?? "";
    settingsElement("settingsEditorTitle").textContent = provider ? "编辑 AI 线路" : "新增 AI 线路";
    settingsElement("settingsProviderName").value = provider?.name || "";
    settingsElement("settingsProviderProtocol").value = provider?.protocol || "gemini";
    settingsElement("settingsProviderBaseUrl").value = provider?.base_url || "";

    const apiKey = settingsElement("settingsProviderApiKey");
    apiKey.value = "";
    apiKey.placeholder = provider
        ? maskedKeyPlaceholder(provider)
        : "输入 API Key";

    const hasVertexCredentials = provider?.has_vertex_credentials === true;
    [
        ["settingsVertexProjectId", "Google Cloud Project ID"],
        ["settingsVertexLocation", "例如：us-central1"],
        ["settingsVertexKeyPath", "/path/to/service-account.json"]
    ].forEach(([fieldId, defaultPlaceholder]) => {
        const field = settingsElement(fieldId);
        field.value = "";
        field.placeholder = hasVertexCredentials
            ? "已保存，留空表示保留"
            : defaultPlaceholder;
    });

    settingsElement("settingsTextModel").value = provider?.text_model || "";
    settingsElement("settingsImageModel").value = provider?.image_model || "";
    settingsElement("settingsImageGenerationMode").value =
        provider?.image_generation_mode || "image_to_image";
    settingsElement("settingsSupportsText").checked = provider?.supports_text ?? true;
    settingsElement("settingsSupportsImage").checked = provider?.supports_image ?? false;
    settingsElement("settingsTimeoutSeconds").value = provider?.timeout_seconds ?? 60;
    settingsElement("settingsMaxRetries").value = provider?.max_retries ?? 2;
    settingsElement("settingsProviderEnabled").checked = provider?.enabled ?? true;

    const result = settingsElement("settingsTestResult");
    result.textContent = "";
    result.className = "settings-test-result";

    updateProviderProtocolFields();
    updateProviderCapabilityFields();
    settingsElement("settingsProviderEditor").classList.remove("hidden");
    window.setTimeout(() => settingsElement("settingsProviderName")?.focus(), 0);
}

function closeProviderEditor() {
    settingsElement("settingsProviderEditor")?.classList.add("hidden");
}

function updateProviderProtocolFields() {
    const protocol = settingsElement("settingsProviderProtocol")?.value || "gemini";
    const isVertex = protocol === "vertex";
    const isOpenAI = protocol === "openai_compatible";

    settingsElement("settingsApiKeyFields")?.classList.toggle("hidden", isVertex);
    settingsElement("settingsOpenAiFields")?.classList.toggle("hidden", !isOpenAI);
    settingsElement("settingsVertexFields")?.classList.toggle("hidden", !isVertex);

    const baseUrl = settingsElement("settingsProviderBaseUrl");
    if (baseUrl) baseUrl.required = isOpenAI;
    updateProviderImageGenerationModeField();
}

function updateProviderImageGenerationModeField() {
    const protocol = settingsElement("settingsProviderProtocol")?.value || "gemini";
    const supportsImage = settingsElement("settingsSupportsImage")?.checked === true;
    const visible = shouldShowImageGenerationMode(protocol, supportsImage);
    settingsElement("settingsImageGenerationModeFields")?.classList.toggle(
        "hidden",
        !visible
    );
    const select = settingsElement("settingsImageGenerationMode");
    if (select) select.disabled = !visible;
}

function updateProviderCapabilityFields() {
    const supportsText = settingsElement("settingsSupportsText")?.checked === true;
    const supportsImage = settingsElement("settingsSupportsImage")?.checked === true;
    const textModel = settingsElement("settingsTextModel");
    const imageModel = settingsElement("settingsImageModel");
    const textField = settingsElement("settingsTextModelField");
    const imageField = settingsElement("settingsImageModelField");
    const testCapability = settingsElement("settingsTestCapability");
    const testButton = settingsElement("settingsTestProviderButton");

    if (textModel) textModel.disabled = !supportsText;
    if (imageModel) imageModel.disabled = !supportsImage;
    textField?.classList.toggle("settings-field-muted", !supportsText);
    imageField?.classList.toggle("settings-field-muted", !supportsImage);

    if (testCapability) {
        const textOption = testCapability.querySelector('option[value="text"]');
        const imageOption = testCapability.querySelector('option[value="image"]');
        if (textOption) textOption.disabled = !supportsText;
        if (imageOption) imageOption.disabled = !supportsImage;
        if (supportsText) {
            testCapability.value = "text";
        } else if (supportsImage) {
            testCapability.value = "image";
        }
    }
    if (testButton) testButton.disabled = !supportsText && !supportsImage;
    updateProviderImageGenerationModeField();
}

function providerFormValues() {
    return {
        name: settingsElement("settingsProviderName").value,
        protocol: settingsElement("settingsProviderProtocol").value,
        base_url: settingsElement("settingsProviderBaseUrl").value,
        api_key: settingsElement("settingsProviderApiKey").value,
        vertex_project_id: settingsElement("settingsVertexProjectId").value,
        vertex_location: settingsElement("settingsVertexLocation").value,
        vertex_key_path: settingsElement("settingsVertexKeyPath").value,
        text_model: settingsElement("settingsTextModel").value,
        image_model: settingsElement("settingsImageModel").value,
        image_generation_mode: settingsElement("settingsImageGenerationMode").value,
        supports_text: settingsElement("settingsSupportsText").checked,
        supports_image: settingsElement("settingsSupportsImage").checked,
        timeout_seconds: settingsElement("settingsTimeoutSeconds").value,
        max_retries: settingsElement("settingsMaxRetries").value,
        enabled: settingsElement("settingsProviderEnabled").checked
    };
}

function providerFormPayload() {
    const values = providerFormValues();
    const payload = buildProviderPayload(values);

    if (payload.protocol !== "openai_compatible") {
        payload.base_url = null;
    }
    if (payload.protocol !== "vertex") {
        payload.vertex_project_id = null;
        payload.vertex_location = null;
        payload.vertex_key_path = null;
    }
    if (payload.protocol === "vertex") {
        payload.api_key = null;
    }
    return payload;
}

function validateProviderPayload(payload) {
    if (!payload.name) return "请输入线路名称";
    if (!payload.supports_text && !payload.supports_image) {
        return "请至少启用一种 AI 能力";
    }
    if (payload.supports_text && !payload.text_model) {
        return "启用文本能力时必须填写文本模型";
    }
    if (payload.supports_image && !payload.image_model) {
        return "启用图片能力时必须填写图片模型";
    }
    if (payload.protocol === "openai_compatible" && !payload.base_url) {
        return "OpenAI Compatible 线路必须填写 Base URL";
    }
    return "";
}

function preserveBlankSecretsOnEdit(payload) {
    if (settingsState.editingProviderId === null) return payload;
    [
        "api_key",
        "vertex_project_id",
        "vertex_location",
        "vertex_key_path"
    ].forEach(field => {
        if (payload[field] === null) delete payload[field];
    });
    return payload;
}

async function saveProvider(event) {
    event?.preventDefault();
    const form = settingsElement("settingsProviderForm");
    if (form && !form.reportValidity()) return;

    const payload = preserveBlankSecretsOnEdit(providerFormPayload());
    const validationError = validateProviderPayload(payload);
    if (validationError) {
        settingsToast(validationError, "error");
        return;
    }

    const button = event?.submitter || settingsElement("settingsSaveProviderButton");
    const providerId = settingsState.editingProviderId;
    const url = providerId === null
        ? `${API_BASE}/api/settings/ai/providers`
        : `${API_BASE}/api/settings/ai/providers/${providerId}`;
    setSettingsButtonBusy(button, true);
    let savedProvider;
    try {
        savedProvider = await settingsRequest(url, {
            method: providerId === null ? "POST" : "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
    } catch (error) {
        settingsToast(error.message, "error");
        setSettingsButtonBusy(button, false);
        return;
    }

    applyLocalProvider(savedProvider);
    settingsToast(providerId === null ? "AI 线路已创建" : "AI 线路已保存", "success");
    await refreshSettingsAfterSuccess(savedProvider);
    setSettingsButtonBusy(button, false);
    closeProviderEditor();
}

async function testProviderConnection(button) {
    const capability = settingsElement("settingsTestCapability")?.value || "text";
    const payload = providerFormPayload();
    const validationError = validateProviderPayload(payload);
    if (validationError) {
        settingsToast(validationError, "error");
        return;
    }

    const requestBody = buildProviderTestRequestBody(
        settingsState.editingProviderId,
        payload,
        capability
    );
    const resultElement = settingsElement("settingsTestResult");
    setSettingsButtonBusy(button, true);
    if (resultElement) {
        resultElement.textContent = settingsState.editingProviderId === null
            ? "正在测试当前表单配置…"
            : "正在测试当前编辑配置…";
        resultElement.className = "settings-test-result";
    }

    let data;
    try {
        data = await settingsRequest(`${API_BASE}/api/settings/ai/providers/test`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody)
        });
    } catch (error) {
        if (resultElement) {
            resultElement.textContent = error.message;
            resultElement.className = "settings-test-result is-error";
        }
        settingsToast(error.message, "error");
        setSettingsButtonBusy(button, false);
        return;
    }

    const success = data.status === "success";
    const message = `${data.message}（${data.duration_ms} ms）`;
    if (resultElement) {
        resultElement.textContent = message;
        resultElement.className = `settings-test-result ${success ? "is-success" : "is-error"}`;
    }
    settingsToast(message, success ? "success" : "error");
    await refreshSettingsAfterSuccess(data);
    setSettingsButtonBusy(button, false);
}

async function testSavedProvider(providerId, capability, button) {
    if (!capability) {
        settingsToast("该线路未声明可测试能力", "error");
        return;
    }
    setSettingsButtonBusy(button, true);
    let data;
    try {
        data = await settingsRequest(`${API_BASE}/api/settings/ai/providers/test`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                provider_id: Number(providerId),
                capability
            })
        });
    } catch (error) {
        settingsToast(error.message, "error");
        setSettingsButtonBusy(button, false);
        return;
    }

    const message = `${data.message}（${data.duration_ms} ms）`;
    settingsToast(message, data.status === "success" ? "success" : "error");
    await refreshSettingsAfterSuccess(data);
    setSettingsButtonBusy(button, false);
}

async function saveCapabilityBinding(capability, button) {
    const select = settingsElement(
        capability === "text" ? "settingsTextProvider" : "settingsImageProvider"
    );
    const providerId = Number(select?.value);
    if (!providerId) {
        settingsToast(`请选择${capability === "text" ? "文本" : "图片"} AI 线路`, "error");
        return;
    }

    setSettingsButtonBusy(button, true);
    let savedBinding;
    try {
        savedBinding = await settingsRequest(`${API_BASE}/api/settings/ai/bindings/${capability}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ provider_config_id: providerId })
        });
    } catch (error) {
        settingsToast(error.message, "error");
        setSettingsButtonBusy(button, false);
        return;
    }

    applyLocalBinding(savedBinding);
    settingsToast(`${capability === "text" ? "文本" : "图片"}能力线路已切换`, "success");
    await refreshSettingsAfterSuccess(savedBinding);
    setSettingsButtonBusy(button, false);
}

async function toggleProviderEnabled(providerId, button) {
    const provider = settingsState.providers
        .find(item => Number(item.id) === Number(providerId));
    if (!provider) {
        settingsToast("AI 线路不存在", "error");
        return;
    }

    const action = provider.enabled ? "disable" : "enable";
    setSettingsButtonBusy(button, true);
    let updatedProvider;
    try {
        updatedProvider = await settingsRequest(
            `${API_BASE}/api/settings/ai/providers/${providerId}/${action}`,
            { method: "POST" }
        );
    } catch (error) {
        // 409 detail is surfaced verbatim; current bindings and editor selection remain untouched.
        settingsToast(error.message, "error");
        setSettingsButtonBusy(button, false);
        return;
    }

    applyLocalProvider(updatedProvider);
    settingsToast(provider.enabled ? "AI 线路已停用" : "AI 线路已启用", "success");
    await refreshSettingsAfterSuccess(updatedProvider);
    setSettingsButtonBusy(button, false);
}

async function deleteProvider(providerId, button) {
    const provider = settingsState.providers
        .find(item => Number(item.id) === Number(providerId));
    if (!provider) {
        settingsToast("AI 线路不存在", "error");
        return;
    }
    if (!window.confirm(`确定删除线路“${provider.name}”吗？此操作无法撤销。`)) {
        return;
    }

    setSettingsButtonBusy(button, true);
    let result;
    try {
        result = await settingsRequest(
            `${API_BASE}/api/settings/ai/providers/${providerId}`,
            { method: "DELETE" }
        );
    } catch (error) {
        // 409 detail is surfaced verbatim; current bindings and editor selection remain untouched.
        settingsToast(error.message, "error");
        setSettingsButtonBusy(button, false);
        return;
    }

    removeLocalProvider(providerId);
    settingsToast("AI 线路已删除", "success");
    await refreshSettingsAfterSuccess(result);
    setSettingsButtonBusy(button, false);
}

function renderCrawlerSettingsBadge(crawler = settingsState.crawler) {
    const badgeEl = settingsElement("settingsCrawlerStatusBadge");
    if (!badgeEl) return;

    if (!crawler || !crawler.has_api_key) {
        badgeEl.innerHTML = '<span class="settings-badge settings-badge-disabled"><i class="ph ph-warning"></i> 未配置</span>';
    } else if (crawler.last_test_status === "success") {
        badgeEl.innerHTML = '<span class="settings-badge settings-badge-enabled"><i class="ph ph-check-circle"></i> 已就绪</span>';
    } else if (crawler.last_test_status === "error" || crawler.last_test_status === "failed") {
        badgeEl.innerHTML = '<span class="settings-badge settings-badge-warning" style="background:#fee2e2;color:#b91c1c;"><i class="ph ph-x-circle"></i> 连接异常</span>';
    } else {
        badgeEl.innerHTML = '<span class="settings-badge settings-badge-enabled"><i class="ph ph-check"></i> 已配置</span>';
    }
}

function renderCrawlerSettings(crawler = settingsState.crawler) {
    renderCrawlerSettingsBadge(crawler);

    const keyInput = settingsElement("settingsFirecrawlApiKey");
    if (keyInput) {
        keyInput.value = "";
        keyInput.placeholder = maskedCrawlerKeyPlaceholder(crawler);
    }

    const urlInput = settingsElement("settingsFirecrawlApiUrl");
    if (urlInput) {
        urlInput.value = crawler?.api_url || "https://api.firecrawl.dev/v1/scrape";
    }

    const msgEl = settingsElement("settingsCrawlerTestMsg");
    if (msgEl) {
        if (crawler?.last_test_message) {
            const isSuccess = crawler.last_test_status === "success";
            const timeStr = crawler.last_tested_at ? ` [${crawler.last_tested_at}]` : "";
            msgEl.textContent = `${isSuccess ? "✓ " : "✗ "}${crawler.last_test_message}${timeStr}`;
            msgEl.className = `settings-crawler-test-msg ${isSuccess ? "is-success" : "is-error"}`;
        } else {
            msgEl.textContent = "";
            msgEl.className = "settings-crawler-test-msg";
        }
    }
    updateSettingsOverviewKpis();
}

function toggleFirecrawlKeyVisibility() {
    const input = settingsElement("settingsFirecrawlApiKey");
    const icon = settingsElement("settingsFirecrawlKeyEyeIcon");
    if (!input) return;
    if (input.type === "password") {
        input.type = "text";
        if (icon) icon.className = "ph ph-eye-slash";
    } else {
        input.type = "password";
        if (icon) icon.className = "ph ph-eye";
    }
}

async function testCrawlerConnection(button) {
    const keyInput = settingsElement("settingsFirecrawlApiKey");
    const urlInput = settingsElement("settingsFirecrawlApiUrl");
    const msgEl = settingsElement("settingsCrawlerTestMsg");

    const apiKey = keyInput ? keyInput.value.trim() : "";
    const apiUrl = urlInput ? urlInput.value.trim() : "";

    const payload = {
        api_key: apiKey || null,
        api_url: apiUrl || "https://api.firecrawl.dev/v1/scrape"
    };

    setSettingsButtonBusy(button, true);
    if (msgEl) {
        msgEl.textContent = "正在测试连接 Firecrawl…";
        msgEl.className = "settings-crawler-test-msg";
    }

    let result;
    try {
        result = await settingsRequest(`${API_BASE}/api/settings/crawler/test`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
    } catch (error) {
        if (msgEl) {
            msgEl.textContent = `✗ ${error.message}`;
            msgEl.className = "settings-crawler-test-msg is-error";
        }
        settingsToast(error.message, "error");
        setSettingsButtonBusy(button, false);
        return;
    }

    const durationText = result.duration_ms ? `（${result.duration_ms} ms）` : "";
    const fullMsg = `${result.message}${durationText}`;

    if (result.ok) {
        if (msgEl) {
            msgEl.textContent = `✓ ${fullMsg}`;
            msgEl.className = "settings-crawler-test-msg is-success";
        }
        if (settingsState.crawler) {
            settingsState.crawler.last_test_status = "success";
            settingsState.crawler.last_test_message = fullMsg;
        }
        renderCrawlerSettingsBadge(settingsState.crawler);
        settingsToast(fullMsg, "success");
    } else {
        if (msgEl) {
            msgEl.textContent = `✗ ${fullMsg}`;
            msgEl.className = "settings-crawler-test-msg is-error";
        }
        if (settingsState.crawler) {
            settingsState.crawler.last_test_status = "error";
            settingsState.crawler.last_test_message = fullMsg;
        }
        renderCrawlerSettingsBadge(settingsState.crawler);
        settingsToast(fullMsg, "error");
    }
    setSettingsButtonBusy(button, false);
}

async function saveCrawlerSettings(button) {
    const keyInput = settingsElement("settingsFirecrawlApiKey");
    const urlInput = settingsElement("settingsFirecrawlApiUrl");

    const apiKey = keyInput ? keyInput.value.trim() : "";
    const apiUrl = urlInput ? urlInput.value.trim() : "";

    const payload = buildCrawlerPayload({
        api_key: apiKey,
        api_url: apiUrl
    });

    setSettingsButtonBusy(button, true);
    let result;
    try {
        result = await settingsRequest(`${API_BASE}/api/settings/crawler`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
    } catch (error) {
        settingsToast(error.message, "error");
        setSettingsButtonBusy(button, false);
        return;
    }

    settingsState.crawler = result;
    renderCrawlerSettings(result);
    settingsToast("Firecrawl 配置已保存", "success");
    setSettingsButtonBusy(button, false);
}

/* ==========================================================================
   多目标云存储图床托管管理 (WordPress / Shopify / Cloudflare R2)
   ========================================================================== */

function getSettingsStorageConfigs() {
    return Array.isArray(settingsState.storageConfigs) ? settingsState.storageConfigs : [];
}

function formatStorageDisplayLabel(name, targetUrlOrDomain, fallback = "未命名") {
    if (typeof window !== "undefined" && typeof window.formatStorageDisplayLabel === "function" && window.formatStorageDisplayLabel !== formatStorageDisplayLabel) {
        return window.formatStorageDisplayLabel(name, targetUrlOrDomain, fallback);
    }
    const rawName = (name || "").trim();
    const rawTarget = (targetUrlOrDomain || "").trim();

    if (!rawName && !rawTarget) {
        return fallback;
    }
    if (!rawTarget) {
        return rawName || fallback;
    }
    if (!rawName) {
        return rawTarget;
    }

    const cleanTarget = rawTarget.replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
    const cleanName = rawName.replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
    if (cleanName === cleanTarget) {
        return rawTarget;
    }

    if (rawName.includes(rawTarget) || (cleanTarget && cleanName.includes(cleanTarget))) {
        return rawName;
    }

    return `${rawName} (${rawTarget})`;
}

function renderStorageIntegrations(configs = settingsState.storageConfigs) {
    const list = Array.isArray(configs) ? configs : [];
    const wpConfigs = list.filter(c => c.storage_type === "wordpress");
    const shopifyConfigs = list.filter(c => c.storage_type === "shopify");
    const r2Config = list.find(c => c.storage_type === "r2");

    // 1. WordPress 卡片
    const wpStatusEl = settingsElement("settingsStorageStatusWp");
    const wpSummaryEl = settingsElement("settingsStorageSummaryWp");
    if (wpStatusEl) {
        if (wpConfigs.length > 0) {
            wpStatusEl.className = "settings-badge settings-badge-enabled";
            wpStatusEl.textContent = `已配置 ${wpConfigs.length} 个站点`;
        } else {
            wpStatusEl.className = "settings-badge settings-badge-neutral";
            wpStatusEl.textContent = "未配置";
        }
    }
    if (wpSummaryEl) {
        if (wpConfigs.length > 0) {
            const defWp = wpConfigs.find(c => c.is_default) || wpConfigs[0];
            const wpLabel = formatStorageDisplayLabel(defWp.name, defWp.wp_url, "未命名站点");
            wpSummaryEl.textContent = `默认: ${wpLabel}`;
            wpSummaryEl.title = wpConfigs.map(c => `${c.is_default ? "★ " : ""}${formatStorageDisplayLabel(c.name, c.wp_url, "未命名站点")}`).join("\n");
        } else {
            wpSummaryEl.textContent = "尚未添加 WordPress 独立站";
            wpSummaryEl.title = "";
        }
    }

    // 2. Shopify 卡片
    const shopifyStatusEl = settingsElement("settingsStorageStatusShopify");
    const shopifySummaryEl = settingsElement("settingsStorageSummaryShopify");
    if (shopifyStatusEl) {
        if (shopifyConfigs.length > 0) {
            shopifyStatusEl.className = "settings-badge settings-badge-enabled";
            shopifyStatusEl.textContent = `已配置 ${shopifyConfigs.length} 个店铺`;
        } else {
            shopifyStatusEl.className = "settings-badge settings-badge-neutral";
            shopifyStatusEl.textContent = "未配置";
        }
    }
    if (shopifySummaryEl) {
        if (shopifyConfigs.length > 0) {
            const defShop = shopifyConfigs.find(c => c.is_default) || shopifyConfigs[0];
            const shopLabel = formatStorageDisplayLabel(defShop.name, defShop.shopify_shop_domain, "未命名店铺");
            shopifySummaryEl.textContent = `默认: ${shopLabel}`;
            shopifySummaryEl.title = shopifyConfigs.map(c => `${c.is_default ? "★ " : ""}${formatStorageDisplayLabel(c.name, c.shopify_shop_domain, "未命名店铺")}`).join("\n");
        } else {
            shopifySummaryEl.textContent = "尚未添加 Shopify 店铺";
            shopifySummaryEl.title = "";
        }
    }

    // 3. Cloudflare R2 卡片
    const r2StatusEl = settingsElement("settingsStorageStatusR2");
    const r2SummaryEl = settingsElement("settingsStorageSummaryR2");
    if (r2StatusEl) {
        if (r2Config && (r2Config.r2_bucket_name || r2Config.r2_account_id)) {
            r2StatusEl.className = "settings-badge settings-badge-enabled";
            r2StatusEl.textContent = "已配置";
        } else {
            r2StatusEl.className = "settings-badge settings-badge-neutral";
            r2StatusEl.textContent = "未配置";
        }
    }
    if (r2SummaryEl) {
        if (r2Config && (r2Config.r2_bucket_name || r2Config.r2_account_id)) {
            const bkt = r2Config.r2_bucket_name || "未命名Bucket";
            const pub = r2Config.r2_public_url ? ` · CDN: ${r2Config.r2_public_url}` : "";
            r2SummaryEl.textContent = `Bucket: ${bkt}${pub}`;
            r2SummaryEl.title = `Account: ${r2Config.r2_account_id || "-"}\nBucket: ${bkt}\nCDN: ${r2Config.r2_public_url || "-"}`;
        } else {
            r2SummaryEl.textContent = "尚未配置 R2 Bucket 与密钥";
            r2SummaryEl.title = "";
        }
    }

    // 卡片统计计数
    const countBadge = settingsElement("settingsStorageCardCountBadge");
    if (countBadge) {
        const total = wpConfigs.length + shopifyConfigs.length + (r2Config && (r2Config.r2_bucket_name || r2Config.r2_account_id) ? 1 : 0);
        countBadge.textContent = total > 0 ? `已配置 ${total} 个存储源` : "多目标驱动已就绪";
    }
}

function openStorageEditor(storageType = "wordpress", configId = null) {
    const editor = settingsElement("settingsStorageEditor");
    if (!editor) return;

    settingsState.activeStorageTarget = ["wordpress", "shopify", "r2"].includes(storageType)
        ? storageType
        : "wordpress";

    refreshSettingsStorageEditorView(configId);
    editor.classList.remove("hidden");
}

function closeStorageEditor() {
    const editor = settingsElement("settingsStorageEditor");
    if (editor) editor.classList.add("hidden");
    const testMsg = settingsElement("settingsStorageTestMsg");
    if (testMsg) {
        testMsg.textContent = "尚未进行连通性测试";
        testMsg.className = "settings-test-result";
    }
}

function switchStorageEditorTab(type) {
    settingsState.activeStorageTarget = ["wordpress", "shopify", "r2"].includes(type)
        ? type
        : "wordpress";
    refreshSettingsStorageEditorView();
}

function refreshSettingsStorageEditorView(targetConfigId = null) {
    const type = settingsState.activeStorageTarget || "wordpress";
    const configs = getSettingsStorageConfigs();

    // 切换 Tab 按钮激活态与面板显隐
    ["wordpress", "shopify", "r2"].forEach(t => {
        const cap = t === "wordpress" ? "Wp" : (t === "shopify" ? "Shopify" : "R2");
        const btn = settingsElement(`btnSettingsStorageTab${cap}`);
        const panel = settingsElement(`settingsStorage${cap}Panel`);
        if (btn) btn.classList.toggle("is-active", t === type);
        if (panel) panel.classList.toggle("hidden", t !== type);
    });

    const testMsg = settingsElement("settingsStorageTestMsg");
    if (testMsg) {
        testMsg.textContent = "尚未进行连通性测试";
        testMsg.className = "settings-test-result";
    }

    if (type === "wordpress") {
        const wpConfigs = configs.filter(c => c.storage_type === "wordpress");
        const select = settingsElement("settingsWpSelect");
        if (select) {
            let optionsHtml = "";
            wpConfigs.forEach(cfg => {
                const display = formatStorageDisplayLabel(cfg.name, cfg.wp_url, "未命名站点");
                const label = `${cfg.is_default ? "★ " : ""}${display}`;
                optionsHtml += `<option value="${cfg.id}">${escapeSettingsHtml(label)}</option>`;
            });
            optionsHtml += '<option value="0">+ 新增 WordPress 站点</option>';
            select.innerHTML = optionsHtml;
        }

        let selected = null;
        if (targetConfigId && wpConfigs.some(c => c.id === targetConfigId)) {
            selected = wpConfigs.find(c => c.id === targetConfigId);
        } else if (settingsState.activeWpConfigId && wpConfigs.some(c => c.id === settingsState.activeWpConfigId)) {
            selected = wpConfigs.find(c => c.id === settingsState.activeWpConfigId);
        } else {
            selected = wpConfigs.find(c => c.is_default) || wpConfigs[0] || null;
        }

        if (selected) {
            settingsState.activeWpConfigId = selected.id;
            if (select) select.value = String(selected.id);
            fillSettingsWpForm(selected);
        } else {
            addNewSettingsWpSite();
        }
    } else if (type === "shopify") {
        const shopifyConfigs = configs.filter(c => c.storage_type === "shopify");
        const select = settingsElement("settingsShopifySelect");
        if (select) {
            let optionsHtml = "";
            shopifyConfigs.forEach(cfg => {
                const display = formatStorageDisplayLabel(cfg.name, cfg.shopify_shop_domain, "未命名店铺");
                const label = `${cfg.is_default ? "★ " : ""}${display}`;
                optionsHtml += `<option value="${cfg.id}">${escapeSettingsHtml(label)}</option>`;
            });
            optionsHtml += '<option value="0">+ 新增 Shopify 店铺</option>';
            select.innerHTML = optionsHtml;
        }

        let selected = null;
        if (targetConfigId && shopifyConfigs.some(c => c.id === targetConfigId)) {
            selected = shopifyConfigs.find(c => c.id === targetConfigId);
        } else if (settingsState.activeShopifyConfigId && shopifyConfigs.some(c => c.id === settingsState.activeShopifyConfigId)) {
            selected = shopifyConfigs.find(c => c.id === settingsState.activeShopifyConfigId);
        } else {
            selected = shopifyConfigs.find(c => c.is_default) || shopifyConfigs[0] || null;
        }

        if (selected) {
            settingsState.activeShopifyConfigId = selected.id;
            if (select) select.value = String(selected.id);
            fillSettingsShopifyForm(selected);
        } else {
            addNewSettingsShopifyStore();
        }
    } else {
        const r2Config = configs.find(c => c.storage_type === "r2");
        fillSettingsR2Form(r2Config);
    }
}

function fillSettingsWpForm(cfg) {
    const nameInput = settingsElement("settingsWpName");
    const urlInput = settingsElement("settingsWpUrl");
    const userInput = settingsElement("settingsWpUsername");
    const passInput = settingsElement("settingsWpAppPassword");

    if (nameInput) nameInput.value = cfg?.name || "";
    if (urlInput) urlInput.value = cfg?.wp_url || "";
    if (userInput) userInput.value = cfg?.wp_username || "";
    if (passInput) {
        passInput.value = "";
        passInput.placeholder = cfg?.has_wp_app_password
            ? "•••••••• (已保存，留空则保持不变)"
            : "在WP用户个人资料中生成";
    }
}

function onSettingsWpSelectChange(val) {
    const id = parseInt(val, 10);
    if (!id || id === 0) {
        addNewSettingsWpSite();
        return;
    }
    settingsState.activeWpConfigId = id;
    const cfg = getSettingsStorageConfigs().find(c => c.id === id);
    fillSettingsWpForm(cfg);
}

function addNewSettingsWpSite() {
    settingsState.activeWpConfigId = 0;
    const select = settingsElement("settingsWpSelect");
    if (select) select.value = "0";
    fillSettingsWpForm({ name: "", wp_url: "", wp_username: "", has_wp_app_password: false });
    if (typeof window !== "undefined") {
        setTimeout(() => settingsElement("settingsWpName")?.focus?.(), 50);
    }
}

function addNewSettingsWpSiteFromCard() {
    openStorageEditor("wordpress");
    addNewSettingsWpSite();
}

async function deleteCurrentSettingsWpSite() {
    const id = settingsState.activeWpConfigId;
    if (!id || id === 0) {
        settingsToast("请先选择要删除的已保存 WordPress 站点", "warning");
        return;
    }
    const currentCfg = getSettingsStorageConfigs().find(c => c.id === id);
    const siteName = currentCfg?.name || currentCfg?.wp_url || "当前站点";
    if (typeof confirm === "function" && !confirm(`确定要删除 WordPress 站点 [${siteName}] 吗？`)) {
        return;
    }

    try {
        await settingsRequest(`${API_BASE}/api/storage/config/${id}`, { method: "DELETE" });
        settingsToast(`站点 [${siteName}] 已删除`, "success");
        settingsState.activeWpConfigId = 0;
        await reloadSettingsStorageConfigs();
        refreshSettingsStorageEditorView();
        syncWithDetailsModule();
    } catch (err) {
        settingsToast(`删除失败：${err.message}`, "error");
    }
}

function fillSettingsShopifyForm(cfg) {
    const nameInput = settingsElement("settingsShopifyName");
    const domainInput = settingsElement("settingsShopifyDomain");
    const tokenInput = settingsElement("settingsShopifyAccessToken");

    if (nameInput) nameInput.value = cfg?.name || "";
    if (domainInput) domainInput.value = cfg?.shopify_shop_domain || "";
    if (tokenInput) {
        tokenInput.value = "";
        tokenInput.placeholder = cfg?.has_shopify_token
            ? "•••••••• (已保存，留空则保持不变)"
            : "shpat_xxxxxxxxxxxx";
    }
}

function onSettingsShopifySelectChange(val) {
    const id = parseInt(val, 10);
    if (!id || id === 0) {
        addNewSettingsShopifyStore();
        return;
    }
    settingsState.activeShopifyConfigId = id;
    const cfg = getSettingsStorageConfigs().find(c => c.id === id);
    fillSettingsShopifyForm(cfg);
}

function addNewSettingsShopifyStore() {
    settingsState.activeShopifyConfigId = 0;
    const select = settingsElement("settingsShopifySelect");
    if (select) select.value = "0";
    fillSettingsShopifyForm({ name: "", shopify_shop_domain: "", has_shopify_token: false });
    if (typeof window !== "undefined") {
        setTimeout(() => settingsElement("settingsShopifyName")?.focus?.(), 50);
    }
}

function addNewSettingsShopifyStoreFromCard() {
    openStorageEditor("shopify");
    addNewSettingsShopifyStore();
}

async function deleteCurrentSettingsShopifyStore() {
    const id = settingsState.activeShopifyConfigId;
    if (!id || id === 0) {
        settingsToast("请先选择要删除的已保存 Shopify 店铺", "warning");
        return;
    }
    const currentCfg = getSettingsStorageConfigs().find(c => c.id === id);
    const storeName = currentCfg?.name || currentCfg?.shopify_shop_domain || "当前店铺";
    if (typeof confirm === "function" && !confirm(`确定要删除 Shopify 店铺 [${storeName}] 吗？`)) {
        return;
    }

    try {
        await settingsRequest(`${API_BASE}/api/storage/config/${id}`, { method: "DELETE" });
        settingsToast(`店铺 [${storeName}] 已删除`, "success");
        settingsState.activeShopifyConfigId = 0;
        await reloadSettingsStorageConfigs();
        refreshSettingsStorageEditorView();
        syncWithDetailsModule();
    } catch (err) {
        settingsToast(`删除失败：${err.message}`, "error");
    }
}

function fillSettingsR2Form(cfg) {
    const accInput = settingsElement("settingsR2AccountId");
    const keyInput = settingsElement("settingsR2AccessKeyId");
    const secInput = settingsElement("settingsR2SecretKey");
    const bktInput = settingsElement("settingsR2BucketName");
    const pubInput = settingsElement("settingsR2PublicUrl");
    const pfxInput = settingsElement("settingsR2PathPrefix");

    if (accInput) accInput.value = cfg?.r2_account_id || "";
    if (keyInput) keyInput.value = cfg?.r2_access_key_id || "";
    if (secInput) {
        secInput.value = "";
        secInput.placeholder = cfg?.has_r2_secret
            ? "•••••••• (已保存，留空则保持不变)"
            : "••••••••";
    }
    if (bktInput) bktInput.value = cfg?.r2_bucket_name || "";
    if (pubInput) pubInput.value = cfg?.r2_public_url || "";
    if (pfxInput) pfxInput.value = cfg?.r2_path_prefix || "pdp/";
}

async function reloadSettingsStorageConfigs() {
    try {
        const configs = await settingsRequest(`${API_BASE}/api/storage/configs`);
        settingsState.storageConfigs = Array.isArray(configs) ? configs : [];
        renderStorageIntegrations();
    } catch (err) {
        console.warn("Failed to reload storage configs:", err);
    }
}

function syncWithDetailsModule() {
    if (typeof window !== "undefined" && typeof window.loadStorageConfigsToModal === "function") {
        try { window.loadStorageConfigsToModal(); } catch (e) {}
    }
}

async function testSettingsStorageConnection(button) {
    const type = settingsState.activeStorageTarget || "wordpress";
    const msgEl = settingsElement("settingsStorageTestMsg");
    let payload;

    if (type === "wordpress") {
        const wpUrl = settingsElement("settingsWpUrl")?.value?.trim() || "";
        const wpUsername = settingsElement("settingsWpUsername")?.value?.trim() || "";
        const wpAppPassword = settingsElement("settingsWpAppPassword")?.value?.trim() || "";
        const currentCfg = getSettingsStorageConfigs().find(c => c.id === settingsState.activeWpConfigId);

        if (!wpUrl) {
            settingsToast("请先输入 WordPress 网站地址", "warning");
            if (msgEl) {
                msgEl.textContent = "⚠️ 请先输入 WordPress 网站完整地址";
                msgEl.className = "settings-test-result is-error";
            }
            return;
        }
        if (!wpUsername) {
            settingsToast("请先输入 WordPress 用户名", "warning");
            if (msgEl) {
                msgEl.textContent = "⚠️ 请先输入 WordPress 管理员或作者用户名";
                msgEl.className = "settings-test-result is-error";
            }
            return;
        }
        if (!wpAppPassword && !currentCfg?.has_wp_app_password) {
            settingsToast("请先输入 WordPress 应用程序密码", "warning");
            if (msgEl) {
                msgEl.textContent = "⚠️ 请先输入 WordPress 应用程序密码";
                msgEl.className = "settings-test-result is-error";
            }
            return;
        }

        const wpConfig = {
            id: settingsState.activeWpConfigId > 0 ? settingsState.activeWpConfigId : null,
            storage_type: "wordpress",
            name: settingsElement("settingsWpName")?.value?.trim() || "",
            enabled: true,
            wp_url: wpUrl,
            wp_username: wpUsername,
            wp_app_password: wpAppPassword
        };
        payload = {
            config_id: settingsState.activeWpConfigId > 0 ? settingsState.activeWpConfigId : null,
            ...wpConfig,
            config_override: wpConfig
        };
    } else if (type === "shopify") {
        const rawDomain = settingsElement("settingsShopifyDomain")?.value?.trim() || "";
        const shopDomain = rawDomain.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").trim();
        const shopToken = settingsElement("settingsShopifyAccessToken")?.value?.trim() || "";
        const currentCfg = getSettingsStorageConfigs().find(c => c.id === settingsState.activeShopifyConfigId);

        if (!shopDomain) {
            settingsToast("请先输入 Shopify 店铺域名", "warning");
            if (msgEl) {
                msgEl.textContent = "⚠️ 请先输入 Shopify 店铺域名 (myshopify.com)";
                msgEl.className = "settings-test-result is-error";
            }
            return;
        }
        if (!shopToken && !currentCfg?.has_shopify_token) {
            settingsToast("请先输入 Shopify Admin API Access Token", "warning");
            if (msgEl) {
                msgEl.textContent = "⚠️ 请先输入 Shopify Access Token (shpat_...)";
                msgEl.className = "settings-test-result is-error";
            }
            return;
        }

        const shopifyConfig = {
            id: settingsState.activeShopifyConfigId > 0 ? settingsState.activeShopifyConfigId : null,
            storage_type: "shopify",
            name: settingsElement("settingsShopifyName")?.value?.trim() || "",
            enabled: true,
            shopify_shop_domain: shopDomain,
            shopify_access_token: shopToken
        };
        payload = {
            config_id: settingsState.activeShopifyConfigId > 0 ? settingsState.activeShopifyConfigId : null,
            ...shopifyConfig,
            config_override: shopifyConfig
        };
    } else {
        const r2AccountId = settingsElement("settingsR2AccountId")?.value?.trim() || "";
        const r2AccessKeyId = settingsElement("settingsR2AccessKeyId")?.value?.trim() || "";
        const r2SecretKey = settingsElement("settingsR2SecretKey")?.value?.trim() || "";
        const r2BucketName = settingsElement("settingsR2BucketName")?.value?.trim() || "";
        const r2PublicUrl = settingsElement("settingsR2PublicUrl")?.value?.trim() || "";
        const r2PathPrefix = settingsElement("settingsR2PathPrefix")?.value?.trim() || "pdp/";
        const currentCfg = getSettingsStorageConfigs().find(c => c.storage_type === "r2");

        if (!r2AccountId) {
            settingsToast("请先输入 Cloudflare Account ID", "warning");
            if (msgEl) {
                msgEl.textContent = "⚠️ 请先输入 Cloudflare Account ID";
                msgEl.className = "settings-test-result is-error";
            }
            return;
        }
        if (!r2AccessKeyId) {
            settingsToast("请先输入 R2 Access Key ID", "warning");
            if (msgEl) {
                msgEl.textContent = "⚠️ 请先输入 R2 Access Key ID";
                msgEl.className = "settings-test-result is-error";
            }
            return;
        }
        if (!r2SecretKey && !currentCfg?.has_r2_secret) {
            settingsToast("请先输入 R2 Secret Access Key", "warning");
            if (msgEl) {
                msgEl.textContent = "⚠️ 请先输入 R2 Secret Access Key";
                msgEl.className = "settings-test-result is-error";
            }
            return;
        }
        if (!r2BucketName) {
            settingsToast("请先输入 R2 Bucket Name (存储桶名称)", "warning");
            if (msgEl) {
                msgEl.textContent = "⚠️ 请先输入 R2 Bucket Name";
                msgEl.className = "settings-test-result is-error";
            }
            return;
        }

        const r2Config = {
            storage_type: "r2",
            enabled: true,
            name: "默认 Cloudflare R2",
            r2_account_id: r2AccountId,
            r2_access_key_id: r2AccessKeyId,
            r2_secret_access_key: r2SecretKey,
            r2_bucket_name: r2BucketName,
            r2_public_url: r2PublicUrl,
            r2_path_prefix: r2PathPrefix
        };
        payload = {
            ...r2Config,
            config_override: r2Config
        };
    }

    setSettingsButtonBusy(button, true);
    if (msgEl) {
        msgEl.textContent = "正在测试连通性与读写鉴权...";
        msgEl.className = "settings-test-result";
    }

    try {
        const result = await settingsRequest(`${API_BASE}/api/storage/test`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        if (result.success) {
            if (msgEl) {
                msgEl.textContent = `✅ ${result.message}`;
                msgEl.className = "settings-test-result is-success";
            }
            settingsToast("存储连通性测试通过！", "success");
        } else {
            const errMsg = result.message || "连接失败";
            if (msgEl) {
                msgEl.textContent = `❌ ${errMsg}`;
                msgEl.className = "settings-test-result is-error";
            }
            settingsToast(`连接测试失败：${errMsg}`, "error");
        }
    } catch (err) {
        if (msgEl) {
            msgEl.textContent = `❌ ${err.message}`;
            msgEl.className = "settings-test-result is-error";
        }
        settingsToast(`连接测试失败：${err.message}`, "error");
    } finally {
        setSettingsButtonBusy(button, false);
    }
}

async function saveSettingsStorageConfig(button) {
    const type = settingsState.activeStorageTarget || "wordpress";
    let payload;

    if (type === "wordpress") {
        const wpUrl = settingsElement("settingsWpUrl")?.value?.trim() || "";
        const wpUsername = settingsElement("settingsWpUsername")?.value?.trim() || "";
        if (!wpUrl) {
            settingsToast("请输入 WordPress 站点地址", "warning");
            return;
        }
        if (!wpUsername) {
            settingsToast("请输入 WordPress 用户名", "warning");
            return;
        }

        payload = {
            id: settingsState.activeWpConfigId > 0 ? settingsState.activeWpConfigId : null,
            storage_type: "wordpress",
            name: settingsElement("settingsWpName")?.value?.trim() || "",
            enabled: true,
            wp_url: wpUrl,
            wp_username: wpUsername,
            wp_app_password: settingsElement("settingsWpAppPassword")?.value?.trim() || "",
            is_default: true
        };
    } else if (type === "shopify") {
        const rawDomain = settingsElement("settingsShopifyDomain")?.value?.trim() || "";
        const cleanDomain = rawDomain.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").trim();
        if (!cleanDomain) {
            settingsToast("请输入 Shopify 店铺域名", "warning");
            return;
        }

        payload = {
            id: settingsState.activeShopifyConfigId > 0 ? settingsState.activeShopifyConfigId : null,
            storage_type: "shopify",
            name: settingsElement("settingsShopifyName")?.value?.trim() || "",
            enabled: true,
            shopify_shop_domain: cleanDomain,
            shopify_access_token: settingsElement("settingsShopifyAccessToken")?.value?.trim() || "",
            is_default: true
        };
    } else {
        const r2AccountId = settingsElement("settingsR2AccountId")?.value?.trim() || "";
        const r2AccessKeyId = settingsElement("settingsR2AccessKeyId")?.value?.trim() || "";
        const r2BucketName = settingsElement("settingsR2BucketName")?.value?.trim() || "";
        if (!r2AccountId || !r2AccessKeyId || !r2BucketName) {
            settingsToast("请填写 Cloudflare Account ID、Access Key 和 Bucket Name", "warning");
            return;
        }

        payload = {
            storage_type: "r2",
            enabled: true,
            name: "默认 Cloudflare R2",
            r2_account_id: r2AccountId,
            r2_access_key_id: r2AccessKeyId,
            r2_secret_access_key: settingsElement("settingsR2SecretKey")?.value?.trim() || "",
            r2_bucket_name: r2BucketName,
            r2_public_url: settingsElement("settingsR2PublicUrl")?.value?.trim() || "",
            r2_path_prefix: settingsElement("settingsR2PathPrefix")?.value?.trim() || "pdp/"
        };
    }

    setSettingsButtonBusy(button, true);

    try {
        const saved = await settingsRequest(`${API_BASE}/api/storage/config`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        const targetLabels = { wordpress: "WordPress", shopify: "Shopify", r2: "Cloudflare R2" };
        settingsToast(`${targetLabels[type] || "存储"}配置已保存！`, "success");

        if (type === "wordpress") {
            settingsState.activeWpConfigId = saved.id;
        } else if (type === "shopify") {
            settingsState.activeShopifyConfigId = saved.id;
        }

        await reloadSettingsStorageConfigs();
        refreshSettingsStorageEditorView();
        syncWithDetailsModule();
    } catch (err) {
        settingsToast(`保存失败：${err.message}`, "error");
    } finally {
        setSettingsButtonBusy(button, false);
    }
}

if (typeof window !== "undefined") {
    window.toggleFirecrawlKeyVisibility = toggleFirecrawlKeyVisibility;
    window.testCrawlerConnection = testCrawlerConnection;
    window.saveCrawlerSettings = saveCrawlerSettings;
    window.renderCrawlerSettings = renderCrawlerSettings;
    window.renderCrawlerSettingsBadge = renderCrawlerSettingsBadge;
    window.updateSettingsOverviewKpis = updateSettingsOverviewKpis;
    window.switchSettingsTab = switchSettingsTab;
    window.filterSettingsProviders = filterSettingsProviders;
    window.quickBindCapability = quickBindCapability;
    window.renderStorageIntegrations = renderStorageIntegrations;
    window.openStorageEditor = openStorageEditor;
    window.closeStorageEditor = closeStorageEditor;
    window.switchStorageEditorTab = switchStorageEditorTab;
    window.onSettingsWpSelectChange = onSettingsWpSelectChange;
    window.addNewSettingsWpSite = addNewSettingsWpSite;
    window.addNewSettingsWpSiteFromCard = addNewSettingsWpSiteFromCard;
    window.deleteCurrentSettingsWpSite = deleteCurrentSettingsWpSite;
    window.onSettingsShopifySelectChange = onSettingsShopifySelectChange;
    window.addNewSettingsShopifyStore = addNewSettingsShopifyStore;
    window.addNewSettingsShopifyStoreFromCard = addNewSettingsShopifyStoreFromCard;
    window.deleteCurrentSettingsShopifyStore = deleteCurrentSettingsShopifyStore;
    window.testSettingsStorageConnection = testSettingsStorageConnection;
    window.saveSettingsStorageConfig = saveSettingsStorageConfig;
    window.formatStorageDisplayLabel = formatStorageDisplayLabel;
}

if (typeof module !== "undefined") {
    module.exports = {
        providerSupportsCapability,
        shouldShowImageGenerationMode,
        providerTestCapabilities,
        providerTestActionsMarkup,
        providerTestStatusMarkup,
        providerImageModeBadgeMarkup,
        buildProviderPayload,
        buildProviderTestRequestBody,
        maskedKeyPlaceholder,
        maskedCrawlerKeyPlaceholder,
        buildCrawlerPayload,
        renderCrawlerSettings,
        renderCrawlerSettingsBadge,
        toggleFirecrawlKeyVisibility,
        testCrawlerConnection,
        saveCrawlerSettings,
        updateSettingsOverviewKpis,
        switchSettingsTab,
        filterSettingsProviders,
        quickBindCapability,
        formatStorageDisplayLabel,
        renderStorageIntegrations,
        openStorageEditor,
        closeStorageEditor,
        switchStorageEditorTab,
        onSettingsWpSelectChange,
        addNewSettingsWpSite,
        addNewSettingsWpSiteFromCard,
        deleteCurrentSettingsWpSite,
        onSettingsShopifySelectChange,
        addNewSettingsShopifyStore,
        addNewSettingsShopifyStoreFromCard,
        deleteCurrentSettingsShopifyStore,
        testSettingsStorageConnection,
        saveSettingsStorageConfig,
        replaceProviderInList,
        removeProviderFromList,
        replaceBindingInList,
        refreshSettingsAfterSuccess,
        logMatchesFilters,
        appendBoundedSettingsLog,
        shouldConnectSettingsLogs,
        closeSettingsLogSource,
        connectSettingsLogs,
        disconnectSettingsLogs,
        appendSettingsLog,
        formatSettingsLogLine,
        settingsLogSummary,
        settingsLogDetails,
        settingsLogId,
        settingsLogKey,
        mergeSettingsLogSnapshot
    };
}
