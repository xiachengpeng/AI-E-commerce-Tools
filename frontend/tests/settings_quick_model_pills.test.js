const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const htmlPath = path.resolve(__dirname, '..', 'index.html');
const htmlContent = fs.readFileSync(htmlPath, 'utf8');

test('index.html contains quick model pill containers in provider modal', () => {
    assert.match(
        htmlContent,
        /id="settingsTextModelQuickPills"/,
        'index.html should have #settingsTextModelQuickPills'
    );
    assert.match(
        htmlContent,
        /id="settingsImageModelQuickPills"/,
        'index.html should have #settingsImageModelQuickPills'
    );
});

test('renderProviderQuickModelPills renders appropriate model pills for protocol', () => {
    const settingsJs = fs.readFileSync(path.resolve(__dirname, '..', 'js', 'settings.js'), 'utf8');

    const elements = {};
    const getEl = (id) => {
        if (!elements[id]) {
            elements[id] = {
                value: '',
                textContent: '',
                innerHTML: '',
                classList: {
                    add: () => {},
                    remove: () => {},
                    toggle: () => {}
                }
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
        }
    };

    const vm = require('node:vm');
    vm.createContext(context);
    vm.runInContext(settingsJs, context);

    assert.equal(typeof context.renderProviderQuickModelPills, 'function', 'renderProviderQuickModelPills must be defined');

    // Test Gemini protocol pills
    context.renderProviderQuickModelPills('gemini');
    const textPillsGemini = getEl('settingsTextModelQuickPills').innerHTML;
    assert.match(textPillsGemini, /gemini-2\.5-flash/, 'Gemini should offer gemini-2.5-flash pill');
    assert.match(textPillsGemini, /gemini-2\.5-pro/, 'Gemini should offer gemini-2.5-pro pill');

    // Test OpenAI compatible protocol pills
    context.renderProviderQuickModelPills('openai_compatible');
    const textPillsOpenAI = getEl('settingsTextModelQuickPills').innerHTML;
    assert.match(textPillsOpenAI, /gpt-4o/, 'OpenAI compatible should offer gpt-4o pill');
    assert.match(textPillsOpenAI, /gpt-4o-mini/, 'OpenAI compatible should offer gpt-4o-mini pill');
});

test('applyQuickModelPill sets input value and triggers update', () => {
    const settingsJs = fs.readFileSync(path.resolve(__dirname, '..', 'js', 'settings.js'), 'utf8');

    const elements = {};
    const getEl = (id) => {
        if (!elements[id]) {
            elements[id] = {
                value: '',
                textContent: '',
                innerHTML: '',
                classList: {
                    add: () => {},
                    remove: () => {},
                    toggle: () => {}
                }
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
        }
    };

    const vm = require('node:vm');
    vm.createContext(context);
    vm.runInContext(settingsJs, context);

    assert.equal(typeof context.applyQuickModelPill, 'function', 'applyQuickModelPill must be defined');

    context.applyQuickModelPill('text', 'gemini-2.5-flash');
    assert.equal(getEl('settingsTextModel').value, 'gemini-2.5-flash', 'settingsTextModel value should be set');

    context.applyQuickModelPill('image', 'dall-e-3');
    assert.equal(getEl('settingsImageModel').value, 'dall-e-3', 'settingsImageModel value should be set');
});
