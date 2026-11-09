import { expect, test } from "bun:test";

import { downloadCanvasFile } from "../src/lib/canvas/canvas-download";

test("downloads fetched canvas assets as blobs", async () => {
    const saved: Array<{ blob: Blob; filename: string }> = [];
    const payload = new Blob(["image-data"], { type: "image/png" });

    await downloadCanvasFile(
        "http://127.0.0.1:9503/api/canvas/assets/image-id",
        "canvas-image.png",
        (blob, filename) => saved.push({ blob, filename }),
        async () => new Response(payload, { status: 200 }),
    );

    expect(saved).toHaveLength(1);
    expect(saved[0].filename).toBe("canvas-image.png");
    expect(await saved[0].blob.text()).toBe("image-data");
});

test("surfaces failed asset responses instead of silently doing nothing", async () => {
    let saved = false;
    await expect(
        downloadCanvasFile(
            "http://127.0.0.1:9503/api/canvas/assets/missing",
            "canvas-image.png",
            () => { saved = true; },
            async () => new Response("missing", { status: 404 }),
        ),
    ).rejects.toThrow("HTTP 404");
    expect(saved).toBe(false);
});
