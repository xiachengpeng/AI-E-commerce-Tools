const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

function createTestContext() {
    const elements = {};
    const doc = {
        getElementById: (id) => {
            if (!elements[id]) {
                elements[id] = {
                    id,
                    value: '',
                    textContent: '',
                    innerHTML: '',
                    className: '',
                    style: {},
                    dataset: {},
                    classList: {
                        _classes: new Set(),
                        add(c) { this._classes.add(c); },
                        remove(c) { this._classes.delete(c); },
                        toggle(c, force) {
                            if (force !== undefined) {
                                if (force) this._classes.add(c);
                                else this._classes.delete(c);
                            } else {
                                if (this._classes.has(c)) this._classes.delete(c);
                                else this._classes.add(c);
                            }
                        },
                        contains(c) { return this._classes.has(c); }
                    },
                    querySelector: () => null,
                    querySelectorAll: () => [],
                    setAttribute: (k, v) => { elements[id][k] = v; },
                    getAttribute: (k) => elements[id][k] || null,
                    appendChild: () => {},
                    removeChild: () => {},
                    scrollIntoView: () => {}
                };
            }
            return elements[id];
        },
        querySelector: (sel) => null,
        querySelectorAll: () => [],
        createElement: (tag) => ({
            tagName: tag.toUpperCase(),
            value: '',
            textContent: '',
            innerHTML: '',
            className: '',
            style: {},
            dataset: {},
            classList: {
                _classes: new Set(),
                add(c) { this._classes.add(c); },
                remove(c) { this._classes.delete(c); },
                toggle(c) {},
                contains(c) { return this._classes.has(c); }
            },
            appendChild: () => {},
            removeChild: () => {}
        }),
        body: {
            appendChild: () => {},
            removeChild: () => {}
        }
    };

    const ctx = {
        console,
        document: doc,
        setTimeout,
        clearTimeout,
        AbortController,
        DOMException: typeof DOMException !== 'undefined' ? DOMException : undefined,
        showToast: () => {},
        remoteLog: () => {},
        localStorage: {
            _store: {},
            getItem(k) { return this._store[k] || null; },
            setItem(k, v) { this._store[k] = String(v); },
            removeItem(k) { delete this._store[k]; }
        },
        API_BASE: 'http://127.0.0.1:9503/api',
        fetch: async () => ({ ok: true, json: async () => ({}) })
    };

    ctx.window = ctx;
    ctx.globalThis = ctx;

    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(root, 'js', 'config.js'), 'utf8'), ctx);
    vm.runInContext(fs.readFileSync(path.join(root, 'js', 'utils.js'), 'utf8'), ctx);
    ctx.showToast = () => {};
    vm.runInContext(fs.readFileSync(path.join(root, 'js', 'details.js'), 'utf8'), ctx);
    ctx.showToast = () => {};

    return { ctx, elements };
}

// 1. WCAG AA 对比度算法测试
test('WCAG AA contrast calculation ensures readable text colors (>= 4.5:1 ratio)', () => {
    const { ctx } = createTestContext();
    assert.strictEqual(typeof ctx.calculateContrastRatio, 'function', 'calculateContrastRatio must be defined');
    assert.strictEqual(typeof ctx.getAccessibleContrastColor, 'function', 'getAccessibleContrastColor must be defined');

    // Pure black on pure white is 21:1
    const blackOnWhite = ctx.calculateContrastRatio('#000000', '#FFFFFF');
    assert.ok(blackOnWhite >= 20.9 && blackOnWhite <= 21.1, `Expected ~21:1, got ${blackOnWhite}`);

    // Same color has ratio 1:1
    const sameColor = ctx.calculateContrastRatio('#4f46e5', '#4f46e5');
    assert.strictEqual(Math.round(sameColor), 1);

    // If preferred color on light tint has insufficient contrast (< 4.5:1), getAccessibleContrastColor returns darkened or high-contrast alternative
    const lightTint = '#f4f4ff';
    const lowContrastLightIndigo = '#a5b4fc'; // light pastel indigo on almost white
    const accessibleColor = ctx.getAccessibleContrastColor(lightTint, lowContrastLightIndigo, 4.5);
    const newRatio = ctx.calculateContrastRatio(lightTint, accessibleColor);
    assert.ok(newRatio >= 4.5, `Accessible color ${accessibleColor} on ${lightTint} should have ratio >= 4.5, got ${newRatio}`);
});

