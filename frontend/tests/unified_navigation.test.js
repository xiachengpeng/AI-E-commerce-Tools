const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function application() {
    class Node {
        constructor(tag = 'div', id = '') {
            this.tagName = tag.toUpperCase(); this.id = id; this.children = []; this.className = ''; this.style = {}; this.attributes = {};
            this.classList = {
                contains: name => this.className.split(/\s+/).includes(name),
                add: name => { if (!this.classList.contains(name)) this.className += ' ' + name; },
                remove: name => { this.className = this.className.split(/\s+/).filter(x => x !== name).join(' '); },
                toggle: (name, enabled) => enabled ? this.classList.add(name) : this.classList.remove(name)
            };
        }
        append(...nodes) { for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); } }
        remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(x => x !== this); this.parentElement = null; }
        before(node) { const parent = this.parentElement; node.remove(); parent.children.splice(parent.children.indexOf(this), 0, node); node.parentElement = parent; }
        setAttribute(name, value) { this.attributes[name] = value; }
        querySelector() { return null; }
    }
    const body = new Node(), sidebar = new Node('aside', 'appSidebar'), legacy = new Node('nav'); legacy.className = 'sidebar-nav-groups'; body.append(sidebar); sidebar.append(legacy);
    const tabs = ['research', 'analysis', 'generate', 'listing', 'ads', 'image-canvas', 'square-redraw', 'watermark-removal', 'translate', 'text-translate', 'settings'];
    const nodes = new Map([['appSidebar', sidebar]]);
    for (const id of [...tabs.map(x => 'tab-' + x), 'btnOpenBrandHub', 'btnOpenHistory', 'btnResetAllState']) { const node = new Node('button', id); node.className = 'side-tab'; node.originalHandler = () => id; nodes.set(id, node); legacy.append(node); }
    for (const tab of tabs) { const view = new Node('div', 'view-' + tab); nodes.set(view.id, view); body.append(view); }
    const descendants = node => [node, ...node.children.flatMap(descendants)];
    const document = { body, createElement: tag => new Node(tag), createComment: () => new Node('#comment'), getElementById: id => nodes.get(id) || null, querySelectorAll: selector => descendants(body).filter(node => selector === '.side-tab' ? node.classList.contains('side-tab') : selector === 'div[id^="view-"]' ? node.id.startsWith('view-') : false) };
    const storage = new Map(), frames = [], context = { document, MODULES_CONFIG: [], window: {}, localStorage: { setItem(k,v) { storage.set(k,v); }, getItem(k) { return storage.get(k) ?? null; } }, console };
    vm.createContext(context); vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8'), context);
    context.updateResearchSettingsFrame = enabled => frames.push(enabled);
    return { context, body, sidebar, nodes, frames, descendants, storage, Node };
}

test('research and other modules retain one shared sidebar, original controls and expansion state', () => {
    const app = application(); app.context.switchMainTab('research');
    const menu = app.sidebar.children.find(node => node.className === 'rw-global-navigation');
    assert.ok(menu); const content = menu.children.find(node => node.tagName === 'DETAILS'); content.open = true;
    const handlers = new Map([...app.nodes].filter(([id]) => id.startsWith('tab-')).map(([id, node]) => [id, node.originalHandler]));
    for (const tab of ['analysis', 'settings', 'listing', 'ads', 'translate', 'research', 'analysis']) {
        app.context.switchMainTab(tab);
        assert.equal(app.sidebar.children.find(node => node.className === 'rw-global-navigation'), menu, tab + ' must retain the same navigation');
        assert.equal(app.body.classList.contains('unified-navigation-mode'), true);
        assert.equal(content.open, true);
        for (const [id, handler] of handlers) assert.equal(app.nodes.get(id).originalHandler, handler);
        assert.equal(app.nodes.get('tab-' + tab).classList.contains('active'), true);
        assert.equal(app.nodes.get('view-' + tab).style.display, 'flex');
        assert.equal(app.descendants(menu).filter(node => node.id === 'tab-analysis').length, 1);
    }
    assert.equal(app.body.classList.contains('research-design-mode'), false, 'research content styling must remain scoped');
});

test('collapsed shared navigation preserves controls, group state and user preference', () => {
    const app=application(), toggle=new app.Node('button','btnToggleSidebar');app.nodes.set(toggle.id,toggle);app.sidebar.append(toggle);
    app.context.switchMainTab('listing');
    const menu=app.sidebar.children.find(node=>node.className==='rw-global-navigation');
    const group=app.nodes.get('tab-listing').parentElement;
    app.context.toggleSidebarExpansion();
    assert.equal(app.sidebar.classList.contains('rw-sidebar-collapsed'),true);
    assert.equal(toggle.attributes['aria-expanded'],'false');
    assert.equal(app.storage.get('ai_tool_unified_sidebar_collapsed'),'true');
    app.context.switchMainTab('ads');
    assert.equal(app.nodes.get('tab-ads').parentElement,group);assert.equal(group.open,true);
    assert.equal(app.sidebar.children.find(node=>node.className==='rw-global-navigation'),menu);
    app.context.toggleSidebarExpansion();
    assert.equal(app.sidebar.classList.contains('rw-sidebar-collapsed'),false);
    assert.equal(toggle.attributes['aria-expanded'],'true');
});

test('direct entry to a grouped module mounts unified navigation and reveals its active entry', () => {
    const app = application(); app.context.switchMainTab('listing');
    const menu = app.sidebar.children.find(node => node.className === 'rw-global-navigation'); assert.ok(menu);
    assert.equal(app.nodes.get('tab-listing').parentElement.open, true);
    assert.equal(app.body.classList.contains('research-design-mode'), false);
});

test('saved legacy canvas route opens the current image canvas', () => {
    const app = application();
    app.context.switchMainTab('legacy-image-canvas');
    assert.equal(app.nodes.get('tab-image-canvas').classList.contains('active'), true);
    assert.equal(app.nodes.get('view-image-canvas').style.display, 'flex');
    assert.equal(app.storage.get('activeMainTab'), 'image-canvas');
});

test('collapsed preference is restored without legacy sidebar state overriding it', () => {
    const app = application(), toggle = new app.Node('button', 'btnToggleSidebar');
    app.nodes.set(toggle.id, toggle); app.sidebar.append(toggle);
    app.storage.set('ai_tool_unified_sidebar_collapsed', 'true');
    app.storage.set('ai_tool_sidebar_expanded', 'true');
    app.context.switchMainTab('listing'); app.context.initSidebarState();
    assert.equal(app.sidebar.classList.contains('rw-sidebar-collapsed'), true);
    assert.equal(toggle.attributes['aria-label'], '展开侧边栏');
    const group = app.nodes.get('tab-listing').parentElement;
    assert.equal(group.children[0].attributes.title, '内容制作');
    assert.equal(group.open, true);
});
