const assert = require("node:assert/strict");
const test = require("node:test");

const {
    getUtf8ByteLength,
    cleanAndDeduplicateSearchTerms,
    setListingViewMode,
    getCurrentListingViewMode,
    restoreListingFullState,
    adoptTitleAlternative,
    getCurrentListingData,
    setCurrentListingData,
    getListingUploadedBase64,
    setListingUploadedBase64,
    aiFillListingInputs
} = require("../js/listing.js");

test("getUtf8ByteLength calculates byte length accurately", () => {
    assert.equal(getUtf8ByteLength(""), 0);
    assert.equal(getUtf8ByteLength(null), 0);
    assert.equal(getUtf8ByteLength(undefined), 0);
    assert.equal(getUtf8ByteLength("wireless earbuds"), 16);
    // 4 Chinese chars * 3 bytes = 12 bytes
    assert.equal(getUtf8ByteLength("蓝牙耳机"), 12);
    // 9 ASCII chars ("Bluetooth") + 1 space + 6 bytes ("蓝牙") = 16 bytes
    assert.equal(getUtf8ByteLength("Bluetooth 蓝牙"), 16);
});

test("cleanAndDeduplicateSearchTerms deduplicates and filters title words", () => {
    const title = "Echo Dot Smart Speaker with Alexa Charcoal";
    const rawSt = "smart alexa speaker echo portable bluetooth wireless compact Echo SMART";

    const result = cleanAndDeduplicateSearchTerms(rawSt, title);
    // "smart", "alexa", "speaker", "echo" appear in title, so they should be filtered out
    // "Echo" and "SMART" are duplicates/title words
    assert.equal(result.terms, "portable bluetooth wireless compact");
    assert.equal(result.wordCount, 4);
    assert.equal(result.byteLength, 35);
});

test("cleanAndDeduplicateSearchTerms handles punctuation, duplicates and stays <= 249 bytes", () => {
    const rawSt = "noise-cancelling, bass boost; ultra-light weight bass boost noise cancelling";
    const result = cleanAndDeduplicateSearchTerms(rawSt, "Unrelated Product");

    // "bass" and "boost" should only appear once
    const words = result.terms.split(" ");
    assert.equal(words.filter(w => w === "bass").length, 1);
    assert.equal(words.filter(w => w === "boost").length, 1);

    // Test byte limit trimming
    const longWords = Array(60).fill("superlongsearchterm").join(" ");
    const trimmed = cleanAndDeduplicateSearchTerms(longWords, "");
    assert.ok(trimmed.byteLength <= 249);
    assert.ok(getUtf8ByteLength(trimmed.terms) <= 249);
    assert.ok(!trimmed.terms.endsWith(" "));
});

test("setListingViewMode updates view mode and container classes", () => {
    const classes = new Set();
    const mockContainer = {
        classList: {
            add: (...args) => args.forEach(c => classes.add(c)),
            remove: (...args) => args.forEach(c => classes.delete(c)),
            contains: (c) => classes.has(c)
        }
    };
    const mockButtons = {
        btnViewBilingual: { className: "" },
        btnViewTarget: { className: "" },
        btnViewZh: { className: "" }
    };

    const origDoc = globalThis.document;
    globalThis.document = {
        getElementById: (id) => {
            if (id === "listingResults") return mockContainer;
            return mockButtons[id] || null;
        }
    };

    try {
        setListingViewMode("target");
        assert.equal(getCurrentListingViewMode(), "target");
        assert.ok(classes.has("listing-view-target"));
        assert.ok(!classes.has("listing-view-zh"));

        setListingViewMode("zh");
        assert.equal(getCurrentListingViewMode(), "zh");
        assert.ok(!classes.has("listing-view-target"));
        assert.ok(classes.has("listing-view-zh"));

        setListingViewMode("bilingual");
        assert.equal(getCurrentListingViewMode(), "bilingual");
        assert.ok(!classes.has("listing-view-target"));
        assert.ok(!classes.has("listing-view-zh"));
    } finally {
        globalThis.document = origDoc;
    }
});

