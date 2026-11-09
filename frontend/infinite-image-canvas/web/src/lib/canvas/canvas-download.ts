export async function downloadCanvasFile(
    url: string,
    filename: string,
    save: (blob: Blob, filename: string) => void,
    fetcher: typeof fetch = fetch,
) {
    const response = await fetcher(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    if (!blob.size) throw new Error("图片内容为空");
    save(blob, filename);
}
