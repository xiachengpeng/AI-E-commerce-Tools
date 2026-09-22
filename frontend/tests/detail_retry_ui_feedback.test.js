const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

function createDetailsTestContext() {
    const ctx = {
        console,
        setTimeout: (fn) => { fn(); return 1; },
        clearTimeout: () => {},
        AbortController,
        MODULES_CONFIG: [
            { id: 'm1', name: 'Hero', riskLevel: 'low', evidenceRequirements: [] }
        ],
        MODULE_PRESETS: {},
        API_BASE: 'http://127.0.0.1:9503',
        remoteLog: () => {},
        showToast: () => {},
        CONCURRENCY_LIMIT: 2,
        STAGGER_DELAY: 100,
        localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
        document: {
            elements: {},
            getElementById(id) {
                if (!this.elements[id]) {
                    this.elements[id] = {
                        id,
                        innerHTML: '',
                        innerText: '',
                        textContent: '',
                        classList: {
                            classes: new Set(),
                            add(...c) { c.forEach(item => this.classes.add(item)); },
                            remove(...c) { c.forEach(item => this.classes.delete(item)); },
                            contains(c) { return this.classes.has(c); }
                        },
                        style: {},
                        dataset: {},
                        children: [],
                        appendChild(child) {
                            this.children.push(child);
                            return child;
                        },
                        querySelector(sel) {
                            if (sel === '.detail-retry-notice') {
                                return this.children.find(c => c.className && c.className.includes('detail-retry-notice')) || null;
                            }
                            if (sel === '.detail-error-message') {
                                return { textContent: this.innerHTML };
                            }
                            return null;
                        },
                        querySelectorAll() { return []; }
                    };
                }
                return this.elements[id];
            },
            querySelectorAll: () => [],
            createElement(tag) {
                return {
                    tagName: tag.toUpperCase(),
                    className: '',
                    innerHTML: '',
                    textContent: '',
                    style: {},
                    children: [],
                    appendChild(child) {
                        this.children.push(child);
                        return child;
                    }
                };
            }
        },
        window: {},
        globalThis: {}
    };

    ctx.window = ctx;
    ctx.globalThis = ctx;

    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(root, 'js', 'config.js'), 'utf8'), ctx);
    vm.runInContext(fs.readFileSync(path.join(root, 'js', 'utils.js'), 'utf8'), ctx);
    vm.runInContext('remoteLog = () => {}', ctx);
    vm.runInContext(fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8'), ctx);
    vm.runInContext(fs.readFileSync(path.join(root, 'js', 'details.js'), 'utf8'), ctx);

    return ctx;
}

