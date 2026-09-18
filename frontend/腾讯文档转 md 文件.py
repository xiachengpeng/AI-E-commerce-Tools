#!/usr/bin/env python3
"""Export a publicly viewable Tencent Docs word document to Markdown.

V1 scope:
- https://docs.qq.com/doc/... documents that can be opened without signing in
- text, basic inline formatting, headings, simple lists/tables
- image extraction, local download and reinsertion at source character positions

This script intentionally does not import browser cookies or log in to Tencent Docs.
"""

from __future__ import annotations

import argparse
import html as html_lib
import json
import mimetypes
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import parse_qs, urlparse

import requests


USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36"
)

TABLE_HEADER_START = "\x1a"
TABLE_CELL_SEP = "\x07"
TABLE_ROW_START = "\x06"
CODE_BLOCK_MARK = "\x1d"
CODE_INLINE_MARK = "\x1c"
HEADING_MARK = "\x08"


class TencentDocError(RuntimeError):
    pass


@dataclass
class ImageAnchor:
    pos: int
    url: str
    alt: str = "image"
    width: int | None = None
    height: int | None = None
    local_path: str | None = None

    @property
    def markdown_src(self) -> str:
        return self.local_path or self.url


@dataclass
class FetchResult:
    api_data: dict[str, Any]
    page_url: str
    page_html: str
    title: str


