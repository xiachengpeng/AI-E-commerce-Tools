// ==========================================
// 【静态配置文件】
// ==========================================

const MODULES_CONFIG = [
    { id: 'm1', title: '首屏认知', promptTitle: 'Hero Product Understanding', subtitle: '让用户秒懂产品', active: false, count: 1, includeText: true, prompt: "Create a clear hero section that immediately explains what the product is, who it is for, and the primary benefit. Use one short headline, one short support line, and up to three proof-oriented callouts." },
    { id: 'm2', title: '核心功能证明', promptTitle: 'Core Benefit Proof', subtitle: '给出购买理由', active: false, count: 1, includeText: true, prompt: "Create a focused benefit infographic. Each version must cover a different buying reason, with no repeated headline angle across variants." },
    { id: 'm3', title: '场景/痛点唤醒', promptTitle: 'Usage Scenario and Pain Point', subtitle: '展示真实使用需求', active: false, count: 1, includeText: true, prompt: "Create a believable lifestyle usage scene with realistic product scale, natural lighting, and a single user context solving a daily pain point. Avoid exaggerated transformation claims." },
    { id: 'm4', title: '外观/多角度证明', promptTitle: 'Appearance and Multi-Angle Proof', subtitle: '降低看不清疑虑', active: false, count: 1, includeText: true, prompt: "Create a layout showing a collage of different angle views of the product on a clean studio background." },
    { id: 'm5', title: '生活方式氛围', promptTitle: 'Lifestyle Atmosphere', subtitle: '强化使用代入感', active: false, count: 1, includeText: true, prompt: "Create an atmospheric lifestyle shot with warm lighting, setting a mood that perfectly fits the product's aesthetic." },
    { id: 'm6', title: '细节/材质证明', promptTitle: 'Detail and Material Proof', subtitle: '放大关键做工', active: false, count: 1, includeText: true, prompt: "Create a macro close-up shot highlighting the premium material, texture, and exquisite craftsmanship of the product." },
    { id: 'm7', title: '品牌/定位表达', promptTitle: 'Brand Positioning Expression', subtitle: '建立产品调性', active: false, count: 1, includeText: true, prompt: "Create an editorial layout with a brand story aesthetic, combining the product with lifestyle elements and elegant text space." },
    { id: 'm8', title: '尺寸/收纳证明', promptTitle: 'Size and Storage Proof', subtitle: '消除空间疑虑', active: false, count: 1, includeText: true, prompt: "Create a technical drawing or infographic style image showing exact dimensions, size proportions, or capacity with measurement lines." },
    { id: 'm9', title: '对比差异证明', promptTitle: 'Objective Comparison Proof', subtitle: '说明为什么选它', active: false, count: 1, includeText: true, prompt: "Create an objective comparison table between a single-function alternative and this product. Use factual feature rows, not exaggerated superiority claims." },
    { id: 'm10', title: '参数规格确认', promptTitle: 'Specification Confirmation', subtitle: '用事实消除顾虑', active: false, count: 1, includeText: true, prompt: "Create a clean specification section. Only show parameters that are present in the supplied product information or clearly visible in the reference image." },
    { id: 'm11', title: '信任/售后背书', promptTitle: 'Trust and After-Sales Support', subtitle: '降低下单风险', active: false, count: 1, includeText: true, prompt: "Create a trust-building after-sales section using warranty, support, shipping, returns, maintenance, or package-list cues only when provided. Do not invent certifications." },
    { id: 'm12', title: '使用/维护指引', promptTitle: 'Usage and Maintenance Guide', subtitle: '降低使用门槛', active: false, count: 1, includeText: true, prompt: "Create an instructional step-by-step guide or usage tips layout showing how to properly use or maintain the product with clear visual cues." },
    { id: 'm13', title: '全家福拆解清单', promptTitle: "What's in the Box / Bundle Breakdown", subtitle: '工整陈列所有配件与数量', active: false, count: 1, includeText: true, prompt: "Create an organized knolling / flat-lay composition showing the complete kit and what's in the box. Display the hero item cleanly alongside every accessory, replacement part, and cable in an orderly grid layout with clear visual hierarchy." },
    { id: 'm14', title: '组合超值算账对比', promptTitle: 'Bundle Value and Savings Comparison', subtitle: '量化1+1>2一站式省心', active: false, count: 1, includeText: true, prompt: "Create a value-comparison visual highlighting the bundle package advantage. Show the complete bundle set on one side and communicate all-in-one convenience and significant savings compared to buying individual parts separately." },
    { id: 'm15', title: '分步协同使用动线', promptTitle: 'Multi-Step Routine and Synergy', subtitle: '展示多件搭配使用流', active: false, count: 1, includeText: true, prompt: "Create an instructional multi-step routine layout showing how the different items in this set work together sequentially (Step 1, Step 2, Step 3) to achieve the complete outcome." },
    { id: 'm16', title: '关键配件精工特写', promptTitle: 'Key Accessory Craft and Spec', subtitle: '打消配件廉价劣质疑虑', active: false, count: 1, includeText: true, prompt: "Create a macro close-up shot highlighting the premium build quality, precise fit, and durable materials of the core accessories and attachments included in the package." },
    { id: 'm17', title: '爆炸拆解/精密构造', promptTitle: 'Exploded View / Precision Engineering', subtitle: '硬核内部构造与工匠级机芯/零件透视', active: false, count: 1, includeText: true, prompt: "Create an exploded view / precision deconstructed layout showing the internal engineering and core components floating in perfect alignment alongside the main product. High-end industrial design aesthetic with clean leader lines, metallic reflections, and subtle callouts." },
    { id: 'm18', title: 'UGC买家秀/社交背书', promptTitle: 'UGC Social Proof / Unboxing Card', subtitle: '真实买家生活开箱与高转化口碑评价', active: false, count: 1, includeText: true, prompt: "Create a realistic UGC / social unboxing card showing the product in an authentic everyday consumer setting with a clean, high-trust 5-star customer review quote overlay and authentic lifestyle context." }
];

