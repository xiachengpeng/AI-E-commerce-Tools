const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const frontendRoot = path.resolve(__dirname, "..");
const indexHtml = fs.readFileSync(path.join(frontendRoot, "index.html"), "utf8");
const appScript = fs.readFileSync(path.join(frontendRoot, "js", "app.js"), "utf8");
const scriptPath = path.join(frontendRoot, "js", "watermark_removal.js");
const stylePath = path.join(frontendRoot, "css", "watermark_removal.css");
const script = fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, "utf8") : "";

test("page exposes the AI removal tab and controls", () => {
    assert.match(indexHtml, /id="tab-watermark-removal"/);
    assert.match(indexHtml, /id="view-watermark-removal"/);
    assert.match(indexHtml, /id="watermarkRemovalCanvas"/);
    assert.match(indexHtml, /id="watermarkRemovalSubmit"/);
    assert.match(indexHtml, /id="watermarkRemovalDownload"/);
});

test("page exposes upload, editing, comparison, and error states", () => {
    assert.match(indexHtml, /id="watermarkRemovalFileInput"/);
    assert.match(indexHtml, /id="watermarkRemovalDelete"/);
    assert.match(indexHtml, /id="watermarkRemovalClear"/);
    assert.match(indexHtml, /id="watermarkRemovalError"/);
    assert.match(indexHtml, /id="watermarkRemovalComparison"/);
    assert.match(indexHtml, /id="watermarkRemovalOriginal"/);
    assert.match(indexHtml, /id="watermarkRemovalResult"/);
    assert.equal(fs.existsSync(stylePath), true);
});

test("watermark scripts load in dependency order and initialize with the app", () => {
    const corePosition = indexHtml.indexOf('src="js/watermark_removal_core.js"');
    const uiPosition = indexHtml.indexOf('src="js/watermark_removal.js"');

    assert.notEqual(corePosition, -1);
    assert.notEqual(uiPosition, -1);
    assert.ok(corePosition < uiPosition);
    assert.match(appScript, /initWatermarkRemoval/);
});

test("editor supports creation, movement, eight-way resize, and keyboard deletion", () => {
    assert.match(script, /setPointerCapture/);
    assert.match(script, /mode:\s*"create"/);
    assert.match(script, /mode:\s*"move"/);
    for (const handle of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) {
        assert.match(script, new RegExp(`"${handle}"`));
    }
    assert.match(script, /Delete/);
    assert.match(script, /Backspace/);
    assert.match(script, /normalizeRegion/);
    assert.match(script, /denormalizeRegion/);
});

test("submission renders an original-size mask and saves successful history", () => {
    assert.match(script, /renderMask/);
    assert.match(script, /naturalWidth/);
    assert.match(script, /naturalHeight/);
    assert.match(script, /\/api\/watermark-removal/);
    assert.match(script, /mask_data/);
    assert.match(script, /saveToHistory\("watermark-removal"/);
});

test("download is result-only and uses removed suffix", () => {
    assert.match(script, /result_url/);
    assert.match(script, /-removed/);
    assert.doesNotMatch(script, /downloadWatermarkRemovalSource/);
    assert.doesNotMatch(script, /downloadWatermarkRemovalMask/);
});

test("failure does not clear regions", () => {
    assert.match(script, /catch[\s\S]*setWatermarkRemovalBusy\(false\)/);
    assert.doesNotMatch(script, /catch[\s\S]{0,300}regions\s*=\s*\[\]/);
});
