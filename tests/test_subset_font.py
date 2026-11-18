#!/usr/bin/env python3
"""Offline character-collection regressions; fontTools/network are not required."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("subset_font", Path(__file__).resolve().parents[1] / "scripts/subset_font.py")
subset_font = importlib.util.module_from_spec(spec)
spec.loader.exec_module(subset_font)


class CharacterCollectionTests(unittest.TestCase):
    def chars(self, javascript):
        return subset_font.collect_chars("<script>" + javascript + "</script>")

    def test_bmp_unicode_escapes(self):
        self.assertTrue(set("星愿令") <= self.chars(r'output.textContent="\u661f\u613f\u4ee4";'))

    def test_hex_escapes(self):
        self.assertIn("é", self.chars(r"output.textContent='\xe9';"))

    def test_braced_codepoints(self):
        self.assertTrue(set("星🌟") <= self.chars(r'output.textContent="\u{661f}\u{1f31f}";'))

    def test_surrogate_pairs(self):
        self.assertIn("🌟", self.chars(r'output.textContent="\uD83C\uDF1F";'))

    def test_template_interpolation(self):
        self.assertTrue(set("星愿令") <= self.chars(r'output.textContent=`\u661f${"\u613f"}\u4ee4`;'))

    def test_escaped_backslash_is_not_unicode(self):
        self.assertNotIn("星", self.chars(r'output.textContent="\\u661f";'))

    def test_regex_and_comments_are_not_rendered(self):
        chars = self.chars(r'const re=/\u9f8d/; /* "\u9858" */ output.textContent="\u661f";')
        self.assertIn("星", chars)
        self.assertTrue(set("龍願").isdisjoint(chars))

    def test_division_after_postfix_does_not_swallow_strings(self):
        chars = self.chars('x = a++ / b; const s = "星愿"; y = c-- / 2;\nconst t = "令"; z = d / 2;')
        self.assertTrue(set("星愿令") <= chars)
        regex_chars = self.chars(r'const s = a + /"\u9f8d"/; output.textContent = "星";')
        self.assertIn("星", regex_chars)
        self.assertNotIn("龍", regex_chars)

    def test_regex_after_control_head_and_division_after_calls(self):
        chars = self.chars('if (ok(check(a / b))) /"龍/u.test(value); output.textContent = "星愿令";')
        self.assertTrue(set("星愿令") <= chars)
        self.assertNotIn("龍", chars)
        chars = self.chars('const a = obj.if(1) / 2; const b = obj?.return / 2; output.textContent = "愿";')
        self.assertIn("愿", chars)

    def test_regex_after_for_await_head(self):
        chars = self.chars('async function f(xs) { for /* gap */ await (const x of xs) /"龍/u.test(x); return "星愿"; }')
        self.assertTrue(set("星愿") <= chars)
        self.assertNotIn("龍", chars)

    def test_line_comment_stops_at_each_js_line_terminator(self):
        for separator in ("\n", "\r", "\r\n", "\u2028", "\u2029"):
            with self.subTest(separator=repr(separator)):
                chars = self.chars('// "龍"' + separator + 'output.textContent = "星愿令";')
                self.assertTrue(set("星愿令") <= chars)
                self.assertNotIn("龍", chars)

    def test_division_after_object_literal_keeps_same_line_strings(self):
        chars = self.chars('const n = { valueOf() { return 8; } } / "星愿".length; const t = "令";')
        self.assertTrue(set("星愿令") <= chars)

    def test_regex_scan_stops_at_line_terminator(self):
        chars = self.chars('x = a + /unterminated\nconst s = "星愿令"; y = b / 2;')
        self.assertTrue(set("星愿令") <= chars)

    def test_invalid_scalars_do_not_break_collection(self):
        chars = self.chars(r'const text="\uD800\u{110000}\u661f";')
        self.assertIn("星", chars)
        self.assertFalse(any(0xD800 <= ord(char) <= 0xDFFF for char in chars))

    def test_entities_and_printable_ascii_are_preserved(self):
        chars = subset_font.collect_chars('<p title="星">愿&#20196;</p>')
        self.assertTrue(set("星愿令") <= chars)
        self.assertTrue(set(map(chr, range(32, 127))) <= chars)

    def test_css_string_escapes(self):
        chars = subset_font.collect_chars(
            r'<style>a::after{content:"\25BE  \5FAE\8F6F"} /* "\4E2D" */'
            r"b::before{content:'\2606x\D800\'\5c'}</style>")
        self.assertTrue(set("▾微软☆") <= chars)
        self.assertNotIn("中", chars)
        self.assertFalse(any(0xD800 <= ord(char) <= 0xDFFF for char in chars))

    def test_css_invalid_escapes_render_a_replacement_character(self):
        for escape in (r"\0", r"\D800", r"\110000"):
            with self.subTest(escape=escape):
                chars = subset_font.collect_chars(f'<style>p::after{{content:"{escape}"}}</style>')
                self.assertIn("\ufffd", chars)

    def test_css_line_continuation_does_not_break_decoding(self):
        chars = subset_font.collect_chars('<style>p::after{content:"\\\r\n\\9F8D\r\nx"}</style>')
        self.assertIn("龍", chars)


if __name__ == "__main__":
    unittest.main()
