const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const frontendRoot = path.resolve(__dirname, "..");
const indexHtml = fs.readFileSync(path.join(frontendRoot, "index.html"), "utf8");
const watermarkJs = fs.readFileSync(path.join(frontendRoot, "js", "watermark_removal.js"), "utf8");

test("index.html watermark section has plain Chinese eyebrow and workflow bridge buttons", () => {
    // 1. Eyebrow should be localized
    assert.doesNotMatch(indexHtml, /<span class="watermark-removal-eyebrow">AI Object Cleanup<\/span>/);
    assert.match(indexHtml, /watermark-removal-eyebrow[^>]*>智能图像无损消除/);

    // 2. Result header should contain buttons for square redraw and translate
    assert.match(indexHtml, /id="watermarkRemovalSendToSquareRedraw"/);
    assert.match(indexHtml, /id="watermarkRemovalSendToTranslate"/);
    assert.match(indexHtml, /id="watermarkRemovalSendToDetails"/);
});

test("sendWatermarkRemovalResultToDetails invokes setDetailProductImage with dataUrl and filename", async () => {
    let capturedImage = null;
    let capturedFilename = null;
    let capturedTab = null;
    let toastMessage = null;

    const fakeBlob = { type: "image/png" };
    const fakeDataUrl = "data:image/png;base64,cleanedWatermarkDataUrl";
    const elementMap = {};

    const sandbox = {
        console,
        API_BASE: "http://127.0.0.1:9503",
        fetch: async (url) => {
            return {
                ok: true,
                status: 200,
                blob: async () => fakeBlob
            };
        },
        readBlobAsDataUrl: async (blob) => fakeDataUrl,
        setDetailProductImage: (dataUrl, filename, asPrimary) => {
            capturedImage = dataUrl;
            capturedFilename = filename;
        },
        switchMainTab: (tab) => {
            capturedTab = tab;
        },
        showToast: (msg, type) => {
            toastMessage = msg;
        },
        FileReader: class {
            readAsDataURL(blob) {
                this.result = fakeDataUrl;
                setTimeout(() => this.onload?.(), 1);
            }
        },
        Image: class {
            constructor() {
                this.naturalWidth = 800;
                this.naturalHeight = 800;
            }
            set src(val) {
                this._src = val;
                setTimeout(() => this.onload?.(), 1);
            }
            get src() { return this._src; }
        },
        document: {
            getElementById: (id) => {
                if (!elementMap[id]) {
                    elementMap[id] = {
                        id,
                        disabled: false,
                        textContent: "",
                        style: {},
                        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
                        addEventListener() {},
                        removeAttribute() {},
                        focus() {},
                        getContext: () => ({
                            clearRect() {},
                            drawImage() {},
                            save() {},
                            restore() {},
                            strokeRect() {},
                            fillRect() {},
                            beginPath() {},
                            setLineDash() {},
                            stroke() {},
                            fill() {},
                            arc() {}
                        }),
                        getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 800 })
                    };
                }
                return elementMap[id];
            }
        },
        WatermarkRemovalCore: require("../js/watermark_removal_core.js"),
        addEventListener: () => {},
        requestAnimationFrame: (cb) => cb(),
        cancelAnimationFrame: () => {},
        window: {},
        globalThis: {}
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;

    const script = new vm.Script(watermarkJs);
    const context = vm.createContext(sandbox);
    script.runInContext(context);

    assert.equal(typeof context.sendWatermarkRemovalResultToDetails, "function");
    assert.equal(typeof context.sendWatermarkRemovalResultToSquareRedraw, "function");
    assert.equal(typeof context.sendWatermarkRemovalResultToTranslate, "function");

    // Initialize watermark removal elements
    context.initWatermarkRemoval();

    // Initialize with a mock image result
    const ok = await context.restoreWatermarkRemovalHistory({
        filename: "test_product.png",
        source_url: "/static/source.png",
        result_url: "/static/cleaned.png",
        width: 800,
        height: 800,
        regions: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.2 }]
    });
    assert.equal(ok, true);

    // 1. Test sending to details
    await context.sendWatermarkRemovalResultToDetails();
    assert.equal(capturedImage, fakeDataUrl);
    assert.equal(capturedFilename, "test_product.png");
    assert.equal(capturedTab, "generate");

    // 2. Test sending to square redraw
    let capturedRedrawItem = null;
    sandbox.addImageToSquareRedraw = (dataUrl, filename) => {
        capturedRedrawItem = { dataUrl, filename };
        return true;
    };
    await context.sendWatermarkRemovalResultToSquareRedraw();
    assert.equal(capturedRedrawItem.dataUrl, fakeDataUrl);
    assert.equal(capturedTab, "square-redraw");

    // 3. Test sending to translate
    sandbox.transImages = [];
    await context.sendWatermarkRemovalResultToTranslate();
    assert.equal(sandbox.transImages.length, 1);
    assert.equal(sandbox.transImages[0].base64, fakeDataUrl);
    assert.equal(capturedTab, "translate");
});
