const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const htmlPath = path.join(__dirname, '..', 'index.html');
const detailsPath = path.join(__dirname, '..', 'js', 'details.js');

test('index.html contains detailDeliveryHandoffCard modal with fixed backdrop', () => {
    const html = fs.readFileSync(htmlPath, 'utf8');
    assert.ok(html.includes('id="detailDeliveryHandoffCard"'), 'detailDeliveryHandoffCard container should exist in index.html');
    assert.ok(html.includes('id="resultArea"'), 'resultArea should exist');
    // Ensure detailDeliveryHandoffCard is styled as a modal dialog with fixed inset-0 so it doesn't block the preview canvas
    assert.match(html, /id="detailDeliveryHandoffCard"[^>]*class="[^"]*fixed\s+inset-0/, 'detailDeliveryHandoffCard should have fixed inset-0 modal backdrop');
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

test('renderDetailDeliveryHub updates badge without blocking preview, openDetailDeliveryHub reveals modal', () => {
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

    // Call with 5 successful modules: should update badge but NOT auto-unhide the card (avoiding blocking the preview canvas)
    sandbox.renderDetailDeliveryHub(5, 6);
    assert.strictEqual(card.classList.contains('hidden'), true, 'Card should remain hidden on generation to avoid blocking the preview canvas');
    assert.strictEqual(getEl('detailDeliveryStatsBadge').textContent, '已就绪 5 个视觉模块 (共 6 个)');

    // Explicitly opening delivery hub reveals it
    sandbox.openDetailDeliveryHub();
    assert.strictEqual(card.classList.contains('hidden'), false, 'openDetailDeliveryHub should make the modal visible');

    // Dismissing hides it again
    sandbox.dismissDetailDeliveryHub();
    assert.strictEqual(card.classList.contains('hidden'), true, 'dismissDetailDeliveryHub should hide the modal');
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

test('dismissDetailDeliveryHub and toggleDetailDeliveryHubCollapse control delivery hub card', () => {
    const html = fs.readFileSync(htmlPath, 'utf8');
    assert.ok(html.includes('dismissDetailDeliveryHub'), 'index.html should have dismiss button for delivery hub');
    assert.ok(html.includes('toggleDetailDeliveryHubCollapse'), 'index.html should have collapse toggle button for delivery hub');

    const detailsCode = fs.readFileSync(detailsPath, 'utf8');
    assert.ok(detailsCode.includes('function dismissDetailDeliveryHub'), 'dismissDetailDeliveryHub should be defined in details.js');
    assert.ok(detailsCode.includes('function toggleDetailDeliveryHubCollapse'), 'toggleDetailDeliveryHubCollapse should be defined in details.js');

    const elements = new Map();
    const getEl = (id) => {
        if (!elements.has(id)) {
            const classes = new Set();
            elements.set(id, {
                id,
                value: '',
                textContent: '',
                classList: {
                    add: (c) => classes.add(c),
                    remove: (c) => classes.delete(c),
                    toggle: (c, force) => {
                        if (force === true) classes.add(c);
                        else if (force === false) classes.delete(c);
                        else if (classes.has(c)) classes.delete(c);
                        else classes.add(c);
                    },
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
        showToast: () => {}
    };

    vm.createContext(sandbox);
    vm.runInContext(detailsCode, sandbox);

    const card = getEl('detailDeliveryHandoffCard');
    const body = getEl('detailDeliveryHandoffBody');
    const toggleBtn = getEl('btnToggleDeliveryCollapse');

    // Make modal visible via explicit open
    sandbox.openDetailDeliveryHub();
    assert.strictEqual(card.classList.contains('hidden'), false);

    // Test dismiss
    sandbox.dismissDetailDeliveryHub();
    assert.strictEqual(card.classList.contains('hidden'), true, 'Card should be hidden after dismiss');

    // Show again via openDetailDeliveryHub
    sandbox.openDetailDeliveryHub();
    assert.strictEqual(card.classList.contains('hidden'), false);

    // Test collapse toggle
    sandbox.toggleDetailDeliveryHubCollapse();
    assert.strictEqual(body.classList.contains('hidden'), true, 'Body should be collapsed/hidden');

    // Toggle again to expand
    sandbox.toggleDetailDeliveryHubCollapse();
    assert.strictEqual(body.classList.contains('hidden'), false, 'Body should be expanded');
});