test("restoreListingFullState restores form inputs and calls renderListingData", () => {
    const mockElements = {
        listingName: { value: "" },
        listingCategory: { value: "" },
        listingKeywords: { value: "" },
        listingPoints: { value: "" },
        listingTargetAudience: { value: "" },
        listingSpecs: { value: "" },
        listingStyleSelect: { value: "", options: [] },
        listingRegionSelect: { value: "" },
        listingLanguageSelect: { value: "" },
        listingMarketingThemeSelect: { value: "" },
        listingEmpty: { classList: { add: () => {} } },
        listingResults: { classList: { add: () => {}, remove: () => {} } },
        btnRiskCheck: { classList: { remove: () => {} } },
        listingViewModeBar: { classList: { remove: () => {}, add: () => {} } },
        listingExportBar: { classList: { remove: () => {}, add: () => {} } }
    };

    const origDoc = globalThis.document;
    globalThis.document = {
        getElementById: (id) => mockElements[id] || null,
        createElement: () => ({
            className: "",
            textContent: "",
            appendChild: () => {},
            classList: { add: () => {} }
        })
    };

    try {
        const savedProject = {
            result: {
                title: { target: "Restored Title", zh: "恢复标题" },
                bullets: [{ target: "Bullet 1", zh: "卖点1" }],
                description: { target: "Desc", zh: "描述" }
            },
            _inputs: {
                name: "Saved Product Name",
                category: "Electronics",
                keywords: "earbuds, wireless",
                points: "Noise cancelling",
                target_language: "English"
            }
        };

        restoreListingFullState(savedProject);

        assert.equal(mockElements.listingName.value, "Saved Product Name");
        assert.equal(mockElements.listingKeywords.value, "earbuds, wireless");
        assert.equal(mockElements.listingPoints.value, "Noise cancelling");
        assert.equal(mockElements.listingLanguageSelect.value, "English");
    } finally {
        globalThis.document = origDoc;
    }
});

test("adoptTitleAlternative switches active target title and moves old title to alternatives", () => {
    const listingData = {
        title: {
            target: "Original Title",
            zh: "原始标题"
        },
        titleAlternatives: [
            { target: "Alternative Title Alpha", zh: "备选1" },
            { target: "Alternative Title Beta", zh: "备选2" }
        ]
    };
    setCurrentListingData(listingData);

    const makeMockEl = () => ({
        className: "",
        textContent: "",
        innerHTML: "",
        appendChild: () => {},
        append: () => {},
        classList: { add: () => {}, remove: () => {} }
    });

    const origDoc = globalThis.document;
    const toasts = [];
    globalThis.showToast = (msg, type) => toasts.push({ msg, type });
    globalThis.document = {
        getElementById: () => makeMockEl(),
        createElement: () => makeMockEl()
    };

    try {
        adoptTitleAlternative(1);
        const current = getCurrentListingData();
        // The main title should now be Alternative Title Beta
        assert.equal(current.title.target, "Alternative Title Beta");
        // Alternative 1 should now store the swapped Original Title
        assert.equal(current.titleAlternatives[1].target, "Original Title");
        assert.ok(toasts.some(t => t.msg.includes("已采纳备选标题")));
    } finally {
        globalThis.document = origDoc;
        delete globalThis.showToast;
    }
});

