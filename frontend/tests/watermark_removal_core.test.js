const assert = require("node:assert/strict");
const test = require("node:test");

const core = require("../js/watermark_removal_core.js");

function fakeMaskContext(calls) {
    let fillStyle = "";
    return {
        set fillStyle(value) {
            fillStyle = value;
            calls.push(["fillStyle", value]);
        },
        get fillStyle() {
            return fillStyle;
        },
        fillRect(...values) {
            calls.push(["fillRect", ...values]);
        }
    };
}

test("normalizes a rectangle against displayed image bounds", () => {
    assert.deepEqual(
        core.normalizeRegion(
            { left: 30, top: 40, width: 50, height: 20 },
            { left: 10, top: 20, width: 200, height: 100 }
        ),
        { x: 0.1, y: 0.2, width: 0.25, height: 0.2 }
    );
});

test("normalization clips a rectangle to the image bounds", () => {
    assert.deepEqual(
        core.normalizeRegion(
            { left: -10, top: 80, width: 80, height: 80 },
            { left: 10, top: 20, width: 200, height: 100 }
        ),
        { x: 0, y: 0.6, width: 0.3, height: 0.4 }
    );
});

test("denormalizes a region into displayed image coordinates", () => {
    assert.deepEqual(
        core.denormalizeRegion(
            { x: 0.1, y: 0.2, width: 0.25, height: 0.2 },
            { left: 10, top: 20, width: 200, height: 100 }
        ),
        { left: 30, top: 40, width: 50, height: 20 }
    );
});

test("submit requires image, region, and idle state", () => {
    assert.equal(core.canSubmitRemoval({ hasImage: true, regions: [{}], busy: false }), true);
    assert.equal(core.canSubmitRemoval({ hasImage: true, regions: [], busy: false }), false);
    assert.equal(core.canSubmitRemoval({ hasImage: true, regions: [{}], busy: true }), false);
});

test("renders every region as a white rectangle", () => {
    const calls = [];
    const ctx = fakeMaskContext(calls);
    core.renderMask(ctx, 100, 50, [
        { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
        { x: 0.7, y: 0.1, width: 0.2, height: 0.2 },
    ]);

    assert.deepEqual(calls.filter(call => call[0] === "fillRect"), [
        ["fillRect", 0, 0, 100, 50],
        ["fillRect", 10, 10, 30, 21],
        ["fillRect", 70, 5, 20, 11],
    ]);
    assert.deepEqual(calls.filter(call => call[0] === "fillStyle"), [
        ["fillStyle", "black"],
        ["fillStyle", "white"],
    ]);
});

test("mask preserves the backend ceil result for floating-point region ends", () => {
    const calls = [];
    core.renderMask(fakeMaskContext(calls), 100, 100, [
        { x: 0.1, y: 0, width: 0.2, height: 0.1 },
    ]);

    assert.deepEqual(calls.filter(call => call[0] === "fillRect").at(-1), [
        "fillRect", 10, 0, 21, 10
    ]);
});

test("mask uses floor start and ceil end pixel boundaries", () => {
    const calls = [];
    core.renderMask(fakeMaskContext(calls), 100, 100, [
        { x: 0.103, y: 0.207, width: 0.201, height: 0.201 },
    ]);

    assert.deepEqual(calls.filter(call => call[0] === "fillRect").at(-1), [
        "fillRect", 10, 20, 21, 21
    ]);
});
