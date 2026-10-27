const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const {
    switchSettingsTab,
    filterSettingsProviders
} = require("../js/settings.js");

test("settings index.html contains tab navigation, settings panes, and storage integration card", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");

    // Check tab navigation bar & buttons
    assert.match(html, /id=\"settingsTabBtnAi\"/);
    assert.match(html, /id=\"settingsTabBtnIntegrations\"/);
    assert.match(html, /id=\"settingsTabBtnLogs\"/);

    // Check the original panes alongside the dedicated storage pane
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

test('storage is a real settings pane and cannot leave integrations highlighted or visible',()=>{
 const previous=global.document,ids=new Map(),tabs=['Ai','Integrations','Storage','Logs','Appearance'];
 for(const tab of tabs)for(const prefix of ['settingsTabBtn','settingsPane']){const classes=new Set(),attrs={};ids.set(prefix+tab,{classList:{add:c=>classes.add(c),remove:c=>classes.delete(c),toggle:(c,on)=>on?classes.add(c):classes.delete(c),contains:c=>classes.has(c)},setAttribute:(k,v)=>attrs[k]=v,getAttribute:k=>attrs[k]});}
 global.document={getElementById:id=>ids.get(id)||null};
 try{for(const active of ['storage','integrations','appearance','logs','ai','storage']){switchSettingsTab(active);for(const tab of tabs){const expected=tab.toLowerCase()===active;assert.equal(ids.get('settingsTabBtn'+tab).getAttribute('aria-selected'),String(expected),active+' selected '+tab);assert.equal(ids.get('settingsPane'+tab).classList.contains('hidden'),!expected,active+' pane '+tab);}}}finally{global.document=previous;}
});
test('storage card has its own single static tab and is outside external-service pane',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),app=fs.readFileSync(path.join(__dirname,'../js/app.js'),'utf8');
 const integrations=html.indexOf('id="settingsPaneIntegrations"'),storage=html.indexOf('id="settingsPaneStorage"'),card=html.indexOf('id="settingsStorageIntegrationCard"'),logs=html.indexOf('id="settingsPaneLogs"');
 assert.ok(integrations<storage&&storage<card&&card<logs);assert.equal((html.match(/id="settingsTabBtnStorage"/g)||[]).length,1);assert.match(html,/onclick="switchSettingsTab\('storage'\)"/);assert.doesNotMatch(app,/storageLink\.addEventListener/);
});