// 2. Section Tree: 激活模块选中与追踪
test('setActiveInspectorTask and getActiveInspectorTask manage active section selection', () => {
    const { ctx } = createTestContext();
    assert.strictEqual(typeof ctx.setActiveInspectorTask, 'function');
    assert.strictEqual(typeof ctx.getActiveInspectorTask, 'function');

    const mockTasks = [
        { uniqueId: 'task_m1_100', id: 'm1', title: 'Hero' },
        { uniqueId: 'task_m2_101', id: 'm2', title: 'Benefit' }
    ];
    ctx.setGlobalGenContext({ tasks: mockTasks });

    ctx.setActiveInspectorTask('task_m2_101');
    assert.strictEqual(ctx.getActiveInspectorTask()?.uniqueId, 'task_m2_101');

    // Deselect
    ctx.setActiveInspectorTask(null);
    assert.strictEqual(ctx.getActiveInspectorTask(), null);
});

// 3. Section Tree: 上下移动与排序 (moveDetailTask)
test('moveDetailTask reorders sections up and down in global tasks list', () => {
    const { ctx } = createTestContext();
    assert.strictEqual(typeof ctx.moveDetailTask, 'function');

    const t1 = { uniqueId: 't1', id: 'm1', title: 'Hero' };
    const t2 = { uniqueId: 't2', id: 'm2', title: 'Benefit' };
    const t3 = { uniqueId: 't3', id: 'm3', title: 'Scene' };
    ctx.setGlobalGenContext({ tasks: [t1, t2, t3] });

    // Move t2 up -> [t2, t1, t3]
    const resUp = ctx.moveDetailTask('t2', 'up');
    assert.strictEqual(resUp, true);
    const order1 = ctx.getGlobalGenContext().tasks.map(t => t.uniqueId);
    assert.deepStrictEqual(order1, ['t2', 't1', 't3']);

    // Move t2 up again (already at top) -> should return false
    assert.strictEqual(ctx.moveDetailTask('t2', 'up'), false);

    // Move t1 down -> [t2, t3, t1]
    const resDown = ctx.moveDetailTask('t1', 'down');
    assert.strictEqual(resDown, true);
    const order2 = ctx.getGlobalGenContext().tasks.map(t => t.uniqueId);
    assert.deepStrictEqual(order2, ['t2', 't3', 't1']);
});

// 4. Section Tree: 显示/隐藏开关 (toggleDetailTaskVisibility)
test('toggleDetailTaskVisibility toggles section hidden property', () => {
    const { ctx } = createTestContext();
    assert.strictEqual(typeof ctx.toggleDetailTaskVisibility, 'function');

    const task = { uniqueId: 't1', id: 'm1', isHidden: false };
    ctx.setGlobalGenContext({ tasks: [task] });

    ctx.toggleDetailTaskVisibility('t1');
    assert.strictEqual(task.isHidden, true);

    ctx.toggleDetailTaskVisibility('t1');
    assert.strictEqual(task.isHidden, false);
});

// 5. Property Inspector: 内容文案热更新 (updateDetailTaskContent)
test('updateDetailTaskContent updates section copy and triggers live preview update', () => {
    const { ctx } = createTestContext();
    assert.strictEqual(typeof ctx.updateDetailTaskContent, 'function');

    const task = {
        uniqueId: 't1',
        id: 'm1',
        title: 'Hero',
        dtcCopy: {
            headline: 'Old Headline',
            subheadline: 'Old Sub'
        }
    };
    ctx.setGlobalGenContext({ tasks: [task] });

    ctx.updateDetailTaskContent('t1', {
        headline: 'Next-Gen Standing Desk',
        subheadline: 'Work healthier, live better'
    });

    assert.strictEqual(task.dtcCopy.headline, 'Next-Gen Standing Desk');
    assert.strictEqual(task.dtcCopy.subheadline, 'Work healthier, live better');
});

// 6. Property Inspector: SEO 元数据热更新 (updateDetailTaskSeo)
test('updateDetailTaskSeo modifies SEO attributes of selected task', () => {
    const { ctx } = createTestContext();
    assert.strictEqual(typeof ctx.updateDetailTaskSeo, 'function');

    const task = {
        uniqueId: 't1',
        id: 'm1',
        seo: { titleTarget: 'Old SEO', altTarget: 'Old Alt' }
    };
    ctx.setGlobalGenContext({ tasks: [task] });

    ctx.updateDetailTaskSeo('t1', {
        titleTarget: 'Ergonomic Desk Pro 2026',
        altTarget: 'Electric standing desk in modern workspace'
    });

    assert.strictEqual(task.seo.titleTarget, 'Ergonomic Desk Pro 2026');
    assert.strictEqual(task.seo.altTarget, 'Electric standing desk in modern workspace');
});

