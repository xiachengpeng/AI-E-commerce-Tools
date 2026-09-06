const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');
const languages = fs.readFileSync(path.resolve(__dirname, '..', 'js', 'languages.js'), 'utf8');

assert.match(html, /id="textTranslationLanguageOptions"/);
assert.strictEqual(
    (languages.match(/value: 'Chinese'/g) || []).length,
    1,
    'text translation language list must contain one Chinese target'
);
assert.match(languages, /value: 'Chinese'[\s\S]*?textLabel: '中文 \(ZH\)'/);
assert.strictEqual(
    (languages.match(/value: 'Thai'/g) || []).length,
    1,
    'text translation language list must contain one Thai target'
);
assert.match(languages, /value: 'Thai'[\s\S]*?textLabel: 'ไทย \(TH\)'/);