if (typeof globalThis !== 'undefined') {
    globalThis.MODULES_CONFIG = MODULES_CONFIG;
}

const PLATFORM_OPTIONS = [
    { value: "Independent Website (Shopify-like, highly aesthetic, minimalist, lifestyle-focused)", label: "独立站" },
    { value: "Amazon (clean white background, highly informative, feature-focused)",               label: "亚马逊" },
    { value: "Walmart Marketplace (trustworthy, value-focused, practical, clear retail presentation)", label: "Walmart" },
    { value: "eBay (deal-oriented, clear product condition, value and buyer confidence focused)", label: "eBay" },
    { value: "Etsy (handcrafted, boutique, story-led, warm and creative marketplace style)", label: "Etsy" },
    { value: "TikTok Shop (mobile-first, bold hook, social-commerce energy, fast benefit clarity)", label: "TikTok Shop" }
];

if (typeof globalThis !== 'undefined') {
    globalThis.PLATFORM_OPTIONS = PLATFORM_OPTIONS;
}

const REGION_OPTIONS = [
    { value: "US Market",           label: "美国 (US)" },
    { value: "UK Market",           label: "英国 (UK)" },
    { value: "Germany Market",      label: "德国 (Germany/DE)" },
    { value: "France Market",       label: "法国 (France/FR)" },
    { value: "Spain Market",        label: "西班牙 (Spain/ES)" },
    { value: "Italy Market",        label: "意大利 (Italy/IT)" },
    { value: "European Market",     label: "欧洲综合 (Europe)" },
    { value: "Japan Market",        label: "日本 (Japan)" },
    { value: "Southeast Asia Market", label: "东南亚 (SEA)" },
    { value: "Middle East Market",  label: "中东 (Middle East)" },
    { value: "Australian Market",   label: "澳大利亚 (Australia)" },
    { value: "Global Market",       label: "全球 (Global)" }
];

const MARKET_TONE_MAP = {
    "US Market": "Direct, benefit-led, confident, conversion-focused, but factual and compliant.",
    "UK Market": "Polite, practical, value-aware, lightly witty, professional and approachable.",
    "Germany Market": "Thorough, structured, specification-accurate, engineering-led, reliable and certified.",
    "France Market": "Artistic, elegant, lifestyle-centric, refined and sensorial.",
    "Spain Market": "Warm, expressive, family/social-oriented, vivid and benefit-driven.",
    "Italy Market": "Stylish, aesthetic-conscious, passionate, design-driven and craftsmanship-oriented.",
    "European Market": "Refined, design-conscious, quality-focused, sustainability-aware, clear and restrained.",
    "Japan Market": "Precise, detail-oriented, trust-building, polite, calm, and reassurance-focused.",
    "Southeast Asia Market": "Bright, energetic, promotion-aware, urgency-driven, but still factual.",
    "Middle East Market": "Premium, dignified, elegant, comfort-focused, and respectful of lifestyle context.",
    "Australian Market": "Relaxed, practical, lifestyle-led, friendly, and straightforward.",
    "Global Market": "Neutral, professional, broadly understandable, clear, and practical."
};

