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
    assert.match(indexHtml, /id="settingsUsageCredentialLabel"/, "credential dynamic label");
    assert.match(indexHtml, /id="settingsUsageUserId"/, "userId input for newapi");
    assert.match(indexHtml, /id="settingsUsageUserIdGroup"/, "userId container group");
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

test("settings.js exports providerUsageActionMarkup and returns button for openai_compatible", () => {
    const settings = require("../js/settings.js");
    assert.equal(typeof settings.providerUsageActionMarkup, "function");

    const openaiProvider = { id: 10, protocol: "openai_compatible", name: "Relay Hub" };
    const markup = settings.providerUsageActionMarkup(openaiProvider);
    assert.match(markup, /openUsageQueryModal\(10\)/);
    assert.match(markup, /ph-sliders-horizontal|ph-chart-bar|ph-gear-six/);

    const geminiProvider = { id: 11, protocol: "gemini", name: "Gemini Official" };
    assert.equal(settings.providerUsageActionMarkup(geminiProvider), "");
});

test("settings.js exports usage query modal controller functions", () => {
    const settings = require("../js/settings.js");
    assert.equal(typeof settings.openUsageQueryModal, "function");
    assert.equal(typeof settings.closeUsageQueryModal, "function");
    assert.equal(typeof settings.selectUsageTemplate, "function");
    assert.equal(typeof settings.testUsageQueryScript, "function");
    assert.equal(typeof settings.formatUsageQueryScript, "function");
    assert.equal(typeof settings.saveUsageQueryConfig, "function");
});

test("selectUsageTemplate loads template script into editor and updates active pill", () => {
    const settings = require("../js/settings.js");
    const mockElements = {
        settingsUsageTemplateCustom: { classes: new Set(), classList: { add(c) { mockElements.settingsUsageTemplateCustom.classes.add(c); }, remove(c) { mockElements.settingsUsageTemplateCustom.classes.delete(c); } } },
        settingsUsageTemplateGeneral: { classes: new Set(["active"]), classList: { add(c) { mockElements.settingsUsageTemplateGeneral.classes.add(c); }, remove(c) { mockElements.settingsUsageTemplateGeneral.classes.delete(c); } } },
        settingsUsageTemplateNewApi: { classes: new Set(), classList: { add(c) { mockElements.settingsUsageTemplateNewApi.classes.add(c); }, remove(c) { mockElements.settingsUsageTemplateNewApi.classes.delete(c); } } },
        settingsUsageTemplateTokenPlan: { classes: new Set(), classList: { add(c) { mockElements.settingsUsageTemplateTokenPlan.classes.add(c); }, remove(c) { mockElements.settingsUsageTemplateTokenPlan.classes.delete(c); } } },
        settingsUsageTemplateOfficial: { classes: new Set(), classList: { add(c) { mockElements.settingsUsageTemplateOfficial.classes.add(c); }, remove(c) { mockElements.settingsUsageTemplateOfficial.classes.delete(c); } } },
        settingsUsageScriptEditor: { value: "" }
    };

    global.document = {
        getElementById: (id) => mockElements[id] || null
    };

    settings.selectUsageTemplate("newapi");
    assert.equal(mockElements.settingsUsageTemplateNewApi.classes.has("active"), true);
    assert.equal(mockElements.settingsUsageTemplateGeneral.classes.has("active"), false);
    assert.match(mockElements.settingsUsageScriptEditor.value, /api\/user\/self/);
    assert.match(mockElements.settingsUsageScriptEditor.value, /500000/);

    settings.selectUsageTemplate("token_plan");
    assert.equal(mockElements.settingsUsageTemplateTokenPlan.classes.has("active"), true);
    assert.equal(mockElements.settingsUsageTemplateNewApi.classes.has("active"), false);
    assert.match(mockElements.settingsUsageScriptEditor.value, /dashboard\/billing\/subscription/);
});

