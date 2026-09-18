const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createHistoryTestContext() {
    const context = {
        console,
        setTimeout,
        clearTimeout,
        Date,
        Set,
        Array,
        Object,
        JSON,
        API_BASE: 'http://127.0.0.1:9503',
        document: {
            getElementById: () => null,
            querySelectorAll: () => []
        },
        window: {},
        globalThis: {}
    };

    context.window = context;
    context.globalThis = context;
    const vmCtx = vm.createContext(context);

    const historyCode = fs.readFileSync(path.join(__dirname, '../js/history_manager.js'), 'utf8');
    vm.runInContext(historyCode, vmCtx);

    return vmCtx;
}

test('history manager toggleHistoryBatchMode and toggleHistorySelectAll manage selection correctly', () => {
    const ctx = createHistoryTestContext();

    const mockElements = {
        historyToolbar: { classList: { add: () => {}, remove: () => {} } },
        historyBatchBar: { classList: { add: () => {}, remove: () => {} } },
        historyBatchToggleBtn: { disabled: false, classList: { toggle: () => {} } },
        historySelectAllCheckbox: { checked: false, indeterminate: false },
        historySelectedCount: { textContent: '' },
        historyBatchDeleteBtn: { disabled: true, innerHTML: '' },
        historyItemCount: { textContent: '' },
        globalHistoryList: { innerHTML: '' }
    };

    ctx.document.getElementById = (id) => mockElements[id] || null;

    // Load mock cache of 3 items
    ctx.setHistoryCache([
        { id: 101, product_name: 'Item 1' },
        { id: 102, product_name: 'Item 2' },
        { id: 103, product_name: 'Item 3' }
    ]);

    // 1. Initially batch mode is false
    assert.strictEqual(ctx.getHistoryBatchMode(), false);
    assert.strictEqual(ctx.getSelectedHistoryIds().size, 0);

    // 2. Activate batch mode
    ctx.toggleHistoryBatchMode(true);
    assert.strictEqual(ctx.getHistoryBatchMode(), true);
    assert.strictEqual(mockElements.historyBatchDeleteBtn.disabled, true);

    // 3. Select all items
    ctx.toggleHistorySelectAll(true);
    const selected1 = ctx.getSelectedHistoryIds();
    assert.strictEqual(selected1.size, 3);
    assert.ok(selected1.has(101));
    assert.ok(selected1.has(102));
    assert.ok(selected1.has(103));
    assert.strictEqual(mockElements.historyBatchDeleteBtn.disabled, false);
    assert.strictEqual(mockElements.historySelectAllCheckbox.checked, true);

    // 4. Deselect one item
    ctx.toggleHistoryItemSelection(102, false);
    const selected2 = ctx.getSelectedHistoryIds();
    assert.strictEqual(selected2.size, 2);
    assert.strictEqual(selected2.has(102), false);
    assert.strictEqual(mockElements.historySelectAllCheckbox.indeterminate, true);

    // 5. Deselect all
    ctx.toggleHistorySelectAll(false);
    assert.strictEqual(ctx.getSelectedHistoryIds().size, 0);
    assert.strictEqual(mockElements.historyBatchDeleteBtn.disabled, true);

    // 6. Exit batch mode
    ctx.toggleHistoryItemSelection(101, true);
    assert.strictEqual(ctx.getSelectedHistoryIds().size, 1);
    ctx.toggleHistoryBatchMode(false);
    assert.strictEqual(ctx.getHistoryBatchMode(), false);
    assert.strictEqual(ctx.getSelectedHistoryIds().size, 0);
});

test('deleteHistoryBatchSelected prompts user and executes batch-delete request', async () => {
    const ctx = createHistoryTestContext();

    let confirmPrompt = '';
    ctx.confirm = (msg) => {
        confirmPrompt = msg;
        return true;
    };

    let fetchUrl = '';
    let fetchOptions = null;
    ctx.fetch = async (url, opts) => {
        fetchUrl = url;
        fetchOptions = opts;
        return {
            ok: true,
            json: async () => ({ status: 'success', deleted_count: 2 })
        };
    };

    let lastToast = null;
    ctx.showToast = (msg, type) => {
        lastToast = { msg, type };
    };

    ctx.setHistoryCache([
        { id: 201, product_name: 'P1' },
        { id: 202, product_name: 'P2' }
    ]);
    ctx.setCurrentHistoryModule('listing');
    ctx.toggleHistoryBatchMode(true);
    ctx.toggleHistoryItemSelection(201, true);
    ctx.toggleHistoryItemSelection(202, true);

    await ctx.deleteHistoryBatchSelected();

    assert.ok(confirmPrompt.includes('2 条历史记录'));
    assert.strictEqual(fetchUrl, 'http://127.0.0.1:9503/api/history/listing/batch-delete');
    assert.strictEqual(fetchOptions.method, 'POST');
    assert.deepStrictEqual(JSON.parse(fetchOptions.body), { ids: [201, 202] });
    assert.strictEqual(ctx.getSelectedHistoryIds().size, 0);
    assert.strictEqual(lastToast?.type, 'success');
    assert.ok(lastToast?.msg.includes('2 条历史记录'));
});

