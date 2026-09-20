const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const htmlPath = path.resolve(__dirname, '..', 'index.html');
const htmlContent = fs.readFileSync(htmlPath, 'utf8');

test('index.html eliminates hardcoded Gemini Active text and provides dynamic engine status', () => {
    assert.doesNotMatch(
        htmlContent,
        /Gemini\s+Active/i,
        'index.html should not have hardcoded Gemini Active text'
    );
    assert.match(
        htmlContent,
        /id="transEngineStatus"[^>]*>[\s\S]*?AI 翻译引擎就绪/,
        'index.html must have #transEngineStatus indicating ready state'
    );
});

test('transEmptyState clearly explains image translation instead of mere watermark removal', () => {
    const emptyStateMatch = htmlContent.match(/id="transEmptyState"[\s\S]*?<\/div>\s*<\/div>/);
    assert.ok(emptyStateMatch, 'transEmptyState must exist in index.html');
    const emptyStateHtml = emptyStateMatch[0];

    assert.match(emptyStateHtml, /翻译/, 'Empty state must explain translation');
    assert.match(emptyStateHtml, /目标语言|多语言/, 'Empty state must mention target language or multilingual output');
});

test('langDropdownMenu includes region language preset buttons', () => {
    assert.match(
        htmlContent,
        /applyQuickLangPreset\(['"]western['"]\)/,
        'index.html should have a preset button for Western languages'
    );
    assert.match(
        htmlContent,
        /applyQuickLangPreset\(['"]east_asia['"]\)/,
        'index.html should have a preset button for East Asia languages'
    );
});

test('applyQuickLangPreset updates checkboxes and labels correctly', () => {
    // Mock minimal DOM environment
    const { JSDOM } = require('node:util');
    const languagesJs = fs.readFileSync(path.resolve(__dirname, '..', 'js', 'languages.js'), 'utf8');
    const translateJs = fs.readFileSync(path.resolve(__dirname, '..', 'js', 'translate.js'), 'utf8');

    // Run in isolated context
    const context = {
        window: {
            addEventListener: () => {}
        },
        document: {
            addEventListener: () => {}
        }
    };

    const vm = require('node:vm');
    vm.createContext(context);
    vm.runInContext(languagesJs, context);

    // Setup DOM elements in context
    const elements = {};
    const checkboxes = {};

    context.TRANS_LANG_OPTIONS.forEach(opt => {
        checkboxes[opt.value] = { value: opt.value, checked: false };
    });

    context.document.querySelectorAll = (selector) => {
        if (selector === '#transLangTags input[type=checkbox]') {
            return Object.values(checkboxes);
        }
        if (selector === '#transLangTags input[type=checkbox]:checked') {
            return Object.values(checkboxes).filter(c => c.checked);
        }
        return [];
    };

    context.document.getElementById = (id) => {
        if (!elements[id]) {
            elements[id] = { textContent: '', innerHTML: '', classList: { add: () => {}, remove: () => {} } };
        }
        return elements[id];
    };

    vm.runInContext(translateJs, context);

    assert.equal(typeof context.applyQuickLangPreset, 'function', 'applyQuickLangPreset must be defined');

    // Test western preset
    context.applyQuickLangPreset('western');
    assert.equal(checkboxes['English'].checked, true, 'English should be checked in western preset');
    assert.equal(checkboxes['German'].checked, true, 'German should be checked in western preset');
    assert.equal(checkboxes['French'].checked, true, 'French should be checked in western preset');
    assert.equal(checkboxes['Japanese'].checked, false, 'Japanese should not be checked in western preset');

    // Test east_asia preset
    context.applyQuickLangPreset('east_asia');
    assert.equal(checkboxes['Japanese'].checked, true, 'Japanese should be checked in east_asia preset');
    assert.equal(checkboxes['Korean'].checked, true, 'Korean should be checked in east_asia preset');
    assert.equal(checkboxes['German'].checked, false, 'German should not be checked in east_asia preset');
});
