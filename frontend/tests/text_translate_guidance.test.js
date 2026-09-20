const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const frontendRoot = path.resolve(__dirname, "..");
const indexHtml = fs.readFileSync(path.join(frontendRoot, "index.html"), "utf8");
const textTranslateJs = fs.readFileSync(path.join(frontendRoot, "js", "text_translate.js"), "utf8");

test("index.html text translation section eliminates English labels and adds region presets", () => {
    // 1. Check eliminated English labels
    assert.doesNotMatch(indexHtml, /Localized Contextual Translation/);
    assert.doesNotMatch(indexHtml, /<span class="text-\[10px\] font-black text-gray-400 uppercase tracking-widest">Source Text<\/span>/);
    assert.doesNotMatch(indexHtml, /<span class="text-\[10px\] font-black text-gray-400 uppercase text-center tracking-widest">Target Language<\/span>/);
    assert.doesNotMatch(indexHtml, />Select Multiple</);
    assert.doesNotMatch(indexHtml, />AI Result List</);
    assert.doesNotMatch(indexHtml, /Batch Localized Mode Active/);

    // 2. Check localized Chinese labels
    assert.match(indexHtml, /多语言本地化语境翻译/);
    assert.match(indexHtml, /待翻译原文/);
    assert.match(indexHtml, /目标国家与语言/);
    assert.match(indexHtml, /多语言本土化翻译结果/);
    assert.match(indexHtml, /单次请求多语言智能本地化已就绪/);

    // 3. Check quick preset buttons
    assert.match(indexHtml, /applyTextLangPreset\('western5'\)/);
    assert.match(indexHtml, /applyTextLangPreset\('sea_latam'\)/);
    assert.match(indexHtml, /applyTextLangPreset\('east_asia'\)/);
});

test("applyTextLangPreset updates checkboxes and selected text", () => {
    const checkboxes = [
        { value: "English", checked: false },
        { value: "German", checked: false },
        { value: "French", checked: false },
        { value: "Spanish", checked: false },
        { value: "Italian", checked: false },
        { value: "Japanese", checked: false },
        { value: "Korean", checked: false }
    ];

    const selectedText = { innerText: "" };
    const optionsList = { classList: { add() {}, remove() {} } };

    const sandbox = {
        console,
        document: {
            addEventListener() {},
            querySelectorAll: (selector) => {
                if (selector.includes(".lang-checkbox:checked")) {
                    return checkboxes.filter(c => c.checked).map(c => ({
                        value: c.value,
                        parentElement: { querySelector: () => ({ innerText: c.value }) }
                    }));
                }
                if (selector.includes(".lang-checkbox")) {
                    return checkboxes;
                }
                return [];
            },
            getElementById: (id) => {
                if (id === "selectedLangText") return selectedText;
                if (id === "langOptionsList") return optionsList;
                return null;
            }
        },
        window: {},
        globalThis: {}
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;

    const script = new vm.Script(textTranslateJs);
    const context = vm.createContext(sandbox);
    script.runInContext(context);

    assert.equal(typeof context.applyTextLangPreset, "function");

    // Apply western 5
    context.applyTextLangPreset("western5");
    assert.equal(checkboxes.find(c => c.value === "English").checked, true);
    assert.equal(checkboxes.find(c => c.value === "German").checked, true);
    assert.equal(checkboxes.find(c => c.value === "Japanese").checked, false);
    assert.equal(selectedText.innerText, "已选 5 种语言");

    // Apply east asia
    context.applyTextLangPreset("east_asia");
    assert.equal(checkboxes.find(c => c.value === "English").checked, false);
    assert.equal(checkboxes.find(c => c.value === "Japanese").checked, true);
    assert.equal(checkboxes.find(c => c.value === "Korean").checked, true);
    assert.equal(selectedText.innerText, "已选 2 种语言");
});

test("sendTranslatedTextToListing and sendTranslatedTextToAds transfer translated content", () => {
    let capturedListingText = "";
    let capturedAdsText = "";
    let currentTab = "";

    const contentElement = { innerText: "Ergonomic office chair with breathable mesh" };
    const listingInput = { value: "" };
    const adsInput = { value: "" };

    const sandbox = {
        console,
        document: {
            addEventListener() {},
            getElementById: (id) => {
                if (id === "card-en-content") return contentElement;
                if (id === "listingRawInput") return listingInput;
                if (id === "adsProductDesc") return adsInput;
                return null;
            }
        },
        switchMainTab: (tab) => { currentTab = tab; },
        showToast: () => {},
        window: {},
        globalThis: {}
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;

    const script = new vm.Script(textTranslateJs);
    const context = vm.createContext(sandbox);
    script.runInContext(context);

    assert.equal(typeof context.sendTranslatedTextToListing, "function");
    assert.equal(typeof context.sendTranslatedTextToAds, "function");

    context.sendTranslatedTextToListing("card-en-content");
    assert.equal(listingInput.value, "Ergonomic office chair with breathable mesh");
    assert.equal(currentTab, "listing");

    context.sendTranslatedTextToAds("card-en-content");
    assert.equal(adsInput.value, "Ergonomic office chair with breathable mesh");
    assert.equal(currentTab, "ads");
});
