#!/usr/bin/env python3
"""Nebulove 字体子集化"""
import base64
from html.parser import HTMLParser
import os
import re
import sys
import tempfile
import urllib.request

# 子集化用的完整字体来源
FONT_URL = "https://raw.githubusercontent.com/lingyicute/Nebulove/main/Nebulove.ttf"
# 仓库根目录的 index.html（无论从哪里运行脚本都能定位）
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX_PATH = os.path.join(REPO_ROOT, "index.html")

_REGEX_PREV = set("(,=:[!&|?{};\n")


def _strip_css_comments(css):
    out, i, n = [], 0, len(css)
    while i < n:
        c = css[i]
        if c in ('"', "'"):
            out.append(c)
            i += 1
            while i < n:
                if css[i] == "\\" and i + 1 < n:
                    out.append(css[i:i + 2])
                    i += 2
                elif css[i] == c:
                    out.append(c)
                    i += 1
                    break
                else:
                    out.append(css[i])
                    i += 1
        elif css[i:i + 2] == "/*":
            end = css.find("*/", i + 2)
            i = n if end == -1 else end + 2
        else:
            out.append(c)
            i += 1
    return "".join(out)


def _extract_js_strings(code):
    out, i, n = [], 0, len(code)
    prev = ""
    while i < n:
        c = code[i]
        if c in ('"', "'", "`"):
            i += 1
            while i < n:
                if code[i] == "\\" and i + 1 < n:
                    out.append(code[i:i + 2])
                    i += 2
                elif code[i] == c:
                    i += 1
                    break
                else:
                    out.append(code[i])
                    i += 1
            prev = c
        elif code[i:i + 2] == "//":
            end = code.find("\n", i + 2)
            i = n if end == -1 else end + 1
        elif code[i:i + 2] == "/*":
            end = code.find("*/", i + 2)
            i = n if end == -1 else end + 2
        elif c == "/" and (not prev or prev in _REGEX_PREV):
            i += 1
            in_class = False
            while i < n:
                if code[i] == "\\" and i + 1 < n:
                    i += 2
                elif code[i] == "[":
                    in_class = True
                    i += 1
                elif code[i] == "]":
                    in_class = False
                    i += 1
                elif code[i] == "/" and not in_class:
                    i += 1
                    break
                else:
                    i += 1
            prev = "/"
        else:
            if not c.isspace():
                prev = c
            i += 1
    return "".join(out)


def collect_chars(html):
    # 先去掉上一轮内嵌的 data URI，避免无意义的大串扫描；
    # 解析 HTML 以自动忽略 HTML 注释、解码字符实体，并过滤 CSS/JS 注释中的未渲染字符。
    cleaned = re.sub(r"data:font/woff2[^\"'\)]*", "", html)
    parts = []

    class _Collector(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=True)
            self.tag = None

        def handle_starttag(self, tag, attrs):
            self.tag = tag.lower()
            for key, val in attrs:
                if val and key in ("title", "placeholder", "alt"):
                    parts.append(val)

        def handle_endtag(self, tag):
            self.tag = None

        def handle_data(self, data):
            if self.tag == "style":
                parts.append(_strip_css_comments(data))
            elif self.tag == "script":
                parts.append(_extract_js_strings(data))
            else:
                parts.append(data)

    parser = _Collector()
    parser.feed(cleaned)
    parser.close()

    chars = set("".join(parts))
    # 补全 ASCII 可打印字符（32-126）：覆盖英文输入、代码、标点
    for c in range(32, 127):
        chars.add(chr(c))
    # 常用中文标点
    chars.update(['：', '，', '。', '！', '？', '；', '“', '”', '‘', '’', '（', '）', '【', '】', '—', '…', '·', '《', '》', '×', '＝', '÷', '＋', '－'])
    return chars


def main():
    if not os.path.exists(INDEX_PATH):
        print(f"Error: {INDEX_PATH} not found.", file=sys.stderr)
        sys.exit(1)

    print(f"Reading {INDEX_PATH}...")
    with open(INDEX_PATH, "r", encoding="utf-8") as f:
        html = f.read()

    # 1. 收集实际会渲染的所需字符
    chars = collect_chars(html)

    print(f"Total unique characters needed: {len(chars)}")

    with tempfile.TemporaryDirectory(prefix="nebulove-subset-") as tmp_dir:
        tmp_font_path = os.path.join(tmp_dir, "Nebulove.ttf")
        tmp_woff2_path = os.path.join(tmp_dir, "Nebulove-Subset.woff2")

        # 2. 下载完整 Nebulove 字体
        print(f"Downloading font from {FONT_URL}...")
        try:
            # 设置超时，避免网络半开时任务一直挂起直到 CI 被强制终止。
            with urllib.request.urlopen(FONT_URL, timeout=60) as resp, open(tmp_font_path, "wb") as out:
                out.write(resp.read())
        except Exception as e:
            print(f"Failed to download font: {e}", file=sys.stderr)
            sys.exit(1)

        # 3. 用 fontTools 子集化
        from fontTools.ttLib import TTFont
        from fontTools.subset import Subsetter, Options

        print("Subsetting font...")
        # 不重写 head.modified：否则每次运行的字体字节都不同，CI 会反复提交内容未变的子集。
        font = TTFont(tmp_font_path, recalcTimestamp=False)
        subsetter = Subsetter(options=Options())
        subsetter.populate(text="".join(sorted(chars)))
        subsetter.subset(font)

        font.flavor = "woff2"
        font.save(tmp_woff2_path)

        woff2_size = os.path.getsize(tmp_woff2_path)
        print(f"Subsetted WOFF2 size: {woff2_size} bytes ({woff2_size / 1024:.2f} KB)")

        # 4. 转 base64
        with open(tmp_woff2_path, "rb") as f:
            b64_font = base64.b64encode(f.read()).decode("utf-8")

    # 5. 替换 index.html 中的 @font-face（保留原有缩进风格）
    # 只保留内嵌 data URI：远程回退一旦被 CSP 拦截只会产生控制台噪音，
    # 且会在"完全离线、零第三方请求"的承诺上留下缺口。
    font_css_template = (
        '@font-face{\n'
        '    font-family:"Nebulove";\n'
        f'    src:url("data:font/woff2;charset=utf-8;base64,{b64_font}") format("woff2");\n'
        '    font-display:swap;\n'
        '}'
    )

    m = re.search(r"^([ \t]*)@font-face\s*\{[^}]*\}", html, flags=re.DOTALL | re.MULTILINE)
    if not m:
        print("Error: no @font-face block found in index.html.", file=sys.stderr)
        sys.exit(1)
    indent = m.group(1)
    font_css = "\n".join(indent + line if line else line for line in font_css_template.split("\n"))
    new_html = html[:m.start()] + font_css + html[m.end():]

    if new_html == html:
        print("index.html is already up to date. No changes made.")
        return

    with open(INDEX_PATH, "w", encoding="utf-8") as f:
        f.write(new_html)

    print("index.html updated successfully!")


if __name__ == "__main__":
    main()
