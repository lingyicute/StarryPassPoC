#!/usr/bin/env python3
"""Nebulove 字体子集化"""
import base64
import os
import re
import sys
import urllib.request

# 子集化用的完整字体来源
FONT_URL = "https://raw.githubusercontent.com/lingyicute/Nebulove/main/Nebulove.ttf"
# 远程回退：保留 StarryPass 原有 CDN，另加 jsDelivr TTF 兜底
# 注意：@font-face 的多 src 是“加载失败”回退，不是按字形回退；
# 缺字形会走到 font-family 栈的系统字体。
FALLBACK_WOFF2 = "https://nebulove.92li.uk/Nebulove.woff2"
FALLBACK_TTF = "https://cdn.jsdelivr.net/gh/lingyicute/Nebulove@main/Nebulove.ttf"

# 仓库根目录的 index.html（无论从哪里运行脚本都能定位）
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX_PATH = os.path.join(REPO_ROOT, "index.html")
TMP_FONT_PATH = "/tmp/Nebulove.ttf"
TMP_WOFF2_PATH = "/tmp/Nebulove-Subset.woff2"


def main():
    if not os.path.exists(INDEX_PATH):
        print(f"Error: {INDEX_PATH} not found.", file=sys.stderr)
        sys.exit(1)

    print(f"Reading {INDEX_PATH}...")
    with open(INDEX_PATH, "r", encoding="utf-8") as f:
        html = f.read()

    # 1. 收集所需字符（先去掉上一轮内嵌的 data URI，避免无意义的大串扫描；
    #    base64 字符本就属于 ASCII 子集，不影响结果）
    html_for_chars = re.sub(r"data:font/woff2[^\"'\)]*", "", html)
    chars = set(html_for_chars)
    # 补全 ASCII 可打印字符（32-126）：覆盖英文输入、代码、标点
    for c in range(32, 127):
        chars.add(chr(c))
    # 常用中文标点（与 92li 一致）
    chars.update(['：', '，', '。', '！', '？', '；', '“', '”', '‘', '’', '（', '）', '【', '】', '—', '…', '·', '《', '》', '×', '＝', '÷', '＋', '－'])

    print(f"Total unique characters needed: {len(chars)}")

    # 2. 下载完整 Nebulove 字体
    print(f"Downloading font from {FONT_URL}...")
    try:
        urllib.request.urlretrieve(FONT_URL, TMP_FONT_PATH)
    except Exception as e:
        print(f"Failed to download font: {e}", file=sys.stderr)
        sys.exit(1)

    # 3. 用 fontTools 子集化
    from fontTools.ttLib import TTFont
    from fontTools.subset import Subsetter, Options

    print("Subsetting font...")
    font = TTFont(TMP_FONT_PATH)
    subsetter = Subsetter(options=Options())
    subsetter.populate(text="".join(chars))
    subsetter.subset(font)

    font.flavor = "woff2"
    font.save(TMP_WOFF2_PATH)

    woff2_size = os.path.getsize(TMP_WOFF2_PATH)
    print(f"Subsetted WOFF2 size: {woff2_size} bytes ({woff2_size / 1024:.2f} KB)")

    # 4. 转 base64
    with open(TMP_WOFF2_PATH, "rb") as f:
        b64_font = base64.b64encode(f.read()).decode("utf-8")

    # 5. 替换 index.html 中的 @font-face（保留原有缩进风格）
    font_css_template = (
        '@font-face{\n'
        '    font-family:"Nebulove";\n'
        f'    src:url("data:font/woff2;charset=utf-8;base64,{b64_font}") format("woff2"),\n'
        f'        url("{FALLBACK_WOFF2}") format("woff2"),\n'
        f'        url("{FALLBACK_TTF}") format("truetype");\n'
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
