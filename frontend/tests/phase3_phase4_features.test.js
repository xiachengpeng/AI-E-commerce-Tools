const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");

// 1. Listing Search Terms & Risk Detection Tests
const {
    getUtf8ByteLength,
    detectSearchTermsRiskWords,
    removeListingSearchTermsRiskWords,
    updateSearchTermsCounter,
    LISTING_AMAZON_RISK_TERMS,
    setCurrentListingData
} = require("../js/listing.js");

test("detectSearchTermsRiskWords accurately detects Amazon forbidden terms case-insensitively", () => {
    assert.ok(Array.isArray(LISTING_AMAZON_RISK_TERMS));
    assert.ok(LISTING_AMAZON_RISK_TERMS.length >= 5);
    assert.ok(LISTING_AMAZON_RISK_TERMS.includes("best"));
    assert.ok(LISTING_AMAZON_RISK_TERMS.includes("guarantee"));

    const cleanText = "waterproof bluetooth earphone sports running gym bass";
    assert.deepEqual(detectSearchTermsRiskWords(cleanText), []);

    const dirtyText = "best earphone with 100% satisfaction guarantee and cure for pain";
    const detected = detectSearchTermsRiskWords(dirtyText);
    assert.ok(detected.includes("best"));
    assert.ok(detected.includes("guarantee"));
    assert.ok(detected.includes("cure"));

    // Case insensitivity
    const upperText = "GUARANTEE and BEST item";
    const detectedUpper = detectSearchTermsRiskWords(upperText);
    assert.ok(detectedUpper.includes("guarantee"));
    assert.ok(detectedUpper.includes("best"));
});

test("removeListingSearchTermsRiskWords strips forbidden terms and updates DOM & byte counter", () => {
    const rawText = "wireless earphone best waterproof guarantee gym running";
    setCurrentListingData({
        searchTerms: { target: rawText, zh: "中文搜索词" }
    });

    const elements = {
        resListingSearchTerms: {
            textContent: rawText
        },
        listingStByteCount: {
            textContent: "",
            className: ""
        },
        listingStProgressBar: {
            style: { width: "0%" },
            className: ""
        },
        listingStRiskWarning: {
            classList: {
                _classes: new Set(["hidden"]),
                add(...cls) { cls.forEach(c => this._classes.add(c)); },
                remove(...cls) { cls.forEach(c => this._classes.delete(c)); },
                contains(c) { return this._classes.has(c); }
            }
        },
        listingStRiskTermsText: {
            textContent: ""
        }
    };

    let toastMsg = null;
    const origDoc = globalThis.document;
    const origToast = globalThis.showToast;
    const origWindow = globalThis.window;

    globalThis.document = {
        getElementById: (id) => elements[id] || null
    };
    globalThis.showToast = (msg, type) => { toastMsg = { msg, type }; };
    globalThis.window = globalThis;

    try {
        removeListingSearchTermsRiskWords();
        const cleaned = elements.resListingSearchTerms.textContent;
        assert.ok(!cleaned.includes("best"));
        assert.ok(!cleaned.includes("guarantee"));
        assert.ok(cleaned.includes("wireless earphone"));
        assert.ok(cleaned.includes("waterproof"));
        assert.ok(cleaned.includes("gym running"));
        assert.ok(toastMsg && toastMsg.type === "success");
    } finally {
        globalThis.document = origDoc;
        globalThis.showToast = origToast;
        globalThis.window = origWindow;
        setCurrentListingData(null);
    }
});

