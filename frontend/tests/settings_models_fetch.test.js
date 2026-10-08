const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const frontendRoot = path.resolve(__dirname, "..");
const indexHtml = fs.readFileSync(path.join(frontendRoot, "index.html"), "utf8");

test("index.html contains fetch models button and model select dropdowns, and eliminates quick pills", () => {
    // 1. Fetch models button exists
    assert.match(indexHtml, /id="settingsFetchModelsBtn"/);
    assert.match(indexHtml, /fetchProviderModels/);

    // 2. Model select dropdowns exist
    assert.match(indexHtml, /id="settingsTextModelSelect"/);
    assert.match(indexHtml, /id="settingsImageModelSelect"/);

    // 3. Static quick pills container is removed or replaced
    assert.doesNotMatch(indexHtml, /id="settingsTextModelQuickPills"/);
    assert.doesNotMatch(indexHtml, /id="settingsImageModelQuickPills"/);
});

test("settings.js exports fetchProviderModels function and populates dropdowns", () => {
    const jsPath = path.join(frontendRoot, "js", "settings.js");
    const code = fs.readFileSync(jsPath, "utf8");
    assert.match(code, /function fetchProviderModels/);
    assert.match(code, /populateModelSelectDropdown/);
    assert.match(code, /settingsTextModelSelect/);
    assert.match(code, /settingsImageModelSelect/);
    // Ensure no undefined providerModalState variable
    assert.doesNotMatch(code, /providerModalState/);
    assert.match(code, /settingsState\.editingProviderId/);

    // Ensure fetchProviderModels targets backend API_BASE (port 9503) instead of relative static origin
    assert.doesNotMatch(code, /fetch\(\s*["']\/api\/settings\/ai\/providers\/models\/fetch["']/);
    assert.match(code, /settingsRequest\(`\$\{apiBase\}\/api\/settings\/ai\/providers\/models\/fetch`|settingsRequest\(`\$\{API_BASE\}\/api\/settings\/ai\/providers\/models\/fetch`/);

    // Ensure no naked escapeHtml call that throws ReferenceError
    assert.doesNotMatch(code, /escapeHtml\(/);
});

test("populateModelSelectDropdown safely escapes model names and updates dropdown options", () => {
    const { populateModelSelectDropdown } = require("../js/settings.js");
    const mockSelect = {
        classList: { add() {}, remove() {} },
        innerHTML: "",
    };
    populateModelSelectDropdown(mockSelect, ["model-1", "model<script>alert(1)</script>", "dall-e-3"], "-- 选择模型 --");
    assert.match(mockSelect.innerHTML, /model-1/);
    assert.match(mockSelect.innerHTML, /&lt;script&gt;/);
    assert.doesNotMatch(mockSelect.innerHTML, /<script>/);
});