test("aiFillListingInputs preserves existing user-entered product name", async () => {
    const mockNameInput = { value: "User Defined Product Name" };
    const mockPointsInput = { value: "" };
    const mockKeywordsInput = { value: "" };
    const mockBtn = { innerHTML: "", disabled: false };

    const origDoc = globalThis.document;
    const origPost = globalThis.postListingApi;
    const origFetch = globalThis.fetch;
    const origApiBase = globalThis.API_BASE;
    globalThis.API_BASE = "http://localhost:9503";

    setListingUploadedBase64("data:image/png;base64,mock");
    assert.equal(getListingUploadedBase64(), "data:image/png;base64,mock");

    const toasts = [];
    globalThis.showToast = (msg, type) => toasts.push({ msg, type });
    globalThis.fetch = async () => ({
        json: async () => ({
            status: "success",
            data: {
                name: "AI Extracted Overwrite Name",
                points: "Extracted feature 1",
                keywords: "extracted, keywords"
            }
        })
    });

    globalThis.document = {
        getElementById: (id) => {
            if (id === "listingName") return mockNameInput;
            if (id === "listingPoints") return mockPointsInput;
            if (id === "listingKeywords") return mockKeywordsInput;
            if (id === "aiListingExtractBtn") return mockBtn;
            return null;
        }
    };

    try {
        await aiFillListingInputs();
        // User defined product name must NOT be overwritten!
        assert.equal(mockNameInput.value, "User Defined Product Name");
        // Points and keywords should be filled
        assert.equal(mockPointsInput.value, "Extracted feature 1");
        assert.equal(mockKeywordsInput.value, "extracted, keywords");
        assert.ok(toasts.some(t => t.msg.includes("已保留原产品名称")));
    } finally {
        globalThis.document = origDoc;
        globalThis.fetch = origFetch;
        globalThis.API_BASE = origApiBase;
        setListingUploadedBase64(null);
        delete globalThis.showToast;
    }
});

test("copyAllListingText copies content and falls back to DOM when state is null", async () => {
    const {
        copyAllListingText,
        setCurrentListingData,
        toggleListingCopyDropdown,
        toggleListingExportDropdown,
        hideListingDropdowns
    } = require("../js/listing.js");

    // Setup state
    setCurrentListingData({
        title: { target: "Echo Dot", zh: "智能音箱" },
        bullets: [{ target: "Voice control", zh: "语音控制" }],
        description: { target: "Great speaker", zh: "音质出众" },
        searchTerms: { target: "smart audio", zh: "" }
    });

    let copiedText = "";
    const origNavDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
        value: {
            clipboard: {
                writeText: (t) => {
                    copiedText = t;
                    return Promise.resolve();
                }
            }
        },
        configurable: true,
        writable: true
    });
    const origDoc = globalThis.document;
    const toasts = [];
    globalThis.showToast = (msg, type) => toasts.push({ msg, type });

    try {
        // Target mode
        copyAllListingText("target");
        await Promise.resolve();
        assert.ok(copiedText.includes("【TITLE】\nEcho Dot"));
        assert.ok(copiedText.includes("1. Voice control"));
        assert.ok(copiedText.includes("【SEARCH TERMS (249 Bytes)】\nsmart audio"));
        assert.ok(toasts.some(t => t.msg.includes("纯外文")));

        // Bilingual mode
        copiedText = "";
        copyAllListingText("bilingual");
        await Promise.resolve();
        assert.ok(copiedText.includes("外文: Echo Dot"));
        assert.ok(copiedText.includes("中文: 智能音箱"));
        assert.ok(toasts.some(t => t.msg.includes("双语对照")));

        // Chinese mode
        copiedText = "";
        copyAllListingText("zh");
        await Promise.resolve();
        assert.ok(copiedText.includes("【产品标题】\n智能音箱"));
        assert.ok(toasts.some(t => t.msg.includes("纯中文")));

        // DOM Fallback test when currentListingDataText is null
        setCurrentListingData(null);
        globalThis.document = {
            getElementById: (id) => {
                if (id === "resListingTitle") {
                    return {
                        querySelector: (sel) => sel === ".target-text" ? { textContent: "DOM Title" } : { textContent: "DOM 标题" },
                        textContent: "DOM Title"
                    };
                }
                if (id === "resListingDesc") {
                    return {
                        querySelector: (sel) => sel === ".target-text" ? { textContent: "DOM Desc" } : { textContent: "DOM 描述" },
                        textContent: "DOM Desc"
                    };
                }
                if (id === "resListingSearchTerms") {
                    return { textContent: "dom search terms" };
                }
                if (id === "resListingBullets") {
                    return {
                        querySelectorAll: () => [
                            {
                                querySelector: (sel) => sel === ".target-text" ? { textContent: "DOM Bullet 1" } : { textContent: "DOM 卖点 1" }
                            }
                        ]
                    };
                }
                return null;
            }
        };

        copiedText = "";
        copyAllListingText("target");
        assert.ok(copiedText.includes("DOM Title"));
        assert.ok(copiedText.includes("DOM Bullet 1"));
        assert.ok(copiedText.includes("dom search terms"));
    } finally {
        if (origNavDescriptor) {
            Object.defineProperty(globalThis, "navigator", origNavDescriptor);
        } else {
            delete globalThis.navigator;
        }
        globalThis.document = origDoc;
        delete globalThis.showToast;
    }
});

