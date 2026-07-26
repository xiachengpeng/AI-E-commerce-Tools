
// ====== 详情页模块配置逻辑 ======
const DETAIL_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const DETAIL_MAX_TASKS = 24;
const DETAIL_MAX_UPLOAD_IMAGES = 6;
let currentStrategyPreviewContext = null;

// 转义 HTML 特殊字符，避免用户输入或 AI 文案插入页面时破坏 DOM。
function detailEscapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[ch]));
}

// 获取 select 当前选中项的展示文案，用于保存配置和拼接提示词。
function getSelectedOptionLabel(selectId) {
    const select = document.getElementById(selectId);
    return select?.options?.[select.selectedIndex]?.text || select?.value || '';
}

// 解析详情页视觉风格，兼容固定选项和用户手动输入的自定义风格。
function resolveDetailImageStyle({ selectedValue = '', selectedLabel = '', customValue = '' } = {}) {
    const value = String(selectedValue || '').trim();
    const label = String(selectedLabel || '').trim();
    const custom = String(customValue || '').replace(/\s+/g, ' ').trim();
    if (value !== 'custom') {
        return { value, label: label || value, isCustom: false, error: '' };
    }
    if (!custom) {
        return { value: '', label: label || '自定义风格', isCustom: true, error: '请输入自定义风格' };
    }
    return {
        value: custom,
        label: `自定义风格：${custom}`,
        isCustom: true,
        error: ''
    };
}

// 根据风格下拉状态显示或隐藏自定义风格输入框。
function toggleCustomImageStyle() {
    const style = resolveDetailImageStyle({
        selectedValue: document.getElementById('imageStyleSelect')?.value || '',
        selectedLabel: getSelectedOptionLabel('imageStyleSelect'),
        customValue: document.getElementById('customImageStyleInput')?.value || ''
    });
    const container = document.getElementById('customImageStyleContainer');
    if (!container) return;
    container.classList.toggle('hidden', !style.isCustom);
    if (style.isCustom) {
        document.getElementById('customImageStyleInput')?.focus();
    }
}

// 校验并标准化宽高比字符串，返回模型可识别的 "宽:高" 格式。
function normalizeAspectRatio(value) {
    const raw = String(value || '').trim();
    const match = raw.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    if (width > 50 || height > 50) return null;
    return `${width}:${height}`;
}

// 汇总详情页生成所需的全局配置，包括风格、平台、市场、语言、比例和营销主题。
function getDetailConfig() {
    let ratioVal = document.getElementById('aspectRatioSelect')?.value || '1:1';
    if (ratioVal === 'custom') {
        ratioVal = `${document.getElementById('customRatioW')?.value || ''}:${document.getElementById('customRatioH')?.value || ''}`;
    }
    const aspectRatio = normalizeAspectRatio(ratioVal);
    if (!aspectRatio) {
        showToast('请填写有效的宽高比，例如 3:4', 'error');
        return null;
    }

    const region = document.getElementById('regionSelect')?.value || 'Global Market';
    const imageStyle = resolveDetailImageStyle({
        selectedValue: document.getElementById('imageStyleSelect')?.value || '',
        selectedLabel: getSelectedOptionLabel('imageStyleSelect'),
        customValue: document.getElementById('customImageStyleInput')?.value || ''
    });
    if (imageStyle.error) {
        showToast(imageStyle.error, 'error');
        document.getElementById('customImageStyleInput')?.focus();
        return null;
    }
    return {
        imageStyle: imageStyle.value,
        imageStyleLabel: imageStyle.label,
        imageStyleIsCustom: imageStyle.isCustom,
        platform: document.getElementById('platformSelect')?.value || '',
        platformLabel: getSelectedOptionLabel('platformSelect'),
        region,
        regionLabel: getSelectedOptionLabel('regionSelect'),
        marketTone: MARKET_TONE_MAP?.[region] || MARKET_TONE_MAP?.["Global Market"] || '',
        language: document.getElementById('languageSelect')?.value || 'English',
        languageLabel: getSelectedOptionLabel('languageSelect'),
        aspectRatio,
        marketingTheme: document.getElementById('marketingThemeSelect')?.value || 'none',
        marketingThemeLabel: getSelectedOptionLabel('marketingThemeSelect'),
        productName: document.getElementById('productNameInput')?.value.trim() || '',
        productFacts: document.getElementById('productFactsText')?.value.trim() || '',
        forbiddenClaims: document.getElementById('forbiddenClaimsText')?.value.trim() || ''
    };
}

// 压缩长文本中的空白并截断到指定长度，避免提示词过长。
function compactDetailText(value, maxLength = 900) {
    const normalized = String(value || '')
        .replace(/\s+/g, ' ')
        .trim();
    if (normalized.length <= maxLength) return normalized;
    const clipped = normalized.slice(0, maxLength);
    const lastSpace = clipped.lastIndexOf(' ');
    const safeCut = lastSpace > maxLength * 0.75 ? clipped.slice(0, lastSpace) : clipped;
    return safeCut.replace(/[,:;.-]*$/, '').trim();
}

// 按需生成产品事实和禁用词上下文，供各类提示词复用。
function buildProductGuardrails(config = {}) {
    const productName = compactDetailText(config.productName || '', 160);
    const facts = compactDetailText(config.productFacts || '', 900);
    const forbidden = compactDetailText(config.forbiddenClaims || '', 700);
    const sections = [];
    if (productName) {
        sections.push(`Product name: ${productName}`);
    }
    if (facts) {
        sections.push(`Confirmed product facts:\n${facts}`);
    }
    if (forbidden) {
        sections.push(`User-forbidden claims and wording:\n${forbidden}`);
    }
    return sections.join('\n\n');
}

// 获取给模型使用的英文模块名称，避免 UI 中文标题进入完整 Prompt。
function getPromptModuleTitle(task = {}) {
    return compactDetailText(task.promptTitle || task.promptName || task.id || 'Detail Page Section', 120);
}

// 构建产品锁定规则，强约束模型不要改造参考图中的产品结构。
function buildProductLockPrompt(config = {}) {
    const hasFacts = Boolean(compactDetailText(config.productFacts || '', 200));
    return `PRODUCT LOCK
- Use the uploaded reference product as the source of truth.
- Do not redesign the product or change its category, silhouette, structure, material, color, proportions, or visible details.
- Do not add any extra product elements, accessories, markings, parts, functions, or attachments unless they are clearly visible in the reference image or confirmed product facts.
- Keep all product markings, color accents, surface texture, and component placement consistent with the reference image.
- If a product detail is unclear, keep it simple or omit it instead of inventing.
${hasFacts ? '- Respect the confirmed product facts listed in PRODUCT CONTEXT; do not contradict them.' : '- No extra confirmed facts were supplied; rely on the uploaded image, product category, and module goal to infer plausible e-commerce details.'}`;
}

// 构建单个模块的执行 brief，明确这张图的目标、构图和可见文字。
function buildModuleExecutionBrief(task = {}, sellingPoints = '', config = {}) {
    const moduleTitle = getPromptModuleTitle(task);
    const role = getModuleContentRole(task);
    const compositionById = {
        m1: 'Use a clean studio or premium lifestyle setting with clear empty space for text. The product must be instantly recognizable.',
        m2: 'Use one focused benefit layout. Keep the product prominent, then add up to three large proof callouts around it. Do not repeat the hero layout.',
        m3: 'Show one believable usage context with realistic product scale, natural posture, and credible lighting. Keep text minimal.',
        m4: 'Show faithful product angles or a clean angle-view collage. Keep each view consistent with the same source product.',
        m5: 'Build a restrained lifestyle mood around the product. The product remains the anchor, not a small decorative prop.',
        m6: 'Use close-up framing for visible material, surface, control, belt, texture, seam, port, or construction details from the reference product.',
        m7: 'Use editorial spacing and restrained copy. Focus on positioning and product fit, not invented brand history.',
        m8: 'Use measurement lines, scale references, or storage layout. Prefer confirmed dimensions, and when missing infer plausible scale cues from the reference image.',
        m9: 'Use a simple objective comparison layout with few rows. Compare practical features, not exaggerated superiority.',
        m10: 'Use a clean specification card or chart. Prefer confirmed facts, and when missing infer plausible specification details from the reference image and product category.',
        m11: 'Use trust cues such as support, maintenance, package list, shipping, returns, or warranty only when supplied.',
        m12: 'Use a simple 3-4 step instructional layout with icons or small visual cues and minimal copy.'
    };
    const visibleTextById = {
        m1: 'Use one short English headline, one short support line, and up to three fact-based callouts from confirmed product information.',
        m2: 'Use one short English benefit headline and up to three large fact-based callouts. Each callout must map to one confirmed feature or visible product detail.',
        m3: 'Use little or no overlay text. If text is needed, use one short English scenario phrase.',
        m4: 'Use short English angle labels only when helpful. Avoid long paragraphs.',
        m5: 'Use one short English lifestyle phrase at most.',
        m6: 'Use short English labels for visible details only.',
        m7: 'Use restrained English editorial copy, one headline and one support line at most.',
        m8: 'Use English measurement labels from confirmed facts when available; if missing, infer plausible visual scale details.',
        m9: 'Use concise English comparison row labels and factual feature names.',
        m10: 'Use English specification labels and values from confirmed facts when available; if missing, infer plausible e-commerce specification details.',
        m11: 'Use English trust labels only for supplied support, warranty, shipping, return, maintenance, or package-list facts.',
        m12: 'Use short English step labels with minimal instruction text.'
    };
    return `SECTION GOAL
${role}

COMPOSITION
- Place the product large and clear as the main subject unless this module is a pure close-up detail section.
${compositionById[task.id] || `Create one focused visual idea for "${moduleTitle}" with clear hierarchy, large readable elements, and the product as the main subject.`}

VISIBLE TEXT
- All visible text must be ${config.language || 'English'}.
- ${visibleTextById[task.id] || 'Use concise, factual visible copy only. One headline, one support line, and up to three short callouts maximum.'}
	- Prefer Product information and Confirmed product facts. When information is missing, infer plausible e-commerce details from the reference image, product category, and module goal.
- Do not put long paragraphs, tiny fine print, repeated badges, or dense poster text in the image.`;
}

// 构建整套详情页的全局策略 brief，约束模块分工、合规、文案密度和视觉真实性。
function buildDetailPageBrief(sellingPoints, config = {}) {
    const productInfo = compactDetailText(sellingPoints, 1600);
    const platform = config.platform || 'cross-border e-commerce';
    const market = config.region || 'Global Market';
    const style = config.imageStyle || 'clean e-commerce';
    const guardrails = buildProductGuardrails(config);
    return `DETAIL PAGE BRIEF
Product information: ${productInfo}
Target platform: ${platform}
Target market: ${market}
Visual style: ${style}
${guardrails ? `\n${guardrails}` : ''}

Global strategy:
- Each section has one clear conversion job. Do not make every image repeat the full product story.
- Build a compact page flow: hero, focused benefits, believable usage, objective comparison, factual specs, and trust.
- Text density rule: one short headline, one short supporting line, maximum 3 bullets or callouts, large readable type, no tiny paragraph blocks.
- Evidence rule: prioritize supplied facts; when information is missing, infer plausible e-commerce specifications and commercial details from the reference image, product category, and module goal.
- Compliance rule: Avoid medical outcomes, body-transformation promises, fat-loss promises, guaranteed results, absolute superlatives, and unverifiable performance claims.
- Visual realism rule: keep source product identity, proportions, material, color, and scale stable. Avoid fake perspective, unrealistic human posture, and mismatched shadows.
- Mobile readability rule: avoid crowded layouts, long tables with tiny text, repeated badges, and dense poster-style stacking.`;
}

