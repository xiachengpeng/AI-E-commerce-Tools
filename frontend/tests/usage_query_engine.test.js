const assert = require("node:assert/strict");
const test = require("node:test");

const {
    USAGE_QUERY_TEMPLATES,
    executeUsageExtractor,
    parseUsageScript,
    interpolateTemplate,
    formatExtractorScript,
} = require("../js/usage_query_engine.js");

test("USAGE_QUERY_TEMPLATES contains all 4 standard CC Switch presets", () => {
    assert.ok(USAGE_QUERY_TEMPLATES.general, "general template should exist");
    assert.ok(USAGE_QUERY_TEMPLATES.newapi, "newapi template should exist");
    assert.ok(USAGE_QUERY_TEMPLATES.token_plan, "token_plan template should exist");
    assert.ok(USAGE_QUERY_TEMPLATES.official, "official template should exist");
});

test("parseUsageScript parses script object with request and extractor", () => {
    const script = USAGE_QUERY_TEMPLATES.general;
    const parsed = parseUsageScript(script);
    assert.ok(parsed, "Parsed result should exist");
    assert.equal(parsed.request.url, "{{baseUrl}}/v1/usage");
    assert.equal(parsed.request.method, "GET");
    assert.equal(typeof parsed.extractor, "function");
});

test("New-API extractor extracts planName, remaining, used, total and unit", () => {
    const script = USAGE_QUERY_TEMPLATES.newapi;
    const mockResponse = {
        success: true,
        data: {
            group: "尊享版",
            quota: 5000000,
            used_quota: 1000000,
        },
    };
    const result = executeUsageExtractor(script, mockResponse);
    assert.equal(result.isValid, true);
    assert.equal(result.planName, "尊享版");
    assert.equal(result.remaining, 10);
    assert.equal(result.used, 2);
    assert.equal(result.total, 12);
    assert.equal(result.unit, "USD");
});

test("New-API extractor handles error response and invalidMessage", () => {
    const script = USAGE_QUERY_TEMPLATES.newapi;
    const mockResponse = {
        success: false,
        message: "访问令牌无效或已过期",
    };
    const result = executeUsageExtractor(script, mockResponse);
    assert.equal(result.isValid, false);
    assert.equal(result.invalidMessage, "访问令牌无效或已过期");
});

test("General extractor extracts remaining and unit", () => {
    const script = USAGE_QUERY_TEMPLATES.general;
    const mockResponse = {
        remaining: 18.5,
        unit: "USD",
        is_active: true,
    };
    const result = executeUsageExtractor(script, mockResponse);
    assert.equal(result.isValid, true);
    assert.equal(result.remaining, 18.5);
    assert.equal(result.unit, "USD");
});

test("General extractor extracts nested quota.remaining and quota.unit", () => {
    const script = USAGE_QUERY_TEMPLATES.general;
    const mockResponse = {
        quota: {
            remaining: 99.8,
            unit: "CNY",
        },
    };
    const result = executeUsageExtractor(script, mockResponse);
    assert.equal(result.isValid, true);
    assert.equal(result.remaining, 99.8);
    assert.equal(result.unit, "CNY");
});

test("Token Plan extractor extracts hard_limit and unit", () => {
    const script = USAGE_QUERY_TEMPLATES.token_plan;
    const mockResponse = {
        hard_limit_usd: 150.0,
        is_active: true,
    };
    const result = executeUsageExtractor(script, mockResponse);
    assert.equal(result.isValid, true);
    assert.equal(result.remaining, "150.00");
    assert.equal(result.unit, "USD");
});

test("interpolateTemplate replaces {{baseUrl}}, {{apiKey}}, {{accessToken}}, {{userId}}", () => {
    const tpl = "{{baseUrl}}/query?key={{apiKey}}&tok={{accessToken}}&uid={{userId}}";
    const vars = {
        baseUrl: "https://api.test.com",
        apiKey: "sk-key-1",
        accessToken: "tok-2",
        userId: "10086",
    };
    const rendered = interpolateTemplate(tpl, vars);
    assert.equal(
        rendered,
        "https://api.test.com/query?key=sk-key-1&tok=tok-2&uid=10086"
    );
});

test("formatExtractorScript returns formatted code without crashing", () => {
    const messy = "({request:{url:'{{baseUrl}}'},extractor:function(r){return{remaining:r.quota};}})";
    const formatted = formatExtractorScript(messy);
    assert.ok(formatted.includes("\n"));
    assert.ok(formatted.includes("extractor"));
});

test("executeUsageExtractor handles syntax error gracefully", () => {
    const badScript = "({ request: {}, extractor: function( { return broken; } })";
    const result = executeUsageExtractor(badScript, { test: 1 });
    assert.equal(result.isValid, false);
    assert.ok(result.invalidMessage.includes("语法错误"));
});
