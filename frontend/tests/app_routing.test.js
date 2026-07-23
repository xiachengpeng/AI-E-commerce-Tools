const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const textRoute = {
    capability: "text",
    name: "Text Provider",
    protocol: "gemini",
    model: "text-model"
};
const imageRoute = {
    capability: "image",
    name: "Image Provider",
    protocol: "openai_compatible",
    model: "image-model"
};

function createContext(configs) {
    const state = {
        configResponses: [...configs],
        fetchCalls: 0,
        aiCalls: [],
        logs: []
    };
    const context = {
        AbortController,
        API_BASE: "http://localhost:8000",
        MODULES_CONFIG: [],
        console: { log() {}, warn() {} },
        document: {
            getElementById: () => null,
            querySelectorAll: () => []
        },
        localStorage: {
            getItem: () => null,
            setItem() {}
        },
        remoteLog: message => state.logs.push(message),
        fetch: async () => {
            state.fetchCalls += 1;
            const config = state.configResponses.shift();
            return {
                ok: true,
                json: async () => config
            };
        },
        fetchWithRetry: async (url, options) => {
            state.aiCalls.push({ url, options });
            return { ok: true };
        },
        setTimeout,
        clearTimeout,
        window: {}
    };
    vm.createContext(context);
    vm.runInContext(
        fs.readFileSync(path.join(root, "js", "app.js"), "utf8"),
        context
    );
    return { context, state };
}

function publicConfig(text = textRoute, image = imageRoute) {
    return {
        TEXT_ROUTE: text,
        IMAGE_ROUTE: image,
        CONCURRENCY_LIMIT: 2,
        STAGGER_DELAY: 100
    };
}

async function testCapabilityPayloadAndStatus(capability, route) {
    const { context, state } = createContext([publicConfig()]);
    await context.refreshPublicAIRoutes();
    state.logs.length = 0;

    const payload = {
        contents: [{ role: "user", parts: [{ text: "hi" }] }]
    };
    await context.callAI(capability, payload);

    assert.equal(state.aiCalls.length, 1);
    assert.deepEqual(
        JSON.parse(state.aiCalls[0].options.body),
        { capability, payload }
    );
    assert.deepEqual(
        state.logs,
        [`正在调用模型: ${route.model} (${route.name})`]
    );
}

async function testUnconfiguredDoesNotFetch(capability, expectedMessage) {
    const missing = {
        capability,
        name: null,
        protocol: null,
        model: null
    };
    const config = capability === "text"
        ? publicConfig(missing, imageRoute)
        : publicConfig(textRoute, missing);
    const { context, state } = createContext([config]);
    await context.refreshPublicAIRoutes();
    state.logs.length = 0;

    await assert.rejects(
        context.callAI(capability, {}),
        new RegExp(expectedMessage)
    );
    assert.equal(state.aiCalls.length, 0);
    assert.deepEqual(state.logs, []);
}

async function run() {
    await testCapabilityPayloadAndStatus("text", textRoute);
    await testCapabilityPayloadAndStatus("image", imageRoute);
    await testUnconfiguredDoesNotFetch(
        "text",
        "文本 AI 未配置，请前往设置页面配置"
    );
    await testUnconfiguredDoesNotFetch(
        "image",
        "图片 AI 未配置，请前往设置页面配置"
    );

    const updatedTextRoute = {
        ...textRoute,
        name: "Updated Provider",
        model: "updated-text-model"
    };
    const { context, state } = createContext([
        publicConfig(),
        publicConfig(updatedTextRoute, imageRoute)
    ]);
    await context.refreshPublicAIRoutes();
    await context.refreshPublicAIRoutes();
    state.logs.length = 0;
    await context.callAI("text", { contents: [] });
    assert.deepEqual(
        state.logs,
        ["正在调用模型: updated-text-model (Updated Provider)"]
    );
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
