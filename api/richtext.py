"""Allowlist sanitizer for text-box HTML (Phase 8b rich text boxes).

Text boxes are edited in the browser with contentEditable, which produces
HTML -- and the dashboard renders that HTML back. Everything stored goes
through here first, so a text box can only ever contain formatting markup:
a fixed set of tags, no attributes except a filtered `style`, and only
typographic CSS properties with conservative values. Scripts, event
handlers, links, images, iframes and `url(...)` are all dropped.

stdlib `html.parser` only -- no new dependency for a few dozen lines.
"""

import html
import re
from html.parser import HTMLParser

ALLOWED_TAGS = {"div", "p", "br", "span", "b", "strong", "i", "em", "u", "s", "strike", "ul", "ol", "li", "h1", "h2", "h3"}
VOID_TAGS = {"br"}
# Content of these is dropped entirely, not just the tags.
DROP_CONTENT = {"script", "style", "iframe", "object", "embed", "template", "noscript", "svg", "math"}

ALLOWED_STYLE_PROPS = {
    "font-weight",
    "font-style",
    "text-decoration",
    "text-decoration-line",
    "color",
    "background-color",
    "font-size",
    "font-family",
    "text-align",
}
# Colors, sizes, keywords, quoted font names. Anything with parentheses other
# than rgb()/rgba(), backslashes, or "url"/"expression" fails.
_SAFE_VALUE = re.compile(
    r"^(?:[#\w\s.,%'\"-]+"
    r"|rgba?\(\s*[\d.\s,%]+\)"
    # per-selection font family: the app's own next/font CSS variables only
    r"|var\(--font-[a-z-]+\)(?:\s*,\s*[\w\s-]+)?)$"
)
_BANNED = re.compile(r"url|expression|javascript|@import|\\", re.IGNORECASE)


def _clean_style(style: str) -> str:
    out = []
    for decl in style.split(";"):
        if ":" not in decl:
            continue
        prop, value = (p.strip() for p in decl.split(":", 1))
        prop = prop.lower()
        if "var(" in value and prop != "font-family":
            continue
        if prop in ALLOWED_STYLE_PROPS and value and _SAFE_VALUE.match(value) and not _BANNED.search(value):
            out.append(f"{prop}: {value}")
    return "; ".join(out)


class _Sanitizer(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self.open: list[str] = []
        self.dropping = 0

    def handle_starttag(self, tag, attrs):
        if tag in DROP_CONTENT:
            self.dropping += 1
            return
        if self.dropping or tag not in ALLOWED_TAGS:
            return
        style = next((v for k, v in attrs if k == "style" and v), None)
        clean = _clean_style(style) if style else ""
        attr = f' style="{html.escape(clean, quote=True)}"' if clean else ""
        self.out.append(f"<{tag}{attr}>")
        if tag not in VOID_TAGS:
            self.open.append(tag)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        if tag in DROP_CONTENT:
            self.dropping = max(0, self.dropping - 1)
            return
        if self.dropping or tag not in ALLOWED_TAGS or tag in VOID_TAGS or tag not in self.open:
            return
        # close anything left open inside it, keeping the output well-formed
        while self.open:
            t = self.open.pop()
            self.out.append(f"</{t}>")
            if t == tag:
                break

    def handle_data(self, data):
        if not self.dropping:
            self.out.append(html.escape(data, quote=False))


def sanitize_html(source: str) -> str:
    p = _Sanitizer()
    p.feed(source)
    p.close()
    while p.open:
        p.out.append(f"</{p.open.pop()}>")
    return "".join(p.out)
