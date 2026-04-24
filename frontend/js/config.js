// ==========================================
// 【静态配置文件】
// ==========================================

const MODULES_CONFIG = [
    { id: 'm1', title: '首屏主视觉', subtitle: '传递核心价值', active: true, count: 1, prompt: "Create a high-impact hero banner with cinematic lighting, showcasing the product in the center with a premium background." },
    { id: 'm2', title: '核心卖点图', subtitle: '突出卖点优势', active: true, count: 3, prompt: "Create an infographic style layout highlighting key selling points with modern typography and icons next to the product." },
    { id: 'm3', title: '使用场景图', subtitle: '呈现真实使用场景', active: false, count: 1, prompt: "Create lifestyle photography showing the product being used in a real-world scenario or natural environment." },
    { id: 'm4', title: '多角度图', subtitle: '多角度呈现外观', active: false, count: 1, prompt: "Create a layout showing a collage of different angle views of the product on a clean studio background." },
    { id: 'm5', title: '场景氛围图', subtitle: '展示使用场景', active: false, count: 1, prompt: "Create an atmospheric lifestyle shot with warm lighting, setting a mood that perfectly fits the product's aesthetic." },
    { id: 'm6', title: '商品细节图', subtitle: '放大材质与工艺', active: false, count: 1, prompt: "Create a macro close-up shot highlighting the premium material, texture, and exquisite craftsmanship of the product." },
    { id: 'm7', title: '品牌故事图', subtitle: '传达品牌理念', active: false, count: 1, prompt: "Create an editorial layout with a brand story aesthetic, combining the product with lifestyle elements and elegant text space." },
    { id: 'm8', title: '尺寸/容量/尺码图', subtitle: '展示规格信息', active: false, count: 1, prompt: "Create a technical drawing or infographic style image showing exact dimensions, size proportions, or capacity with measurement lines." },
    { id: 'm9', title: '效果对比图', subtitle: '对比展示优势', active: false, count: 1, prompt: "Create a split-screen comparison layout highlighting the clear advantages of the product." },
    { id: 'm10', title: '详细规格表', subtitle: '展示详细参数', active: false, count: 1, prompt: "Create a clean, modern specification data visualization or structured layout with tech-inspired graphics." },
    { id: 'm11', title: '售后保障图', subtitle: '增强购买信心', active: false, count: 1, prompt: "Create a trust-building infographic highlighting after-sales service, warranty, and customer support with secure icons and reassuring layout." },
    { id: 'm12', title: '使用建议图', subtitle: '指导正确使用', active: false, count: 1, prompt: "Create an instructional step-by-step guide or usage tips layout showing how to properly use or maintain the product with clear visual cues." }
];

const PLATFORM_OPTIONS = [
    { value: "Independent Website (Shopify-like, highly aesthetic, minimalist, lifestyle-focused)", label: "独立站" },
    { value: "Amazon (clean white background, highly informative, feature-focused)",               label: "亚马逊" },
    { value: "Taobao (vibrant, promotional, colorful, high-density text)",                         label: "淘宝" }
];

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
    "US Market": "极具煽动性，直接展示核心利益点，略带激进的促销感，自信且引人注目。",
    "European Market": "严谨优雅，强调环保、可持续性、高品质和设计感，措辞清晰高级。",
    "UK Market": "礼貌克制，略带巧妙的幽默感，注重性价比与实用性，专业而亲和。",
    "Japan Market": "极端严谨，注重细节和参数说明，措辞极其礼貌，强调信任感和安心感。",
    "Southeast Asia Market": "色彩鲜艳，情绪高昂，善用FOMO(错失恐惧)心理，促销感极强。",
    "Middle East Market": "奢华尊贵，尊重传统，强调产品带来的地位感和高端体验。",
    "Australian Market": "轻松随性，注重生活方式的融入，实用导向，亲切友好。",
    "Global Market": "中立、专业、普适性强、清晰明了。"
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
    { value: "Natural, organic, warm, cozy, lifestyle photography", label: "自然原木" }
];

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
