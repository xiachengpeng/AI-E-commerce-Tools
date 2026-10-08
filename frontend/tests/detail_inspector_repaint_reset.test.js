const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const detailsPath = path.join(__dirname, '..', 'js', 'details.js');
const detailsCode = fs.readFileSync(detailsPath, 'utf8');

function createSandbox(initialContext = {}) {
    const elements = new Map();
    const standardIds = [
        'sectionTreeContainer',
        'selectNewSectionModule',
        'dtcHybridContainer',
        'sectionInspectorPanel',
        'modulesResultContainer',
        'productName',
        'sellingPoints',
        'languageSelect',
        'aspectRatioSelect',
        'inspectorRepaintPrompt'
    ];

    const createElementMock = (id) => {
        const classes = new Set();
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
            focus: () => {}
        };
    };

    standardIds.forEach(id => {
        elements.set(id, createElementMock(id));
    });

    const getEl = (id) => elements.get(id) || null;

    let aiCallHistory = [];

    const sandbox = {
        console,
        setTimeout,
        clearTimeout,
        window: {},
        globalThis: {},
        document: {
            getElementById: getEl,
            createElement: (tag) => createElementMock('dyn_' + tag),
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
            { id: 'm5', title: '生活方式氛围', subtitle: '场景展示', prompt: 'Cozy living room lifestyle scene.', includeText: false }
        ],
        callAI: async (capability, payload) => {
            aiCallHistory.push({ capability, payload });
            if (capability === 'image') {
                return {
                    candidates: [{
                        content: {
                            parts: [{
                                inlineData: {
                                    mimeType: 'image/png',
                                    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
                                }
                            }]
                        }
                    }]
                };
            }
            return { candidates: [{ content: { parts: [{ text: 'Mock AI text' }] } }] };
        },
        getAiCallHistory: () => aiCallHistory,
        clearAiCallHistory: () => { aiCallHistory = []; },
        ...initialContext
    };

    vm.createContext(sandbox);
    vm.runInContext(detailsCode, sandbox);
    return sandbox;
}

test('executeInspectorTaskRepaint regenerates task with custom prompt even if task is currently success', async () => {
    const sandbox = createSandbox();

    const taskId = 'm5_0';
    const task = {
        id: 'm5',
        uniqueId: taskId,
        title: '生活方式氛围',
        displayTitle: '生活方式氛围 M5_0',
        prompt: 'Cozy living room lifestyle scene.',
        imageSrc: 'data:image/png;base64,initialImage123',
        imageUrl: 'data:image/png;base64,initialImage123',
        status: 'success', // Notice: already success, NOT failed!
        subStatus: { overall: 'success', image: 'success', copy: 'idle', seo: 'idle' }
    };

    sandbox.globalGenContext = {
        tasks: { [taskId]: task },
        longImageOrder: [taskId],
        sellingPoints: 'Cozy modern home furniture',
        config: { aspectRatio: '1:1', language: 'English' },
        uploadedImages: sandbox.currentUploadedImages
    };

    // Set active inspector task
    sandbox.setActiveInspectorTask(taskId);

    // Set custom prompt in inspector
    const promptInput = sandbox.document.getElementById('inspectorRepaintPrompt');
    promptInput.value = 'warm Scandinavian interior, subtle cozy home ambient setting';

    // Execute repaint
    await sandbox.executeInspectorTaskRepaint(taskId);

    // Verify task was regenerated
    assert.strictEqual(task.status, 'success');
    assert.strictEqual(task.repaintPrompt, 'warm Scandinavian interior, subtle cozy home ambient setting');

    // Verify AI image was called with repaint rule in prompt
    const aiHistory = sandbox.getAiCallHistory();
    const imageCall = aiHistory.find(h => h.capability === 'image');
    assert.ok(imageCall, 'AI image generation must be called');
    const promptText = imageCall.payload.contents[0].parts[0].text;
    assert.ok(promptText.includes('warm Scandinavian interior'), 'Repaint instruction must be included in prompt payload');

    // Verify version rollback history was recorded
    assert.ok(Array.isArray(task.imageVersions), 'imageVersions array must exist');
    assert.strictEqual(task.imageVersions.length, 1, 'Previous image must be saved in imageVersions');
    assert.strictEqual(task.imageVersions[0].imageUrl, 'data:image/png;base64,initialImage123');
});

