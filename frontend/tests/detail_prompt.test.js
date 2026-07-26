const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

function loadFrontendContext() {
    const context = {
        console,
        document: { getElementById: () => null },
        showToast: () => {},
        MARKET_TONE_MAP: { 'US Market': 'direct but compliant' }
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(root, 'js', 'config.js'), 'utf8'), context);
    vm.runInContext(fs.readFileSync(path.join(root, 'js', 'details.js'), 'utf8'), context);
    return context;
}

const context = loadFrontendContext();

assert.strictEqual(typeof context.buildDetailPageBrief, 'function');
assert.strictEqual(typeof context.buildModuleGenerationPrompt, 'function');
assert.strictEqual(typeof context.buildProductLockPrompt, 'function');
assert.strictEqual(typeof context.buildModuleExecutionBrief, 'function');
assert.strictEqual(typeof context.getModuleContentRole, 'function');
assert.strictEqual(typeof context.getModuleStrategyCn, 'function');
assert.strictEqual(typeof context.buildSellingPointsExtractionPrompt, 'function');
assert.strictEqual(typeof context.buildSEOMetadataPrompt, 'function');
assert.strictEqual(typeof context.resolveDetailImageStyle, 'function');
assert.strictEqual(typeof context.buildStrategyTasks, 'function');
assert.strictEqual(typeof context.buildStrategyPromptPreview, 'function');
assert.strictEqual(typeof context.applyStrategyOverrides, 'function');
assert.strictEqual(typeof context.assessModuleQuality, 'function');
assert.strictEqual(typeof context.buildPromptRewriteSuggestion, 'function');
assert.strictEqual(typeof context.buildExportChecklist, 'function');
assert.strictEqual(typeof context.removeLongImageModuleFromOrder, 'function');

const config = {
    platform: 'Independent Website',
    platformLabel: '独立站',
    region: 'US Market',
    marketTone: 'direct but compliant',
    language: 'English',
    languageLabel: '英文',
    aspectRatio: '3:4',
    imageStyle: 'High-end minimalist, clean, premium, sophisticated',
    imageStyleLabel: '高端极简',
    marketingTheme: 'none'
};

const sellingPoints = [
    '2-in-1 Walking Pad with vibration mode',
    'Designed for under-desk walking and easy home storage',
    'App synced progress and remote control',
    'Quiet motor, non-slip belt, compact profile'
].join('\n');
const productFacts = [
    'Max load: 300 lbs',
    'Speed range: 0.6-3.8 mph',
    'Includes remote control'
].join('\n');
const forbiddenClaims = [
    'Do not mention burn fat',
    'Do not mention medical recovery',
    'Do not invent FDA certification'
].join('\n');

const productName = 'Compact Under-Desk Walking Pad';
const factConfig = { ...config, productName, productFacts, forbiddenClaims };
const brief = context.buildDetailPageBrief(sellingPoints, factConfig);
assert.match(brief, /one clear conversion job/i);
assert.match(brief, /infer plausible e-commerce specifications/i);
assert.match(brief, /Avoid medical/i);
assert.match(brief, /maximum 3 bullets/i);
assert.match(brief, /Confirmed product facts/i);
assert.match(brief, /Max load: 300 lbs/i);
assert.match(brief, /User-forbidden claims/i);
assert.match(brief, /Do not mention burn fat/i);
assert.match(brief, /Independent Website/i);
assert.match(brief, /US Market/i);
assert.match(brief, /High-end minimalist/i);
assert.doesNotMatch(brief, /独立站|美国 \(US\)|高端极简/);

const extractionPrompt = context.buildSellingPointsExtractionPrompt(3, productFacts, forbiddenClaims, productName);
assert.match(extractionPrompt, /known facts/i);
assert.match(extractionPrompt, /Do not invent/i);
assert.match(extractionPrompt, /avoid weight-loss, medical, body-transformation/i);
assert.match(extractionPrompt, /specifications/i);
assert.match(extractionPrompt, /User-provided product name/i);
assert.match(extractionPrompt, /Compact Under-Desk Walking Pad/i);
assert.match(extractionPrompt, /combine the uploaded image evidence with this product name/i);
assert.match(extractionPrompt, /Confirmed product facts/i);
assert.match(extractionPrompt, /Speed range: 0.6-3.8 mph/i);
assert.match(extractionPrompt, /User-forbidden claims/i);

