(function (root) {
    "use strict";

    const core = root.WatermarkRemovalCore;
    const HANDLE_NAMES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
    const MIN_REGION_SIZE = 0.004;
    const MIN_CREATE_PIXELS = 5;
    const MAX_HISTORY_IMAGE_DIMENSION = 32768;
    const MAX_HISTORY_REGION_COUNT = 100;

    const state = {
        initialized: false,
        busy: false,
        filename: "",
        imageData: "",
        sourceUrl: "",
        sourceObjectUrl: "",
        image: null,
        regions: [],
        selectedIndex: -1,
        interaction: null,
        result: null,
        previewTrigger: null,
        previewPageState: null,
        elements: {}
    };

    function byId(id) {
        return document.getElementById(id);
    }

    function cacheElements() {
        state.elements = {
            page: byId("watermarkRemovalPage"),
            upload: byId("watermarkRemovalUpload"),
            fileInput: byId("watermarkRemovalFileInput"),
            workspace: byId("watermarkRemovalWorkspace"),
            filename: byId("watermarkRemovalFilename"),
            canvas: byId("watermarkRemovalCanvas"),
            stage: byId("watermarkRemovalCanvasStage"),
            replaceButton: byId("watermarkRemovalReplace"),
            deleteButton: byId("watermarkRemovalDelete"),
            clearButton: byId("watermarkRemovalClear"),
            count: byId("watermarkRemovalRegionCount"),
            submit: byId("watermarkRemovalSubmit"),
            status: byId("watermarkRemovalStatus"),
            error: byId("watermarkRemovalError"),
            comparison: byId("watermarkRemovalComparison"),
            original: byId("watermarkRemovalOriginal"),
            resultImage: byId("watermarkRemovalResult"),
            resultMeta: byId("watermarkRemovalResultMeta"),
            download: byId("watermarkRemovalDownload"),
            zoomButton: byId("watermarkRemovalZoomButton"),
            preview: byId("watermarkRemovalPreview"),
            previewImage: byId("watermarkRemovalPreviewImage"),
            previewClose: byId("watermarkRemovalPreviewClose")
        };
    }

    function clamp(value, minimum, maximum) {
        return Math.min(Math.max(value, minimum), maximum);
    }

    function assetUrl(url) {
        if (!url || /^(?:data:|blob:|https?:\/\/)/i.test(url)) return url || "";
        return `${API_BASE}${url.startsWith("/") ? "" : "/"}${url}`;
    }

    function isAllowedHistoryAssetUrl(value) {
        if (typeof value !== "string" || value !== value.trim()) return false;
        if (/[\u0000-\u0020\u007f"'<>\\]/.test(value)) return false;
        return value.startsWith("/static/")
            || /^https?:\/\/[^/?#]+(?:[/?#].*)?$/i.test(value);
    }

    function historyResultValidationError(result) {
        if (!result || typeof result !== "object" || Array.isArray(result)) {
            return "该历史记录数据格式已失效";
        }
        if (
            typeof result.filename !== "string"
            || !result.filename.trim()
            || result.filename.length > 255
            || /[\u0000-\u001f\u007f]/.test(result.filename)
        ) {
            return "该历史记录文件名无效";
        }
        if (
            !isAllowedHistoryAssetUrl(result.source_url)
            || !isAllowedHistoryAssetUrl(result.result_url)
        ) {
            return "该历史记录包含无效图片地址";
        }
        if (
            !Number.isSafeInteger(result.width)
            || !Number.isSafeInteger(result.height)
            || result.width <= 0
            || result.height <= 0
            || result.width > MAX_HISTORY_IMAGE_DIMENSION
            || result.height > MAX_HISTORY_IMAGE_DIMENSION
        ) {
            return "该历史记录图片尺寸无效";
        }
        if (
            !Array.isArray(result.regions)
            || result.regions.length === 0
            || result.regions.length > MAX_HISTORY_REGION_COUNT
        ) {
            return "该历史记录选区无效";
        }
        const validRegions = result.regions.every(region => {
            if (!region || typeof region !== "object" || Array.isArray(region)) {
                return false;
            }
            const { x, y, width, height } = region;
            return [x, y, width, height].every(Number.isFinite)
                && x >= 0
                && y >= 0
                && width > 0
                && height > 0
                && x <= 1
                && y <= 1
                && width <= 1
                && height <= 1
                && x + width <= 1
                && y + height <= 1;
        });
        return validRegions ? "" : "该历史记录选区无效";
    }

    function setWatermarkRemovalError(message) {
        const element = state.elements.error;
        if (!element) return;
        element.textContent = message || "";
        element.hidden = !message;
    }

    function updateWatermarkRemovalControls() {
        const {
            canvas,
            clearButton,
            deleteButton,
            fileInput,
            replaceButton,
            submit,
            status,
            count
        } = state.elements;
        const hasImage = Boolean(state.image);
        const canSubmit = core.canSubmitRemoval({
            hasImage,
            regions: state.regions,
            busy: state.busy
        });

        if (count) count.textContent = `${state.regions.length} 个区域`;
        if (fileInput) fileInput.disabled = state.busy;
        if (replaceButton) replaceButton.disabled = state.busy;
        if (clearButton) clearButton.disabled = state.busy || state.regions.length === 0;
        if (deleteButton) {
            deleteButton.disabled = state.busy
                || state.selectedIndex < 0
                || state.selectedIndex >= state.regions.length;
        }
        if (submit) submit.disabled = !canSubmit;
        if (canvas) canvas.classList.toggle("is-busy", state.busy);
        if (status) {
            if (state.busy) {
                status.textContent = "处理中，请保持页面开启";
            } else if (!hasImage) {
                status.textContent = "上传图片并框选区域后即可提交";
            } else if (!state.regions.length) {
                status.textContent = "请在图片上拖拽框选至少一个水印区域";
            } else {
                status.textContent = `已框选 ${state.regions.length} 个区域，可以提交`;
            }
        }
    }

    function setWatermarkRemovalBusy(busy) {
        state.busy = busy;
        if (state.elements.submit) {
            state.elements.submit.classList.toggle("is-busy", busy);
        }
        updateWatermarkRemovalControls();
    }

    function canvasDisplayRect() {
        const rect = state.elements.canvas.getBoundingClientRect();
        return {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height
        };
    }

    function localPointer(event) {
        const rect = canvasDisplayRect();
        return {
            x: clamp((event.clientX - rect.left) / rect.width, 0, 1),
            y: clamp((event.clientY - rect.top) / rect.height, 0, 1),
            clientX: clamp(event.clientX, rect.left, rect.left + rect.width),
            clientY: clamp(event.clientY, rect.top, rect.top + rect.height)
        };
    }

    function regionBounds(region) {
        return {
            left: region.x,
            top: region.y,
            right: region.x + region.width,
            bottom: region.y + region.height
        };
    }

    function handlePoints(region) {
        const bounds = regionBounds(region);
        const centerX = (bounds.left + bounds.right) / 2;
        const centerY = (bounds.top + bounds.bottom) / 2;
        return {
            "nw": [bounds.left, bounds.top],
            "n": [centerX, bounds.top],
            "ne": [bounds.right, bounds.top],
            "e": [bounds.right, centerY],
            "se": [bounds.right, bounds.bottom],
            "s": [centerX, bounds.bottom],
            "sw": [bounds.left, bounds.bottom],
            "w": [bounds.left, centerY]
        };
    }

    function hitResizeHandle(pointer) {
        if (state.selectedIndex < 0 || !state.regions[state.selectedIndex]) return "";
        const rect = canvasDisplayRect();
        const points = handlePoints(state.regions[state.selectedIndex]);

        const candidates = HANDLE_NAMES.map((name, order) => {
            const point = points[name];
            const deltaX = (pointer.x - point[0]) * rect.width;
            const deltaY = (pointer.y - point[1]) * rect.height;
            return {
                name,
                order,
                deltaX,
                deltaY,
                distance: Math.hypot(deltaX, deltaY)
            };
        }).filter(candidate => (
            Math.abs(candidate.deltaX) <= 11
            && Math.abs(candidate.deltaY) <= 11
        ));

        candidates.sort((left, right) => (
            left.distance - right.distance || left.order - right.order
        ));
        return candidates[0]?.name || "";
    }

    function hitRegion(pointer) {
        for (let index = state.regions.length - 1; index >= 0; index -= 1) {
            const bounds = regionBounds(state.regions[index]);
            if (
                pointer.x >= bounds.left
                && pointer.x <= bounds.right
                && pointer.y >= bounds.top
                && pointer.y <= bounds.bottom
            ) {
                return index;
            }
        }
        return -1;
    }

    function drawWatermarkRemovalEditor() {
        const { canvas } = state.elements;
        if (!canvas || !state.image) return;

        if (
            canvas.width !== state.image.naturalWidth
            || canvas.height !== state.image.naturalHeight
        ) {
            canvas.width = state.image.naturalWidth;
            canvas.height = state.image.naturalHeight;
        }

        const context = canvas.getContext("2d");
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(state.image, 0, 0, canvas.width, canvas.height);

        const displayedWidth = canvas.getBoundingClientRect().width || canvas.width;
        const scale = canvas.width / displayedWidth;
        const lineWidth = Math.max(2 * scale, canvas.width / 900);
        const handleRadius = Math.max(5 * scale, canvas.width / 250);
        const imageRect = { left: 0, top: 0, width: canvas.width, height: canvas.height };

        state.regions.forEach((region, index) => {
            const rect = core.denormalizeRegion(region, imageRect);
            const selected = index === state.selectedIndex;
            context.save();
            context.fillStyle = selected ? "rgba(79, 70, 229, 0.2)" : "rgba(14, 165, 233, 0.16)";
            context.strokeStyle = selected ? "#4f46e5" : "#0ea5e9";
            context.lineWidth = lineWidth;
            context.setLineDash(selected ? [] : [6 * scale, 4 * scale]);
            context.fillRect(rect.left, rect.top, rect.width, rect.height);
            context.strokeRect(rect.left, rect.top, rect.width, rect.height);

            if (selected) {
                context.setLineDash([]);
                context.fillStyle = "#ffffff";
                context.strokeStyle = "#4f46e5";
                context.lineWidth = Math.max(scale, 1);
                Object.values(handlePoints(region)).forEach(point => {
                    context.beginPath();
                    context.arc(
                        point[0] * canvas.width,
                        point[1] * canvas.height,
                        handleRadius,
                        0,
                        Math.PI * 2
                    );
                    context.fill();
                    context.stroke();
                });
            }
            context.restore();
        });
    }

    function requestEditorRedraw() {
        root.requestAnimationFrame(drawWatermarkRemovalEditor);
    }

    function normalizeDrag(start, current) {
        const display = canvasDisplayRect();
        const left = Math.min(start.clientX, current.clientX);
        const top = Math.min(start.clientY, current.clientY);
        return core.normalizeRegion(
            {
                left,
                top,
                width: Math.abs(current.clientX - start.clientX),
                height: Math.abs(current.clientY - start.clientY)
            },
            display
        );
    }

    function resizedRegion(base, handle, deltaX, deltaY) {
        let { left, top, right, bottom } = regionBounds(base);

        if (handle.includes("w")) left = clamp(left + deltaX, 0, right - MIN_REGION_SIZE);
        if (handle.includes("e")) right = clamp(right + deltaX, left + MIN_REGION_SIZE, 1);
        if (handle.includes("n")) top = clamp(top + deltaY, 0, bottom - MIN_REGION_SIZE);
        if (handle.includes("s")) bottom = clamp(bottom + deltaY, top + MIN_REGION_SIZE, 1);

        return {
            x: left,
            y: top,
            width: right - left,
            height: bottom - top
        };
    }

    function onEditorPointerDown(event) {
        if (state.busy || !state.image || event.button !== 0) return;
        const canvas = state.elements.canvas;
        const pointer = localPointer(event);
        const handle = hitResizeHandle(pointer);
        const regionIndex = handle ? state.selectedIndex : hitRegion(pointer);

        canvas.focus({ preventScroll: true });
        canvas.setPointerCapture(event.pointerId);

        if (handle) {
            state.interaction = {
                mode: "resize",
                pointerId: event.pointerId,
                handle,
                start: pointer,
                baseRegion: { ...state.regions[state.selectedIndex] }
            };
        } else if (regionIndex >= 0) {
            state.selectedIndex = regionIndex;
            state.interaction = {
                mode: "move",
                pointerId: event.pointerId,
                start: pointer,
                baseRegion: { ...state.regions[regionIndex] }
            };
        } else {
            state.regions.push({ x: pointer.x, y: pointer.y, width: 0, height: 0 });
            state.selectedIndex = state.regions.length - 1;
            state.interaction = {
                mode: "create",
                pointerId: event.pointerId,
                start: pointer
            };
        }

        setWatermarkRemovalError("");
        updateWatermarkRemovalControls();
        requestEditorRedraw();
        event.preventDefault();
    }

    function onEditorPointerMove(event) {
        const interaction = state.interaction;
        if (!interaction || interaction.pointerId !== event.pointerId || state.busy) return;
        const pointer = localPointer(event);
        const index = state.selectedIndex;

        if (interaction.mode === "create") {
            state.regions[index] = normalizeDrag(interaction.start, pointer);
        } else if (interaction.mode === "move") {
            const base = interaction.baseRegion;
            state.regions[index] = {
                x: clamp(base.x + pointer.x - interaction.start.x, 0, 1 - base.width),
                y: clamp(base.y + pointer.y - interaction.start.y, 0, 1 - base.height),
                width: base.width,
                height: base.height
            };
        } else if (interaction.mode === "resize") {
            state.regions[index] = resizedRegion(
                interaction.baseRegion,
                interaction.handle,
                pointer.x - interaction.start.x,
                pointer.y - interaction.start.y
            );
        }

        updateWatermarkRemovalControls();
        requestEditorRedraw();
        event.preventDefault();
    }

    function onEditorPointerUp(event) {
        const interaction = state.interaction;
        if (!interaction || interaction.pointerId !== event.pointerId) return;
        const canvas = state.elements.canvas;

        if (interaction.mode === "create") {
            const display = canvasDisplayRect();
            const region = state.regions[state.selectedIndex];
            if (
                !region
                || region.width * display.width < MIN_CREATE_PIXELS
                || region.height * display.height < MIN_CREATE_PIXELS
            ) {
                state.regions.splice(state.selectedIndex, 1);
                state.selectedIndex = -1;
            }
        }

        if (canvas.hasPointerCapture(event.pointerId)) {
            canvas.releasePointerCapture(event.pointerId);
        }
        state.interaction = null;
        updateWatermarkRemovalControls();
        requestEditorRedraw();
    }

    function deleteSelectedRegion() {
        if (state.busy || state.selectedIndex < 0) return;
        state.regions.splice(state.selectedIndex, 1);
        state.selectedIndex = Math.min(state.selectedIndex, state.regions.length - 1);
        updateWatermarkRemovalControls();
        requestEditorRedraw();
    }

    function clearWatermarkRegions() {
        if (state.busy || !state.regions.length) return;
        state.regions = [];
        state.selectedIndex = -1;
        updateWatermarkRemovalControls();
        requestEditorRedraw();
    }

    function onEditorKeyDown(event) {
        if ((event.key === "Delete" || event.key === "Backspace") && state.selectedIndex >= 0) {
            event.preventDefault();
            deleteSelectedRegion();
        }
    }

    function loadImageSource(source) {
        return new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () => reject(new Error("无法读取图片，请更换文件后重试"));
            image.src = source;
        });
    }

    function readBlobAsDataUrl(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error("图片读取失败"));
            reader.readAsDataURL(blob);
        });
    }

    function lockPreviewBackground() {
        const page = state.elements.page;
        if (!page || state.previewPageState) return;
        state.previewPageState = {
            inert: page.inert,
            overflow: page.style.overflow,
            overflowY: page.style.overflowY,
            wasLocked: page.classList.contains("watermark-removal-preview-open")
        };
        page.inert = true;
        page.style.overflow = "hidden";
        page.style.overflowY = "hidden";
        page.classList.add("watermark-removal-preview-open");
    }

    function unlockPreviewBackground() {
        const page = state.elements.page;
        const previous = state.previewPageState;
        if (!page || !previous) return;
        page.inert = previous.inert;
        page.style.overflow = previous.overflow;
        page.style.overflowY = previous.overflowY;
        page.classList.toggle("watermark-removal-preview-open", previous.wasLocked);
        state.previewPageState = null;
    }

    function openResultPreview(trigger) {
        if (!state.result?.result_url || !state.elements.resultImage?.src) return;
        state.previewTrigger = trigger || state.elements.resultImage;
        lockPreviewBackground();
        state.elements.previewImage.src = state.elements.resultImage.src;
        state.elements.preview.hidden = false;
        state.elements.previewClose.focus();
    }

    function closeResultPreview({ restoreFocus = true } = {}) {
        if (state.elements.preview.hidden) return;
        state.elements.preview.hidden = true;
        state.elements.previewImage.removeAttribute("src");
        unlockPreviewBackground();
        const trigger = state.previewTrigger;
        state.previewTrigger = null;
        if (restoreFocus) trigger?.focus();
        else state.elements.page?.focus({ preventScroll: true });
    }

    function resetResult() {
        closeResultPreview({ restoreFocus: false });
        state.result = null;
        if (state.elements.comparison) state.elements.comparison.hidden = true;
        if (state.elements.download) state.elements.download.disabled = true;
        if (state.elements.original) state.elements.original.removeAttribute("src");
        if (state.elements.resultImage) state.elements.resultImage.removeAttribute("src");
    }

    async function applySourceImage({ filename, imageData, sourceUrl }) {
        const image = await loadImageSource(sourceUrl);
        if (state.sourceObjectUrl && state.sourceObjectUrl !== sourceUrl) {
            URL.revokeObjectURL(state.sourceObjectUrl);
        }

        state.filename = filename;
        state.imageData = imageData;
        state.sourceUrl = sourceUrl;
        state.sourceObjectUrl = sourceUrl.startsWith("blob:") ? sourceUrl : "";
        state.image = image;
        state.regions = [];
        state.selectedIndex = -1;
        state.interaction = null;

        state.elements.upload.hidden = true;
        state.elements.workspace.hidden = false;
        state.elements.filename.textContent = filename;
        setWatermarkRemovalError("");
        resetResult();
        updateWatermarkRemovalControls();
        requestEditorRedraw();
    }

    async function handleWatermarkUpload(event) {
        const file = event?.target?.files?.[0];
        if (!file || state.busy) return;
        const supportedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

        if (!supportedTypes.has(file.type)) {
            setWatermarkRemovalError("仅支持 JPG、PNG 或 WebP 图片");
            event.target.value = "";
            return;
        }

        const objectUrl = URL.createObjectURL(file);
        try {
            const imageData = await readBlobAsDataUrl(file);
            await applySourceImage({
                filename: file.name,
                imageData,
                sourceUrl: objectUrl
            });
        } catch (error) {
            URL.revokeObjectURL(objectUrl);
            setWatermarkRemovalError(error.message || "图片加载失败");
        } finally {
            event.target.value = "";
        }
    }

    function renderWatermarkRemovalResult(result, originalUrl) {
        closeResultPreview({ restoreFocus: false });
        state.result = result;
        state.elements.original.src = assetUrl(originalUrl);
        state.elements.resultImage.src = assetUrl(result.result_url);
        state.elements.resultMeta.textContent = result.width && result.height
            ? `${result.width} × ${result.height} · 已消除 ${result.regions?.length || state.regions.length} 个区域`
            : "对比原图与消除结果";
        state.elements.comparison.hidden = false;
        state.elements.download.disabled = false;
    }

    function buildMaskData() {
        const maskCanvas = document.createElement("canvas");
        maskCanvas.width = state.image.naturalWidth;
        maskCanvas.height = state.image.naturalHeight;
        core.renderMask(
            maskCanvas.getContext("2d"),
            state.image.naturalWidth,
            state.image.naturalHeight,
            state.regions
        );
        return maskCanvas.toDataURL("image/png");
    }

    async function submitWatermarkRemoval() {
        if (!core.canSubmitRemoval({
            hasImage: Boolean(state.image && state.imageData),
            regions: state.regions,
            busy: state.busy
        })) {
            setWatermarkRemovalError("请先上传图片并框选至少一个水印区域");
            return;
        }

        setWatermarkRemovalError("");
        setWatermarkRemovalBusy(true);

        try {
            const response = await fetch(`${API_BASE}/api/watermark-removal`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    filename: state.filename,
                    image_data: state.imageData,
                    mask_data: buildMaskData(),
                    regions: state.regions
                })
            });
            if (!response.ok) throw new Error(`请求失败（HTTP ${response.status}）`);

            const payload = await response.json();
            if (payload.status !== "success" || !payload.data?.result_url) {
                throw new Error(payload.message || "AI 未返回有效结果");
            }

            renderWatermarkRemovalResult(payload.data, state.sourceUrl);
            if (typeof saveToHistory === "function") {
                saveToHistory("watermark-removal", {
                    filename: state.filename,
                    result: payload.data
                });
            }
            if (typeof showToast === "function") showToast("水印消除完成", "success");
            setWatermarkRemovalBusy(false);
        } catch (error) {
            setWatermarkRemovalError(error.message || "处理失败，请稍后重试");
            if (typeof showToast === "function") showToast("水印消除失败", "error");
            setWatermarkRemovalBusy(false);
        }
    }

    function extensionForMimeType(mimeType) {
        const mapping = {
            "image/jpeg": "jpg",
            "image/png": "png",
            "image/webp": "webp"
        };
        return mapping[String(mimeType || "").toLowerCase()] || "png";
    }

    function safeDownloadStem(filename) {
        return String(filename || "image")
            .replace(/\.[^.]+$/, "")
            .replace(/[^\p{L}\p{N}_-]+/gu, "-")
            .replace(/^-+|-+$/g, "")
            || "image";
    }

    async function downloadWatermarkRemovalResult() {
        if (!state.result?.result_url) return;
        const resultUrl = state.result.result_url;
        const resultMimeType = state.result.result_mime_type;
        const filename = state.filename;
        const button = state.elements.download;
        button.disabled = true;

        try {
            const response = await fetch(assetUrl(resultUrl));
            if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`);
            const blob = await response.blob();
            const objectUrl = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            const extension = extensionForMimeType(resultMimeType);
            anchor.href = objectUrl;
            anchor.download = `${safeDownloadStem(filename)}-removed.${extension}`;
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            URL.revokeObjectURL(objectUrl);
        } catch (error) {
            setWatermarkRemovalError(error.message || "结果下载失败");
            if (typeof showToast === "function") showToast("结果下载失败", "error");
        } finally {
            button.disabled = false;
        }
    }

    async function restoreWatermarkRemovalHistory(result) {
        if (state.busy) return false;
        const validationError = historyResultValidationError(result);
        if (validationError) {
            setWatermarkRemovalError(validationError);
            return false;
        }

        try {
            setWatermarkRemovalBusy(true);
            const sourceUrl = assetUrl(result.source_url);
            const resultUrl = assetUrl(result.result_url);
            const sourceResponse = await fetch(sourceUrl);
            if (!sourceResponse.ok) throw new Error("历史原图读取失败");
            const sourceBlob = await sourceResponse.blob();
            const sourceData = await readBlobAsDataUrl(sourceBlob);
            const [sourceImage, resultImage] = await Promise.all([
                loadImageSource(sourceData),
                loadImageSource(resultUrl)
            ]);
            if (
                sourceImage.naturalWidth !== result.width
                || sourceImage.naturalHeight !== result.height
                || resultImage.naturalWidth !== result.width
                || resultImage.naturalHeight !== result.height
            ) {
                throw new Error("历史图片尺寸与记录不一致");
            }

            const restoredRegions = result.regions.map(region => ({ ...region }));
            const restoredResult = {
                ...result,
                regions: restoredRegions
            };
            if (state.sourceObjectUrl) {
                URL.revokeObjectURL(state.sourceObjectUrl);
            }
            closeResultPreview({ restoreFocus: false });
            state.filename = result.filename;
            state.imageData = sourceData;
            state.sourceUrl = sourceUrl;
            state.sourceObjectUrl = "";
            state.image = sourceImage;
            state.regions = restoredRegions;
            state.selectedIndex = state.regions.length ? 0 : -1;
            state.interaction = null;
            state.elements.upload.hidden = true;
            state.elements.workspace.hidden = false;
            state.elements.filename.textContent = result.filename;
            setWatermarkRemovalError("");
            renderWatermarkRemovalResult(restoredResult, sourceUrl);
            updateWatermarkRemovalControls();
            requestEditorRedraw();
            setWatermarkRemovalBusy(false);
            return true;
        } catch (error) {
            setWatermarkRemovalError(error.message || "历史记录恢复失败");
            setWatermarkRemovalBusy(false);
            return false;
        }
    }

    function initWatermarkRemoval() {
        if (!core) {
            console.error("WatermarkRemovalCore is unavailable");
            return;
        }
        if (state.initialized) {
            requestEditorRedraw();
            return;
        }

        cacheElements();
        if (!state.elements.canvas) return;
        state.initialized = true;

        state.elements.canvas.addEventListener("pointerdown", onEditorPointerDown);
        state.elements.canvas.addEventListener("pointermove", onEditorPointerMove);
        state.elements.canvas.addEventListener("pointerup", onEditorPointerUp);
        state.elements.canvas.addEventListener("pointercancel", onEditorPointerUp);
        state.elements.canvas.addEventListener("keydown", onEditorKeyDown);
        state.elements.replaceButton.addEventListener("click", () => {
            if (!state.busy) state.elements.fileInput.click();
        });
        state.elements.deleteButton.addEventListener("click", deleteSelectedRegion);
        state.elements.clearButton.addEventListener("click", clearWatermarkRegions);
        state.elements.resultImage.addEventListener("click", () => {
            openResultPreview(state.elements.resultImage);
        });
        state.elements.resultImage.addEventListener("keydown", event => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault?.();
                openResultPreview(state.elements.resultImage);
            }
        });
        state.elements.zoomButton.addEventListener("click", () => {
            openResultPreview(state.elements.zoomButton);
        });
        state.elements.resultImage.addEventListener("error", () => {
            if (!state.result?.result_url) return;
            resetResult();
            setWatermarkRemovalError("结果图片加载失败，请重新处理");
        });
        state.elements.previewImage.addEventListener("error", () => {
            if (state.elements.preview.hidden) return;
            resetResult();
            setWatermarkRemovalError("预览图片加载失败，请重新处理");
        });
        state.elements.previewClose.addEventListener("click", closeResultPreview);
        state.elements.preview.addEventListener("click", event => {
            if (event.target === state.elements.preview) closeResultPreview();
        });
        root.addEventListener("resize", requestEditorRedraw);
        root.addEventListener("keydown", event => {
            if (state.elements.preview.hidden) return;
            if (event.key === "Tab") {
                event.preventDefault?.();
                state.elements.previewClose.focus();
            } else if (event.key === "Escape") {
                closeResultPreview();
            }
        });

        if (typeof ResizeObserver === "function") {
            const observer = new ResizeObserver(requestEditorRedraw);
            observer.observe(state.elements.stage);
        }
        updateWatermarkRemovalControls();
    }

    root.initWatermarkRemoval = initWatermarkRemoval;
    root.handleWatermarkUpload = handleWatermarkUpload;
    root.submitWatermarkRemoval = submitWatermarkRemoval;
    root.downloadWatermarkRemovalResult = downloadWatermarkRemovalResult;
    root.restoreWatermarkRemovalHistory = restoreWatermarkRemovalHistory;
})(window);
