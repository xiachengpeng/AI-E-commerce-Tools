const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const frontendRoot = path.resolve(__dirname, "..");
const indexHtml = fs.readFileSync(path.join(frontendRoot, "index.html"), "utf8");

test("index.html provider editor contains New-API and balance query fields", () => {
    // 1. Balance Access Token field for New-API
    assert.match(indexHtml, /id="settingsProviderBalanceAccessToken"/);
    assert.match(indexHtml, /查询访问令牌/);
    assert.match(indexHtml, /New-API/);

    // 2. Balance User ID field
    assert.match(indexHtml, /id="settingsProviderBalanceUserId"/);
    assert.match(indexHtml, /用户 ID/);

    // 3. Custom Balance URL field
    assert.match(indexHtml, /id="settingsProviderCustomBalanceUrl"/);
    assert.match(indexHtml, /自定义余额查询接口/);
});

test("settings.js renders balance badge and query button for openai_compatible providers", () => {
    // Load settings.js in a mock DOM environment
    const jsPath = path.join(frontendRoot, "js", "settings.js");
    const code = fs.readFileSync(jsPath, "utf8");

    // Check code contains queryProviderBalance function
    assert.match(code, /function queryProviderBalance\(/);
    assert.match(code, /\/api\/settings\/ai\/providers\/\$\{providerId\}\/balance/);

    // Check code contains balance badge rendering markup
    assert.match(code, /settings-balance-badge/);
    assert.match(code, /queryProviderBalance/);
});

test("settings.js exports providerBalanceActionMarkup and renders wallet button for openai_compatible", () => {
    const { providerBalanceActionMarkup } = require("../js/settings.js");
    assert.equal(typeof providerBalanceActionMarkup, "function");

    const openaiProvider = { id: 9, protocol: "openai_compatible", name: "My Relay" };
    const vertexProvider = { id: 1, protocol: "vertex", name: "Google Vertex" };

    const markup = providerBalanceActionMarkup(openaiProvider);
    assert.match(markup, /settings-provider-balance-action/);
    assert.match(markup, /queryProviderBalance\(9/);
    assert.match(markup, /ph-wallet/);

    assert.equal(providerBalanceActionMarkup(vertexProvider), "");
});

test("index.html contains overview KPI balance elements and cache-busting version", () => {
    assert.match(indexHtml, /id="settingsKpiTextBalance"/);
    assert.match(indexHtml, /id="settingsKpiImageBalance"/);
    assert.match(indexHtml, /js\/settings\.js\?v=20260920-(?:balance-v3|ccswitch-v1|ccswitch-v2|ccswitch-v3|ccswitch-v4)/);
});

test("index.html contains balance test connection button and message container", () => {
    assert.match(indexHtml, /id="settingsTestBalanceBtn"/);
    assert.match(indexHtml, /id="settingsBalanceTestMsg"/);
    assert.match(indexHtml, /测试余额连接/);
});

test("settings.js exports testBalanceQueryConnection function", () => {
    const { testBalanceQueryConnection } = require("../js/settings.js");
    assert.equal(typeof testBalanceQueryConnection, "function");
});