test('formatFriendlyDetailErrorMessage formats errors without exposing raw stack traces', () => {
    const ctx = createDetailsTestContext();
    assert.strictEqual(typeof ctx.formatFriendlyDetailErrorMessage, 'function', 'Must export formatFriendlyDetailErrorMessage');

    // 401
    const err401 = ctx.formatFriendlyDetailErrorMessage(new Error('AI 提供商鉴权失败 (401)：API Key 无效或过期'));
    assert.match(err401, /401/);
    assert.match(err401, /API Key/);

    // 429
    const err429 = ctx.formatFriendlyDetailErrorMessage(new Error('Rate limit exceeded: 429 Too Many Requests'));
    assert.match(err429, /429/);
    assert.match(err429, /频繁或额度不足/);

    // 503 / timeout
    const err503 = ctx.formatFriendlyDetailErrorMessage(new Error("Client error '503 Service Unavailable' for url 'https://api.openai.com/v1'"));
    assert.doesNotMatch(err503, /https:\/\//, 'Must not expose raw upstream URL');
    assert.match(err503, /上游 AI 服务繁忙/);

    // Raw python traceback
    const rawTraceback = `Traceback (most recent call last):\n  File "/app/backend/services/ai_adapters.py", line 630, in generate\nValueError: failed`;
    const cleaned = ctx.formatFriendlyDetailErrorMessage(new Error(rawTraceback));
    assert.doesNotMatch(cleaned, /Traceback/);
    assert.doesNotMatch(cleaned, /ai_adapters\.py/);
});

test('handleDetailAIRetryEvent updates card DOM with real-time retry feedback', () => {
    const ctx = createDetailsTestContext();
    assert.strictEqual(typeof ctx.handleDetailAIRetryEvent, 'function', 'Must export handleDetailAIRetryEvent');

    // Setup globalGenContext tasks
    const taskId = 'task-hero-m1';
    ctx.globalGenContext = {
        tasks: {
            [taskId]: {
                id: 'm1',
                uniqueId: taskId,
                title: '主图/首屏海报',
                clientOperationKey: 'op-initial-123',
                status: 'running'
            }
        }
    };

    // Pre-populate content card in DOM
    const cardEl = ctx.document.getElementById(`content-mod-${taskId}`);
    cardEl.innerHTML = `<span>AI引擎构图中...</span>`;

    // Dispatch retry event from backend
    ctx.handleDetailAIRetryEvent({
        event: 'ai_retry',
        message: {
            operation_id: 'op-initial-123',
            status_text: '接口响应异常，正在自动重试（1/3）',
            attempt: 1,
            max_attempts: 4
        }
    });

    const task = ctx.globalGenContext.tasks[taskId];
    assert.strictEqual(task.retryStatusText, '接口响应异常，正在自动重试（1/3）');
    assert.strictEqual(task.retryAttempt, 1);

    const retryNotice = cardEl.querySelector('.detail-retry-notice');
    assert.ok(retryNotice, 'Card DOM must contain .detail-retry-notice element');
    assert.match(retryNotice.innerHTML, /接口响应异常，正在自动重试（1\/3）/);
});

test('retrySingleModuleTask preserves clientOperationKey while regenerateSingleModuleTask creates fresh key', async () => {
    const ctx = createDetailsTestContext();
    assert.strictEqual(typeof ctx.retrySingleModuleTask, 'function', 'Must export retrySingleModuleTask');
    assert.strictEqual(typeof ctx.regenerateSingleModuleTask, 'function', 'Must export regenerateSingleModuleTask');

    const taskId = 'task-test-m1';
    const initialOpKey = 'op-initial-test-key';
    let passedOpKey = null;

    ctx.globalGenContext = {
        tasks: {
            [taskId]: {
                id: 'm1',
                uniqueId: taskId,
                title: 'Hero',
                clientOperationKey: initialOpKey,
                status: 'error'
            }
        },
        uploadedImages: [{ mimeType: 'image/png', data: 'AAA' }],
        config: { aspectRatio: '1:1' },
        sellingPoints: {}
    };

    ctx.generateSingleWrap = async (uniqueId, skipSeo, prompt, signal, opts = {}) => {
        const t = ctx.globalGenContext.tasks[uniqueId];
        passedOpKey = t.clientOperationKey;
        return { status: 'success', task: t };
    };

    // 1. Retry should preserve initialOpKey
    await ctx.retrySingleModuleTask(taskId);
    assert.strictEqual(passedOpKey, initialOpKey, 'Retry must preserve clientOperationKey');

    // 2. Regenerate should create a new operation key
    await ctx.regenerateSingleModuleTask(taskId);
    assert.notStrictEqual(passedOpKey, initialOpKey, 'Regenerate must create a new distinct clientOperationKey');
    assert.ok(passedOpKey && passedOpKey.length > 5, 'New operation key must be valid');
});

test('generateSingleWrap failure renders friendly error and dual retry/regenerate actions', async () => {
    const ctx = createDetailsTestContext();
    const taskId = 'task-card-error-test';

    ctx.globalGenContext = {
        tasks: {
            [taskId]: {
                id: 'm1',
                uniqueId: taskId,
                title: 'Hero Module',
                status: 'pending'
            }
        },
        uploadedImages: [{ mimeType: 'image/png', data: 'AAA' }],
        config: { aspectRatio: '1:1' },
        sellingPoints: {}
    };

    ctx.getImagesForTask = () => [{ mimeType: 'image/png', data: 'AAA' }];
    ctx.ensureInlineImageData = async (img) => img;

    // Simulate raw upstream 503 error
    ctx.callAI = async () => {
        throw new Error("Client error '503 Service Unavailable' for url 'https://api.openai.com/v1/images/generations'");
    };

    const cardEl = ctx.document.getElementById(`content-mod-${taskId}`);
    await ctx.generateSingleWrap(taskId, true);

    assert.strictEqual(ctx.globalGenContext.tasks[taskId].status, 'error');
    assert.match(cardEl.innerHTML, /detail-error-message/);
    assert.match(cardEl.innerHTML, /上游 AI 服务繁忙/);
    assert.doesNotMatch(cardEl.innerHTML, /https:\/\/api\.openai\.com/, 'Must not expose raw upstream URL');
    assert.match(cardEl.innerHTML, /retrySingleModuleTask\('task-card-error-test'\)/);
    assert.match(cardEl.innerHTML, /regenerateSingleModuleTask\('task-card-error-test'\)/);
});
