"""Record CPython html.parser events as the reference for scripts/lib/html-parser.mjs.

Run with the CPython version named in the output file (3.13.13). Older 3.12
parsers treat comments and raw-text elements differently, so the reference is
recorded once and committed instead of being recomputed on each machine.

    python3 tests/gen_html_parser_golden.py
"""

from html.parser import HTMLParser
from pathlib import Path
import json
import platform
import random
import sys

OUT = Path(__file__).with_name("fixtures") / "html-parser-golden.json"

CASES = [
    ("plain tags", '<p class="a" id=b data-x=\'c\' disabled>hi</p>'),
    ("upper case", '<DIV CLASS="A"><Span>t</SPAN></DIV>'),
    ("self closing", '<br/><img src="a.png" /><a href=x/>t</a>'),
    ("duplicate attrs", '<i a=1 a=2 A="3">'),
    ("attr entities", '<a href="?a=1&amp;b=2&copy=3&notit;&#65;&#x42;&amp">x</a>'),
    ("data entities", 'a &amp; b &lt; c &copy d &#65; &#x42; &#0; &#128; &#xD800; &#1114112; &notit; &ampx &#'),
    ("script raw", '<script>if (a < b && c > d) { x = "</div>"; }</script><p>after</p>'),
    ("script close variants", '<script>a</scripty>b</script >c</SCRIPT\n>d</script>e'),
    ("style raw", '<style>a > b { content: "&amp;" }</style>'),
    ("textarea rcdata", '<textarea>a &amp; <b>x</b> &lt;</textarea>'),
    ("title rcdata", '<title>A &amp; B <i>c</i></title>'),
    ("noscript", '<noscript><img src=a></noscript>'),
    ("xmp iframe", '<xmp><b>x</b></xmp><iframe><p>y</p></iframe>'),
    ("plaintext", '<plaintext><b>everything</b></plaintext>'),
    ("comments", '<!-- a --><!----><!-->x<!--->y<!-- b --!>z<!-- c -- d -->'),
    ("bogus comments", '<!x><! y ></ z></>t</1>'),
    ("doctype", '<!DOCTYPE html>\n<!doctype HTML PUBLIC "x">'),
    ("cdata", '<![CDATA[ a < b ]]>'),
    ("pi", '<?xml version="1.0"?><?php echo 1 ?>'),
    ("stray lt", 'a < b <1 <> << c'),
    ("malformed attrs", '<div class="a"b><div a="b"c=d><div ="x"><div a=\'b\'"c">'),
    ("slashes", '<a/b/c=d / e><br / >'),
    ("multiline", 'line1\n<div\n  class="a"\n>\n  text\n</div>\n'),
    ("astral", '😀<b title="😀">한😀</b>&#128512;'),
    ("python spaces", '<a \x1c>x</a><b\x85>y</b><c ﻿>z</c>'),
    ("unterminated start", 'text <div class="a'),
    ("unterminated comment", 'text <!-- open'),
    ("unterminated comment dash", 'text <!-- open --'),
    ("unterminated end", 'text </div'),
    ("unterminated lt slash", 'text </'),
    ("unterminated doctype", '<!DOCTYPE html'),
    ("unterminated cdata", '<![CDATA[ x'),
    ("unterminated pi", '<?xml x'),
    ("unterminated bogus", '<!x'),
    ("unterminated entity", 'a &amp'),
    ("unterminated charref", 'a &#6'),
    ("unterminated script", '<script>var a = 1;'),
    ("document", (
        '<!doctype html>\n<html lang="ko">\n<head>\n<meta charset="utf-8">\n'
        '<link rel="stylesheet" href="kit.css" media="screen">\n<title>Kit &amp; docs</title>\n'
        '<style>body{background:url("a.png")}</style>\n</head>\n<body>\n'
        '<main class="page" style="--gap: 8px">\n<img srcset="a.png 1x, b.png 2x" alt="">\n'
        '<script type="module" src="kit.js"></script>\n<script>document.body.dataset.ready = "1"</script>\n'
        '</main>\n</body>\n</html>\n'
    )),
]