test("exportListingToFile sanitizes filenames and generates downloads", () => {
    const {
        exportListingToFile,
        setCurrentListingData
    } = require("../js/listing.js");

    setCurrentListingData({
        title: { target: "Anker USB-C Charger", zh: "充电器" },
        bullets: [{ target: "Fast charge", zh: "快速充电" }],
        description: { target: "Compact size", zh: "小巧便携" },
        searchTerms: { target: "charger adapter", zh: "" }
    });

    let downloadedFilename = "";
    let downloadedContent = "";

    const origBlob = globalThis.Blob;
    const origUrl = globalThis.URL;
    const origDoc = globalThis.document;
    const toasts = [];

    globalThis.showToast = (msg, type) => toasts.push({ msg, type });
    globalThis.Blob = class {
        constructor(parts) {
            this.content = parts.join("");
        }
    };
    globalThis.URL = {
        createObjectURL: (blob) => {
            downloadedContent = blob.content;
            return "blob:mock-url";
        },
        revokeObjectURL: () => {}
    };

    const mockAnchor = {
        style: {},
        href: "",
        download: "",
        click: () => { downloadedFilename = mockAnchor.download; },
        parentNode: { removeChild: () => {} }
    };

    globalThis.document = {
        getElementById: (id) => {
            if (id === "listingName") return { value: "Anker 20W USB-C / Type-C" }; // Contains slash
            if (id === "listingLanguageSelect") return { value: "English" };
            return null;
        },
        createElement: (tag) => {
            if (tag === "a") return mockAnchor;
            return {};
        },
        body: {
            appendChild: () => {},
            removeChild: () => {}
        }
    };

    try {
        // Test TXT export
        exportListingToFile("txt");
        assert.ok(downloadedFilename.endsWith(".txt"));
        // Slash should be sanitized to underscore
        assert.ok(!downloadedFilename.includes("/"));
        assert.ok(downloadedFilename.includes("Anker 20W USB-C _ Type-C"));
        assert.ok(downloadedContent.includes("[TITLE]\nAnker USB-C Charger"));

        // Test MD export
        downloadedFilename = "";
        downloadedContent = "";
        exportListingToFile("md");
        assert.ok(downloadedFilename.endsWith(".md"));
        assert.ok(!downloadedFilename.includes("/"));
        assert.ok(downloadedContent.includes("# Anker 20W USB-C / Type-C - Product Listing"));
        assert.ok(downloadedContent.includes("## 1. Product Title"));
    } finally {
        globalThis.Blob = origBlob;
        globalThis.URL = origUrl;
        globalThis.document = origDoc;
        delete globalThis.showToast;
    }
});

