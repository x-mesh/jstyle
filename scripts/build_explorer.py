#!/usr/bin/env python3
"""Build a portable, offline design comparison from a local manifest."""

from __future__ import annotations

import argparse
import base64
import hashlib
from html import escape, unescape
from html.parser import HTMLParser
import json
import mimetypes
from pathlib import Path
import re
import shlex
import sys
import tempfile
from urllib.parse import unquote, urlsplit
from urllib.request import url2pathname


SKILL_ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = SKILL_ROOT / "assets" / "style-explorer.html"
MARKER = "/*__JSTYLE_DATA__*/ null"
CONNECT_CSP = "connect-src 'none'"
PREVIEW_CSP = (
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; "
    "font-src data:; media-src data:; script-src 'none'; "
    "form-action 'none'; base-uri 'none'; object-src 'none'"
)
MAX_RESOURCE_BYTES = 20 * 1024 * 1024
MAX_TOTAL_RESOURCE_BYTES = 100 * 1024 * 1024


class ManifestError(ValueError):
    """Every problem found in one pass, so the manifest can be fixed in one edit."""

    def __init__(self, problems: list[str]):
        self.problems = problems
        if len(problems) == 1:
            super().__init__(problems[0])
        else:
            super().__init__(f"manifest 있음 {len(problems)} 곳을 고쳐야 합니다：\n" + "\n".join(f"  {i}. {p}" for i, p in enumerate(problems, 1)))


def text_field(obj: dict, name: str, *, default: str | None = None, where: str = "") -> str:
    value = obj.get(name, default)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{where}{name} 비어 있지 않은 문자열이어야 합니다")
    return value.strip()


def text_list(obj: dict, name: str, *, where: str = "") -> list[str]:
    values = obj.get(name)
    if not isinstance(values, list) or not values:
        raise ValueError(f"{where}{name} 비어 있지 않은 문자열 배열이어야 합니다")
    if any(not isinstance(v, str) or not v.strip() for v in values):
        raise ValueError(f"{where}{name} 각 항목은 비어 있지 않은 문자열이어야 합니다")
    return [v.strip() for v in values]


class AssetCheck(HTMLParser):
    """Reject resource dependencies; the browser sandbox disables behavior."""

    def __init__(self):
        super().__init__()
        self.styles = []
        self.in_style = False
        self.head_position = None

    def handle_starttag(self, tag: str, attrs: list) -> None:
        attrs = dict(attrs)
        if tag == "head" and self.head_position is None:
            self.head_position = (self.getpos(), self.get_starttag_text())
        if tag in ("iframe", "frame", "object", "embed"):
            raise ValueError("안 HTML 중첩 문서를 지원하지 않음；정지 내용이나 캡처를 주세요")
        if tag == "style":
            self.in_style = True
        if attrs.get("style"):
            self.styles.append(attrs["style"])
        if tag == "base":
            raise ValueError("안 HTML 포함하면 안 됨 base；파일을 안에 넣어야 합니다")
        if tag == "meta" and attrs.get("http-equiv", "").lower() == "refresh":
            raise ValueError("안 HTML 자동으로 다른 곳을 열면 안 됩니다")
        for key in ("src", "poster", "data", "href", "xlink:href"):
            value = attrs.get(key, "") or ""
            if not value or value.lower().startswith(("#", "data:")):
                continue
            raise ValueError(f"안 HTML 밖의 파일 참조를 포함함 {tag}.{key}: {value}")
        if attrs.get("srcset"):
            raise ValueError("안 HTML 안에 넣은 파일을 쓰세요: src 대신 srcset")

    def handle_endtag(self, tag: str) -> None:
        if tag == "style":
            self.in_style = False

    def handle_data(self, data: str) -> None:
        if self.in_style:
            self.styles.append(data)


CSS_TOKEN = re.compile(
    r"(?P<comment>/\*.*?\*/)|(?P<string>\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*')"
    r"|(?P<ident>(?:[-_a-zA-Z]|\\(?:[0-9a-fA-F]{1,6}\s?|[^\r\n]))"
    r"(?:[-_a-zA-Z0-9]|\\(?:[0-9a-fA-F]{1,6}\s?|[^\r\n]))*)"
    r"|(?P<space>\s+)|(?P<symbol>.)", re.S,
)


def css_unescape(value: str) -> str:
    def replacement(match):
        if match.group(1):
            codepoint = int(match.group(1), 16)
            return chr(codepoint) if 0 < codepoint <= 0x10FFFF else "\ufffd"
        return match.group(2)
    return re.sub(r"\\([0-9a-fA-F]{1,6})(?:\s)?|\\([^\r\n])", replacement, value)


def check_css(css: str, label: str) -> None:
    tokens = [(m.lastgroup, m.group()) for m in CSS_TOKEN.finditer(css)
              if m.lastgroup not in ("comment", "space")]

    def check_resource(value: str):
        if not css_unescape(value).strip().lower().startswith(("data:", "#")):
            raise ValueError(f"{label}: CSS 밖의 파일 참조를 포함함")

    for index, (kind, value) in enumerate(tokens):
        if value == "@" and index + 1 < len(tokens) and tokens[index + 1][0] == "ident" and css_unescape(tokens[index + 1][1]).lower() == "import":
            raise ValueError(f"{label}: 파일 안에 넣어 주세요: CSS，쓰지 않습니다 @import")
        name = css_unescape(value).lower() if kind == "ident" else ""
        if name not in ("url", "image-set", "-webkit-image-set", "image", "src"):
            continue
        if index + 1 >= len(tokens) or tokens[index + 1][1] != "(":
            continue
        depth, body = 1, []
        for inner_kind, inner_value in tokens[index + 2:]:
            if inner_kind == "symbol" and inner_value == "(":
                depth += 1
            elif inner_kind == "symbol" and inner_value == ")":
                depth -= 1
                if depth == 0:
                    break
            if name == "url":
                body.append(inner_value[1:-1] if inner_kind == "string" else inner_value)
            elif depth == 1 and inner_kind == "string":
                check_resource(inner_value[1:-1])
        if name == "url":
            check_resource("".join(body))


