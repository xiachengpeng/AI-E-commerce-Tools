const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const htmlPath = path.resolve(__dirname, '..', 'index.html');
const htmlContent = fs.readFileSync(htmlPath, 'utf8');

test('index.html replaces static quick model pills with fetch models button and model select dropdowns', () => {
    // 1. Static pills must be completely eliminated
    assert.doesNotMatch(
        htmlContent,
        /id="settingsTextModelQuickPills"/,
        'index.html should no longer have #settingsTextModelQuickPills'
    );
    assert.doesNotMatch(
        htmlContent,
        /id="settingsImageModelQuickPills"/,
        'index.html should no longer have #settingsImageModelQuickPills'
    );

    // 2. Fetch models button and select dropdowns must exist
    assert.match(htmlContent, /id="settingsFetchModelsBtn"/);
    assert.match(htmlContent, /id="settingsTextModelSelect"/);
    assert.match(htmlContent, /id="settingsImageModelSelect"/);
});

test('populateModelSelectDropdown populates options and unhides select element', () => {
    const { populateModelSelectDropdown } = require('../js/settings.js');
    assert.equal(typeof populateModelSelectDropdown, 'function');

    const mockSelect = {
        innerHTML: '',
        classList: {
            classes: new Set(['hidden']),
            add: (c) => mockSelect.classList.classes.add(c),
            remove: (c) => mockSelect.classList.classes.delete(c),
            contains: (c) => mockSelect.classList.classes.has(c),
        }
    };

    const models = ['gpt-4o', 'claude-3-5-sonnet', 'dall-e-3'];
    populateModelSelectDropdown(mockSelect, models, '-- 选择已获取的模型 --');

    assert.equal(mockSelect.classList.contains('hidden'), false);
    assert.match(mockSelect.innerHTML, /共 3 个/);
    assert.match(mockSelect.innerHTML, /<option value="gpt-4o">gpt-4o<\/option>/);
    assert.match(mockSelect.innerHTML, /<option value="claude-3-5-sonnet">claude-3-5-sonnet<\/option>/);
});

test('onModelSelectChange sets model input value and triggers update event', () => {
    const settingsJs = fs.readFileSync(path.resolve(__dirname, '..', 'js', 'settings.js'), 'utf8');

    const elements = {};
    const getEl = (id) => {
        if (!elements[id]) {
            elements[id] = {
                value: '',
                dispatchEvent: () => {}
            };
        }
        return elements[id];
    };

    const context = {
        window: {
            addEventListener: () => {}
        },
        document: {
            addEventListener: () => {},
            getElementById: (id) => getEl(id)
        },
        settingsState: {
            providers: [],
            capabilityBindings: []
        },
        Event: class {}
    };

    const vm = require('node:vm');
    vm.createContext(context);
    vm.runInContext(settingsJs, context);

    assert.equal(typeof context.onModelSelectChange, 'function', 'onModelSelectChange must be defined');

    // 1. Text model
    context.onModelSelectChange('text', 'claude-3-5-sonnet');
    assert.equal(getEl('settingsTextModel').value, 'claude-3-5-sonnet');

    // 2. Image model
    context.onModelSelectChange('image', 'flux-1-schnell');
    assert.equal(getEl('settingsImageModel').value, 'flux-1-schnell');
});
