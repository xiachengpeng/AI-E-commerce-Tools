const assert = require("node:assert/strict");
const {
    providerSupportsCapability,
    buildProviderPayload,
    maskedKeyPlaceholder,
    refreshSettingsAfterSuccess,
    replaceProviderInList,
    removeProviderFromList,
    replaceBindingInList,
    logMatchesFilters,
    appendBoundedSettingsLog,
    shouldConnectSettingsLogs,
    closeSettingsLogSource,
    connectSettingsLogs,
    disconnectSettingsLogs,
    appendSettingsLog,
    formatSettingsLogLine
} = require("../js/settings.js");
const { appendToastContent } = require("../js/utils.js");

assert.equal(providerSupportsCapability(
    { enabled: true, supports_text: true }, "text"), true);
assert.equal(providerSupportsCapability(
    { enabled: false, supports_text: true }, "text"), false);
assert.equal(maskedKeyPlaceholder(
    { has_api_key: true, api_key_masked: "sk-****1234" }), "已保存：sk-****1234");
assert.deepEqual(buildProviderPayload({
    name: " Relay ",
    protocol: "openai_compatible",
    base_url: "https://relay.example.com/",
    api_key: "",
    supports_text: true,
    supports_image: false,
    timeout_seconds: "30",
    max_retries: "2",
    enabled: true
}), {
    name: "Relay",
    protocol: "openai_compatible",
    base_url: "https://relay.example.com",
    api_key: null,
    supports_text: true,
    supports_image: false,
    timeout_seconds: 30,
    max_retries: 2,
    enabled: true
});

function fakeElement(tagName) {
    return {
        tagName: tagName.toUpperCase(),
        className: "",
        textContent: "",
        children: [],
        appendChild(child) {
            this.children.push(child);
            return child;
        }
    };
}

const fakeDocument = {
    createElement: tagName => fakeElement(tagName)
};
const toast = fakeElement("div");
const attack = '<img src=x onerror="globalThis.toastXss=true">';
appendToastContent(toast, attack, "ph-warning-circle", fakeDocument);
assert.equal(toast.children.length, 2);
assert.equal(toast.children[0].tagName, "I");
assert.equal(toast.children[0].className, "ph ph-warning-circle text-lg");
assert.equal(toast.children[1].tagName, "SPAN");
assert.equal(toast.children[1].textContent, attack);
assert.deepEqual(toast.children[1].children, []);
assert.equal(toast.children.some(child => child.tagName === "IMG"), false);

assert.deepEqual(replaceProviderInList(
    [{ id: 1, enabled: true }, { id: 2, enabled: true }],
    { id: 1, enabled: false }
), [{ id: 1, enabled: false }, { id: 2, enabled: true }]);
assert.deepEqual(replaceProviderInList(
    [],
    { id: 3, enabled: true }
), [{ id: 3, enabled: true }]);
assert.deepEqual(removeProviderFromList(
    [{ id: 1 }, { id: 2 }],
    1
), [{ id: 2 }]);
assert.deepEqual(replaceBindingInList(
    [{ capability: "text", provider_config_id: 1 }],
    { capability: "text", provider_config_id: 2 }
), [{ capability: "text", provider_config_id: 2 }]);
assert.deepEqual(replaceBindingInList(
    [],
    { capability: "image", provider_config_id: 3 }
), [{ capability: "image", provider_config_id: 3 }]);

const logEntry = {
    level: "error",
    source: "ai",
    capability: "image"
};
assert.equal(logMatchesFilters(logEntry, {
    level: "error",
    source: "all",
    capability: "image"
}), true);
assert.equal(logMatchesFilters(logEntry, {
    level: "info",
    source: "all",
    capability: "image"
}), false);
assert.equal(logMatchesFilters(logEntry, {
    level: "error",
    source: "frontend",
    capability: "image"
}), false);
assert.equal(logMatchesFilters(logEntry, {
    level: "error",
    source: "ai",
    capability: "text"
}), false);
assert.equal(logMatchesFilters(
    { level: "info", source: "system", capability: null },
    { level: "all", source: "all", capability: "all" }
), true);

const boundedLogs = Array.from({ length: 200 }, (_, index) => ({ index }));
const newestLog = { index: 200 };
const nextLogs = appendBoundedSettingsLog(boundedLogs, newestLog);
assert.equal(nextLogs.length, 200);
assert.equal(nextLogs[0].index, 1);
assert.strictEqual(nextLogs[199], newestLog);
assert.equal(boundedLogs.length, 200);

assert.equal(shouldConnectSettingsLogs({
    logSource: null,
    logConnecting: null
}), true);
assert.equal(shouldConnectSettingsLogs({
    logSource: { readyState: 1 },
    logConnecting: null
}), false);
assert.equal(shouldConnectSettingsLogs({
    logSource: null,
    logConnecting: Promise.resolve()
}), false);