test("toggleListingCopyDropdown, toggleListingExportDropdown, and hideListingDropdowns toggle classes", () => {
    const {
        toggleListingCopyDropdown,
        toggleListingExportDropdown,
        hideListingDropdowns
    } = require("../js/listing.js");

    const copyMenu = {
        classes: new Set(["hidden"]),
        classList: {
            add: (c) => copyMenu.classes.add(c),
            remove: (c) => copyMenu.classes.delete(c),
            toggle: (c) => copyMenu.classes.has(c) ? copyMenu.classes.delete(c) : copyMenu.classes.add(c)
        }
    };

    const exportMenu = {
        classes: new Set(["hidden"]),
        classList: {
            add: (c) => exportMenu.classes.add(c),
            remove: (c) => exportMenu.classes.delete(c),
            toggle: (c) => exportMenu.classes.has(c) ? exportMenu.classes.delete(c) : exportMenu.classes.add(c)
        }
    };

    const origDoc = globalThis.document;
    globalThis.document = {
        getElementById: (id) => {
            if (id === "listingCopyDropdownMenu") return copyMenu;
            if (id === "listingExportDropdownMenu") return exportMenu;
            return null;
        }
    };

    try {
        toggleListingCopyDropdown({ stopPropagation: () => {} });
        assert.equal(copyMenu.classes.has("hidden"), false); // Should now be visible
        assert.equal(exportMenu.classes.has("hidden"), true);

        toggleListingExportDropdown({ stopPropagation: () => {} });
        assert.equal(copyMenu.classes.has("hidden"), true); // Copy should close when export opens
        assert.equal(exportMenu.classes.has("hidden"), false); // Export visible

        hideListingDropdowns();
        assert.equal(copyMenu.classes.has("hidden"), true);
        assert.equal(exportMenu.classes.has("hidden"), true);
    } finally {
        globalThis.document = origDoc;
    }
});

test("insertListingFactSlot inserts factual slot tag into listingPoints textarea", () => {
    let focusCalled = false;
    let rangeSet = null;
    const mockTextarea = {
        value: "天然藤编吊灯",
        focus: () => { focusCalled = true; },
        setSelectionRange: (s, e) => { rangeSet = [s, e]; }
    };
    const origDoc = globalThis.document;
    globalThis.document = {
        getElementById: (id) => id === "listingPoints" ? mockTextarea : null
    };
    try {
        const { insertListingFactSlot } = require("../js/listing.js");
        insertListingFactSlot("material");
        assert.ok(mockTextarea.value.includes("【材质工艺】: "));
        assert.ok(focusCalled);
        assert.ok(rangeSet !== null);
    } finally {
        globalThis.document = origDoc;
    }
});

test("toggleListingAdvancedConfig toggles hidden class and text", () => {
    const container = {
        classes: new Set(["hidden"]),
        classList: {
            contains: (c) => container.classes.has(c),
            add: (c) => container.classes.add(c),
            remove: (c) => container.classes.delete(c)
        }
    };
    const text = { textContent: "展开" };
    const icon = { className: "ph ph-caret-down" };
    const origDoc = globalThis.document;
    globalThis.document = {
        getElementById: (id) => {
            if (id === "listingAdvancedConfigContainer") return container;
            if (id === "listingAdvancedConfigToggleText") return text;
            if (id === "listingAdvancedConfigToggleIcon") return icon;
            return null;
        }
    };
    try {
        const { toggleListingAdvancedConfig } = require("../js/listing.js");
        toggleListingAdvancedConfig();
        assert.equal(container.classes.has("hidden"), false);
        assert.equal(text.textContent, "收起");

        toggleListingAdvancedConfig();
        assert.equal(container.classes.has("hidden"), true);
        assert.equal(text.textContent, "展开");
    } finally {
        globalThis.document = origDoc;
    }
});

test("applyRegeneratedSection updates in-memory listing data accurately", () => {
    const {
        applyRegeneratedSection,
        getCurrentListingData,
        setCurrentListingData
    } = require("../js/listing.js");

    const initialData = {
        title: { target: "Old Title", zh: "旧标题" },
        bullets: [{ target: "Old Bullet 1", zh: "旧卖点1" }, { target: "Old Bullet 2", zh: "旧卖点2" }],
        description: { target: "Old Desc", zh: "旧描述" },
        searchTerms: { target: "old terms", zh: "旧搜索词" }
    };
    setCurrentListingData(initialData);

    // Test title regeneration update
    applyRegeneratedSection("title", null, {
        title: { target: "New Crisp Title", zh: "新精炼标题" },
        titleAlternatives: [{ target: "Alt 1", zh: "备选1" }]
    });
    const afterTitle = getCurrentListingData();
    assert.equal(afterTitle.title.target, "New Crisp Title");
    assert.equal(afterTitle.titleAlternatives.length, 1);

    // Test single bullet regeneration update (index 1)
    applyRegeneratedSection("bullet", 1, {
        bullet: { target: "[QUICK SETUP] Takes 30 seconds...", zh: "30秒快速安装" }
    });
    const afterBullet = getCurrentListingData();
    assert.equal(afterBullet.bullets[0].target, "Old Bullet 1");
    assert.equal(afterBullet.bullets[1].target, "[QUICK SETUP] Takes 30 seconds...");
});

