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

_JS_LINE_TERMINATOR = re.compile(r"[\r\n\u2028\u2029]")
_REGEX_PREV = set("(,=:[!&|?{};+-*%^~<>")
_CONTROL_HEADS = frozenset({"if", "while", "for", "with", "switch", "catch"})
_REGEX_KEYWORDS = frozenset({
    "return", "case", "throw", "in", "of", "typeof", "void", "delete",
    "yield", "await", "new", "else", "do",
})


_CSS_HEX_ESCAPE = re.compile(r"\\([0-9a-fA-F]{1,6})(?:\r\n|[ \t\r\n\f])?")


def _read_css_escape(css, pos):
    # CSS 字符串转义（如 content:"\25BE"）渲染的是解码后的字符，而非反斜杠与十六进制数字。
    match = _CSS_HEX_ESCAPE.match(css, pos)
    if match:
        value = int(match.group(1), 16)
        if value == 0 or value > 0x10FFFF or 0xD800 <= value <= 0xDFFF:
            # 收集浏览器实际渲染的 U+FFFD，而非原无效码点。
            return "\ufffd", match.end()
        return chr(value), match.end()
    if css.startswith("\r\n", pos + 1):
        return "", pos + 3
    if css[pos + 1] in "\n\r\f":
        return "", pos + 2  # 字符串内的续行不产生字符
    return css[pos + 1], pos + 2


def _strip_css_comments(css):
    out, i, n = [], 0, len(css)
    while i < n:
        c = css[i]
        if c in ('"', "'"):
            out.append(c)
            i += 1
            while i < n:
                if css[i] == "\\" and i + 1 < n:
                    decoded, i = _read_css_escape(css, i)
                    out.append(decoded)
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



_JS_CHAR_ESCAPE = re.compile(r"\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2}))")


def _read_js_escape(code, pos):
    match = _JS_CHAR_ESCAPE.match(code, pos)
    if not match:
        return code[pos:pos + 2], pos + 2
    value = int(next(group for group in match.groups() if group is not None), 16)
    end = match.end()
    if 0xD800 <= value <= 0xDBFF:
        following = _JS_CHAR_ESCAPE.match(code, end)
        if following:
            low = int(next(group for group in following.groups() if group is not None), 16)
            if 0xDC00 <= low <= 0xDFFF:
                return chr(0x10000 + ((value - 0xD800) << 10) + low - 0xDC00), following.end()
    if value > 0x10FFFF or 0xD800 <= value <= 0xDFFF:
        # Invalid/unpaired scalar values have no usable cmap entry.
        return "", end
    return chr(value), end


def _regex_literal_end(code, pos):
    i, n = pos + 1, len(code)
    in_class = False
    while i < n:
        c = code[i]
        if _JS_LINE_TERMINATOR.match(code, i):
            break
        if c == "\\":
            if i + 1 == n or _JS_LINE_TERMINATOR.match(code, i + 1):
                break
            i += 2
            continue
        if c == "[":
            in_class = True
        elif c == "]":
            in_class = False
        elif c == "/" and not in_class:
            return i + 1
        i += 1
    return None


def _extract_js_strings(code):
    out, i, n = [], 0, len(code)
    prev, prev_word = "", ""
    tpl_braces = []
    control_parens = []

    def scan_template(pos):
        while pos < n:
            if code[pos] == "\\" and pos + 1 < n:
                decoded, pos = _read_js_escape(code, pos)
                out.append(decoded)
            elif code[pos:pos + 2] == "${":
                tpl_braces.append(0)
                return pos + 2, "{", ""
            elif code[pos] == "`":
                return pos + 1, "`", ""
            else:
                out.append(code[pos])
                pos += 1
        return pos, "`", ""

    while i < n:
        c = code[i]
        if c in ('"', "'"):
            i += 1
            while i < n:
                if code[i] == "\\" and i + 1 < n:
                    decoded, i = _read_js_escape(code, i)
                    out.append(decoded)
                elif code[i] == c:
                    i += 1
                    break
                else:
                    out.append(code[i])
                    i += 1
            prev, prev_word = c, ""
        elif c == "`":
            i, prev, prev_word = scan_template(i + 1)
        elif c == "{" and tpl_braces:
            tpl_braces[-1] += 1
            prev, prev_word = "{", ""
            i += 1
        elif c == "}" and tpl_braces:
            if tpl_braces[-1] == 0:
                tpl_braces.pop()
                i, prev, prev_word = scan_template(i + 1)
            else:
                tpl_braces[-1] -= 1
                prev, prev_word = "}", ""
                i += 1
        elif code[i:i + 2] == "//":
            end = _JS_LINE_TERMINATOR.search(code, i + 2)
            i = end.end() if end else n
        elif code[i:i + 2] == "/*":
            end = code.find("*/", i + 2)
            i = n if end == -1 else end + 2
        elif c == "(":
            control_parens.append(prev_word in _CONTROL_HEADS)
            prev, prev_word = "(", ""
            i += 1
        elif c == ")":
            # A control head ends before a statement; a call/group ends an expression.
            prev = "control-head" if control_parens and control_parens.pop() else ")"
            prev_word = ""
            i += 1
        elif c == "/" and (not prev or prev == "control-head" or prev in _REGEX_PREV or prev_word in _REGEX_KEYWORDS):
            # A slash after a brace may be division. Don't consume later
            # literals unless we could actually close a regex on this line.
            end = _regex_literal_end(code, i)
            i = end if end is not None else i + 1
            prev, prev_word = "/", ""
        elif c.isalpha() or c in ("_", "$"):
            j = i + 1
            while j < n and (code[j].isalnum() or code[j] in ("_", "$")):
                j += 1
            # A property such as obj.if is not a keyword. In a `for await`
            # head, retain `for` so the closing paren permits a regex statement.
            word = code[i:j]
            if prev == ".":
                prev_word = ""
            elif not (prev_word == "for" and word == "await"):
                prev_word = word
            prev = code[j - 1]
            i = j
        elif code[i:i + 2] in ("++", "--"):
            prev, prev_word = code[i:i + 2], ""
            i += 2
        else:
            if not c.isspace():
                prev, prev_word = c, ""
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
