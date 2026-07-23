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

function response(status, data) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => data
    };
}

function publicConfig(text = textRoute, image = imageRoute) {
    return {
        TEXT_ROUTE: text,
        IMAGE_ROUTE: image,
        CONCURRENCY_LIMIT: 2,
        STAGGER_DELAY: 100
    };
}

function createContext({ configs = [], aiResponses = [] } = {}) {
    const state = {
        configResponses: [...configs],
        aiResponses: [...aiResponses],
        configCalls: 0,
        aiCalls: [],
        logs: [],
        warnings: []
    };
    const context = {
        AbortController,
        MODULES_CONFIG: [],
        console: {
            error() {},
            log() {},
            warn: (...values) => state.warnings.push(values.join(" "))
        },
        document: {
            createElement: () => ({}),
            getElementById: () => null,
            querySelectorAll: () => []
        },
        localStorage: {
            getItem: () => null,
            setItem() {}
        },
        fetch: async (url, options) => {
            if (url.endsWith("/config")) {
                state.configCalls += 1;
                const next = state.configResponses.shift();
                if (next instanceof Error) throw next;
                return response(200, next);
            }
            state.aiCalls.push({ url, options });
            const next = state.aiResponses.shift();
            if (next instanceof Error) throw next;
            return next;
        },
        setTimeout: callback => {
            callback();
            return 1;
        },
        clearTimeout() {},
        window: {}
    };
    vm.createContext(context);
    vm.runInContext(
        fs.readFileSync(path.join(root, "js", "utils.js"), "utf8"),
        context
    );
    context.__capturedLogs = state.logs;
    vm.runInContext(
        "remoteLog = message => __capturedLogs.push(message)",
        context
    );
    vm.runInContext(
        fs.readFileSync(path.join(root, "js", "app.js"), "utf8"),
        context
    );
    return { context, state };
}

async function testCapabilityPayloadAndStatus(capability, route) {
    const { context, state } = createContext({
        configs: [publicConfig()],
        aiResponses: [response(200, { ok: true })]
    });
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

async function testExplicitNullRefreshesThenBlocks(capability, message) {
    const missing = {
        capability,
        name: null,
        protocol: null,
        model: null
    };
    const config = capability === "text"
        ? publicConfig(missing, imageRoute)
        : publicConfig(textRoute, missing);
    const { context, state } = createContext({
        configs: [config, config]
    });
    await context.refreshPublicAIRoutes();
    state.logs.length = 0;

    await assert.rejects(context.callAI(capability, {}), new RegExp(message));
    assert.equal(state.configCalls, 2);
    assert.equal(state.aiCalls.length, 0);
    assert.deepEqual(state.logs, [
        capability === "text"
            ? "配置加载成功 | 文本: 未配置 | 图片: Image Provider / image-model"
            : "配置加载成功 | 文本: Text Provider / text-model | 图片: 未配置"
    ]);
}

async function run() {
    await testCapabilityPayloadAndStatus("text", textRoute);
    await testCapabilityPayloadAndStatus("image", imageRoute);
    await testExplicitNullRefreshesThenBlocks(
        "text",
        "文本 AI 未配置，请前往设置页面配置"
    );
    await testExplicitNullRefreshesThenBlocks(
        "image",
        "图片 AI 未配置，请前往设置页面配置"
    );

    const initialFailure = createContext({
        configs: [
            new Error("secret initial connection detail"),
            new Error("secret retry connection detail")
        ]
    });
    await initialFailure.context.loadConfig();
    await assert.rejects(
        initialFailure.context.callAI("text", {}),
        /无法获取 AI 路由配置，请检查后端连接后重试/
    );
    assert.equal(initialFailure.state.configCalls, 2);
    assert.equal(initialFailure.state.aiCalls.length, 0);
    assert.equal(
        initialFailure.state.warnings.some(
            warning => warning.includes("secret")
        ),
        false
    );

    const recovery = createContext({
        configs: [
            new Error("initial outage"),
            publicConfig()
        ],
        aiResponses: [response(200, { recovered: true })]
    });
    await recovery.context.loadConfig();
    assert.deepEqual(
        await recovery.context.callAI("text", {}),
        { recovered: true }
    );
    assert.equal(recovery.state.configCalls, 2);
    assert.equal(recovery.state.aiCalls.length, 1);

    const nullTextRoute = {
        capability: "text",
        name: null,
        protocol: null,
        model: null
    };
    const postSettingsFailure = createContext({
        configs: [
            publicConfig(nullTextRoute, imageRoute),
            new Error("post-settings refresh failed"),
            publicConfig()
        ],
        aiResponses: [response(200, { recovered: true })]
    });
    await postSettingsFailure.context.refreshPublicAIRoutes();
    await assert.rejects(
        postSettingsFailure.context.refreshPublicAIRoutes(),
        /post-settings refresh failed/
    );
    assert.deepEqual(
        await postSettingsFailure.context.callAI("text", {}),
        { recovered: true }
    );
    assert.equal(postSettingsFailure.state.configCalls, 3);

    const staleConfigured = createContext({
        configs: [publicConfig()],
        aiResponses: [
            response(409, {
                detail: "文本 AI 未配置，请前往设置页面配置"
            })
        ]
    });
    await staleConfigured.context.refreshPublicAIRoutes();
    await assert.rejects(
        staleConfigured.context.callAI("text", {}),
        /文本 AI 未配置，请前往设置页面配置/
    );
    assert.equal(staleConfigured.state.aiCalls.length, 1);

    const transientFailure = createContext({
        configs: [publicConfig()],
        aiResponses: [
            response(503, {}),
            response(503, {}),
            response(200, { retried: true })
        ]
    });
    await transientFailure.context.refreshPublicAIRoutes();
    assert.deepEqual(
        await transientFailure.context.callAI("image", {}),
        { retried: true }
    );
    assert.equal(transientFailure.state.aiCalls.length, 3);
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
