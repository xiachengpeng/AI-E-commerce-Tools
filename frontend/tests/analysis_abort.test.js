const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");

const analysisSource = fs.readFileSync(path.join(__dirname, "../js/analysis.js"), "utf8");

function createAnalysisContext(domElements = {}, overrides = {}) {
    const elements = { ...domElements };
    const context = {
        console,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        AbortController,
        DOMException: typeof DOMException !== "undefined" ? DOMException : undefined,
        confirm: overrides.confirm || (() => true),
        alert: overrides.alert || (() => {}),
        window: {},
        document: {
            getElementById: (id) => elements[id] || null,
            querySelector: (sel) => elements[sel] || null,
            querySelectorAll: () => [],
            createElement: (tag) => ({
                tag,
                value: "",
                style: {},
                classList: {
                    add() {},
                    remove() {}
                },
                appendChild() {},
                insertBefore() {},
                remove() {},
                focus() {},
                select() {}
            }),
            body: {
                appendChild() {},
                removeChild() {}
            }
        },
        localStorage: {
            getItem: () => null,
            setItem: () => {},
            removeItem: () => {}
        },
        switchMainTab: () => {},
        showToast: () => {},
        fetch: overrides.fetch || (async () => ({
            ok: true,
            json: async () => ({ status: "success", template_type: "single", data: {} })
        }))
    };
    context.window = context;
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(analysisSource, context);
    return context;
}

function createMockClassList(initialClasses = []) {
    const classes = new Set(initialClasses);
    return {
        add(cls) { classes.add(cls); },
        remove(cls) { classes.delete(cls); },
        contains(cls) { return classes.has(cls); },
        get list() { return Array.from(classes); }
    };
}

test("xp_abortAnalyze returns false when no analysis is active", () => {
    const ctx = createAnalysisContext();
    assert.strictEqual(typeof ctx.window.xp_abortAnalyze, "function", "xp_abortAnalyze should be exposed on window");
    assert.strictEqual(ctx.window.xp_abortAnalyze(), false);
});

test("xp_handleAnalyze can be aborted cleanly via xp_abortAnalyze", async () => {
    let capturedSignal = null;
    let fetchAborted = false;

    const mockFetch = (url, options) => {
        capturedSignal = options.signal;
        return new Promise((resolve, reject) => {
            if (options.signal) {
                options.signal.addEventListener("abort", () => {
                    fetchAborted = true;
                    const err = new Error("The user aborted a request.");
                    err.name = "AbortError";
                    reject(err);
                });
            }
        });
    };

    const analyzeBtn = { disabled: false, innerHTML: "" };
    const urlInputField = { value: "https://www.amazon.com/dp/B08N5WRWNW" };
    const tagsList = { innerHTML: "", appendChild() {}, insertBefore() {} };
    const urlCounter = { textContent: "", classList: createMockClassList([]) };
    const errorMsg = {
        style: { display: "none" },
        textContent: "",
        classList: createMockClassList(["xp-hidden"])
    };
    const loadingSection = {
        classList: createMockClassList(["xp-hidden"])
    };
    const resultSection = {
        classList: createMockClassList(["xp-hidden"])
    };
    const stageLabel = { textContent: "" };
    const progressBar = { style: { width: "0%" } };
    const elapsedTimer = { textContent: "" };

    const ctx = createAnalysisContext(
        {
            "xp-analyzeBtn": analyzeBtn,
            "xp-urlInputField": urlInputField,
            "xp-tagsList": tagsList,
            "xp-urlCounter": urlCounter,
            "xp-errorMsg": errorMsg,
            "xp-loadingSection": loadingSection,
            "xp-resultSection": resultSection,
            "xp-loadingStageLabel": stageLabel,
            "xp-progressBar": progressBar,
            "xp-elapsedTimer": elapsedTimer
        },
        { fetch: mockFetch }
    );

    // Start analysis
    const analyzePromise = ctx.window.xp_handleAnalyze(
        analyzeBtn,
        urlInputField,
        tagsList,
        urlCounter,
        errorMsg,
        loadingSection,
        resultSection
    );

    assert.strictEqual(analyzeBtn.disabled, true);
    assert.strictEqual(loadingSection.classList.contains("xp-hidden"), false);
    assert.ok(capturedSignal, "AbortSignal should be passed to fetch");
    assert.strictEqual(capturedSignal.aborted, false);

    // Call abort
    const abortResult = ctx.window.xp_abortAnalyze();
    assert.strictEqual(abortResult, true);
    assert.strictEqual(capturedSignal.aborted, true);
    assert.strictEqual(fetchAborted, true);

    await analyzePromise;

    // After abort, UI should be cleanly reset
    assert.strictEqual(analyzeBtn.disabled, false);
    assert.match(analyzeBtn.innerHTML, /分析对比/);
    assert.strictEqual(loadingSection.classList.contains("xp-hidden"), true);
    assert.strictEqual(errorMsg.classList.contains("xp-hidden"), false);
    assert.strictEqual(errorMsg.textContent, "分析流程已由用户手动取消。");
});

