#!/usr/bin/env python3
"""Nebulove 字体子集化"""
import base64
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
    # 常用中文标点
    chars.update(['：', '，', '。', '！', '？', '；', '“', '”', '‘', '’', '（', '）', '【', '】', '—', '…', '·', '《', '》', '×', '＝', '÷', '＋', '－'])

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