const emptyNamePrompt = context.buildSellingPointsExtractionPrompt(
    1,
    productFacts,
    forbiddenClaims,
    '',
    'Chinese'
);
assert.match(emptyNamePrompt, /identify the product from the uploaded image/i);
assert.match(emptyNamePrompt, /product_name/i);
assert.match(emptyNamePrompt, /selling_points/i);
assert.match(emptyNamePrompt, /Chinese/);

const suppliedNamePrompt = context.buildSellingPointsExtractionPrompt(
    1,
    productFacts,
    forbiddenClaims,
    'Compact Under-Desk Walking Pad',
    'English'
);
assert.match(suppliedNamePrompt, /Compact Under-Desk Walking Pad/);
assert.match(suppliedNamePrompt, /combine the uploaded image evidence/i);

assert.strictEqual(typeof context.parseSellingPointsResponse, 'function');
assert.deepStrictEqual(
    JSON.parse(JSON.stringify(context.parseSellingPointsResponse(
        '{"product_name":"折叠式桌下走步机","selling_points":"产品类型：桌下走步机\\n核心卖点：便于收纳"}'
    ))),
    {
        productName: '折叠式桌下走步机',
        sellingPoints: '产品类型：桌下走步机\n核心卖点：便于收纳'
    }
);

assert.strictEqual(
    context.parseSellingPointsResponse(
        '```json\n{"product_name":"Walking Pad","selling_points":"Core selling points:\\n- Compact"}\n```'
    ).productName,
    'Walking Pad'
);

const legacyChinese = context.parseSellingPointsResponse(
    '产品名称：折叠式桌下走步机\n产品类型：家用健身设备\n核心卖点：小巧易收纳'
);
assert.strictEqual(legacyChinese.productName, '折叠式桌下走步机');
assert.match(legacyChinese.sellingPoints, /核心卖点：小巧易收纳/);

const legacyEnglish = context.parseSellingPointsResponse(
    'Product name: Compact Walking Pad\nProduct type: Home fitness equipment'
);
assert.strictEqual(legacyEnglish.productName, 'Compact Walking Pad');
assert.match(legacyEnglish.sellingPoints, /Product type/);

assert.strictEqual(typeof context.resolveSellingPointsFormState, 'function');
assert.deepStrictEqual(
    JSON.parse(JSON.stringify(context.resolveSellingPointsFormState(
        '',
        'old selling points',
        { productName: '折叠式桌下走步机', sellingPoints: '新的核心卖点' }
    ))),
    {
        productName: '折叠式桌下走步机',
        sellingPoints: '新的核心卖点',
        didFillProductName: true
    }
);

assert.deepStrictEqual(
    JSON.parse(JSON.stringify(context.resolveSellingPointsFormState(
        '用户确认的产品名',
        'old selling points',
        { productName: 'AI 返回的名称', sellingPoints: '新的核心卖点' }
    ))),
    {
        productName: '用户确认的产品名',
        sellingPoints: '新的核心卖点',
        didFillProductName: false
    }
);

assert.deepStrictEqual(
    JSON.parse(JSON.stringify(context.resolveSellingPointsFormState(
        '',
        '保留原卖点',
        { productName: 'Walking Pad', sellingPoints: '' }
    ))),
    {
        productName: '',
        sellingPoints: '保留原卖点',
        didFillProductName: false
    }
);

const firstBenefit = {
    id: 'm2',
    title: '核心卖点图',
    promptTitle: 'Core Benefit Proof',
    subtitle: '突出卖点优势',
    prompt: 'benefits',
    variant: 0,
    totalVariants: 3
};
const secondBenefit = { ...firstBenefit, variant: 1 };

const firstPrompt = context.buildModuleGenerationPrompt(firstBenefit, sellingPoints, factConfig);
const secondPrompt = context.buildModuleGenerationPrompt(secondBenefit, sellingPoints, factConfig);

assert.strictEqual(typeof context.buildModuleTextPolicy, 'function');
const withCopyPrompt = context.buildModuleGenerationPrompt(
    { ...firstBenefit, includeText: true },
    sellingPoints,
    factConfig
);
assert.match(withCopyPrompt, /VISIBLE TEXT/);
assert.match(withCopyPrompt, /max 1 headline/i);