test("toggleListingHistoryDrawer toggles hidden class", () => {
    const drawer = {
        classes: new Set(["hidden"]),
        classList: {
            contains: (c) => drawer.classes.has(c),
            add: (c) => drawer.classes.add(c),
            remove: (c) => drawer.classes.delete(c)
        }
    };
    const origDoc = globalThis.document;
    globalThis.document = {
        getElementById: (id) => id === "listingHistoryDrawer" ? drawer : null
    };
    try {
        const { toggleListingHistoryDrawer } = require("../js/listing.js");
        toggleListingHistoryDrawer(true);
        assert.equal(drawer.classes.has("hidden"), false);

        toggleListingHistoryDrawer(false);
        assert.equal(drawer.classes.has("hidden"), true);
    } finally {
        globalThis.document = origDoc;
    }
});

test("loadListingHistoryDrawerList renders DB records without throwing Cannot read properties of undefined", async () => {
    const mockList = {
        children: [],
        innerHTML: "",
        appendChild: (el) => mockList.children.push(el)
    };
    const mockBadge = {
        textContent: "0",
        classes: new Set(["hidden"]),
        classList: {
            remove: (c) => mockBadge.classes.delete(c),
            add: (c) => mockBadge.classes.add(c)
        }
    };
    const origDoc = globalThis.document;
    const origFetch = globalThis.fetch;

    const mockHistoryData = [
        {
            id: 101,
            product_name: "Smart Watch",
            platform: "Amazon",
            timestamp: "2026-09-18T10:00:00.000Z",
            result: {
                title: { target: "Smart Fitness Watch", zh: "智能手表" },
                bullets: [{ target: "[BATTERY] 10 days runtime", zh: "续航10天" }]
            }
        },
        {
            id: 102,
            product_name: "Coffee Tumbler",
            platform: "TikTok",
            timestamp: "2026-09-18T11:00:00.000Z",
            result: JSON.stringify({
                title: { target: "Insulated Tumbler", zh: "保温杯" }
            })
        }
    ];

    globalThis.fetch = async () => ({
        ok: true,
        json: async () => mockHistoryData
    });

    globalThis.document = {
        getElementById: (id) => {
            if (id === "listingHistoryList") return mockList;
            if (id === "listingHistoryCountBadge") return mockBadge;
            return null;
        },
        createElement: (tag) => {
            const el = {
                tag,
                className: "",
                textContent: "",
                innerHTML: "",
                children: [],
                append: (...items) => el.children.push(...items),
                appendChild: (child) => el.children.push(child)
            };
            return el;
        }
    };

    try {
        const { loadListingHistoryDrawerList } = require("../js/listing.js");
        await loadListingHistoryDrawerList();
        assert.equal(mockList.children.length, 2);
        assert.equal(mockBadge.textContent, 2);
        assert.equal(mockBadge.classes.has("hidden"), false);
    } finally {
        globalThis.document = origDoc;
        globalThis.fetch = origFetch;
    }
});

test("onListingEmojiToggleChange updates hint and localStorage", () => {
    const hint = { textContent: "", className: "" };
    const toggle = { checked: false };
    const origDoc = globalThis.document;
    const origStorage = globalThis.localStorage;

    const storageMap = new Map();
    globalThis.localStorage = {
        getItem: (k) => storageMap.get(k) || null,
        setItem: (k, v) => storageMap.set(k, String(v))
    };

    globalThis.document = {
        getElementById: (id) => {
            if (id === "listingEmojiStatusHint") return hint;
            if (id === "listingIncludeEmojiToggle") return toggle;
            return null;
        }
    };

    try {
        const { onListingEmojiToggleChange } = require("../js/listing.js");
        onListingEmojiToggleChange(true);
        assert.equal(hint.textContent.includes("开启"), true);
        assert.equal(toggle.checked, true);
        assert.equal(globalThis.localStorage.getItem("listing_include_emoji"), "true");

        onListingEmojiToggleChange(false);
        assert.equal(hint.textContent.includes("关闭"), true);
        assert.equal(toggle.checked, false);
        assert.equal(globalThis.localStorage.getItem("listing_include_emoji"), "false");
    } finally {
        globalThis.document = origDoc;
        globalThis.localStorage = origStorage;
    }
});