const ASPECT_RATIO_OPTIONS = [
    { value: "1:1",    label: "1:1 (正方形)" },
    { value: "3:4",    label: "3:4 (竖图)" },
    { value: "16:9",   label: "16:9 (横图)" },
    { value: "custom", label: "自定义比例" }
];

const IMAGE_STYLE_OPTIONS = [
    { value: "High-end minimalist, clean, premium, sophisticated", label: "高端极简" },
    { value: "Trendy, vibrant, TikTok viral style, energetic, bold", label: "TikTok爆款" },
    { value: "Light luxury, elegant, glossy, high-fashion aesthetic", label: "轻奢风" },
    { value: "Tech-focused, cyberpunk, modern, neon accents", label: "科技风" },
    { value: "Natural, organic, warm, cozy, lifestyle photography", label: "自然原木" },
    { value: "Amazon infographic style, clean white background, structured callouts", label: "亚马逊信息图风" },
    { value: "Shopify premium lifestyle style, editorial product photography, elegant spacing", label: "Shopify高级生活方式风" },
    { value: "Realistic home interior scene, natural daylight, credible product scale", label: "家居场景实拍风" },
    { value: "Professional fitness equipment style, clean studio, restrained performance cues", label: "运动健身专业风" },
    { value: "Health and wellness trust style, calm colors, compliant supportive messaging", label: "健康护理克制风" },
    { value: "Beauty and personal care premium style, soft lighting, refined editorial layout", label: "美妆个护高级风" },
    { value: "Industrial technical specification style, precise diagrams, clean measurement layout", label: "工业参数说明风" },
    { value: "Outdoor rugged gear style, durable materials, practical adventure context", label: "户外硬核装备风" },
    { value: "Mother and baby soft trust style, warm gentle palette, safety-focused layout", label: "母婴柔和信任风" },
    { value: "Office productivity style, organized workspace, efficient professional atmosphere", label: "办公效率风" },
    { value: "Black and gold premium style, luxury contrast, restrained dramatic lighting", label: "黑金高端风" },
    { value: "White background parameter chart style, clear product cutouts, concise labels", label: "白底参数图风" },
    { value: "C4D 3D commercial hyper-realistic style, precision product modeling, exquisite tactile textures, softbox and rim lighting, depth of field, premium studio quality", label: "C4D 3D 商用超写实" },
    { value: "Apple Keynote minimalist presentation style, pure white to subtle light gray gradient background, ultra-clean, elegant generous spacing, crisp modern lighting", label: "Apple Keynote 极简发布会风" },
    { value: "Miniature creative diorama style, macro tilt-shift photography, playful environment scale, realistic warm daylight, rich environmental details", label: "微缩景观创意风" },
    { value: "Haute horlogerie technical deconstruction style, luxury brushed titanium and sapphire crystal, technical brochure aesthetics, crisp daylight reflections", label: "奢华精工机械透视风" },
    { value: "Vintage editorial lookbook style, high-fashion catalog shoot, warm daylight studio, dynamic layout collage, sophisticated shopping website aesthetic", label: "复古编辑杂志画册风" },
    { value: "custom", label: "自定义风格" }
];

if (typeof globalThis !== 'undefined') {
    globalThis.IMAGE_STYLE_OPTIONS = IMAGE_STYLE_OPTIONS;
}

const MARKETING_THEMES = [
    { value: "none", label: "无营销主题 (常规)" },
    { value: "Black Friday cyber punk sales vibe, neon accents, discount tags", label: "🔥 黑五 / 网一" },
    { value: "Christmas festive vibe, snow, warm lights, red and green accents", label: "🎄 圣诞节庆" },
    { value: "Valentine's Day romantic vibe, roses, pink and red tones", label: "💖 情人节限定" },
    { value: "Summer beach vibe, bright sunshine, ocean background", label: "🏖️ 夏日大促" },
    { value: "Halloween spooky vibe, pumpkins, dark atmospheric lighting", label: "🎃 万圣节主题" }
];