// 7. 多版本素材历史记录与回滚 (recordTaskImageVersion & rollbackTaskImageVersion)
test('recordTaskImageVersion archives image history and rollback restores it', () => {
    const { ctx } = createTestContext();
    assert.strictEqual(typeof ctx.recordTaskImageVersion, 'function');
    assert.strictEqual(typeof ctx.rollbackTaskImageVersion, 'function');

    const task = {
        uniqueId: 't1',
        id: 'm1',
        imageUrl: 'data:image/png;base64,image_v1',
        imageVersions: []
    };
    ctx.setGlobalGenContext({ tasks: [task] });

    // New generation occurred: record version 1, set new image
    ctx.recordTaskImageVersion(task, 'data:image/png;base64,image_v2', '换浅色背景');
    assert.strictEqual(task.imageUrl, 'data:image/png;base64,image_v2');
    assert.strictEqual(task.imageVersions.length, 1);
    assert.strictEqual(task.imageVersions[0].imageUrl, 'data:image/png;base64,image_v1');
    assert.strictEqual(task.imageVersions[0].promptAdjustment, '换浅色背景');

    // Rollback to version 1
    const v1Id = task.imageVersions[0].versionId;
    const rolledBack = ctx.rollbackTaskImageVersion('t1', v1Id);
    assert.strictEqual(rolledBack, true);
    assert.strictEqual(task.imageUrl, 'data:image/png;base64,image_v1');
});

// 8. Dictionary tasks reordering with longImageOrder (moveDetailTask & getDetailTasksList)
test('moveDetailTask and getDetailTasksList handle object tasks and longImageOrder', () => {
    const { ctx } = createTestContext();
    const t1 = { uniqueId: 'uid_1', id: 'm1', title: 'Hero' };
    const t2 = { uniqueId: 'uid_2', id: 'm2', title: 'Benefit' };
    const t3 = { uniqueId: 'uid_3', id: 'm3', title: 'Scene' };

    ctx.setGlobalGenContext({
        tasks: {
            'uid_1': t1,
            'uid_2': t2,
            'uid_3': t3
        },
        longImageOrder: ['uid_1', 'uid_2', 'uid_3']
    });

    // Move uid_2 up -> ['uid_2', 'uid_1', 'uid_3']
    const res = ctx.moveDetailTask('uid_2', 'up');
    assert.strictEqual(res, true);
    assert.deepStrictEqual(Array.from(ctx.getGlobalGenContext().longImageOrder), ['uid_2', 'uid_1', 'uid_3']);

    const orderedTasks = ctx.getDetailTasksList();
    assert.strictEqual(orderedTasks[0].uniqueId, 'uid_2');
    assert.strictEqual(orderedTasks[1].uniqueId, 'uid_1');
    assert.strictEqual(orderedTasks[2].uniqueId, 'uid_3');
});

// 9. 三栏侧栏显隐切换 (toggleSectionTree & toggleSectionInspector)
test('toggleSectionTree and toggleSectionInspector toggle hidden classes on DOM sidebars', () => {
    const { ctx } = createTestContext();
    const treeSidebar = ctx.document.getElementById('sectionTreeSidebar');
    const treeBtn = ctx.document.getElementById('btnToggleSectionTree');
    const inspSidebar = ctx.document.getElementById('sectionInspectorSidebar');
    const inspBtn = ctx.document.getElementById('btnToggleInspector');

    // Initial toggle -> hides treeSidebar
    ctx.toggleSectionTree();
    assert.strictEqual(treeSidebar.classList.contains('hidden'), true);
    // Toggle again -> reveals treeSidebar
    ctx.toggleSectionTree();
    assert.strictEqual(treeSidebar.classList.contains('hidden'), false);

    // Inspector toggle
    ctx.toggleSectionInspector();
    assert.strictEqual(inspSidebar.classList.contains('hidden'), true);
    ctx.toggleSectionInspector();
    assert.strictEqual(inspSidebar.classList.contains('hidden'), false);
});

// 10. 页面结构树 DOM 渲染 (renderSectionTree)
test('renderSectionTree renders section items with active selection and status icons', () => {
    const { ctx } = createTestContext();
    const container = ctx.document.getElementById('sectionTreeContainer');

    const t1 = { uniqueId: 'sec_1', id: 'm1', title: 'Hero Section', subStatus: { overall: 'success' } };
    const t2 = { uniqueId: 'sec_2', id: 'm2', title: 'Core Benefit', subStatus: { overall: 'failed' }, isHidden: true };

    ctx.setGlobalGenContext({ tasks: [t1, t2] });
    ctx.setActiveInspectorTask('sec_1');

    ctx.renderSectionTree();
    const html = container.innerHTML;

    assert.ok(html.includes('Hero Section'));
    assert.ok(html.includes('Core Benefit'));
    assert.ok(html.includes('line-through')); // Hidden item has line-through
    assert.ok(html.includes('sec_1'));
});