const withoutCopyPrompt = context.buildModuleGenerationPrompt(
    { ...firstBenefit, includeText: false },
    sellingPoints,
    factConfig
);
assert.match(withoutCopyPrompt, /NO ADDED TEXT/);
assert.match(withoutCopyPrompt, /no headlines, subheadlines, callouts, captions, specifications, dimensions, labels, badges, watermarks, letters, numbers, or typographic elements/i);
assert.match(withoutCopyPrompt, /original product markings/i);
assert.match(withoutCopyPrompt, /do not rewrite, translate, replace, or redesign/i);
assert.doesNotMatch(withoutCopyPrompt, /Text density: max 1 headline/i);
assert.doesNotMatch(withoutCopyPrompt, /add up to three large proof callouts/i);
assert.doesNotMatch(withoutCopyPrompt, /headline, visual composition, or callout set/i);
assert.doesNotMatch(withoutCopyPrompt, /generate plausible e-commerce details/i);

for (const prompt of [withCopyPrompt, withoutCopyPrompt]) {
    assert.match(prompt, /uploaded reference product as the only source of truth/i);
    assert.match(prompt, /logo, controls, buttons, ports, labels, texture, and component placement/i);
    assert.match(prompt, /do not alter or invent/i);
}

assert.match(firstPrompt, /SECTION GOAL/);
assert.match(firstPrompt, /Do NOT repeat the same angle/i);
assert.match(firstPrompt, /Text density/i);
assert.match(firstPrompt, /Forbidden claims/i);
assert.notStrictEqual(firstPrompt, secondPrompt);
assert.match(firstPrompt, /under-desk|core daily-use/i);
assert.match(secondPrompt, /vibration|secondary function/i);
assert.match(firstPrompt, /Max load: 300 lbs/i);
assert.match(firstPrompt, /Product name: Compact Under-Desk Walking Pad/i);
assert.match(firstPrompt, /Do not mention medical recovery/i);
assert.doesNotMatch(firstPrompt, /独立站|美国 \(US\)|高端极简/);
assert.match(firstPrompt, /Core Benefit Proof/);
assert.doesNotMatch(firstPrompt, /核心卖点图|核心功能证明/);
assert.match(firstPrompt, /IMAGE TASK/);
assert.match(firstPrompt, /PRODUCT LOCK/);
assert.match(firstPrompt, /SECTION GOAL/);
assert.match(firstPrompt, /COMPOSITION/);
assert.match(firstPrompt, /VISIBLE TEXT/);
assert.match(firstPrompt, /HARD RULES/);
assert.match(firstPrompt, /Use the uploaded reference product as the source of truth/i);
assert.match(firstPrompt, /Do not redesign the product/i);
assert.match(firstPrompt, /Do not add any extra product elements, accessories, markings, parts, functions, or attachments/i);
assert.doesNotMatch(firstPrompt, /handrails|console screens|wheels|handles/i);
assert.match(firstPrompt, /Place the product large and clear/i);
assert.match(firstPrompt, /All visible text must be English/i);
assert.strictEqual((firstPrompt.match(/Target platform:/gi) || []).length, 1);
assert.strictEqual((firstPrompt.match(/Product information:/gi) || []).length, 1);
assert.strictEqual((firstPrompt.match(/Module role:/gi) || []).length, 0);
assert.strictEqual((firstPrompt.match(/PRODUCT INFORMATION FOR THIS SECTION/gi) || []).length, 0);
assert.strictEqual((firstPrompt.match(/2-in-1 Walking Pad with vibration mode/gi) || []).length, 1);
assert.doesNotMatch(firstPrompt, /Confirmed product facts to preserve: 2-in-1 Walking Pad/i);
assert.doesNotMatch(firstPrompt, /Do not invent specifications, certifications, warranty terms, app functions, speed, load capacity, dimensions, or awards/i);
assert.doesNotMatch(firstPrompt, /Use only facts from Product information or Confirmed product facts/i);
assert.match(firstPrompt, /When information is missing, infer plausible e-commerce details from the reference image, product category, and module goal/i);