TOKENS = [
    "<", ">", "</", "<!--", "-->", "--!>", "<!", "<?", "?>", "<![CDATA[", "]]>", "<!DOCTYPE html>",
    "&", "&amp;", "&amp", "&#", "&#x", "&#65;", "&#x41", "&#0;", "&#128;", "&#xD800;", "&notit;", "&noti",
    "&ampx", "a", "b", " ", "\n", "\t", "\f", "\r", "'", '"', "=", "/", "/>", "<a", "<A HREF", "<div",
    "<br/", "<script>", "</script>", "</script ", "<style>", "</STYLE>", "<textarea>", "</textarea>",
    "<title>", "</title>", "<plaintext>", "<noscript>", "</noscript>", "<xmp>", "<iframe>", " class=x",
    ' id="q', " data-a='b&amp;c'", " disabled", " href=a&b=c", "\U0001F600", "한", "\x85", "﻿",
]


def fuzz_cases():
    rng = random.Random(20261106)
    for index in range(300):
        text = "".join(rng.choice(TOKENS) for _ in range(rng.randint(1, 14)))
        yield f"fuzz {index}", text


def utf16_len(text):
    return len(text.encode("utf-16-le")) // 2


class Recorder(HTMLParser):
    def __init__(self, full, **options):
        super().__init__(**options)
        self.events = []
        self.line_starts = [0]
        for at, char in enumerate(full):
            if char == "\n":
                self.line_starts.append(at + 1)
        self.full = full

    def where(self):
        line, column = self.getpos()
        start = self.line_starts[line - 1]
        index = utf16_len(self.full[:start + column])
        return [line, index - utf16_len(self.full[:start]), index]

    def record(self, *event):
        self.events.append([*event, *self.where()])

    def handle_starttag(self, tag, attrs):
        self.record("starttag", tag, [list(pair) for pair in attrs], self.get_starttag_text())

    def handle_startendtag(self, tag, attrs):
        self.record("startendtag", tag, [list(pair) for pair in attrs], self.get_starttag_text())

    def handle_endtag(self, tag):
        self.record("endtag", tag)

    def handle_data(self, data):
        self.record("data", data)

    def handle_comment(self, data):
        self.record("comment", data)

    def handle_decl(self, decl):
        self.record("decl", decl)

    def handle_pi(self, data):
        self.record("pi", data)

    def unknown_decl(self, data):
        self.record("unknown_decl", data)

    def handle_charref(self, name):
        self.record("charref", name)

    def handle_entityref(self, name):
        self.record("entityref", name)


def run(chunks, convert_charrefs, scripting, close):
    parser = Recorder("".join(chunks), convert_charrefs=convert_charrefs, scripting=scripting)
    for chunk in chunks:
        parser.feed(chunk)
    if close:
        parser.close()
    return {"events": parser.events, "rest": parser.rawdata, "pos": parser.where()}


def main():
    if sys.version_info[:2] != (3, 13):
        sys.exit(f"Python 3.13 is required to record the reference; this is {platform.python_version()}")
    cases = []
    for name, text in [*CASES, *fuzz_cases()]:
        for convert in (True, False):
            for close in (True, False):
                cases.append({"name": name, "chunks": [text], "convertCharrefs": convert, "scripting": False, "close": close,
                              **run([text], convert, False, close)})
        cases.append({"name": name + " scripting", "chunks": [text], "convertCharrefs": True, "scripting": True, "close": True,
                      **run([text], True, True, True)})
    for name, text in CASES:
        for size in (1, 3, 7):
            chunks = [text[at:at + size] for at in range(0, len(text), size)]
            for convert in (True, False):
                cases.append({"name": f"{name} chunks {size}", "chunks": chunks, "convertCharrefs": convert, "scripting": False,
                              "close": True, **run(chunks, convert, False, True)})
    OUT.parent.mkdir(exist_ok=True)
    payload = {"python": platform.python_version(), "cases": cases}
    OUT.write_text(json.dumps(payload, ensure_ascii=True, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"{OUT.relative_to(Path.cwd()) if OUT.is_relative_to(Path.cwd()) else OUT}: {len(cases)} cases, Python {payload['python']}")


if __name__ == "__main__":
    main()
