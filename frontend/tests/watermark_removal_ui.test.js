const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const frontendRoot = path.resolve(__dirname, "..");
const indexHtml = fs.readFileSync(path.join(frontendRoot, "index.html"), "utf8");
const appScript = fs.readFileSync(path.join(frontendRoot, "js", "app.js"), "utf8");
const scriptPath = path.join(frontendRoot, "js", "watermark_removal.js");
const stylePath = path.join(frontendRoot, "css", "watermark_removal.css");
const script = fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, "utf8") : "";
const style = fs.existsSync(stylePath) ? fs.readFileSync(stylePath, "utf8") : "";
const core = require("../js/watermark_removal_core.js");

class FakeClassList {
    constructor() {
        this.values = new Set();
    }

    toggle(name, force) {
        if (force) this.values.add(name);
        else this.values.delete(name);
    }
}

function fakeContext2d() {
    return {
        arc() {},
        beginPath() {},
        clearRect() {},
        drawImage() {},
        fill() {},
        fillRect() {},
        restore() {},
        save() {},
        setLineDash() {},
        stroke() {},
        strokeRect() {}
    };
}

function fakeElement(id, harnessState) {
    const listeners = {};
    const pointerCapture = new Set();
    return {
        id,
        classList: new FakeClassList(),
        disabled: false,
        files: [],
        hidden: false,
        src: "",
        textContent: "",
        value: "",
        width: 0,
        height: 0,
        addEventListener(type, listener) {
            listeners[type] = listener;
        },
        appendChild() {},
        click() {
            if (id === "temporary-anchor") {
                harnessState.downloadNames.push(this.download);
            }
        },
        emit(type, event) {
            listeners[type]?.(event);
        },
        focus() {},
        getBoundingClientRect() {
            return { left: 0, top: 0, width: 100, height: 100 };
        },
        getContext() {
            return fakeContext2d();
        },
        hasPointerCapture(pointerId) {
            return pointerCapture.has(pointerId);
        },
        releasePointerCapture(pointerId) {
            pointerCapture.delete(pointerId);
        },
        remove() {},
        removeAttribute(name) {
            this[name] = "";
        },
        setPointerCapture(pointerId) {
            pointerCapture.add(pointerId);
        },
        toDataURL() {
            return "data:image/png;base64,bWFzaw==";
        }
    };
}

function response({ json, blob, status = 200 }) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => json,
        blob: async () => blob
    };
}

