const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const {
    cleanSearchText,
    replaceFirstStringValue,
    applySuggestionByField,
} = require("../js/listing.js");

test("cleanSearchText removes quotes and trims whitespace", () => {
    assert.equal(cleanSearchText(' "cure all" '), "cure all");
    assert.equal(cleanSearchText(" '100% guaranteed' "), "100% guaranteed");
    assert.equal(cleanSearchText("“miracle treatment”"), "miracle treatment");
    assert.equal(cleanSearchText("`best ever`"), "best ever");
    assert.equal(cleanSearchText(null), "");
    assert.equal(cleanSearchText(undefined), "");
});

test("replaceFirstStringValue replaces exact and quoted search targets", () => {
    const listing = {
        title: { target: "World's Best Wireless Earbuds with 100% Guarantee", zh: "标题" },
        bullets: [
            { target: "Provides instant pain relief and cures fatigue", zh: "卖点1" },
            { target: "Long battery life up to 40 hours", zh: "卖点2" }
        ]
    };

    // Replace with quotes in search string
    const r1 = replaceFirstStringValue(listing, '"World\'s Best"', "Premium");
    assert.equal(r1.replaced, true);
    assert.equal(r1.value.title.target, "Premium Wireless Earbuds with 100% Guarantee");

    // Replace inside array of bullets
    const r2 = replaceFirstStringValue(r1.value, "cures fatigue", "relieves fatigue");
    assert.equal(r2.replaced, true);
    assert.equal(r2.value.bullets[0].target, "Provides instant pain relief and relieves fatigue");
});

test("replaceFirstStringValue matches normalized whitespace and case-insensitively", () => {
    const listing = {
        description: { target: "This product is   FDA   Approved for daily use.", zh: "描述" }
    };
    const r = replaceFirstStringValue(listing, "fda approved", "Tested according to safety standards");
    assert.equal(r.replaced, true);
    assert.match(r.value.description.target, /Tested according to safety standards/);
});

test("applySuggestionByField replaces title, description, and socialMedia", () => {
    const data = {
        title: { target: "Bad Title", zh: "标题" },
        description: { target: "Bad Description", zh: "描述" },
        socialMedia: { target: "Bad Social", zh: "社媒" }
    };

    const rTitle = applySuggestionByField(data, "title", "Good Title");
    assert.equal(rTitle.replaced, true);
    assert.equal(rTitle.value.title.target, "Good Title");
    assert.equal(rTitle.value.title.zh, "标题");

    const rDesc = applySuggestionByField(data, "description", "Good Description");
    assert.equal(rDesc.replaced, true);
    assert.equal(rDesc.value.description.target, "Good Description");

    const rSocial = applySuggestionByField(data, "socialMedia", "Good Social");
    assert.equal(rSocial.replaced, true);
    assert.equal(rSocial.value.socialMedia.target, "Good Social");
});

test("applySuggestionByField replaces specific bullet by current text or keyword match", () => {
    const data = {
        bullets: [
            { target: "Lightweight and portable design for travel", zh: "轻便" },
            { target: "100% Guaranteed best sound on the market", zh: "保真" },
            { target: "Water resistant IPX7 rating", zh: "防水" }
        ]
    };

    const res = applySuggestionByField(
        data,
        "bullets",
        "High-fidelity immersive sound quality",
        '"100% Guaranteed best sound"'
    );
    assert.equal(res.replaced, true);
    assert.equal(res.value.bullets[1].target, "High-fidelity immersive sound quality");
    assert.equal(res.value.bullets[0].target, "Lightweight and portable design for travel");
    assert.equal(res.value.bullets[2].target, "Water resistant IPX7 rating");
});

test("applySuggestionByField replaces keywords in categories", () => {
    const data = {
        keywords: {
            core: [{ target: "best earbuds", zh: "耳机" }],
            longTail: [{ target: "#1 wireless earbuds", zh: "顶级耳机" }],
            ads: [{ target: "cheap earbuds", zh: "平价耳机" }]
        }
    };

    const res = applySuggestionByField(
        data,
        "keywords",
        "top wireless earbuds",
        "#1 wireless earbuds"
    );
    assert.equal(res.replaced, true);
    assert.equal(res.value.keywords.longTail[0].target, "top wireless earbuds");
});

