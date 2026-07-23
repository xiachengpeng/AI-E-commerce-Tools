/**
 * AI 提供商设置页
 */

function providerSupportsCapability(provider, capability) {
    return provider.enabled && provider[`supports_${capability}`] === true;
}

function maskedKeyPlaceholder(provider) {
    if (!provider || !provider.has_api_key || !provider.api_key_masked) {
        return "未保存 API Key";
    }
    return `已保存：${provider.api_key_masked}`;
}

function buildProviderPayload(values) {
    const payload = {
        name: String(values.name || "").trim(),
        protocol: values.protocol,
        base_url: String(values.base_url || "").trim().replace(/\/+$/, "") || null,
        api_key: String(values.api_key || "").trim() || null,
        supports_text: values.supports_text === true,
        supports_image: values.supports_image === true,
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
    "retry"
];

function settingsLogId(entry) {
    return Number.isSafeInteger(entry?.id) && entry.id > 0
        ? entry.id
        : null;
}

function mergeSettingsLogSnapshot(snapshot, buffered, limit = 200) {
    const seen = new Set();
    return [...snapshot, ...buffered]
        .filter(entry => {
            const id = settingsLogId(entry);
            if (id === null) return true;
            if (seen.has(id)) return false;
            seen.add(id);
            return true;
        })
        .slice(-limit);
}

function formatSettingsLogLine(entry) {
    return SETTINGS_LOG_FIELDS
        .map(field => `${field}=${entry?.[field] ?? "—"}`)
        .join(" ");
}

function shouldConnectSettingsLogs(state) {
    return !state.logSource && !state.logConnecting;
}

function closeSettingsLogSource(source) {
    source?.close();
    return null;
}

function replaceSettingsLogs(state, logs) {
    state.logs = logs.slice(-200);
    state.logSeenIds = new Set(
        state.logs
            .map(settingsLogId)
            .filter(id => id !== null)
    );
}

const settingsState = {
    initialized: false,
    providers: [],
    bindings: { items: [] },
    editingProviderId: null,
    logs: [],
    logSeenIds: new Set(),
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
    if (!badge) return;
    const labels = {
        connecting: "连接中",
        connected: "已连接",
        reconnecting: "重连中",
        disconnected: "已断开"
    };
    badge.dataset.status = status;
    badge.textContent = labels[status] || status;
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
            appendSettingsLogField(message, "message", entry?.message);
            row.appendChild(message);

            const meta = createSettingsLogElement("div", "settings-log-meta", "");
            appendSettingsLogField(meta, "capability", entry?.capability);
            appendSettingsLogField(meta, "provider", entry?.provider);
            appendSettingsLogField(meta, "model", entry?.model);
            appendSettingsLogField(meta, "duration_ms", entry?.duration_ms);
            appendSettingsLogField(meta, "retry", entry?.retry);
            row.appendChild(meta);
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
    if (!(state.logSeenIds instanceof Set)) {
        replaceSettingsLogs(state, state.logs || []);
    }
    const id = settingsLogId(entry);
    if (id !== null && state.logSeenIds.has(id)) return false;
    replaceSettingsLogs(
        state,
        appendBoundedSettingsLog(state.logs || [], entry)
    );
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
    warn = message => settingsToast(message, "warning")
) {
    try {
        await refresh();
        return { result, refreshed: true, refreshError: null };
    } catch (error) {
        warn(`操作成功，但刷新失败：${error.message}`);
        return { result, refreshed: false, refreshError: error };
    }
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
    document.addEventListener("keydown", event => {
        if (event.key === "Escape" && !editor?.classList.contains("hidden")) {
            closeProviderEditor();
        }
    });

    try {
        await loadSettingsData();
    } catch (error) {
        renderSettingsLoadError(error.message);
        settingsToast(error.message, "error");
    }
}

async function loadSettingsData() {
    const [providersData, bindingsData] = await Promise.all([
        settingsRequest(`${API_BASE}/api/settings/ai/providers`),
        settingsRequest(`${API_BASE}/api/settings/ai/bindings`)
    ]);

    settingsState.providers = Array.isArray(providersData.items)
        ? providersData.items
        : [];
    settingsState.bindings = {
        ...bindingsData,
        items: Array.isArray(bindingsData.items) ? bindingsData.items : []
    };
    renderCapabilityBindings();
    renderProviderList();
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
    return `
        <span class="settings-test-status ${success ? "is-success" : "is-error"}"
            title="${escapeSettingsHtml(message)}">
            <i class="ph ${success ? "ph-check-circle" : "ph-warning-circle"}"></i>
            <span class="settings-test-message">${escapeSettingsHtml(message)}</span>
        </span>
    `;
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

    list.innerHTML = settingsState.providers.map(provider => {
        const boundCapabilities = boundCapabilitiesForProvider(provider.id);
        const inUse = boundCapabilities.length > 0;
        const testCapability = provider.supports_text
            ? "text"
            : (provider.supports_image ? "image" : "");
        const capabilityBadges = [
            provider.supports_text
                ? '<span class="settings-badge settings-badge-capability"><i class="ph ph-text-aa"></i> 文本</span>'
                : "",
            provider.supports_image
                ? '<span class="settings-badge settings-badge-capability"><i class="ph ph-image"></i> 图片</span>'
                : "",
            ...boundCapabilities.map(capability => `
                <span class="settings-badge settings-badge-bound">
                    <i class="ph ph-link-simple"></i>
                    ${capability === "text" ? "文本使用中" : "图片使用中"}
                </span>
            `),
            !provider.enabled
                ? '<span class="settings-badge settings-badge-disabled">已停用</span>'
                : ""
        ].join("");
        const conflictTitle = inUse
            ? "该线路正在使用，请先切换能力绑定"
            : "";

        return `
            <article class="settings-provider-item ${provider.enabled ? "" : "is-disabled"}">
                <div class="settings-provider-main">
                    <div class="settings-provider-heading">
                        <span class="settings-provider-avatar">
                            <i class="ph ${providerProtocolIcon(provider.protocol)}"></i>
                        </span>
                        <div>
                            <h3 class="settings-provider-name">${escapeSettingsHtml(provider.name)}</h3>
                            <span class="settings-provider-protocol">
                                ${escapeSettingsHtml(SETTINGS_PROTOCOL_LABELS[provider.protocol] || provider.protocol)}
                            </span>
                        </div>
                    </div>
                    <div class="settings-provider-actions">
                        <button type="button" class="settings-provider-action"
                            title="编辑线路" aria-label="编辑 ${escapeSettingsHtml(provider.name)}"
                            onclick="openProviderEditor(${Number(provider.id)})">
                            <i class="ph ph-pencil-simple"></i>
                        </button>
                        <button type="button" class="settings-provider-action"
                            title="${testCapability ? `测试${testCapability === "text" ? "文本" : "图片"}连接` : "未声明可测试能力"}"
                            aria-label="测试 ${escapeSettingsHtml(provider.name)}"
                            onclick="testSavedProvider(${Number(provider.id)}, '${testCapability}', this)"
                            ${testCapability ? "" : "disabled"}>
                            <i class="ph ph-plugs"></i>
                        </button>
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

    const requestBody = settingsState.editingProviderId === null
        ? { draft: payload, capability }
        : { provider_id: settingsState.editingProviderId, capability };
    const resultElement = settingsElement("settingsTestResult");
    setSettingsButtonBusy(button, true);
    if (resultElement) {
        resultElement.textContent = settingsState.editingProviderId === null
            ? "正在测试当前表单配置…"
            : "正在测试已保存配置…";
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

if (typeof module !== "undefined") {
    module.exports = {
        providerSupportsCapability,
        buildProviderPayload,
        maskedKeyPlaceholder,
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
        settingsLogId,
        mergeSettingsLogSnapshot
    };
}