# Sandboxed previews have no storage; give prototypes an in-memory stand-in so their scripts keep running.
STORAGE_SHIM = (
    "<script>(()=>{const mem=()=>{const m=new Map();return{get length(){return m.size},"
    "key:i=>[...m.keys()][i]??null,getItem:k=>m.has(String(k))?m.get(String(k)):null,"
    "setItem:(k,v)=>{m.set(String(k),String(v))},removeItem:k=>{m.delete(String(k))},clear:()=>m.clear()}};"
    "for(const n of['localStorage','sessionStorage']){try{window[n].length}catch{"
    "Object.defineProperty(window,n,{value:mem(),configurable:true})}}})();</script>"
)


def preview_csp(interactive: bool) -> str:
    # Interactive prototypes may run their own inline scripts, still with no network or external files.
    # 'unsafe-eval' lets declarative libraries such as Alpine.js evaluate their attribute expressions.
    return PREVIEW_CSP.replace("script-src 'none'", "script-src 'unsafe-inline' 'unsafe-eval'") if interactive else PREVIEW_CSP


EMBEDDABLE = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
    ".gif": "image/gif", ".avif": "image/avif", ".svg": "image/svg+xml",
    ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf",
    ".mp4": "video/mp4", ".webm": "video/webm",
}


def read_asset(path: Path, used: set[Path]) -> bytes:
    """Bound input size before reading; keep every dependency protected from output overwrites."""
    size = path.stat().st_size
    if size > MAX_RESOURCE_BYTES:
        raise ValueError(f"로컬 파일 {path} 값: {size} 바이트，파일 하나의 최대 크기 {MAX_RESOURCE_BYTES}를 넘습니다. 제한값: {MAX_RESOURCE_BYTES} 바이트；"
                         f"파일을 압축하거나 잘라 다음 크기로 줄이세요: {MAX_RESOURCE_BYTES} 바이트 이내，원래 경로를 유지한 뒤 다시 실행하세요")
    total = sum(p.stat().st_size for p in used | {path})
    if total > MAX_TOTAL_RESOURCE_BYTES:
        raise ValueError(f"안에 넣은 파일의 총 크기 {total} 바이트，전체 최대 크기 {MAX_TOTAL_RESOURCE_BYTES}를 넘습니다. 제한값: {MAX_TOTAL_RESOURCE_BYTES} 바이트；"
                         f"안에서 참조한 이미지를 줄이세요、글꼴 또는 영상，입력 파일 전체가 넘지 않게 합니다: {MAX_TOTAL_RESOURCE_BYTES} 바이트로 줄인 뒤 다시 실행하세요")
    used.add(path)
    return path.read_bytes()


def read_text_asset(path: Path, used: set[Path]) -> str:
    # Match Path.read_text's universal newline handling used by earlier versions.
    return read_asset(path, used).decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")


def resource_parts(ref: str):
    path = Path(ref)
    if path.drive and path.is_absolute():
        ref = path.as_uri()
    return urlsplit(ref)


def local_file(ref: str, base: Path, root: Path) -> Path | None:
    """Resolve files anywhere on disk; root is retained for compatibility with existing callers."""
    ref = ref.strip()
    if not ref or ref.startswith("#") or ref.lower().startswith("data:"):
        return None
    try:
        parts = resource_parts(ref)
    except ValueError:
        raise ValueError(f"파일 주소가 올바르지 않습니다：{ref}；참조를 있는 파일의 절대 경로로 바꾼 뒤 다시 만드세요") from None
    if (parts.scheme and parts.scheme.lower() != "file") or parts.netloc not in ("", "localhost") or ref.startswith("//"):
        destination = base / (Path(unquote(parts.path)).name or "resource.bin")
        command = f"curl -L --fail --output {shlex.quote(str(destination))} -- {shlex.quote(ref)}"
        raise ValueError(f"외부 파일 {ref} 오프라인에서 쓸 수 없음；먼저 실행 `{command}`，"
                         f"다음 참조를 바꾸세요: {json.dumps(ref, ensure_ascii=False)} 다음으로 바꾸세요: {json.dumps(str(destination), ensure_ascii=False)} 다시 만드세요")
    # A file URL's /C:/... is not a Windows filesystem path. Decode it with
    # the platform converter, which also handles percent-escaped filenames.
    target = (base / url2pathname(parts.path)).resolve()
    if not target.is_file():
        raise ValueError(f"로컬 파일을 찾을 수 없습니다 {ref}（읽은 값: {target}）；"
                         f"파일을 다음 위치에 저장하세요: {json.dumps(str(target), ensure_ascii=False)}，참조를 실제 파일의 절대 경로로 바꾼 뒤 다시 만드세요")
    return target


