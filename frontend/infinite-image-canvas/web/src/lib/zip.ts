import { Unzip, UnzipInflate, zipSync } from "fflate";

type ZipFile = {
    name: string;
    data: BlobPart;
};

export async function createZip(files: ZipFile[]) {
    const entries = await Promise.all(
        files.map(async (file) => {
            const data = new Uint8Array(await new Blob([file.data]).arrayBuffer());
            return [file.name, data] as const;
        }),
    );
    return new Blob([zipSync(Object.fromEntries(entries), { level: 0 })], { type: "application/zip" });
}

export async function readZip(file: Blob) {
    if (file.size > 100_000_000) throw new Error("压缩文件过大");
    const entries = new Map<string, Blob>();
    let total = 0, count = 0;
    const unzip = new Unzip((entry) => {
        if (++count > 1000 || entries.has(entry.name)) throw new Error("压缩文件条目无效或过多");
        const limit = entry.name === "projects.json" ? 5_000_000 : 25_000_000;
        if (entry.originalSize !== undefined && entry.originalSize > limit) throw new Error("压缩文件中的单个文件过大");
        const chunks: Uint8Array[] = [];
        let size = 0;
        entries.set(entry.name, new Blob());
        entry.ondata = (error, chunk, final) => {
            if (error) throw error;
            size += chunk.length;
            total += chunk.length;
            if (size > limit || total > 100_000_000) throw new Error("压缩文件解压后过大");
            chunks.push(chunk);
            if (final) entries.set(entry.name, new Blob(chunks as BlobPart[]));
        };
        entry.start();
    });
    unzip.register(UnzipInflate);
    const bytes = new Uint8Array(await file.arrayBuffer());
    for (let offset = 0; offset < bytes.length; offset += 16_384) {
        unzip.push(bytes.subarray(offset, offset + 16_384), offset + 16_384 >= bytes.length);
    }
    if (!bytes.length) throw new Error("压缩文件为空");
    return entries;
}
