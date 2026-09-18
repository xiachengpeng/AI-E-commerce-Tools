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
