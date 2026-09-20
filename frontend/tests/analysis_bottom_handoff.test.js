const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const htmlPath = path.join(__dirname, '..', 'index.html');
const analysisPath = path.join(__dirname, '..', 'js', 'analysis.js');

test('index.html contains single and matrix bottom handoff containers', () => {
    const html = fs.readFileSync(htmlPath, 'utf8');
    assert.ok(html.includes('id="xp-singleBottomHandoff"'), 'xp-singleBottomHandoff should exist in index.html');
    assert.ok(html.includes('id="xp-matrixBottomHandoff"'), 'xp-matrixBottomHandoff should exist in index.html');
});

test('analysis.js defines bottom handoff renderers', () => {
    const code = fs.readFileSync(analysisPath, 'utf8');
    assert.ok(code.includes('function xp_renderSingleBottomHandoff'), 'xp_renderSingleBottomHandoff should be defined');
    assert.ok(code.includes('function xp_renderMatrixBottomHandoff'), 'xp_renderMatrixBottomHandoff should be defined');
});

test('xp_renderSingleBottomHandoff and xp_renderMatrixBottomHandoff render actionable CTA buttons in DOM', () => {
    const code = fs.readFileSync(analysisPath, 'utf8');
    const elements = new Map();

    const getEl = (id) => {
        if (!elements.has(id)) {
            const classes = new Set(['xp-hidden']);
            elements.set(id, {
                id,
                innerHTML: '',
                textContent: '',
                classList: {
                    add: (c) => classes.add(c),
                    remove: (c) => classes.delete(c),
                    contains: (c) => classes.has(c)
                }
            });
        }
        return elements.get(id);
    };

    const sandbox = {
        console,
        window: {},
        globalThis: {},
        document: {
            getElementById: getEl
        },
        xp_currentLang: 'zh',
        showToast: () => {}
    };

    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);

    const renderSingle = sandbox.window.xp_renderSingleBottomHandoff || sandbox.xp_renderSingleBottomHandoff;
    const renderMatrix = sandbox.window.xp_renderMatrixBottomHandoff || sandbox.xp_renderMatrixBottomHandoff;

    assert.strictEqual(typeof renderSingle, 'function', 'renderSingle should be a function');
    assert.strictEqual(typeof renderMatrix, 'function', 'renderMatrix should be a function');

    // Call single bottom handoff
    renderSingle({ product_name: 'Test Stand' });
    const singleEl = getEl('xp-singleBottomHandoff');
    assert.strictEqual(singleEl.classList.contains('xp-hidden'), false);
    assert.ok(singleEl.innerHTML.includes('xp_transferToListing'), 'Should have transfer to Listing action');
    assert.ok(singleEl.innerHTML.includes('xp_transferToAds'), 'Should have transfer to Ads action');
    assert.ok(singleEl.innerHTML.includes('xp_transferToDetails'), 'Should have transfer to Details action');
    assert.ok(singleEl.innerHTML.includes('xp_transferToBrandProfile'), 'Should have save to Brand Profile action');

    // Call matrix bottom handoff
    renderMatrix({ products: [{ product_name: 'Winner Pod' }] });
    const matrixEl = getEl('xp-matrixBottomHandoff');
    assert.strictEqual(matrixEl.classList.contains('xp-hidden'), false);
    assert.ok(matrixEl.innerHTML.includes('xp_transferMatrixToListing'), 'Matrix handoff should have transfer to Listing action');
    assert.ok(matrixEl.innerHTML.includes('xp_transferMatrixToAds'), 'Matrix handoff should have transfer to Ads action');
    assert.ok(matrixEl.innerHTML.includes('xp_transferMatrixToDetails'), 'Matrix handoff should have transfer to Details action');
    assert.ok(matrixEl.innerHTML.includes('xp_transferToBrandProfile'), 'Matrix handoff should have save to Brand Profile action');
});

test('xp_renderSingleBottomHandoff renders English text when xp_currentLang is en', () => {
    const code = fs.readFileSync(analysisPath, 'utf8');
    const elements = new Map();

    const getEl = (id) => {
        if (!elements.has(id)) {
            const classes = new Set(['xp-hidden']);
            elements.set(id, {
                id,
                innerHTML: '',
                textContent: '',
                classList: {
                    add: (c) => classes.add(c),
                    remove: (c) => classes.delete(c),
                    contains: (c) => classes.has(c)
                }
            });
        }
        return elements.get(id);
    };

    const sandbox = {
        console,
        window: {},
        globalThis: {},
        document: {
            getElementById: getEl
        },
        xp_currentLang: 'en',
        showToast: () => {}
    };

    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);

    if (sandbox.window.xp_setLang) {
        sandbox.window.xp_setLang('en');
    }

    const renderSingle = sandbox.window.xp_renderSingleBottomHandoff;
    renderSingle({ product_name: 'Smart Water Bottle' });
    const singleEl = getEl('xp-singleBottomHandoff');
    assert.ok(singleEl.innerHTML.includes('Insights Ready'), 'English title should be rendered');
    assert.ok(singleEl.innerHTML.includes('Generate Listing'), 'English action label should be rendered');
});

