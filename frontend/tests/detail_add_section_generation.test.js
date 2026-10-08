const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const detailsPath = path.join(__dirname, '..', 'js', 'details.js');
const detailsCode = fs.readFileSync(detailsPath, 'utf8');

function createSandbox(initialContext = {}) {
    const elements = new Map();
    // Standard pre-existing elements
    const standardIds = new Set([
        'sectionTreeContainer',
        'selectNewSectionModule',
        'dtcHybridContainer',
        'sectionInspectorPanel',
        'modulesResultContainer',
        'productName',
        'sellingPoints',
        'languageSelect',
        'aspectRatioSelect'
    ]);

    const createElementMock = (id) => {
        const classes = new Set(['hidden']);
        return {
            id,
            value: '',
            textContent: '',
            innerHTML: '',
            style: {},
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
            },
            appendChild: (child) => {},
            querySelectorAll: () => [],
            querySelector: () => null,
            scrollIntoView: () => {}
        };
    };

    standardIds.forEach(id => {
        elements.set(id, createElementMock(id));
    });

    const getEl = (id) => {
        return elements.get(id) || null;
    };

    let aiCallPayload = null;
    let aiCapability = null;

    const sandbox = {
        console,
        setTimeout,
        clearTimeout,
        window: {},
        globalThis: {},
        document: {
            getElementById: getEl,
            createElement: (tag) => createElementMock('dynamic_' + tag),
            querySelectorAll: () => [],
            querySelector: () => null,
            addEventListener: () => {}
        },
        showToast: () => {},
        remoteLog: () => {},
        currentDetailPresentationMode: 'hybrid',
        currentDetailResultView: 'hybrid',
        currentUploadedImages: [
            { id: 'img1', name: 'main.png', mimeType: 'image/png', data: 'AQIDBA==', base64: 'data:image/png;base64,AQIDBA==', isPrimary: true, role: 'primary' }
        ],
        MODULES_CONFIG: [
            { id: 'm3', title: '场景/痛点唤醒', subtitle: '展示真实使用需求', prompt: 'Create a believable lifestyle usage scene.', includeText: true },
            { id: 'm6', title: '细节/材质证明', subtitle: '放大关键做工', prompt: 'Create a macro close-up shot highlighting the premium material.', includeText: true }
        ],
        callAI: async (capability, payload) => {
            aiCapability = capability;
            aiCallPayload = payload;
            if (capability === 'image') {
                return {
                    candidates: [{
                        content: {
                            parts: [{
                                inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' }
                            }]
                        }
                    }]
                };
            }
            return { candidates: [{ content: { parts: [{ text: 'Mock response' }] } }] };
        },
        getAIHistory: () => ({ aiCapability, aiCallPayload }),
        ...initialContext
    };

    vm.createContext(sandbox);
    vm.runInContext(detailsCode, sandbox);
    return sandbox;
}

test('generateSingleWrap runs and generates image even when content-mod div is not in DOM', async () => {
    const sandbox = createSandbox();

    const taskId = 'm3_test_1';
    const task = {
        id: 'm3',
        uniqueId: taskId,
        title: '场景/痛点唤醒',
        displayTitle: '场景/痛点唤醒',
        prompt: 'Create a believable lifestyle usage scene.',
        includeText: false,
        status: 'pending',
        subStatus: { overall: 'pending', image: 'pending', copy: 'pending', seo: 'pending' }
    };

    sandbox.globalGenContext = {
        tasks: { [taskId]: task },
        longImageOrder: [taskId],
        sellingPoints: 'Comfortable ergonomic chair',
        config: { aspectRatio: '1:1', language: 'English' },
        uploadedImages: sandbox.currentUploadedImages
    };

    // Notice: content-mod-m3_test_1 is NOT in document.getElementById!
    const result = await sandbox.generateSingleWrap(taskId, true, '', null);

    assert.ok(result, 'generateSingleWrap should not abort with undefined');
    assert.strictEqual(task.status, 'success', 'Task status should be success after generation');
    assert.ok(task.imageSrc && task.imageSrc.startsWith('data:image/'), 'Task should have valid imageSrc');
    assert.strictEqual(task.subStatus.image, 'success', 'Image subStatus should be success');
});

test('addNewSectionFromTree initializes task prompt, handles hybrid mode includeText, and triggers generation', async () => {
    const sandbox = createSandbox();

    sandbox.globalGenContext = {
        tasks: {},
        longImageOrder: [],
        sellingPoints: 'Smart temperature control mug',
        config: { aspectRatio: '1:1', language: 'English' },
        uploadedImages: sandbox.currentUploadedImages,
        productFacts: {
            category: { value: 'Drinkware', verified: true }
        }
    };

    const addedTask = await sandbox.addNewSectionFromTree('m3');

    assert.ok(addedTask, 'Task must be returned');
    assert.strictEqual(addedTask.id, 'm3');
    assert.ok(addedTask.prompt && addedTask.prompt.length > 0, 'Added task must inherit prompt from MODULES_CONFIG');
    assert.strictEqual(addedTask.includeText, false, 'In hybrid mode, includeText should be false');
    assert.ok(sandbox.globalGenContext.longImageOrder.includes(addedTask.uniqueId), 'Task must be added to longImageOrder');
});

test('renderDtcImagePlate renders loading state when task is loading instead of image generation failed', () => {
    const sandbox = createSandbox();

    const taskId = 'm3_loading_task';
    sandbox.globalGenContext = {
        tasks: {
            [taskId]: {
                id: 'm3',
                uniqueId: taskId,
                status: 'loading',
                subStatus: { image: 'running' }
            }
        }
    };

    const html = sandbox.renderDtcImagePlate('', 'Lifestyle Scene', false, 'aspect-square', 'rounded-2xl', '', taskId);

    assert.ok(!html.includes('Image generation failed'), 'Should not display "Image generation failed" while loading');
    assert.ok(html.includes('animate-spin') || html.includes('animate-pulse') || html.includes('loader'), 'Should display loading indicator');
});
