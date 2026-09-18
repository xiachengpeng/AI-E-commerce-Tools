const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const {
    switchSettingsTab,
    filterSettingsProviders
} = require("../js/settings.js");

test("settings index.html contains tab navigation, 3 panes, and storage integration card", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");

    // Check tab navigation bar & buttons
    assert.match(html, /id=\"settingsTabBtnAi\"/);
    assert.match(html, /id=\"settingsTabBtnIntegrations\"/);
    assert.match(html, /id=\"settingsTabBtnLogs\"/);

    // Check 3 tab panes
    assert.match(html, /id=\"settingsPaneAi\"/);
    assert.match(html, /id=\"settingsPaneIntegrations\"/);
    assert.match(html, /id=\"settingsPaneLogs\"/);

    // Check storage integration card
    assert.match(html, /id=\"settingsStorageIntegrationCard\"/);
    assert.match(html, /WordPress REST API/);
    assert.match(html, /Shopify Admin API/);
    assert.match(html, /Cloudflare R2/);

    // Check provider protocol filters
    assert.match(html, /id=\"settingsProviderFilters\"/);
});

test("switchSettingsTab toggles active and hidden classes appropriately", () => {
    const originalDocument = global.document;

    function makeMockElement() {
        const classes = new Set();
        const attrs = {};
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
            setAttribute: (k, v) => { attrs[k] = v; },
            getAttribute: (k) => attrs[k]
        };
    }

    const mockAiBtn = makeMockElement();
    const mockIntBtn = makeMockElement();
    const mockLogsBtn = makeMockElement();
    const mockAiPane = makeMockElement();
    const mockIntPane = makeMockElement();
    const mockLogsPane = makeMockElement();

    global.document = {
        getElementById: (id) => {
            if (id === "settingsTabBtnAi") return mockAiBtn;
            if (id === "settingsTabBtnIntegrations") return mockIntBtn;
            if (id === "settingsTabBtnLogs") return mockLogsBtn;
            if (id === "settingsPaneAi") return mockAiPane;
            if (id === "settingsPaneIntegrations") return mockIntPane;
            if (id === "settingsPaneLogs") return mockLogsPane;
            return null;
        }
    };

    try {
        // Switch to integrations tab
        switchSettingsTab("integrations");
        assert.equal(mockAiBtn.classList.contains("is-active"), false);
        assert.equal(mockIntBtn.classList.contains("is-active"), true);
        assert.equal(mockLogsBtn.classList.contains("is-active"), false);

        assert.equal(mockAiPane.classList.contains("hidden"), true);
        assert.equal(mockIntPane.classList.contains("hidden"), false);
        assert.equal(mockLogsPane.classList.contains("hidden"), true);

        // Switch to logs tab
        switchSettingsTab("logs");
        assert.equal(mockIntBtn.classList.contains("is-active"), false);
        assert.equal(mockLogsBtn.classList.contains("is-active"), true);
        assert.equal(mockLogsPane.classList.contains("hidden"), false);
        assert.equal(mockIntPane.classList.contains("hidden"), true);

        // Switch back to ai tab
        switchSettingsTab("ai");
        assert.equal(mockAiBtn.classList.contains("is-active"), true);
        assert.equal(mockAiPane.classList.contains("hidden"), false);
    } finally {
        global.document = originalDocument;
    }
});