test("index.html contains listingIncludeEmojiToggle switch", () => {
    const fs = require("fs");
    const path = require("path");
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.equal(html.includes('id="listingIncludeEmojiToggle"'), true);
    assert.equal(html.includes('id="listingEmojiStatusHint"'), true);
});

test("buildListingDtcHtml produces self-contained HTML with scoped CSS, features and trust bar", () => {
    const { buildListingDtcHtml } = require("../js/listing.js");
    const mockData = {
        title: { target: "Ergonomic Office Chair with 3D Armrests", zh: "人体工学电脑椅" },
        bullets: [
            { target: "[LUMBAR SUPPORT] Dynamic 3D self-adjusting cushion protects spine", zh: "自适应腰靠" },
            { target: "⚡ [FAST SETUP] Complete assembly in under 10 minutes", zh: "10分钟快捷安装" }
        ],
        description: { target: "Engineered for maximum posture health and comfort.\nBuilt to last all day.", zh: "专为健康坐姿设计。" },
        faq: [
            { q: { target: "What is the weight capacity?", zh: "承重是多少？" }, a: { target: "Up to 330 lbs.", zh: "最高330磅。" } }
        ]
    };

    // 1. Target mode (Foreign DTC Store)
    const htmlTarget = buildListingDtcHtml(mockData, "target");
    assert.equal(htmlTarget.includes("<style>"), true);
    assert.equal(htmlTarget.includes(".dtc-listing-wrapper"), true);
    assert.equal(htmlTarget.includes("Ergonomic Office Chair with 3D Armrests"), true);
    assert.equal(htmlTarget.includes("LUMBAR SUPPORT"), true);
    assert.equal(htmlTarget.includes("FAST SETUP"), true);
    assert.equal(htmlTarget.includes("Fast Global Shipping"), true);
    assert.equal(htmlTarget.includes("<details>"), true);
    assert.equal(htmlTarget.includes("application/ld+json"), true);
    // Should NOT have bilingual Chinese sub lines in target mode
    assert.equal(htmlTarget.includes('<div class="dtc-feature-zh">'), false);

    // 2. Bilingual mode
    const htmlBilingual = buildListingDtcHtml(mockData, "bilingual");
    assert.equal(htmlBilingual.includes("人体工学电脑椅"), true);
    assert.equal(htmlBilingual.includes("自适应腰靠"), true);
    assert.equal(htmlBilingual.includes("dtc-feature-zh"), true);
});

test("index.html contains DTC HTML modal and toolbar button in Details studio", () => {
    const fs = require("fs");
    const path = require("path");
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    // Listing toolbar should NOT contain the DTC button (purified for marketplaces)
    assert.equal(html.includes('id="btnOpenListingDtcHtmlModal"'), false);
    // Details studio toolbar contains the DTC HTML description modal trigger
    assert.equal(html.includes('id="btnOpenDetailDtcHtmlModal"'), true);
    // Global DTC HTML preview modal and components exist
    assert.equal(html.includes('id="listingDtcHtmlModal"'), true);
    assert.equal(html.includes('id="listingDtcHtmlPreviewFrame"'), true);
    assert.equal(html.includes('id="listingDtcHtmlCodeArea"'), true);
    assert.equal(html.includes('id="btnDtcHtmlViewportDesktop"'), true);
    assert.equal(html.includes('id="btnDtcHtmlViewportMobile"'), true);
    // Listing sidebar indicates marketplace platforms
    assert.equal(html.includes("第三方平台刊登 (Amazon / TikTok / eBay / Etsy)"), true);
});

