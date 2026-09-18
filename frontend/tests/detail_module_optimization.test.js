const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");

function createTestContext() {
    const elements = {};

    function getOrCreate(id) {
        if (!elements[id]) {
            elements[id] = {
                id,
                innerHTML: "",
                textContent: "",
                value: "",
                className: "",
                classList: {
                    _classes: new Set(),
                    add(...cls) { cls.forEach(c => this._classes.add(c)); },
                    remove(...cls) { cls.forEach(c => this._classes.delete(c)); },
                    toggle(c, force) {
                        if (force === true) this._classes.add(c);
                        else if (force === false) this._classes.delete(c);
                        else if (this._classes.has(c)) this._classes.delete(c);
                        else this._classes.add(c);
                    },
                    contains(c) { return this._classes.has(c); }
                },
                appendChild: () => {},
                insertAdjacentHTML: function(pos, html) {
                    if (pos === "beforeend") this.innerHTML += html;
                    else this.innerHTML = html + this.innerHTML;
                },
                removeChild: () => {}
            };
        }
        return elements[id];
    }

    const doc = {
        getElementById: (id) => getOrCreate(id),
        querySelector: (sel) => {
            if (sel.startsWith("#")) return getOrCreate(sel.slice(1));
            return null;
        },
        querySelectorAll: () => []
    };

    let lastToast = null;

    const ctx = {
        console,
        document: doc,
        showToast: (msg, type) => { lastToast = { msg, type }; },
        switchTab: () => {},
        remoteLog: () => {},
        localStorage: {
            getItem: () => null,
            setItem: () => {},
            removeItem: () => {}
        },
        MARKET_TONE_MAP: { "US Market": "direct but compliant" },
        API_BASE: "http://127.0.0.1:9503/api",
        fetch: async () => ({ ok: true, json: async () => ({}) })
    };

    ctx.window = ctx;
    ctx.globalThis = ctx;

    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(root, "js", "config.js"), "utf8"), ctx);
    vm.runInContext(fs.readFileSync(path.join(root, "js", "app.js"), "utf8"), ctx);
    vm.runInContext(fs.readFileSync(path.join(root, "js", "details.js"), "utf8"), ctx);

    return { ctx, elements, getLastToast: () => lastToast };
}

test("MODULE_CATEGORIES defines 6 category groups covering all modules", () => {
    const { ctx } = createTestContext();
    assert.ok(ctx.MODULE_CATEGORIES, "MODULE_CATEGORIES should be defined");
    assert.strictEqual(typeof ctx.MODULE_CATEGORIES, "object");
    assert.ok(ctx.MODULE_CATEGORIES.all, "all category exists");
    assert.ok(ctx.MODULE_CATEGORIES.selected, "selected category exists");
    assert.ok(ctx.MODULE_CATEGORIES.core, "core category exists");
    assert.ok(ctx.MODULE_CATEGORIES.brand, "brand category exists");
    assert.ok(ctx.MODULE_CATEGORIES.specs, "specs category exists");
    assert.ok(ctx.MODULE_CATEGORIES.bundle, "bundle category exists");

    const categorized = new Set([
        ...ctx.MODULE_CATEGORIES.core.ids,
        ...ctx.MODULE_CATEGORIES.brand.ids,
        ...ctx.MODULE_CATEGORIES.specs.ids,
        ...ctx.MODULE_CATEGORIES.bundle.ids
    ]);
    for (let i = 1; i <= 18; i++) {
        assert.ok(categorized.has(`m${i}`), `Module m${i} should belong to a category`);
    }
});

test("initModules updates moduleSelectionStatsBadge and renders module grid with min-h-[106px]", () => {
    const { ctx, elements } = createTestContext();

    ctx.modules.forEach(m => { m.active = false; m.count = 1; });
    const m1 = ctx.modules.find(m => m.id === "m1");
    const m2 = ctx.modules.find(m => m.id === "m2");
    const m3 = ctx.modules.find(m => m.id === "m3");
    m1.active = true;
    m2.active = true;
    m2.count = 2;
    m3.active = true;

    ctx.initModules();

    const badge = elements["moduleSelectionStatsBadge"];
    assert.ok(badge.textContent.includes("已选 3 模块"), `Badge text should show 3 modules, got: ${badge.textContent}`);
    assert.ok(badge.textContent.includes("共 4 张图"), `Badge text should show 4 images, got: ${badge.textContent}`);

    const grid = elements["moduleGrid"];
    assert.ok(grid.innerHTML.includes("min-h-[106px]"), "Module cards should have min-h-[106px] height stabilization");
    assert.ok(grid.innerHTML.includes("#1"), "First active module should have storyboard badge #1");
    assert.ok(grid.innerHTML.includes("#2"), "Second active module should have storyboard badge #2");
    assert.ok(grid.innerHTML.includes("#3"), "Third active module should have storyboard badge #3");
});

test("invertModuleSelection inverts active state and updates badge", () => {
    const { ctx, elements } = createTestContext();

    ctx.modules.forEach(m => { m.active = false; });
    ctx.modules.find(m => m.id === "m1").active = true;
    ctx.modules.find(m => m.id === "m2").active = true;

    ctx.invertModuleSelection();

    assert.strictEqual(ctx.modules.find(m => m.id === "m1").active, false);
    assert.strictEqual(ctx.modules.find(m => m.id === "m2").active, false);
    const activeCount = ctx.modules.filter(m => m.active).length;
    assert.strictEqual(activeCount, 16);

    const badge = elements["moduleSelectionStatsBadge"];
    assert.ok(badge.textContent.includes("已选 16 模块"), `Badge should reflect 16 modules, got: ${badge.textContent}`);
});

test("batchSetAllModuleText toggles includeText for all active modules", () => {
    const { ctx, getLastToast } = createTestContext();

    ctx.modules.forEach(m => { m.active = false; m.includeText = true; });
    ctx.modules.find(m => m.id === "m1").active = true;
    ctx.modules.find(m => m.id === "m2").active = true;

    ctx.batchSetAllModuleText(false);
    assert.strictEqual(ctx.modules.find(m => m.id === "m1").includeText, false);
    assert.strictEqual(ctx.modules.find(m => m.id === "m2").includeText, false);
    assert.strictEqual(getLastToast()?.type, "success");
    assert.ok(getLastToast()?.msg.includes("纯图"));

    ctx.batchSetAllModuleText(true);
    assert.strictEqual(ctx.modules.find(m => m.id === "m1").includeText, true);
    assert.strictEqual(ctx.modules.find(m => m.id === "m2").includeText, true);
    assert.strictEqual(getLastToast()?.type, "success");
    assert.ok(getLastToast()?.msg.includes("含字"));
});

test("setModuleCategoryFilter filters modules shown in moduleGrid", () => {
    const { ctx, elements } = createTestContext();

    ctx.setModuleCategoryFilter("brand");

    const grid = elements["moduleGrid"];
    assert.ok(grid.innerHTML.includes("品牌/定位表达"), "Grid should contain m7 Brand positioning");
    assert.ok(grid.innerHTML.includes("生活方式氛围"), "Grid should contain m5 Lifestyle atmosphere");
    assert.ok(!grid.innerHTML.includes("全家福拆解清单"), "Grid should NOT contain m13 bundle breakdown in brand filter");

    ctx.setModuleCategoryFilter("all");
    assert.ok(elements["moduleGrid"].innerHTML.includes("全家福拆解清单"));
});
