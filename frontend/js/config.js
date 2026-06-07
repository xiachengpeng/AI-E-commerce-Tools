// ==========================================
// 【静态配置文件】
// ==========================================

const MODULES_CONFIG = [
    { id: 'm1', title: '首屏认知', promptTitle: 'Hero Product Understanding', subtitle: '让用户秒懂产品', active: true, count: 1, prompt: "Create a clear hero section that immediately explains what the product is, who it is for, and the primary benefit. Use one short headline, one short support line, and up to three proof-oriented callouts." },
    { id: 'm2', title: '核心功能证明', promptTitle: 'Core Benefit Proof', subtitle: '给出购买理由', active: true, count: 1, prompt: "Create a focused benefit infographic. Each version must cover a different buying reason, with no repeated headline angle across variants." },
    { id: 'm3', title: '场景/痛点唤醒', promptTitle: 'Usage Scenario and Pain Point', subtitle: '展示真实使用需求', active: true, count: 1, prompt: "Create a believable lifestyle usage scene with realistic product scale, natural lighting, and a single user context. Avoid exaggerated fitness transformations." },
    { id: 'm4', title: '外观/多角度证明', promptTitle: 'Appearance and Multi-Angle Proof', subtitle: '降低看不清疑虑', active: false, count: 1, prompt: "Create a layout showing a collage of different angle views of the product on a clean studio background." },
    { id: 'm5', title: '生活方式氛围', promptTitle: 'Lifestyle Atmosphere', subtitle: '强化使用代入感', active: false, count: 1, prompt: "Create an atmospheric lifestyle shot with warm lighting, setting a mood that perfectly fits the product's aesthetic." },
    { id: 'm6', title: '细节/材质证明', promptTitle: 'Detail and Material Proof', subtitle: '放大关键做工', active: false, count: 1, prompt: "Create a macro close-up shot highlighting the premium material, texture, and exquisite craftsmanship of the product." },
    { id: 'm7', title: '品牌/定位表达', promptTitle: 'Brand Positioning Expression', subtitle: '建立产品调性', active: false, count: 1, prompt: "Create an editorial layout with a brand story aesthetic, combining the product with lifestyle elements and elegant text space." },
    { id: 'm8', title: '尺寸/收纳证明', promptTitle: 'Size and Storage Proof', subtitle: '消除空间疑虑', active: false, count: 1, prompt: "Create a technical drawing or infographic style image showing exact dimensions, size proportions, or capacity with measurement lines." },
    { id: 'm9', title: '对比差异证明', promptTitle: 'Objective Comparison Proof', subtitle: '说明为什么选它', active: true, count: 1, prompt: "Create an objective comparison table between a single-function alternative and this product. Use factual feature rows, not exaggerated superiority claims." },
    { id: 'm10', title: '参数规格确认', promptTitle: 'Specification Confirmation', subtitle: '用事实消除顾虑', active: true, count: 1, prompt: "Create a clean specification section. Only show parameters that are present in the supplied product information or clearly visible in the reference image." },
    { id: 'm11', title: '信任/售后背书', promptTitle: 'Trust and After-Sales Support', subtitle: '降低下单风险', active: true, count: 1, prompt: "Create a trust-building after-sales section using warranty, support, shipping, returns, maintenance, or package-list cues only when provided. Do not invent certifications." },
    { id: 'm12', title: '使用/维护指引', promptTitle: 'Usage and Maintenance Guide', subtitle: '降低使用门槛', active: false, count: 1, prompt: "Create an instructional step-by-step guide or usage tips layout showing how to properly use or maintain the product with clear visual cues." }
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
    { value: "European Market",     label: "欧洲 (Europe)" },
    { value: "UK Market",           label: "英国 (UK)" },
    { value: "Japan Market",        label: "日本 (Japan)" },
    { value: "Southeast Asia Market", label: "东南亚 (SEA)" },
    { value: "Middle East Market",  label: "中东 (Middle East)" },
    { value: "Australian Market",   label: "澳大利亚 (Australia)" },
    { value: "Global Market",       label: "全球 (Global)" }
];

const MARKET_TONE_MAP = {
    "US Market": "Direct, benefit-led, confident, conversion-focused, but factual and compliant.",
    "European Market": "Refined, design-conscious, quality-focused, sustainability-aware, clear and restrained.",
    "UK Market": "Polite, practical, value-aware, lightly witty, professional and approachable.",
    "Japan Market": "Precise, detail-oriented, trust-building, polite, calm, and reassurance-focused.",
    "Southeast Asia Market": "Bright, energetic, promotion-aware, urgency-driven, but still factual.",
    "Middle East Market": "Premium, dignified, elegant, comfort-focused, and respectful of lifestyle context.",
    "Australian Market": "Relaxed, practical, lifestyle-led, friendly, and straightforward.",
    "Global Market": "Neutral, professional, broadly understandable, clear, and practical."
};

const LANGUAGE_OPTIONS = [
    { value: "English",    label: "英文 (English)" },
    { value: "Chinese",    label: "中文 (Chinese)" },
    { value: "Japanese",   label: "日文 (Japanese)" },
    { value: "Spanish",    label: "西语 (Spanish)" },
    { value: "German",     label: "德语 (German)" },
    { value: "French",     label: "法语 (French)" },
    { value: "Italian",    label: "意语 (Italian)" },
    { value: "Portuguese", label: "葡语 (Portuguese)" },
    { value: "Russian",    label: "俄语 (Russian)" },
    { value: "Arabic",     label: "阿拉伯语 (Arabic)" },
    { value: "Korean",     label: "韩语 (Korean)" }
];

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
