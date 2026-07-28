const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const frontendRoot = path.resolve(__dirname, "..");
const indexHtml = fs.readFileSync(path.join(frontendRoot, "index.html"), "utf8");
const historyScript = fs.readFileSync(
    path.join(frontendRoot, "js", "history_manager.js"),
    "utf8"
);

class FakeClassList {
    constructor(...values) {
        this.values = new Set(values);
    }

    contains(name) {
        return this.values.has(name);
    }

    toggle(name, force) {
        if (force === undefined) {
            if (this.values.has(name)) this.values.delete(name);
            else this.values.add(name);
            return;
        }
        if (force) this.values.add(name);
        else this.values.delete(name);
    }
}

function historyResult(overrides = {}) {
    return {
        filename: "summer-shoe.png",
        source_url: "/static/outputs/watermark-removal/job/source.png",
        result_url: "/static/outputs/watermark-removal/job/result.png",
        width: 1200,
        height: 800,
        regions: [
            { x: 0.1, y: 0.2, width: 0.2, height: 0.1 },
            { x: 0.6, y: 0.7, width: 0.15, height: 0.1 }
        ],
        ...overrides
    };
}

function createHistoryHarness(records) {
    const list = { innerHTML: "" };
    const tabs = [
        "analysis",
        "listing",
        "watermark-removal",
        "render"
    ].map(module => ({
        id: `hist-tab-${module}`,
        classList: new FakeClassList(module === "analysis" ? "active" : "")
    }));
    const state = {
        fetchUrls: [],
        restored: [],
        switched: []
    };
    const context = {
        API_BASE: "http://localhost:8000",
        Date,
        console: { error() {}, log() {} },
        document: {
            getElementById(id) {
                return id === "globalHistoryList" ? list : null;
            },
            querySelectorAll(selector) {
                return selector === ".history-tab-btn" ? tabs : [];
            }
        },
        fetch: async url => {
            state.fetchUrls.push(url);
            return {
                json: async () => records
            };
        },
        restoreWatermarkRemovalHistory(result) {
            state.restored.push(result);
        },
        setTimeout(callback) {
            callback();
            return 1;
        },
        showToast() {},
        switchMainTab(module) {
            state.switched.push(module);
        }
    };
    vm.createContext(context);
    vm.runInContext(historyScript, context);
    return { context, list, state, tabs };
}

test("global history exposes an AI removal tab", () => {
    assert.match(
        indexHtml,
        /id="hist-tab-watermark-removal"[^>]*>AI 消除</
    );
});

test("AI removal history activates its tab and renders result summary", async () => {
    const result = historyResult();
    const harness = createHistoryHarness([{
        id: 7,
        timestamp: "2026-07-28T10:00:00",
        filename: result.filename,
        result
    }]);

    await harness.context.loadGlobalHistory("watermark-removal");

    const activeTab = harness.tabs.find(tab =>
        tab.id === "hist-tab-watermark-removal"
    );
    assert.equal(activeTab.classList.contains("active"), true);
    assert.match(harness.list.innerHTML, />summer-shoe\.png</);
    assert.match(
        harness.list.innerHTML,
        /src="http:\/\/localhost:8000\/static\/outputs\/watermark-removal\/job\/result\.png"/
    );
    assert.match(harness.list.innerHTML, /1200 × 800/);
    assert.match(harness.list.innerHTML, /2 个区域/);
});

test("AI removal history restores the saved result without an AI request", async () => {
    const result = historyResult();
    const harness = createHistoryHarness([{
        id: 9,
        filename: result.filename,
        result
    }]);

    await harness.context.loadGlobalHistory("watermark-removal");
    const fetchCountBeforeRestore = harness.state.fetchUrls.length;
    await harness.context.restoreHistoryItemByIndex("watermark-removal", 0);

    assert.deepEqual(harness.state.switched, ["watermark-removal"]);
    assert.deepEqual(harness.state.restored, [result]);
    assert.equal(harness.state.fetchUrls.length, fetchCountBeforeRestore);
});

test("AI removal history escapes a malicious filename", async () => {
    const maliciousFilename = '"><img src=x onerror="globalThis.pwned=true">';
    const result = historyResult({ filename: maliciousFilename });
    const harness = createHistoryHarness([{
        id: 11,
        filename: maliciousFilename,
        result
    }]);

    await harness.context.loadGlobalHistory("watermark-removal");

    assert.doesNotMatch(harness.list.innerHTML, /<img src=x onerror=/);
    assert.match(
        harness.list.innerHTML,
        /&quot;&gt;&lt;img src=x onerror=&quot;globalThis\.pwned=true&quot;&gt;/
    );
});

test("AI removal history safely encodes a quote-breaking asset URL", async () => {
    const result = historyResult({
        result_url: 'https://cdn.example.test/result.png" onerror="globalThis.pwned=true'
    });
    const harness = createHistoryHarness([{
        id: 13,
        filename: result.filename,
        result
    }]);

    await harness.context.loadGlobalHistory("watermark-removal");

    assert.doesNotMatch(
        harness.list.innerHTML,
        /src="https:\/\/cdn\.example\.test\/result\.png" onerror=/
    );
    assert.match(
        harness.list.innerHTML,
        /src="https:\/\/cdn\.example\.test\/result\.png&quot; onerror=&quot;globalThis\.pwned=true"/
    );
});
