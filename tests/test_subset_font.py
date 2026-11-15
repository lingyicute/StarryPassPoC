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


if __name__ == "__main__":
    unittest.main()