const LISTING_STYLE_OPTIONS = [
    { value: "Amazon风 (注重核心大词SEO布局，规格严谨，信息密度极高)", label: "Amazon风 (注重SEO)" },
    { value: "Shopify独立站风 (注重品牌故事，排版优雅，营销导向，强调生活方式)", label: "独立站风 (营销导向)" },
    { value: "TikTok短视频带货风 (短促有力，情绪煽动强，多用emoji，网感强)", label: "TikTok风 (短促有力)" }
];

const RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000];

const MODULE_PRESETS = {
    amazon_seven: {
        label: "Amazon 7图套餐",
        description: "首屏+卖点+痛点+多角度+细节+尺寸+售后",
        ids: ['m1', 'm2', 'm3', 'm4', 'm6', 'm8', 'm11']
    },
    shopify_dtc: {
        label: "独立站视觉流",
        description: "首屏+功能+痛点+生活氛围+品牌+规格+使用指引",
        ids: ['m1', 'm2', 'm3', 'm5', 'm7', 'm10', 'm12']
    },
    tiktok_viral: {
        label: "TikTok爆款流",
        description: "首屏+功能证明+痛点唤醒+对比差异+售后背书",
        ids: ['m1', 'm2', 'm3', 'm9', 'm11']
    },
    bundle_suite: {
        label: "套装大礼包流",
        description: "首屏+全家福拆解+核心功能+关键配件+协同动线+超值对比+售后背书",
        ids: ['m1', 'm13', 'm2', 'm16', 'm15', 'm14', 'm11']
    },
    tech_hardware: {
        label: "3C硬核工匠流",
        description: "首屏+核心功能+爆炸拆解+细节材质+尺寸规格+参数+售后",
        ids: ['m1', 'm2', 'm17', 'm6', 'm8', 'm10', 'm11']
    },
    social_ugc: {
        label: "社交种草爆款流",
        description: "首屏+痛点唤醒+UGC买家秀+核心功能+对比差异+售后",
        ids: ['m1', 'm3', 'm18', 'm2', 'm9', 'm11']
    }
};

if (typeof globalThis !== 'undefined') {
    globalThis.MODULE_PRESETS = MODULE_PRESETS;
}

const DTC_LAYOUT_STYLES = {
    editorial: {
        id: 'editorial',
        name: '经典杂志交错',
        nameEn: 'Editorial Alternating',
        badge: '经典交错',
        icon: 'ph-rows',
        desc: '50/50 左右交替图文，稳健平衡，全品类通用。'
    },
    minimalist: {
        id: 'minimalist',
        name: '苹果极简大图',
        nameEn: 'Tech Minimalist',
        badge: '苹果大图',
        icon: 'ph-frame-corners',
        desc: '全宽沉浸式焦点大图，画中悬浮胶囊参数，现代极简。'
    },
    bento: {
        id: 'bento',
        name: '便当盒磁贴风',
        nameEn: 'Bento Grid',
        badge: '便当磁贴',
        icon: 'ph-squares-four',
        desc: '不等宽网格错落卡片，主次分明，信息密度高且极耐看。'
    },
    lookbook: {
        id: 'lookbook',
        name: '优雅生活画册',
        nameEn: 'Lifestyle Lookbook',
        badge: '生活画册',
        icon: 'ph-book-open',
        desc: '大量艺术留白，垂直居中排版与柔和底衬，轻奢美学。'
    },
    technical: {
        id: 'technical',
        name: '硬核参数极客',
        nameEn: 'Technical Breakdown',
        badge: '参数极客',
        icon: 'ph-cpu',
        desc: '大号性能指标数字看板，痛点红黑榜并排对比，极客工业感。'
    }
};

