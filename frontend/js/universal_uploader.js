/**
 * Universal Asset Uploader (通用云存储图床托管控制器)
 * 统一承接全站（尺寸重绘、AI 消除、图片翻译、详情页等）的生成图片上传至云存储
 * 支持多目标（WordPress 多站点 / Shopify 多店铺 / Cloudflare R2）、WebP 无损压缩、SEO Title 与 Alt 文本编辑
 */

(function () {
    const STATE = {
        isOpen: false,
        sourceModule: '',
        imageData: '',
        filename: '',
        title: '',
        altText: '',
        storageType: 'r2',
        configId: null,
        configs: [],
        isUploading: false,
        convertToWebp: true,
        quality: 90,
        lastResult: null,
        onSuccess: null,
        batchQueue: [],
        batchProgress: { total: 0, current: 0, successful: 0, failed: 0 },
        isBatchMode: false,
        onBatchComplete: null
    };

    function getApiBase() {
        if (typeof API_BASE !== 'undefined' && API_BASE) return API_BASE;
        if (typeof window !== 'undefined' && window.location && window.location.hostname) {
            return `${window.location.protocol}//${window.location.hostname}:9503`;
        }
        return 'http://localhost:9503';
    }

    async function loadStorageConfigs() {
        try {
            const res = await fetch(`${getApiBase()}/api/storage/configs`);
            if (res.ok) {
                const data = await res.json();
                STATE.configs = Array.isArray(data) ? data : [];
            }
        } catch (err) {
            console.error('[UniversalUploader] Failed to load storage configs:', err);
            STATE.configs = [];
        }
        return STATE.configs;
    }

    function sanitizeNameForSeo(rawName) {
        if (!rawName) return '';
        return rawName
            .replace(/\.[a-zA-Z0-9]+$/, '')
            .replace(/[-_]+/g, ' ')
            .trim();
    }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    /**
     * 检测文件名或文案是否属于常见无意义/通用设计占位名
     */
    function isGenericPlaceholderName(name) {
        if (!name) return true;
        const cleaned = String(name).trim();
        if (!cleaned) return true;

        // 纯数字、短横杠下划线、或者类似 ti_1789617078_a8b9c 或 12 位以上哈希
        if (/^[\d_\-\s]+$/.test(cleaned)) return true;
        if (/^[a-f0-9]{12,}$/i.test(cleaned)) return true;
        if (/^ti_\d+_[a-z0-9]+$/i.test(cleaned)) return true;

        // 通用占位符 (中文 & 英文)，允许后面跟数字、下划线、空格、以及可选的语言后缀 (如 EN, ZH, TH 等) 或 "in 英文" 等机翻残留
        const GENERIC_REGEX = /^(?:描述图|详情图|主图|副图|轮播图|产品图|商品图|素材|图片|译图|翻译图|重绘图|去水印图|截图|image|img|pic|picture|photo|screenshot|screen_shot|untitled|未命名|canvas|download|output|file|asset)[\s_\-\d]*(?:[a-zA-Z]{2,4}|in\s*[\u4e00-\u9fa5a-zA-Z]+)?$/i;
        return GENERIC_REGEX.test(cleaned);
    }

    /**
     * 从文件名中提取序号 (例如 描述图_05 -> 05, img_2 -> 02)
     */
    function extractSequenceFromFilename(name, fallbackIndex = null) {
        if (!name && fallbackIndex === null) return '';
        const match = String(name || '').match(/(\d+)(?:\.[a-zA-Z0-9]+)?$/);
        if (match && match[1]) {
            const num = parseInt(match[1], 10);
            return num < 10 ? `0${num}` : `${num}`;
        }
        if (fallbackIndex !== null && fallbackIndex !== undefined) {
            const num = fallbackIndex + 1;
            return num < 10 ? `0${num}` : `${num}`;
        }
        return '';
    }

    const CATEGORY_EN_MAP = [
        [/人体工学|工学椅|办公椅|椅子|chair/i, 'Ergonomic Office Chair'],
        [/耳机|音箱|音频|earbuds|headphone|audio/i, 'Wireless Audio Device'],
        [/手表|手环|watch|band/i, 'Smart Wearable Watch'],
        [/充电|电源|电池|power|charger/i, 'Fast Power Charger'],
        [/家具|沙发|桌|desk|table|furniture/i, 'Home & Office Furniture'],
        [/户外|露营|登山|outdoor|camping/i, 'Outdoor Gear'],
        [/手机壳|支架|配件|case|holder|stand/i, 'Mobile Phone Accessory'],
        [/服装|衣服|男装|女装|apparel|clothing/i, 'Fashion Apparel'],
        [/鞋|sneaker|shoes/i, 'Comfort Footwear'],
        [/美妆|护肤|美容|cosmetic|skincare/i, 'Beauty & Skincare'],
        [/厨房|小家电|kitchen|appliance/i, 'Smart Kitchen Appliance'],
        [/宠物|猫|狗|pet/i, 'Pet Supplies'],
        [/灯|照明|light|lamp/i, 'LED Lighting Device']
    ];

    /**
     * 获取全局商品画像或上下文信息
     */
    function getResolvedBrandContext() {
        let profile = null;
        if (typeof window !== 'undefined' && window.brandContextHub && typeof window.brandContextHub.getActiveProfile === 'function') {
            profile = window.brandContextHub.getActiveProfile();
        }
        if (!profile && typeof getActiveBrandProfile === 'function') {
            profile = getActiveBrandProfile();
        }

        // 彻底杜绝示例画像 (ErgoPro 工学椅) 污染无关图片
        if (profile && (profile.id === 'sample_ergonomic_chair' || profile.name === '自适应动态腰托人体工学椅')) {
            let hasExplicitChairInDom = false;
            if (typeof document !== 'undefined') {
                const prodInput = document.getElementById('productNameInput');
                if (prodInput && /椅|chair/i.test(prodInput.value || '')) {
                    hasExplicitChairInDom = true;
                }
            }
            if (!hasExplicitChairInDom) {
                profile = null;
            }
        }

        const brandName = (profile?.brandName || '').trim();
        const productName = (profile?.name || '').trim();
        const category = (profile?.category || '').trim();
        const differentiators = (profile?.differentiators || '').trim();

        let domProductName = '';
        if (typeof document !== 'undefined') {
            const prodInput = document.getElementById('productNameInput');
            if (prodInput && prodInput.value) domProductName = prodInput.value.trim();
            if (!domProductName) {
                const listingTitle = document.getElementById('listingTitle');
                if (listingTitle && listingTitle.value) domProductName = listingTitle.value.trim();
            }
        }

        const resolvedProd = productName || domProductName || '';
        return {
            brandName: brandName,
            productName: resolvedProd,
            category: category,
            differentiators: differentiators,
            hasContext: !!(brandName || (productName && productName !== '未命名商品画像') || domProductName)
        };
    }

    /**
     * 智能 SEO 元数据生成引擎 (核心算法与确定性降级规则)
     * 根除类似 "描述图_05 in 英文" 等机械拼接，根据商品画像、模块与目标语言生成符合 SEO 与无障碍规范的元数据
     */
    function generateSmartSeoMetadata(options = {}) {
        const rawFilename = (options.filename || '').trim();
        const sourceModule = options.sourceModule || STATE.sourceModule || 'general';
        const langInput = options.lang || options.targetLang || '';
        const index = typeof options.index === 'number' ? options.index : null;
        const baseWithoutExt = rawFilename.replace(/\.[a-zA-Z0-9]+$/, '');
        const isGeneric = isGenericPlaceholderName(baseWithoutExt);
        const seq = extractSequenceFromFilename(baseWithoutExt, index);

        const brandCtx = getResolvedBrandContext();
        const brandName = options.brandName || brandCtx.brandName || '';
        let productName = options.productName || (brandCtx.hasContext ? brandCtx.productName : '');

        // 若原文件名非通用占位且无显式商品名，清洗文件名做为商品名补充
        if (!productName && !isGeneric && baseWithoutExt) {
            productName = sanitizeNameForSeo(baseWithoutExt);
        }

        // 解析目标语言
        const langLower = String(langInput).toLowerCase();
        let targetLang = 'en'; // 默认跨境电商英语
        let langLabel = 'English';
        let langShort = 'EN';

        if (langLower.includes('zh') || langLower.includes('chin') || langLower.includes('中')) {
            targetLang = 'zh';
            langLabel = '中文';
            langShort = 'ZH';
        } else if (langLower.includes('th') || langLower.includes('thai') || langLower.includes('泰')) {
            targetLang = 'th';
            langLabel = 'ไทย';
            langShort = 'TH';
        } else if (langLower.includes('ja') || langLower.includes('japan') || langLower.includes('日')) {
            targetLang = 'ja';
            langLabel = '日本語';
            langShort = 'JA';
        } else if (langLower.includes('de') || langLower.includes('german') || langLower.includes('德')) {
            targetLang = 'de';
            langLabel = 'Deutsch';
            langShort = 'DE';
        } else if (langLower.includes('fr') || langLower.includes('french') || langLower.includes('法')) {
            targetLang = 'fr';
            langLabel = 'Français';
            langShort = 'FR';
        } else if (langLower.includes('es') || langLower.includes('spanish') || langLower.includes('西')) {
            targetLang = 'es';
            langLabel = 'Español';
            langShort = 'ES';
        } else if (langLower.includes('en') || langLower.includes('engl') || langLower.includes('英')) {
            targetLang = 'en';
            langLabel = 'English';
            langShort = 'EN';
        } else if (langInput) {
            langShort = langInput.slice(0, 2).toUpperCase();
            langLabel = langInput;
        }

        // 针对英文等非中文环境，若商品名含中文字符，智能尝试映射英文化
        let displayProd = productName;
        if (targetLang !== 'zh' && /[\u4e00-\u9fa5]/.test(displayProd || '')) {
            let mappedEn = '';
            const testText = `${brandCtx.category} ${productName}`;
            for (const [regex, enTerm] of CATEGORY_EN_MAP) {
                if (regex.test(testText)) {
                    mappedEn = enTerm;
                    break;
                }
            }
            displayProd = mappedEn || (brandName ? `${brandName} Product` : 'Premium E-commerce Product');
        }
        if (!displayProd) {
            displayProd = targetLang === 'zh' ? '商品' : 'E-commerce Product';
        }

        const brandProdName = brandName && !displayProd.toLowerCase().includes(brandName.toLowerCase())
            ? `${brandName} ${displayProd}`
            : displayProd;

        let title = '';
        let altText = '';
        const seqPart = seq ? ` ${seq}` : '';

        if (targetLang === 'zh') {
            const zhProdName = (brandProdName || '商品').trim();
            if (sourceModule === 'translate') {
                title = `${zhProdName} - 本地化核心卖点展示${seqPart} [${langShort}]`;
                altText = `${zhProdName} 高清细节功能展示与卖点说明图`;
            } else if (sourceModule === 'square-redraw') {
                title = `${zhProdName} - 高清重绘展示图${seqPart}`;
                altText = `${zhProdName} 完美比例电商展示图`;
            } else if (sourceModule === 'watermark-removal') {
                title = `${zhProdName} - 超清纯净展示图`;
                altText = `${zhProdName} 无水印高清细节展示图`;
            } else if (sourceModule === 'details') {
                title = options.moduleTitle ? `${zhProdName} - ${options.moduleTitle}` : `${zhProdName} - 核心特性细节图${seqPart}`;
                altText = options.moduleTitle ? `${options.moduleTitle} 细节功能展示 - ${zhProdName}` : `${zhProdName} 核心特性深度解析图`;
            } else {
                title = `${zhProdName} - 商品细节展示${seqPart}`;
                altText = `${zhProdName} 高清商品展示图`;
            }
        } else if (targetLang === 'th') {
            title = `${brandProdName} - ภาพรายละเอียดสินค้า${seqPart} [TH]`;
            altText = `ภาพแสดงคุณสมบัติสินค้า ${brandProdName} ฉบับภาษาไทย คมชัดสูง`;
        } else if (targetLang === 'ja') {
            title = `${brandProdName} - 詳細仕様紹介${seqPart} [JA]`;
            altText = `${brandProdName} 日本語版 製品特徴詳細画像`;
        } else {
            // 英语及其他国际化语言
            if (sourceModule === 'translate') {
                title = `${brandProdName} - Feature Details${seqPart} [${langShort}]`;
                altText = `${brandProdName} - ${langLabel} localized product showcase highlighting key features and specifications`;
            } else if (sourceModule === 'square-redraw') {
                title = `${brandProdName} - Aspect Ratio Optimized View${seqPart}`;
                altText = `High-resolution e-commerce product showcase view for ${brandProdName}`;
            } else if (sourceModule === 'watermark-removal') {
                title = `${brandProdName} - Ultra Clean High-Res View`;
                altText = `Crystal clear high-resolution product feature view of ${brandProdName}`;
            } else if (sourceModule === 'details') {
                const angle = options.moduleTitle || `Feature View${seqPart}`;
                title = `${brandProdName} - ${angle}`;
                altText = `Detailed showcase of ${angle} for ${brandProdName}`;
            } else {
                title = `${brandProdName} - Product Showcase${seqPart}`;
                altText = `Official e-commerce presentation view of ${brandProdName}`;
            }
        }

        // 文件名规范化
        let generatedFilename = rawFilename;
        if (!generatedFilename || isGeneric) {
            const cleanSlug = (brandProdName || 'product')
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '_')
                .replace(/^_+|_+$/g, '');
            const slugSeq = seq ? `_${seq}` : '';
            const slugLang = langShort ? `_${langShort.toLowerCase()}` : '';
            generatedFilename = `${cleanSlug || 'product'}${slugSeq}${slugLang}.png`;
        }

        return {
            title: title.trim(),
            altText: altText.trim(),
            filename: generatedFilename,
            productName: brandProdName,
            targetLang: targetLang
        };
    }

    /**
     * 辅助函数：解析图片二进制数据用于多模态 Vision AI
     */
    async function getImageInlineData(imageSrc) {
        if (!imageSrc) return null;
        if (typeof imageSrc === 'string' && imageSrc.startsWith('data:image/')) {
            const commaIdx = imageSrc.indexOf(',');
            if (commaIdx === -1) return null;
            const meta = imageSrc.slice(0, commaIdx);
            const data = imageSrc.slice(commaIdx + 1);
            const mimeMatch = meta.match(/data:([^;]+)/);
            return {
                mimeType: mimeMatch ? mimeMatch[1] : 'image/png',
                data: data
            };
        }
        if (typeof fetch === 'function') {
            try {
                const res = await fetch(imageSrc);
                if (!res.ok) return null;
                const blob = await res.blob();
                if (typeof FileReader !== 'undefined') {
                    return await new Promise((resolve) => {
                        const reader = new FileReader();
                        reader.onload = () => {
                            const dataUrl = reader.result;
                            if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/')) {
                                const commaIdx = dataUrl.indexOf(',');
                                const meta = dataUrl.slice(0, commaIdx);
                                const data = dataUrl.slice(commaIdx + 1);
                                const mimeMatch = meta.match(/data:([^;]+)/);
                                resolve({
                                    mimeType: mimeMatch ? mimeMatch[1] : (blob.type || 'image/png'),
                                    data: data
                                });
                            } else {
                                resolve(null);
                            }
                        };
                        reader.onerror = () => resolve(null);
                        reader.readAsDataURL(blob);
                    });
                }
            } catch (err) {
                console.warn('[UniversalUploader] Failed to fetch image for inlineData:', err);
            }
        }
        return null;
    }

    /**
     * 视觉 AI 图片多模态深度识别引擎
     * 直接分析图片画面视觉内容，辨识商品物理形态与属性，生成 100% 契合画面的 SEO Title、Alt 与纯净 Slug
     */
    async function recognizeImageWithVisionAI(imageSrc, options = {}) {
        if (typeof callAI !== 'function') {
            throw new Error('当前环境未启用 AI 服务 (callAI 未定义)');
        }
        const inlineData = await getImageInlineData(imageSrc);
        if (!inlineData || !inlineData.data) {
            throw new Error('无法解析图片二进制数据，请检查图片有效性');
        }

        const targetLang = options.targetLang || options.lang || 'en';
        const hint = (options.hint || options.productHint || '').trim();
        const sourceModule = options.sourceModule || STATE.sourceModule || 'general';
        const index = typeof options.index === 'number' ? options.index : 0;

        let langInstruction = 'English (en)';
        const l = String(targetLang).toLowerCase();
        if (l.includes('zh') || l.includes('中')) langInstruction = 'Simplified Chinese (zh-CN)';
        else if (l.includes('th') || l.includes('泰')) langInstruction = 'Thai (th)';
        else if (l.includes('ja') || l.includes('日')) langInstruction = 'Japanese (ja)';
        else if (l.includes('de') || l.includes('德')) langInstruction = 'German (de)';
        else if (l.includes('fr') || l.includes('法')) langInstruction = 'French (fr)';
        else if (l.includes('es') || l.includes('西')) langInstruction = 'Spanish (es)';

        const prompt = `You are a professional cross-border e-commerce visual AI analyst and SEO specialist.
Analyze the attached product image with high accuracy.

${hint ? `USER HINT / CATEGORY GUIDANCE: "${hint}" (Use this as high-priority reference if relevant).` : `NOTE: There is NO prior brand or product context. You must identify the physical item strictly from what is visually present in the image.`}

STRICT INSTRUCTIONS:
1. Identify the EXACT physical item shown in the image (e.g. lipstick, wireless earbuds, smartwatch, summer dress, sneaker, coffee maker, pet leash, desk lamp, mechanical keyboard, etc.).
2. NEVER hallucinate or guess unrelated products (e.g. NEVER output "ergonomic chair" or furniture unless the image actually shows a chair or furniture).
3. Identify visual composition: main color, texture, visible parts, angle (e.g., front angle, detail close-up, exploded view, lifestyle usage, infographic spec).
4. Generate the following structured fields in valid JSON:
   - "productName": Concise English name of the item (2-4 words, e.g. "Matte Velvet Lipstick", "Active Noise Canceling Earbuds").
   - "category": Standard e-commerce category in English (e.g. "Beauty & Personal Care", "Consumer Electronics", "Fashion").
   - "title": High-converting, search-optimized image title (45-75 characters) in ${langInstruction}. Mention the specific product name, visual feature/view angle, and core benefit.
   - "altText": Descriptive, accessible Alt Text (60-120 characters) in ${langInstruction} accurately describing the visual subject and composition for SEO and accessibility.
   - "slug": Lowercase alphanumeric slug with underscores (e.g. "velvet_matte_lipstick_front_view").

OUTPUT FORMAT:
Return ONLY a valid JSON object without markdown formatting, code fences, or backticks:
{
  "productName": "...",
  "category": "...",
  "title": "...",
  "altText": "...",
  "slug": "..."
}`;

        const payload = {
            contents: [
                {
                    role: 'user',
                    parts: [
                        { text: prompt },
                        { inlineData: { mimeType: inlineData.mimeType, data: inlineData.data } }
                    ]
                }
            ]
        };

        const res = await callAI('text', payload);
        const textPart = res?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!textPart) {
            throw new Error('AI 返回内容为空');
        }

        const parsed = (typeof safeExtractAndParseJson === 'function')
            ? safeExtractAndParseJson(textPart)
            : (() => {
                const match = textPart.match(/\{[\s\S]*\}/);
                if (!match) throw new Error('未能从 AI 响应中解析出结构化 JSON');
                return JSON.parse(match[0]);
            })();
        return {
            productName: (parsed.productName || '').trim(),
            category: (parsed.category || '').trim(),
            title: (parsed.title || '').trim(),
            altText: (parsed.altText || '').trim(),
            slug: (parsed.slug || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
        };
    }

    function populateTargetDropdowns() {
        const wpConfigs = STATE.configs.filter(c => c.storage_type === 'wordpress' && c.enabled);
        const shopifyConfigs = STATE.configs.filter(c => c.storage_type === 'shopify' && c.enabled);
        const r2Configs = STATE.configs.filter(c => c.storage_type === 'r2' && c.enabled);

        const wpSubSelect = document.getElementById('univWpSubSelect');
        const shopifySubSelect = document.getElementById('univShopifySubSelect');
        const wpContainer = document.getElementById('univWpSelectContainer');
        const shopifyContainer = document.getElementById('univShopifySelectContainer');
        const r2Container = document.getElementById('univR2InfoContainer');

        if (wpSubSelect && wpContainer) {
            wpSubSelect.innerHTML = '';
            if (wpConfigs.length > 0) {
                wpConfigs.forEach(cfg => {
                    const opt = document.createElement('option');
                    opt.value = cfg.id;
                    opt.textContent = `${cfg.name || 'WordPress'} (${cfg.wp_url || ''})`;
                    wpSubSelect.appendChild(opt);
                });
                wpContainer.classList.remove('hidden');
                if (STATE.storageType === 'wordpress' && !STATE.configId) {
                    STATE.configId = wpConfigs[0].id;
                }
            } else {
                wpContainer.classList.add('hidden');
            }
        }

        if (shopifySubSelect && shopifyContainer) {
            shopifySubSelect.innerHTML = '';
            if (shopifyConfigs.length > 0) {
                shopifyConfigs.forEach(cfg => {
                    const opt = document.createElement('option');
                    opt.value = cfg.id;
                    opt.textContent = `${cfg.name || 'Shopify 店铺'} (${cfg.shopify_shop_domain || ''})`;
                    shopifySubSelect.appendChild(opt);
                });
                shopifyContainer.classList.remove('hidden');
                if (STATE.storageType === 'shopify' && !STATE.configId) {
                    STATE.configId = shopifyConfigs[0].id;
                }
            } else {
                shopifyContainer.classList.add('hidden');
            }
        }

        if (r2Container) {
            const activeR2 = r2Configs[0];
            const r2Text = document.getElementById('univR2BucketText');
            if (activeR2 && r2Text) {
                r2Text.textContent = `存储桶: ${activeR2.r2_bucket_name || '-'} | CDN前缀: ${activeR2.r2_public_url || '默认'}`;
            }
        }
    }

    function switchUniversalStorageTarget(target) {
        STATE.storageType = target;
        STATE.configId = null;

        const tabs = ['r2', 'shopify', 'wordpress'];
        tabs.forEach(t => {
            const btn = document.getElementById(`univTabTarget_${t}`);
            const pane = document.getElementById(`univPaneTarget_${t}`);
            if (btn) {
                if (t === target) {
                    btn.classList.add('active', 'border-indigo-600', 'text-indigo-600', 'bg-indigo-50/60');
                    btn.classList.remove('border-transparent', 'text-slate-500', 'hover:bg-slate-50');
                } else {
                    btn.classList.remove('active', 'border-indigo-600', 'text-indigo-600', 'bg-indigo-50/60');
                    btn.classList.add('border-transparent', 'text-slate-500', 'hover:bg-slate-50');
                }
            }
            if (pane) {
                if (t === target) {
                    pane.classList.remove('hidden');
                } else {
                    pane.classList.add('hidden');
                }
            }
        });

        if (target === 'wordpress') {
            const sel = document.getElementById('univWpSubSelect');
            if (sel && sel.value) STATE.configId = parseInt(sel.value, 10);
        } else if (target === 'shopify') {
            const sel = document.getElementById('univShopifySubSelect');
            if (sel && sel.value) STATE.configId = parseInt(sel.value, 10);
        }

        updateConfigStatusFeedback();
    }

    function updateConfigStatusFeedback() {
        const feedbackEl = document.getElementById('univConfigNotice');
        if (!feedbackEl) return;

        const relevant = STATE.configs.filter(c => c.storage_type === STATE.storageType && c.enabled);
        if (relevant.length === 0) {
            feedbackEl.innerHTML = `
                <div class="flex items-center justify-between p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-xs">
                    <div class="flex items-center gap-2">
                        <i class="ph ph-warning text-base flex-shrink-0 text-amber-600"></i>
                        <span>当前尚未配置或启用 <strong>${STATE.storageType.toUpperCase()}</strong> 存储凭据。</span>
                    </div>
                    <button type="button" onclick="openStorageSettingsFromModal()" class="px-2.5 py-1 rounded-lg bg-white border border-amber-300 font-bold text-amber-700 hover:bg-amber-100 transition-colors shadow-2xs cursor-pointer">前往设置</button>
                </div>
            `;
            feedbackEl.classList.remove('hidden');
        } else {
            feedbackEl.innerHTML = '';
            feedbackEl.classList.add('hidden');
        }
    }

    async function openUniversalImageUploader(options = {}) {
        STATE.isBatchMode = false;
        STATE.isOpen = true;
        STATE.sourceModule = options.sourceModule || 'general';
        STATE.imageData = options.imageData || '';
        STATE.filename = options.filename || 'generated_image.png';

        // 智能生成默认 SEO 信息（避免原 options.title 包含 generic 占位名或机翻残留）
        let initialTitle = options.title || '';
        let initialAlt = options.altText || '';
        const isGenTitle = !initialTitle || isGenericPlaceholderName(initialTitle) || initialTitle.includes(' in 英文') || initialTitle.includes(' in 中文');
        const isGenAlt = !initialAlt || isGenericPlaceholderName(initialAlt) || initialAlt.includes(' in 英文') || initialAlt.includes(' in 中文');

        if (isGenTitle || isGenAlt) {
            const smart = generateSmartSeoMetadata({
                filename: STATE.filename,
                sourceModule: STATE.sourceModule,
                lang: options.lang || (STATE.filename.match(/_([A-Za-z]{2})\./)?.[1]) || '',
                index: 0
            });
            if (isGenTitle) initialTitle = smart.title;
            if (isGenAlt) initialAlt = smart.altText;
            if (isGenericPlaceholderName(STATE.filename.replace(/\.[^/.]+$/, ''))) {
                STATE.filename = smart.filename;
            }
        }

        STATE.title = initialTitle;
        STATE.altText = initialAlt;
        STATE.onSuccess = options.onSuccess || null;
        STATE.lastResult = null;
        STATE.isUploading = false;

        const modal = document.getElementById('universalUploaderModal');
        if (!modal) {
            console.error('[UniversalUploader] Modal container #universalUploaderModal not found in DOM');
            return;
        }

        // 1. 设置预览图与基本信息
        const previewImg = document.getElementById('univUploadPreviewImg');
        const filenameInput = document.getElementById('univUploadFilename');
        const titleInput = document.getElementById('univUploadTitle');
        const altInput = document.getElementById('univUploadAltText');
        const webpCheckbox = document.getElementById('univUploadWebpToggle');
        const qualityInput = document.getElementById('univUploadQuality');
        const singleContainer = document.getElementById('univSingleUploadContainer');
        const batchContainer = document.getElementById('univBatchUploadContainer');
        const resultCard = document.getElementById('univUploadResultCard');
        const uploadBtn = document.getElementById('btnUnivStartUpload');
        const batchBadge = document.getElementById('univWebpBatchBadge');

        if (previewImg) previewImg.src = STATE.imageData;
        if (filenameInput) filenameInput.value = STATE.filename;
        if (titleInput) titleInput.value = STATE.title;
        if (altInput) altInput.value = STATE.altText;
        if (webpCheckbox) webpCheckbox.checked = true;
        if (qualityInput) qualityInput.value = 90;
        if (batchBadge) batchBadge.classList.add('hidden');

        if (singleContainer) singleContainer.classList.remove('hidden');
        if (batchContainer) batchContainer.classList.add('hidden');
        if (resultCard) resultCard.classList.add('hidden');
        if (uploadBtn) {
            uploadBtn.disabled = false;
            uploadBtn.innerHTML = '<i class="ph-bold ph-cloud-arrow-up text-base"></i> 开始上传至云图床';
        }

        // 2. 加载存储配置并初始化目标选择器
        await loadStorageConfigs();
        populateTargetDropdowns();

        // 默认优先选择已配置的目标
        let defaultTarget = 'r2';
        const hasR2 = STATE.configs.some(c => c.storage_type === 'r2' && c.enabled);
        const hasShopify = STATE.configs.some(c => c.storage_type === 'shopify' && c.enabled);
        const hasWp = STATE.configs.some(c => c.storage_type === 'wordpress' && c.enabled);
        if (!hasR2 && hasShopify) defaultTarget = 'shopify';
        else if (!hasR2 && !hasShopify && hasWp) defaultTarget = 'wordpress';

        switchUniversalStorageTarget(defaultTarget);

        modal.classList.remove('hidden');
    }

    /**
     * 单图视觉 AI 识别并生成 SEO
     */
    async function triggerSingleVisionAiSeo(options = {}) {
        const btn = document.getElementById('univSingleVisionBtn');
        const hintInput = document.getElementById('univSingleProductHint');
        const filenameInput = document.getElementById('univUploadFilename');
        const titleInput = document.getElementById('univUploadTitle');
        const altInput = document.getElementById('univUploadAltText');

        const hint = hintInput ? hintInput.value.trim() : '';
        const currentFilename = filenameInput ? filenameInput.value.trim() : STATE.filename;
        const originalBtnHtml = btn ? btn.innerHTML : '';

        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="ph ph-spinner animate-spin text-sm"></i> 视觉识别分析中...';
        }

        try {
            const visionResult = await recognizeImageWithVisionAI(STATE.imageData, {
                hint: hint,
                sourceModule: STATE.sourceModule,
                lang: STATE.targetLang || (currentFilename.match(/_([A-Za-z]{2})\./)?.[1]) || ''
            });

            if (visionResult.title && titleInput) {
                titleInput.value = visionResult.title;
                STATE.title = visionResult.title;
            }
            if (visionResult.altText && altInput) {
                altInput.value = visionResult.altText;
                STATE.altText = visionResult.altText;
            }
            if (visionResult.slug && filenameInput) {
                const currentExt = (currentFilename.match(/\.[a-zA-Z0-9]+$/)?.[0]) || '.png';
                const newFilename = `${visionResult.slug}${currentExt}`;
                filenameInput.value = newFilename;
                STATE.filename = newFilename;
            }

            if (typeof showToast === 'function') {
                showToast(`视觉 AI 识别完成：已生成 ${visionResult.productName || '商品'} 的精准 SEO！`, 'success');
            }
            return visionResult;
        } catch (err) {
            console.warn('[UniversalUploader] Vision AI recognition failed, fallback used:', err);
            // 优雅降级为智能确定性生成
            const smart = generateSmartSeoMetadata({
                filename: currentFilename,
                sourceModule: STATE.sourceModule,
                productName: hint,
                index: 0
            });
            if (titleInput) {
                titleInput.value = smart.title;
                STATE.title = smart.title;
            }
            if (altInput) {
                altInput.value = smart.altText;
                STATE.altText = smart.altText;
            }
            if (filenameInput && isGenericPlaceholderName(currentFilename.replace(/\.[^/.]+$/, ''))) {
                filenameInput.value = smart.filename;
                STATE.filename = smart.filename;
            }
            if (!options.silent && typeof showToast === 'function') {
                showToast(`视觉识别降级：已通过智能规则生成中立 SEO`, 'info');
            }
            return smart;
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = originalBtnHtml || '<i class="ph-bold ph-eye text-indigo-600"></i><span>✨ 视觉 AI 识别并生成 SEO</span>';
            }
        }
    }

    async function triggerSmartSeoGenerationForCurrentSingle(options = {}) {
        return await triggerSingleVisionAiSeo(options);
    }

    async function openUniversalBatchUploader(options = {}) {
        STATE.isBatchMode = true;
        STATE.isOpen = true;
        STATE.sourceModule = options.sourceModule || 'general';
        const rawItems = Array.isArray(options.items) ? options.items : [];
        STATE.batchQueue = rawItems.map((item, idx) => {
            const rawFile = item.filename || `image_${idx + 1}.png`;
            const currentTitle = item.title || '';
            const currentAlt = item.altText || '';
            const isGenTitle = !currentTitle || isGenericPlaceholderName(currentTitle) || currentTitle.includes(' in 英文') || currentTitle.includes(' in 中文');
            const isGenAlt = !currentAlt || isGenericPlaceholderName(currentAlt) || currentAlt.includes(' in 英文') || currentAlt.includes(' in 中文');

            if (isGenTitle || isGenAlt) {
                const smart = generateSmartSeoMetadata({
                    filename: rawFile,
                    sourceModule: STATE.sourceModule,
                    lang: options.lang || item.lang || (rawFile.match(/_([A-Za-z]{2})\./)?.[1]) || '',
                    index: idx
                });
                return {
                    ...item,
                    filename: (!item.filename || isGenericPlaceholderName(item.filename.replace(/\.[^/.]+$/, ''))) ? smart.filename : item.filename,
                    title: isGenTitle ? smart.title : currentTitle,
                    altText: isGenAlt ? smart.altText : currentAlt
                };
            }
            return { ...item };
        });

        STATE.onBatchComplete = options.onComplete || null;
        STATE.isUploading = false;
        STATE.batchProgress = {
            total: STATE.batchQueue.length,
            current: 0,
            successful: 0,
            failed: 0
        };

        const modal = document.getElementById('universalUploaderModal');
        if (!modal) return;

        const singleContainer = document.getElementById('univSingleUploadContainer');
        const batchContainer = document.getElementById('univBatchUploadContainer');
        const resultCard = document.getElementById('univUploadResultCard');
        const uploadBtn = document.getElementById('btnUnivStartUpload');
        const batchCountText = document.getElementById('univBatchCountText');
        const batchBadge = document.getElementById('univWebpBatchBadge');
        const brandDesc = document.getElementById('univBatchBrandContextDesc');
        const batchHintInput = document.getElementById('univBatchProductHint');

        if (singleContainer) singleContainer.classList.add('hidden');
        if (batchContainer) batchContainer.classList.remove('hidden');
        if (resultCard) resultCard.classList.add('hidden');
        if (batchBadge) batchBadge.classList.remove('hidden');

        if (batchHintInput) batchHintInput.value = '';

        if (brandDesc) {
            brandDesc.textContent = '✨ 视觉 AI 模式已就绪，可一键自动分析每张图片真实画面生成精准 SEO';
        }

        if (batchCountText) {
            batchCountText.textContent = `共 ${STATE.batchQueue.length} 张待上传图片`;
        }

        renderBatchList();

        if (uploadBtn) {
            uploadBtn.disabled = false;
            uploadBtn.innerHTML = `<i class="ph-bold ph-cloud-arrow-up text-base"></i> 开始批量上传 (${STATE.batchQueue.length}张)`;
        }

        await loadStorageConfigs();
        populateTargetDropdowns();
        switchUniversalStorageTarget('r2');

        modal.classList.remove('hidden');
    }

    function renderBatchList() {
        const batchList = document.getElementById('univBatchItemList');
        if (!batchList) return;

        batchList.innerHTML = STATE.batchQueue.map((item, idx) => `
            <div class="p-3 rounded-2xl bg-white border border-slate-200/80 shadow-2xs flex flex-col gap-2.5 text-xs transition-all hover:border-indigo-200" id="univBatchRow_${idx}">
                <div class="flex items-center gap-3">
                    <img src="${item.imageData || ''}" class="w-12 h-12 object-cover rounded-xl border border-slate-200 bg-slate-50 flex-shrink-0" alt="thumb">
                    <div class="flex-1 min-w-0">
                        <div class="flex items-center justify-between mb-1">
                            <span class="text-[10px] font-bold text-slate-400 uppercase tracking-wider">图片 #${idx + 1} 保存文件名</span>
                            <div class="text-[11px] font-bold text-slate-500" id="univBatchStatus_${idx}">待上传</div>
                        </div>
                        <input type="text" id="univBatchFile_${idx}" value="${escapeHtml(item.filename || `image_${idx + 1}.png`)}" oninput="window.universalUploader.updateBatchItemField(${idx}, 'filename', this.value)" class="w-full bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1 text-xs font-bold text-slate-800 outline-none focus:bg-white focus:border-indigo-500">
                    </div>
                    <button type="button" onclick="window.universalUploader.triggerSingleBatchItemVisionSeo(${idx})" class="text-[11px] font-bold text-indigo-600 hover:text-indigo-800 bg-indigo-50 hover:bg-indigo-100 px-2.5 py-1.5 rounded-lg flex items-center gap-1 transition-colors cursor-pointer flex-shrink-0" title="为此图片单独重新执行视觉 AI 识别">
                        <i class="ph-bold ph-sparkle"></i> AI 识别
                    </button>
                </div>
                <div class="grid grid-cols-2 gap-2 pt-1 border-t border-slate-100">
                    <div class="flex flex-col gap-1">
                        <label class="text-[10px] font-bold text-slate-500 flex items-center justify-between">
                            <span>SEO 标题 (Title)</span>
                        </label>
                        <input type="text" id="univBatchTitle_${idx}" value="${escapeHtml(item.title || '')}" oninput="window.universalUploader.updateBatchItemField(${idx}, 'title', this.value)" class="w-full bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1 text-xs text-slate-800 outline-none focus:bg-white focus:border-indigo-500 font-medium" placeholder="SEO Title">
                    </div>
                    <div class="flex flex-col gap-1">
                        <label class="text-[10px] font-bold text-slate-500 flex items-center justify-between">
                            <span>替代文本 (Alt Text)</span>
                        </label>
                        <input type="text" id="univBatchAlt_${idx}" value="${escapeHtml(item.altText || '')}" oninput="window.universalUploader.updateBatchItemField(${idx}, 'altText', this.value)" class="w-full bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1 text-xs text-slate-800 outline-none focus:bg-white focus:border-indigo-500 font-medium" placeholder="Alt Text">
                    </div>
                </div>
            </div>
        `).join('');
    }

    function updateBatchItemField(index, field, value) {
        if (!STATE.batchQueue[index]) return;
        STATE.batchQueue[index][field] = value;
    }

    async function triggerSingleBatchItemVisionSeo(index) {
        const item = STATE.batchQueue[index];
        if (!item) return;

        const hintInput = document.getElementById('univBatchProductHint');
        const hint = hintInput ? hintInput.value.trim() : '';
        const statusEl = document.getElementById(`univBatchStatus_${index}`);
        if (statusEl) {
            statusEl.innerHTML = '<span class="text-indigo-600 font-bold flex items-center gap-1"><i class="ph ph-spinner animate-spin"></i> 识别中...</span>';
        }

        try {
            const res = await recognizeImageWithVisionAI(item.imageData, {
                hint: hint,
                sourceModule: STATE.sourceModule,
                lang: item.lang || (item.filename?.match(/_([A-Za-z]{2})\./)?.[1]) || '',
                index: index
            });

            item.title = res.title;
            item.altText = res.altText;
            if (res.slug) {
                const ext = (item.filename?.match(/\.[a-zA-Z0-9]+$/)?.[0]) || '.png';
                item.filename = `${res.slug}_${index + 1}${ext}`;
            }

            const fileInp = document.getElementById(`univBatchFile_${index}`);
            const titleInp = document.getElementById(`univBatchTitle_${index}`);
            const altInp = document.getElementById(`univBatchAlt_${index}`);
            if (fileInp) fileInp.value = item.filename;
            if (titleInp) titleInp.value = item.title;
            if (altInp) altInp.value = item.altText;

            if (statusEl) {
                statusEl.innerHTML = '<span class="text-emerald-600 font-bold flex items-center gap-1"><i class="ph-bold ph-check"></i> 已识别</span>';
            }
            if (typeof showToast === 'function') showToast(`第 ${index + 1} 张图片视觉 AI 识别完成`, 'success');
        } catch (err) {
            console.warn(`[UniversalUploader] Single batch item #${index + 1} Vision AI failed:`, err);
            generateItemSeo(index);
        }
    }

    async function triggerBatchVisionAiSeo(options = {}) {
        if (!STATE.batchQueue.length) {
            if (typeof showToast === 'function') showToast('待上传队列为空', 'warning');
            return;
        }

        const btn = document.getElementById('univBatchVisionBtn');
        const hintInput = document.getElementById('univBatchProductHint');
        const hint = hintInput ? hintInput.value.trim() : '';
        const originalBtnHtml = btn ? btn.innerHTML : '';

        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="ph ph-spinner animate-spin text-sm"></i> 视觉批量识别中...';
        }

        let successCount = 0;
        let fallbackCount = 0;

        for (let idx = 0; idx < STATE.batchQueue.length; idx++) {
            const item = STATE.batchQueue[idx];
            const statusEl = document.getElementById(`univBatchStatus_${idx}`);
            if (statusEl) {
                statusEl.innerHTML = '<span class="text-indigo-600 font-bold flex items-center gap-1"><i class="ph ph-spinner animate-spin"></i> 视觉识别中...</span>';
            }

            try {
                const res = await recognizeImageWithVisionAI(item.imageData, {
                    hint: hint,
                    sourceModule: STATE.sourceModule,
                    lang: item.lang || (item.filename?.match(/_([A-Za-z]{2})\./)?.[1]) || '',
                    index: idx
                });

                item.title = res.title;
                item.altText = res.altText;
                if (res.slug) {
                    const ext = (item.filename?.match(/\.[a-zA-Z0-9]+$/)?.[0]) || '.png';
                    item.filename = `${res.slug}_${idx + 1}${ext}`;
                }

                const fileInp = document.getElementById(`univBatchFile_${idx}`);
                const titleInp = document.getElementById(`univBatchTitle_${idx}`);
                const altInp = document.getElementById(`univBatchAlt_${idx}`);
                if (fileInp) fileInp.value = item.filename;
                if (titleInp) titleInp.value = item.title;
                if (altInp) altInp.value = item.altText;

                if (statusEl) {
                    statusEl.innerHTML = '<span class="text-emerald-600 font-bold flex items-center gap-1"><i class="ph-bold ph-check"></i> 已识别</span>';
                }
                successCount++;
            } catch (err) {
                console.warn(`[UniversalUploader] Batch item #${idx + 1} Vision AI failed:`, err);
                const smart = generateSmartSeoMetadata({
                    filename: item.filename,
                    sourceModule: STATE.sourceModule,
                    productName: hint,
                    lang: item.lang || (item.filename?.match(/_([A-Za-z]{2})\./)?.[1]) || '',
                    index: idx
                });
                item.title = smart.title;
                item.altText = smart.altText;
                if (!item.filename || isGenericPlaceholderName(item.filename.replace(/\.[^/.]+$/, ''))) {
                    item.filename = smart.filename;
                }

                const fileInp = document.getElementById(`univBatchFile_${idx}`);
                const titleInp = document.getElementById(`univBatchTitle_${idx}`);
                const altInp = document.getElementById(`univBatchAlt_${idx}`);
                if (fileInp) fileInp.value = item.filename;
                if (titleInp) titleInp.value = item.title;
                if (altInp) altInp.value = item.altText;

                if (statusEl) {
                    statusEl.innerHTML = '<span class="text-slate-500 font-bold">已生成(规则)</span>';
                }
                fallbackCount++;
            }
        }

        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalBtnHtml || '<i class="ph-bold ph-sparkle"></i><span>✨ 视觉 AI 批量识别全量 SEO</span>';
        }

        if (typeof showToast === 'function') {
            if (successCount > 0) {
                showToast(`批量视觉识别完成：成功识别 ${successCount} 张图片！`, 'success');
            } else {
                showToast(`已通过规则引擎为 ${fallbackCount} 张图片生成规范 SEO 元数据`, 'info');
            }
        }
    }

    function batchApplyHintToQueue() {
        if (!STATE.batchQueue.length) return;
        const hintInput = document.getElementById('univBatchProductHint');
        const hint = hintInput ? hintInput.value.trim() : '';

        STATE.batchQueue.forEach((item, idx) => {
            const smart = generateSmartSeoMetadata({
                filename: item.filename,
                sourceModule: STATE.sourceModule,
                productName: hint,
                lang: item.lang || (item.filename?.match(/_([A-Za-z]{2})\./)?.[1]) || '',
                index: idx
            });
            item.title = smart.title;
            item.altText = smart.altText;
            if (!item.filename || isGenericPlaceholderName(item.filename.replace(/\.[^/.]+$/, ''))) {
                item.filename = smart.filename;
                const fileInp = document.getElementById(`univBatchFile_${idx}`);
                if (fileInp) fileInp.value = item.filename;
            }
            const titleInp = document.getElementById(`univBatchTitle_${idx}`);
            const altInp = document.getElementById(`univBatchAlt_${idx}`);
            if (titleInp) titleInp.value = item.title;
            if (altInp) altInp.value = item.altText;
            const statusEl = document.getElementById(`univBatchStatus_${idx}`);
            if (statusEl) statusEl.textContent = '已套用';
        });
        if (typeof showToast === 'function') {
            showToast(`已按 "${hint || '通用商品'}" 快速套用全量 ${STATE.batchQueue.length} 张图片 SEO`, 'success');
        }
    }

    function generateItemSeo(index) {
        const item = STATE.batchQueue[index];
        if (!item) return;
        const smart = generateSmartSeoMetadata({
            filename: item.filename,
            sourceModule: STATE.sourceModule,
            lang: item.lang || (item.filename?.match(/_([A-Za-z]{2})\./)?.[1]) || '',
            index: index
        });
        item.title = smart.title;
        item.altText = smart.altText;
        if (!item.filename || isGenericPlaceholderName(item.filename.replace(/\.[^/.]+$/, ''))) {
            item.filename = smart.filename;
            const fileInp = document.getElementById(`univBatchFile_${index}`);
            if (fileInp) fileInp.value = item.filename;
        }
        const titleInp = document.getElementById(`univBatchTitle_${index}`);
        const altInp = document.getElementById(`univBatchAlt_${index}`);
        if (titleInp) titleInp.value = item.title;
        if (altInp) altInp.value = item.altText;
        if (typeof showToast === 'function') showToast(`第 ${index + 1} 张图片 SEO 已重新生成`, 'success');
    }

    function batchApplySmartSeoToQueue() {
        if (!STATE.batchQueue.length) return;
        STATE.batchQueue.forEach((item, idx) => {
            const smart = generateSmartSeoMetadata({
                filename: item.filename,
                sourceModule: STATE.sourceModule,
                lang: item.lang || (item.filename?.match(/_([A-Za-z]{2})\./)?.[1]) || '',
                index: idx
            });
            item.title = smart.title;
            item.altText = smart.altText;
            if (!item.filename || isGenericPlaceholderName(item.filename.replace(/\.[^/.]+$/, ''))) {
                item.filename = smart.filename;
                const fileInp = document.getElementById(`univBatchFile_${idx}`);
                if (fileInp) fileInp.value = item.filename;
            }
            const titleInp = document.getElementById(`univBatchTitle_${idx}`);
            const altInp = document.getElementById(`univBatchAlt_${idx}`);
            if (titleInp) titleInp.value = item.title;
            if (altInp) altInp.value = item.altText;
        });
        if (typeof showToast === 'function') showToast(`已为全量 ${STATE.batchQueue.length} 张图片填充智能 SEO`, 'success');
    }

    function closeUniversalImageUploader() {
        const modal = document.getElementById('universalUploaderModal');
        if (modal) modal.classList.add('hidden');
        const batchBadge = document.getElementById('univWebpBatchBadge');
        if (batchBadge) batchBadge.classList.add('hidden');
        STATE.isOpen = false;
        STATE.isUploading = false;
    }

    function openStorageSettingsFromModal() {
        closeUniversalImageUploader();
        if (typeof switchMainTab === 'function') {
            switchMainTab('settings');
        }
        setTimeout(() => {
            if (typeof switchSettingsTab === 'function') {
                switchSettingsTab('storage');
            }
        }, 150);
    }

    async function executeUniversalImageUpload() {
        if (STATE.isUploading) return;

        const uploadBtn = document.getElementById('btnUnivStartUpload');
        const resultCard = document.getElementById('univUploadResultCard');
        const webpToggle = document.getElementById('univUploadWebpToggle');
        const qualityInput = document.getElementById('univUploadQuality');

        const shouldCompress = webpToggle ? webpToggle.checked : true;
        const quality = qualityInput ? parseInt(qualityInput.value, 10) || 90 : 90;

        if (STATE.isBatchMode) {
            await executeBatchProcess(shouldCompress, quality);
            return;
        }

        const titleInput = document.getElementById('univUploadTitle');
        const altInput = document.getElementById('univUploadAltText');
        const filenameInput = document.getElementById('univUploadFilename');

        const title = titleInput ? titleInput.value.trim() : STATE.title;
        const altText = altInput ? altInput.value.trim() : STATE.altText;
        let filename = filenameInput ? filenameInput.value.trim() : STATE.filename;

        if (shouldCompress && !filename.toLowerCase().endsWith('.webp')) {
            filename = filename.replace(/\.(png|jpe?g|gif)$/i, '') + '.webp';
        }

        // 验证存储有效性
        const relevant = STATE.configs.filter(c => c.storage_type === STATE.storageType && c.enabled);
        if (relevant.length === 0) {
            if (typeof showToast === 'function') showToast(`请先配置 ${STATE.storageType.toUpperCase()} 存储凭据`, 'warning');
            return;
        }

        STATE.isUploading = true;
        if (uploadBtn) {
            uploadBtn.disabled = true;
            uploadBtn.innerHTML = '<span class="loader w-3.5 h-3.5 border-white border-t-transparent inline-block"></span> 正在上传并优化中...';
        }

        try {
            const payload = {
                storage_type: STATE.storageType,
                config_id: STATE.configId > 0 ? STATE.configId : null,
                image_data: STATE.imageData,
                filename: filename,
                mime_type: shouldCompress ? 'image/webp' : 'image/png',
                convert_to_webp: shouldCompress,
                quality: quality,
                title: title,
                alt_text: altText
            };

            const res = await fetch(`${getApiBase()}/api/storage/upload-image`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const data = await res.json().catch(() => ({}));
            if (res.ok && data.success && data.remote_url) {
                STATE.lastResult = data;
                if (typeof showToast === 'function') showToast('图片成功上传并托管至云图床！', 'success');

                if (resultCard) {
                    resultCard.classList.remove('hidden');
                    const urlInput = document.getElementById('univResultUrlInput');
                    const previewLink = document.getElementById('univResultPreviewLink');
                    if (urlInput) urlInput.value = data.remote_url;
                    if (previewLink) previewLink.href = data.remote_url;
                }

                if (typeof STATE.onSuccess === 'function') {
                    try { STATE.onSuccess(data); } catch (e) { console.error(e); }
                }
            } else {
                const errMsg = data.error || data.detail || data.message || `上传失败 (HTTP ${res.status})`;
                if (typeof showToast === 'function') showToast(`上传失败: ${errMsg}`, 'error');
            }
        } catch (err) {
            console.error('[UniversalUploader] Upload failed:', err);
            if (typeof showToast === 'function') showToast(`网络错误: ${err.message}`, 'error');
        } finally {
            STATE.isUploading = false;
            if (uploadBtn) {
                uploadBtn.disabled = false;
                uploadBtn.innerHTML = '<i class="ph-bold ph-check text-base"></i> 再次上传 / 更新';
            }
        }
    }

    async function executeBatchProcess(shouldCompress, quality) {
        STATE.isUploading = true;
        const uploadBtn = document.getElementById('btnUnivStartUpload');
        const results = [];

        for (let i = 0; i < STATE.batchQueue.length; i++) {
            const item = STATE.batchQueue[i];
            const statusEl = document.getElementById(`univBatchStatus_${i}`);
            const fileInp = document.getElementById(`univBatchFile_${i}`);
            const titleInp = document.getElementById(`univBatchTitle_${i}`);
            const altInp = document.getElementById(`univBatchAlt_${i}`);

            if (fileInp && fileInp.value) item.filename = fileInp.value.trim();
            if (titleInp && titleInp.value) item.title = titleInp.value.trim();
            if (altInp && altInp.value) item.altText = altInp.value.trim();

            if (statusEl) statusEl.innerHTML = '<span class="text-blue-600 font-bold">上传中...</span>';

            let filename = item.filename || `batch_img_${i + 1}.png`;
            if (shouldCompress && !filename.toLowerCase().endsWith('.webp')) {
                filename = filename.replace(/\.(png|jpe?g|gif)$/i, '') + '.webp';
            }

            try {
                const payload = {
                    storage_type: STATE.storageType,
                    config_id: STATE.configId > 0 ? STATE.configId : null,
                    image_data: item.imageData,
                    filename: filename,
                    mime_type: shouldCompress ? 'image/webp' : 'image/png',
                    convert_to_webp: shouldCompress,
                    quality: quality,
                    title: item.title || sanitizeNameForSeo(filename),
                    alt_text: item.altText || item.title || 'Product Image'
                };

                const res = await fetch(`${getApiBase()}/api/storage/upload-image`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                const data = await res.json().catch(() => ({}));
                if (res.ok && data.success && data.remote_url) {
                    results.push(data);
                    if (statusEl) statusEl.innerHTML = '<span class="text-emerald-600 font-bold">✔ 成功</span>';
                } else {
                    if (statusEl) statusEl.innerHTML = '<span class="text-rose-500 font-bold">✖ 失败</span>';
                }
            } catch (e) {
                if (statusEl) statusEl.innerHTML = '<span class="text-rose-500 font-bold">✖ 错误</span>';
            }
        }

        STATE.isUploading = false;
        if (uploadBtn) {
            uploadBtn.disabled = false;
            uploadBtn.innerHTML = '<i class="ph-bold ph-check text-base"></i> 批量处理完成';
        }

        if (typeof showToast === 'function') {
            showToast(`批量上传完成：成功 ${results.length} / ${STATE.batchQueue.length} 项`, 'success');
        }

        if (typeof STATE.onBatchComplete === 'function') {
            try { STATE.onBatchComplete(results); } catch (e) { console.error(e); }
        }
    }

    function copyResultRemoteUrl() {
        const urlInput = document.getElementById('univResultUrlInput');
        if (!urlInput || !urlInput.value) return;
        navigator.clipboard.writeText(urlInput.value).then(() => {
            if (typeof showToast === 'function') showToast('云图床远程 CDN 链接已复制到剪贴板！', 'success');
        }).catch(() => {
            urlInput.select();
            document.execCommand('copy');
            if (typeof showToast === 'function') showToast('链接已复制！', 'success');
        });
    }

    // 全局暴露
    const exportsObj = {
        openUniversalImageUploader,
        openUniversalBatchUploader,
        closeUniversalImageUploader,
        switchUniversalStorageTarget,
        executeUniversalImageUpload,
        copyResultRemoteUrl,
        openStorageSettingsFromModal,
        sanitizeNameForSeo,
        generateSmartSeoMetadata,
        isGenericPlaceholderName,
        recognizeImageWithVisionAI,
        getImageInlineData,
        triggerSingleVisionAiSeo,
        triggerBatchVisionAiSeo,
        triggerSingleBatchItemVisionSeo,
        batchApplyHintToQueue,
        triggerSmartSeoGenerationForCurrentSingle,
        batchApplySmartSeoToQueue,
        updateBatchItemField,
        generateItemSeo
    };

    if (typeof window !== 'undefined') {
        window.openUniversalImageUploader = openUniversalImageUploader;
        window.openUniversalBatchUploader = openUniversalBatchUploader;
        window.closeUniversalImageUploader = closeUniversalImageUploader;
        window.switchUniversalStorageTarget = switchUniversalStorageTarget;
        window.executeUniversalImageUpload = executeUniversalImageUpload;
        window.copyResultRemoteUrl = copyResultRemoteUrl;
        window.openStorageSettingsFromModal = openStorageSettingsFromModal;
        window.generateSmartSeoMetadata = generateSmartSeoMetadata;
        window.triggerSmartSeoGenerationForCurrentSingle = triggerSmartSeoGenerationForCurrentSingle;
        window.triggerSingleVisionAiSeo = triggerSingleVisionAiSeo;
        window.triggerBatchVisionAiSeo = triggerBatchVisionAiSeo;
        window.batchApplySmartSeoToQueue = batchApplySmartSeoToQueue;
        window.universalUploader = exportsObj;
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = exportsObj;
    }
})();