test("applySuggestionByField replaces QA question or answer", () => {
    const data = {
        qa: [
            {
                q: { target: "Is this guaranteed to cure insomnia?", zh: "问题" },
                a: { target: "Yes, it 100% cures insomnia overnight.", zh: "回答" }
            }
        ]
    };

    const resA = applySuggestionByField(
        data,
        "qa",
        "It helps create a relaxing sleep environment.",
        "100% cures insomnia"
    );
    assert.equal(resA.replaced, true);
    assert.equal(resA.value.qa[0].a.target, "It helps create a relaxing sleep environment.");
});

test("applyComplianceSuggestion updates UI state, replaces text and marks button applied", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const vm = require("node:vm");

    const elements = {};
    const toasts = [];
    let renderedData = null;

    const makeMockElement = (id = "") => ({
        id,
        className: "",
        innerHTML: "",
        textContent: "",
        disabled: false,
        classList: {
            add: () => {},
            remove: () => {},
            contains: () => false,
            toggle: () => {}
        },
        appendChild: () => {},
        append: () => {},
        addEventListener: () => {}
    });

    const mockDocument = {
        createElement: tag => makeMockElement(),
        getElementById: id => {
            if (!elements[id]) {
                elements[id] = makeMockElement(id);
            }
            return elements[id];
        }
    };

    const context = {
        console,
        document: mockDocument,
        showToast: (msg, type) => toasts.push({ msg, type }),
        renderListingData: data => { renderedData = data; }
    };
    vm.createContext(context);
    const listingSource = fs.readFileSync(path.join(__dirname, "../js/listing.js"), "utf8");
    vm.runInContext(listingSource, context);

    // Setup state
    context.setCurrentListingData({
        title: { target: "Best in the world earbuds", zh: "标题" },
        bullets: [{ target: "100% cure all diseases", zh: "卖点" }]
    });
    const suggestions = [
        {
            field: "title",
            current_text: "Best in the world",
            suggested_text: "Premium Quality",
            reason: "夸大宣传"
        },
        {
            field: "bullets",
            current_text: "cure all diseases",
            suggested_text: "enhances daily relaxation",
            reason: "医疗用词"
        }
    ];

    context.renderComplianceReport({
        overall_level: "medium",
        summary: "存在违禁词",
        risks: [],
        rewrite_suggestions: suggestions
    });

    // Apply single suggestion
    context.applyComplianceSuggestion(0);

    const afterSingleSuggestions = context.getCurrentComplianceSuggestions();
    const afterSingleData = context.getCurrentListingData();

    assert.equal(afterSingleSuggestions[0].applied, true);
    assert.equal(afterSingleData.title.target, "Premium Quality earbuds");
    assert.equal(elements["compliance-apply-btn-0"].disabled, true);
    assert.match(elements["compliance-apply-btn-0"].innerHTML, /已应用/);
    assert.ok(toasts.some(t => t.msg === "已应用合规建议" && t.type === "success"));

    // Apply all remaining suggestions
    context.applyAllComplianceSuggestions();

    const afterAllSuggestions = context.getCurrentComplianceSuggestions();
    const afterAllData = context.getCurrentListingData();

    assert.equal(afterAllSuggestions[1].applied, true);
    assert.equal(afterAllData.bullets[0].target, "100% enhances daily relaxation");
    assert.equal(elements["compliance-apply-btn-1"].disabled, true);
    assert.equal(elements["btnApplyAllCompliance"].disabled, true);
    assert.match(elements["btnApplyAllCompliance"].innerHTML, /全部建议已应用/);
    assert.ok(toasts.some(t => t.msg.includes("已成功采纳") && t.type === "success"));
});

test("app.js and listing.js load sequentially in the same context without collision", () => {
    const context = {
        console,
        window: {},
        document: {
            querySelectorAll: () => [],
            getElementById: () => null,
            createElement: () => ({ appendChild: () => {} })
        },
        localStorage: {
            getItem: () => null,
            setItem: () => {}
        },
        MODULES_CONFIG: [],
        API_BASE: "http://localhost:9503"
    };
    vm.createContext(context);
    const appSource = fs.readFileSync(path.join(__dirname, "../js/app.js"), "utf8");
    const listingSource = fs.readFileSync(path.join(__dirname, "../js/listing.js"), "utf8");

    assert.doesNotThrow(() => {
        vm.runInContext(appSource, context);
        vm.runInContext(listingSource, context);
    });
});
