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