test("formatUsageQueryScript formats raw JS in editor", () => {
    const settings = require("../js/settings.js");
    const mockElements = {
        settingsUsageScriptEditor: {
            value: "({request:{url:'/v1',method:'GET'},extractor:function(r){return {remaining:10}}})"
        }
    };
    global.document = {
        getElementById: (id) => mockElements[id] || null
    };

    settings.formatUsageQueryScript();
    assert.match(mockElements.settingsUsageScriptEditor.value, /request:\s*\{/);
    assert.match(mockElements.settingsUsageScriptEditor.value, /extractor:\s*function/);
});

test("selectUsageTemplate dynamically updates credential label to Access Token and shows userId input for newapi", () => {
    const settings = require("../js/settings.js");
    const mockElements = {
        settingsUsageTemplateGeneral: { classes: new Set(["active"]), classList: { add(c) { mockElements.settingsUsageTemplateGeneral.classes.add(c); }, remove(c) { mockElements.settingsUsageTemplateGeneral.classes.delete(c); } } },
        settingsUsageTemplateNewApi: { classes: new Set(), classList: { add(c) { mockElements.settingsUsageTemplateNewApi.classes.add(c); }, remove(c) { mockElements.settingsUsageTemplateNewApi.classes.delete(c); } } },
        settingsUsageCredentialLabel: { textContent: "API Key (可选覆盖)" },
        settingsUsageApiKey: { placeholder: "留空则使用供应商的 API Key", value: "" },
        settingsUsageUserIdGroup: { classes: new Set(["hidden"]), classList: { add(c) { mockElements.settingsUsageUserIdGroup.classes.add(c); }, remove(c) { mockElements.settingsUsageUserIdGroup.classes.delete(c); } } },
        settingsUsageScriptEditor: { value: "" }
    };
    global.document = {
        getElementById: (id) => mockElements[id] || null
    };

    // Switch to newapi
    settings.selectUsageTemplate("newapi");
    assert.equal(mockElements.settingsUsageCredentialLabel.textContent, "Access Token (可选覆盖)");
    assert.match(mockElements.settingsUsageApiKey.placeholder, /Access Token/);
    assert.equal(mockElements.settingsUsageUserIdGroup.classes.has("hidden"), false, "userId group should be visible for newapi");

    // Switch back to general
    settings.selectUsageTemplate("general");
    assert.equal(mockElements.settingsUsageCredentialLabel.textContent, "API Key (可选覆盖)");
    assert.match(mockElements.settingsUsageApiKey.placeholder, /API Key/);
    assert.equal(mockElements.settingsUsageUserIdGroup.classes.has("hidden"), true, "userId group should be hidden for general");
});

test("updateUsageCredentialUI handles custom, token_plan and official templates gracefully", () => {
    const settings = require("../js/settings.js");
    const mockElements = {
        settingsUsageCredentialLabel: { textContent: "" },
        settingsUsageApiKey: { placeholder: "" },
        settingsUsageUserIdGroup: { classes: new Set(["hidden"]), classList: { add(c) { mockElements.settingsUsageUserIdGroup.classes.add(c); }, remove(c) { mockElements.settingsUsageUserIdGroup.classes.delete(c); } } }
    };
    global.document = {
        getElementById: (id) => mockElements[id] || null
    };

    ["custom", "token_plan", "official", "general"].forEach(tpl => {
        settings.updateUsageCredentialUI(tpl);
        assert.equal(mockElements.settingsUsageCredentialLabel.textContent, "API Key (可选覆盖)");
        assert.match(mockElements.settingsUsageApiKey.placeholder, /API Key/);
        assert.equal(mockElements.settingsUsageUserIdGroup.classes.has("hidden"), true);
    });

    settings.updateUsageCredentialUI("newapi");
    assert.equal(mockElements.settingsUsageCredentialLabel.textContent, "Access Token (可选覆盖)");
    assert.match(mockElements.settingsUsageApiKey.placeholder, /Access Token/);
    assert.equal(mockElements.settingsUsageUserIdGroup.classes.has("hidden"), false);
});