let closeCalls = 0;
assert.equal(closeSettingsLogSource({
    close() {
        closeCalls += 1;
    }
}), null);
assert.equal(closeCalls, 1);
assert.equal(closeSettingsLogSource(null), null);

assert.equal(formatSettingsLogLine({
    timestamp: "2026-07-23T10:00:00Z",
    level: "error",
    source: "ai",
    message: "<script>alert(1)</script>",
    capability: "image",
    provider: "Relay",
    model: "vision-v1",
    duration_ms: 125,
    retry: 2
}), "timestamp=2026-07-23T10:00:00Z level=error source=ai message=<script>alert(1)</script> capability=image provider=Relay model=vision-v1 duration_ms=125 retry=2");

async function runAsyncTests() {
    const operationResult = { status: "success", message: "连接成功" };
    const warnings = [];
    const outcome = await refreshSettingsAfterSuccess(
        operationResult,
        async () => {
            throw new Error("refresh failed");
        },
        message => warnings.push(message)
    );

    assert.strictEqual(outcome.result, operationResult);
    assert.equal(outcome.refreshed, false);
    assert.equal(outcome.refreshError.message, "refresh failed");
    assert.deepEqual(warnings, ["操作成功，但刷新失败：refresh failed"]);

    const lifecycleState = {
        logs: [],
        logSource: null,
        logConnecting: null,
        logGeneration: 0
    };
    let resolveRecent;
    let recentRequests = 0;
    let eventSources = 0;
    let rendered = 0;
    let connectionStatus = "";
    const recentPromise = new Promise(resolve => {
        resolveRecent = resolve;
    });
    class FakeEventSource {
        constructor(url) {
            this.url = url;
            this.closeCalls = 0;
            eventSources += 1;
        }

        close() {
            this.closeCalls += 1;
        }
    }
    const lifecycleOptions = {
        state: lifecycleState,
        baseUrl: "http://localhost:8000",
        request: async () => {
            recentRequests += 1;
            return recentPromise;
        },
        EventSourceClass: FakeEventSource,
        render: () => {
            rendered += 1;
        },
        setConnection: status => {
            connectionStatus = status;
        },
        onError: error => {
            throw error;
        }
    };

    const firstConnection = connectSettingsLogs(lifecycleOptions);
    const duplicateConnection = connectSettingsLogs(lifecycleOptions);
    assert.equal(recentRequests, 1);
    resolveRecent({
        items: Array.from({ length: 201 }, (_, index) => ({ index }))
    });
    await Promise.all([firstConnection, duplicateConnection]);
    assert.equal(eventSources, 1);
    assert.equal(rendered, 1);
    assert.equal(lifecycleState.logs.length, 200);
    assert.equal(lifecycleState.logs[0].index, 1);
    assert.equal(lifecycleState.logSource.url, "http://localhost:8000/api/settings/logs/stream");
    lifecycleState.logSource.onopen();
    assert.equal(connectionStatus, "connected");

    const connectedSource = lifecycleState.logSource;
    disconnectSettingsLogs({ state: lifecycleState, setConnection: lifecycleOptions.setConnection });
    assert.equal(connectedSource.closeCalls, 1);
    assert.equal(lifecycleState.logSource, null);
    assert.equal(connectionStatus, "disconnected");

    const pausedState = {
        logs: [],
        logsPaused: true
    };
    let pausedRenders = 0;
    appendSettingsLog(
        { message: "buffer while paused" },
        { state: pausedState, render: () => { pausedRenders += 1; } }
    );
    assert.equal(pausedState.logs.length, 1);
    assert.equal(pausedRenders, 0);
    pausedState.logsPaused = false;
    appendSettingsLog(
        { message: "render while running" },
        { state: pausedState, render: () => { pausedRenders += 1; } }
    );
    assert.equal(pausedState.logs.length, 2);
    assert.equal(pausedRenders, 1);

    const pendingState = {
        logs: [],
        logSource: null,
        logConnecting: null,
        logGeneration: 0
    };
    let resolvePendingRecent;
    let pendingSources = 0;
    const pendingConnect = connectSettingsLogs({
        state: pendingState,
        baseUrl: "",
        request: () => new Promise(resolve => {
            resolvePendingRecent = resolve;
        }),
        EventSourceClass: class {
            constructor() {
                pendingSources += 1;
            }
        },
        render: () => {},
        setConnection: () => {},
        onError: error => {
            throw error;
        }
    });
    disconnectSettingsLogs({ state: pendingState, setConnection: () => {} });
    resolvePendingRecent({ items: [] });
    await pendingConnect;
    assert.equal(pendingSources, 0);
}

runAsyncTests().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
