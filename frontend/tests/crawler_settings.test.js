const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

if (typeof global.window === "undefined") {
    global.window = global;
}
if (typeof global.document === "undefined") {
    global.document = {
        getElementById: () => null,
        querySelectorAll: () => [],
        createElement: () => ({
            tagName: "",
            classList: { add() {}, remove() {}, contains: () => false },
            setAttribute() {},
            appendChild() {}
        }),
        createTextNode: (t) => ({ textContent: t })
    };
}

const {
    maskedCrawlerKeyPlaceholder,
    buildCrawlerPayload,
    renderCrawlerSettingsBadge,
    renderCrawlerSettings,
    toggleFirecrawlKeyVisibility
} = require("../js/settings.js");

const {
    xp_showError,
    xp_openCrawlerSettings
} = require("../js/analysis.js");

test("maskedCrawlerKeyPlaceholder returns proper text for various configurations", () => {
    assert.equal(maskedCrawlerKeyPlaceholder(null), "未配置 API Key");
    assert.equal(maskedCrawlerKeyPlaceholder({}), "未配置 API Key");
    assert.equal(maskedCrawlerKeyPlaceholder({ has_api_key: false }), "未配置 API Key");
    assert.equal(
        maskedCrawlerKeyPlaceholder({ has_api_key: true, api_key_masked: "fc-123••••789" }),
        "已保存：fc-123••••789"
    );
});

test("buildCrawlerPayload formats and normalizes values properly", () => {
    assert.deepEqual(buildCrawlerPayload(), {
        api_key: "",
        api_url: "https://api.firecrawl.dev/v1/scrape"
    });

    assert.deepEqual(buildCrawlerPayload({
        api_key: "  fc-secret-key  ",
        api_url: "  https://my-firecrawl.local/v1/scrape/  "
    }), {
        api_key: "fc-secret-key",
        api_url: "https://my-firecrawl.local/v1/scrape"
    });

    assert.deepEqual(buildCrawlerPayload({
        api_key: "",
        api_url: ""
    }), {
        api_key: "",
        api_url: "https://api.firecrawl.dev/v1/scrape"
    });
});

test("renderCrawlerSettingsBadge updates badge HTML based on crawler state", () => {
    const originalDocument = global.document;

    const mockBadge = { innerHTML: "" };
    global.document = {
        getElementById: (id) => (id === "settingsCrawlerStatusBadge" ? mockBadge : null)
    };

    try {
        // 1. Unconfigured
        renderCrawlerSettingsBadge(null);
        assert.match(mockBadge.innerHTML, /未配置/);
        assert.match(mockBadge.innerHTML, /settings-badge-disabled/);

        renderCrawlerSettingsBadge({ has_api_key: false });
        assert.match(mockBadge.innerHTML, /未配置/);

        // 2. Success state
        renderCrawlerSettingsBadge({ has_api_key: true, last_test_status: "success" });
        assert.match(mockBadge.innerHTML, /已就绪/);
        assert.match(mockBadge.innerHTML, /settings-badge-enabled/);

        // 3. Error state
        renderCrawlerSettingsBadge({ has_api_key: true, last_test_status: "error" });
        assert.match(mockBadge.innerHTML, /连接异常/);

        renderCrawlerSettingsBadge({ has_api_key: true, last_test_status: "failed" });
        assert.match(mockBadge.innerHTML, /连接异常/);

        // 4. Configured but untested
        renderCrawlerSettingsBadge({ has_api_key: true, last_test_status: null });
        assert.match(mockBadge.innerHTML, /已配置/);
    } finally {
        global.document = originalDocument;
    }
});