def resource_url(ref: str, base: Path, root: Path, used: set[Path]) -> str:
    target = local_file(ref, base, root)
    if target is None:
        return ref
    mime = EMBEDDABLE.get(target.suffix.lower()) or mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    fragment = resource_parts(ref).fragment
    return f"data:{mime};base64," + base64.b64encode(read_asset(target, used)).decode("ascii") + ("#" + fragment if fragment else "")


def apply_edits(content: str, edits: list[tuple[int, int, str]]) -> str:
    for start, end, replacement in sorted(edits, reverse=True):
        content = content[:start] + replacement + content[end:]
    return content


def embed_css(css: str, base: Path, root: Path, used: set[Path], stack: tuple[Path, ...] = ()) -> str:
    """Rewrite actual CSS tokens only, including escaped url names and nested local imports."""
    tokens = [m for m in CSS_TOKEN.finditer(css) if m.lastgroup not in ("comment", "space")]
    edits = []

    def closing(index):
        depth = 0
        for end in range(index, len(tokens)):
            if tokens[end].lastgroup == "symbol":
                if tokens[end].group() == "(":
                    depth += 1
                elif tokens[end].group() == ")":
                    depth -= 1
                    if depth == 0:
                        return end
        return len(tokens) - 1

    def value(start, end):
        raw = "".join(m.group() for m in CSS_TOKEN.finditer(css[start:end]) if m.lastgroup != "comment").strip()
        if raw[:1] in ("'", '"') and raw[-1:] == raw[:1]:
            raw = raw[1:-1]
        return css_unescape(raw)

    i = 0
    while i < len(tokens):
        token = tokens[i]
        name = css_unescape(token.group()).lower() if token.lastgroup == "ident" else ""
        if token.group() == "@" and i + 2 < len(tokens) and css_unescape(tokens[i + 1].group()).lower() == "import":
            first = i + 2
            last = first
            if tokens[first].lastgroup == "string":
                ref = value(tokens[first].start(), tokens[first].end())
            elif css_unescape(tokens[first].group()).lower() == "url" and first + 1 < len(tokens) and tokens[first + 1].group() == "(":
                last = closing(first + 1)
                ref = value(tokens[first + 1].end(), tokens[last].start())
            else:
                raise ValueError('CSS @import 읽어 들일 수 없습니다；다음으로 고치세요: @import "이미 있는 파일의 절대 경로.css";')
            end = last + 1
            while end < len(tokens) and tokens[end].group() != ";":
                if tokens[end].group() == "(":
                    end = closing(end)
                end += 1
            condition = css[tokens[last].end():tokens[end].start() if end < len(tokens) else len(css)].strip()
            target = local_file(ref, base, root)
            if target is None:
                # Embedded imports have no local base; decode and check them as well.
                if not ref.lower().startswith("data:text/css"):
                    raise ValueError('CSS @import 로컬 파일을 쓰세요: CSS 파일，예: @import "./style.css";')
                header, payload = ref.split(",", 1)
                imported = (base64.b64decode(payload).decode("utf-8") if ";base64" in header.lower() else unquote(payload))
                imported = embed_css(imported, base, root, used, stack)
            elif target in stack:
                imported = ""  # Browsers ignore cyclic imports too.
            else:
                imported = embed_css(read_text_asset(target, used), target.parent, root, used, stack + (target,))
            # Preserve import layer/supports/media conditions when moving the CSS inline.
            wrappers = []
            for keyword in ("layer", "supports"):
                match = re.match(r"^" + keyword + r"\b", condition, re.I)
                if not match:
                    continue
                rest = condition[match.end():].lstrip()
                argument = ""
                if rest.startswith("("):
                    depth = 0
                    for pos, char in enumerate(rest):
                        depth += (char == "(") - (char == ")")
                        if depth == 0:
                            argument, rest = rest[1:pos], rest[pos + 1:].lstrip()
                            break
                wrappers.append("@layer " + argument if keyword == "layer" else "@supports (" + argument + ")")
                condition = rest
            if condition:
                wrappers.append("@media " + condition)
            for wrapper in reversed(wrappers):
                imported = wrapper + "{" + imported + "}"
            edits.append((token.start(), tokens[end].end() if end < len(tokens) else len(css), imported))
            i = end + 1
            continue
        if name in ("url", "image-set", "-webkit-image-set", "image", "src") and i + 1 < len(tokens) and tokens[i + 1].group() == "(":
            end = closing(i + 1)
            if name == "url":
                ref = value(tokens[i + 1].end(), tokens[end].start())
                url = resource_url(ref, base, root, used)
                if url != ref:
                    edits.append((token.start(), tokens[end].end(), 'url("' + url + '")'))
                i = end + 1
                continue
            depth = 0
            for inner in tokens[i + 2:end]:
                if inner.lastgroup == "symbol":
                    depth += (inner.group() == "(") - (inner.group() == ")")
                if depth == 0 and inner.lastgroup == "string":
                    ref = value(inner.start(), inner.end())
                    url = resource_url(ref, base, root, used)
                    if url != ref:
                        edits.append((inner.start(), inner.end(), '"' + url + '"'))
        i += 1
    return apply_edits(css, edits)