// 构建 AI 帮写卖点时使用的图片理解提示词，要求输出事实、卖点、场景和风险项。
function buildSellingPointsExtractionPrompt(imageCount = 1, productFacts = '', forbiddenClaims = '', productName = '') {
    const multiImageNote = imageCount > 1
        ? `I provided ${imageCount} product images. The first image is the primary product image and the rest are angle/detail references. Treat them as the same product unless clearly impossible.`
        : 'I provided one primary product image.';
    const normalizedProductName = compactDetailText(productName, 160);
    const productNameNote = normalizedProductName
        ? `User-provided product name: ${normalizedProductName}. Use the uploaded image evidence as the visual source of truth, and combine the uploaded image evidence with this product name to correct the product category, naming, and selling-point direction.`
        : 'No user-provided product name. Identify the product from the uploaded image evidence.';
    const guardrails = buildProductGuardrails({ productName: normalizedProductName, productFacts, forbiddenClaims });
    return `You are a senior cross-border e-commerce product strategist and visual merchandising copywriter.

Analyze the supplied product image(s) and extract a factual, conversion-ready product brief for detail-page generation.
${multiImageNote}
${productNameNote}
${guardrails ? `\n${guardrails}` : ''}

Output these sections in clear plain text:
1. Product name: concise and e-commerce friendly.
2. Product type and core use: explain what it is in one sentence.
3. Known facts: list visible or supplied facts only, including material, structure, controls, accessories, app/remote support, dimensions, capacity, speed, warranty, certifications, or specifications only when visible or provided.
4. Core selling points: 3-4 bullets. Each bullet must use "feature + user value" and avoid vague quality words.
5. Target users: specific user groups.
6. Use scenarios: specific everyday contexts.
7. Unknown or risky claims to avoid: list claims that should not be invented for this product.

Rules:
- Do not invent specifications, certifications, warranty terms, medical effects, measured performance, or app features.
- Use cautious wording for inferred benefits.
- For wellness, fitness, beauty, recovery, or health products, avoid weight-loss, medical, body-transformation, pain-treatment, or guaranteed-result claims.
- Prefer practical, verifiable benefits over hype words such as ultimate, revolutionary, transform, miracle, best, or guaranteed.
- Do not use markdown tables.`;
}

// 根据模块 ID 和序号返回当前模块的转化职责，避免不同图片重复讲同一件事。
function getModuleContentRole(task = {}) {
    const variant = Number(task.variant || 0);
    const roles = {
        m1: 'Hero: immediately state what the product is, the primary user benefit, and 2-3 proof points. Avoid vague revolution/ultimate language.',
        m3: 'Lifestyle scene: show one believable use case with realistic scale, natural lighting, and minimal overlay text.',
        m4: 'Multi-angle proof: show real product angles or faithful inferred views. Focus on appearance and construction, not marketing promises.',
        m5: 'Lifestyle mood: communicate fit with the user environment using quiet visual cues and very little text.',
        m6: 'Detail close-up: highlight material, texture, controls, belt, surface, seams, ports, or build details visible in the reference.',
        m7: 'Brand story: express product positioning with restrained editorial copy and no unsupported origin or mission claims.',
        m8: 'Size and dimensions: show scale, measurements, or storage footprint. Prefer supplied values, and infer plausible scale cues when missing.',
        m9: 'Comparison: use an objective feature table. Compare functions and convenience, not inflated superiority claims.',
        m10: 'Specifications: Prefer supplied facts or visible reference cues. If values are missing, infer plausible specification details for the product category.',
        m11: 'Trust: show after-sales, support, maintenance, shipping, returns, or package-list reassurance only if supported by supplied information.',
        m12: 'Usage guide: show a clear step-by-step use or maintenance flow with simple icons and minimal text.'
    };
    if (task.id === 'm2') {
        const benefitRoles = [
            'Benefit 1: core daily-use angle such as under-desk walking, compact home movement, or the main practical use case.',
            'Benefit 2: secondary function angle such as vibration mode, relaxation support, app/remote convenience, or control experience.',
            'Benefit 3: ownership angle such as easy storage, quiet operation, durable surface, or space-saving setup.',
            'Benefit 4: design/detail angle such as controls, non-slip surface, build quality, or multi-mode convenience.',
            'Benefit 5: audience angle such as home office users, apartment users, or light daily activity users.'
        ];
        return benefitRoles[Math.min(variant, benefitRoles.length - 1)];
    }
    return roles[task.id] || 'Focused section: communicate one specific buying reason with clear proof and restrained copy.';
}

// 根据模块 ID 和序号返回中文策略说明，供生成前预览阅读和修改方向。
function getModuleStrategyCn(task = {}) {
    const variant = Number(task.variant || 0);
    const strategies = {
        m1: {
            goal: '首屏让用户立刻看懂这是什么产品、适合谁、核心好处是什么。',
            visual: '产品主体要大，标题短，最多 2-3 个可信卖点，不要堆满参数。',
            avoid: '避免空泛口号、过度震撼词、看不清产品主体。'
        },
        m3: {
            goal: '用真实场景唤醒需求，让用户想象自己怎么用。',
            visual: '场景要可信，产品比例真实，人物姿态自然，文字少。',
            avoid: '避免夸张健身效果、AI 感人物、产品尺寸失真。'
        },
        m4: {
            goal: '展示外观和角度，降低用户看不清结构的疑虑。',
            visual: '用主图和角度素材做清晰拼图，突出正面、侧面、细节。',
            avoid: '避免生成不同型号、不同颜色或不一致外观。'
        },
        m5: {
            goal: '强化生活方式和空间氛围，提高代入感。',
            visual: '画面干净、有真实空间感，少量文案辅助即可。',
            avoid: '避免只有氛围没有产品，也避免过度装饰。'
        },
        m6: {
            goal: '证明材质、做工或关键细节，让用户觉得产品可信。',
            visual: '放大控制区、表面材质、结构、接口、跑带等可见细节。',
            avoid: '避免编造看不到的工艺、认证或材质。'
        },
        m7: {
            goal: '表达产品定位和调性，适合独立站品牌感页面。',
            visual: '更像编辑排版，克制文字，强调品牌气质和使用价值。',
            avoid: '避免虚构品牌历史、使命或奖项。'
        },
        m8: {
            goal: '说明尺寸、收纳或空间占用，消除放不下的顾虑。',
            visual: '用测量线、比例参照、收纳示意表达明确尺寸。',
            avoid: '没有确定尺寸时不要编具体数字。'
        },
        m9: {
            goal: '客观说明为什么选它，而不是单纯贬低普通产品。',
            visual: '用简洁对比表呈现功能、便利性、收纳、控制方式等差异。',
            avoid: '避免绝对化胜出、夸张优越性表达、无依据对比。'
        },
        m10: {
            goal: '集中展示确定参数，用事实消除下单前顾虑。',
            visual: '规格表要清楚、大字、少行，只展示已知事实。',
            avoid: '避免编造承重、速度、功率、认证、保修等参数。'
        },
        m11: {
            goal: '建立信任，降低售后、配送、维护和购买风险。',
            visual: '可展示保修、客服、包装清单、维护便利等已知内容。',
            avoid: '避免虚构认证、保修年限、退换政策。'
        },
        m12: {
            goal: '降低使用门槛，让用户知道买回去怎么开始用。',
            visual: '用 3-4 步流程图说明开机、模式、收纳、维护。',
            avoid: '避免复杂说明书式小字。'
        }
    };
    if (task.id === 'm2') {
        const goals = [
            ['主卖点证明', '讲最核心的日常使用价值，例如办公走路、轻运动、空间不占用。'],
            ['第二功能证明', '讲辅助功能，例如震动模式、App/遥控、控制体验。'],
            ['拥有成本证明', '讲收纳、静音、耐用、维护方便等购买后价值。'],
            ['细节信任证明', '讲控制区、防滑表面、结构细节或多模式便利性。'],
            ['人群匹配证明', '讲适合居家办公、小户型、轻运动人群等。']
        ];
        const selected = goals[Math.min(variant, goals.length - 1)];
        return {
            goal: `${selected[0]}：${selected[1]}`,
            visual: '只讲一个购买理由，标题短，最多三个大号信息点。',
            avoid: '避免每张核心卖点图都重复同一套 2-in-1 话术。'
        };
    }
    return strategies[task.id] || {
        goal: '围绕一个明确购买理由组织这一张图。',
        visual: '产品清晰、文案克制、层级明确。',
        avoid: '避免重复、堆字和无依据承诺。'
    };
}

// 构建模块 SEO 标题和 Alt 文案的提示词，并限制编造参数或高风险功效表述。
function buildSEOMetadataPrompt(task, sellingPoints, config = {}) {
    const guardrails = buildProductGuardrails(config);
    const moduleTitle = getPromptModuleTitle(task);
    return `You are an e-commerce SEO specialist. I am generating one product detail-page image module named "${moduleTitle}".
Product information: ${compactDetailText(sellingPoints, 500)}
Target platform: ${config.platform || 'cross-border e-commerce'}
Target market: ${config.region || 'Global Market'}
${guardrails ? `\n${guardrails}` : ''}

Create SEO metadata in English with Chinese reference text:
1. seoTitle: short image title containing the core product keyword.
2. altText: accessible, descriptive image alt text.

Rules:
- Do not add unsupported claims, fake specifications, certifications, warranty terms, awards, or exact performance data.
- For wellness, fitness, beauty, recovery, or health products, avoid medical, body transformation, fat loss, treatment, cure, or guaranteed-result wording.
- Keep the title natural and under 70 characters.
- Keep alt text descriptive and under 160 characters.

Return strict JSON only:
{
  "seoTitle": {"target": "English Title", "zh": "中文对照标题"},
  "altText": {"target": "English Alt Text", "zh": "中文对照alt描述"}
}`;
}

// 拼接最终发给图片模型的模块级提示词，融合模块职责、卖点、配置、合规和重绘要求。
function buildModuleGenerationPrompt(task, sellingPoints, config = {}, promptAdjustment = '') {
    const moduleTitle = getPromptModuleTitle(task);
    const productInfo = compactDetailText(sellingPoints, 1800);
    const guardrails = buildProductGuardrails(config);
    const productLock = buildProductLockPrompt(config);
    const executionBrief = buildModuleExecutionBrief(task, sellingPoints, config);
    const themeContext = config.marketingTheme && config.marketingTheme !== 'none'
        ? `Marketing theme: ${config.marketingTheme}. Integrate it lightly without overwhelming the product.`
        : 'Marketing theme: none. Keep the layout evergreen and product-led.';
    const variationRule = task.totalVariants > 1
        ? `Variant rule: this is version ${Number(task.variant || 0) + 1}/${task.totalVariants}. Do NOT repeat the same angle, headline, visual composition, or callout set used by sibling variants.`
        : 'Variant rule: one focused version only.';
    const repaintRule = promptAdjustment
        ? `User repaint instruction: ${promptAdjustment}. Apply it while preserving product identity, section role, compliance, and readability.`
        : '';

    return `IMAGE TASK
Create one professional e-commerce detail-page image section for "${moduleTitle}".
Module request: ${task.prompt}

PRODUCT CONTEXT
Product information: ${productInfo || 'No written product information supplied.'}
${guardrails ? `\n${guardrails}` : ''}

MARKET AND STYLE
- Target platform: ${config.platform || 'cross-border e-commerce'}
- Target market: ${config.region || 'Global Market'}
- Local tone: ${config.marketTone || 'clear, practical, trust-building'}
- Aspect ratio: ${config.aspectRatio || '1:1'}
- Aesthetic style: ${config.imageStyle || 'clean premium e-commerce'}
- ${themeContext}
- ${variationRule}

${productLock}

${executionBrief}

HARD RULES
- Generate one finished image only, not a wireframe or instruction sheet.
- Keep one primary visual idea, clear hierarchy, readable mobile text, consistent typography, and no overstuffed collage.
- Text density: max 1 headline, max 1 subheadline, maximum 3 bullets/callouts, no dense fine print.
- Forbidden claims: no clinical outcomes, no body-shape guarantees, no guaranteed measurable results, and no forbidden wording supplied by the user.
- If specs, dimensions, capacity, warranty, app functions, or similar commercial details are not supplied, generate plausible e-commerce details from the reference image, product category, and module goal.
- Avoid medical outcomes, body-transformation promises, fat-loss promises, absolute superlatives, and unverifiable performance claims.
- Keep shadows, perspective, scale, and human posture realistic.
${repaintRule}`.trim();
}

// 构建策略预览里展示的短模块请求和完整最终提示词，避免把两者混为一谈。
function buildStrategyPromptPreview(task, sellingPoints, config = {}) {
    const moduleRequest = String(task?.prompt || '').trim();
    return {
        moduleRequest,
        fullPrompt: buildModuleGenerationPrompt({ ...task, prompt: moduleRequest }, sellingPoints, config)
    };
}

