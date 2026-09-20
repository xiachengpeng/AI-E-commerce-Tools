const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const indexHtml = fs.readFileSync(path.resolve(__dirname, "../index.html"), "utf8");
const settingsCss = fs.readFileSync(path.resolve(__dirname, "../css/settings.css"), "utf8");

test("index.html contains CC Switch usage query modal and elements", () => {
    assert.match(indexHtml, /id="settingsUsageQueryModal"/, "modal container should exist");
    assert.match(indexHtml, /id="settingsUsageProviderTitle"/, "provider title container should exist");
    assert.match(indexHtml, /id="settingsUsageTemplateCustom"/, "custom template tab");
    assert.match(indexHtml, /id="settingsUsageTemplateGeneral"/, "general template tab");
    assert.match(indexHtml, /id="settingsUsageTemplateNewApi"/, "newapi template tab");
    assert.match(indexHtml, /id="settingsUsageTemplateTokenPlan"/, "token_plan template tab");
    assert.match(indexHtml, /id="settingsUsageTemplateOfficial"/, "official template tab");
    assert.match(indexHtml, /id="settingsUsageApiKey"/, "apiKey input");
    assert.match(indexHtml, /id="settingsUsageBaseUrl"/, "baseUrl input");
    assert.match(indexHtml, /id="settingsUsageTimeout"/, "timeout input");
    assert.match(indexHtml, /id="settingsUsageAutoInterval"/, "auto interval input");
    assert.match(indexHtml, /id="settingsUsageScriptEditor"/, "script editor textarea");
    assert.match(indexHtml, /id="settingsUsageResultArea"/, "result preview area");
    assert.match(indexHtml, /id="settingsUsageTestBtn"/, "test script button");
    assert.match(indexHtml, /id="settingsUsageFormatBtn"/, "format script button");
    assert.match(indexHtml, /id="settingsUsageSaveBtn"/, "save config button");
});

test("settings.css contains CC Switch usage query dark-theme and layout classes", () => {
    assert.match(settingsCss, /\.settings-usage-modal/, "modal styling");
    assert.match(settingsCss, /\.settings-usage-pills/, "segmented pills styling");
    assert.match(settingsCss, /\.settings-usage-editor/, "editor styling");
    assert.match(settingsCss, /\.settings-usage-result/, "result box styling");
});
