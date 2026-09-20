const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const detailsPath = path.join(__dirname, '..', 'js', 'details.js');
const listingPath = path.join(__dirname, '..', 'js', 'listing.js');
const adsPath = path.join(__dirname, '..', 'js', 'ads.js');
const redrawPath = path.join(__dirname, '..', 'js', 'square_redraw.js');

test('details.js replaces cold errors with actionable diagnostic messages', () => {
    const code = fs.readFileSync(detailsPath, 'utf8');

    // Selling points error
    assert.ok(
        code.includes('卖点提炼失败：请检查网络连接，或前往【AI设置】确认已配置并启用文本大模型'),
        'details.js should provide actionable guidance when selling points extraction fails'
    );
    assert.strictEqual(
        code.includes("showToast('生成失败', 'error')"),
        false,
        "details.js should not have cold showToast('生成失败', 'error')"
    );

    // Repaint error
    assert.ok(
        code.includes('模块重绘失败：生图服务未正常响应，请检查生图渠道状态或稍后重试'),
        'details.js should provide actionable guidance when repaint fails'
    );
    assert.strictEqual(
        code.includes("showToast('重绘失败', 'error')"),
        false,
        "details.js should not have cold showToast('重绘失败', 'error')"
    );

    // Image read error
    assert.ok(
        code.includes('图片读取失败：文件可能损坏或格式不兼容，请重新上传 JPG/PNG/WebP 格式图片'),
        'details.js should provide file format guidance when image read fails'
    );
    assert.strictEqual(
        code.includes("showToast('图片读取失败', 'error')"),
        false,
        "details.js should not have cold showToast('图片读取失败', 'error')"
    );

    // Empty modules on builder/export
    assert.ok(
        code.includes('尚未生成任何视觉模块：请先在左侧勾选所需模块并点击【一键生成详情页】'),
        'details.js should instruct user how to generate modules when opening long image builder'
    );
    assert.ok(
        code.includes('没有可导出的详情页：请先生成视觉模块后再打包物料'),
        'details.js should instruct user to generate modules before launch kit export'
    );
});

test('listing.js provides constructive instructions for empty or required inputs', () => {
    const code = fs.readFileSync(listingPath, 'utf8');

    // Required fields message
    assert.ok(
        code.includes('请补充商品信息：产品名称与核心卖点均为必填项，有助于 AI 精准创作'),
        'listing.js should explain why product name and features are required'
    );

    // Empty copy message
    assert.ok(
        code.includes('当前暂无已生成的 Listing 内容，请先生成后再复制'),
        'listing.js should instruct user to generate before copying'
    );
});

test('ads.js provides clear copy failure and missing input instructions', () => {
    const code = fs.readFileSync(adsPath, 'utf8');

    // Missing input instruction
    assert.ok(
        code.includes('请至少提供商品名称或上传 1 张商品白底图，以便 AI 解析卖点并撰写广告'),
        'ads.js should instruct user to provide name or image'
    );

    // Copy error guidance
    assert.ok(
        code.includes('复制失败：请检查浏览器剪贴板权限，或手动长按/选中文本复制'),
        'ads.js should provide permission and manual copy workaround'
    );
});

test('square_redraw.js explains locked batch ratio with clear recovery action', () => {
    const code = fs.readFileSync(redrawPath, 'utf8');

    // Batch ratio lock message
    assert.ok(
        code.includes('当前批次已锁定尺寸：如需更换目标宽高比，请先清空当前图片列表后重新添加'),
        'square_redraw.js should tell user how to change ratio'
    );
    assert.strictEqual(
        code.includes("showToast('当前批次已创建，如需改尺寸请重新上传一批图片', 'error')"),
        false,
        'square_redraw.js should not show unhelpful error'
    );
});