// 根据已启用模块生成出图前策略任务列表，每个任务对应最终要生成的一张图。
function buildStrategyTasks(activeModules = [], sellingPoints = '', config = {}) {
    const tasks = [];
    activeModules.forEach(mod => {
        for (let i = 0; i < (mod.count || 1); i++) {
            const task = {
                ...mod,
                uniqueId: `${mod.id}_${i}`,
                displayTitle: mod.count > 1 ? `${mod.title} 0${i + 1}` : mod.title,
                variant: i,
                totalVariants: mod.count || 1,
                role: getModuleContentRole({ ...mod, variant: i, totalVariants: mod.count || 1 }),
                strategyCn: getModuleStrategyCn({ ...mod, variant: i, totalVariants: mod.count || 1 }),
                status: 'pending'
            };
            task.strategySummary = compactDetailText(`${task.role} ${sellingPoints}`, 260);
            tasks.push(task);
        }
    });
    return tasks;
}

// 把策略预览里手动编辑的 prompt 覆盖到任务列表，保持原任务对象不被直接修改。
function applyStrategyOverrides(tasks = [], overrides = {}) {
    return tasks.map(task => {
        const override = String(overrides?.[task.uniqueId] || '').trim();
        return override ? { ...task, prompt: override, promptOverride: override } : { ...task };
    });
}

// 根据模块状态、SEO 文案、prompt 和禁用词做本地质检，给出轻量问题标签。
function assessModuleQuality(task = {}, config = {}) {
    const issues = [];
    const text = [
        task.title,
        task.displayTitle,
        task.prompt,
        task.repaintPrompt,
        task.seo?.titleTarget,
        task.seo?.altTarget,
        task.seo?.titleZh,
        task.seo?.altZh
    ].filter(Boolean).join(' ').toLowerCase();
    const forbidden = compactDetailText(config.forbiddenClaims || '', 700).toLowerCase();
    const forbiddenTerms = forbidden
        .split(/[,，\n;/]+/)
        .map(item => item.replace(/do not mention|不要写|禁止|do not|不要/gi, '').trim())
        .filter(item => item.length >= 3);

    forbiddenTerms.forEach(term => {
        if (term && text.includes(term.toLowerCase())) {
            issues.push({ code: 'forbidden-claim', level: 'danger', label: '禁用词风险', text: `出现禁用表达：${term}` });
        }
    });
    if (/burn fat|medical recovery|fda|cure|pain relief|guaranteed result/i.test(text)) {
        issues.push({ code: 'forbidden-claim', level: 'danger', label: '高风险功效', text: '可能包含疗效、认证或保证类高风险表达' });
    }
    if (/tiny text|dense|fine print|paragraph|many labels|信息密集|小字/i.test(text)) {
        issues.push({ code: 'dense-text', level: 'warning', label: '小字/拥挤', text: '可能出现文字过密或小字不可读' });
    }
    if (task.status === 'fallback' || task.isFallback) {
        issues.push({ code: 'fallback', level: 'warning', label: '降级图', text: '图片模型失败后使用了本地降级图' });
    }
    if (!task.imageSrc) {
        issues.push({ code: 'missing-image', level: 'danger', label: '缺图', text: '该模块还没有可导出的图片' });
    }
    if ((task.title || '').includes('规格') && !compactDetailText(config.productFacts || '', 900)) {
        issues.push({ code: 'missing-facts', level: 'warning', label: '缺少事实', text: '规格模块缺少明确产品事实，容易空泛或编造' });
    }
    if (!issues.length) {
        issues.push({ code: 'usable', level: 'success', label: '可用', text: '未发现明显本地规则风险' });
    }
    return { issues };
}

// 按质检问题生成可直接放进重绘输入框的英文重绘建议。
function buildPromptRewriteSuggestion(task = {}, issues = [], config = {}) {
    const actions = [
        `Regenerate "${task.title || task.displayTitle || 'this module'}" with the same product identity.`
    ];
    if (issues.some(issue => issue.code === 'dense-text')) {
        actions.push('Reduce text density: use one short headline, one short subheadline, and no more than three large readable callouts.');
    }
    if (issues.some(issue => issue.code === 'forbidden-claim')) {
        actions.push('Remove all forbidden or unsupported claims.');
    }
    if (issues.some(issue => issue.code === 'missing-facts')) {
        actions.push('Use only confirmed facts; omit unknown specification rows instead of inventing values.');
    }
    const guardrails = buildProductGuardrails(config);
    if (guardrails) actions.push(guardrails);
    actions.push('Keep the layout clean, mobile-readable, and conversion-focused.');
    return actions.join('\n');
}

// 导出长图前检查模块完整性、降级图、缺图、重复模块和事实/禁用词风险。
function buildExportChecklist(tasks = [], config = {}) {
    const checklist = [];
    if (!tasks.length) {
        return [{ level: 'danger', text: '没有可导出的模块' }];
    }
    const titles = new Map();
    tasks.forEach(task => {
        const title = task.title || task.displayTitle || task.id;
        titles.set(title, (titles.get(title) || 0) + 1);
        if (!task.imageSrc) checklist.push({ level: 'danger', text: `${title} 缺少图片` });
        if (task.status === 'fallback' || task.isFallback) checklist.push({ level: 'warning', text: `${title} 是 fallback 降级图` });
        const quality = assessModuleQuality(task, config);
        quality.issues
            .filter(issue => issue.level !== 'success')
            .forEach(issue => checklist.push({ level: issue.level, text: `${title}: ${issue.text}` }));
    });
    titles.forEach((count, title) => {
        if (count > 1) checklist.push({ level: 'info', text: `${title} 有 ${count} 张，导出前确认是否重复` });
    });
    if (!compactDetailText(config.productFacts || '', 900)) {
        checklist.push({ level: 'info', text: '未填写产品事实/参数，规格和对比信息可能偏泛' });
    }
    return checklist.length ? checklist : [{ level: 'success', text: '导出检查未发现明显问题' }];
}

// 更新单个模块卡片的状态徽标，例如生成中、已完成、降级图或失败。
function setModuleStatus(uniqueId, status, message = '') {
    const badge = document.getElementById(`status-badge-${uniqueId}`);
    if (!badge) return;
    const styles = {
        pending: 'bg-slate-100 text-slate-500 border-slate-200',
        loading: 'bg-blue-50 text-blue-600 border-blue-100',
        success: 'bg-emerald-50 text-emerald-600 border-emerald-100',
        fallback: 'bg-amber-50 text-amber-700 border-amber-100',
        error: 'bg-red-50 text-red-600 border-red-100'
    };
    const labels = {
        pending: '等待中',
        loading: '生成中',
        success: '已完成',
        fallback: '降级图',
        error: '失败'
    };
    badge.className = `text-[10px] font-black px-2 py-0.5 rounded-full border ${styles[status] || styles.pending}`;
    badge.textContent = message || labels[status] || labels.pending;
}

// 从页面表单读取某个模块当前的 SEO 标题和 Alt 文案。
function getModuleSeo(uniqueId) {
    return {
        titleTarget: document.getElementById(`seo-title-target-${uniqueId}`)?.value || '',
        titleZh: document.getElementById(`seo-title-zh-${uniqueId}`)?.value || '',
        altTarget: document.getElementById(`alt-text-target-${uniqueId}`)?.value || '',
        altZh: document.getElementById(`alt-text-zh-${uniqueId}`)?.value || ''
    };
}

// 把生成或恢复的 SEO 标题和 Alt 文案写回模块表单。
function setModuleSeo(uniqueId, seo = {}) {
    const fields = {
        [`seo-title-target-${uniqueId}`]: seo.titleTarget || seo.seoTitle?.target || '',
        [`seo-title-zh-${uniqueId}`]: seo.titleZh || seo.seoTitle?.zh || '',
        [`alt-text-target-${uniqueId}`]: seo.altTarget || seo.altText?.target || '',
        [`alt-text-zh-${uniqueId}`]: seo.altZh || seo.altText?.zh || ''
    };
    Object.entries(fields).forEach(([id, value]) => {
        const el = document.getElementById(id);
        if (el) el.value = value;
    });
}

// 获取指定模块当前显示图片的 src，用于下载、长图排版和历史保存。
function getModuleImageSrc(uniqueId) {
    return document.getElementById(`content-mod-${uniqueId}`)?.querySelector('img')?.src || '';
}

// 获取指定模块重绘输入框中的附加提示词。
function getModulePromptAdjustment(uniqueId) {
    return document.getElementById(`regen-prompt-${uniqueId}`)?.value.trim() || '';
}

// 设置模块重绘控件的忙碌状态，防止重复提交并同步按钮文案。
function setPromptControlsBusy(uniqueId, busy) {
    const promptInput = document.getElementById(`regen-prompt-${uniqueId}`);
    const submitBtn = document.getElementById(`regen-submit-${uniqueId}`);
    if (promptInput) promptInput.disabled = busy;
    if (submitBtn) {
        submitBtn.disabled = busy;
        submitBtn.innerHTML = busy
            ? '<span class="loader border-white border-t-transparent w-3 h-3"></span><span>重绘中</span>'
            : '<i class="ph ph-magic-wand text-sm"></i><span>按提示重绘</span>';
    }
}

// 渲染单个模块下方的 Prompt Repaint 输入区和提交按钮。
function renderPromptRegenerationControls(uniqueId) {
    const safeId = detailEscapeHtml(uniqueId);
    return `
        <div class="border-t border-gray-100 bg-white px-4 py-3 flex flex-col gap-2">
            <div class="flex items-center justify-between gap-3">
                <div class="flex items-center gap-1.5 min-w-0">
                    <i class="ph ph-magic-wand text-blue-500"></i>
                    <span class="text-xs font-black text-gray-700 uppercase tracking-widest">Prompt Repaint</span>
                </div>
                <button id="regen-submit-${safeId}" onclick="regenerateModuleWithPrompt('${safeId}')" class="flex items-center justify-center gap-1.5 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 px-3 py-1.5 rounded shadow-sm transition-all active:scale-95 whitespace-nowrap">
                    <i class="ph ph-magic-wand text-sm"></i><span>按提示重绘</span>
                </button>
            </div>
            <textarea id="regen-prompt-${safeId}" class="w-full text-xs leading-relaxed px-3 py-2 border border-gray-200 rounded bg-slate-50 outline-none focus:border-blue-400 focus:bg-white resize-none" rows="2" placeholder="输入想调整的画面要求，例如：背景换成厨房使用场景，产品主体更大，光线更自然"></textarea>
        </div>`;
}

// 渲染模块本地质检结果和重绘建议入口。
function renderModuleQualityPanel(uniqueId) {
    const task = globalGenContext?.tasks?.[uniqueId];
    const container = document.getElementById(`quality-panel-${uniqueId}`);
    if (!task || !container) return;
    const quality = assessModuleQuality(task, globalGenContext?.config || {});
    container.innerHTML = `
        <div class="flex items-center justify-between gap-2">
            <div class="flex flex-wrap gap-1.5">
                ${quality.issues.map(issue => {
                    const cls = issue.level === 'danger'
                        ? 'bg-red-50 text-red-600 border-red-100'
                        : issue.level === 'warning'
                            ? 'bg-amber-50 text-amber-700 border-amber-100'
                            : issue.level === 'success'
                                ? 'bg-emerald-50 text-emerald-600 border-emerald-100'
                                : 'bg-slate-50 text-slate-500 border-slate-100';
                    return `<span title="${detailEscapeHtml(issue.text)}" class="text-[10px] font-bold px-2 py-1 rounded border ${cls}">${detailEscapeHtml(issue.label)}</span>`;
                }).join('')}
            </div>
            <button onclick="fillRewriteSuggestion('${detailEscapeHtml(uniqueId)}')" class="text-[10px] font-bold text-blue-600 bg-blue-50 hover:bg-blue-100 border border-blue-100 px-2 py-1 rounded">重绘建议</button>
        </div>`;
}

// 根据本地质检结果生成重绘提示词，并填入当前模块的重绘输入框。
function fillRewriteSuggestion(uniqueId) {
    const task = globalGenContext?.tasks?.[uniqueId];
    if (!task) return;
    const quality = assessModuleQuality(task, globalGenContext?.config || {});
    const suggestion = buildPromptRewriteSuggestion(task, quality.issues, globalGenContext?.config || {});
    const input = document.getElementById(`regen-prompt-${uniqueId}`);
    if (input) {
        input.value = suggestion;
        input.focus();
    }
    showToast('已生成重绘建议', 'success');
}