const DTC_BRAND_COLORS = {
    indigo: {
        id: 'indigo',
        name: '经典靛蓝',
        primary: '#4f46e5',
        light: '#eef2ff',
        border: '#c7d2fe',
        text: '#4338ca',
        desc: 'DTC 行业经典基准色，专业可靠，全品类通用'
    },
    orange: {
        id: 'orange',
        name: '活力暖橙',
        primary: '#ea580c',
        light: '#fff7ed',
        border: '#ffedd5',
        text: '#c2410c',
        desc: '醒目高转化活力橙，适合运动户外、快消爆款、节日促销'
    },
    emerald: {
        id: 'emerald',
        name: '生机森绿',
        primary: '#059669',
        light: '#ecfdf5',
        border: '#a7f3d0',
        text: '#047857',
        desc: '天然健康生态绿，适合环保个护、绿植园艺、健康食品'
    },
    rose: {
        id: 'rose',
        name: '高定美妆粉',
        primary: '#e11d48',
        light: '#fff1f2',
        border: '#fecdd3',
        text: '#be123c',
        desc: '高质感柔美玫瑰色，适合美妆护肤、女性时尚、轻奢配饰'
    },
    cyan: {
        id: 'cyan',
        name: '极客数码青',
        primary: '#0891b2',
        light: '#ecfeff',
        border: '#a5f3fc',
        text: '#0e7490',
        desc: '未来感数码青霓虹，适合数码3C、智能硬件、极客外设'
    },
    slate: {
        id: 'slate',
        name: '轻奢黑曜石',
        primary: '#0f172a',
        light: '#f8fafc',
        border: '#e2e8f0',
        text: '#1e293b',
        desc: '高端纯粹哑光黑，适合轻奢服饰、高端工具、商务品质'
    },
    amber: {
        id: 'amber',
        name: '奢华琥珀金',
        primary: '#d97706',
        light: '#fffbeb',
        border: '#fde68a',
        text: '#b45309',
        desc: '典雅奢华温润金，适合轻奢珠宝、腕表皮具、典藏礼品'
    }
};

const DTC_FONT_FAMILIES = {
    'system': {
        id: 'system',
        name: '系统默认 (System Sans)',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
        googleFont: null,
        category: 'sans-serif'
    },
    'inter': {
        id: 'inter',
        name: 'Inter (现代出海标配)',
        fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, sans-serif',
        googleFont: 'Inter:wght@400;500;600;700;800',
        category: 'sans-serif'
    },
    'plus-jakarta': {
        id: 'plus-jakarta',
        name: 'Plus Jakarta Sans (新锐品牌)',
        fontFamily: '"Plus Jakarta Sans", -apple-system, BlinkMacSystemFont, sans-serif',
        googleFont: 'Plus+Jakarta+Sans:wght@400;500;600;700;800',
        category: 'sans-serif'
    },
    'poppins': {
        id: 'poppins',
        name: 'Poppins (潮流几何感)',
        fontFamily: '"Poppins", -apple-system, BlinkMacSystemFont, sans-serif',
        googleFont: 'Poppins:wght@400;500;600;700;800',
        category: 'sans-serif'
    },
    'playfair': {
        id: 'playfair',
        name: 'Playfair Display (高雅美妆衬线)',
        fontFamily: '"Playfair Display", Georgia, "Times New Roman", serif',
        googleFont: 'Playfair+Display:ital,wght@0,500;0,600;0,700;0,800;1,400',
        category: 'serif'
    },
    'montserrat': {
        id: 'montserrat',
        name: 'Montserrat (大气开阔)',
        fontFamily: '"Montserrat", -apple-system, BlinkMacSystemFont, sans-serif',
        googleFont: 'Montserrat:wght@400;500;600;700;800',
        category: 'sans-serif'
    },
    'roboto': {
        id: 'roboto',
        name: 'Roboto (严谨高密度)',
        fontFamily: '"Roboto", -apple-system, BlinkMacSystemFont, sans-serif',
        googleFont: 'Roboto:wght@400;500;700',
        category: 'sans-serif'
    },
    'space-grotesk': {
        id: 'space-grotesk',
        name: 'Space Grotesk (未来极客风)',
        fontFamily: '"Space Grotesk", monospace, sans-serif',
        googleFont: 'Space+Grotesk:wght@400;500;600;700',
        category: 'display'
    }
};

