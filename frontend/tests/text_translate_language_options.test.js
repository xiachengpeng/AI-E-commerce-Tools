const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');
const listStart = html.indexOf('id="langOptionsList"');
const listEnd = html.indexOf('</div>\n                            </div>', listStart);
const languageList = html.slice(listStart, listEnd);

assert.ok(listStart >= 0, 'text translation language list must exist');
assert.strictEqual(
    (languageList.match(/value="Chinese"/g) || []).length,
    1,
    'text translation language list must contain one Chinese target'
);
assert.match(languageList, /value="Chinese"[\s\S]*?中文 \(ZH\)/);
assert.strictEqual(
    (languageList.match(/value="Thai"/g) || []).length,
    1,
    'text translation language list must contain one Thai target'
);
assert.match(languageList, /value="Thai"[\s\S]*?ไทย \(TH\)/);