test("renderCrawlerSettings populates inputs, placeholder, and test message", () => {
    const originalDocument = global.document;

    const mockBadge = { innerHTML: "" };
    const mockKeyInput = { value: "old-val", placeholder: "" };
    const mockUrlInput = { value: "" };
    const mockMsg = { textContent: "", className: "" };

    global.document = {
        getElementById: (id) => {
            if (id === "settingsCrawlerStatusBadge") return mockBadge;
            if (id === "settingsFirecrawlApiKey") return mockKeyInput;
            if (id === "settingsFirecrawlApiUrl") return mockUrlInput;
            if (id === "settingsCrawlerTestMsg") return mockMsg;
            return null;
        }
    };

    try {
        const crawler = {
            has_api_key: true,
            api_key_masked: "fc-abc••••xyz",
            api_url: "https://custom.firecrawl.io/v1/scrape",
            last_test_status: "success",
            last_test_message: "服务可用",
            last_tested_at: "2026-09-16 12:00:00"
        };

        renderCrawlerSettings(crawler);

        assert.equal(mockKeyInput.value, "");
        assert.equal(mockKeyInput.placeholder, "已保存：fc-abc••••xyz");
        assert.equal(mockUrlInput.value, "https://custom.firecrawl.io/v1/scrape");
        assert.match(mockMsg.textContent, /服务可用/);
        assert.equal(mockMsg.className, "settings-crawler-test-msg is-success");
    } finally {
        global.document = originalDocument;
    }
});

test("toggleFirecrawlKeyVisibility toggles password and text input type", () => {
    const originalDocument = global.document;

    const mockInput = { type: "password" };
    const mockIcon = { className: "ph ph-eye" };

    global.document = {
        getElementById: (id) => {
            if (id === "settingsFirecrawlApiKey") return mockInput;
            if (id === "settingsFirecrawlKeyEyeIcon") return mockIcon;
            return null;
        }
    };

    try {
        toggleFirecrawlKeyVisibility();
        assert.equal(mockInput.type, "text");
        assert.equal(mockIcon.className, "ph ph-eye-slash");

        toggleFirecrawlKeyVisibility();
        assert.equal(mockInput.type, "password");
        assert.equal(mockIcon.className, "ph ph-eye");
    } finally {
        global.document = originalDocument;
    }
});

test("xp_showError renders shortcut button when Firecrawl or 抓取 error occurs", () => {
    const originalDocument = global.document;

    const mockErrorEl = {
        innerHTML: "",
        textContent: "",
        classList: {
            classes: new Set(["xp-hidden"]),
            add(c) { this.classes.add(c); },
            remove(c) { this.classes.delete(c); },
            contains(c) { return this.classes.has(c); }
        },
        appendChild(child) {
            if (typeof child === "object" && child.textContent) {
                this.innerHTML += child.textContent;
            }
        }
    };

    global.document = {
        createElement: (tag) => ({
            tagName: tag.toUpperCase(),
            type: "",
            className: "",
            textContent: "",
            setAttribute() {},
            classList: { add() {}, remove() {} }
        }),
        createTextNode: (text) => ({ textContent: text })
    };

    try {
        // Standard error
        xp_showError(mockErrorEl, "无效的商品链接");
        assert.equal(mockErrorEl.textContent, "无效的商品链接");
        assert.equal(mockErrorEl.classList.contains("xp-hidden"), false);

        // Crawler error
        xp_showError(mockErrorEl, "网页抓取服务未配置，请在系统设置中填入 Firecrawl API Key。");
        assert.match(mockErrorEl.innerHTML, /前往系统设置配置 Key/);
    } finally {
        global.document = originalDocument;
    }
});

test("index.html contains crawler configuration entry and elements", () => {
    const html = fs.readFileSync(
        path.join(__dirname, "..", "index.html"),
        "utf8"
    );

    assert.match(html, /id="xp-btnOpenCrawlerSettings"/);
    assert.match(html, /id="settingsCrawlerCard"/);
    assert.match(html, /id="settingsFirecrawlApiKey"/);
    assert.match(html, /id="settingsFirecrawlApiUrl"/);
    assert.match(html, /id="settingsTestCrawlerBtn"/);
    assert.match(html, /id="settingsSaveCrawlerBtn"/);
});