test("setListingDtcHtmlViewport and setListingDtcHtmlTab manage modal DOM states", () => {
    const {
        setListingDtcHtmlViewport,
        setListingDtcHtmlTab
    } = require("../js/listing.js");

    const previewWrap = {
        style: {},
        classes: new Set(),
        classList: {
            add: (c) => previewWrap.classes.add(c),
            remove: (c) => previewWrap.classes.delete(c)
        }
    };
    const btnDesktop = { className: "" };
    const btnMobile = { className: "" };
    const codeWrap = {
        classes: new Set(["hidden"]),
        classList: {
            add: (c) => codeWrap.classes.add(c),
            remove: (c) => codeWrap.classes.delete(c)
        }
    };
    const btnPreview = { className: "" };
    const btnCode = { className: "" };

    const origDoc = globalThis.document;
    globalThis.document = {
        getElementById: (id) => {
            if (id === "listingDtcHtmlPreviewWrapper") return previewWrap;
            if (id === "btnDtcHtmlViewportDesktop") return btnDesktop;
            if (id === "btnDtcHtmlViewportMobile") return btnMobile;
            if (id === "listingDtcHtmlCodeWrapper") return codeWrap;
            if (id === "btnDtcHtmlTabPreview") return btnPreview;
            if (id === "btnDtcHtmlTabCode") return btnCode;
            return null;
        }
    };

    try {
        // Test mobile viewport
        setListingDtcHtmlViewport("mobile");
        assert.equal(previewWrap.style.maxWidth, "375px");

        // Test desktop viewport
        setListingDtcHtmlViewport("desktop");
        assert.equal(previewWrap.style.maxWidth, "100%");

        // Test code tab
        setListingDtcHtmlTab("code");
        assert.equal(codeWrap.classes.has("hidden"), false);

        // Test preview tab
        setListingDtcHtmlTab("preview");
        assert.equal(codeWrap.classes.has("hidden"), true);
    } finally {
        globalThis.document = origDoc;
    }
});

test("openDetailDtcHtmlModal and getDetailDtcHtmlData populate modal from details inputs", () => {
    const { getDetailDtcHtmlData, openDetailDtcHtmlModal } = require("../js/details.js");

    const modal = {
        classes: new Set(["hidden"]),
        classList: {
            remove: (c) => modal.classes.delete(c),
            add: (c) => modal.classes.add(c)
        }
    };
    const codeArea = { value: "" };
    const iframe = { srcdoc: "" };

    const prodNameInput = { value: "Minimalist Ceramic Mug" };
    const sellingPointsText = { value: "- Handcrafted stoneware clay\n- Ergonomic matte handle\n- 350ml capacity" };
    const productFactsText = { value: "Fired at 1280°C for superior chip resistance. Microwave & dishwasher safe." };

    const origDoc = globalThis.document;
    globalThis.document = {
        getElementById: (id) => {
            if (id === "listingDtcHtmlModal") return modal;
            if (id === "listingDtcHtmlCodeArea") return codeArea;
            if (id === "listingDtcHtmlPreviewFrame") return iframe;
            if (id === "productNameInput") return prodNameInput;
            if (id === "sellingPointsText") return sellingPointsText;
            if (id === "productFactsText") return productFactsText;
            return null;
        }
    };

    try {
        const data = getDetailDtcHtmlData();
        assert.equal(data.title.target, "Minimalist Ceramic Mug");
        assert.equal(data.bullets.length, 3);
        assert.equal(data.bullets[0].target, "Handcrafted stoneware clay");
        assert.equal(data.description.target.includes("1280°C"), true);

        openDetailDtcHtmlModal();
        assert.equal(modal.classes.has("hidden"), false);
        assert.equal(codeArea.value.includes("Minimalist Ceramic Mug"), true);
        assert.equal(codeArea.value.includes(".dtc-listing-wrapper"), true);
        assert.equal(iframe.srcdoc.includes("Minimalist Ceramic Mug"), true);
    } finally {
        globalThis.document = origDoc;
    }
});
