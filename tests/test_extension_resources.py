"""Check that the independent skill remains usable after relocation."""

from html.parser import HTMLParser
from pathlib import Path
import json
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ResourceParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.targets = []
        self.ids = set()

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if "id" in values:
            self.ids.add(values["id"])
        for key in ("href", "src"):
            if key in values:
                self.targets.append(values[key])


class ExtensionResourcesTests(unittest.TestCase):
    def test_skill_references_resolve_without_installation_paths(self):
        sources = [ROOT / "SKILL.md", *sorted((ROOT / "references/extended").glob("*.md"))]
        for source in sources:
            for target in re.findall(r"\]\(([^)]+)\)", source.read_text(encoding="utf-8")):
                if "://" in target:
                    continue
                with self.subTest(source=source.name, target=target):
                    resolved = (source.parent / target.split("#", 1)[0]).resolve()
                    self.assertTrue(resolved.is_relative_to(ROOT))
                    self.assertTrue(resolved.is_file())

    def test_packaged_text_has_no_han_characters(self):
        package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        paths = set()
        for pattern in package["files"]:
            for path in ROOT.glob(pattern):
                paths.update(path.rglob("*") if path.is_dir() else [path])
        for path in sorted(paths):
            if not path.is_file():
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                continue
            match = re.search(r"[\u3400-\u4dbf\u4e00-\u9fff]", text)
            with self.subTest(path=str(path.relative_to(ROOT))):
                self.assertIsNone(match, "Use Korean or English in packaged text")

    def test_library_resources_and_navigation_resolve(self):
        source = ROOT / "assets/extended/index.html"
        parser = ResourceParser()
        parser.feed(source.read_text(encoding="utf-8"))
        for target in parser.targets:
            with self.subTest(target=target):
                if target.startswith("#"):
                    self.assertIn(target[1:], parser.ids)
                else:
                    self.assertNotIn("://", target)
                    resolved = (source.parent / target).resolve()
                    self.assertTrue(resolved.is_relative_to(ROOT))
                    self.assertTrue(resolved.is_file())


if __name__ == "__main__":
    unittest.main()