function deferred() {
    let resolve;
    const promise = new Promise(resolvePromise => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

function historyResult(filename, overrides = {}) {
    const stem = filename.replace(/\.[^.]+$/, "");
    return {
        filename,
        source_url: `/static/source/${stem}.png`,
        result_url: `/static/result/${stem}.png`,
        result_mime_type: "image/png",
        width: 100,
        height: 100,
        regions: [{ x: 0.45, y: 0.45, width: 0.1, height: 0.1 }],
        ...overrides
    };
}

function createRuntimeHarness(fetchImpl, { failedImageSources = [] } = {}) {
    const harnessState = {
        downloadNames: [],
        failedImageSources,
        fetchCalls: [],
        historySaves: [],
        requestBodies: []
    };
    const ids = [
        "watermarkRemovalUpload",
        "watermarkRemovalFileInput",
        "watermarkRemovalWorkspace",
        "watermarkRemovalFilename",
        "watermarkRemovalCanvas",
        "watermarkRemovalCanvasStage",
        "watermarkRemovalDelete",
        "watermarkRemovalClear",
        "watermarkRemovalRegionCount",
        "watermarkRemovalSubmit",
        "watermarkRemovalStatus",
        "watermarkRemovalError",
        "watermarkRemovalComparison",
        "watermarkRemovalOriginal",
        "watermarkRemovalResult",
        "watermarkRemovalResultMeta",
        "watermarkRemovalDownload"
    ];
    const elements = Object.fromEntries(
        ids.map(id => [id, fakeElement(id, harnessState)])
    );
    let objectUrlSequence = 0;

    class FakeImage {
        constructor() {
            this.naturalWidth = 100;
            this.naturalHeight = 100;
        }

        set src(value) {
            this.currentSource = value;
            if (harnessState.failedImageSources.some(source => value.includes(source))) {
                this.onerror?.();
            } else {
                this.onload?.();
            }
        }
    }

    class FakeFileReader {
        readAsDataURL(blob) {
            this.result = blob?.dataUrl || "data:image/png;base64,c291cmNl";
            this.onload?.();
        }
    }

    const document = {
        body: {
            appendChild() {},
            removeChild() {}
        },
        createElement(tagName) {
            const element = fakeElement(
                tagName === "a" ? "temporary-anchor" : `temporary-${tagName}`,
                harnessState
            );
            return element;
        },
        getElementById(id) {
            return elements[id] || null;
        }
    };
    const window = {
        WatermarkRemovalCore: core,
        addEventListener() {},
        requestAnimationFrame(callback) {
            callback();
        }
    };
    const context = {
        API_BASE: "http://localhost:8000",
        FileReader: FakeFileReader,
        Image: FakeImage,
        ResizeObserver: class {
            observe() {}
        },
        URL: {
            createObjectURL() {
                objectUrlSequence += 1;
                return `blob:generated-${objectUrlSequence}`;
            },
            revokeObjectURL() {}
        },
        console: { error() {} },
        document,
        fetch: async (url, options = {}) => {
            harnessState.fetchCalls.push({ url, options });
            if (options.body) {
                harnessState.requestBodies.push(JSON.parse(options.body));
            }
            return fetchImpl(url, options, harnessState);
        },
        saveToHistory(module, data) {
            harnessState.historySaves.push({ module, data });
        },
        showToast() {},
        window
    };
    vm.createContext(context);
    vm.runInContext(script, context);
    window.initWatermarkRemoval();
    return { elements, state: harnessState, window };
}

function pointerEvent(clientX, clientY, pointerId = 1) {
    return {
        button: 0,
        clientX,
        clientY,
        pointerId,
        preventDefault() {}
    };
}

function assertRegionClose(actual, expected, message) {
    for (const key of ["x", "y", "width", "height"]) {
        assert.ok(
            Math.abs(actual[key] - expected[key]) < 1e-10,
            `${message}: ${key} was ${actual[key]}, expected ${expected[key]}`
        );
    }
}

function standardFetch(url, options) {
    if (url.includes("/static/source/")) {
        return response({ blob: { dataUrl: "data:image/png;base64,c291cmNl" } });
    }
    if (url.endsWith("/api/watermark-removal") && options.method === "POST") {
        return response({
            json: {
                status: "success",
                data: historyResult("processed.png")
            }
        });
    }
    return response({ blob: { bytes: "result" } });
}

test("page exposes the AI removal tab and controls", () => {
    assert.match(indexHtml, /id="tab-watermark-removal"/);
    assert.match(indexHtml, /id="view-watermark-removal"/);
    assert.match(indexHtml, /id="watermarkRemovalCanvas"/);
    assert.match(indexHtml, /id="watermarkRemovalSubmit"/);
    assert.match(indexHtml, /id="watermarkRemovalDownload"/);
});

test("page exposes upload, editing, comparison, and error states", () => {
    assert.match(indexHtml, /id="watermarkRemovalFileInput"/);
    assert.match(indexHtml, /id="watermarkRemovalDelete"/);
    assert.match(indexHtml, /id="watermarkRemovalClear"/);
    assert.match(indexHtml, /id="watermarkRemovalError"/);
    assert.match(indexHtml, /id="watermarkRemovalComparison"/);
    assert.match(indexHtml, /id="watermarkRemovalOriginal"/);
    assert.match(indexHtml, /id="watermarkRemovalResult"/);
    assert.equal(fs.existsSync(stylePath), true);
});

test("watermark scripts load in dependency order and initialize with the app", () => {
    const corePosition = indexHtml.indexOf('src="js/watermark_removal_core.js"');
    const uiPosition = indexHtml.indexOf('src="js/watermark_removal.js"');

    assert.notEqual(corePosition, -1);
    assert.notEqual(uiPosition, -1);
    assert.ok(corePosition < uiPosition);
    assert.match(appScript, /initWatermarkRemoval/);
});

test("editor supports creation, movement, eight-way resize, and keyboard deletion", () => {
    assert.match(script, /setPointerCapture/);
    assert.match(script, /mode:\s*"create"/);
    assert.match(script, /mode:\s*"move"/);
    for (const handle of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) {
        assert.match(script, new RegExp(`"${handle}"`));
    }
    assert.match(script, /Delete/);
    assert.match(script, /Backspace/);
    assert.match(script, /normalizeRegion/);
    assert.match(script, /denormalizeRegion/);
});

test("submission renders an original-size mask and saves successful history", () => {
    assert.match(script, /renderMask/);
    assert.match(script, /naturalWidth/);
    assert.match(script, /naturalHeight/);
    assert.match(script, /\/api\/watermark-removal/);
    assert.match(script, /mask_data/);
    assert.match(script, /saveToHistory\("watermark-removal"/);
});

test("download is result-only and uses removed suffix", () => {
    assert.match(script, /result_url/);
    assert.match(script, /-removed/);
    assert.doesNotMatch(script, /downloadWatermarkRemovalSource/);
    assert.doesNotMatch(script, /downloadWatermarkRemovalMask/);
});

test("failure does not clear regions", () => {
    assert.match(script, /catch[\s\S]*setWatermarkRemovalBusy\(false\)/);
    assert.doesNotMatch(script, /catch[\s\S]{0,300}regions\s*=\s*\[\]/);
});

test("small regions resize from each of the eight visible handles", async () => {
    const cases = [
        ["nw", [45, 45], { x: 0.5, y: 0.5, width: 0.05, height: 0.05 }],
        ["n", [50, 45], { x: 0.45, y: 0.5, width: 0.1, height: 0.05 }],
        ["ne", [55, 45], { x: 0.45, y: 0.5, width: 0.15, height: 0.05 }],
        ["e", [55, 50], { x: 0.45, y: 0.45, width: 0.15, height: 0.1 }],
        ["se", [55, 55], { x: 0.45, y: 0.45, width: 0.15, height: 0.15 }],
        ["s", [50, 55], { x: 0.45, y: 0.45, width: 0.1, height: 0.15 }],
        ["sw", [45, 55], { x: 0.5, y: 0.45, width: 0.05, height: 0.15 }],
        ["w", [45, 50], { x: 0.5, y: 0.45, width: 0.05, height: 0.1 }]
    ];

    for (const [handle, [x, y], expected] of cases) {
        const harness = createRuntimeHarness(standardFetch);
        assert.equal(
            await harness.window.restoreWatermarkRemovalHistory(historyResult(`${handle}.png`)),
            true
        );
        const canvas = harness.elements.watermarkRemovalCanvas;

        canvas.emit("pointerdown", pointerEvent(x, y));
        canvas.emit("pointermove", pointerEvent(x + 5, y + 5));
        canvas.emit("pointerup", pointerEvent(x + 5, y + 5));
        await harness.window.submitWatermarkRemoval();

        assertRegionClose(
            harness.state.requestBodies.at(-1).regions[0],
            expected,
            `${handle} handle resized the wrong edges`
        );
    }
});

test("history restore is ignored while a submit operation is busy", async () => {
    const pendingSubmit = deferred();
    let newSourceFetches = 0;
    const harness = createRuntimeHarness((url, options) => {
        if (url.endsWith("/static/source/old.png")) {
            return response({ blob: { dataUrl: "data:image/png;base64,b2xk" } });
        }
        if (url.endsWith("/static/source/new.png")) {
            newSourceFetches += 1;
            return response({ blob: { dataUrl: "data:image/png;base64,bmV3" } });
        }
        if (url.endsWith("/api/watermark-removal") && options.method === "POST") {
            return pendingSubmit.promise;
        }
        throw new Error(`Unexpected fetch: ${url}`);
    });
    assert.equal(
        await harness.window.restoreWatermarkRemovalHistory(historyResult("old.png")),
        true
    );

    const submitPromise = harness.window.submitWatermarkRemoval();
    assert.equal(
        await harness.window.restoreWatermarkRemovalHistory(historyResult("new.png")),
        false
    );
    pendingSubmit.resolve(response({
        json: {
            status: "success",
            data: historyResult("old-result.png")
        }
    }));
    await submitPromise;

    assert.equal(newSourceFetches, 0);
    assert.equal(harness.state.historySaves.length, 1);
    assert.equal(harness.state.historySaves[0].data.filename, "old.png");
});

test("download keeps the original result metadata when state changes during fetch", async () => {
    const pendingDownload = deferred();
    const harness = createRuntimeHarness((url) => {
        if (url.includes("/static/source/")) {
            return response({ blob: { dataUrl: "data:image/png;base64,c291cmNl" } });
        }
        if (url.endsWith("/static/result/alpha.png")) {
            return pendingDownload.promise;
        }
        throw new Error(`Unexpected fetch: ${url}`);
    });
    await harness.window.restoreWatermarkRemovalHistory(historyResult("alpha.png"));

    const downloadPromise = harness.window.downloadWatermarkRemovalResult();
    await harness.window.restoreWatermarkRemovalHistory(historyResult("beta.webp", {
        result_mime_type: "image/webp",
        source_url: "/static/source/beta.webp",
        result_url: "/static/result/beta.webp"
    }));
    pendingDownload.resolve(response({ blob: { bytes: "alpha result" } }));
    await downloadPromise;

    assert.deepEqual(harness.state.downloadNames, ["alpha-removed.png"]);
});

test("history restore rejects malformed URLs, dimensions, filenames, and regions", async () => {
    const invalidCases = [
        ["unsafe source URL", { source_url: "javascript:alert(1)" }],
        ["unsafe result URL", { result_url: "/private/result.png" }],
        ["quote-breaking URL", {
            result_url: 'https://cdn.example/result.png" onerror="alert(1)'
        }],
        ["empty filename", { filename: "   " }],
        ["non-integer width", { width: 100.5 }],
        ["unbounded height", { height: 1000000 }],
        ["missing regions", { regions: null }],
        ["non-finite region", {
            regions: [{ x: Number.NaN, y: 0, width: 0.1, height: 0.1 }]
        }],
        ["negative region", {
            regions: [{ x: -0.1, y: 0, width: 0.1, height: 0.1 }]
        }],
        ["zero-area region", {
            regions: [{ x: 0.1, y: 0.1, width: 0, height: 0.1 }]
        }],
        ["overflowing region", {
            regions: [{ x: 0.9, y: 0.1, width: 0.2, height: 0.1 }]
        }]
    ];

    for (const [label, overrides] of invalidCases) {
        const harness = createRuntimeHarness(() => {
            throw new Error(`${label} must be rejected before fetch`);
        });

        assert.equal(
            await harness.window.restoreWatermarkRemovalHistory(
                historyResult("invalid.png", overrides)
            ),
            false,
            label
        );
        assert.equal(harness.state.fetchCalls.length, 0, label);
    }
});

test("failed result preload leaves the current image, result, and regions unchanged", async () => {
    const harness = createRuntimeHarness(standardFetch, {
        failedImageSources: ["/static/result/new.png"]
    });
    const original = historyResult("old.png", {
        regions: [{ x: 0.2, y: 0.25, width: 0.3, height: 0.2 }]
    });

    assert.equal(
        await harness.window.restoreWatermarkRemovalHistory(original),
        true
    );
    const before = {
        filename: harness.elements.watermarkRemovalFilename.textContent,
        originalSrc: harness.elements.watermarkRemovalOriginal.src,
        resultSrc: harness.elements.watermarkRemovalResult.src,
        regionCount: harness.elements.watermarkRemovalRegionCount.textContent
    };

    assert.equal(
        await harness.window.restoreWatermarkRemovalHistory(
            historyResult("new.png", {
                regions: [{ x: 0.7, y: 0.7, width: 0.1, height: 0.1 }]
            })
        ),
        false
    );

    assert.deepEqual({
        filename: harness.elements.watermarkRemovalFilename.textContent,
        originalSrc: harness.elements.watermarkRemovalOriginal.src,
        resultSrc: harness.elements.watermarkRemovalResult.src,
        regionCount: harness.elements.watermarkRemovalRegionCount.textContent
    }, before);

    await harness.window.submitWatermarkRemoval();
    assert.equal(harness.state.requestBodies.at(-1).filename, "old.png");
    assertRegionClose(
        harness.state.requestBodies.at(-1).regions[0],
        original.regions[0],
        "failed restore replaced the current regions"
    );
});

test("sidebar remains vertically reachable on short viewports", () => {
    assert.match(indexHtml, /class="[^"]*watermark-removal-sidebar[^"]*"/);
    assert.match(
        style,
        /\.watermark-removal-sidebar\s*\{[^}]*overflow-y:\s*auto/
    );
});