const specPrompt = context.buildModuleGenerationPrompt({
    id: 'm10',
    title: '详细规格表',
    promptTitle: 'Specification Confirmation',
    subtitle: '展示详细参数',
    prompt: 'specs',
    variant: 0,
    totalVariants: 1
}, sellingPoints, factConfig);
assert.match(specPrompt, /infer plausible specification details/i);
assert.match(specPrompt, /Speed range: 0.6-3.8 mph/i);
assert.match(specPrompt, /Do not mention burn fat/i);

const seoPrompt = context.buildSEOMetadataPrompt({ title: '详细规格表' }, sellingPoints, factConfig);
assert.match(seoPrompt, /Do not add unsupported claims/i);
assert.match(seoPrompt, /avoid medical, body transformation, fat loss/i);
assert.match(seoPrompt, /Max load: 300 lbs/i);
assert.match(seoPrompt, /Do not invent FDA certification/i);

const englishSeoPrompt = context.buildSEOMetadataPrompt({
    title: '核心功能证明',
    promptTitle: 'Core Benefit Proof'
}, sellingPoints, factConfig);
assert.match(englishSeoPrompt, /Core Benefit Proof/);
assert.doesNotMatch(englishSeoPrompt, /核心功能证明/);

const activeDefaults = context.MODULES_CONFIG
    .filter(mod => mod.active)
    .map(mod => mod.id);
assert.strictEqual(JSON.stringify(activeDefaults), JSON.stringify(['m1', 'm2', 'm3', 'm9', 'm10', 'm11']));
assert(context.MODULES_CONFIG.every(mod => mod.includeText === true));
assert.strictEqual(typeof context.setModuleIncludeText, 'function');

const moduleToggleFixture = [
    { id: 'm1', active: true, count: 2, includeText: true },
    { id: 'm2', active: true, count: 1, includeText: true }
];
assert.strictEqual(context.setModuleIncludeText(moduleToggleFixture, 'm2', false), true);
assert.strictEqual(moduleToggleFixture[0].includeText, true);
assert.strictEqual(moduleToggleFixture[0].count, 2);
assert.strictEqual(moduleToggleFixture[0].active, true);
assert.strictEqual(moduleToggleFixture[1].includeText, false);
assert.strictEqual(context.setModuleIncludeText(moduleToggleFixture, 'missing', false), false);

const styleLabels = context.IMAGE_STYLE_OPTIONS.map(opt => opt.label);
assert(styleLabels.includes('亚马逊信息图风'));
assert(styleLabels.includes('Shopify高级生活方式风'));
assert(styleLabels.includes('自定义风格'));

const platformLabels = context.PLATFORM_OPTIONS.map(opt => opt.label);
assert(platformLabels.includes('独立站'));
assert(platformLabels.includes('亚马逊'));
assert(platformLabels.includes('Walmart'));
assert(platformLabels.includes('TikTok Shop'));
assert(!platformLabels.includes('淘宝'));
assert(!context.PLATFORM_OPTIONS.some(opt => /Taobao|淘宝/i.test(`${opt.value} ${opt.label}`)));

const builtInStyle = context.resolveDetailImageStyle({
    selectedValue: 'Amazon infographic style, clean white background, structured callouts',
    selectedLabel: '亚马逊信息图风',
    customValue: ''
});
assert.strictEqual(JSON.stringify(builtInStyle), JSON.stringify({
    value: 'Amazon infographic style, clean white background, structured callouts',
    label: '亚马逊信息图风',
    isCustom: false,
    error: ''
}));

const customStyle = context.resolveDetailImageStyle({
    selectedValue: 'custom',
    selectedLabel: '自定义风格',
    customValue: 'Nordic home office style, soft daylight, calm productivity'
});
assert.strictEqual(JSON.stringify(customStyle), JSON.stringify({
    value: 'Nordic home office style, soft daylight, calm productivity',
    label: '自定义风格：Nordic home office style, soft daylight, calm productivity',
    isCustom: true,
    error: ''
}));

const emptyCustomStyle = context.resolveDetailImageStyle({
    selectedValue: 'custom',
    selectedLabel: '自定义风格',
    customValue: '  '
});
assert.strictEqual(emptyCustomStyle.error, '请输入自定义风格');

