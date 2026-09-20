const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createDetailsContext(overrides = {}) {
    const context = {
        console,
        setTimeout,
        clearTimeout,
        document: {
            getElementById: (id) => null
        },
        window: {},
        showToast: () => {}
    };
    context.window = context;
    context.globalThis = context;
    vm.createContext(context);

    const detailsCode = fs.readFileSync(path.join(__dirname, '../js/details.js'), 'utf8');
    vm.runInContext(detailsCode, context);
    return context;
}

test('calculateSafeLongImageScale maintains scale when height is within limit', () => {
    const ctx = createDetailsContext();
    assert.strictEqual(typeof ctx.window.calculateSafeLongImageScale, 'function', 'calculateSafeLongImageScale should be defined');

    // 2000px height with scale 2 = 4000px <= 16384px -> stays 2.0
    const scale = ctx.window.calculateSafeLongImageScale(2000, 2.0, 16384);
    assert.strictEqual(scale, 2.0);
});

test('calculateSafeLongImageScale downscales when height exceeds maxDimension', () => {
    const ctx = createDetailsContext();

    // 10000px height with scale 2 = 20000px > 16384px -> downscales to <= 1.63
    const scale = ctx.window.calculateSafeLongImageScale(10000, 2.0, 16384);
    assert.ok(scale <= 1.6384, `Expected scale <= 1.6384, got ${scale}`);
    assert.ok(scale >= 1.0, `Scale should not drop below 1.0, got ${scale}`);
    assert.ok(10000 * scale <= 16384, 'Total rendered height must not exceed 16384');
});

test('calculateSafeLongImageScale respects extreme heights with floor 1.0', () => {
    const ctx = createDetailsContext();

    // 25000px height with scale 1.5 -> floor is 1.0
    const scale = ctx.window.calculateSafeLongImageScale(25000, 1.5, 16384);
    assert.strictEqual(scale, 1.0);
});
