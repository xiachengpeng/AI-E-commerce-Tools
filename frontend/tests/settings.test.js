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
    formatSettingsLogLine,
    settingsLogId,
    settingsLogKey,
    mergeSettingsLogSnapshot
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

const snapshotLog = {
    session_id: "boot-a",
    id: 101,
    timestamp: "2026-07-23T10:00:00Z",
    level: "success",
    source: "ai",
    message: "AI 请求完成",
    capability: "text",
    provider: "Primary",
    model: "text-v1",
    duration_ms: 80,
    retry: 0
};
const sameBackendLog = { ...snapshotLog };
const laterLegitimateLog = {
    ...snapshotLog,
    id: 102
};
assert.equal(
    settingsLogId(snapshotLog),
    settingsLogId(sameBackendLog)
);
assert.notEqual(
    settingsLogId(snapshotLog),
    settingsLogId(laterLegitimateLog)
);
assert.equal(settingsLogKey(snapshotLog), "boot-a:101");
assert.equal(
    settingsLogKey({ ...snapshotLog, session_id: "boot-b" }),
    "boot-b:101"
);
assert.deepEqual(
    mergeSettingsLogSnapshot(
        [snapshotLog],
        [sameBackendLog, laterLegitimateLog]
    ),
    [snapshotLog, laterLegitimateLog]
);

