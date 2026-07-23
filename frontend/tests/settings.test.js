const assert = require("node:assert/strict");
const {
    providerSupportsCapability,
    buildProviderPayload,
    maskedKeyPlaceholder,
    refreshSettingsAfterSuccess,
    replaceProviderInList,
    removeProviderFromList,
    replaceBindingInList
} = require("../js/settings.js");
const { appendToastContent } = require("../js/utils.js");

assert.equal(providerSupportsCapability(
    { enabled: true, supports_text: true }, "text"), true);
assert.equal(providerSupportsCapability(
    { enabled: false, supports_text: true }, "text"), false);
assert.equal(maskedKeyPlaceholder(
    { has_api_key: true, api_key_masked: "sk-****1234" }), "已保存：sk-****1234");
assert.deepEqual(buildProviderPayload({
    name: " Relay ",
    protocol: "openai_compatible",
    base_url: "https://relay.example.com/",
    api_key: "",
    supports_text: true,
    supports_image: false,
    timeout_seconds: "30",
    max_retries: "2",
    enabled: true
}), {
    name: "Relay",
    protocol: "openai_compatible",
    base_url: "https://relay.example.com",
    api_key: null,
    supports_text: true,
    supports_image: false,
    timeout_seconds: 30,
    max_retries: 2,
    enabled: true
});

function fakeElement(tagName) {
    return {
        tagName: tagName.toUpperCase(),
        className: "",
        textContent: "",
        children: [],
        appendChild(child) {
            this.children.push(child);
            return child;
        }
    };
}

const fakeDocument = {
    createElement: tagName => fakeElement(tagName)
};
const toast = fakeElement("div");
const attack = '<img src=x onerror="globalThis.toastXss=true">';
appendToastContent(toast, attack, "ph-warning-circle", fakeDocument);
assert.equal(toast.children.length, 2);
assert.equal(toast.children[0].tagName, "I");
assert.equal(toast.children[0].className, "ph ph-warning-circle text-lg");
assert.equal(toast.children[1].tagName, "SPAN");
assert.equal(toast.children[1].textContent, attack);
assert.deepEqual(toast.children[1].children, []);
assert.equal(toast.children.some(child => child.tagName === "IMG"), false);

assert.deepEqual(replaceProviderInList(
    [{ id: 1, enabled: true }, { id: 2, enabled: true }],
    { id: 1, enabled: false }
), [{ id: 1, enabled: false }, { id: 2, enabled: true }]);
assert.deepEqual(replaceProviderInList(
    [],
    { id: 3, enabled: true }
), [{ id: 3, enabled: true }]);
assert.deepEqual(removeProviderFromList(
    [{ id: 1 }, { id: 2 }],
    1
), [{ id: 2 }]);
assert.deepEqual(replaceBindingInList(
    [{ capability: "text", provider_config_id: 1 }],
    { capability: "text", provider_config_id: 2 }
), [{ capability: "text", provider_config_id: 2 }]);
assert.deepEqual(replaceBindingInList(
    [],
    { capability: "image", provider_config_id: 3 }
), [{ capability: "image", provider_config_id: 3 }]);

async function runAsyncTests() {
    const operationResult = { status: "success", message: "连接成功" };
    const warnings = [];
    const outcome = await refreshSettingsAfterSuccess(
        operationResult,
        async () => {
            throw new Error("refresh failed");
        },
        message => warnings.push(message)
    );

    assert.strictEqual(outcome.result, operationResult);
    assert.equal(outcome.refreshed, false);
    assert.equal(outcome.refreshError.message, "refresh failed");
    assert.deepEqual(warnings, ["操作成功，但刷新失败：refresh failed"]);
}

runAsyncTests().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
