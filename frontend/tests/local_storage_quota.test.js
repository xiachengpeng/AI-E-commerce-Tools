const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createUtilsContext() {
    const store = new Map();
    let throwOnKey = null;

    const mockLocalStorage = {
        getItem: (k) => store.get(k) || null,
        setItem: (k, v) => {
            if (throwOnKey === k || throwOnKey === '*') {
                const err = new Error('Quota exceeded');
                err.name = 'QuotaExceededError';
                err.code = 22;
                throw err;
            }
            store.set(k, String(v));
        },
        removeItem: (k) => store.delete(k),
        clear: () => store.clear()
    };

    const context = {
        console,
        localStorage: mockLocalStorage,
        window: {}
    };
    context.window = context;
    context.globalThis = context;
    vm.createContext(context);

    const utilsCode = fs.readFileSync(path.join(__dirname, '../js/utils.js'), 'utf8');
    vm.runInContext(utilsCode, context);

    return {
        ctx: context,
        store,
        setThrowOnKey: (k) => { throwOnKey = k; }
    };
}

test('safeLocalStorageSet stores data normally when space is sufficient', () => {
    const { ctx, store } = createUtilsContext();
    assert.strictEqual(typeof ctx.window.safeLocalStorageSet, 'function', 'safeLocalStorageSet should be defined');

    const success = ctx.window.safeLocalStorageSet('test_key', 'test_value');
    assert.strictEqual(success, true);
    assert.strictEqual(store.get('test_key'), 'test_value');
});

test('safeLocalStorageSet purges purgeKeys and retries successfully on QuotaExceededError', () => {
    const { ctx, store } = createUtilsContext();

    // Populate old cache keys
    store.set('xuanpin_last_result_v26', 'heavy_old_data');
    store.set('temp_preview_cache', 'heavy_preview_data');

    // Simulate quota exceeded until purge happens
    let attempts = 0;
    ctx.localStorage.setItem = (k, v) => {
        attempts++;
        if (attempts === 1 && store.has('xuanpin_last_result_v26')) {
            const err = new Error('Quota exceeded');
            err.name = 'QuotaExceededError';
            throw err;
        }
        store.set(k, String(v));
    };

    const success = ctx.window.safeLocalStorageSet('new_key', 'new_value', ['xuanpin_last_result_v26']);
    assert.strictEqual(success, true);
    assert.strictEqual(store.get('new_key'), 'new_value');
    assert.strictEqual(store.has('xuanpin_last_result_v26'), false, 'Old key should have been purged');
});

test('safeLocalStorageSet returns false without throwing if quota still exceeded after purge', () => {
    const { ctx, setThrowOnKey } = createUtilsContext();
    setThrowOnKey('*');

    assert.doesNotThrow(() => {
        const result = ctx.window.safeLocalStorageSet('huge_key', 'huge_value');
        assert.strictEqual(result, false);
    });
});
