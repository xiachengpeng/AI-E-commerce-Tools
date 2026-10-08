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
    assert.match(indexHtml, /js\/settings\.js\?v=(?:20260920-(?:balance-v3|ccswitch-v1|ccswitch-v2|ccswitch-v3|ccswitch-v4|ccswitch-v5|ccswitch-v6|logs-v1)|20260921-(?:models-v[123]|secret-v1|vertex-v1))/);
});


test("index.html contains expanded log source filter options including usage_query, balance, storage", () => {
    assert.match(indexHtml, /<option value="usage_query">用量查询<\/option>/);
    assert.match(indexHtml, /<option value="balance">中转余额<\/option>/);
    assert.match(indexHtml, /<option value="storage">对象存储<\/option>/);
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

test("queryProviderBalance checks usage-query endpoint and records balance", () => {
    const jsPath = path.join(frontendRoot, "js", "settings.js");
    const code = fs.readFileSync(jsPath, "utf8");
    assert.match(code, /usage-query/);
    assert.match(code, /balance\/record/);
});

test("settings.js explicitly exposes queryProviderBalance on window", () => {
    const jsPath = path.join(frontendRoot, "js", "settings.js");
    const code = fs.readFileSync(jsPath, "utf8");
    assert.match(code, /window\.queryProviderBalance\s*=\s*queryProviderBalance;/);
});

test("queryProviderBalance displays immediate loading state and handles proxy failure", () => {
    const jsPath = path.join(frontendRoot, "js", "settings.js");
    const code = fs.readFileSync(jsPath, "utf8");
    assert.match(code, /settings-balance-loading/);
    assert.match(code, /proxyResp\.ok/);
});

test("providerBalanceMarkup suppresses unlimited quotas and renders is-error badge for 查询失败", () => {
    const { providerBalanceMarkup } = require("../js/settings.js");
    assert.equal(typeof providerBalanceMarkup, "function");

    // 1. Unlimited quota must be suppressed (must not display "无限额度", renders empty query state)
    const unlimitedProvider = {
        id: 1,
        protocol: "openai_compatible",
        last_balance_text: "无限额度",
        last_balance_at: "2026-09-20T12:00:00Z",
    };
    const unlimitedMarkup = providerBalanceMarkup(unlimitedProvider);
    assert.doesNotMatch(unlimitedMarkup, /无限/);
    assert.doesNotMatch(unlimitedMarkup, /不限/);
    assert.match(unlimitedMarkup, /is-empty/);
    assert.match(unlimitedMarkup, /查中转站余额/);



    // 2. Failed query must render is-error badge
    const failedProvider = {
        id: 2,
        protocol: "openai_compatible",
        last_balance_text: "查询失败",
        last_balance_at: "2026-09-20T12:00:00Z",
    };
    const failedMarkup = providerBalanceMarkup(failedProvider);
    assert.match(failedMarkup, /settings-balance-badge/);
    assert.match(failedMarkup, /is-error/);
    assert.match(failedMarkup, /查询失败/);
    assert.match(failedMarkup, /查询失败，详情看日志/);
});

test("queryProviderBalance defaults to general query and uses markBalanceQueryFailed on failure", () => {
    const jsPath = path.join(frontendRoot, "js", "settings.js");
    const code = fs.readFileSync(jsPath, "utf8");
    assert.match(code, /engine\.USAGE_QUERY_TEMPLATES\.general\.script/);
    assert.match(code, /markBalanceQueryFailed\(/);
});
