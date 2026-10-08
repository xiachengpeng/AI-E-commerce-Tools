const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const frontendRoot = path.resolve(__dirname, "..");
const indexHtml = fs.readFileSync(path.join(frontendRoot, "index.html"), "utf8");

const SECRET_INPUT_IDS = [
    "settingsProviderApiKey",
    "settingsProviderBalanceAccessToken",
    "settingsUsageApiKey",
    "settingsFirecrawlApiKey",
    "settingsWpAppPassword",
    "settingsShopifyAccessToken",
    "settingsR2SecretKey",
    "storageWpAppPassword",
    "storageShopifyAccessToken",
    "storageR2SecretKey",
];

test("all 10 secret inputs exist with initial type password in index.html", () => {
    for (const inputId of SECRET_INPUT_IDS) {
        const idRegex = new RegExp(`id="${inputId}"[^>]*type="password"|type="password"[^>]*id="${inputId}"`);
        assert.match(
            indexHtml,
            idRegex,
            `Input with id "${inputId}" must exist and have type="password"`
        );
    }
});

test("all 10 secret inputs have an eye toggle button and togglePasswordVisibility in index.html", () => {
    for (const inputId of SECRET_INPUT_IDS) {
        // Matches togglePasswordVisibility('<id>', ...) or toggleFirecrawlKeyVisibility
        const toggleRegex = new RegExp(`togglePasswordVisibility\\(['"]${inputId}['"]|toggleFirecrawlKeyVisibility`);
        assert.match(
            indexHtml,
            toggleRegex,
            `Input with id "${inputId}" must have an eye toggle calling togglePasswordVisibility('${inputId}')`
        );
    }
});

test("togglePasswordVisibility toggles input type between password and text and updates eye icon", () => {
    const { togglePasswordVisibility } = require("../js/utils.js");
    assert.equal(typeof togglePasswordVisibility, "function");

    // Mock DOM elements
    const mockInput = { id: "testInput", type: "password" };
    const mockIcon = { className: "ph ph-eye" };
    const mockBtn = {
        querySelector: (sel) => (sel === "i" ? mockIcon : null),
        setAttribute: (k, v) => {}
    };

    // 1. Password -> Text
    togglePasswordVisibility(mockInput, mockBtn);
    assert.equal(mockInput.type, "text");
    assert.match(mockIcon.className, /ph-eye-slash/);

    // 2. Text -> Password
    togglePasswordVisibility(mockInput, mockBtn);
    assert.equal(mockInput.type, "password");
    assert.match(mockIcon.className, /ph-eye/);
    assert.doesNotMatch(mockIcon.className, /slash/);
});

test("togglePasswordVisibility fetches saved credential from backend when input is empty", async () => {
    const { togglePasswordVisibility } = require("../js/utils.js");

    const mockInput = {
        id: "settingsProviderApiKey",
        type: "password",
        value: "",
        dataset: { secretCategory: "ai_provider", secretField: "api_key", secretId: "5" }
    };
    const mockIcon = { className: "ph ph-eye" };
    const mockBtn = {
        querySelector: (sel) => (sel === "i" ? mockIcon : null),
        setAttribute: (k, v) => {}
    };

    // Mock global fetch
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
        assert.match(url, /\/api\/settings\/secrets\/reveal/);
        const body = JSON.parse(options.body);
        assert.equal(body.category, "ai_provider");
        assert.equal(body.field, "api_key");
        assert.equal(body.id, 5);
        return {
            ok: true,
            json: async () => ({ status: "success", secret: "sk-live-revealed-key-888" })
        };
    };

    try {
        // First click: reveals secret
        await togglePasswordVisibility(mockInput, mockBtn);
        assert.equal(mockInput.type, "text");
        assert.equal(mockInput.value, "sk-live-revealed-key-888");
        assert.match(mockIcon.className, /ph-eye-slash/);

        // Second click: hides secret and restores empty placeholder value
        await togglePasswordVisibility(mockInput, mockBtn);
        assert.equal(mockInput.type, "password");
        assert.equal(mockInput.value, "");
        assert.match(mockIcon.className, /ph-eye/);
        assert.doesNotMatch(mockIcon.className, /slash/);

        // Third click: cached, doesn't refetch
        await togglePasswordVisibility(mockInput, mockBtn);
        assert.equal(mockInput.type, "text");
        assert.equal(mockInput.value, "sk-live-revealed-key-888");
    } finally {
        globalThis.fetch = originalFetch;
    }
});