test("updateSearchTermsCounter applies green, amber, and pulsing red thresholds based on 249 byte limit", () => {
    const counterEl = {
        textContent: "",
        className: ""
    };
    const progressBarEl = {
        style: { width: "0%" },
        className: ""
    };
    const warningEl = {
        classList: {
            _classes: new Set(["hidden"]),
            add(...cls) { cls.forEach(c => this._classes.add(c)); },
            remove(...cls) { cls.forEach(c => this._classes.delete(c)); },
            contains(c) { return this._classes.has(c); }
        }
    };
    const riskWordsEl = { textContent: "" };

    const elements = {
        listingStByteCount: counterEl,
        listingStProgressBar: progressBarEl,
        listingStRiskWarning: warningEl,
        listingStRiskTermsText: riskWordsEl
    };

    const origDoc = globalThis.document;
    globalThis.document = {
        getElementById: (id) => elements[id] || null
    };

    try {
        // Under 200 bytes: green / safe
        updateSearchTermsCounter("wireless earbuds bluetooth 5.3");
        assert.ok(counterEl.className.includes("bg-emerald-50"));
        assert.ok(counterEl.textContent.includes("(安全)"));
        assert.ok(warningEl.classList.contains("hidden"));

        // 200 - 249 bytes: amber / optimal
        const mediumText = "a".repeat(220);
        updateSearchTermsCounter(mediumText);
        assert.ok(counterEl.className.includes("bg-amber-100"));
        assert.ok(counterEl.textContent.includes("(极致利用)"));
        assert.ok(warningEl.classList.contains("hidden"));

        // > 249 bytes: red pulsing + overflow alert
        const overflowText = "a".repeat(260);
        updateSearchTermsCounter(overflowText);
        assert.ok(counterEl.className.includes("bg-red-100"));
        assert.ok(counterEl.className.includes("animate-pulse"));
        assert.ok(counterEl.textContent.includes("超标 +11 Bytes ⚠️"));

        // With risk words
        updateSearchTermsCounter("best earbuds with guarantee");
        assert.ok(!warningEl.classList.contains("hidden"));
        assert.ok(riskWordsEl.textContent.includes("best"));
        assert.ok(riskWordsEl.textContent.includes("guarantee"));
    } finally {
        globalThis.document = origDoc;
    }
});

// 2. Details Module: Amazon A+ Crops, Standalone Preview, and Cross-Module Asset Setup
function createDetailsVmContext() {
    const elements = {};
    function getOrCreate(id) {
        if (!elements[id]) {
            elements[id] = {
                id,
                innerHTML: "",
                textContent: "",
                value: "",
                className: "",
                classList: {
                    _classes: new Set(),
                    add(...cls) { cls.forEach(c => this._classes.add(c)); },
                    remove(...cls) { cls.forEach(c => this._classes.delete(c)); },
                    toggle(c) {
                        if (this._classes.has(c)) this._classes.delete(c);
                        else this._classes.add(c);
                    },
                    contains(c) { return this._classes.has(c); }
                },
                appendChild: () => {},
                setAttribute: () => {},
                click: () => {},
                style: {},
                remove: () => {}
            };
        }
        return elements[id];
    }

    let lastToast = null;
    let switchedTab = null;
    let openedUrl = null;

    const doc = {
        getElementById: (id) => getOrCreate(id),
        querySelector: (sel) => {
            if (sel.startsWith("#")) return getOrCreate(sel.slice(1));
            return null;
        },
        querySelectorAll: () => [],
        createElement: (tag) => {
            const el = getOrCreate(`created_${tag}_${Math.random().toString(36).slice(2, 6)}`);
            el.tagName = tag.toUpperCase();
            return el;
        },
        body: {
            appendChild: () => {}
        }
    };

    const ctx = {
        console,
        setTimeout,
        clearTimeout,
        document: doc,
        showToast: (msg, type) => { lastToast = { msg, type }; },
        switchMainTab: (tab) => { switchedTab = tab; },
        remoteLog: () => {},
        localStorage: {
            getItem: () => null,
            setItem: () => {},
            removeItem: () => {}
        },
        URL: {
            createObjectURL: (blob) => `blob:mock-url-${Math.random().toString(36).slice(2, 8)}`,
            revokeObjectURL: () => {}
        },
        Blob: class {
            constructor(chunks, options) {
                this.chunks = chunks;
                this.options = options;
            }
        },
        open: (url, target) => { openedUrl = { url, target }; return { focus: () => {} }; },
        fetch: async () => ({ ok: true, json: async () => ({}) })
    };

    ctx.window = ctx;
    ctx.globalThis = ctx;

    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(root, "js", "config.js"), "utf8"), ctx);
    vm.runInContext(fs.readFileSync(path.join(root, "js", "app.js"), "utf8"), ctx);
    vm.runInContext(fs.readFileSync(path.join(root, "js", "details.js"), "utf8"), ctx);

    return {
        ctx,
        elements,
        getLastToast: () => lastToast,
        getSwitchedTab: () => switchedTab,
        getOpenedUrl: () => openedUrl
    };
}

