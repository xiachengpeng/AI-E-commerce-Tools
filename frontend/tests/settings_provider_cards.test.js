const assert = require("node:assert/strict");
const test = require("node:test");

const {
    providerTestCapabilities,
    providerTestActionsMarkup,
    providerTestStatusMarkup
} = require("../js/settings.js");

test("dual-capability providers expose separate saved text and image tests", () => {
    const provider = {
        id: 7,
        name: "Dual Relay",
        supports_text: true,
        supports_image: true
    };

    assert.deepEqual(
        providerTestCapabilities?.(provider) ?? [],
        ["text", "image"]
    );
    const markup = providerTestActionsMarkup?.(provider) ?? "";
    assert.match(markup, />测试文本</);
    assert.match(markup, />测试图片</);
    assert.match(
        markup,
        /testSavedProvider\(7, 'text', this\)/
    );
    assert.match(
        markup,
        /testSavedProvider\(7, 'image', this\)/
    );
});

test("single-capability providers expose only their appropriate saved test", () => {
    const provider = {
        id: 8,
        name: "Image Relay",
        supports_text: false,
        supports_image: true
    };

    assert.deepEqual(
        providerTestCapabilities?.(provider) ?? [],
        ["image"]
    );
    const markup = providerTestActionsMarkup?.(provider) ?? "";
    assert.doesNotMatch(markup, /测试文本/);
    assert.match(markup, />测试图片</);
    assert.doesNotMatch(markup, /'text'/);
    assert.match(markup, /'image'/);
});

test("saved status labels the capability that produced it", () => {
    const markup = providerTestStatusMarkup?.({
        last_test_status: "success",
        last_test_message: "连接成功",
        last_test_capability: "image"
    }) ?? "";

    assert.match(markup, /图片/);
    assert.match(markup, /连接成功/);
});

test("saved status escapes upstream text while retaining capability context", () => {
    const markup = providerTestStatusMarkup?.({
        last_test_status: "error",
        last_test_message: "<img onerror=alert(1)>",
        last_test_capability: "text"
    }) ?? "";

    assert.match(markup, /文本/);
    assert.doesNotMatch(markup, /<img/);
    assert.match(markup, /&lt;img onerror=alert\(1\)&gt;/);
});