test('resetAndRegenerateInspectorTask clears repaint prompt and regenerates cleanly', async () => {
    const sandbox = createSandbox();

    const taskId = 'm5_0';
    const task = {
        id: 'm5',
        uniqueId: taskId,
        title: '生活方式氛围',
        displayTitle: '生活方式氛围 M5_0',
        prompt: 'Cozy living room lifestyle scene.',
        repaintPrompt: 'some previous custom adjustment',
        imageSrc: 'data:image/png;base64,prevImage',
        imageUrl: 'data:image/png;base64,prevImage',
        status: 'success',
        subStatus: { overall: 'success', image: 'success', copy: 'idle', seo: 'idle' }
    };

    sandbox.globalGenContext = {
        tasks: { [taskId]: task },
        longImageOrder: [taskId],
        sellingPoints: 'Cozy modern home furniture',
        config: { aspectRatio: '1:1', language: 'English' },
        uploadedImages: sandbox.currentUploadedImages
    };

    sandbox.setActiveInspectorTask(taskId);
    const promptInput = sandbox.document.getElementById('inspectorRepaintPrompt');
    promptInput.value = 'some previous custom adjustment';

    // Reset and regenerate
    await sandbox.resetAndRegenerateInspectorTask(taskId);

    assert.strictEqual(task.repaintPrompt, undefined, 'repaintPrompt must be deleted');
    assert.strictEqual(promptInput.value, '', 'Input must be cleared');

    const aiHistory = sandbox.getAiCallHistory();
    const imageCall = aiHistory.find(h => h.capability === 'image');
    assert.ok(imageCall, 'AI image generation must be called');
    const promptText = imageCall.payload.contents[0].parts[0].text;
    assert.ok(!promptText.includes('User repaint instruction'), 'Clean prompt must not contain repaint instruction');
});

test('rollbackTaskImageVersion swaps current and target versions and syncs imageSrc and imageUrl', () => {
    const sandbox = createSandbox();

    const taskId = 'm5_0';
    const task = {
        id: 'm5',
        uniqueId: taskId,
        imageSrc: 'data:image/png;base64,version2',
        imageUrl: 'data:image/png;base64,version2',
        repaintPrompt: 'v2 prompt',
        imageVersions: [
            {
                versionId: 'ver_1',
                imageUrl: 'data:image/png;base64,version1',
                promptAdjustment: 'v1 prompt',
                createdAt: 1000
            }
        ]
    };

    sandbox.globalGenContext = {
        tasks: { [taskId]: task },
        longImageOrder: [taskId]
    };

    const result = sandbox.rollbackTaskImageVersion(taskId, 'ver_1');
    assert.strictEqual(result, true, 'Rollback should succeed');
    assert.strictEqual(task.imageSrc, 'data:image/png;base64,version1', 'task.imageSrc must be updated to version 1');
    assert.strictEqual(task.imageUrl, 'data:image/png;base64,version1', 'task.imageUrl must be updated to version 1');
    assert.strictEqual(task.imageVersions[0].imageUrl, 'data:image/png;base64,version2', 'Old current image must be swapped into imageVersions');
});

test('renderSectionInspector renders image preview from imageSrc, uses executeInspectorTaskRepaint, and provides reset controls', () => {
    const sandbox = createSandbox();

    const taskId = 'm5_0';
    const task = {
        id: 'm5',
        uniqueId: taskId,
        title: '生活方式氛围',
        displayTitle: '生活方式氛围 M5_0',
        imageSrc: 'data:image/png;base64,generatedSrcOnly', // Notice: only imageSrc, no imageUrl
        status: 'success',
        subStatus: { overall: 'success', image: 'success' },
        dtcCopy: { headline: 'Test Headline' }
    };

    sandbox.globalGenContext = {
        tasks: { [taskId]: task },
        longImageOrder: [taskId]
    };

    sandbox.setActiveInspectorTask(taskId);

    const panel = sandbox.document.getElementById('sectionInspectorPanel');
    const html = panel.innerHTML;

    // Image preview must be rendered
    assert.ok(html.includes('data:image/png;base64,generatedSrcOnly'), 'Inspector must render image from imageSrc');
    assert.ok(!html.includes('未出图'), 'Should not display 未出图 when imageSrc is present');

    // Button must call executeInspectorTaskRepaint, NOT retryFailedModuleImages
    assert.ok(html.includes('executeInspectorTaskRepaint'), 'Inspector must call executeInspectorTaskRepaint');
    assert.ok(!html.includes('retryFailedModuleImages'), 'Inspector must not call retryFailedModuleImages');

    // Must provide reset controls
    assert.ok(html.includes('resetAndRegenerateInspectorTask'), 'Must provide resetAndRegenerate button');
    assert.ok(html.includes('resetInspectorRepaintPrompt'), 'Must provide resetInspectorRepaintPrompt button');
});
