const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

function createResilienceContext() {
    const elements = {};
    const doc = {
        getElementById: (id) => {
            if (!elements[id]) {
                elements[id] = {
                    id,
                    value: '',
                    textContent: '',
                    innerHTML: '',
                    className: '',
                    style: {},
                    classList: {
                        add: () => {},
                        remove: () => {},
                        toggle: () => {},
                        contains: () => false
                    },
                    querySelector: () => null,
                    querySelectorAll: () => []
                };
            }
            return elements[id];
        },
        querySelector: (sel) => null,
        querySelectorAll: () => [],
        createElement: (tag) => ({
            tagName: tag.toUpperCase(),
            value: '',
            textContent: '',
            innerHTML: '',
            className: '',
            classList: {
                add: () => {},
                remove: () => {},
                toggle: () => {},
                contains: () => false
            },
            appendChild: () => {},
            removeChild: () => {}
        }),
        body: {
            appendChild: () => {},
            removeChild: () => {}
        }
    };

    const ctx = {
        console,
        document: doc,
        setTimeout,
        clearTimeout,
        AbortController,
        DOMException: typeof DOMException !== 'undefined' ? DOMException : undefined,
        showToast: () => {},
        remoteLog: () => {},
        localStorage: {
            getItem: () => null,
            setItem: () => {},
            removeItem: () => {}
        },
        MARKET_TONE_MAP: { 'US Market': 'direct' },
        API_BASE: 'http://127.0.0.1:9503/api',
        fetch: async () => ({ ok: true, json: async () => ({}) })
    };

    ctx.window = ctx;
    ctx.globalThis = ctx;

    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(root, 'js', 'config.js'), 'utf8'), ctx);
    vm.runInContext(fs.readFileSync(path.join(root, 'js', 'utils.js'), 'utf8'), ctx);
    vm.runInContext(fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8'), ctx);
    vm.runInContext(fs.readFileSync(path.join(root, 'js', 'details.js'), 'utf8'), ctx);

    return { ctx, elements };
}

test('generateSingleWrap preserves successful image even if SEO or DTC copy fails', async () => {
    const { ctx, elements } = createResilienceContext();

    // Set up globalGenContext with a task
    const taskId = 'mod-hero';
    const task = {
        id: taskId,
        title: 'Hero Shot',
        displayTitle: 'Hero Shot',
        prompt: 'Clean commercial product hero shot',
        negativePrompt: '',
        includeCopy: true,
        status: 'pending',
        imageSrc: ''
    };

    ctx.globalGenContext = {
        productName: 'Ergonomic Chair',
        sellingPoints: 'Lumbar support',
        primaryImage: { mimeType: 'image/png', data: 'fakebase64source' },
        config: { aspectRatio: '1:1', style: 'minimalist' },
        tasks: { [taskId]: task }
    };

    // Mock callAI:
    // "image" -> returns valid image candidate
    // "text" (used by SEO / copy) -> throws 429 Rate Limit error
    ctx.callAI = async (capability, payload, options) => {
        if (capability === 'image') {
            return {
                candidates: [{
                    content: {
                        parts: [{
                            inlineData: {
                                mimeType: 'image/webp',
                                data: 'generated_base64_image_data_success'
                            }
                        }]
                    }
                }]
            };
        }
        if (capability === 'text') {
            throw new Error('429 Too Many Requests (Simulated rate limit)');
        }
        return {};
    };

    // Mock generateSEOMetadata to reject with an unhandled exception
    ctx.generateSEOMetadata = async () => {
        throw new Error('500 SEO Generator Crashed');
    };

    // Execute generateSingleWrap for the task
    const result = await ctx.generateSingleWrap(taskId);

    // Assertions:
    // The image must NOT be dropped!
    assert.strictEqual(task.status, 'success', 'Task status should be success despite text generation failure');
    assert.match(task.imageSrc, /generated_base64_image_data_success/, 'Generated image must be preserved');
    assert.strictEqual(task.isFallback, false);
});