const strategyTasks = context.buildStrategyTasks([
    { id: 'm1', title: '首屏主视觉', promptTitle: 'Hero Product Understanding', subtitle: '传递核心价值', prompt: 'hero', count: 1 },
    { id: 'm2', title: '核心卖点图', promptTitle: 'Core Benefit Proof', subtitle: '突出卖点优势', prompt: 'benefit', count: 2 }
], sellingPoints, factConfig);
assert.strictEqual(strategyTasks.length, 3);
assert.strictEqual(strategyTasks[0].uniqueId, 'm1_0');
assert.strictEqual(strategyTasks[0].promptTitle, 'Hero Product Understanding');
assert.match(strategyTasks[0].role, /Hero/i);
assert.match(strategyTasks[0].strategyCn.goal, /立刻看懂/);
assert.match(strategyTasks[1].strategyCn.avoid, /重复/);
assert.match(strategyTasks[1].prompt, /benefit/i);

const textModeTasks = context.buildStrategyTasks([
    { id: 'm1', title: 'Hero', subtitle: 'Hero', prompt: 'hero', count: 1, includeText: true },
    { id: 'm3', title: 'Scene', subtitle: 'Scene', prompt: 'scene', count: 1, includeText: false }
], sellingPoints, factConfig);
assert.strictEqual(textModeTasks[0].includeText, true);
assert.strictEqual(textModeTasks[1].includeText, false);

const removedLongImageOrder = context.removeLongImageModuleFromOrder(['m1_0', 'm2_0', 'm3_0', 'm2_0'], 'm2_0');
assert.strictEqual(JSON.stringify(removedLongImageOrder), JSON.stringify(['m1_0', 'm3_0']));
assert.strictEqual(
    JSON.stringify(context.removeLongImageModuleFromOrder(['m1_0', 'm3_0'], 'missing')),
    JSON.stringify(['m1_0', 'm3_0'])
);

const strategyPreviewPrompt = context.buildStrategyPromptPreview(strategyTasks[0], sellingPoints, factConfig);
assert.strictEqual(strategyPreviewPrompt.moduleRequest, 'hero');
assert.match(strategyPreviewPrompt.fullPrompt, /IMAGE TASK/);
assert.match(strategyPreviewPrompt.fullPrompt, /Create one professional e-commerce detail-page image section/i);
assert.match(strategyPreviewPrompt.fullPrompt, /Module request: hero/i);
assert.match(strategyPreviewPrompt.fullPrompt, /Confirmed product facts/i);
assert.match(strategyPreviewPrompt.fullPrompt, /Hero Product Understanding/);
assert.doesNotMatch(strategyPreviewPrompt.fullPrompt, /首屏主视觉|首屏认知/);
assert(strategyPreviewPrompt.fullPrompt.length > strategyPreviewPrompt.moduleRequest.length * 5);

const overriddenTasks = context.applyStrategyOverrides(strategyTasks, {
    m1_0: 'Use a clear white-background hero with larger product.',
    m2_1: 'Focus only on storage and quiet motor.'
});
assert.match(overriddenTasks[0].prompt, /larger product/i);
assert.match(overriddenTasks[2].prompt, /storage and quiet motor/i);
assert.strictEqual(strategyTasks[0].prompt, 'hero');

const quality = context.assessModuleQuality({
    status: 'success',
    title: '详细规格表',
    prompt: 'Create dense tiny text with FDA certification and burn fat claims',
    seo: { altTarget: 'Walking pad with FDA burn fat result' },
    imageSrc: 'data:image/png;base64,abc'
}, factConfig);
assert(quality.issues.some(issue => issue.code === 'forbidden-claim'));
assert(quality.issues.some(issue => issue.code === 'dense-text'));

const rewrite = context.buildPromptRewriteSuggestion({
    title: '详细规格表',
    prompt: 'dense tiny text'
}, quality.issues, factConfig);
assert.match(rewrite, /reduce text density/i);
assert.match(rewrite, /Do not mention burn fat/i);

const checklist = context.buildExportChecklist([
    { id: 'm1_0', title: '首屏主视觉', status: 'success', imageSrc: 'data:image/png;base64,a', seo: {} },
    { id: 'm10_0', title: '详细规格表', status: 'fallback', imageSrc: '', seo: {} }
], factConfig);
assert(checklist.some(item => item.level === 'warning'));
assert(checklist.some(item => /fallback|降级/i.test(item.text)));

console.log('detail prompt tests passed');