def widest_candidate(srcset: str) -> str | None:
    """Largest "url 1200w" / "url 2x" entry of a srcset; an entry without a descriptor counts as 1x.

    Parsed as the HTML spec does: a URL runs to the next whitespace, so data URLs keep their commas.
    """
    best, best_size, i, n = None, -1.0, 0, len(srcset)
    while i < n:
        while i < n and (srcset[i].isspace() or srcset[i] == ","):
            i += 1
        start = i
        while i < n and not srcset[i].isspace():
            i += 1
        url, descriptor = srcset[start:i], ""
        if url.endswith(","):
            url = url.rstrip(",")
        else:
            start = i
            while i < n and srcset[i] != ",":
                i += 1
            descriptor = srcset[start:i].strip()
        try:
            size = float(descriptor[:-1]) if descriptor[-1:] in ("w", "x") else 1.0
        except ValueError:
            size = 1.0
        if url and size > best_size:
            best, best_size = url, size
    return best


HTML_ATTR = re.compile(r"""(?P<lead>\s+(?P<name>[^\s=/>]+)\s*=\s*)(?:"(?P<double>[^"]*)"|'(?P<single>[^']*)'|(?P<bare>[^\s>]+))""")


class LocalAssets(HTMLParser):
    """Edit only real tags and styles, preserving comments, text and inline script bodies."""

    def __init__(self, content: str, base: Path, root: Path, used: set[Path], interactive: bool, *, shell: bool = False):
        super().__init__(convert_charrefs=False)
        self.content, self.base, self.root, self.used = content, base, root, used
        self.interactive = interactive
        self.shell = shell
        self.lines = content.split("\n")
        self.edits = []
        self.in_style = False
        self.script = None
        self.deferred = []

    def char_index(self):
        line, col = self.getpos()
        return sum(len(part) + 1 for part in self.lines[:line - 1]) + col

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        raw = self.get_starttag_text()
        start = self.char_index()
        if tag == "link" and "stylesheet" in (attrs.get("rel") or "").lower().split() and attrs.get("href"):
            target = local_file(attrs["href"], self.base, self.root)
            if target is not None:
                css = embed_css(read_text_asset(target, self.used), target.parent, self.root, self.used, (target,))
                if attrs.get("media"):
                    css = "@media " + attrs["media"] + "{" + css + "}"
                self.edits.append((start, start + len(raw), "<style>" + re.sub(r"</style", r"<\\/style", css, flags=re.I) + "</style>"))
                return
        if tag == "script" and attrs.get("src"):
            target = local_file(attrs["src"], self.base, self.root)
            if target is not None:
                if self.interactive:
                    code = read_text_asset(target, self.used)
                else:
                    read_asset(target, self.used)
                    code = ""
                code = re.sub(r"</script", r"<\\/script", code, flags=re.I)
                module = (attrs.get("type") or "").lower() == "module"
                replacement = (('<script type="module">' if module else "<script>") + code + "</script>") if self.interactive else ""
                if "defer" in attrs and not module:
                    # Inline scripts ignore defer; keep their original execution after the DOM.
                    self.deferred.append(replacement)
                    replacement = ""
                self.script = (start, replacement)
                return
        if tag == "style":
            self.in_style = True

        def attribute(match):
            name = match["name"].lower()
            if self.shell and tag == "a" and name == "href":
                return match.group()  # Template navigation is not an offline resource dependency.
            ref = unescape(next(match[group] for group in ("double", "single", "bare") if match[group] is not None))
            has_src = bool((attrs.get("src") or "").strip())
            if name == "src" and tag == "img" and not has_src and widest_candidate(attrs.get("srcset") or ""):
                return ""  # An empty src gives way to the srcset candidate below, so the tag keeps one src.
            if name == "srcset" and tag == "img":
                # The page shows one fixed size, so one file is enough: keep src, or take the widest candidate.
                if has_src or not widest_candidate(ref):
                    return ""
                return match["lead"].replace(match["name"], "src") + '"' + escape(resource_url(widest_candidate(ref), self.base, self.root, self.used), quote=True) + '"'
            if name == "style":
                result = embed_css(ref, self.base, self.root, self.used)
            elif name in ("src", "poster", "data", "href", "xlink:href"):
                result = resource_url(ref, self.base, self.root, self.used)
            else:
                return match.group()
            return match.group() if result == ref else match["lead"] + '"' + escape(result, quote=True) + '"'

        replacement = HTML_ATTR.sub(attribute, raw)
        if replacement != raw:
            self.edits.append((start, start + len(raw), replacement))

    def handle_endtag(self, tag):
        if tag == "style":
            self.in_style = False
        if tag == "script" and self.script is not None:
            start, replacement = self.script
            end = self.content.find(">", self.char_index()) + 1
            self.edits.append((start, end, replacement))
            self.script = None

    def handle_data(self, data):
        if self.in_style:
            replacement = embed_css(data, self.base, self.root, self.used)
            if replacement != data:
                self.edits.append((self.char_index(), self.char_index() + len(data), replacement))

    def result(self):
        self.feed(self.content)
        self.close()
        if self.script is not None:
            start, replacement = self.script
            self.edits.append((start, len(self.content), replacement))
        content = apply_edits(self.content, self.edits)
        if self.deferred:
            close = content.lower().rfind("</body>")
            close = len(content) if close < 0 else close
            content = content[:close] + "".join(self.deferred) + content[close:]
        return content


def embed_local_files(content: str, base: Path, root: Path, used: set[Path]) -> str:
    return LocalAssets(content, base, root, used, False, shell=True).result()


