const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const htmlPath = path.join(__dirname, '..', 'index.html');
const detailsPath = path.join(__dirname, '..', 'js', 'details.js');

test('index.html contains detailDeliveryHandoffCard container in resultArea', () => {
    const html = fs.readFileSync(htmlPath, 'utf8');
    assert.ok(html.includes('id="detailDeliveryHandoffCard"'), 'detailDeliveryHandoffCard container should exist in index.html');
    assert.ok(html.includes('id="resultArea"'), 'resultArea should exist');
});

test('details.js defines renderDetailDeliveryHub, transferDetailToListing, and transferDetailToAds', () => {
    const detailsCode = fs.readFileSync(detailsPath, 'utf8');
    assert.ok(detailsCode.includes('function renderDetailDeliveryHub'), 'renderDetailDeliveryHub should be defined in details.js');
    assert.ok(detailsCode.includes('function transferDetailToListing'), 'transferDetailToListing should be defined in details.js');
    assert.ok(detailsCode.includes('function transferDetailToAds'), 'transferDetailToAds should be defined in details.js');
});

test('renderDetailDeliveryHub renders downstream action buttons and stats', () => {
    const detailsCode = fs.readFileSync(detailsPath, 'utf8');
    assert.ok(detailsCode.includes('openLongImageBuilder'), 'Delivery Hub should offer long image builder action');
    assert.ok(detailsCode.includes('openDetailDtcHtmlModal'), 'Delivery Hub should offer DTC HTML modal action');
    assert.ok(detailsCode.includes('openPdpAssetHostingModal'), 'Delivery Hub should offer asset hosting action');
    assert.ok(detailsCode.includes('exportFullLaunchKit'), 'Delivery Hub should offer Launch Kit export action');
    assert.ok(detailsCode.includes('transferDetailToListing'), 'Delivery Hub should offer transfer to Listing action');
    assert.ok(detailsCode.includes('transferDetailToAds'), 'Delivery Hub should offer transfer to Ads action');
});

test('renderDetailDeliveryHub correctly toggles visibility and updates count badge', () => {
    const detailsCode = fs.readFileSync(detailsPath, 'utf8');
    const elements = new Map();

    const getEl = (id) => {
        if (!elements.has(id)) {
            const classes = new Set(['hidden']);
            elements.set(id, {
                id,
                value: '',
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
        showToast: () => {},
        switchMainTab: () => {},
        currentDetailPresentationMode: 'hybrid'
    };

    vm.createContext(sandbox);
    vm.runInContext(detailsCode, sandbox);

    // Initial state: hidden
    const card = getEl('detailDeliveryHandoffCard');
    assert.ok(card.classList.contains('hidden'));

    // Call with 5 successful modules
    sandbox.renderDetailDeliveryHub(5, 6);
    assert.strictEqual(card.classList.contains('hidden'), false, 'Card should be visible when successCount > 0');
    assert.strictEqual(getEl('detailDeliveryStatsBadge').textContent, '已就绪 5 个视觉模块 (共 6 个)');

    // Call with 0 successful modules (or reset)
    sandbox.renderDetailDeliveryHub(0, 6);
    assert.strictEqual(card.classList.contains('hidden'), true, 'Card should be hidden when successCount === 0');
});

test('transferDetailToListing and transferDetailToAds successfully store draft and switch tabs', () => {
    const detailsCode = fs.readFileSync(detailsPath, 'utf8');
    const elements = new Map();

    const getEl = (id) => {
        if (!elements.has(id)) {
            elements.set(id, {
                id,
                value: id === 'productName' ? '智能温控咖啡杯' : (id === 'sellingPoints' ? '55度恒温 无线充电' : ''),
                textContent: ''
            });
        }
        return elements.get(id);
    };

    let switchedTab = null;
    let toastMessage = null;

    const sandbox = {
        console,
        window: {},
        globalThis: {},
        document: {
            getElementById: getEl
        },
        showToast: (msg) => { toastMessage = msg; },
        switchMainTab: (tab) => { switchedTab = tab; }
    };

    vm.createContext(sandbox);
    vm.runInContext(detailsCode, sandbox);

    // Test transferDetailToListing
    sandbox.transferDetailToListing();
    assert.strictEqual(switchedTab, 'listing');
    assert.ok(toastMessage && toastMessage.includes('智能温控咖啡杯'));
    assert.strictEqual(sandbox.window.listingDraftState.productName, '智能温控咖啡杯');
    assert.strictEqual(sandbox.window.listingDraftState.features, '55度恒温 无线充电');
    assert.strictEqual(sandbox.window.listingDraftState.sourceModule, 'details');

    // Test transferDetailToAds
    switchedTab = null;
    toastMessage = null;
    sandbox.transferDetailToAds();
    assert.strictEqual(switchedTab, 'ads');
    assert.ok(toastMessage && toastMessage.includes('智能温控咖啡杯'));
    assert.strictEqual(sandbox.window.adsDraftState.productName, '智能温控咖啡杯');
    assert.strictEqual(sandbox.window.adsDraftState.sellingPoints, '55度恒温 无线充电');
    assert.strictEqual(sandbox.window.adsDraftState.sourceModule, 'details');
});