test('deleteHistoryBatchSelected falls back to parallel single deletes on HTTP 405/404', async () => {
    const ctx = createHistoryTestContext();
    ctx.confirm = () => true;

    const singleDeletes = [];
    ctx.fetch = async (url, opts) => {
        if (url.includes('/batch-delete')) {
            return {
                ok: false,
                status: 405,
                json: async () => ({ detail: 'Method Not Allowed' })
            };
        }
        singleDeletes.push({ url, method: opts?.method });
        return {
            ok: true,
            status: 200,
            json: async () => ({ status: 'success' })
        };
    };

    let lastToast = null;
    ctx.showToast = (msg, type) => {
        lastToast = { msg, type };
    };

    ctx.setHistoryCache([
        { id: 301, product_name: 'Item 1' },
        { id: 302, product_name: 'Item 2' }
    ]);
    ctx.setCurrentHistoryModule('render');
    ctx.toggleHistoryBatchMode(true);
    ctx.toggleHistoryItemSelection(301, true);
    ctx.toggleHistoryItemSelection(302, true);

    await ctx.deleteHistoryBatchSelected();

    assert.strictEqual(singleDeletes.length, 2);
    assert.strictEqual(singleDeletes[0].url, 'http://127.0.0.1:9503/api/history/render/301');
    assert.strictEqual(singleDeletes[0].method, 'DELETE');
    assert.strictEqual(singleDeletes[1].url, 'http://127.0.0.1:9503/api/history/render/302');
    assert.strictEqual(singleDeletes[1].method, 'DELETE');
    assert.strictEqual(ctx.getSelectedHistoryIds().size, 0);
    assert.strictEqual(lastToast?.type, 'success');
    assert.ok(lastToast?.msg.includes('2 条历史记录'));
});

test('saveDetailProjectToHistory captures full project snapshot including DTC copy and mode', () => {
    const ctx = createHistoryTestContext();

    const detailsCode = fs.readFileSync(path.join(__dirname, '../js/details.js'), 'utf8');
    vm.runInContext(detailsCode, ctx);

    let savedModule = '';
    let savedPayload = null;
    ctx.saveToHistory = (mod, data) => {
        savedModule = mod;
        savedPayload = data;
    };

    ctx.document.getElementById = (id) => {
        if (id === 'productNameInput') return { value: 'Ergonomic Standing Desk' };
        if (id === 'sellingPointsText') return { value: 'Dual motor, memory presets' };
        return null;
    };

    ctx.globalGenContext = {
        config: {
            productName: 'Ergonomic Standing Desk',
            presentationMode: 'hybrid',
            imageStyleLabel: '北欧轻奢',
            imageStyle: 'nordic'
        },
        primaryImage: { base64: 'data:image/jpeg;base64,deskPrimary' },
        uploadedImages: [
            { id: 'u1', name: 'desk.jpg', base64: 'data:image/jpeg;base64,deskPrimary', isPrimary: true }
        ],
        sellingPoints: 'Dual motor, memory presets',
        longImageOrder: ['m1', 'm2'],
        tasks: {
            m1: {
                id: 'm1',
                title: '首屏认知',
                subtitle: '快速升降',
                imageSrc: 'data:image/jpeg;base64,heroImg',
                dtcCopy: { headline: 'Work Healthier Everyday' }
            },
            m2: {
                id: 'm2',
                title: '核心痛点解决',
                subtitle: '告别久坐腰痛',
                imageSrc: 'data:image/jpeg;base64,fbrImg',
                dtcCopy: { headline: 'End Sitting Strain', fbr: [{ feature: 'Dual Motor', benefit: 'Smooth lift' }] }
            }
        }
    };

    ctx.currentDetailPresentationMode = 'hybrid';
    ctx.saveDetailProjectToHistory();

    assert.strictEqual(savedModule, 'render');
    assert.ok(savedPayload);
    assert.strictEqual(savedPayload.name, 'Ergonomic Standing Desk_详情全案');
    assert.strictEqual(savedPayload.style, '北欧轻奢');
    assert.strictEqual(savedPayload.metadata.kind, 'detail-page-project');
    assert.strictEqual(savedPayload.metadata.presentationMode, 'hybrid');
    assert.strictEqual(savedPayload.metadata.modules.length, 2);
    assert.strictEqual(savedPayload.metadata.modules[0].dtcCopy.headline, 'Work Healthier Everyday');
    assert.strictEqual(savedPayload.metadata.modules[1].dtcCopy.fbr[0].feature, 'Dual Motor');
});

