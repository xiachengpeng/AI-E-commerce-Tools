const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function createDtcTestContext() {
    const documentMock = {
        getElementById: (id) => null,
        querySelectorAll: () => [],
        createElement: () => ({ setAttribute: () => {}, appendChild: () => {} }),
        body: { appendChild: () => {}, removeChild: () => {} }
    };
    const ctx = {
        console,
        window: {
            addEventListener: () => {},
            localStorage: {
                getItem: () => null,
                setItem: () => {},
                removeItem: () => {}
            }
        },
        document: documentMock,
        navigator: { clipboard: { writeText: async () => {} } },
        showToast: () => {},
        openImageLightbox: () => {},
        openModuleImagePicker: () => {},
        generateSingleWrap: () => {},
        retryTaskAuxiliaryStep: () => {},
        copyDtcSectionHtml: () => {}
    };
    ctx.window.document = documentMock;
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(root, 'js', 'config.js'), 'utf8'), ctx);
    vm.runInContext(fs.readFileSync(path.join(root, 'js', 'details.js'), 'utf8'), ctx);
    return ctx;
}

test('Task 3: renderDtcStepsSection renders image plate when task.imageSrc is present', () => {
    const ctx = createDtcTestContext();
    const stepTasksWithImg = [{
        id: 'm12',
        uniqueId: 'm12_0',
        title: '使用流程',
        imageSrc: 'https://example.com/step_guide.jpg',
        dtcCopy: {
            headline: 'Simple 3-Step Setup',
            tagline: 'HOW IT WORKS',
            steps: [
                { step: 1, title: 'Unpack', instruction: 'Remove all components' },
                { step: 2, title: 'Plug in', instruction: 'Connect power' }
            ]
        }
    }];

    const html = ctx.renderDtcStepsSection(stepTasksWithImg, false, 'editorial');
    assert.ok(html.includes('https://example.com/step_guide.jpg'), 'renderDtcStepsSection must render task.imageSrc');
    assert.ok(html.includes('Simple 3-Step Setup'), 'renderDtcStepsSection must render headline');
    assert.ok(html.includes('Unpack'), 'renderDtcStepsSection must render steps');
});

test('Task 3: renderDtcSpecsSection renders image plate when task.imageSrc is present', () => {
    const ctx = createDtcTestContext();
    const specsTasksWithImg = [{
        id: 'm10',
        uniqueId: 'm10_0',
        title: '详细规格表',
        imageSrc: 'https://example.com/spec_diagram.jpg',
        dtcCopy: {
            headline: 'Specifications & Dimensions',
            tagline: 'PRECISE SPECS',
            specifications: [
                { label: 'Weight', value: '1.2kg' }
            ],
            packageIncludes: ['Main unit', 'Power cable']
        }
    }];

    const html = ctx.renderDtcSpecsSection(specsTasksWithImg, false, 'editorial');
    assert.ok(html.includes('https://example.com/spec_diagram.jpg'), 'renderDtcSpecsSection must render task.imageSrc');
    assert.ok(html.includes('Weight'), 'renderDtcSpecsSection must render specifications');
});

test('Task 3: renderDtcFaqSection renders image plate when task.imageSrc is present', () => {
    const ctx = createDtcTestContext();
    const faqTasksWithImg = [{
        id: 'm11',
        uniqueId: 'm11_0',
        title: '常见疑问',
        imageSrc: 'https://example.com/faq_support.jpg',
        dtcCopy: {
            faqs: [
                { q: 'Is it waterproof?', a: 'Yes, IPX4 rated.' }
            ]
        }
    }];

    const html = ctx.renderDtcFaqSection(faqTasksWithImg, false, 'editorial');
    assert.ok(html.includes('https://example.com/faq_support.jpg'), 'renderDtcFaqSection must render task.imageSrc');
    assert.ok(html.includes('Is it waterproof?'), 'renderDtcFaqSection must render questions');
});

test('Task 4: renderDtcSpecsSection never renders [object Object] when facts contain object entries', () => {
    const ctx = createDtcTestContext();
    const specsTask = [{
        id: 'm10',
        uniqueId: 'm10_0',
        title: '详细规格表',
        imageSrc: '',
        productFacts: {
            material: { value: 'Aviation Aluminum', verified: true, source: 'user' },
            dimensions: { value: '', verified: false, source: 'unknown' },
            weight: { value: '2.5 kg', verified: true, source: 'user' },
            color: { value: '', verified: false, source: 'unknown' }
        },
        dtcCopy: {
            headline: 'Product Specifications',
            specifications: [] // Empty AI specs, triggers fallback to productFacts
        }
    }];

    const html = ctx.renderDtcSpecsSection(specsTask, false, 'editorial');
    assert.ok(!html.includes('[object Object]'), 'Output MUST NEVER contain [object Object]');
    assert.ok(html.includes('Aviation Aluminum'), 'Verified material string value must be rendered');
    assert.ok(html.includes('2.5 kg'), 'Verified weight string value must be rendered');
    assert.ok(!html.includes('Color'), 'Empty color fact must not be rendered');
});

test('Task 5: DTC layout does not render offer stack or risk reversal when not verified or active', () => {
    const ctx = createDtcTestContext();
    const fbrTasks = [{
        id: 'm1',
        uniqueId: 'm1_0',
        title: '首屏视觉',
        imageSrc: 'https://example.com/hero.jpg',
        dtcCopy: { headline: 'Hero Headline', body: 'Hero body' }
    }];
    const stepTasks = [];
    const specsTasks = [];
    const bundleBoxTasks = [];
    const bundleSavingsTasks = [];
    const faqTasks = [];

    // When no bundle tasks and no verified guarantee exist, offer stack and risk reversal must NOT be rendered
    const editorialHtml = ctx.renderEditorialLayout(fbrTasks, stepTasks, specsTasks, bundleBoxTasks, bundleSavingsTasks, faqTasks, false, true);
    assert.ok(!editorialHtml.includes('data-section="offer-stack"'), 'Editorial layout should not render offer-stack when no bundle tasks');
    assert.ok(!editorialHtml.includes('data-section="risk-reversal"'), 'Editorial layout should not render risk-reversal when not verified');

    const minimalistHtml = ctx.renderMinimalistLayout(fbrTasks, stepTasks, specsTasks, bundleBoxTasks, bundleSavingsTasks, faqTasks, false, true);
    assert.ok(!minimalistHtml.includes('data-section="offer-stack"'), 'Minimalist layout should not render offer-stack when no bundle tasks');
    assert.ok(!minimalistHtml.includes('data-section="risk-reversal"'), 'Minimalist layout should not render risk-reversal when not verified');
});
