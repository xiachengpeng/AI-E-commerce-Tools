const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");

async function run() {
    let fetchOptions;
    const logs = [];
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
        remoteLog: message => logs.push(message),
        fetchWithRetry: async (_url, options) => {
            fetchOptions = options;
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

    const payload = {
        contents: [{ role: "user", parts: [{ text: "hi" }] }]
    };
    await context.callAI("text", payload);

    assert.deepEqual(
        JSON.parse(fetchOptions.body),
        { capability: "text", payload }
    );
    assert.equal(logs.some(message => /undefined|null/.test(message)), false);
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