const newerSnapshot = Array.from({ length: 200 }, (_, index) => ({
    ...snapshotLog,
    id: index + 201
}));
const olderBuffered = Array.from({ length: 200 }, (_, index) => ({
    ...snapshotLog,
    id: index + 1
}));
assert.deepEqual(
    mergeSettingsLogSnapshot(newerSnapshot, olderBuffered)
        .map(entry => entry.id),
    Array.from({ length: 200 }, (_, index) => index + 201)
);

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

    class DeterministicEventSource {
        static instances = [];

        constructor(url) {
            this.url = url;
            this.closeCalls = 0;
            DeterministicEventSource.instances.push(this);
        }

        open() {
            this.onopen?.();
        }

        error() {
            this.onerror?.();
        }

        message(entry) {
            this.onmessage?.({ data: JSON.stringify(entry) });
        }

        close() {
            this.closeCalls += 1;
        }
    }

    const lifecycleState = {
        logs: [],
        logSource: null,
        logConnecting: null,
        logGeneration: 0
    };
    let resolveRecent;
    let recentRequests = 0;
    let rendered = 0;
    let connectionStatus = "";
    const recentPromise = new Promise(resolve => {
        resolveRecent = resolve;
    });
    const lifecycleOptions = {
        state: lifecycleState,
        baseUrl: "http://localhost:8000",
        request: async () => {
            recentRequests += 1;
            return recentPromise;
        },
        EventSourceClass: DeterministicEventSource,
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
    assert.equal(DeterministicEventSource.instances.length, 1);
    assert.equal(recentRequests, 0);

    const connectedSource = DeterministicEventSource.instances[0];
    assert.equal(
        connectedSource.url,
        "http://localhost:8000/api/settings/logs/stream"
    );
    connectedSource.open();
    assert.equal(connectionStatus, "connected");
    assert.equal(recentRequests, 1);

    const duringSnapshotFetch = {
        ...snapshotLog,
        id: 103,
        message: "arrived during snapshot fetch"
    };
    connectedSource.message(sameBackendLog);
    connectedSource.message(duringSnapshotFetch);
    resolveRecent({ items: [snapshotLog] });
    await Promise.all([firstConnection, duplicateConnection]);

    assert.equal(rendered, 1);
    assert.deepEqual(lifecycleState.logs, [
        snapshotLog,
        duringSnapshotFetch
    ]);
    assert.equal(
        lifecycleState.logs.filter(
            entry => entry.id === snapshotLog.id
        ).length,
        1
    );

    connectedSource.message(laterLegitimateLog);
    assert.equal(lifecycleState.logs.length, 3);
    assert.equal(
        lifecycleState.logs.filter(
            entry => entry.message === snapshotLog.message
        ).length,
        2
    );
    assert.deepEqual(
        lifecycleState.logs.map(entry => entry.id),
        [101, 102, 103]
    );

    connectedSource.error();
    connectedSource.open();
    connectedSource.message(sameBackendLog);
    const replayedAfterReconnect = {
        ...snapshotLog,
        id: 104,
        message: "replayed after reconnect"
    };
    connectedSource.message(replayedAfterReconnect);
    connectedSource.message({ ...replayedAfterReconnect });
    assert.equal(recentRequests, 1);
    assert.deepEqual(
        lifecycleState.logs.map(entry => entry.id),
        [101, 102, 103, 104]
    );

    disconnectSettingsLogs({
        state: lifecycleState,
        setConnection: lifecycleOptions.setConnection
    });
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

    const fallbackState = {
        logs: [],
        logSource: null,
        logConnecting: null,
        logGeneration: 0
    };
    let fallbackRequests = 0;
    const fallbackConnection = connectSettingsLogs({
        state: fallbackState,
        baseUrl: "",
        request: async () => {
            fallbackRequests += 1;
            return { items: [snapshotLog] };
        },
        EventSourceClass: DeterministicEventSource,
        render: () => {},
        setConnection: () => {},
        onError: error => {
            throw error;
        }
    });
    const fallbackSource = DeterministicEventSource.instances[1];
    fallbackSource.error();
    await fallbackConnection;
    fallbackSource.error();
    fallbackSource.open();
    assert.equal(fallbackRequests, 1);
    assert.equal(fallbackSource.closeCalls, 0);
    assert.deepEqual(fallbackState.logs, [snapshotLog]);
    fallbackSource.message(sameBackendLog);
    assert.deepEqual(fallbackState.logs, [snapshotLog]);
    disconnectSettingsLogs({
        state: fallbackState,
        setConnection: () => {}
    });

    const pendingState = {
        logs: [{ sentinel: true }],
        logSource: null,
        logConnecting: null,
        logGeneration: 0
    };
    let resolvePendingRecent;
    const pendingConnect = connectSettingsLogs({
        state: pendingState,
        baseUrl: "",
        request: () => new Promise(resolve => {
            resolvePendingRecent = resolve;
        }),
        EventSourceClass: DeterministicEventSource,
        render: () => {},
        setConnection: () => {},
        onError: error => {
            throw error;
        }
    });
    const staleSource = DeterministicEventSource.instances[2];
    staleSource.open();
    staleSource.message(snapshotLog);
    disconnectSettingsLogs({ state: pendingState, setConnection: () => {} });
    staleSource.open();
    staleSource.message(duringSnapshotFetch);
    resolvePendingRecent({ items: [snapshotLog] });
    await pendingConnect;
    assert.deepEqual(pendingState.logs, [{ sentinel: true }]);
    assert.equal(staleSource.closeCalls, 1);

    const dedupeState = {
        logs: [snapshotLog],
        logSeenIds: new Set(["boot-a:101"]),
        logSessionId: "boot-a",
        logsPaused: false
    };
    let dedupeRenders = 0;
    appendSettingsLog(
        sameBackendLog,
        {
            state: dedupeState,
            render: () => { dedupeRenders += 1; }
        }
    );
    appendSettingsLog(
        laterLegitimateLog,
        {
            state: dedupeState,
            render: () => { dedupeRenders += 1; }
        }
    );
    assert.deepEqual(
        dedupeState.logs.map(entry => entry.id),
        [101, 102]
    );
    assert.equal(dedupeRenders, 1);

    const sessionChangeState = {
        logs: [
            { ...snapshotLog, id: 399 },
            { ...snapshotLog, id: 400 }
        ],
        logSeenIds: new Set(["boot-a:399", "boot-a:400"]),
        logSessionId: "boot-a",
        logsPaused: false
    };
    let sessionChangeRenders = 0;
    const newSessionFirst = {
        ...snapshotLog,
        session_id: "boot-b",
        id: 1
    };
    appendSettingsLog(newSessionFirst, {
        state: sessionChangeState,
        render: () => { sessionChangeRenders += 1; }
    });
    appendSettingsLog({ ...newSessionFirst }, {
        state: sessionChangeState,
        render: () => { sessionChangeRenders += 1; }
    });
    appendSettingsLog(
        { ...newSessionFirst, id: 2 },
        {
            state: sessionChangeState,
            render: () => { sessionChangeRenders += 1; }
        }
    );
    assert.equal(sessionChangeState.logSessionId, "boot-b");
    assert.deepEqual(
        sessionChangeState.logs.map(entry => [
            entry.session_id,
            entry.id
        ]),
        [["boot-b", 1], ["boot-b", 2]]
    );
    assert.deepEqual(
        [...sessionChangeState.logSeenIds],
        ["boot-b:1", "boot-b:2"]
    );
    assert.equal(sessionChangeRenders, 2);
}

runAsyncTests().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