// 按用户输入的重绘提示词重新生成单个模块图片和 SEO。
async function regenerateModuleWithPrompt(uniqueId) {
    const promptAdjustment = getModulePromptAdjustment(uniqueId);
    if (!promptAdjustment) {
        showToast('请输入重绘提示词', 'warning');
        document.getElementById(`regen-prompt-${uniqueId}`)?.focus();
        return;
    }

    setPromptControlsBusy(uniqueId, true);
    try {
        await generateSingleWrap(uniqueId, false, promptAdjustment);
        showToast('已按提示重绘', 'success');
    } catch (error) {
        console.error(error);
        showToast('重绘失败', 'error');
    } finally {
        setPromptControlsBusy(uniqueId, false);
    }
}

// 校验 AI 返回的长图排序 ID，去重、过滤非法 ID，并自动补齐遗漏模块。
function validateSortedIds(sortedIds, expectedIds) {
    if (!Array.isArray(sortedIds)) return null;
    const expected = new Set(expectedIds);
    const clean = [];
    sortedIds.forEach(id => {
        if (expected.has(id) && !clean.includes(id)) clean.push(id);
    });
    expectedIds.forEach(id => {
        if (!clean.includes(id)) clean.push(id);
    });
    return clean.length === expectedIds.length ? clean : null;
}

// 解析 data URL 图片，拆出 MIME 类型和 base64 数据。
function parseImageDataUrl(dataUrl) {
    if (!dataUrl || !dataUrl.includes(',')) return null;
    return {
        mimeType: dataUrl.split(';')[0].split(':')[1],
        data: dataUrl.split(',')[1]
    };
}

// 把远程或本地图片 URL 转成 data URL，方便作为模型内联图片输入。
async function imageUrlToDataUrl(src) {
    if (!src || src.startsWith('data:image')) return src;
    const response = await fetch(formatImgSrc(src));
    if (!response.ok) throw new Error(`图片读取失败: ${response.status}`);
    const blob = await response.blob();
    return await fileToDataUrl(blob);
}

// 确保图片对象包含模型调用需要的 mimeType 和 base64 data 字段。
async function ensureInlineImageData(image) {
    if (!image) return null;
    if (image.data && image.mimeType) return image;
    const dataUrl = await imageUrlToDataUrl(image.base64 || image.imageSrc || '');
    const parsed = parseImageDataUrl(dataUrl);
    if (!parsed) return null;
    return {
        ...image,
        base64: dataUrl,
        mimeType: parsed.mimeType,
        data: parsed.data
    };
}

