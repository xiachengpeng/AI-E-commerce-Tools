const assert = require("node:assert/strict");
const {
    providerSupportsCapability,
    buildProviderPayload,
    maskedKeyPlaceholder
} = require("../js/settings.js");

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