def ensure_head(content: str) -> str:
    class Structure(HTMLParser):
        def __init__(self):
            super().__init__()
            self.head = self.html = self.body = self.html_end = self.declaration = None
            self.head_closed = False

        def char_index(self):
            line, col = self.getpos()
            return sum(len(part) + 1 for part in content.split("\n")[:line - 1]) + col

        def handle_starttag(self, tag, attrs):
            if tag == "head" and self.head is None:
                self.head = self.char_index() + len(self.get_starttag_text())
            if tag == "html" and self.html is None:
                self.html = self.char_index() + len(self.get_starttag_text())
            if tag == "body" and self.body is None:
                self.body = self.char_index()

        def handle_endtag(self, tag):
            if tag == "head":
                self.head_closed = True
            if tag == "html":
                self.html_end = self.char_index()

        def handle_startendtag(self, tag, attrs):
            self.handle_starttag(tag, attrs)
            if tag != "head":  # HTML does not allow a self-closing head.
                self.handle_endtag(tag)

        def handle_decl(self, decl):
            self.declaration = self.char_index() + len(decl) + 3

    parser = Structure()
    parser.feed(content)
    if parser.head is None:
        at = parser.html if parser.html is not None else parser.declaration or 0
        return content[:at] + "<head></head>" + content[at:]
    if not parser.head_closed:
        at = next((pos for pos in (parser.body, parser.html_end) if pos is not None and pos >= parser.head), len(content))
        return content[:at] + "</head>" + content[at:]
    return content


def prepare_html(path: Path, interactive: bool = False, root: Path | None = None, used: set[Path] | None = None) -> str:
    path = path.resolve()
    used = used if used is not None else set()
    content = read_text_asset(path, used)
    content = ensure_head(content)
    content = LocalAssets(content, path.parent, root or path.parent, used, interactive).result()
    parser = AssetCheck()
    parser.feed(content)
    for style in parser.styles:
        check_css(style, path.name)
    (line, column), start_tag = parser.head_position
    head_end = sum(len(part) + 1 for part in content.split('\n')[:line - 1]) + column + len(start_tag)
    meta = f'<meta http-equiv="Content-Security-Policy" content="{preview_csp(interactive)}">'
    return content[:head_end] + meta + (STORAGE_SHIM if interactive else "") + content[head_end:]


def prepare_image(path: Path, used: set[Path] | None = None) -> str:
    data = read_asset(path, used if used is not None else set())
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        mime = "image/png"
    elif data.startswith(b"\xff\xd8\xff"):
        mime = "image/jpeg"
    elif data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        mime = "image/webp"
    else:
        raise ValueError(f"{path.name}: 정지 미리보기 지원 형식: PNG、JPEG 와 WebP")
    return f"data:{mime};base64," + base64.b64encode(data).decode("ascii")


LOOPBACK = {"localhost", "127.0.0.1", "::1"}


def local_url(value: str, label: str) -> str:
    """Live candidates only point at a dev server on this machine."""
    try:
        parts = urlsplit(value)
        parts.port  # Reject malformed ports before generating CSP origins.
    except ValueError:
        raise ValueError(f"{label}올바른 로컬 주소여야 합니다: http(s) 주소，받은 값: {value}") from None
    if parts.scheme not in ("http", "https") or (parts.hostname or "").lower() not in LOOPBACK or parts.username or parts.password:
        raise ValueError(f"{label}로컬 개발 서버 주소만 받을 수 있습니다，예: http://localhost:5173/orders；받은 값: {value}")
    return value


HEX_COLOR = re.compile(r"#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-zA-Z_])")


def palette(value, where: str) -> list[str]:
    colors = HEX_COLOR.findall(json.dumps(value, ensure_ascii=False))
    if not colors:
        raise ValueError(f'{where}palette 쓸 수 있는 16진 색 값이 없습니다，받은 값: {json.dumps(value, ensure_ascii=False)}；'
                         '다음으로 고치세요: "palette": ["#1a2b3c", "#ffffff"]')
    return colors


def native_viewport(value, where: str) -> dict:
    """Normalize a fixed canvas without changing manifests that omit it."""
    dimensions = None
    if isinstance(value, str):
        match = re.fullmatch(r"\s*(\d+)\s*[xX×]\s*(\d+)\s*", value)
        if match:
            dimensions = [int(part) for part in match.groups()]
    elif isinstance(value, dict):
        dimensions = [value.get("width"), value.get("height")]
    if dimensions and all(isinstance(n, (int, float)) and not isinstance(n, bool)
                          and 0 < n <= 2**53 - 1 and n == int(n) for n in dimensions):
        return dict(zip(("width", "height"), map(int, dimensions)))
    raise ValueError(f'{where}nativeViewport 너비와 높이는 양의 정수여야 합니다；받은 값: {json.dumps(value, ensure_ascii=False)}；'
                     '예: "1920x1080"、"1920×1080" 또는 {"width":1920,"height":1080}')


def read_manifest(path: Path) -> dict:
    if not path.is_file():
        raise ValueError(f"찾을 수 없습니다 manifest：{path}。먼저 작업 폴더에 적어 둡니다 manifest.json，필드 안내: references/style-explorer.md 의“입력 준비”")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"manifest 올바르지 않음: JSON： {exc.lineno} 줄의 {exc.colno} 열，{exc.msg}") from None
    if not isinstance(raw, dict):
        raise ValueError("manifest 맨 바깥은 객체여야 합니다，안에 들어 있음 candidates 배열")
    return raw


class HTMLTitle(HTMLParser):
    def __init__(self):
        super().__init__()
        self.in_title = False
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list) -> None:
        if tag.lower() == "title":
            self.in_title = True

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "title":
            self.in_title = False

    def handle_data(self, data: str) -> None:
        if self.in_title:
            self.parts.append(data)