// 读取浏览器 File/Blob 并转换为 data URL。
function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = e => resolve(e.target.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

// 获取当前主图素材，兼容新版多图数组和旧版单图字段。
function getPrimaryUploadedImage() {
    if (Array.isArray(currentUploadedImages) && currentUploadedImages.length) {
        return currentUploadedImages[0];
    }
    return currentUploadedBase64 ? {
        id: 'primary_legacy',
        name: '主图',
        base64: currentUploadedBase64,
        isPrimary: true,
        ...parseImageDataUrl(currentUploadedBase64)
    } : null;
}

// 获取除主图以外的角度或细节素材。
function getAngleUploadedImages() {
    return Array.isArray(currentUploadedImages) ? currentUploadedImages.slice(1) : [];
}

// 渲染已上传素材的缩略图、主图标记、设为主图按钮和删除按钮。
function renderUploadedImagePreviews() {
    const container = document.getElementById('imagePreviewContainer');
    if (!container) return;

    if (!currentUploadedImages.length) {
        container.innerHTML = '';
        container.classList.add('hidden');
        container.classList.remove('flex');
        return;
    }

    container.classList.remove('hidden');
    container.classList.add('flex');
    container.innerHTML = currentUploadedImages.map((img, index) => `
        <div class="w-[112px] rounded-lg border border-gray-200 bg-gray-50 overflow-hidden relative group shadow-inner p-1">
            <div class="relative w-full h-[82px] overflow-hidden rounded bg-white">
                <img src="${detailEscapeHtml(img.base64)}" alt="${detailEscapeHtml(img.name || 'Product')}" class="w-full h-full object-cover">
                <span class="absolute left-1 bottom-1 text-[9px] font-black px-1.5 py-0.5 rounded bg-black/60 text-white">${index === 0 ? '主图' : `素材${index}`}</span>
            </div>
            <select onchange="updateImageRole(${index}, this.value)" class="mt-1 w-full text-[10px] border border-gray-200 rounded bg-white px-1 py-0.5 outline-none">
                ${[
                    ['primary', '主图'],
                    ['angle', '角度/外观'],
                    ['detail', '细节/材质'],
                    ['scene', '场景参考'],
                    ['spec', '尺寸/参数'],
                    ['package', '包装/配件']
                ].map(([value, label]) => `<option value="${value}" ${(img.role || (index === 0 ? 'primary' : 'angle')) === value ? 'selected' : ''}>${label}</option>`).join('')}
            </select>
            ${index > 0 ? `<button onclick="setPrimaryImage(${index})" title="设为主图"
                class="absolute left-1 top-1 bg-white/90 text-blue-600 rounded px-1.5 py-0.5 text-[9px] font-black opacity-0 group-hover:opacity-100 transition-opacity">主图</button>` : ''}
            <button onclick="removeImage(${index})"
                class="absolute top-1 right-1 bg-black/60 text-white rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity"><i
                    class="ph ph-x text-xs"></i></button>
        </div>
    `).join('');
}

// 更新某张上传素材的角色，用于后续按模块优先选择参考图。
function updateImageRole(index, role) {
    if (!Array.isArray(currentUploadedImages) || !currentUploadedImages[index]) return;
    currentUploadedImages[index] = { ...currentUploadedImages[index], role };
    if (index === 0 && role !== 'primary') {
        currentUploadedImages[index].role = 'primary';
        showToast('第一张固定为主图角色', 'info');
    }
    renderUploadedImagePreviews();
}

// 将某张角度素材移动为主图，并重新渲染上传预览。
function setPrimaryImage(index) {
    if (!Array.isArray(currentUploadedImages) || index <= 0 || index >= currentUploadedImages.length) return;
    const [selected] = currentUploadedImages.splice(index, 1);
    currentUploadedImages.unshift(selected);
    currentUploadedImages = currentUploadedImages.map((img, idx) => ({ ...img, isPrimary: idx === 0, role: idx === 0 ? 'primary' : (img.role === 'primary' ? 'angle' : img.role || 'angle') }));
    currentUploadedBase64 = currentUploadedImages[0]?.base64 || null;
    renderUploadedImagePreviews();
    showToast('已设为主图', 'success');
}

// 根据模块类型选择传给模型的图片素材，多角度模块会带上更多角度参考图。
function getImagesForTask(task) {
    const primaryImage = globalGenContext.primaryImage;
    const angleImages = globalGenContext.angleImages || [];
    const byRole = role => angleImages.filter(img => img.role === role);
    let preferred = [];
    if (task.id === 'm3' || task.id === 'm5') preferred = byRole('scene');
    else if (task.id === 'm6') preferred = byRole('detail');
    else if (task.id === 'm8' || task.id === 'm10') preferred = byRole('spec');
    else if (task.id === 'm11') preferred = byRole('package');
    else if (task.id === 'm4') preferred = byRole('angle');
    const fallback = task.id === 'm4' ? angleImages : [];
    return primaryImage ? [primaryImage, ...preferred, ...fallback].slice(0, 6) : [];
}

// 初始化模块选择网格，显示模块卡片、启用状态和张数控制。
function initModules() {
    const grid = document.getElementById('moduleGrid');
    if (!grid) return;
    grid.innerHTML = '';
    modules.forEach(mod => {
        const activeClasses = mod.active ? 'border-blue-500 bg-blue-50 shadow-sm' : 'border-gray-200 bg-white hover:border-blue-300';
        const titleClasses = mod.active ? 'text-blue-600' : 'text-gray-700';
        const iconHTML = mod.active ? `<i class="ph-fill ph-check-circle text-blue-500 absolute top-2 right-2 text-sm"></i>` : '';

        let countControlHTML = '';
        if (mod.active) {
            countControlHTML = `
                <div class="mt-2 pt-2 border-t border-blue-100 flex items-center justify-between" onclick="event.stopPropagation()">
                    <span class="text-[10px] text-gray-500">张数</span>
                    <div class="flex items-center bg-white rounded border border-gray-200">
                        <button onclick="updateModuleCount('${mod.id}', -1)" class="w-6 h-5 flex items-center justify-center text-gray-400 hover:text-blue-600 disabled:opacity-30" ${mod.count <= 1 ? 'disabled' : ''}><i class="ph ph-minus text-[10px]"></i></button>
                        <span class="text-[10px] font-bold w-4 text-center">${mod.count}</span>
                        <button onclick="updateModuleCount('${mod.id}', 1)" class="w-6 h-5 flex items-center justify-center text-gray-400 hover:text-blue-600 disabled:opacity-30" ${mod.count >= 5 ? 'disabled' : ''}><i class="ph ph-plus text-[10px]"></i></button>
                    </div>
                </div>`;
        }

        grid.insertAdjacentHTML('beforeend', `
            <div onclick="toggleModule('${mod.id}')" class="relative cursor-pointer border rounded-lg p-2.5 transition-all flex flex-col justify-between ${activeClasses}">
                ${iconHTML}
                <div>
                    <div class="text-xs font-bold ${titleClasses} mb-0.5">${mod.title}</div>
                    <div class="text-[10px] text-gray-400 truncate pr-4">${mod.subtitle}</div>
                </div>
                ${countControlHTML}
            </div>`);
    });
}

// 获取当前已启用模块对应的策略任务，并合并手动 prompt 覆盖。
function getCurrentStrategyTasks() {
    const config = getDetailConfig();
    if (!config) return null;
    const sellingPoints = document.getElementById('sellingPointsText')?.value || '';
    const activeModules = modules.filter(m => m.active);
    return applyStrategyOverrides(
        buildStrategyTasks(activeModules, sellingPoints, config),
        typeof detailStrategyOverrides === 'object' ? detailStrategyOverrides : {}
    );
}

// 打开生成前策略预览弹窗，允许编辑每个模块本次使用的 prompt。
function openStrategyPreview() {
    const modal = document.getElementById('detailStrategyModal');
    if (modal && modal.parentElement !== document.body) {
        document.body.appendChild(modal);
    }
    const tasks = getCurrentStrategyTasks();
    if (!tasks || !tasks.length) {
        showToast('请至少选择一个模块', 'error');
        return;
    }
    const container = document.getElementById('detailStrategyContent');
    if (!container) return;
    const config = getDetailConfig();
    const sellingPoints = document.getElementById('sellingPointsText')?.value.trim() || '';
    currentStrategyPreviewContext = { tasks, sellingPoints, config };
    container.innerHTML = tasks.map(task => {
        const promptPreview = buildStrategyPromptPreview(task, sellingPoints, config || {});
        return `
        <div class="border border-gray-200 rounded-xl p-4 bg-white shadow-sm">
            <div class="flex items-start justify-between gap-3 mb-3">
                <div>
                    <div class="text-sm font-black text-gray-800">${detailEscapeHtml(task.displayTitle)}</div>
                    <div class="text-[11px] text-gray-600 mt-1 leading-relaxed">${detailEscapeHtml(task.strategyCn?.goal || '')}</div>
                </div>
                <span class="text-[10px] font-bold text-blue-600 bg-blue-50 border border-blue-100 px-2 py-1 rounded">${detailEscapeHtml(task.subtitle || '')}</span>
            </div>
            <div class="grid grid-cols-2 gap-3 mb-3">
                <div class="bg-slate-50 border border-slate-100 rounded-lg p-3">
                    <div class="text-[10px] font-black text-slate-400 mb-1">画面方向</div>
                    <div class="text-xs text-slate-700 leading-relaxed">${detailEscapeHtml(task.strategyCn?.visual || '')}</div>
                </div>
                <div class="bg-red-50/50 border border-red-100 rounded-lg p-3">
                    <div class="text-[10px] font-black text-red-400 mb-1">避免事项</div>
                    <div class="text-xs text-red-700 leading-relaxed">${detailEscapeHtml(task.strategyCn?.avoid || '')}</div>
                </div>
            </div>
            <details class="group">
                <summary class="cursor-pointer text-[11px] font-bold text-blue-600 hover:text-blue-700 select-none">编辑模块请求</summary>
                <div class="mt-2 text-[10px] font-bold text-gray-400">这段是模块方向，会被拼进下面的完整最终 Prompt。</div>
                <textarea data-strategy-id="${detailEscapeHtml(task.uniqueId)}" rows="3"
                    oninput="updateStrategyFullPrompt('${detailEscapeHtml(task.uniqueId)}')"
                    class="mt-1 w-full text-xs leading-relaxed border border-gray-200 rounded-lg p-3 outline-none focus:border-blue-500 resize-none bg-slate-50">${detailEscapeHtml(promptPreview.moduleRequest)}</textarea>
            </details>
            <details class="group mt-3">
                <summary class="cursor-pointer text-[11px] font-bold text-slate-600 hover:text-slate-800 select-none">查看完整最终 Prompt</summary>
                <div class="mt-2 text-[10px] font-bold text-gray-400">这是实际发送给图片模型的完整提示词预览，包含商品信息、平台、风格、禁用词和生成约束。</div>
                <textarea data-full-prompt-id="${detailEscapeHtml(task.uniqueId)}" rows="10" readonly
                    class="mt-1 w-full text-xs leading-relaxed border border-gray-200 rounded-lg p-3 outline-none bg-gray-50 text-gray-600 resize-y">${detailEscapeHtml(promptPreview.fullPrompt)}</textarea>
            </details>
        </div>
    `;
    }).join('');
    modal?.classList.remove('hidden');
}

// 根据当前编辑的模块请求实时刷新完整最终 Prompt 预览。
function updateStrategyFullPrompt(uniqueId) {
    const context = currentStrategyPreviewContext;
    if (!context) return;
    const task = context.tasks.find(item => item.uniqueId === uniqueId);
    const moduleField = document.querySelector(`[data-strategy-id="${CSS.escape(uniqueId)}"]`);
    const fullField = document.querySelector(`[data-full-prompt-id="${CSS.escape(uniqueId)}"]`);
    if (!task || !moduleField || !fullField) return;
    const promptPreview = buildStrategyPromptPreview(
        { ...task, prompt: moduleField.value },
        context.sellingPoints,
        context.config || {}
    );
    fullField.value = promptPreview.fullPrompt;
}

// 关闭生成前策略预览弹窗。
function closeStrategyPreview() {
    document.getElementById('detailStrategyModal')?.classList.add('hidden');
}

// 应用策略预览里编辑过的模块 prompt 覆盖。
function applyStrategyPreview() {
    const fields = document.querySelectorAll('[data-strategy-id]');
    fields.forEach(field => {
        const id = field.dataset.strategyId;
        const value = field.value.trim();
        if (id && value) detailStrategyOverrides[id] = value;
    });
    closeStrategyPreview();
    showToast('已应用本次生成策略', 'success');
}

// 切换某个详情页模块的启用状态。
function toggleModule(id) {
    const mod = modules.find(m => m.id === id);
    if (mod) { mod.active = !mod.active; initModules(); }
}

// 调整模块生成张数，并限制在允许范围内。
function updateModuleCount(id, delta) {
    const mod = modules.find(m => m.id === id);
    if (mod) {
        let newCount = mod.count + delta;
        if (newCount >= 1 && newCount <= 5) { mod.count = newCount; initModules(); }
    }
}

// 根据比例下拉状态显示或隐藏自定义宽高比输入区。
function toggleCustomRatio() {
    const select = document.getElementById('aspectRatioSelect');
    const container = document.getElementById('customRatioContainer');
    if (select.value === 'custom') {
        container.classList.remove('hidden'); container.classList.add('grid');
    } else {
        container.classList.add('hidden'); container.classList.remove('grid');
    }
}

// ====== 图像上传处理 ======
// 处理用户上传的主图和角度素材，完成类型/大小校验、base64 转换和预览刷新。
async function handleImageUpload(event) {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;
    const remainingSlots = DETAIL_MAX_UPLOAD_IMAGES - currentUploadedImages.length;
    if (remainingSlots <= 0) {
        showToast(`最多上传 ${DETAIL_MAX_UPLOAD_IMAGES} 张素材`, 'warning');
        event.target.value = '';
        return;
    }
    const selectedFiles = files.slice(0, remainingSlots);
    if (files.length > remainingSlots) {
        showToast(`最多保留 ${DETAIL_MAX_UPLOAD_IMAGES} 张素材，已自动忽略多余图片`, 'warning');
    }

    const validFiles = [];
    for (const file of selectedFiles) {
        if (!file.type.startsWith('image/')) {
            showToast('请上传图片文件', 'error');
            event.target.value = '';
            return;
        }
        if (file.size > DETAIL_IMAGE_MAX_BYTES) {
            showToast('图片过大，请压缩到 8MB 以内', 'error');
            event.target.value = '';
            return;
        }
        validFiles.push(file);
    }

    try {
        const uploaded = await Promise.all(validFiles.map(async (file) => {
            const base64 = await fileToDataUrl(file);
            return {
                id: `detail_img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                name: file.name,
                base64,
                isPrimary: false,
                ...parseImageDataUrl(base64)
            };
        }));
        currentUploadedImages = [...currentUploadedImages, ...uploaded]
            .slice(0, DETAIL_MAX_UPLOAD_IMAGES)
            .map((img, index) => ({ ...img, isPrimary: index === 0, role: index === 0 ? 'primary' : img.role || 'angle' }));
        currentUploadedBase64 = currentUploadedImages[0]?.base64 || null;
        renderUploadedImagePreviews();
        const angleCount = Math.max(0, currentUploadedImages.length - 1);
        showToast(angleCount ? `已上传 ${currentUploadedImages.length} 张素材，多角度图将优先使用角度素材` : '主图素材上传成功', 'success');
    } catch (e) {
        console.error(e);
        showToast('图片读取失败', 'error');
    } finally {
        event.target.value = '';
    }
}

// 删除单张或全部上传素材，并同步主图状态和预览。
function removeImage(index = null) {
    if (index === null || index === undefined) {
        currentUploadedImages = [];
    } else {
        currentUploadedImages.splice(index, 1);
        currentUploadedImages = currentUploadedImages.map((img, idx) => ({ ...img, isPrimary: idx === 0, role: idx === 0 ? 'primary' : (img.role === 'primary' ? 'angle' : img.role || 'angle') }));
    }
    currentUploadedBase64 = currentUploadedImages[0]?.base64 || null;
    document.getElementById('imageUpload').value = '';
    renderUploadedImagePreviews();
}

// ====== 生成逻辑 ======
// 调用文本模型从上传图片中提取产品事实、核心卖点、适用人群、场景和风险提示。
async function generateSellingPoints() {
    const logMsg = "开始提取核心卖点...";
    console.log(`%c[详情页] ${logMsg}`, "color: #6366f1; font-weight: bold;");
    remoteLog(logMsg);
    const btn = document.getElementById('aiWriteBtn');
    const textArea = document.getElementById('sellingPointsText');
    const origHtml = btn.innerHTML;
    btn.innerHTML = '<span class="loader w-3 h-3 border-2 border-blue-500 border-t-transparent mr-1"></span> 生成中...';
    btn.disabled = true;

    const sellingPointImages = [getPrimaryUploadedImage(), ...getAngleUploadedImages().slice(0, 2)].filter(Boolean);
    const productName = document.getElementById('productNameInput')?.value.trim() || '';
    const productFacts = document.getElementById('productFactsText')?.value.trim() || '';
    const forbiddenClaims = document.getElementById('forbiddenClaimsText')?.value.trim() || '';
    let parts = [{ text: buildSellingPointsExtractionPrompt(sellingPointImages.length || 1, productFacts, forbiddenClaims, productName) }];
    if (sellingPointImages.length) {
        if (sellingPointImages.length > 1) {
            parts[0].text += `\n\n我同时提供了 ${sellingPointImages.length} 张商品素材。第一张是主图，后续为角度/细节参考。请综合判断，但不要把不同角度误认为不同产品。`;
        }
        sellingPointImages.forEach(img => {
            parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
        });
    } else { showToast('未上传图片，将仅使用预设文案测试', 'info'); }

    try {
        const payload = { contents: [{ role: "user", parts: parts }] };
        remoteLog(`正在提取产品卖点 (视觉解析模式)...`);
        const res = await callAI("text", payload);
        const text = res.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
            textArea.value = text;
            showToast('卖点提取成功', 'success');
            remoteLog(`卖点提取成功: ${text.substring(0, 50)}...`);
        }
    } catch (err) {
        console.error(err); showToast('生成失败', 'error');
        remoteLog(`卖点提取失败: ${err.message}`);
    } finally {
        btn.innerHTML = origHtml; btn.disabled = false;
    }
}

// 调用文本模型为单个详情页模块生成 SEO 标题和 Alt 文案。
async function generateSEOMetadata(task, sellingPoints) {
    const prompt = buildSEOMetadataPrompt(task, sellingPoints, globalGenContext?.config || {});

    try {
        remoteLog(`正在为模块 [${task.title}] 生成 SEO 元数据...`);
        const res = await callAI("text", {
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json" }
        });
        const text = res.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
            const data = JSON.parse(text);
            const getVal = (obj) => typeof obj === 'string' ? { target: obj, zh: '' } : { target: obj?.target || '', zh: obj?.zh || '' };

            const titleData = getVal(data.seoTitle);
            const altData = getVal(data.altText);
            const seo = {
                titleTarget: titleData.target,
                titleZh: titleData.zh,
                altTarget: altData.target,
                altZh: altData.zh
            };
            setModuleSeo(task.uniqueId, seo);
            task.seo = seo;
            remoteLog(`模块 [${task.title}] SEO 元数据生成成功`);
            return seo;
        }
    } catch (e) {
        console.warn("SEO Gen Fail:", e);
        remoteLog(`模块 [${task.title}] SEO 生成失败: ${e.message}`);
    }
    return null;
}

// 启动整套详情页生成流程：校验输入、创建任务队列、并发生成模块并渲染结果区。
async function generateAIPage() {
    const activeModules = modules.filter(m => m.active);
    if (!activeModules.length) { showToast('请至少选择一个模块', 'error'); return; }
    const primaryImage = getPrimaryUploadedImage();
    const angleImages = getAngleUploadedImages();
    if (!primaryImage) { showToast('请先上传一张主图素材', 'error'); return; }
    const totalTaskCount = activeModules.reduce((sum, mod) => sum + (mod.count || 1), 0);
    if (totalTaskCount > DETAIL_MAX_TASKS) {
        showToast(`当前共 ${totalTaskCount} 张，建议控制在 ${DETAIL_MAX_TASKS} 张以内`, 'error');
        return;
    }

    const sellingPoints = document.getElementById('sellingPointsText').value;
    if (!sellingPoints) { showToast('请填写核心卖点', 'error'); return; }

    const startMsg = `开始详情页全案生成流程 | 出图总数: ${totalTaskCount} | 并发控制: ${CONCURRENCY_LIMIT}`;
    console.log(`%c[详情页] ${startMsg}`, "color: #4f46e5; font-weight: bold;");
    remoteLog(startMsg);

    const config = getDetailConfig();
    if (!config) return;

    globalGenContext = {
        base64Data: primaryImage.data,
        mimeType: primaryImage.mimeType,
        primaryImage,
        angleImages,
        uploadedImages: [primaryImage, ...angleImages],
        sellingPoints,
        config,
        tasks: {},
        longImageOrder: []
    };

    let taskQueue = applyStrategyOverrides(
        buildStrategyTasks(activeModules, sellingPoints, config),
        typeof detailStrategyOverrides === 'object' ? detailStrategyOverrides : {}
    );
    taskQueue.forEach(task => {
        globalGenContext.tasks[task.uniqueId] = task;
        globalGenContext.longImageOrder.push(task.uniqueId);
    });

    document.getElementById('showcaseArea').classList.add('hidden');
    const resArea = document.getElementById('resultArea');
    resArea.classList.remove('hidden'); resArea.classList.add('flex');

    const container = document.getElementById('modulesResultContainer');
    container.innerHTML = '';

    const ratioStr = config.aspectRatio.replace(':', '/');
    taskQueue.forEach(task => {
        container.innerHTML += `
            <div id="result-mod-${task.uniqueId}" class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden flex flex-col group">
                <div class="bg-gray-50/80 px-5 py-3 border-b border-gray-100 flex justify-between items-center backdrop-blur">
                    <div class="flex items-center gap-2">
                        <span class="w-1.5 h-4 bg-blue-500 rounded-full"></span>
                        <span class="font-bold text-gray-700 text-sm">${detailEscapeHtml(task.displayTitle)}</span>
                        <span id="status-badge-${task.uniqueId}" class="text-[10px] font-black px-2 py-0.5 rounded-full border bg-slate-100 text-slate-500 border-slate-200">等待中</span>
                    </div>
                    <div class="flex items-center gap-2">
                        <span class="text-xs text-gray-400 mr-2">${detailEscapeHtml(task.subtitle)}</span>
                        <button id="regen-btn-${task.uniqueId}" onclick="generateSingleWrap('${task.uniqueId}')" class="hidden flex items-center justify-center w-7 h-7 rounded bg-white border border-gray-200 text-gray-500 hover:text-blue-600 transition-colors shadow-sm" title="重绘图像并刷新 SEO"><i class="ph ph-arrows-clockwise text-sm"></i></button>
                    </div>
                </div>
                <div id="content-mod-${task.uniqueId}" class="p-6 flex flex-col items-center justify-center relative bg-[url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyMCIgaGVpZ2h0PSIyMCI+PHJlY3Qgd2lkdGg9IjIwIiBoZWlnaHQ9IjIwIiBmaWxsPSIjZmZmIi8+PGNpcmNsZSBjeD0iMTAiIGN5PSIxMCIgcj0iMSIgZmlsbD0iI2YxZjFmMSIvPjwvc3ZnPg==')]" style="aspect-ratio: ${ratioStr}; min-height: 200px;">
                    <span class="loader border-blue-500 border-t-transparent w-8 h-8 mb-3"></span><span class="text-sm text-gray-500 font-medium tracking-wide">AI引擎构图中...</span>
                </div>
                ${renderPromptRegenerationControls(task.uniqueId)}
                <div id="quality-panel-${task.uniqueId}" class="border-t border-gray-100 bg-white px-4 py-3"></div>
                <div class="border-t border-gray-100 bg-slate-50 p-4 flex flex-col gap-3">
                    <div class="flex items-center justify-between">
                        <div class="flex items-center gap-1.5"><i class="ph-fill ph-link text-blue-500"></i><span class="text-xs font-black text-gray-700 uppercase tracking-widest">SEO Meta-Data</span></div>
                        <button onclick="downloadModule('${task.uniqueId}', '${task.displayTitle}')" class="text-xs flex items-center gap-1 text-gray-500 hover:text-indigo-600 font-bold bg-white border border-gray-200 px-2 py-1 rounded shadow-sm transition-all active:scale-95"><i class="ph ph-download-simple"></i> 单存</button>
                    </div>
                    <div class="flex flex-col gap-2.5">
                        <div class="flex items-center gap-2">
                            <span class="text-[10px] font-bold text-gray-400 w-6">Title</span>
                            <div class="relative flex-1">
                                <input type="text" id="seo-title-target-${task.uniqueId}" class="w-full text-xs pl-2 pr-8 py-1.5 border border-gray-200 rounded outline-none focus:border-blue-400 bg-white shadow-inner" placeholder="English Title" readonly>
                                <button onclick="copyText('seo-title-target-${task.uniqueId}')" class="absolute inset-y-0 right-0 pr-2 flex items-center text-gray-400 hover:text-blue-600"><i class="ph ph-copy"></i></button>
                            </div>
                            <div class="relative flex-1">
                                <input type="text" id="seo-title-zh-${task.uniqueId}" class="w-full text-xs pl-2 pr-8 py-1.5 border border-gray-200 rounded outline-none focus:border-blue-400 bg-white shadow-inner text-gray-500" placeholder="中文标题" readonly>
                            </div>
                        </div>
                        <div class="flex items-start gap-2">
                            <span class="text-[10px] font-bold text-gray-400 w-6 mt-1">Alt</span>
                            <div class="relative flex-1">
                                <textarea id="alt-text-target-${task.uniqueId}" class="w-full text-xs pl-2 pr-8 py-1.5 border border-gray-200 rounded outline-none focus:border-blue-400 bg-white shadow-inner resize-none hide-scroll" rows="2" placeholder="English Alt" readonly></textarea>
                                <button onclick="copyText('alt-text-target-${task.uniqueId}')" class="absolute top-1 right-0 pr-2 flex items-start text-gray-400 hover:text-blue-600"><i class="ph ph-copy"></i></button>
                            </div>
                            <div class="relative flex-1">
                                <textarea id="alt-text-zh-${task.uniqueId}" class="w-full text-xs pl-2 pr-8 py-1.5 border border-gray-200 rounded outline-none focus:border-blue-400 bg-white shadow-inner resize-none hide-scroll text-gray-500" rows="2" placeholder="中文描述" readonly></textarea>
                            </div>
                        </div>
                    </div>
                </div>
            </div>`;
    });

    const btn = document.getElementById('generateBtn');
    const origBtnHtml = btn.innerHTML;
    btn.innerHTML = '<span class="loader mr-2 border-white border-t-transparent w-4 h-4"></span> 正在启动并发渲染引擎...';
    btn.disabled = true;

    const activeTasks = [];
    let completedCount = 0;
    let successCount = 0;
    let fallbackCount = 0;
    let errorCount = 0;

    for (let i = 0; i < taskQueue.length; i++) {
        if (activeTasks.length >= CONCURRENCY_LIMIT) {
            await Promise.race(activeTasks);
        }

        const task = taskQueue[i];
        const submitMsg = `正在提交任务 [${task.title}] (${i + 1}/${taskQueue.length})`;
        console.log(`%c[详情页] ${submitMsg}`, "color: #8b5cf6;");
        remoteLog(submitMsg);

        const taskPromise = (async () => {
            try {
                const result = await generateSingleWrap(task.uniqueId);
                if (result?.status === 'success') successCount++;
                else if (result?.status === 'fallback') fallbackCount++;
                else errorCount++;
                const finishMsg = `模块 [${task.title}] 渲染成功`;
                console.log(`%c[详情页] ${finishMsg}`, "color: #10b981;");
                remoteLog(finishMsg);
            } catch (e) {
                errorCount++;
                console.error(`Task ${task.uniqueId} failed:`, e);
                setModuleStatus(task.uniqueId, 'error');
                remoteLog(`模块 [${task.title}] 渲染异常: ${e.message}`);
            } finally {
                completedCount++;
                btn.innerHTML = `<span class="loader mr-2 border-white border-t-transparent w-4 h-4"></span> 正在并行渲染 (${completedCount}/${taskQueue.length})...`;
            }
        })();

        activeTasks.push(taskPromise);
        taskPromise.finally(() => {
            const idx = activeTasks.indexOf(taskPromise);
            if (idx > -1) activeTasks.splice(idx, 1);
        });

        if (i < taskQueue.length - 1) {
            await new Promise(r => setTimeout(r, STAGGER_DELAY));
        }
    }

    await Promise.all(activeTasks);
    btn.innerHTML = origBtnHtml; btn.disabled = false;
    const summary = `生成完成：成功 ${successCount}，降级 ${fallbackCount}，失败 ${errorCount}`;
    showToast(summary, errorCount ? 'warning' : (fallbackCount ? 'warning' : 'success'));
    remoteLog(`详情页全案生成结束 | ${summary}`);
}

// 生成或重绘单个详情页模块图片，失败时降级为本地 HTML/CSS 占位图。
async function generateSingleWrap(uniqueId, skipSEO = false, promptAdjustment = '') {
    const task = globalGenContext.tasks[uniqueId];
    if (!task) return;

    remoteLog(`开始渲染模块: ${task.title}`);
    if (promptAdjustment) {
        task.repaintPrompt = promptAdjustment;
        remoteLog(`模块 [${task.title}] 使用自定义提示词重绘`);
    }
    const contentDiv = document.getElementById(`content-mod-${uniqueId}`);
    if (!contentDiv) return;

    setModuleStatus(uniqueId, 'loading');
    task.status = 'loading';
    task.error = '';
    contentDiv.innerHTML = `<span class="loader border-blue-500 border-t-transparent w-8 h-8 mb-3"></span><span class="text-sm text-gray-500 font-medium">AI引擎构图中...</span>`;
    document.getElementById(`regen-btn-${uniqueId}`)?.classList.add('hidden');
    contentDiv.classList.add('p-6', 'flex-col', 'items-center', 'justify-center');
    contentDiv.style.padding = '';

    const { sellingPoints, config } = globalGenContext;
    const taskImages = (await Promise.all(getImagesForTask(task).map(img => ensureInlineImageData(img)))).filter(Boolean);
    if (!taskImages.length) {
        throw new Error('缺少可用的商品图片素材');
    }
    const isAngleModule = task.id === 'm4';
    const hasAngleReferences = isAngleModule && (globalGenContext.angleImages || []).length > 0;

    const angleRule = isAngleModule
        ? (hasAngleReferences
            ? `9. Multi-angle mode: I provided real angle reference images after the first primary image. Use these references faithfully to build a multi-angle collage. Do not hallucinate different product variants.`
            : `9. Multi-angle mode: Only one primary image is provided. Generate plausible front, side, back, detail, and perspective views from the primary image while preserving the exact product identity, proportions, materials, and colors.`)
        : '';

    let prompt = buildModuleGenerationPrompt(task, sellingPoints, config, promptAdjustment);
    if (angleRule) prompt += `\n${angleRule}`;

    let parts = [{ text: prompt }, ...taskImages.map(img => ({ inlineData: { mimeType: img.mimeType, data: img.data } }))];
    const payload = {
        contents: [{ role: "user", parts: parts }],
        generationConfig: {
            responseModalities: ['IMAGE'],
            imageConfig: { aspectRatio: config.aspectRatio }
        }
    };

    try {
        const promises = [callAI("image", payload)];
        if (!skipSEO) {
            promises.push(generateSEOMetadata(task, sellingPoints));
        }

        const results = await Promise.all(promises);
        const imgRes = results[0];

        const imagePart = imgRes.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
        if (imagePart?.inlineData) {
            const generatedSrc = `data:${imagePart.inlineData.mimeType};base64,${imagePart.inlineData.data}`;
            contentDiv.innerHTML = `<img src="${generatedSrc}" class="w-full h-full object-cover">`;
            contentDiv.classList.remove('p-6', 'flex-col', 'items-center', 'justify-center');
            contentDiv.style.padding = '0';
            task.imageSrc = generatedSrc;
            task.status = 'success';
            task.isFallback = false;
            setModuleStatus(uniqueId, 'success');
        } else throw new Error("No image data in response");

    } catch (error) {
        console.warn(`[Fallback] Module rendering via code CSS:`, error);
        remoteLog(`模块 [${task.title}] 触发 Fallback 渲染`);
        if (isAngleModule && taskImages.length > 1) {
            renderMultiAngleFallback(contentDiv, task, sellingPoints, config, taskImages);
        } else {
            renderMockModule(contentDiv, task, sellingPoints, config, taskImages[0]?.base64 || currentUploadedBase64);
        }
        if (!skipSEO) {
            await generateSEOMetadata(task, sellingPoints);
        }
        task.imageSrc = getModuleImageSrc(uniqueId);
        task.status = 'fallback';
        task.isFallback = true;
        task.error = error.message || String(error);
        setModuleStatus(uniqueId, 'fallback');
    }

    document.getElementById(`regen-btn-${uniqueId}`)?.classList.remove('hidden');
    task.seo = getModuleSeo(uniqueId);
    renderModuleQualityPanel(uniqueId);
    return { status: task.status, task };
}

// 在图片模型失败时渲染通用降级模块，保证页面仍有可下载的占位图。
function renderMockModule(container, task, points, config, imgSrc) {
    if (!container) return;
    const ratioStr = config.aspectRatio.replace(':', '/');
    const themeTag = config.marketingTheme !== 'none' ? `<div class="absolute top-4 left-4 bg-orange-500 text-white text-[9px] font-black px-2 py-1 rounded shadow-lg uppercase tracking-tighter z-10">${detailEscapeHtml(config.marketingThemeLabel || config.marketingTheme)}</div>` : '';
    const safeTitle = detailEscapeHtml(task.title);
    const safePoints = detailEscapeHtml(points.substring(0, 80));
    const safeStyle = detailEscapeHtml((config.imageStyleLabel || config.imageStyle || '').split(',')[0]);
    const safePlatform = detailEscapeHtml(config.platformLabel || config.platform);
    const safeImg = detailEscapeHtml(imgSrc || '');

    let content = `<div class="w-full h-full flex flex-col items-center justify-center p-8 text-center bg-gradient-to-br from-slate-50 to-slate-100 relative overflow-hidden">
        ${themeTag}
        <img src="${safeImg}" class="h-3/5 object-contain drop-shadow-2xl mb-6 max-w-full transform hover:scale-105 transition-transform duration-700">
        <h3 class="text-xl font-black text-slate-800 tracking-wider uppercase">${safeTitle}</h3>
        <div class="w-12 h-1 bg-blue-500 my-3 rounded-full"></div>
        <p class="text-[10px] text-slate-500 mt-1 max-w-xs leading-relaxed font-medium">${safePoints}...</p>
        <div class="mt-6 flex items-center gap-2">
            <span class="px-3 py-1 bg-white border border-slate-200 rounded-full text-[9px] font-black text-slate-400 uppercase tracking-widest">${safeStyle}</span>
            <span class="w-1 h-1 rounded-full bg-slate-300"></span>
            <span class="text-[9px] font-black text-blue-500 uppercase">${safePlatform}</span>
        </div>
    </div>`;
    container.innerHTML = `<div class="w-full h-full overflow-hidden" style="aspect-ratio: ${ratioStr};">${content}</div>`;
    container.classList.remove('p-6', 'flex-col', 'items-center', 'justify-center');
    container.style.padding = '0';
}

// 在多角度模块失败时用上传素材渲染本地多角度拼图降级图。
function renderMultiAngleFallback(container, task, points, config, images) {
    if (!container || !images.length) return;
    const ratioStr = config.aspectRatio.replace(':', '/');
    const safeTitle = detailEscapeHtml(task.title);
    const safePoints = detailEscapeHtml(points.substring(0, 70));
    const safeTheme = detailEscapeHtml(config.marketingThemeLabel || '');
    const tiles = images.slice(0, 6).map((img, index) => `
        <div class="relative bg-white rounded-lg overflow-hidden border border-slate-200 shadow-sm">
            <img src="${detailEscapeHtml(img.base64)}" class="w-full h-full object-contain p-2">
            <span class="absolute left-2 bottom-2 bg-slate-900/70 text-white text-[9px] font-black px-2 py-0.5 rounded">${index === 0 ? '主视角' : `角度 ${index}`}</span>
        </div>
    `).join('');

    container.innerHTML = `
        <div class="w-full h-full bg-slate-50 p-5 flex flex-col gap-4" style="aspect-ratio: ${ratioStr};">
            <div class="flex items-center justify-between">
                <div>
                    <div class="text-xl font-black text-slate-800 tracking-wide">${safeTitle}</div>
                    <div class="text-[10px] text-slate-500 mt-1 max-w-lg">${safePoints}...</div>
                </div>
                ${safeTheme ? `<span class="text-[9px] font-black text-orange-600 bg-orange-50 border border-orange-100 rounded px-2 py-1">${safeTheme}</span>` : ''}
            </div>
            <div class="grid grid-cols-3 gap-3 flex-1 min-h-0">${tiles}</div>
        </div>`;
    container.classList.remove('p-6', 'flex-col', 'items-center', 'justify-center');
    container.style.padding = '0';
}

// 从结果区返回详情页生成首页展示区。
function resetView() {
    document.getElementById('resultArea').classList.add('hidden');
    document.getElementById('resultArea').classList.remove('flex');
    document.getElementById('showcaseArea').classList.remove('hidden');
    setTimeout(() => { document.getElementById('showcaseArea').classList.remove('opacity-0'); }, 50);
}

// 将单个模块 DOM 用 html2canvas 打包成图片并下载。
async function downloadModule(modId, modTitle, isBatch = false) {
    const el = document.getElementById(`content-mod-${modId}`);
    if (!el) return;
    try {
        if (!isBatch) showToast(`正在打包...`, 'info');
        const canvas = await html2canvas(el, { useCORS: true, scale: 2, backgroundColor: '#ffffff' });
        const link = document.createElement('a');

        let baseFilename = modTitle;
        const seoInput = document.getElementById(`seo-title-target-${modId}`);
        if (seoInput && seoInput.value && seoInput.value.length > 2) {
            const parsedTitle = seoInput.value.trim().replace(/[/\\?%*:|"<>]/g, '-');
            if (parsedTitle) baseFilename = parsedTitle;
        }

        const pad = n => n.toString().padStart(2, '0');
        const d = new Date();
        const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;

        link.download = `${baseFilename}_${ts}.png`;
        link.href = canvas.toDataURL('image/png');
        link.click();
        if (!isBatch) showToast('下载成功', 'success');
    } catch (e) { console.error(e); if (!isBatch) showToast('下载失败', 'error'); }
}

// 依次下载当前项目里的所有已生成模块图片。
async function downloadAllModules() {
    if (!globalGenContext || !Object.keys(globalGenContext.tasks).length) return;
    showToast('开始批量打包，请耐心等待...', 'info');
    const ids = Object.keys(globalGenContext.tasks);
    for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        await downloadModule(id, globalGenContext.tasks[id].displayTitle, true);
        await new Promise(r => setTimeout(r, 600));
    }
    showToast('全部下载完毕！', 'success');
}

// 收集当前详情页项目快照，用于历史保存和后续恢复。
function collectCurrentRenderProject(finalImage = '') {
    if (!globalGenContext) return null;
    const taskEntries = Object.entries(globalGenContext.tasks || {});
    const modulesSnapshot = taskEntries.map(([id, task]) => ({
        id,
        title: task.title,
        subtitle: task.subtitle,
        displayTitle: task.displayTitle,
        prompt: task.prompt,
        variant: task.variant,
        totalVariants: task.totalVariants,
        status: task.status || 'pending',
        isFallback: !!task.isFallback,
        error: task.error || '',
        repaintPrompt: task.repaintPrompt || getModulePromptAdjustment(id),
        imageSrc: getModuleImageSrc(id) || task.imageSrc || '',
        seo: getModuleSeo(id)
    }));
    return {
        version: 2,
        kind: 'detail-page-project',
        finalImage,
        uploadedImages: (globalGenContext.uploadedImages || []).map(img => ({
            id: img.id,
            name: img.name,
            base64: img.base64,
            mimeType: img.mimeType,
            isPrimary: !!img.isPrimary,
            role: img.role || ''
        })),
        sellingPoints: globalGenContext.sellingPoints || '',
        productName: globalGenContext.config?.productName || '',
        productFacts: globalGenContext.config?.productFacts || '',
        forbiddenClaims: globalGenContext.config?.forbiddenClaims || '',
        config: globalGenContext.config || {},
        longImageOrder: (globalGenContext.longImageOrder || []).slice(),
        modules: modulesSnapshot
    };
}

// 从历史记录恢复详情页项目，包括素材、模块图片、SEO、顺序和重绘提示词。
function renderRestoredDetailProject(project, fallbackImage = '') {
    if (!project || project.kind !== 'detail-page-project' || !Array.isArray(project.modules)) return false;

    const restoredImages = Array.isArray(project.uploadedImages)
        ? project.uploadedImages.map((img, index) => {
            const base64 = formatImgSrc(img.base64 || img.imageSrc || '');
            const parsed = parseImageDataUrl(base64) || {};
            return {
                ...img,
                base64,
                mimeType: img.mimeType || parsed.mimeType || '',
                data: img.data || parsed.data || '',
                isPrimary: index === 0,
                role: index === 0 ? 'primary' : img.role || 'angle'
            };
        }).filter(img => img.base64).slice(0, DETAIL_MAX_UPLOAD_IMAGES)
        : [];
    currentUploadedImages = restoredImages;
    currentUploadedBase64 = restoredImages[0]?.base64 || null;
    renderUploadedImagePreviews();

    const restoredTasks = {};
    const order = Array.isArray(project.longImageOrder) && project.longImageOrder.length
        ? project.longImageOrder
        : project.modules.map(mod => mod.id);

    globalGenContext = {
        base64Data: '',
        mimeType: '',
        primaryImage: restoredImages[0] || null,
        angleImages: restoredImages.slice(1),
        uploadedImages: restoredImages,
        sellingPoints: project.sellingPoints || '',
        config: project.config || { aspectRatio: '1:1', marketingTheme: 'none' },
        tasks: restoredTasks,
        longImageOrder: order
    };

    const sellingInput = document.getElementById('sellingPointsText');
    if (sellingInput) sellingInput.value = project.sellingPoints || '';
    const productNameInput = document.getElementById('productNameInput');
    if (productNameInput) productNameInput.value = project.productName || project.config?.productName || '';
    const factsInput = document.getElementById('productFactsText');
    if (factsInput) factsInput.value = project.productFacts || project.config?.productFacts || '';
    const forbiddenInput = document.getElementById('forbiddenClaimsText');
    if (forbiddenInput) forbiddenInput.value = project.forbiddenClaims || project.config?.forbiddenClaims || '';

    const showcaseArea = document.getElementById('showcaseArea');
    const resultArea = document.getElementById('resultArea');
    const container = document.getElementById('modulesResultContainer');
    if (!container || !resultArea) return false;

    showcaseArea?.classList.add('hidden');
    resultArea.classList.remove('hidden');
    resultArea.classList.add('flex');
    container.innerHTML = '';

    const ratioStr = (project.config?.aspectRatio || '1:1').replace(':', '/');
    project.modules.forEach(mod => {
        const task = { ...mod, uniqueId: mod.id, active: true };
        restoredTasks[mod.id] = task;
        const imageSrc = mod.imageSrc || fallbackImage || project.finalImage || '';
        container.insertAdjacentHTML('beforeend', `
            <div id="result-mod-${detailEscapeHtml(mod.id)}" class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden flex flex-col group">
                <div class="bg-gray-50/80 px-5 py-3 border-b border-gray-100 flex justify-between items-center backdrop-blur">
                    <div class="flex items-center gap-2">
                        <span class="w-1.5 h-4 bg-blue-500 rounded-full"></span>
                        <span class="font-bold text-gray-700 text-sm">${detailEscapeHtml(mod.displayTitle || mod.title || '详情模块')}</span>
                        <span id="status-badge-${detailEscapeHtml(mod.id)}" class="text-[10px] font-black px-2 py-0.5 rounded-full border bg-slate-100 text-slate-500 border-slate-200">等待中</span>
                    </div>
                    <div class="flex items-center gap-2">
                        <span class="text-xs text-gray-400 mr-2">${detailEscapeHtml(mod.subtitle || '')}</span>
                        <button id="regen-btn-${detailEscapeHtml(mod.id)}" onclick="generateSingleWrap('${detailEscapeHtml(mod.id)}')" class="flex items-center justify-center w-7 h-7 rounded bg-white border border-gray-200 text-gray-500 hover:text-blue-600 transition-colors shadow-sm" title="重绘图像并刷新 SEO"><i class="ph ph-arrows-clockwise text-sm"></i></button>
                    </div>
                </div>
                <div id="content-mod-${detailEscapeHtml(mod.id)}" class="relative bg-white" style="aspect-ratio: ${ratioStr}; min-height: 200px; padding: 0;">
                    ${imageSrc ? `<img src="${detailEscapeHtml(formatImgSrc(imageSrc))}" class="w-full h-full object-cover">` : '<div class="w-full h-full flex items-center justify-center text-xs text-gray-400">暂无模块图片</div>'}
                </div>
                ${renderPromptRegenerationControls(mod.id)}
                <div id="quality-panel-${detailEscapeHtml(mod.id)}" class="border-t border-gray-100 bg-white px-4 py-3"></div>
                <div class="border-t border-gray-100 bg-slate-50 p-4 flex flex-col gap-3">
                    <div class="flex items-center justify-between">
                        <div class="flex items-center gap-1.5"><i class="ph-fill ph-link text-blue-500"></i><span class="text-xs font-black text-gray-700 uppercase tracking-widest">SEO Meta-Data</span></div>
                        <button onclick="downloadModule('${detailEscapeHtml(mod.id)}', '${detailEscapeHtml(mod.displayTitle || mod.title || '详情模块')}')" class="text-xs flex items-center gap-1 text-gray-500 hover:text-indigo-600 font-bold bg-white border border-gray-200 px-2 py-1 rounded shadow-sm transition-all active:scale-95"><i class="ph ph-download-simple"></i> 单存</button>
                    </div>
                    <div class="flex flex-col gap-2.5">
                        <div class="flex items-center gap-2">
                            <span class="text-[10px] font-bold text-gray-400 w-6">Title</span>
                            <input type="text" id="seo-title-target-${detailEscapeHtml(mod.id)}" class="flex-1 text-xs px-2 py-1.5 border border-gray-200 rounded bg-white shadow-inner" readonly>
                            <input type="text" id="seo-title-zh-${detailEscapeHtml(mod.id)}" class="flex-1 text-xs px-2 py-1.5 border border-gray-200 rounded bg-white shadow-inner text-gray-500" readonly>
                        </div>
                        <div class="flex items-start gap-2">
                            <span class="text-[10px] font-bold text-gray-400 w-6 mt-1">Alt</span>
                            <textarea id="alt-text-target-${detailEscapeHtml(mod.id)}" class="flex-1 text-xs px-2 py-1.5 border border-gray-200 rounded bg-white shadow-inner resize-none hide-scroll" rows="2" readonly></textarea>
                            <textarea id="alt-text-zh-${detailEscapeHtml(mod.id)}" class="flex-1 text-xs px-2 py-1.5 border border-gray-200 rounded bg-white shadow-inner resize-none hide-scroll text-gray-500" rows="2" readonly></textarea>
                        </div>
                    </div>
                </div>
            </div>`);
        setModuleSeo(mod.id, mod.seo || {});
        const promptInput = document.getElementById(`regen-prompt-${mod.id}`);
        if (promptInput) promptInput.value = mod.repaintPrompt || '';
        setModuleStatus(mod.id, mod.status || (mod.isFallback ? 'fallback' : 'success'));
        renderModuleQualityPanel(mod.id);
    });

    renderSortableList();
    return true;
}

// ====== 长图拖拽排版台逻辑 ======
// 打开长图排版台，并在打开前刷新模块排序列表和预览画布。
function openLongImageBuilder() {
    if (!globalGenContext || !globalGenContext.longImageOrder.length) {
        showToast('尚未生成任何模块', 'error'); return;
    }
    renderSortableList();
    document.getElementById('longImageBuilderModal').classList.remove('hidden');
}

// 关闭长图排版台弹窗。
function closeLongImageBuilder() {
    document.getElementById('longImageBuilderModal').classList.add('hidden');
}

// 从长图排序中移除指定模块 ID，用于把不想要的图片排除出长图。
function removeLongImageModuleFromOrder(order = [], moduleId = '') {
    return Array.isArray(order)
        ? order.filter(id => id && id !== moduleId)
        : [];
}

// 删除长图排版台中的模块，只影响长图合成顺序，不删除结果区单张图片。
function removeLongImageModule(moduleId = '') {
    if (!globalGenContext || !moduleId) return;
    const beforeCount = (globalGenContext.longImageOrder || []).length;
    globalGenContext.longImageOrder = removeLongImageModuleFromOrder(globalGenContext.longImageOrder || [], moduleId);
    const afterCount = globalGenContext.longImageOrder.length;
    if (afterCount === beforeCount) return;
    renderSortableList();
    const panel = document.getElementById('exportChecklistPanel');
    if (panel && !panel.classList.contains('hidden')) renderExportChecklist();
    showToast('已从长图中移除，单张模块图仍保留', 'success');
}

// 渲染可拖拽模块列表和长图预览画布。
function renderSortableList() {
    const list = document.getElementById('sortableList');
    const canvas = document.getElementById('longImageCanvas');
    if (!list || !canvas) return;
    list.innerHTML = '';
    canvas.innerHTML = '';

    if (!globalGenContext.longImageOrder.length) {
        list.innerHTML = `
            <div class="text-xs text-slate-400 bg-white border border-dashed border-slate-200 rounded-lg p-4 text-center leading-relaxed">
                当前没有加入长图的图片
            </div>`;
        canvas.innerHTML = `
            <div class="min-h-[360px] flex items-center justify-center text-xs text-slate-400 bg-slate-50">
                当前没有加入长图的图片
            </div>`;
        return;
    }

    globalGenContext.longImageOrder.forEach((id) => {
        const task = globalGenContext.tasks[id];
        if (!task) return;

        const li = document.createElement('div');
        li.className = 'bg-white border border-gray-200 p-3 rounded-lg shadow-sm cursor-move flex items-center gap-3 hover:border-indigo-400 select-none transition-colors';
        li.draggable = true;
        li.dataset.id = id;
        li.innerHTML = `
            <i class="ph ph-dots-six-vertical text-gray-400 text-lg"></i>
            <div class="flex-1 min-w-0">
                <div class="text-xs font-bold text-gray-700 truncate">${detailEscapeHtml(task.displayTitle)}</div>
                <div class="text-[10px] text-gray-400 truncate">${detailEscapeHtml(task.subtitle)}</div>
            </div>
            <button type="button"
                onclick="event.stopPropagation(); removeLongImageModule('${detailEscapeHtml(id)}')"
                class="flex items-center justify-center w-7 h-7 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 border border-transparent hover:border-red-100 transition-colors cursor-pointer"
                title="不加入长图">
                <i class="ph ph-trash text-sm"></i>
            </button>
        `;

        li.addEventListener('dragstart', (e) => {
            draggedItem = li;
            setTimeout(() => li.classList.add('ghost-item'), 0);
        });

        li.addEventListener('dragend', () => {
            setTimeout(() => {
                draggedItem?.classList.remove('ghost-item');
                draggedItem = null;
                updatePreviewOrder();
            }, 0);
        });

        li.addEventListener('dragover', e => e.preventDefault());
        li.addEventListener('dragenter', function (e) {
            e.preventDefault();
            if (this !== draggedItem) this.classList.add('border-indigo-500', 'bg-indigo-50/50');
        });
        li.addEventListener('dragleave', function () {
            this.classList.remove('border-indigo-500', 'bg-indigo-50/50');
        });
        li.addEventListener('drop', function () {
            this.classList.remove('border-indigo-500', 'bg-indigo-50/50');
            if (draggedItem && this !== draggedItem) {
                const allItems = [...list.children];
                const curPos = allItems.indexOf(draggedItem);
                const dropPos = allItems.indexOf(this);
                if (curPos < dropPos) this.parentNode.insertBefore(draggedItem, this.nextSibling);
                else this.parentNode.insertBefore(draggedItem, this);
            }
        });

        list.appendChild(li);

        const contentDiv = document.getElementById(`content-mod-${id}`);
        if (contentDiv) {
            const img = contentDiv.querySelector('img');
            if (img) {
                const cloneImg = document.createElement('img');
                cloneImg.src = img.src;
                cloneImg.className = 'w-full h-auto block m-0 p-0 border-none';
                cloneImg.dataset.id = id;
                cloneImg.crossOrigin = 'anonymous';
                canvas.appendChild(cloneImg);
            }
        }
    });
}

// 根据拖拽后的列表顺序更新全局长图顺序和预览图片顺序。
function updatePreviewOrder() {
    const list = document.getElementById('sortableList');
    const newOrder = [...list.children].map(li => li.dataset.id);
    globalGenContext.longImageOrder = newOrder;

    const canvas = document.getElementById('longImageCanvas');
    const images = [...canvas.children];
    newOrder.forEach(id => {
        const img = images.find(img => img.dataset.id === id);
        if (img) canvas.appendChild(img);
    });
}

// 渲染导出前检查结果，提示缺图、降级图、重复和潜在风险。
function renderExportChecklist() {
    const panel = document.getElementById('exportChecklistPanel');
    if (!panel || !globalGenContext) return;
    const tasks = (globalGenContext.longImageOrder || [])
        .map(id => globalGenContext.tasks[id])
        .filter(Boolean);
    const checklist = buildExportChecklist(tasks, globalGenContext.config || {});
    panel.classList.remove('hidden');
    panel.innerHTML = `
        <div class="font-black text-slate-700 mb-2 flex items-center gap-1.5"><i class="ph ph-shield-check"></i> 导出检查</div>
        <div class="flex flex-col gap-1.5">
            ${checklist.map(item => {
                const cls = item.level === 'danger'
                    ? 'text-red-600'
                    : item.level === 'warning'
                        ? 'text-amber-700'
                        : item.level === 'success'
                            ? 'text-emerald-600'
                            : 'text-slate-500';
                return `<div class="${cls}">• ${detailEscapeHtml(item.text)}</div>`;
            }).join('')}
        </div>`;
}

// 导出当前详情页项目 JSON，便于以后重新载入或排查生成配置。
function exportCurrentProjectJson() {
    const project = collectCurrentRenderProject('');
    if (!project) {
        showToast('没有可导出的详情页项目', 'error');
        return;
    }
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    const ts = Date.now();
    link.download = `AI详情页项目_${ts}.json`;
    link.href = URL.createObjectURL(blob);
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    showToast('项目 JSON 已导出', 'success');
}

// 调用文本模型按高转化详情页逻辑重新排序长图模块。
async function aiSortLongImage() {
    if (!globalGenContext || !globalGenContext.longImageOrder.length) return;
    const btn = document.getElementById('aiSortBtn');
    const origHtml = btn.innerHTML;
    btn.innerHTML = '<i class="ph ph-spinner animate-spin text-sm"></i> 智能计算中...';
    btn.disabled = true;

    const modulesToSort = globalGenContext.longImageOrder.map(id => {
        const task = globalGenContext.tasks[id];
        return { id: id, title: task.title, subtitle: task.subtitle };
    });
    const guardrails = buildProductGuardrails(globalGenContext.config || {});

    const prompt = `你是一个资深跨境电商运营与高转化详情页架构专家。
目前我有以下详情页模块需要组合成一张长图。请根据“高转化营销逻辑”（如 AIDA 模型）对这些模块进行最优排序。
产品卖点背景：${globalGenContext.sellingPoints.substring(0, 300)}
${guardrails ? `产品事实与禁用约束：\n${guardrails}\n` : ''}
待排序模块列表：${JSON.stringify(modulesToSort)}
任务要求：
1. 必须返回所有输入的模块 ID，不能遗漏。
2. 严格返回 JSON 数组格式，仅包含排序后的 ID 字符串列表。
直接返回纯净的 JSON 数组，不要任何解释。`;

    try {
        const res = await callAI("text", {
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json" }
        });
        const text = res.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
            const sortedIds = JSON.parse(text);
            if (Array.isArray(sortedIds)) {
                const currentIds = globalGenContext.longImageOrder.slice();
                const safeOrder = validateSortedIds(sortedIds, currentIds);
                if (!safeOrder) throw new Error('AI 返回的排序结果不完整');
                const changed = safeOrder.some((id, idx) => id !== sortedIds[idx]) || safeOrder.length !== sortedIds.length;
                globalGenContext.longImageOrder = safeOrder;
                renderSortableList();
                showToast(changed ? 'AI 排序已应用，已自动补齐缺失模块' : 'AI 智能排序已应用', 'success');
            }
        }
    } catch (err) { console.error(err); showToast('AI 排序失败', 'error'); }
    finally { btn.innerHTML = origHtml; btn.disabled = false; }
}

// 将长图排版台中的预览画布导出为 PNG/JPG，并保存到历史记录。
async function executeLongImageDownload() {
    const canvasEl = document.getElementById('longImageCanvas');
    const format = document.getElementById('exportQualitySelect').value;
    const btn = document.getElementById('btnDownloadLong');
    const origHTML = btn.innerHTML;
    if (!globalGenContext?.longImageOrder?.length) {
        showToast('长图中没有可导出的图片', 'error');
        return;
    }

    btn.disabled = true;
    btn.innerHTML = '<i class="ph ph-spinner animate-spin text-lg"></i> 渲染中...';
    renderExportChecklist();

    try {
        await new Promise(r => setTimeout(r, 300));
        const finalCanvas = await html2canvas(canvasEl, { useCORS: true, scale: format === 'png' ? 2 : 1.5, backgroundColor: '#ffffff', logging: false });
        const link = document.createElement('a');
        const ts = Date.now();

        if (format === 'png') {
            link.download = `AI详情页长图_${ts}.png`;
            link.href = finalCanvas.toDataURL('image/png');
        } else {
            link.download = `AI详情页长图_${ts}.jpg`;
            link.href = finalCanvas.toDataURL('image/jpeg', 0.85);
        }

        link.click();
        showToast(`导出成功`, 'success');

        const finalImage = finalCanvas.toDataURL('image/jpeg', 0.6);
        const project = collectCurrentRenderProject(finalImage);
        // 存档全案
        saveToHistory('render', {
            name: `全案详情页_${ts}`,
            style: globalGenContext?.config?.imageStyleLabel || globalGenContext?.config?.imageStyle || '默认',
            image: finalImage,
            metadata: project || { count: globalGenContext?.longImageOrder?.length || 0 }
        });
    } catch (e) { showToast('导出失败', 'error'); }
    finally { btn.innerHTML = origHTML; btn.disabled = false; }
}