test("cropImageToCanvas scales and center-crops image to target dimensions without letterboxing", () => {
    const { ctx } = createDetailsVmContext();

    const mockImg = {
        naturalWidth: 1000,
        naturalHeight: 1000,
        width: 1000,
        height: 1000
    };

    let drawnCalls = [];

    // Mock HTMLCanvasElement creation
    ctx.document.createElement = (tag) => {
        if (tag === "canvas") {
            const canvas = {
                width: 0,
                height: 0,
                getContext: (type) => ({
                    fillStyle: "",
                    fillRect: () => {},
                    imageSmoothingEnabled: false,
                    imageSmoothingQuality: "",
                    drawImage: (...args) => {
                        drawnCalls.push(args);
                    }
                }),
                toDataURL: (fmt, quality) => `data:${fmt};base64,mockCroppedData`
            };
            return canvas;
        }
        return { style: {}, appendChild: () => {} };
    };

    const canvas = ctx.cropImageToCanvas(mockImg, 970, 300);
    assert.ok(canvas);
    assert.strictEqual(canvas.width, 970);
    assert.strictEqual(canvas.height, 300);
    assert.strictEqual(drawnCalls.length, 1);

    // Center crop math:
    // scale = Math.max(970/1000, 300/1000) = 0.97
    // renderW = 970, renderH = 970
    // offsetX = (970 - 970)/2 = 0
    // offsetY = (300 - 970)/2 = -335
    const [img, dx, dy, dw, dh] = drawnCalls[0];
    assert.strictEqual(img, mockImg);
    assert.strictEqual(dx, 0);
    assert.strictEqual(dy, -335);
    assert.strictEqual(dw, 970);
    assert.strictEqual(dh, 970);
});

test("downloadAmazonAPlusCrops shows warning toast when no generated module images exist", async () => {
    const { ctx, getLastToast } = createDetailsVmContext();

    // Context without globalGenContext
    ctx.globalGenContext = null;
    await ctx.downloadAmazonAPlusCrops();
    let toast = getLastToast();
    assert.ok(toast);
    assert.strictEqual(toast.type, "warning");
    assert.ok(toast.msg.includes("暂无已生成的详情页模块"));

    // Context with empty tasks
    ctx.globalGenContext = { tasks: {} };
    await ctx.downloadAmazonAPlusCrops();
    toast = getLastToast();
    assert.ok(toast);
    assert.strictEqual(toast.type, "warning");
    assert.ok(toast.msg.includes("暂无可导出的模块图片"));
});

test("openStandalonePdpPreview opens self-contained preview tab via window.open", () => {
    const { ctx, getOpenedUrl, getLastToast } = createDetailsVmContext();

    const pdpContainer = ctx.document.getElementById("dtcHybridContainer");
    pdpContainer.innerHTML = "<div class='dtc-pdp-wrapper'><h1>Brand Title</h1><p>Description</p></div>";

    ctx.globalGenContext = {
        config: { productName: "Ergonomic Office Chair", language: "en" },
        tasks: {
            t1: { imageSrc: "data:image/jpeg;base64,sample1" }
        }
    };

    ctx.openStandalonePdpPreview();
    const opened = getOpenedUrl();
    assert.ok(opened, "window.open should have been called");
    assert.ok(opened.url.startsWith("blob:mock-url-"), "URL should be an object URL");
    assert.strictEqual(opened.target, "_blank");

    const toast = getLastToast();
    assert.ok(toast);
    assert.strictEqual(toast.type, "success");
    assert.ok(toast.msg.includes("已在新窗口打开纯净独立站预览"));
});

test("setDetailProductImage sets image in details queue and renders previews", () => {
    const { ctx, getLastToast } = createDetailsVmContext();

    const sampleBase64 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    ctx.setDetailProductImage(sampleBase64, "watermark_removed_sample.png", true);

    const toast = getLastToast();
    assert.ok(toast);
    assert.strictEqual(toast.type, "success");
    assert.ok(toast.msg.includes("主图"));

    const currentImages = ctx.getCurrentUploadedImages();
    assert.ok(Array.isArray(currentImages));
    assert.ok(currentImages.length >= 1);
    assert.strictEqual(currentImages[0].name, "watermark_removed_sample.png");
    assert.strictEqual(currentImages[0].isPrimary, true);
});

test("sendSquareRedrawToDetails bridges redrawn image to details.js and switches tab to generate", async () => {
    const { ctx } = createDetailsVmContext();

    let detailImageSet = null;
    ctx.setDetailProductImage = (base64, filename, asPrimary) => {
        detailImageSet = { base64, filename, asPrimary };
    };
    let switchedTo = null;
    ctx.switchMainTab = (tab) => {
        switchedTo = tab;
        ctx.localStorage.setItem('activeMainTab', tab);
    };

    // Load square_redraw.js in context
    vm.runInContext(fs.readFileSync(path.join(root, "js", "square_redraw.js"), "utf8"), ctx);

    // Mock square redraw items
    ctx.setSquareRedrawImages([
        { id: "item_123", filename: "redrawn_product.jpg", output_url: "data:image/jpeg;base64,abc123redrawn", status: "done" }
    ]);

    await ctx.sendSquareRedrawToDetails("item_123");
    assert.ok(detailImageSet);
    assert.strictEqual(detailImageSet.filename, "redrawn_product.jpg");
    assert.strictEqual(detailImageSet.asPrimary, true);
    assert.strictEqual(detailImageSet.base64, "data:image/jpeg;base64,abc123redrawn");
    assert.ok(switchedTo === "generate" || ctx.localStorage.getItem("activeMainTab") === "generate");
});

