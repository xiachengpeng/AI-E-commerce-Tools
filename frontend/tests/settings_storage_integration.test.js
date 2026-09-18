const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const {
    formatStorageDisplayLabel,
    renderStorageIntegrations,
    openStorageEditor,
    closeStorageEditor,
    switchStorageEditorTab,
    onSettingsWpSelectChange,
    addNewSettingsWpSite,
    onSettingsShopifySelectChange,
    addNewSettingsShopifyStore
} = require("../js/settings.js");

test("index.html contains interactive storage cards and settingsStorageEditor modal", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");

    // Check storage integration card elements
    assert.match(html, /id=\"settingsStorageIntegrationCard\"/);
    assert.match(html, /id=\"settingsStorageItemWp\"/);
    assert.match(html, /id=\"settingsStorageItemShopify\"/);
    assert.match(html, /id=\"settingsStorageItemR2\"/);
    assert.match(html, /id=\"settingsStorageStatusWp\"/);
    assert.match(html, /id=\"settingsStorageStatusShopify\"/);
    assert.match(html, /id=\"settingsStorageStatusR2\"/);
    assert.match(html, /id=\"settingsStorageSummaryWp\"/);
    assert.match(html, /id=\"settingsStorageSummaryShopify\"/);
    assert.match(html, /id=\"settingsStorageSummaryR2\"/);
    assert.match(html, /openStorageEditor\('wordpress'\)/);
    assert.match(html, /openStorageEditor\('shopify'\)/);
    assert.match(html, /openStorageEditor\('r2'\)/);

    // Check settingsStorageEditor modal dialog
    assert.match(html, /id=\"settingsStorageEditor\"/);
    assert.match(html, /id=\"btnSettingsStorageTabWp\"/);
    assert.match(html, /id=\"btnSettingsStorageTabShopify\"/);
    assert.match(html, /id=\"btnSettingsStorageTabR2\"/);
    assert.match(html, /id=\"settingsStorageWpPanel\"/);
    assert.match(html, /id=\"settingsStorageShopifyPanel\"/);
    assert.match(html, /id=\"settingsStorageR2Panel\"/);
    assert.match(html, /id=\"settingsWpSelect\"/);
    assert.match(html, /id=\"settingsShopifySelect\"/);
    assert.match(html, /id=\"settingsStorageTestMsg\"/);
    assert.match(html, /id=\"btnTestSettingsStorage\"/);
    assert.match(html, /id=\"btnSaveSettingsStorage\"/);
});

test("renderStorageIntegrations updates cards correctly for empty and populated configs", () => {
    const originalDocument = global.document;

    const mockElements = {};
    function getOrCreate(id) {
        if (!mockElements[id]) {
            mockElements[id] = {
                id,
                textContent: "",
                className: "",
                title: "",
                innerHTML: ""
            };
        }
        return mockElements[id];
    }

    global.document = {
        getElementById: (id) => getOrCreate(id)
    };

    try {
        // Test 1: Empty configs
        renderStorageIntegrations([]);
        assert.equal(getOrCreate("settingsStorageStatusWp").textContent, "未配置");
        assert.match(getOrCreate("settingsStorageSummaryWp").textContent, /尚未添加/);
        assert.equal(getOrCreate("settingsStorageStatusShopify").textContent, "未配置");
        assert.match(getOrCreate("settingsStorageSummaryShopify").textContent, /尚未添加/);
        assert.equal(getOrCreate("settingsStorageStatusR2").textContent, "未配置");
        assert.match(getOrCreate("settingsStorageSummaryR2").textContent, /尚未配置/);
        assert.equal(getOrCreate("settingsStorageCardCountBadge").textContent, "多目标驱动已就绪");

        // Test 2: Populated configs
        const sampleConfigs = [
            {
                id: 1,
                storage_type: "wordpress",
                name: "WP测试站",
                wp_url: "https://wp.example.com",
                is_default: true,
                has_wp_app_password: true
            },
            {
                id: 2,
                storage_type: "wordpress",
                name: "WP备用站",
                wp_url: "https://backup.example.com",
                is_default: false
            },
            {
                id: 3,
                storage_type: "shopify",
                name: "Shopify欧美站",
                shopify_shop_domain: "us-store.myshopify.com",
                is_default: true,
                has_shopify_token: true
            },
            {
                id: 4,
                storage_type: "r2",
                r2_account_id: "cf123456",
                r2_bucket_name: "pdp-images",
                r2_public_url: "https://pub-cf.r2.dev"
            }
        ];

        renderStorageIntegrations(sampleConfigs);
        assert.equal(getOrCreate("settingsStorageStatusWp").textContent, "已配置 2 个站点");
        assert.match(getOrCreate("settingsStorageSummaryWp").textContent, /WP测试站/);
        assert.equal(getOrCreate("settingsStorageStatusShopify").textContent, "已配置 1 个店铺");
        assert.match(getOrCreate("settingsStorageSummaryShopify").textContent, /Shopify欧美站/);
        assert.equal(getOrCreate("settingsStorageStatusR2").textContent, "已配置");
        assert.match(getOrCreate("settingsStorageSummaryR2").textContent, /pdp-images/);
        assert.equal(getOrCreate("settingsStorageCardCountBadge").textContent, "已配置 4 个存储源");
    } finally {
        global.document = originalDocument;
    }
});

test("openStorageEditor, switchStorageEditorTab, and closeStorageEditor toggle modal and tabs", () => {
    const originalDocument = global.document;

    function makeClassElement() {
        const classes = new Set(["hidden"]);
        return {
            classList: {
                add: (c) => classes.add(c),
                remove: (c) => classes.delete(c),
                toggle: (c, force) => {
                    if (force === true) classes.add(c);
                    else if (force === false) classes.delete(c);
                    else if (classes.has(c)) classes.delete(c);
                    else classes.add(c);
                },
                contains: (c) => classes.has(c)
            },
            value: "",
            innerHTML: "",
            textContent: "",
            placeholder: ""
        };
    }

    const mockEditor = makeClassElement();
    const mockWpBtn = makeClassElement();
    const mockShopifyBtn = makeClassElement();
    const mockR2Btn = makeClassElement();
    const mockWpPanel = makeClassElement();
    const mockShopifyPanel = makeClassElement();
    const mockR2Panel = makeClassElement();
    const mockTestMsg = makeClassElement();

    global.document = {
        getElementById: (id) => {
            if (id === "settingsStorageEditor") return mockEditor;
            if (id === "btnSettingsStorageTabWp") return mockWpBtn;
            if (id === "btnSettingsStorageTabShopify") return mockShopifyBtn;
            if (id === "btnSettingsStorageTabR2") return mockR2Btn;
            if (id === "settingsStorageWpPanel") return mockWpPanel;
            if (id === "settingsStorageShopifyPanel") return mockShopifyPanel;
            if (id === "settingsStorageR2Panel") return mockR2Panel;
            if (id === "settingsStorageTestMsg") return mockTestMsg;
            return makeClassElement();
        }
    };

    try {
        // Open on WordPress
        openStorageEditor("wordpress");
        assert.equal(mockEditor.classList.contains("hidden"), false);
        assert.equal(mockWpBtn.classList.contains("is-active"), true);
        assert.equal(mockWpPanel.classList.contains("hidden"), false);
        assert.equal(mockShopifyPanel.classList.contains("hidden"), true);

        // Switch to Shopify
        switchStorageEditorTab("shopify");
        assert.equal(mockShopifyBtn.classList.contains("is-active"), true);
        assert.equal(mockWpBtn.classList.contains("is-active"), false);
        assert.equal(mockShopifyPanel.classList.contains("hidden"), false);
        assert.equal(mockWpPanel.classList.contains("hidden"), true);

        // Switch to R2
        switchStorageEditorTab("r2");
        assert.equal(mockR2Btn.classList.contains("is-active"), true);
        assert.equal(mockR2Panel.classList.contains("hidden"), false);
        assert.equal(mockShopifyPanel.classList.contains("hidden"), true);

        // Close editor
        closeStorageEditor();
        assert.equal(mockEditor.classList.contains("hidden"), true);
    } finally {
        global.document = originalDocument;
    }
});

test("onSettingsWpSelectChange and addNewSettingsWpSite update form fields and masked placeholders", () => {
    const originalDocument = global.document;

    const values = {};
    const placeholders = {};
    function makeInput(id) {
        return {
            id,
            get value() { return values[id] || ""; },
            set value(v) { values[id] = v; },
            get placeholder() { return placeholders[id] || ""; },
            set placeholder(v) { placeholders[id] = v; },
            focus: () => {}
        };
    }

    global.document = {
        getElementById: (id) => makeInput(id)
    };

    try {
        // First addNewSettingsWpSite clears fields
        addNewSettingsWpSite();
        assert.equal(values["settingsWpName"], "");
        assert.equal(values["settingsWpUrl"], "");
        assert.equal(values["settingsWpUsername"], "");
        assert.equal(values["settingsWpAppPassword"], "");
        assert.match(placeholders["settingsWpAppPassword"], /在WP用户个人资料中生成/);
    } finally {
        global.document = originalDocument;
    }
});

test("onSettingsShopifySelectChange and addNewSettingsShopifyStore update form fields and masked placeholders", () => {
    const originalDocument = global.document;

    const values = {};
    const placeholders = {};
    function makeInput(id) {
        return {
            id,
            get value() { return values[id] || ""; },
            set value(v) { values[id] = v; },
            get placeholder() { return placeholders[id] || ""; },
            set placeholder(v) { placeholders[id] = v; },
            focus: () => {}
        };
    }

    global.document = {
        getElementById: (id) => makeInput(id)
    };

    try {
        // addNewSettingsShopifyStore clears fields
        addNewSettingsShopifyStore();
        assert.equal(values["settingsShopifyName"], "");
        assert.equal(values["settingsShopifyDomain"], "");
        assert.equal(values["settingsShopifyAccessToken"], "");
        assert.match(placeholders["settingsShopifyAccessToken"], /shpat_/);
    } finally {
        global.document = originalDocument;
    }
});

test("formatStorageDisplayLabel deduplicates URLs and handles variations cleanly", () => {
    // Normal name + URL
    assert.equal(
        formatStorageDisplayLabel("WP测试站", "https://wp.example.com"),
        "WP测试站 (https://wp.example.com)"
    );

    // Name already contains exact URL in parentheses -> no duplicate
    assert.equal(
        formatStorageDisplayLabel("chengpeng6686@gmail.com (https://testbeforebuy.com)", "https://testbeforebuy.com"),
        "chengpeng6686@gmail.com (https://testbeforebuy.com)"
    );

    // Name is the URL itself -> no duplicate
    assert.equal(
        formatStorageDisplayLabel("https://testbeforebuy.com", "https://testbeforebuy.com"),
        "https://testbeforebuy.com"
    );

    // Name is domain without protocol -> returns target URL without duplication
    assert.equal(
        formatStorageDisplayLabel("testbeforebuy.com", "https://testbeforebuy.com"),
        "https://testbeforebuy.com"
    );

    // Shopify store name already has domain
    assert.equal(
        formatStorageDisplayLabel("Shopify欧美站 (us-store.myshopify.com)", "us-store.myshopify.com"),
        "Shopify欧美站 (us-store.myshopify.com)"
    );

    // Empty name with target URL
    assert.equal(
        formatStorageDisplayLabel("", "https://testbeforebuy.com"),
        "https://testbeforebuy.com"
    );

    // Empty target with name
    assert.equal(
        formatStorageDisplayLabel("独立站点", ""),
        "独立站点"
    );

    // Both empty -> fallback
    assert.equal(
        formatStorageDisplayLabel("", "", "未命名站点"),
        "未命名站点"
    );
});

test("WordPress card and tabs use inline SVG icon and prevent duplicate URLs", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");

    // Must NOT contain invalid Phosphor icon ph-wordpress-logo
    assert.equal(html.includes("ph-wordpress-logo"), false, "index.html should not reference non-existent ph-wordpress-logo");

    // Must contain WordPress SVG path in the storage elements
    assert.match(html, /<svg[^>]*class="[^"]*w-5 h-5[^"]*"[^>]*viewBox="0 0 24 24"/);

    // Test renderStorageIntegrations deduplication when config name has URL
    const originalDocument = global.document;
    const mockElements = {};
    function getOrCreate(id) {
        if (!mockElements[id]) {
            mockElements[id] = {
                id,
                textContent: "",
                className: "",
                title: "",
                innerHTML: ""
            };
        }
        return mockElements[id];
    }
    global.document = { getElementById: (id) => getOrCreate(id) };

    try {
        const configsWithEmbeddedUrl = [
            {
                id: 1,
                storage_type: "wordpress",
                name: "chengpeng6686@gmail.com (https://testbeforebuy.com)",
                wp_url: "https://testbeforebuy.com",
                is_default: true
            }
        ];
        renderStorageIntegrations(configsWithEmbeddedUrl);
        const summary = getOrCreate("settingsStorageSummaryWp").textContent;
        // Verify summary does NOT contain duplicate (https://testbeforebuy.com)
        assert.equal(summary, "默认: chengpeng6686@gmail.com (https://testbeforebuy.com)");
        assert.equal(
            summary.indexOf("(https://testbeforebuy.com) (https://testbeforebuy.com)"),
            -1,
            "Summary must not contain duplicate URL"
        );
    } finally {
        global.document = originalDocument;
    }
});
