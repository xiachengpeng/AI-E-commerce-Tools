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

    add(name) {
        this.values.add(name);
    }

    remove(name) {
        this.values.delete(name);
    }

    contains(name) {
        return this.values.has(name);
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
        inert: false,
        src: "",
        style: { overflow: "", overflowY: "" },
        textContent: "",
        value: "",
        width: 0,
        height: 0,
        addEventListener(type, listener) {
            listeners[type] = listener;
        },
        appendChild() {},
        click() {
            harnessState.clickCounts[id] = (harnessState.clickCounts[id] || 0) + 1;
            if (id === "temporary-anchor") {
                harnessState.downloadNames.push(this.download);
            }
        },
        emit(type, event) {
            listeners[type]?.(event);
        },
        focus() {
            harnessState.focusedId = id;
        },
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

function createRuntimeHarness(
    fetchImpl,
    {
        failedImageSources = [],
        imageDimensionsBySource = {}
    } = {}
) {
    const harnessState = {
        clickCounts: {},
        downloadNames: [],
        failedImageSources,
        fetchCalls: [],
        historySaves: [],
        requestBodies: [],
        revokedObjectUrls: []
    };
    const ids = [
        "watermarkRemovalPage",
        "watermarkRemovalUpload",
        "watermarkRemovalFileInput",
        "watermarkRemovalWorkspace",
        "watermarkRemovalFilename",
        "watermarkRemovalCanvas",
        "watermarkRemovalCanvasStage",
        "watermarkRemovalReplace",
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
        "watermarkRemovalDownload",
        "watermarkRemovalZoomButton",
        "watermarkRemovalPreview",
        "watermarkRemovalPreviewImage",
        "watermarkRemovalPreviewClose"
    ];
    const elements = Object.fromEntries(
        ids.map(id => [id, fakeElement(id, harnessState)])
    );
    elements.watermarkRemovalPreview.hidden = true;
    let objectUrlSequence = 0;

    class FakeImage {
        constructor() {
            this.naturalWidth = 100;
            this.naturalHeight = 100;
        }

        set src(value) {
            this.currentSource = value;
            const dimensions = Object.entries(imageDimensionsBySource)
                .find(([source]) => value.includes(source))?.[1];
            if (dimensions) {
                [this.naturalWidth, this.naturalHeight] = dimensions;
            }
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
            removeChild() {},
            classList: new FakeClassList()
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
    const windowListeners = {};
    const window = {
        WatermarkRemovalCore: core,
        addEventListener(type, listener) {
            windowListeners[type] = listener;
        },
        emit(type, event) {
            windowListeners[type]?.(event);
        },
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
            revokeObjectURL(value) {
                harnessState.revokedObjectUrls.push(value);
            }
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
    assert.match(indexHtml, /id="watermarkRemovalZoomButton"/);
    assert.match(
        indexHtml,
        /<div\s+id="watermarkRemovalPreview"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*>/
    );
    assert.match(indexHtml, /id="watermarkRemovalPreviewImage"/);
    assert.match(indexHtml, /id="watermarkRemovalPreviewClose"/);
    assert.match(indexHtml, /id="watermarkRemovalSubmit"/);
    assert.match(indexHtml, /id="watermarkRemovalDownload"/);
});

test("page exposes upload, editing, comparison, and error states", () => {
    assert.match(indexHtml, /id="watermarkRemovalFileInput"/);
    assert.match(
        indexHtml,
        /<button[^>]*id="watermarkRemovalUpload"[^>]*type="button"[^>]*>/
    );
    assert.match(indexHtml, /id="watermarkRemovalDelete"/);
    assert.match(indexHtml, /id="watermarkRemovalClear"/);
    assert.match(indexHtml, /id="watermarkRemovalError"/);
    assert.match(indexHtml, /id="watermarkRemovalComparison"/);
    assert.match(indexHtml, /id="watermarkRemovalOriginal"/);
    assert.match(indexHtml, /id="watermarkRemovalResult"/);
    assert.equal(fs.existsSync(stylePath), true);
});

test("workspace exposes an always-visible replace-image control", () => {
    assert.match(
        indexHtml,
        /<button[^>]*id="watermarkRemovalReplace"[^>]*>[\s\S]*?更换图片[\s\S]*?<\/button>/
    );
});

test("ownership, AI-provider transfer, and local persistence disclosure is always visible", () => {
    assert.match(indexHtml, /仅处理您拥有或获准编辑的图片/);
    assert.match(indexHtml, /图片会发送给已配置的 AI 提供商/);
    assert.match(indexHtml, /在本地静态文件与历史中保存/);
    assert.doesNotMatch(indexHtml, /仅用于本次处理/);
    assert.doesNotMatch(
        style,
        /\.watermark-removal-(?:privacy|disclosure)\s*\{\s*display:\s*none/
    );
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

test("replace-image control is disabled while AI submission is busy", async () => {
    const pendingSubmit = deferred();
    const harness = createRuntimeHarness((url, options) => {
        if (url.endsWith("/static/source/old.png")) {
            return response({ blob: { dataUrl: "data:image/png;base64,b2xk" } });
        }
        if (url.endsWith("/api/watermark-removal") && options.method === "POST") {
            return pendingSubmit.promise;
        }
        throw new Error(`Unexpected fetch: ${url}`);
    });
    await harness.window.restoreWatermarkRemovalHistory(historyResult("old.png"));

    const submitPromise = harness.window.submitWatermarkRemoval();

    assert.equal(harness.elements.watermarkRemovalFileInput.disabled, true);
    assert.equal(harness.elements.watermarkRemovalReplace.disabled, true);

    pendingSubmit.resolve(response({
        json: {
            status: "success",
            data: historyResult("old-result.png")
        }
    }));
    await submitPromise;

    assert.equal(harness.elements.watermarkRemovalReplace.disabled, false);
});

test("result preview opens from the result image and returns focus when closed", async () => {
    const harness = createRuntimeHarness(standardFetch);
    assert.equal(
        await harness.window.restoreWatermarkRemovalHistory(historyResult("sample.png")),
        true
    );

    harness.elements.watermarkRemovalResult.emit("click", {});

    assert.equal(harness.elements.watermarkRemovalPreview.hidden, false);
    assert.equal(
        harness.elements.watermarkRemovalPreviewImage.src,
        "http://localhost:8000/static/result/sample.png"
    );
    assert.equal(harness.state.focusedId, "watermarkRemovalPreviewClose");

    harness.elements.watermarkRemovalPreviewClose.emit("click", {});

    assert.equal(harness.elements.watermarkRemovalPreview.hidden, true);
    assert.equal(harness.elements.watermarkRemovalPreviewImage.src, "");
    assert.equal(harness.state.focusedId, "watermarkRemovalResult");
});

test("result preview locks and inerts the nested page while trapping Tab focus", async () => {
    const harness = createRuntimeHarness(standardFetch);
    await harness.window.restoreWatermarkRemovalHistory(historyResult("sample.png"));
    const page = harness.elements.watermarkRemovalPage;
    page.style.overflow = "scroll";
    page.style.overflowY = "auto";
    page.inert = false;
    page.classList.add("watermark-removal-preview-open");

    harness.elements.watermarkRemovalResult.emit("click", {});

    assert.equal(page.style.overflow, "hidden");
    assert.equal(page.style.overflowY, "hidden");
    assert.equal(page.inert, true);
    assert.equal(page.classList.contains("watermark-removal-preview-open"), true);

    const tabEvent = {
        key: "Tab",
        shiftKey: true,
        preventDefault() {
            this.defaultPrevented = true;
        }
    };
    harness.window.emit("keydown", tabEvent);
    assert.equal(tabEvent.defaultPrevented, true);
    assert.equal(harness.state.focusedId, "watermarkRemovalPreviewClose");

    harness.elements.watermarkRemovalPreviewClose.emit("click", {});
    assert.equal(page.style.overflow, "scroll");
    assert.equal(page.style.overflowY, "auto");
    assert.equal(page.inert, false);
    assert.equal(page.classList.contains("watermark-removal-preview-open"), true);
});

test("result preview supports its alternate opening and closing controls", async () => {
    const harness = createRuntimeHarness(standardFetch);
    await harness.window.restoreWatermarkRemovalHistory(historyResult("sample.png"));
    const preview = harness.elements.watermarkRemovalPreview;

    harness.elements.watermarkRemovalZoomButton.emit("click", {});
    assert.equal(preview.hidden, false);
    assert.equal(harness.state.focusedId, "watermarkRemovalPreviewClose");

    preview.emit("click", { target: harness.elements.watermarkRemovalPreviewImage });
    assert.equal(preview.hidden, false, "clicking the enlarged image must not close the preview");

    preview.emit("click", { target: preview });
    assert.equal(preview.hidden, true, "clicking the backdrop must close the preview");
    assert.equal(harness.state.focusedId, "watermarkRemovalZoomButton");

    harness.elements.watermarkRemovalResult.emit("keydown", { key: "Enter" });
    assert.equal(preview.hidden, false);
    harness.window.emit("keydown", { key: "Escape" });
    assert.equal(preview.hidden, true);
    assert.equal(harness.state.focusedId, "watermarkRemovalResult");

    harness.elements.watermarkRemovalResult.emit("keydown", { key: " " });
    assert.equal(preview.hidden, false);
    harness.elements.watermarkRemovalPreviewClose.emit("click", {});
});

test("result preview remains closed when no result exists or its result is replaced", async () => {
    const emptyHarness = createRuntimeHarness(standardFetch);
    emptyHarness.elements.watermarkRemovalResult.emit("click", {});
    assert.equal(emptyHarness.elements.watermarkRemovalPreview.hidden, true);

    const harness = createRuntimeHarness(standardFetch, {
        imageDimensionsBySource: { "blob:generated-1": [100, 100] }
    });
    await harness.window.restoreWatermarkRemovalHistory(historyResult("sample.png"));
    harness.elements.watermarkRemovalResult.emit("click", {});
    assert.equal(harness.elements.watermarkRemovalPreview.hidden, false);

    await harness.window.handleWatermarkUpload({
        target: {
            files: [{
                name: "replacement.png",
                type: "image/png",
                dataUrl: "data:image/png;base64,cmVwbGFjZW1lbnQ="
            }],
            value: "selected"
        }
    });

    assert.equal(harness.elements.watermarkRemovalPreview.hidden, true);
    assert.equal(harness.elements.watermarkRemovalPreviewImage.src, "");
    assert.equal(harness.state.focusedId, "watermarkRemovalPage");
});

test("history restoration closes an open preview before replacing its result", async () => {
    const harness = createRuntimeHarness(standardFetch);
    await harness.window.restoreWatermarkRemovalHistory(historyResult("first.png"));
    harness.elements.watermarkRemovalResult.emit("click", {});
    assert.equal(harness.elements.watermarkRemovalPreview.hidden, false);

    assert.equal(
        await harness.window.restoreWatermarkRemovalHistory(historyResult("second.png")),
        true
    );

    assert.equal(harness.elements.watermarkRemovalPreview.hidden, true);
    assert.equal(harness.elements.watermarkRemovalPreviewImage.src, "");
    assert.equal(
        harness.elements.watermarkRemovalResult.src,
        "http://localhost:8000/static/result/second.png"
    );
});

test("a new successful result closes the old preview without focusing hidden result controls", async () => {
    const harness = createRuntimeHarness(standardFetch);
    await harness.window.restoreWatermarkRemovalHistory(historyResult("first.png"));
    harness.elements.watermarkRemovalResult.emit("click", {});
    assert.equal(harness.elements.watermarkRemovalPreview.hidden, false);

    await harness.window.submitWatermarkRemoval();

    assert.equal(harness.elements.watermarkRemovalPreview.hidden, true);
    assert.equal(harness.elements.watermarkRemovalPreviewImage.src, "");
    assert.equal(harness.state.focusedId, "watermarkRemovalPage");
    assert.equal(
        harness.elements.watermarkRemovalResult.src,
        "http://localhost:8000/static/result/processed.png"
    );
});

test("result and preview image load failures cannot leave an open empty modal", async () => {
    const harness = createRuntimeHarness(standardFetch);
    await harness.window.restoreWatermarkRemovalHistory(historyResult("sample.png"));

    harness.elements.watermarkRemovalResult.emit("click", {});
    harness.elements.watermarkRemovalPreviewImage.emit("error", {});
    assert.equal(harness.elements.watermarkRemovalPreview.hidden, true);
    assert.equal(harness.elements.watermarkRemovalPreviewImage.src, "");
    assert.equal(harness.elements.watermarkRemovalComparison.hidden, true);
    assert.equal(harness.elements.watermarkRemovalResult.src, "");
    assert.equal(harness.state.focusedId, "watermarkRemovalPage");
    harness.elements.watermarkRemovalResult.emit("click", {});
    assert.equal(harness.elements.watermarkRemovalPreview.hidden, true);
});

test("initial upload entry explicitly opens the file chooser", () => {
    const harness = createRuntimeHarness(standardFetch);
    let defaultPrevented = false;

    harness.elements.watermarkRemovalUpload.emit("click", {
        preventDefault() {
            defaultPrevented = true;
        }
    });

    assert.equal(defaultPrevented, true);
    assert.equal(harness.state.clickCounts.watermarkRemovalFileInput, 1);
});

test("replace-image entry atomically installs a fully loaded image and clears old work", async () => {
    const harness = createRuntimeHarness(standardFetch, {
        imageDimensionsBySource: {
            "blob:generated-1": [240, 160]
        }
    });
    await harness.window.restoreWatermarkRemovalHistory(historyResult("old.png", {
        regions: [{ x: 0.2, y: 0.25, width: 0.3, height: 0.2 }]
    }));
    const replaceButton = harness.elements.watermarkRemovalReplace;
    const fileInput = harness.elements.watermarkRemovalFileInput;

    replaceButton.emit("click", {});
    assert.equal(harness.state.clickCounts.watermarkRemovalFileInput, 1);

    const replacementData = "data:image/webp;base64,bmV3LXNvdXJjZQ==";
    await harness.window.handleWatermarkUpload({
        target: {
            files: [{
                name: "replacement.webp",
                type: "image/webp",
                dataUrl: replacementData
            }],
            value: "selected"
        }
    });

    assert.equal(harness.elements.watermarkRemovalFilename.textContent, "replacement.webp");
    assert.equal(harness.elements.watermarkRemovalRegionCount.textContent, "0 个区域");
    assert.equal(harness.elements.watermarkRemovalComparison.hidden, true);
    assert.equal(harness.elements.watermarkRemovalOriginal.src, "");
    assert.equal(harness.elements.watermarkRemovalResult.src, "");
    assert.equal(harness.elements.watermarkRemovalCanvas.width, 240);
    assert.equal(harness.elements.watermarkRemovalCanvas.height, 160);

    const canvas = harness.elements.watermarkRemovalCanvas;
    canvas.emit("pointerdown", pointerEvent(10, 10));
    canvas.emit("pointermove", pointerEvent(30, 30));
    canvas.emit("pointerup", pointerEvent(30, 30));
    await harness.window.submitWatermarkRemoval();

    assert.equal(harness.state.requestBodies.at(-1).filename, "replacement.webp");
    assert.equal(harness.state.requestBodies.at(-1).image_data, replacementData);
});

test("failed replacement keeps the previous source, regions, dimensions, and result", async () => {
    const harness = createRuntimeHarness(standardFetch, {
        failedImageSources: ["blob:generated-1"]
    });
    const original = historyResult("old.png", {
        regions: [{ x: 0.2, y: 0.25, width: 0.3, height: 0.2 }]
    });
    await harness.window.restoreWatermarkRemovalHistory(original);
    const before = {
        filename: harness.elements.watermarkRemovalFilename.textContent,
        regionCount: harness.elements.watermarkRemovalRegionCount.textContent,
        originalSrc: harness.elements.watermarkRemovalOriginal.src,
        resultSrc: harness.elements.watermarkRemovalResult.src,
        canvasWidth: harness.elements.watermarkRemovalCanvas.width,
        canvasHeight: harness.elements.watermarkRemovalCanvas.height
    };

    await harness.window.handleWatermarkUpload({
        target: {
            files: [{
                name: "broken.png",
                type: "image/png",
                dataUrl: "data:image/png;base64,YnJva2Vu"
            }],
            value: "selected"
        }
    });

    assert.deepEqual({
        filename: harness.elements.watermarkRemovalFilename.textContent,
        regionCount: harness.elements.watermarkRemovalRegionCount.textContent,
        originalSrc: harness.elements.watermarkRemovalOriginal.src,
        resultSrc: harness.elements.watermarkRemovalResult.src,
        canvasWidth: harness.elements.watermarkRemovalCanvas.width,
        canvasHeight: harness.elements.watermarkRemovalCanvas.height
    }, before);
    assert.deepEqual(harness.state.revokedObjectUrls, ["blob:generated-1"]);

    await harness.window.submitWatermarkRemoval();
    assert.equal(harness.state.requestBodies.at(-1).filename, "old.png");
    assertRegionClose(
        harness.state.requestBodies.at(-1).regions[0],
        original.regions[0],
        "failed replacement replaced the previous regions"
    );
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