test('globalHistoryPanel in index.html is NOT inside view-settings and tags are 100% balanced', () => {
    const rawHtml = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

    // Strip script and style contents so inline script strings like '<script ...>' are not parsed as DOM tags
    const html = rawHtml.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '<script></script>')
                        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '<style></style>');

    // 1. Tag balance check
    const stack = [];
    const errors = [];
    const tagRegex = /<\/?([a-zA-Z0-9\-]+)([^>]*)>/g;
    const voidTags = new Set(['img', 'br', 'hr', 'input', 'link', 'meta', 'source']);
    let match;
    while ((match = tagRegex.exec(html)) !== null) {
        const isClosing = match[0].startsWith('</');
        const tagName = match[1].toLowerCase();
        if (voidTags.has(tagName) || match[0].endsWith('/>')) continue;

        if (isClosing) {
            if (stack.length === 0) {
                errors.push(`Extra closing tag: </${tagName}>`);
            } else {
                const last = stack.pop();
                if (last !== tagName) {
                    errors.push(`Mismatched tag: expected </${last}>, got </${tagName}>`);
                }
            }
        } else {
            stack.push(tagName);
        }
    }

    assert.strictEqual(errors.length, 0, `HTML tags must be balanced: ${errors.join(', ')}`);
    assert.strictEqual(stack.length, 0, `All HTML tags must be closed: ${stack.join(', ')}`);

    // 2. Structural position of globalHistoryPanel vs view-settings
    const viewSettingsPos = html.indexOf('id="view-settings"');
    const globalHistoryPanelPos = html.indexOf('id="globalHistoryPanel"');
    assert.ok(viewSettingsPos > -1, 'id="view-settings" must exist');
    assert.ok(globalHistoryPanelPos > -1, 'id="globalHistoryPanel" must exist');
    assert.ok(globalHistoryPanelPos > viewSettingsPos, 'globalHistoryPanel should appear after view-settings in DOM');

    // 3. Ensure view-settings closing comment / tag precedes globalHistoryPanel
    const between = html.substring(viewSettingsPos, globalHistoryPanelPos);
    assert.ok(between.includes('<!-- 关闭 view-settings -->'), 'view-settings must close before globalHistoryPanel starts');
});

test('toggleGlobalHistory manages active state, smart module mapping, and forceState', () => {
    const ctx = createHistoryTestContext();

    const mockElements = {
        globalHistoryPanel: {
            classList: {
                _classes: new Set(),
                add(c) { this._classes.add(c); },
                remove(c) { this._classes.delete(c); },
                toggle(c, force) {
                    if (force === true) this._classes.add(c);
                    else if (force === false) this._classes.delete(c);
                    else if (this._classes.has(c)) this._classes.delete(c);
                    else this._classes.add(c);
                },
                contains(c) { return this._classes.has(c); }
            }
        },
        btnOpenHistory: {
            classList: {
                _classes: new Set(),
                add(c) { this._classes.add(c); },
                remove(c) { this._classes.delete(c); },
                toggle(c, force) {
                    if (force === true) this._classes.add(c);
                    else if (force === false) this._classes.delete(c);
                    else if (this._classes.has(c)) this._classes.delete(c);
                    else this._classes.add(c);
                },
                contains(c) { return this._classes.has(c); }
            }
        },
        globalHistoryList: { innerHTML: '' }
    };

    ctx.document.getElementById = (id) => mockElements[id] || null;

    let loadedModule = null;
    ctx.loadGlobalHistory = (mod) => { loadedModule = mod; };

    // 1. Test getHistoryModuleForActiveTab
    assert.strictEqual(ctx.getHistoryModuleForActiveTab('analysis'), 'analysis');
    assert.strictEqual(ctx.getHistoryModuleForActiveTab('generate'), 'render');
    assert.strictEqual(ctx.getHistoryModuleForActiveTab('listing'), 'listing');
    assert.strictEqual(ctx.getHistoryModuleForActiveTab('ads'), 'ads');
    assert.strictEqual(ctx.getHistoryModuleForActiveTab('square-redraw'), 'square-redraw');
    assert.strictEqual(ctx.getHistoryModuleForActiveTab('watermark-removal'), 'watermark-removal');
    assert.strictEqual(ctx.getHistoryModuleForActiveTab('translate'), 'translation');
    assert.strictEqual(ctx.getHistoryModuleForActiveTab('text-translate'), 'text-translation');

    // 2. Open history from listing tab
    ctx.localStorage = { getItem: (k) => k === 'activeMainTab' ? 'listing' : null };
    ctx.toggleGlobalHistory(true);
    assert.ok(mockElements.globalHistoryPanel.classList.contains('open'));
    assert.ok(mockElements.btnOpenHistory.classList.contains('active'));
    assert.strictEqual(ctx.getCurrentHistoryModule(), 'listing');
    assert.strictEqual(loadedModule, 'listing');

    // 3. Close history
    ctx.toggleGlobalHistory(false);
    assert.ok(!mockElements.globalHistoryPanel.classList.contains('open'));
    assert.ok(!mockElements.btnOpenHistory.classList.contains('active'));

    // 4. Open from generate tab (should map to 'render')
    ctx.localStorage = { getItem: (k) => k === 'activeMainTab' ? 'generate' : null };
    ctx.toggleGlobalHistory();
    assert.ok(mockElements.globalHistoryPanel.classList.contains('open'));
    assert.ok(mockElements.btnOpenHistory.classList.contains('active'));
    assert.strictEqual(ctx.getCurrentHistoryModule(), 'render');
    assert.strictEqual(loadedModule, 'render');
});