const DTC_TYPOGRAPHY_PRESETS = {
    'modern': {
        id: 'modern',
        name: '🌟 现代标准 DTC (默认)',
        desc: 'Inter 字体，视觉层次清晰平衡，适合绝大多数 DTC 出海电商品牌',
        fontFamily: 'inter',
        titleFont: 'inherit',
        titleSize: '28px',
        titleWeight: '700',
        titleSpacing: '-0.02em',
        subtitleSize: '18px',
        subtitleWeight: '600',
        bodySize: '14px',
        bodyWeight: '400',
        bodyLineHeight: '1.6'
    },
    'luxury': {
        id: 'luxury',
        name: '💎 轻奢美妆 / 珠宝',
        desc: 'Playfair Display 优雅大标题 + Plus Jakarta 正文，高贵典雅',
        fontFamily: 'plus-jakarta',
        titleFont: 'playfair',
        titleSize: '32px',
        titleWeight: '600',
        titleSpacing: '0.01em',
        subtitleSize: '18px',
        subtitleWeight: '500',
        bodySize: '14px',
        bodyWeight: '300',
        bodyLineHeight: '1.7'
    },
    'tech': {
        id: 'tech',
        name: '⚡ 硬核数码 / 极客工业',
        desc: 'Space Grotesk / Plus Jakarta 强冲击大字重，机械力量与未来感',
        fontFamily: 'plus-jakarta',
        titleFont: 'space-grotesk',
        titleSize: '32px',
        titleWeight: '800',
        titleSpacing: '-0.03em',
        subtitleSize: '18px',
        subtitleWeight: '700',
        bodySize: '14px',
        bodyWeight: '400',
        bodyLineHeight: '1.5'
    },
    'pop': {
        id: 'pop',
        name: '🛍️ 高转化快消 / 爆款促销',
        desc: 'Poppins 饱满几何大圆角字体，亲和力强，点击欲望强烈',
        fontFamily: 'poppins',
        titleFont: 'inherit',
        titleSize: '30px',
        titleWeight: '700',
        titleSpacing: '-0.01em',
        subtitleSize: '18px',
        subtitleWeight: '600',
        bodySize: '14px',
        bodyWeight: '500',
        bodyLineHeight: '1.55'
    },
    'minimalist': {
        id: 'minimalist',
        name: '🍃 极简生活 / 无印自然',
        desc: '系统精简字体，呼吸感留白，轻字重、大行距、返璞归真',
        fontFamily: 'system',
        titleFont: 'inherit',
        titleSize: '26px',
        titleWeight: '500',
        titleSpacing: '0.02em',
        subtitleSize: '16px',
        subtitleWeight: '500',
        bodySize: '14px',
        bodyWeight: '300',
        bodyLineHeight: '1.8'
    }
};

const DTC_DEFAULT_TYPOGRAPHY = {
    templateId: 'modern',
    fontFamily: 'inter',
    titleFont: 'inherit',
    titleSize: '28px',
    titleWeight: '700',
    titleSpacing: '-0.02em',
    subtitleSize: '18px',
    subtitleWeight: '600',
    bodySize: '14px',
    bodyWeight: '400',
    bodyLineHeight: '1.6'
};

if (typeof window !== 'undefined') {
    window.DTC_LAYOUT_STYLES = DTC_LAYOUT_STYLES;
    window.DTC_BRAND_COLORS = DTC_BRAND_COLORS;
    window.DTC_FONT_FAMILIES = DTC_FONT_FAMILIES;
    window.DTC_TYPOGRAPHY_PRESETS = DTC_TYPOGRAPHY_PRESETS;
    window.DTC_DEFAULT_TYPOGRAPHY = DTC_DEFAULT_TYPOGRAPHY;
}
if (typeof globalThis !== 'undefined') {
    globalThis.DTC_LAYOUT_STYLES = DTC_LAYOUT_STYLES;
    globalThis.DTC_BRAND_COLORS = DTC_BRAND_COLORS;
    globalThis.DTC_FONT_FAMILIES = DTC_FONT_FAMILIES;
    globalThis.DTC_TYPOGRAPHY_PRESETS = DTC_TYPOGRAPHY_PRESETS;
    globalThis.DTC_DEFAULT_TYPOGRAPHY = DTC_DEFAULT_TYPOGRAPHY;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        MODULES_CONFIG,
        PLATFORM_OPTIONS,
        REGION_OPTIONS,
        MARKET_TONE_MAP,
        ASPECT_RATIO_OPTIONS,
        IMAGE_STYLE_OPTIONS,
        MARKETING_THEMES,
        LISTING_STYLE_OPTIONS,
        RETRY_DELAYS,
        MODULE_PRESETS,
        DTC_LAYOUT_STYLES,
        DTC_BRAND_COLORS,
        DTC_FONT_FAMILIES,
        DTC_TYPOGRAPHY_PRESETS,
        DTC_DEFAULT_TYPOGRAPHY
    };
}
