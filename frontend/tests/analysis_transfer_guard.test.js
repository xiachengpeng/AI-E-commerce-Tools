const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");

const analysisSource = fs.readFileSync(path.join(__dirname, "../js/analysis.js"), "utf8");

function createAnalysisContext(domElements = {}, overrides = {}) {
    const elements = { ...domElements };
    const context = {
        console,
        setTimeout,
        clearTimeout,
        confirm: overrides.confirm || (() => true),
        alert: overrides.alert || (() => {}),
        window: {},
        document: {
            getElementById: (id) => elements[id] || null,
            querySelector: (sel) => elements[sel] || null,
            querySelectorAll: () => [],
            createElement: (tag) => ({
                tag,
                value: "",
                style: {},
                classList: { add() {}, remove() {} },
                appendChild() {},
                focus() {},
                select() {}
            }),
            body: {
                appendChild() {},
                removeChild() {}
            }
        },
        localStorage: {
            getItem: () => null,
            setItem: () => {},
            removeItem: () => {}
        },
        switchMainTab: (tab) => {
            context.__switchedTab = tab;
        },
        showToast: (msg, type) => {
            context.__lastToast = { msg, type };
        }
    };
    vm.createContext(context);
    vm.runInContext(analysisSource, context);
    return context;
}

test("xp_transferToDetails preserves existing draft when user cancels overwrite", () => {
    let confirmPrompt = null;
    const nameEl = { value: "My Existing Draft Chair" };
    const pointsEl = { value: "Existing selling point line 1" };

    const ctx = createAnalysisContext(
        {
            productNameInput: nameEl,
            sellingPointsText: pointsEl
        },
        {
            // User clicks "Cancel" on confirmation
            confirm: (msg) => {
                confirmPrompt = msg;
                return false;
            }
        }
    );

    const mockData = {
        product_name: "New Competitor Ergonomic Chair",
        core_selling_points: ["New point from analysis"]
    };

    // Trigger transfer
    ctx.window.xp_transferToDetails(mockData);

    // Verify confirmation was requested
    assert.ok(confirmPrompt !== null, "Confirmation dialog should be prompted");
    assert.match(confirmPrompt, /已存在正在编辑的草稿内容/);

    // Verify existing contents were NOT overwritten
    assert.equal(nameEl.value, "My Existing Draft Chair");
    assert.equal(pointsEl.value, "Existing selling point line 1");
    assert.equal(ctx.__switchedTab, undefined, "Should not switch tabs when cancelled");
});

test("xp_transferToListing preserves existing draft when user cancels overwrite", () => {
    let confirmPrompt = null;
    const nameEl = { value: "Existing Listing Title" };
    const pointsEl = { value: "Existing Listing Bullet 1" };

    const ctx = createAnalysisContext(
        {
            listingName: nameEl,
            listingPoints: pointsEl
        },
        {
            confirm: (msg) => {
                confirmPrompt = msg;
                return false;
            }
        }
    );

    const mockData = {
        product_name: "New Listing Product",
        core_selling_points: ["New point"]
    };

    ctx.window.xp_transferToListing(mockData);

    assert.ok(confirmPrompt !== null);
    assert.match(confirmPrompt, /已存在正在编辑的草稿内容/);
    assert.equal(nameEl.value, "Existing Listing Title");
    assert.equal(pointsEl.value, "Existing Listing Bullet 1");
});

test("xp_transferToAds preserves existing draft when user cancels overwrite", () => {
    let confirmPrompt = null;
    const nameEl = { value: "Existing Ad Headline" };

    const ctx = createAnalysisContext(
        {
            adsProductNameInput: nameEl
        },
        {
            confirm: (msg) => {
                confirmPrompt = msg;
                return false;
            }
        }
    );

    const mockData = {
        product_name: "New Ad Product"
    };

    ctx.window.xp_transferToAds(mockData);

    assert.ok(confirmPrompt !== null);
    assert.match(confirmPrompt, /已存在正在编辑的草稿内容/);
    assert.equal(nameEl.value, "Existing Ad Headline");
});