def inferred_name(kind: str, source: Path | None, url: str | None, index: int) -> str:
    if source and kind == "html":
        try:
            title = HTMLTitle()
            title.feed(read_text_asset(source, set()))
            value = " ".join("".join(title.parts).split())
            if value:
                return value
        except (OSError, UnicodeError, ValueError):
            pass
    if source:
        return source.stem
    if url:
        parts = urlsplit(url)
        return Path(unquote(parts.path)).stem or parts.hostname or f"안 {index}"
    return f"안 {index}"


def _load_manifest_data(raw: dict, path: Path, *, include_manifest: bool) -> tuple[dict, set[Path]]:
    problems: list[str] = []

    def attempt(check):
        """Run one check; keep its message and carry on so the rest still gets checked."""
        try:
            return check()
        except ValueError as exc:
            problems.append(str(exc))
            return None

    if "schemaVersion" in raw and raw["schemaVersion"] != 1:
        problems.append("manifest.schemaVersion 필요한 값: 1")
    data = {"schemaVersion": 1}
    for name, default in (("project", None), ("brief", None), ("round", "01")):
        if name in raw or default is not None:
            value = attempt(lambda: text_field(raw, name, default=default, where="manifest."))
            if value is not None:
                data[name] = value
    if "lang" in raw:
        if raw["lang"] not in ("ko", "en"):
            problems.append('manifest.lang 가능한 값: "ko" 또는 "en"')
        data["lang"] = raw["lang"]
    if "serve" in raw:
        serve = raw["serve"]
        if not isinstance(serve, dict):
            problems.append("serve 객체여야 합니다，예: {\"command\": \"pnpm dev\", \"cwd\": \"/프로젝트의 절대 경로\", \"url\": \"http://localhost:3000\"}")
        else:
            if not isinstance(serve.get("command"), str) or not serve["command"].strip():
                problems.append("serve.command 비어 있지 않은 문자열이어야 합니다")
            if "cwd" in serve and (not isinstance(serve["cwd"], str) or not Path(serve["cwd"]).is_absolute()):
                problems.append("serve.cwd 절대 경로여야 합니다")
            if "url" in serve:
                if not isinstance(serve["url"], str) or not serve["url"].strip():
                    problems.append("serve.url 비어 있지 않은 로컬 값이어야 합니다: http(s) 주소")
                else:
                    attempt(lambda: local_url(serve["url"], "serve.url "))
        data["serve"] = serve
    candidates = raw.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        problems.append("candidates 디자인 안이 하나 이상 필요합니다")
        candidates = []
    seen = set()
    reserved = {c.get("id", "").strip() for c in candidates
                if isinstance(c, dict) and isinstance(c.get("id"), str) and c.get("id", "").strip()}
    inputs = {TEMPLATE.resolve()}
    if include_manifest:
        inputs.add(path.resolve())
    output = []
    viewport = None
    if "nativeViewport" in raw:
        affected = "、".join(str(c.get("id", i)) for i, c in enumerate(candidates, 1)
                            if isinstance(c, dict) and "nativeViewport" not in c)
        where = f"manifest(안 {affected}): " if affected else "manifest."
        viewport = attempt(lambda: native_viewport(raw["nativeViewport"], where))
    for index, candidate in enumerate(candidates, 1):
        if not isinstance(candidate, dict):
            problems.append(f" {index} 번째 안은 객체여야 합니다")
            continue
        before = len(problems)
        identifier = candidate.get("id")
        if identifier is None:
            identifier = f"candidate-{index}"
            suffix = 2
            while identifier in reserved or identifier in seen:
                identifier = f"candidate-{index}-{suffix}"
                suffix += 1
        else:
            if not isinstance(identifier, str) or not identifier.strip():
                problems.append(f" {index} 개 안 id 비어 있지 않은 문자열이어야 합니다")
                identifier = None
            else:
                identifier = identifier.strip()
                if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", identifier):
                    problems.append(f'안 id "{identifier}" 올바르지 않음：소문자만 씁니다、숫자、하이픈과 밑줄，글자나 숫자로 시작，예: "a" 또는 "dir-2"')
                elif identifier in seen:
                    problems.append(f'안 id "{identifier}" 겹칩니다，안마다 다른 값을 쓰세요: id')
                seen.add(identifier)
        where = f"안 {identifier}：" if identifier else f" {index} 개 안："
        candidate_viewport = (attempt(lambda: native_viewport(candidate["nativeViewport"], where))
                              if "nativeViewport" in candidate else viewport)
        kind = candidate.get("kind", "html")
        if kind not in ("html", "image", "url"):
            problems.append(f'{where}kind 가능한 값: "html"、"image" 또는 "url"，받은 값: {json.dumps(kind, ensure_ascii=False)}')
            kind = None
        baseline = candidate.get("baseline", False)
        interactive = candidate.get("interactive", False)
        if not isinstance(baseline, bool) or not isinstance(interactive, bool):
            problems.append(f"{where}baseline 와 interactive 올바른 형식: true 또는 false")
        elif interactive and kind not in ("html", None):
            problems.append(f"{where}interactive 용도: html 안")
        source = url = None
        if kind == "url":
            url = attempt(lambda: local_url(text_field(candidate, "url", where=where), f"{where}url "))
        elif kind:
            name = attempt(lambda: text_field(candidate, "source", where=where))
            if name:
                def source_file():
                    try:
                        # source is a filesystem path, so literal #, ? and % retain their old meaning.
                        direct = (path.parent / name).resolve()
                        if direct.is_file():
                            return direct
                        target = local_file(name, path.parent, path.parent)
                        if target is None:
                            raise ValueError('로컬 파일을 가리키게 해 주세요，예: "source": "./a.html"')
                        return target
                    except ValueError as exc:
                        raise ValueError(f"{where}source {exc}") from None
                source = attempt(source_file)
                if source:
                    inputs.add(source)
        colors = attempt(lambda: palette(candidate.get("palette"), where)) if "palette" in candidate else None
        texts = {name: attempt(lambda name=name: text_field(candidate, name, where=where))
                 for name in ("concept", "typography") if name in candidate}
        candidate_name = (attempt(lambda: text_field(candidate, "name", where=where))
                          if "name" in candidate else None)
        traits = attempt(lambda: text_list(candidate, "traits", where=where)) if "traits" in candidate else None
        if len(problems) > before:
            continue
        try:
            content = url if kind == "url" else prepare_html(source, interactive, path.parent, inputs) if kind == "html" else prepare_image(source, inputs)
        except ValueError as exc:
            message = str(exc)
            if message.startswith(f"{source.name}: "):
                message = message[len(source.name) + 2:]
            problems.append(f"{where}{source.name} {message}" if source else f"{where}{message}")
            continue
        if candidate_name is None:
            candidate_name = inferred_name(kind, source, url, index)
        output.append({
            "id": identifier, "name": candidate_name, **texts,
            **({"palette": colors} if colors is not None else {}),
            **({"traits": traits} if traits is not None else {}), "kind": kind,
            "content": content,
            "sourceLabel": url if kind == "url" else source.name,
            "baseline": baseline,
            "interactive": interactive,
            **({"nativeViewport": candidate_viewport} if candidate_viewport else {}),
        })
    if sum(c["baseline"] for c in output) > 1:
        problems.append("기존 화면 안은 최대 하나입니다（baseline: true）")
    if problems:
        raise ManifestError(problems)
    # The current version always sits first so every direction is read against it.
    output.sort(key=lambda c: not c["baseline"])
    data["candidates"] = output
    canonical = json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    data["fingerprint"] = hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:24]
    return data, inputs


