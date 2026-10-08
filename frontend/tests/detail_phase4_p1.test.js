const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

function createTestContext() {
    const elements = {};
    const doc = {
        getElementById: (id) => {
            if (!elements[id]) {
                elements[id] = {
                    id,
                    value: '',
                    textContent: '',
                    innerHTML: '',
                    className: '',
                    style: {},
                    dataset: {},
                    classList: {
                        _classes: new Set(),
                        add(c) { this._classes.add(c); },
                        remove(c) { this._classes.delete(c); },
                        toggle(c, force) {
                            if (force !== undefined) {
                                if (force) this._classes.add(c);
                                else this._classes.delete(c);
                            } else {
                                if (this._classes.has(c)) this._classes.delete(c);
                                else this._classes.add(c);
                            }
                        },
                        contains(c) { return this._classes.has(c); }
                    },
                    querySelector: () => null,
                    querySelectorAll: () => [],
                    setAttribute: (k, v) => { elements[id][k] = v; },
                    getAttribute: (k) => elements[id][k] || null,
                    appendChild: () => {},
                    removeChild: () => {},
                    scrollIntoView: () => {}
                };
            }
            return elements[id];
        },
        querySelector: (sel) => null,
        querySelectorAll: () => [],
        createElement: (tag) => ({
            tagName: tag.toUpperCase(),
            value: '',
            textContent: '',
            innerHTML: '',
            className: '',
            style: {},
            dataset: {},
            classList: {
                _classes: new Set(),
                add(c) { this._classes.add(c); },
                remove(c) { this._classes.delete(c); },
                toggle(c) {},
                contains(c) { return this._classes.has(c); }
            },
            appendChild: () => {},
            removeChild: () => {}
        }),
        body: {
            appendChild: () => {},
            removeChild: () => {}
        }
    };

    const storageMap = {};
    const ctx = {
        console,
        document: doc,
        setTimeout,
        clearTimeout,
        AbortController,
        DOMException: typeof DOMException !== 'undefined' ? DOMException : undefined,
        showToast: () => {},
        remoteLog: () => {},
        localStorage: {
            _store: storageMap,
            getItem(k) { return this._store[k] || null; },
            setItem(k, v) { this._store[k] = String(v); },
            removeItem(k) { delete this._store[k]; }
        },
        API_BASE: 'http://127.0.0.1:9503/api',
        fetch: async () => ({ ok: true, json: async () => ({}) })
    };

    ctx.window = ctx;
    ctx.globalThis = ctx;

    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(root, 'js', 'config.js'), 'utf8'), ctx);
    vm.runInContext(fs.readFileSync(path.join(root, 'js', 'utils.js'), 'utf8'), ctx);
    ctx.showToast = () => {};
    vm.runInContext(fs.readFileSync(path.join(root, 'js', 'details.js'), 'utf8'), ctx);
    ctx.showToast = () => {};

    return { ctx, elements };
}

// 1. 上架准备度评估算法 (computePublishReadiness)
test('computePublishReadiness calculates readiness score and check items for Shopify channel', () => {
    const { ctx } = createTestContext();
    assert.strictEqual(typeof ctx.computePublishReadiness, 'function');

    const tasks = [
        {
            uniqueId: 't1',
            id: 'm1',
            title: 'Hero',
            imageUrl: 'https://cdn.example.com/hero.webp',
            dtcCopy: { headline: 'Ultimate Desk' },
            seo: { titleTarget: 'Best Desk' }
        },
        {
            uniqueId: 't2',
            id: 'm2',
            title: 'Benefit',
            imageUrl: 'data:image/png;base64,local_img',
            dtcCopy: { headline: 'Dual Motor Power' },
            seo: { titleTarget: 'Motor power' }
        }
    ];

    const result = ctx.computePublishReadiness(tasks, 'shopify');
    assert.ok(result.score > 0);
    assert.strictEqual(typeof result.percentage, 'number');
    assert.ok(Array.isArray(result.items));
    assert.strictEqual(result.items.find(i => i.id === 'images').passed, true);
    assert.strictEqual(result.items.find(i => i.id === 'copy').passed, true);
    // t2 has data:image local URL, so hosting is not 100% complete for shopify
    assert.strictEqual(result.items.find(i => i.id === 'hosting').passed, false);
});

// 2. 空任务准备度评估
test('computePublishReadiness handles empty task list returning 0 score', () => {
    const { ctx } = createTestContext();
    const result = ctx.computePublishReadiness([], 'shopify');
    assert.strictEqual(result.score, 0);
    assert.strictEqual(result.percentage, 0);
    assert.strictEqual(result.isReadyToPublish, false);
});

// 3. 草稿保存与读取 (saveStudioDraft & getStudioDraft)
test('saveStudioDraft saves studio snapshot to localStorage with timestamp', () => {
    const { ctx } = createTestContext();
    assert.strictEqual(typeof ctx.saveStudioDraft, 'function');
    assert.strictEqual(typeof ctx.getStudioDraft, 'function');

    ctx.setDetailChannel('shopify');
    ctx.setGlobalGenContext({
        tasks: [
            { uniqueId: 't1', id: 'm1', title: 'Hero' }
        ]
    });

    const saved = ctx.saveStudioDraft();
    assert.strictEqual(saved, true);

    const draft = ctx.getStudioDraft();
    assert.ok(draft !== null);
    assert.strictEqual(draft.channel, 'shopify');
    assert.ok(draft.savedAt > 0);
    assert.strictEqual(draft.tasks.length, 1);
    assert.strictEqual(draft.tasks[0].uniqueId, 't1');
});

