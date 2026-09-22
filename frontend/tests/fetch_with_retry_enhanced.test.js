const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

async function createTestContext({ aiResponses = [] } = {}) {
    const fetchCalls = [];
    const queuedResponses = [...aiResponses];

    const ctx = {
        console,
        setTimeout: (fn) => { fn(); return 1; },
        clearTimeout: () => {},
        AbortController,
        MODULES_CONFIG: [],
        API_BASE: 'http://127.0.0.1:9503',
        remoteLog: () => {},
        showToast: () => {},
        document: { querySelectorAll: () => [], getElementById: () => null, createElement: () => ({}) },
        localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
        fetch: async (url, options) => {
            fetchCalls.push({ url, options });
            if (url.endsWith('/config')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        TEXT_ROUTE: { capability: "text", name: "test-provider", model: "test-model" },
                        IMAGE_ROUTE: { capability: "image", name: "test-provider", model: "test-model" },
                    })
                };
            }
            if (queuedResponses.length > 0) {
                const next = queuedResponses.shift();
                if (next instanceof Error) throw next;
                return next;
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({ candidates: [{ content: { parts: [{ text: "OK" }] } }] })
            };
        }
    };

    ctx.window = ctx;
    ctx.globalThis = ctx;

    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(root, 'js', 'config.js'), 'utf8'), ctx);
    vm.runInContext(fs.readFileSync(path.join(root, 'js', 'utils.js'), 'utf8'), ctx);
    vm.runInContext('remoteLog = () => {}', ctx);
    vm.runInContext(fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8'), ctx);

    await ctx.refreshPublicAIRoutes();
    fetchCalls.length = 0; // Clear initial /config call

    return { ctx, fetchCalls, queuedResponses };
}

test('fetchWithRetry respects disableRetry and does not retry on failure', async () => {
    const { ctx } = await createTestContext();
    let callCount = 0;

    ctx.fetch = async () => {
        callCount++;
        return {
            ok: false,
            status: 503,
            json: async () => ({ detail: "Server error" })
        };
    };

    await assert.rejects(async () => {
        await ctx.fetchWithRetry('http://example.com/api/test', {}, 3, { disableRetry: true });
    }, /HTTP 503/);

    assert.strictEqual(callCount, 1, "Must not retry when disableRetry is true");
});

test('fetchWithRetry does not retry when retries <= 1', async () => {
    const { ctx } = await createTestContext();
    let callCount = 0;

    ctx.fetch = async () => {
        callCount++;
        return {
            ok: false,
            status: 502,
            json: async () => ({ detail: "Bad gateway" })
        };
    };

    await assert.rejects(async () => {
        await ctx.fetchWithRetry('http://example.com/api/test', {}, 1);
    }, /HTTP 502/);

    assert.strictEqual(callCount, 1, "Must only call once when retries <= 1");
});

test('fetchWithRetry retries transient errors when enabled', async () => {
    const { ctx } = await createTestContext();
    let callCount = 0;

    ctx.fetch = async () => {
        callCount++;
        if (callCount === 1) {
            return {
                ok: false,
                status: 503,
                json: async () => ({ detail: "Transient error" })
            };
        }
        return {
            ok: true,
            status: 200,
            json: async () => ({ result: "success" })
        };
    };

    const res = await ctx.fetchWithRetry('http://example.com/api/test', {}, 3);
    assert.strictEqual(callCount, 2, "Must retry once and succeed on 2nd attempt");
    assert.strictEqual(res.result, "success");
});

test('callAI injects client_request_id, client_operation_key, and disables frontend retry', async () => {
    const { ctx, fetchCalls } = await createTestContext();

    await ctx.callAI('text', { prompt: 'Hello world' }, { taskId: 'task-hero-m1' });

    assert.strictEqual(fetchCalls.length, 1);
    const call = fetchCalls[0];
    assert.strictEqual(call.url, 'http://127.0.0.1:9503/api/ai/generate');

    const body = JSON.parse(call.options.body);
    assert.strictEqual(body.capability, 'text');
    assert.strictEqual(body.payload.prompt, 'Hello world');
    assert.ok(body.client_request_id, "Must generate a client_request_id");
    assert.strictEqual(body.client_operation_key, 'task-hero-m1', "Must forward taskId as client_operation_key");
    assert.strictEqual(call.options.headers['X-Client-Request-Id'], body.client_request_id);
});

test('callAI fails immediately without frontend retrying when backend returns 500', async () => {
    let callCount = 0;
    const { ctx } = await createTestContext({
        aiResponses: [
            {
                ok: false,
                status: 500,
                json: async () => {
                    callCount++;
                    return { detail: "Backend error" };
                }
            },
            {
                ok: false,
                status: 500,
                json: async () => {
                    callCount++;
                    return { detail: "Backend error retry" };
                }
            }
        ]
    });

    await assert.rejects(async () => {
        await ctx.callAI('image', { prompt: 'Generate image' });
    });

    assert.strictEqual(callCount, 1, "Frontend must NOT retry AI generation to prevent retry storm");
});