def parse_document_id(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or parsed.netloc.lower() != "docs.qq.com":
        raise ValueError("仅支持 docs.qq.com 的文档 URL")
    parts = [p for p in parsed.path.split("/") if p]
    if len(parts) < 2 or parts[0] != "doc" or not parts[1]:
        raise ValueError("目前只支持 https://docs.qq.com/doc/<文档ID> 格式")
    return parts[1]


def decode_opendoc_response(text: str) -> dict[str, Any]:
    """Decode direct JSON and Tencent's JSONP/string-wrapped JSON variants."""
    s = html_lib.unescape(text.lstrip("\ufeff").strip())
    if not s:
        raise ValueError("opendoc 返回空内容")

    def _loads(value: str) -> Any:
        obj = json.loads(value)
        # Some JSONP responses wrap the actual JSON as a JSON string.
        for _ in range(2):
            if isinstance(obj, str):
                obj = json.loads(html_lib.unescape(obj))
            else:
                break
        return obj

    try:
        obj = _loads(s)
    except json.JSONDecodeError:
        match = re.match(r"^[\w$.]+\s*\((.*)\)\s*;?\s*$", s, re.S)
        if not match:
            raise ValueError("无法解析 opendoc 响应：既不是 JSON 也不是 JSONP")
        obj = _loads(match.group(1).strip())

    if not isinstance(obj, dict):
        raise ValueError(f"opendoc 返回了非对象 JSON：{type(obj).__name__}")
    return obj


def _walk(obj: Any) -> Iterable[Any]:
    yield obj
    if isinstance(obj, dict):
        for value in obj.values():
            yield from _walk(value)
    elif isinstance(obj, list):
        for value in obj:
            yield from _walk(value)


def extract_mutations(api_data: dict[str, Any]) -> list[dict[str, Any]]:
    """Find the richest mutation list without hard-coding one Tencent schema revision."""
    candidates: list[tuple[int, list[dict[str, Any]]]] = []

    for node in _walk(api_data):
        if not isinstance(node, dict) or "mutations" not in node:
            continue
        mutations = node.get("mutations")
        if not isinstance(mutations, list) or not all(isinstance(x, dict) for x in mutations):
            continue
        raw_lengths = [len(x.get("s", "")) for x in mutations if isinstance(x.get("s"), str)]
        if not raw_lengths:
            continue
        score = max(raw_lengths) * 1000 + len(mutations)
        candidates.append((score, mutations))

    if not candidates:
        raise TencentDocError(
            "没有在 opendoc 数据中找到 mutations。腾讯文档的数据结构可能已变化，"
            "请加 --save-json 保存原始响应后再分析。"
        )
    candidates.sort(key=lambda x: x[0], reverse=True)
    return candidates[0][1]


def _prop_value(container: dict[str, Any], key: str) -> Any:
    value = container.get(key)
    if isinstance(value, dict) and "val" in value:
        return value.get("val")
    return value


def _heading_from_size(value: Any) -> int:
    try:
        size = float(value)
    except (TypeError, ValueError):
        return 0
    if size >= 480:
        return 1
    if size >= 360:
        return 2
    if size >= 300:
        return 3
    if size >= 260:
        return 4
    return 0


def _find_http_url(obj: Any) -> str | None:
    preferred_keys = ("embed", "url", "src", "source")
    if isinstance(obj, dict):
        for key in preferred_keys:
            value = obj.get(key)
            if isinstance(value, str) and value.startswith(("http://", "https://")):
                return value
        for value in obj.values():
            found = _find_http_url(value)
            if found:
                return found
    elif isinstance(obj, list):
        for value in obj:
            found = _find_http_url(value)
            if found:
                return found
    elif isinstance(obj, str) and obj.startswith(("http://", "https://")):
        return obj
    return None


def _find_description(obj: Any) -> str:
    preferred_keys = ("descr", "description", "alt", "title", "name")
    if isinstance(obj, dict):
        for key in preferred_keys:
            value = obj.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        for value in obj.values():
            found = _find_description(value)
            if found:
                return found
    elif isinstance(obj, list):
        for value in obj:
            found = _find_description(value)
            if found:
                return found
    return ""


def _dimensions_from_url(url: str) -> tuple[int | None, int | None]:
    query = parse_qs(urlparse(url).query)

    def one(name: str) -> int | None:
        try:
            return int(query[name][0]) if name in query and query[name] else None
        except (TypeError, ValueError):
            return None

    return one("w"), one("h")


def parse_mutations(
    mutations: list[dict[str, Any]],
) -> tuple[str, dict[int, dict[str, Any]], list[ImageAnchor]]:
    raw_candidates = [m.get("s") for m in mutations if isinstance(m.get("s"), str)]
    if not raw_candidates:
        raise TencentDocError("mutations 中没有正文字符串字段 s")
    raw_text = max(raw_candidates, key=len)

    formats: dict[int, dict[str, Any]] = {}
    images: list[ImageAnchor] = []

    def fmt_at(pos: int) -> dict[str, Any]:
        return formats.setdefault(
            pos,
            {"heading": 0, "bold": False, "italic": False, "strike": False, "code": False},
        )

    for mutation in mutations:
        if mutation.get("ty") != "mp" or not isinstance(mutation.get("pr"), dict):
            continue
        pr = mutation["pr"]
        try:
            bi = int(mutation.get("bi", 0) or 0)
            ei = int(mutation.get("ei", bi) or bi)
        except (TypeError, ValueError):
            continue

        run = pr.get("run")
        if isinstance(run, dict) and ei > bi:
            has_size = "sz" in run
            has_bold = "b" in run
            has_italic = "i" in run
            has_strike = "strike" in run
            has_bg = "bgclr" in run
            heading = _heading_from_size(_prop_value(run, "sz")) if has_size else 0
            bold = _prop_value(run, "b") is True
            italic = _prop_value(run, "i") is True
            strike = _prop_value(run, "strike") is True
            code = bool(_prop_value(run, "bgclr"))
            for pos in range(max(0, bi), min(len(raw_text), max(bi, ei))):
                fmt = fmt_at(pos)
                if has_size:
                    fmt["heading"] = heading
                if has_bold:
                    fmt["bold"] = bold
                if has_italic:
                    fmt["italic"] = italic
                if has_strike:
                    fmt["strike"] = strike
                if has_bg:
                    fmt["code"] = code

        drawing = pr.get("drawing")
        if drawing is not None:
            url = _find_http_url(drawing)
            if url:
                width, height = _dimensions_from_url(url)
                images.append(
                    ImageAnchor(
                        pos=max(0, bi),
                        url=url,
                        alt=_find_description(drawing) or "image",
                        width=width,
                        height=height,
                    )
                )

    images.sort(key=lambda img: img.pos)
    return raw_text, formats, images


def _normal_format(fmt: dict[str, Any] | None) -> dict[str, Any]:
    fmt = fmt or {}
    return {
        "heading": int(fmt.get("heading", 0) or 0),
        "bold": fmt.get("bold") is True,
        "italic": fmt.get("italic") is True,
        "strike": fmt.get("strike") is True,
        "code": fmt.get("code") is True,
    }


def _format_inline_segment(text: str, fmt: dict[str, Any]) -> str:
    if not text or not text.strip():
        return text
    out = text
    if fmt["code"]:
        out = "`" + out.replace("`", "\\`") + "`"
    if fmt["bold"]:
        out = f"**{out}**"
    if fmt["italic"]:
        out = f"*{out}*"
    if fmt["strike"]:
        out = f"~~{out}~~"
    return out


def _image_markdown(img: ImageAnchor) -> str:
    alt = (img.alt or "image").replace("[", "\\[").replace("]", "\\]")
    src = img.markdown_src.replace(" ", "%20")
    return f"![{alt}]({src})"


def _visible_plain(line: str) -> str:
    chars: list[str] = []
    for ch in line:
        code = ord(ch)
        if code < 32:
            if ch == "\t":
                chars.append(" ")
            continue
        chars.append(ch)
    return "".join(chars).strip()


def _process_links(text: str) -> str:
    # Tencent sometimes serializes link fields into the text stream as
    # "HYPERLINK <url> <display> ...".
    pattern = re.compile(r"HYPERLINK\s+(\S+)\s+(\S+)([^\[]*)")

    def repl(match: re.Match[str]) -> str:
        url = match.group(1)
        display = match.group(2)
        tail = match.group(3)
        urls = [url] + re.findall(r"https?://\S+", tail)
        link_url = urls[-1]
        shown = link_url if display == "normalLink" else display
        return f"[{shown}]({link_url})"

    result = pattern.sub(repl, text)
    if "](" not in result:
        result = re.sub(r"(https?://[^\s)]+)", r"[\1](\1)", result)
    return result


def _render_inline_line(
    line: str,
    line_start: int,
    formats: dict[int, dict[str, Any]],
    images_by_pos: dict[int, list[ImageAnchor]],
    *,
    block_images: bool = True,
) -> str:
    out: list[str] = []
    buffer: list[str] = []
    current_key: tuple[bool, bool, bool, bool] | None = None
    current_fmt = _normal_format(None)

    def flush() -> None:
        nonlocal buffer
        if buffer:
            out.append(_format_inline_segment("".join(buffer), current_fmt))
            buffer = []

    for rel in range(len(line) + 1):
        abs_pos = line_start + rel
        if abs_pos in images_by_pos:
            flush()
            for img in images_by_pos[abs_pos]:
                marker = _image_markdown(img)
                out.append(f"\n\n{marker}\n\n" if block_images else marker)

        if rel == len(line):
            break
        ch = line[rel]
        if ord(ch) < 32:
            if ch == "\t":
                buffer.append(" ")
            continue

        fmt = _normal_format(formats.get(abs_pos))
        key = (fmt["bold"], fmt["italic"], fmt["strike"], fmt["code"])
        if current_key is None:
            current_key = key
            current_fmt = fmt
        elif key != current_key:
            flush()
            current_key = key
            current_fmt = fmt
        buffer.append(ch)

    flush()
    return _process_links("".join(out)).strip()


def _line_heading(line: str, start: int, formats: dict[int, dict[str, Any]]) -> int:
    heading = 0
    for rel, ch in enumerate(line):
        if ord(ch) < 32:
            continue
        heading = max(heading, int(formats.get(start + rel, {}).get("heading", 0) or 0))
    return heading


def _normalize_list_spacing(text: str) -> str:
    return re.sub(r"^(\d+|[A-Za-z])\.(\S)", r"\1. \2", text)


def render_markdown(
    raw_text: str,
    formats: dict[int, dict[str, Any]],
    images: list[ImageAnchor],
    *,
    title: str,
) -> str:
    images_by_pos: dict[int, list[ImageAnchor]] = {}
    for image in images:
        images_by_pos.setdefault(image.pos, []).append(image)

    parts: list[str] = [f"# {title.strip() or '未命名文档'}\n\n"]
    table_rows: list[list[str]] = []
    in_table = False
    first_body_line = True

    def flush_table() -> None:
        nonlocal table_rows, in_table
        rows = [row for row in table_rows if any(cell.strip() for cell in row)]
        table_rows = []
        in_table = False
        if not rows:
            return
        cols = max(len(r) for r in rows)
        normalized = []
        for row in rows:
            row = row + [""] * (cols - len(row))
            normalized.append([c.replace("|", "\\|").replace("\n", " ").strip() for c in row])
        parts.append("| " + " | ".join(normalized[0]) + " |\n")
        parts.append("| " + " | ".join("---" for _ in range(cols)) + " |\n")
        for row in normalized[1:]:
            parts.append("| " + " | ".join(row) + " |\n")
        parts.append("\n")

    lines = raw_text.split("\r")
    char_pos = 0
    consumed_image_positions: set[int] = set()

    for index, line in enumerate(lines):
        line_start = char_pos
        line_end = line_start + len(line)
        for pos in images_by_pos:
            if line_start <= pos <= line_end:
                consumed_image_positions.add(pos)

        plain = _visible_plain(line)
        rendered = _render_inline_line(line, line_start, formats, images_by_pos, block_images=not in_table)

        # Tencent's table stream uses one line per cell with control-prefixes.
        if line.startswith(TABLE_HEADER_START):
            if in_table:
                flush_table()
            in_table = True
            cell = _render_inline_line(line[1:], line_start + 1, formats, images_by_pos, block_images=False)
            table_rows.append([cell])
        elif line.startswith(TABLE_CELL_SEP + TABLE_ROW_START):
            if not in_table:
                in_table = True
            cell = _render_inline_line(line[2:], line_start + 2, formats, images_by_pos, block_images=False)
            table_rows.append([cell])
        elif line.startswith(TABLE_CELL_SEP):
            if not in_table:
                in_table = True
                table_rows.append([])
            if not table_rows:
                table_rows.append([])
            cell = _render_inline_line(line[1:], line_start + 1, formats, images_by_pos, block_images=False)
            table_rows[-1].append(cell)
        else:
            if in_table:
                flush_table()

            if not plain and not rendered:
                if parts and not parts[-1].endswith("\n\n"):
                    parts.append("\n")
            else:
                # Avoid repeating a leading body title identical to the document title.
                if first_body_line and plain == title.strip():
                    first_body_line = False
                else:
                    first_body_line = False
                    heading = _line_heading(line, line_start, formats)
                    if heading:
                        parts.append(f"{'#' * heading} {rendered}\n\n")
                    elif re.match(r"^[•·▪◦●]\s*", plain):
                        cleaned = re.sub(r"^[•·▪◦●]\s*", "", rendered)
                        parts.append(f"- {cleaned}\n")
                    elif re.match(r"^(\d+|[A-Za-z])\.", plain):
                        parts.append(_normalize_list_spacing(rendered) + "\n")
                    else:
                        parts.append(rendered + "\n\n")

        char_pos += len(line)
        if index < len(lines) - 1:
            # A \r separator occupies one character in Tencent's source positions.
            if char_pos in images_by_pos and char_pos not in consumed_image_positions:
                if in_table:
                    flush_table()
                for img in images_by_pos[char_pos]:
                    parts.append(_image_markdown(img) + "\n\n")
                consumed_image_positions.add(char_pos)
            char_pos += 1

    if in_table:
        flush_table()

    # Preserve any anchors that Tencent reports after the final text offset.
    for pos in sorted(images_by_pos):
        if pos not in consumed_image_positions:
            for img in images_by_pos[pos]:
                parts.append(_image_markdown(img) + "\n\n")

    md = "".join(parts)
    md = re.sub(r"\n{3,}", "\n\n", md).strip() + "\n"
    return md


def sanitize_filename(name: str) -> str:
    safe = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", (name or "未命名文档").strip())
    safe = safe.strip(" .")[:120]
    return safe or "未命名文档"


def extract_html_title(page_html: str) -> str:
    match = re.search(r"<title[^>]*>(.*?)</title>", page_html, re.I | re.S)
    if not match:
        return ""
    title = html_lib.unescape(re.sub(r"<[^>]+>", "", match.group(1))).strip()
    # Common Tencent suffixes are cosmetic and not the document title.
    title = re.sub(r"\s*[-—|]\s*腾讯文档\s*$", "", title).strip()
    return title


def extract_scode(page_url: str, page_html: str) -> str | None:
    query = parse_qs(urlparse(page_url).query)
    if query.get("scode"):
        return query["scode"][0]
    patterns = [
        r"[?&]scode=([^&\"'<>]+)",
        r'[\"\']scode[\"\']\s*:\s*[\"\']([^\"\']+)',
    ]
    for pattern in patterns:
        match = re.search(pattern, page_html)
        if match:
            return html_lib.unescape(match.group(1))
    return None



def extract_request_timestamp(page_html: str) -> str | None:
    """Extract Tencent's page request timestamp when present."""
    match = re.search(r"(?:[?&]|&amp;)t=(\d{10,16})(?=[&\"'<>]|$)", page_html)
    return match.group(1) if match else None


def choose_image_extension(url: str, content_type: str | None = None) -> str:
    if content_type:
        mime = content_type.split(";", 1)[0].strip().lower()
        mapping = {
            "image/jpeg": ".jpg",
            "image/png": ".png",
            "image/gif": ".gif",
            "image/webp": ".webp",
            "image/svg+xml": ".svg",
            "image/bmp": ".bmp",
        }
        if mime in mapping:
            return mapping[mime]
        guessed = mimetypes.guess_extension(mime)
        if guessed:
            return ".jpg" if guessed == ".jpe" else guessed
    suffix = Path(urlparse(url).path).suffix.lower()
    if suffix in {".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".bmp"}:
        return ".jpg" if suffix == ".jpeg" else suffix
    match = re.search(r"(?:[?&](?:type|fmt|format)=)(?:image/)?([a-zA-Z0-9.+-]+)", url)
    if match:
        ext = match.group(1).lower().replace("jpeg", "jpg")
        if ext in {"jpg", "png", "gif", "webp", "svg", "bmp"}:
            return "." + ext
    return ".png"


class TencentDocClient:
    def __init__(self, timeout: int = 30) -> None:
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update(
            {
                "User-Agent": USER_AGENT,
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            }
        )

    def fetch(self, url: str) -> FetchResult:
        doc_id = parse_document_id(url)
        page = self.session.get(url, timeout=self.timeout, allow_redirects=True)
        if page.status_code >= 400:
            raise TencentDocError(f"打开文档页面失败：HTTP {page.status_code}")

        page_html = page.text
        page_url = page.url
        scode = extract_scode(page_url, page_html)
        title = extract_html_title(page_html)

        base_params: dict[str, str] = {
            "id": doc_id,
            "normal": "1",
            "outformat": "1",
            "noEscape": "1",
            "preview_token": "",
            "doc_chunk_flag": "1",
            "wb": "1",
            "nowb": "0",
            "u": "",
            "t": extract_request_timestamp(page_html) or str(int(time.time() * 1000)),
        }
        if scode:
            base_params["scode"] = scode

        headers = {
            "Referer": page_url,
            "Origin": "https://docs.qq.com",
            "Accept": "application/json,text/plain,*/*",
        }
        api_url = "https://docs.qq.com/dop-api/opendoc"
        attempts: list[str] = []

        # Different Tencent deployments have alternated between direct JSON and JSONP.
        variants = [
            {},
            {"callback": "clientVarsCallback"},
        ]
        # If a page surfaced scode, try it first but also try the public-ID form.
        param_sets = [base_params]
        if scode:
            without_scode = dict(base_params)
            without_scode.pop("scode", None)
            param_sets.append(without_scode)

        for params in param_sets:
            for extra in variants:
                request_params = dict(params)
                request_params.update(extra)
                try:
                    response = self.session.get(
                        api_url,
                        params=request_params,
                        headers=headers,
                        timeout=self.timeout,
                    )
                except requests.RequestException as exc:
                    attempts.append(f"network error: {exc}")
                    continue

                preview = response.text[:160].replace("\n", " ").replace("\r", " ")
                attempts.append(f"HTTP {response.status_code}: {preview}")
                if response.status_code >= 400 or not response.text.strip():
                    continue
                try:
                    data = decode_opendoc_response(response.text)
                except (ValueError, json.JSONDecodeError):
                    continue
                if isinstance(data.get("clientVars"), dict):
                    api_title = str(data.get("clientVars", {}).get("title") or "").strip()
                    return FetchResult(
                        api_data=data,
                        page_url=page_url,
                        page_html=page_html,
                        title=api_title or title or doc_id,
                    )

        detail = "\n  - ".join(attempts[-4:])
        raise TencentDocError(
            "文档页面可以打开，但 opendoc 数据接口没有返回可解析的公开文档数据。\n"
            "这通常表示腾讯调整了匿名访问接口，或该链接实际需要登录态。\n"
            f"最近的请求结果：\n  - {detail}"
        )


def download_images(
    images: list[ImageAnchor],
    *,
    session: requests.Session,
    output_dir: Path,
    referer: str,
    timeout: int = 30,
) -> list[str]:
    warnings: list[str] = []
    if not images:
        return warnings

    image_dir = output_dir / "images"
    image_dir.mkdir(parents=True, exist_ok=True)
    headers = {"Referer": referer, "User-Agent": USER_AGENT}

    # Preserve anchor order even when multiple images share one position.
    for index, image in enumerate(images, start=1):
        try:
            response = session.get(image.url, headers=headers, timeout=timeout)
            response.raise_for_status()
            ext = choose_image_extension(image.url, response.headers.get("Content-Type"))
            filename = f"image_{index:03d}{ext}"
            path = image_dir / filename
            path.write_bytes(response.content)
            image.local_path = f"images/{filename}"
        except requests.RequestException as exc:
            warnings.append(f"图片 {index} 下载失败，将保留远程链接：{exc}")
        except OSError as exc:
            warnings.append(f"图片 {index} 保存失败，将保留远程链接：{exc}")
    return warnings


def convert_url(
    url: str,
    *,
    output_dir: Path | None = None,
    save_json: bool = False,
    timeout: int = 30,
) -> Path:
    client = TencentDocClient(timeout=timeout)
    fetched = client.fetch(url)
    mutations = extract_mutations(fetched.api_data)
    raw_text, formats, images = parse_mutations(mutations)

    title = fetched.title or parse_document_id(url)
    safe_title = sanitize_filename(title)
    destination = output_dir.expanduser() if output_dir else Path.cwd() / safe_title
    destination.mkdir(parents=True, exist_ok=True)

    warnings = download_images(
        images,
        session=client.session,
        output_dir=destination,
        referer=fetched.page_url,
        timeout=timeout,
    )

    markdown = render_markdown(raw_text, formats, images, title=title)
    md_path = destination / f"{safe_title}.md"
    md_path.write_text(markdown, encoding="utf-8")

    if save_json:
        (destination / "opendoc.json").write_text(
            json.dumps(fetched.api_data, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    for warning in warnings:
        print(f"警告: {warning}", file=sys.stderr)
    return md_path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="将无需登录即可查看的腾讯文档转换为 Markdown，并把图片下载到本地。"
    )
    parser.add_argument("url", help="例如 https://docs.qq.com/doc/DSWlwRkZXdFdWWXlG")
    parser.add_argument(
        "-o",
        "--output-dir",
        type=Path,
        help="输出目录；默认在当前目录按文档标题创建文件夹",
    )
    parser.add_argument(
        "--save-json",
        action="store_true",
        help="同时保存 opendoc.json，便于腾讯接口变化时排查",
    )
    parser.add_argument("--timeout", type=int, default=30, help="网络超时秒数，默认 30")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        path = convert_url(
            args.url,
            output_dir=args.output_dir,
            save_json=args.save_json,
            timeout=args.timeout,
        )
    except (ValueError, TencentDocError, requests.RequestException, OSError) as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 1

    print(f"完成: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