def load_manifest(path: Path) -> tuple[dict, set[Path]]:
    path = path.resolve()
    return _load_manifest_data(read_manifest(path), path, include_manifest=True)


def load_html_files(sources: list[Path]) -> tuple[dict, set[Path]]:
    if not sources:
        raise ValueError("폴더에서 안을 찾을 수 없습니다 HTML")
    sources = [source.resolve() for source in sources]
    anchor = sources[0].parent / ".jstyle-explorer-input.json"
    raw = {"candidates": [{"source": str(source)} for source in sources]}
    return _load_manifest_data(raw, anchor, include_manifest=False)


def load_input(source: Path | list[Path]) -> tuple[dict, set[Path]]:
    sources = [source] if isinstance(source, Path) else source
    if len(sources) > 1:
        if any(path.suffix.lower() not in (".html", ".htm") for path in sources):
            raise ValueError("여러 입력은 모두 다음이어야 합니다: HTML 파일")
        return load_html_files(sources)
    path = sources[0].resolve()
    if path.is_dir():
        manifest = path / "manifest.json"
        if manifest.is_file():
            return load_manifest(manifest)
        pages = sorted(p for p in path.iterdir()
                       if p.is_file() and p.suffix.lower() in (".html", ".htm")
                       and p.name.lower() != "style-explorer.html")
        return load_html_files(pages)
    if path.name.lower() == "manifest.json":
        return load_manifest(path)
    if path.suffix.lower() == ".json":
        return load_manifest(path)
    if path.suffix.lower() in (".html", ".htm"):
        return load_html_files([path])
    raise ValueError(f"디자인 안의 폴더를 입력해야 합니다、HTML 파일 또는 manifest.json：{path}")


def build(source: Path | list[Path], output: Path, *, force: bool = False) -> dict:
    output = output.resolve()
    data, inputs = load_input(source)
    if output in inputs or output.is_relative_to(SKILL_ROOT):
        raise ValueError("출력으로 입력을 덮어쓸 수 없습니다. 스킬 설치 폴더에도 쓸 수 없습니다.")
    if output.exists() and not force:
        raise FileExistsError(f"출력이 이미 있습니다：{output}。업데이트하려면 다음을 더하세요: --force，유지하려면 다음을 쓰세요: --output 다른 경로를 쓰세요")
    template = embed_local_files(TEMPLATE.read_text(encoding="utf-8"), TEMPLATE.parent, SKILL_ROOT, inputs)
    skill_file = SKILL_ROOT / "SKILL.md"
    skill = skill_file.read_text(encoding="utf-8") if skill_file.is_file() else ""
    data["edition"] = "pro" if re.search(r"^name:\s*jstyle-pro\s*$", skill, re.MULTILINE) else "open"
    if template.count(MARKER) != 1:
        raise ValueError("템플릿 데이터 입구가 없거나 겹칩니다")
    if template.count(CONNECT_CSP) != 1:
        raise ValueError("템플릿 연결 정책 입구가 없거나 겹칩니다")
    origins = set()
    for candidate in data["candidates"]:
        if candidate["kind"] == "url":
            parts = urlsplit(candidate["content"])
            # Browsers reject IPv6 literals in CSP source lists; probe their loopback alias.
            host = "localhost" if parts.hostname == "::1" else parts.hostname.lower()
            port = f":{parts.port}" if parts.port is not None else ""
            origins.add(f"{parts.scheme}://{host}{port}")
    connect_csp = "connect-src " + (" ".join(sorted(origins)) if origins else "'none'")
    # A closing script tag in metadata or a nested candidate cannot escape the container.
    payload = json.dumps(data, ensure_ascii=False).replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    page = template.replace(CONNECT_CSP, connect_csp).replace(MARKER, payload)
    output.parent.mkdir(parents=True, exist_ok=True)
    if force:
        temp = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=output.parent, delete=False) as handle:
                temp = Path(handle.name)
                handle.write(page)
            temp.replace(output)
        finally:
            if temp and temp.exists():
                temp.unlink()
    else:
        with output.open("x", encoding="utf-8") as handle:
            handle.write(page)
    if origins and "serve" not in data:
        print("안내: 로컬 URL을 쓰는 안이 있습니다. manifest의 serve에 실행 방법을 적으면 나중에 비교 화면을 다시 열기 쉽습니다.", file=sys.stderr)
    return {"output": str(output), "candidates": len(data["candidates"]), "fingerprint": data["fingerprint"], "bytes": output.stat().st_size}