// 4. 清理草稿 (clearStudioDraft)
test('clearStudioDraft removes saved draft from localStorage', () => {
    const { ctx } = createTestContext();
    assert.strictEqual(typeof ctx.clearStudioDraft, 'function');

    ctx.saveStudioDraft();
    assert.ok(ctx.getStudioDraft() !== null);

    ctx.clearStudioDraft();
    assert.strictEqual(ctx.getStudioDraft(), null);
});

// 5. 草稿恢复 (restoreStudioDraft)
test('restoreStudioDraft restores studio state from draft object', () => {
    const { ctx } = createTestContext();
    assert.strictEqual(typeof ctx.restoreStudioDraft, 'function');

    const draftData = {
        channel: 'amazon',
        layoutStyle: 'technical',
        brandColor: 'emerald',
        productFacts: { category: 'Electronics' },
        tasks: [
            { uniqueId: 'amz_1', id: 'm1', title: 'Main Feature' }
        ],
        longImageOrder: ['amz_1']
    };

    const restored = ctx.restoreStudioDraft(draftData);
    assert.strictEqual(restored, true);
    assert.strictEqual(ctx.getDetailChannel(), 'amazon');
    assert.strictEqual(ctx.getGlobalGenContext().tasks.length, 1);
    assert.strictEqual(ctx.getGlobalGenContext().tasks[0].uniqueId, 'amz_1');
});

// 6. 自动防抖保存调度 (scheduleDraftAutosave)
test('scheduleDraftAutosave triggers debounced draft saving', async () => {
    const { ctx } = createTestContext();
    assert.strictEqual(typeof ctx.scheduleDraftAutosave, 'function');

    ctx.setDetailChannel('social');
    ctx.setGlobalGenContext({ tasks: [{ uniqueId: 's1', id: 'm1' }] });

    // Schedule autosave with a short debounce for testing
    ctx.scheduleDraftAutosave(20);

    // Immediately check -> not saved yet
    assert.strictEqual(ctx.getStudioDraft(), null);

    // Wait for timer
    await new Promise(r => setTimeout(r, 40));

    const draft = ctx.getStudioDraft();
    assert.ok(draft !== null);
    assert.strictEqual(draft.channel, 'social');
});

// 7. 渠道主行动更新 (updatePrimaryDeliveryCTA)
test('updatePrimaryDeliveryCTA updates button text and attributes based on active channel', () => {
    const { ctx } = createTestContext();
    assert.strictEqual(typeof ctx.updatePrimaryDeliveryCTA, 'function');

    const btn = ctx.document.getElementById('btnPrimaryDeliveryCTA');
    const textEl = ctx.document.getElementById('btnPrimaryDeliveryCTAText');

    // Test shopify
    ctx.setDetailChannel('shopify');
    ctx.updatePrimaryDeliveryCTA();
    assert.ok(textEl.textContent.includes('上架') || textEl.textContent.includes('Shopify'));

    // Test amazon
    ctx.setDetailChannel('amazon');
    ctx.updatePrimaryDeliveryCTA();
    assert.ok(textEl.textContent.includes('Amazon') || textEl.textContent.includes('切图'));

    // Test general
    ctx.setDetailChannel('general');
    ctx.updatePrimaryDeliveryCTA();
    assert.ok(textEl.textContent.includes('物料包') || textEl.textContent.includes('ZIP'));
});

// 8. 渠道主交付执行分发 (executePrimaryChannelPublish)
test('executePrimaryChannelPublish dispatches according to current channel', () => {
    const { ctx } = createTestContext();
    assert.strictEqual(typeof ctx.executePrimaryChannelPublish, 'function');

    let triggeredAction = '';
    ctx.openDetailDtcHtmlModal = () => { triggeredAction = 'dtc_modal'; };
    ctx.downloadAmazonAPlusCrops = () => { triggeredAction = 'amazon_crops'; };
    ctx.exportFullLaunchKit = () => { triggeredAction = 'launch_kit'; };

    // Shopify -> dtc_modal
    ctx.setDetailChannel('shopify');
    ctx.executePrimaryChannelPublish();
    assert.strictEqual(triggeredAction, 'dtc_modal');

    // Amazon -> amazon_crops
    ctx.setDetailChannel('amazon');
    ctx.executePrimaryChannelPublish();
    assert.strictEqual(triggeredAction, 'amazon_crops');

    // General -> launch_kit
    ctx.setDetailChannel('general');
    ctx.executePrimaryChannelPublish();
    assert.strictEqual(triggeredAction, 'launch_kit');
});

// 9. 长图设计器数据与 Editor 顺序联动 (syncEditorOrderToLongImage)
test('syncEditorOrderToLongImage synchronizes longImageOrder with editor task list', () => {
    const { ctx } = createTestContext();
    assert.strictEqual(typeof ctx.syncEditorOrderToLongImage, 'function');

    const t1 = { uniqueId: 'e1', id: 'm1' };
    const t2 = { uniqueId: 'e2', id: 'm2' };
    ctx.setGlobalGenContext({
        tasks: [t2, t1], // order in editor: [t2, t1]
        longImageOrder: ['e1', 'e2'] // old out of sync
    });

    ctx.syncEditorOrderToLongImage();
    const syncedOrder = Array.from(ctx.getGlobalGenContext().longImageOrder);
    assert.deepStrictEqual(syncedOrder, ['e2', 'e1']);
});

// 10. 自动保存状态条渲染 (updateAutosaveStatusUI)
test('updateAutosaveStatusUI updates status element with save time', () => {
    const { ctx } = createTestContext();
    assert.strictEqual(typeof ctx.updateAutosaveStatusUI, 'function');

    const statusEl = ctx.document.getElementById('dtcAutosaveStatus');
    ctx.updateAutosaveStatusUI(Date.now());

    assert.ok(statusEl.textContent.includes('已自动保存'));
});
