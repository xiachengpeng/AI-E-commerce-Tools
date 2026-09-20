const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const frontendRoot = path.resolve(__dirname, "..");
const indexHtml = fs.readFileSync(path.join(frontendRoot, "index.html"), "utf8");

test("index.html storage editor modal contains beginner educational notice and localized eyebrow", () => {
    // 1. Eyebrow localized
    assert.doesNotMatch(indexHtml, /<span class="settings-eyebrow">Storage Integration<\/span>/);
    assert.match(indexHtml, /settings-eyebrow[^>]*>独立站外链图床与媒体库/);

    // 2. Contains beginner FAQ banner explaining why external storage/CDN is needed
    assert.match(indexHtml, /为什么跨境独立站需要配置外部图床/);
    assert.match(indexHtml, /提升 Google 搜索 SEO 评分/);

    // 3. Contains clear field helper texts for Cloudflare R2
    assert.match(indexHtml, /管理 R2 API 令牌/);
});

test("index.html universal uploader explains SEO Alt Text in plain language for sellers", () => {
    // Check educational plain explanation for Alt Text
    assert.match(indexHtml, /给 Google 等搜索引擎爬虫识别的“图片说明书”/);
});