test("resetAllAppDraftsAndState purges all drafts and triggers modular resets", () => {
    const { resetAllAppDraftsAndState } = require("../js/utils.js");
    const removedKeys = [];
    global.localStorage = {
        removeItem: (k) => removedKeys.push(k)
    };
    let analysisResetCalled = false;
    let listingResetCalled = false;
    let adsResetCalled = false;
    let detailResetCalled = false;
    let toastMessage = null;

    global.showToast = (msg, type) => { toastMessage = { msg, type }; };
    global.xp_resetAnalysisSession = () => { analysisResetCalled = true; };
    global.clearListingDraft = () => { listingResetCalled = true; };
    global.clearAdsDraft = () => { adsResetCalled = true; };
    global.clearDetailInputs = () => { detailResetCalled = true; };

    resetAllAppDraftsAndState();

    assert.ok(removedKeys.includes('xuanpin_last_result_v27'));
    assert.ok(removedKeys.includes('xuanpin_last_urls_v27'));
    assert.ok(removedKeys.includes('ai_ecommerce_listing_draft_v1'));
    assert.ok(removedKeys.includes('ai_ecommerce_ads_draft_v1'));
    assert.ok(analysisResetCalled);
    assert.ok(listingResetCalled);
    assert.ok(adsResetCalled);
    assert.ok(detailResetCalled);
    assert.ok(toastMessage);
    assert.strictEqual(toastMessage.type, 'success');

    // Clean up globals
    delete global.localStorage;
    delete global.showToast;
    delete global.xp_resetAnalysisSession;
    delete global.clearListingDraft;
    delete global.clearAdsDraft;
    delete global.clearDetailInputs;
});

test("sidebar contains 4 distinct functional group badges and supports expansion toggle", () => {
    const indexHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");

    // 1. Check HTML contains 4 functional group sections
    assert.match(indexHtml, /nav-group-badge[^>]*>业务</);
    assert.match(indexHtml, /nav-group-badge[^>]*>视觉</);
    assert.match(indexHtml, /nav-group-badge[^>]*>翻译</);
    assert.match(indexHtml, /nav-group-badge[^>]*>管理</);

    // 2. Check full titles exist for expanded view
    assert.match(indexHtml, /nav-group-title[^>]*>核心业务流</);
    assert.match(indexHtml, /nav-group-title[^>]*>视觉工坊</);
    assert.match(indexHtml, /nav-group-title[^>]*>语言翻译</);
    assert.match(indexHtml, /nav-group-title[^>]*>系统管理</);

    // 3. Test toggleSidebarExpansion & initSidebarState logic via app.js
    const configJs = fs.readFileSync(path.join(root, "js", "config.js"), "utf8");
    const appJs = fs.readFileSync(path.join(root, "js", "app.js"), "utf8");
    const classSet = new Set();
    const mockSidebar = {
        classList: {
            add: (c) => classSet.add(c),
            remove: (c) => classSet.delete(c),
            contains: (c) => classSet.has(c)
        }
    };
    const storage = {};
    const testContext = {
        console,
        document: {
            getElementById: (id) => (id === "appSidebar" ? mockSidebar : null),
            querySelectorAll: () => []
        },
        localStorage: {
            getItem: (k) => storage[k] || null,
            setItem: (k, v) => { storage[k] = v; }
        },
        window: {},
        globalThis: {}
    };

    vm.createContext(testContext);
    vm.runInContext(configJs, testContext);
    vm.runInContext(appJs, testContext);

    // Initial state: not expanded
    assert.equal(classSet.has("sidebar-expanded"), false);

    // Expand
    testContext.toggleSidebarExpansion(true);
    assert.equal(classSet.has("sidebar-expanded"), true);
    assert.equal(storage["ai_tool_sidebar_expanded"], "true");

    // Collapse
    testContext.toggleSidebarExpansion(false);
    assert.equal(classSet.has("sidebar-expanded"), false);
    assert.equal(storage["ai_tool_sidebar_expanded"], "false");

    // Restore from saved storage
    storage["ai_tool_sidebar_expanded"] = "true";
    testContext.initSidebarState();
    assert.equal(classSet.has("sidebar-expanded"), true);
});
