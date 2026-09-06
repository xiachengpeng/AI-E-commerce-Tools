// Shared language catalog used by detail pages, listings, ads, and translation tools.
const ALL_LANGUAGE_OPTIONS = [
    { value: 'English', label: '英文 (English)', textLabel: 'English (US)', short: 'EN' },
    { value: 'Chinese', label: '中文 (Chinese)', textLabel: '中文 (ZH)', short: 'ZH' },
    { value: 'Japanese', label: '日文 (Japanese)', textLabel: '日本語 (JP)', short: 'JA' },
    { value: 'Spanish', label: '西语 (Spanish)', textLabel: 'Español (ES)', short: 'ES' },
    { value: 'German', label: '德语 (German)', textLabel: 'Deutsch (DE)', short: 'DE' },
    { value: 'French', label: '法语 (French)', textLabel: 'Français (FR)', short: 'FR' },
    { value: 'Italian', label: '意语 (Italian)', textLabel: 'Italiano (IT)', short: 'IT' },
    { value: 'Portuguese', label: '葡语 (Portuguese)', textLabel: 'Português (PT)', short: 'PT' },
    { value: 'Russian', label: '俄语 (Russian)', textLabel: 'Русский (RU)', short: 'RU' },
    { value: 'Arabic', label: '阿拉伯语 (Arabic)', textLabel: 'العربية (AR)', short: 'AR' },
    { value: 'Korean', label: '韩语 (Korean)', textLabel: '한국어 (KO)', short: 'KO' },
    { value: 'Thai', label: '泰语 (Thai)', textLabel: 'ไทย (TH)', short: 'TH' }
];

const LANGUAGE_OPTIONS = ALL_LANGUAGE_OPTIONS.map(({ value, label }) => ({ value, label }));
const IMAGE_TRANSLATION_LANGUAGE_VALUES = new Set([
    'English', 'Japanese', 'Spanish', 'German', 'French', 'Korean',
    'Arabic', 'Portuguese', 'Russian', 'Italian', 'Thai'
]);
const TRANS_LANG_OPTIONS = ALL_LANGUAGE_OPTIONS
    .filter(option => IMAGE_TRANSLATION_LANGUAGE_VALUES.has(option.value))
    .map(({ value, label, short }) => ({
        value,
        label: label.replace(/ \(.+\)$/, ''),
        short
    }));

if (typeof globalThis !== 'undefined') {
    globalThis.ALL_LANGUAGE_OPTIONS = ALL_LANGUAGE_OPTIONS;
    globalThis.LANGUAGE_OPTIONS = LANGUAGE_OPTIONS;
    globalThis.TRANS_LANG_OPTIONS = TRANS_LANG_OPTIONS;
}
