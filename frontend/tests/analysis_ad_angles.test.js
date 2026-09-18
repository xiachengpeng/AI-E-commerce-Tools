const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");

const analysisSource = fs.readFileSync(path.join(__dirname, "../js/analysis.js"), "utf8");

function createAnalysisContext() {
    const context = {
        console,
        window: {},
        document: {
            getElementById: () => null,
            querySelectorAll: () => [],
            createElement: () => ({ appendChild: () => {}, classList: { add: () => {}, remove: () => {} } })
        },
        localStorage: {
            getItem: () => null,
            setItem: () => {}
        },
        API_BASE: "http://localhost:9503"
    };
    vm.createContext(context);
    vm.runInContext(analysisSource, context);
    return context;
}

test("xp_extractAdAngleText handles plain strings", () => {
    const ctx = createAnalysisContext();
    const extract = ctx.window.xp_extractAdAngleText;
    assert.equal(
        extract("创意角度1 ||| Creative Angle 1"),
        "创意角度1 ||| Creative Angle 1"
    );
});

test("xp_extractAdAngleText handles object with angle property", () => {
    const ctx = createAnalysisContext();
    const extract = ctx.window.xp_extractAdAngleText;
    const input = {
        angle: "打破乏味约会套路：今晚在餐桌开启陶艺 ||| Break the boring date routine: Turn table into pottery studio"
    };
    assert.equal(
        extract(input),
        "打破乏味约会套路：今晚在餐桌开启陶艺 ||| Break the boring date routine: Turn table into pottery studio"
    );
});

test("xp_extractAdAngleText handles object with title and detail", () => {
    const ctx = createAnalysisContext();
    const extract = ctx.window.xp_extractAdAngleText;
    const input = {
        title: "心意礼物 ||| Sentimental gift",
        detail: "每一口咖啡都是手绘的回忆 ||| Every sip holds memories"
    };
    assert.equal(
        extract(input),
        "心意礼物：每一口咖啡都是手绘的回忆 ||| Sentimental gift: Every sip holds memories"
    );
});

test("xp_extractAdAngleText handles object with hook and angle/description", () => {
    const ctx = createAnalysisContext();
    const extract = ctx.window.xp_extractAdAngleText;
    const input = {
        hook: "数字排毒",
        description: "放下手机两小时找回专注"
    };
    assert.equal(
        extract(input),
        "数字排毒：放下手机两小时找回专注"
    );
});

test("xp_extractAdAngleText handles null/undefined gracefully", () => {
    const ctx = createAnalysisContext();
    const extract = ctx.window.xp_extractAdAngleText;
    assert.equal(extract(null), "");
    assert.equal(extract(undefined), "");
    assert.equal(extract(""), "");
});