HELP_EPILOG = """\
사용법:
  python3 build_explorer.py <비교할 파일 폴더>
  python3 build_explorer.py a.html b.html c.html
  python3 build_explorer.py manifest.json
기본 출력은 입력 옆 style-explorer.html입니다. --force는 덮어쓰기, --output은 다른 경로입니다.

가장 작은 manifest:
  {"candidates": [{"source": "a.html"}, {"source": "b.html"}]}
source는 필수입니다. 이름은 HTML title이나 파일 이름을 씁니다.
concept/typography/palette/traits는 설명을 더하며 비우면 보이지 않습니다.

선택 필드:
  schemaVersion: 기본 1
  lang: ko 또는 en. 비교 도구의 언어이며 기본은 브라우저 언어입니다.
  round: 복사 문구에 들어갈 회차
  nativeViewport: 1920x1080, 1920×1080 또는 {"width":1920,"height":1080}
    전체나 개별 안에 둘 수 있습니다. 기본 desktop1280×900, mobile390×844입니다.
  kind: html, image(PNG/JPEG/WebP), url. url은 source 대신 url을 씁니다.
    localhost, 127.0.0.1, ::1의 개발 서버만 받을 수 있습니다.
  serve: {"command":"실행 명령", "cwd":"프로젝트 절대 경로", "url":"서비스 주소"}
  interactive: 움직이는 단일 HTML. 스크립트는 안에 넣고 외부 통신·파일을 읽지 않습니다.
    저장소는 닫은 뒤 비우며 alert/confirm 대신 페이지 안 대화상자를 씁니다.
  baseline: 기존 화면을 첫 항목으로 보입니다. 한 회차에 최대 하나입니다.

source는 manifest 폴더를 기준으로 읽으며 이미지·글꼴·영상·CSS·스크립트는 참조한 파일 기준입니다.
로컬 절대 경로와 폴더 밖 파일도 안에 넣을 수 있습니다. 네트워크 파일은 받지 않습니다.
파일마다 최대 20 MiB, 전체 최대 100 MiB입니다. head가 없으면 보완합니다.
정지 HTML은 스크립트 없이 내용이 보여야 합니다. img srcset은 src 또는 가장 넓은 한 장만 씁니다.
iframe/object/embed/picture source 대신 로컬 img 한 장이나 스크린샷을 씁니다.
id는 소문자·숫자·하이픈·밑줄로 적고 겹치지 않습니다. palette는 색 값 배열을 권합니다.

Python 3.10 이상이 필요합니다. 스킬 설치 폴더에는 결과를 쓰지 않습니다.
스킬을 바꿔도 이미 만든 비교 화면은 바뀌지 않습니다. 원래 manifest로 --force를 실행합니다.
모든 입력 문제를 한 번에 알리며 실패하면 기존 결과를 고치지 않습니다.
성공은 output/candidates/fingerprint/bytes가 담긴 JSON 한 줄입니다.
"""


def utf8_output() -> None:
    """파이프의 다른 쪽 Agent 기준: UTF-8 읽기；콘솔의 문자 인코딩이 한국어를 지원하지 않을 수 있습니다。"""
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure") and not stream.isatty():
            stream.reconfigure(encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    utf8_output()
    if sys.version_info < (3, 10):
        print("필요 Python 3.10 새 버전 이상", file=sys.stderr)
        return 2
    parser = argparse.ArgumentParser(description="디자인 안을 오프라인 비교 화면으로 모읍니다",
                                     epilog=HELP_EPILOG, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("inputs", type=Path, nargs="+", help="비교할 폴더, HTML 파일 또는 manifest.json")
    parser.add_argument("--output", type=Path, help="만들 HTML 경로. 기본은 입력 옆의 style-explorer.html입니다.")
    parser.add_argument("--force", action="store_true", help="이미 있는 출력 파일 덮어쓰기")
    args = parser.parse_args(argv)
    first = args.inputs[0].resolve()
    output_dir = first if first.is_dir() else first.parent
    output = args.output or output_dir / "style-explorer.html"
    try:
        print(json.dumps(build(args.inputs, output, force=args.force), ensure_ascii=False))
        return 0
    except (OSError, ValueError, TypeError) as exc:
        print(f"비교 화면을 만들지 못했습니다：{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
