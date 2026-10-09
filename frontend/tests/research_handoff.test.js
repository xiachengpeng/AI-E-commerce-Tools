const test = require('node:test');
const assert = require('node:assert/strict');

test('handoff keeps existing edits and undo never erases later edits', () => {
    const { applyDraft, undoDraft } = require('../js/research.js');
    const elements = {
        productNameInput: { value: 'Merchant name', dispatchEvent() {} },
        productFactsText: { value: 'My facts', dispatchEvent() {} }
    };
    global.document = { getElementById: id => elements[id] };
    const preview = { fields: [
        { key: 'product_name', target: 'productNameInput', value: 'Research name' },
        { key: 'material', target: 'productFactsText', value: '材质: Cotton' }
    ] };
    const result = applyDraft(preview, ['product_name', 'material'], 'details');
    assert.equal(elements.productNameInput.value, 'Merchant name');
    assert.equal(elements.productFactsText.value, 'My facts\n材质: Cotton');
    elements.productFactsText.value += '\nLater edit';
    undoDraft(result);
    assert.equal(elements.productFactsText.value, 'My facts\n材质: Cotton\nLater edit');
    delete global.document;
});

test('only accepted fields are inserted into chosen module', () => {
    const { applyDraft } = require('../js/research.js');
    const elements = { listingName: { value: '', dispatchEvent() {} }, listingPoints: { value: '', dispatchEvent() {} } };
    global.document = { getElementById: id => elements[id] };
    applyDraft({ fields: [
        { key: 'product_name', target: 'productNameInput', value: 'Pouch' },
        { key: 'material', target: 'productFactsText', value: '材质: Cotton' }
    ] }, ['product_name'], 'listing');
    assert.equal(elements.listingName.value, 'Pouch');
    assert.equal(elements.listingPoints.value, '');
    delete global.document;
});

test('display escaping cannot execute research source markup', () => {
    const { escapeHtml } = require('../js/research.js');
    assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
});


const vm = require('node:vm');
const fs = require('node:fs');
async function panelFixture() {
    const nodes = {}, handlers = {};
    const node = id => nodes[id] ||= { value: '', innerHTML: '', textContent: '', hidden: true, dataset: {},
        classList: { toggle() {} }, addEventListener(type, fn) { handlers[type] = fn; },
        querySelectorAll() { return [{ dataset: { researchField: 'material' } }]; } };
    let resolvePreview, resolveConfirmation;
    const product = { source_ref: { project_id: 'p', product_id: 'one', source_version: 1, identity_revision: 1 }, market: 'US', name: 'Pouch', facts: [], steps: [] };
    const context = { document: { getElementById: node }, AbortSignal, URL, Event, crypto: require('node:crypto'),
        fetch: async url => ({ ok: true, json: async () => {
            if (url.endsWith('/session')) return { csrf_token: 'test', enabled: true };
            if (url.endsWith('/projects')) return { projects: [], next_cursor: null };
            if (url.endsWith('/preview')) return new Promise(resolve => { resolvePreview = resolve; });
            if (url.endsWith('/confirm-fact')) return new Promise(resolve => { resolveConfirmation = resolve; });
            return { id: 'p', title: 'Travel', market: 'US', products: [product, { ...product, source_ref: { ...product.source_ref, product_id: 'two' } }] };
        } }) };
    context.window = context;
    vm.runInNewContext(fs.readFileSync(require.resolve('../js/research.js'), 'utf8'), context);
    const click = data => handlers.click({ target: { closest: () => ({ dataset: data, hasAttribute: key => key === 'data-research-preview' && data.preview }) } });
    const settle = () => new Promise(resolve => setImmediate(resolve));
    await context.ResearchPanel.init(); click({ researchProject: 'p' }); await settle(); click({ researchProduct: 'one' });
    return { context, node, click, settle, resolve: value => resolvePreview(value),
        resolveConfirmation: value => resolveConfirmation(value), submit: form => handlers.submit({ preventDefault() {}, target: form }) };
}

test('late handoff response cannot fill a different selected product', async () => {
    const f = await panelFixture();
    f.click({ researchApply: 'details' }); await f.settle();
    f.click({ researchProduct: 'two' });
    f.resolve({ fields: [{ key: 'material', target: 'productFactsText', value: 'First product cotton' }] });
    await f.settle();
    assert.equal(f.node('productFactsText').value, '');
});

test('late preview response cannot render after leaving research view', async () => {
    const f = await panelFixture();
    f.click({ preview: true }); await f.settle();
    f.context.ResearchPanel.suspend();
    f.resolve({ fields: [{ key: 'material', target: 'productFactsText', label: 'Material', value: 'Cotton' }], blocked_count: 0 });
    await f.settle();
    assert.equal(f.node('researchPreview').innerHTML, '');
});

test('late confirmation cannot reset a newly edited form after reselection', async () => {
    const f = await panelFixture();
    f.submit({ id: 'researchConfirmForm', elements: { own_product: { checked: true }, key: { value: 'material' },
        value: { value: 'Cotton' }, source_url: { value: 'https://example.com/p' } }, querySelector() { return { disabled: false }; } });
    await f.settle();
    f.click({ researchProduct: 'two' }); f.click({ researchProduct: 'one' });
    f.node('researchProductDetail').innerHTML = 'New form with user edits';
    f.resolveConfirmation({}); await f.settle();
    assert.equal(f.node('researchProductDetail').innerHTML, 'New form with user edits');
});
