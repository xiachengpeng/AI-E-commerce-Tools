(function (root) {
    "use strict";

    function clamp(value, minimum, maximum) {
        return Math.min(Math.max(value, minimum), maximum);
    }

    function stableNumber(value) {
        return Number(value.toFixed(12));
    }

    function normalizedBounds(region) {
        const x = clamp(region.x, 0, 1);
        const y = clamp(region.y, 0, 1);
        return {
            x,
            y,
            right: clamp(region.x + region.width, x, 1),
            bottom: clamp(region.y + region.height, y, 1)
        };
    }

    function normalizeRegion(rect, imageRect) {
        const left = clamp(rect.left, imageRect.left, imageRect.left + imageRect.width);
        const top = clamp(rect.top, imageRect.top, imageRect.top + imageRect.height);
        const right = clamp(rect.left + rect.width, left, imageRect.left + imageRect.width);
        const bottom = clamp(rect.top + rect.height, top, imageRect.top + imageRect.height);

        return {
            x: stableNumber((left - imageRect.left) / imageRect.width),
            y: stableNumber((top - imageRect.top) / imageRect.height),
            width: stableNumber((right - left) / imageRect.width),
            height: stableNumber((bottom - top) / imageRect.height)
        };
    }

    function denormalizeRegion(region, imageRect) {
        const bounds = normalizedBounds(region);
        return {
            left: stableNumber(imageRect.left + bounds.x * imageRect.width),
            top: stableNumber(imageRect.top + bounds.y * imageRect.height),
            width: stableNumber((bounds.right - bounds.x) * imageRect.width),
            height: stableNumber((bounds.bottom - bounds.y) * imageRect.height)
        };
    }

    function canSubmitRemoval(state) {
        return Boolean(state && state.hasImage && state.regions && state.regions.length && !state.busy);
    }

    function renderMask(ctx, imageWidth, imageHeight, regions) {
        ctx.fillStyle = "black";
        ctx.fillRect(0, 0, imageWidth, imageHeight);
        ctx.fillStyle = "white";

        regions.forEach(region => {
            const bounds = normalizedBounds(region);
            const left = Math.floor(bounds.x * imageWidth);
            const top = Math.floor(bounds.y * imageHeight);
            const right = Math.ceil(bounds.right * imageWidth);
            const bottom = Math.ceil(bounds.bottom * imageHeight);
            ctx.fillRect(left, top, right - left, bottom - top);
        });
    }

    const api = { normalizeRegion, denormalizeRegion, canSubmitRemoval, renderMask };

    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.WatermarkRemovalCore = api;
    }
})(typeof window !== "undefined" ? window : null);