test("xp_handleAnalyze handles network error without reporting user cancellation", async () => {
    const mockFetch = async () => {
        throw new Error("Failed to fetch");
    };

    const analyzeBtn = { disabled: false, innerHTML: "" };
    const urlInputField = { value: "https://www.amazon.com/dp/B08N5WRWNW" };
    const tagsList = { innerHTML: "", appendChild() {}, insertBefore() {} };
    const urlCounter = { textContent: "", classList: createMockClassList([]) };
    const errorMsg = {
        style: { display: "none" },
        textContent: "",
        classList: createMockClassList(["xp-hidden"])
    };
    const loadingSection = {
        classList: createMockClassList(["xp-hidden"])
    };
    const resultSection = {
        classList: createMockClassList(["xp-hidden"])
    };

    const ctx = createAnalysisContext(
        {
            "xp-analyzeBtn": analyzeBtn,
            "xp-urlInputField": urlInputField,
            "xp-tagsList": tagsList,
            "xp-urlCounter": urlCounter,
            "xp-errorMsg": errorMsg,
            "xp-loadingSection": loadingSection,
            "xp-resultSection": resultSection,
            "xp-loadingStageLabel": { textContent: "" },
            "xp-progressBar": { style: { width: "0%" } },
            "xp-elapsedTimer": { textContent: "" }
        },
        { fetch: mockFetch }
    );

    await ctx.window.xp_handleAnalyze(
        analyzeBtn,
        urlInputField,
        tagsList,
        urlCounter,
        errorMsg,
        loadingSection,
        resultSection
    );

    assert.strictEqual(analyzeBtn.disabled, false);
    assert.strictEqual(loadingSection.classList.contains("xp-hidden"), true);
    assert.strictEqual(errorMsg.classList.contains("xp-hidden"), false);
    assert.match(errorMsg.textContent, /无法连接到服务器/);
});

test("xp_handleAnalyze automatically aborts previous in-flight request when re-triggered", async () => {
    let firstSignal = null;
    let callCount = 0;

    const mockFetch = (url, options) => {
        callCount++;
        if (callCount === 1) {
            firstSignal = options.signal;
            return new Promise((resolve, reject) => {
                options.signal.addEventListener("abort", () => {
                    const err = new Error("Aborted");
                    err.name = "AbortError";
                    reject(err);
                });
            });
        }
        return Promise.resolve({
            json: async () => ({ status: "success", template_type: "single", data: {} })
        });
    };

    const analyzeBtn = { disabled: false, innerHTML: "" };
    const urlInputField = { value: "https://www.amazon.com/dp/B08N5WRWNW" };
    const tagsList = { innerHTML: "", appendChild() {}, insertBefore() {} };
    const urlCounter = { textContent: "", classList: createMockClassList([]) };
    const errorMsg = {
        style: { display: "none" },
        textContent: "",
        classList: createMockClassList(["xp-hidden"])
    };
    const loadingSection = {
        classList: createMockClassList(["xp-hidden"])
    };
    const resultSection = {
        classList: createMockClassList(["xp-hidden"])
    };

    const ctx = createAnalysisContext(
        {
            "xp-analyzeBtn": analyzeBtn,
            "xp-urlInputField": urlInputField,
            "xp-tagsList": tagsList,
            "xp-urlCounter": urlCounter,
            "xp-errorMsg": errorMsg,
            "xp-loadingSection": loadingSection,
            "xp-resultSection": resultSection,
            "xp-single-template": { classList: createMockClassList(["xp-hidden"]) },
            "xp-matrix-template": { classList: createMockClassList(["xp-hidden"]) },
            "xp-loadingStageLabel": { textContent: "" },
            "xp-progressBar": { style: { width: "0%" } },
            "xp-elapsedTimer": { textContent: "" }
        },
        { fetch: mockFetch }
    );

    const firstPromise = ctx.window.xp_handleAnalyze(
        analyzeBtn,
        urlInputField,
        tagsList,
        urlCounter,
        errorMsg,
        loadingSection,
        resultSection
    );

    assert.strictEqual(firstSignal.aborted, false);

    // Trigger second analyze
    urlInputField.value = "https://www.amazon.com/dp/B08N5WRWN2";
    const secondPromise = ctx.window.xp_handleAnalyze(
        analyzeBtn,
        urlInputField,
        tagsList,
        urlCounter,
        errorMsg,
        loadingSection,
        resultSection
    );

    assert.strictEqual(firstSignal.aborted, true, "First request signal should be aborted");

    await Promise.all([firstPromise, secondPromise]);
    assert.strictEqual(callCount, 2);
});
