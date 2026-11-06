import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { HTMLParser, unescape } from "../scripts/lib/html-parser.mjs";

const golden = JSON.parse(readFileSync(new URL("./fixtures/html-parser-golden.json", import.meta.url), "utf8"));

class Recorder extends HTMLParser {
  events = [];

  where() {
    const [line, column] = this.getpos();
    return [line, column, this.index];
  }

  record(...event) {
    this.events.push([...event, ...this.where()]);
  }

  handleStarttag(tag, attrs) {
    this.record("starttag", tag, attrs, this.getStarttagText());
  }

  handleStartendtag(tag, attrs) {
    this.record("startendtag", tag, attrs, this.getStarttagText());
  }

  handleEndtag(tag) { this.record("endtag", tag); }
  handleData(data) { this.record("data", data); }
  handleComment(data) { this.record("comment", data); }
  handleDecl(decl) { this.record("decl", decl); }
  handlePi(data) { this.record("pi", data); }
  unknownDecl(data) { this.record("unknown_decl", data); }
  handleCharref(name) { this.record("charref", name); }
  handleEntityref(name) { this.record("entityref", name); }
}

test(`matches CPython ${golden.python} events, positions and leftover buffer`, () => {
  for (const item of golden.cases) {
    const parser = new Recorder({ convertCharrefs: item.convertCharrefs, scripting: item.scripting });
    for (const chunk of item.chunks) parser.feed(chunk);
    if (item.close) parser.close();
    const label = `${item.name} convert=${item.convertCharrefs} close=${item.close}: ${JSON.stringify(item.chunks.join(""))}`;
    assert.deepEqual(parser.events, item.events, label);
    assert.equal(parser.rawdata, item.rest, label);
    assert.deepEqual(parser.where(), item.pos, label);
  }
});

test("default startendtag dispatches start then end", () => {
  const seen = [];
  const parser = new (class extends HTMLParser {
    handleStarttag(tag, attrs) { seen.push(["start", tag, attrs]); }
    handleEndtag(tag) { seen.push(["end", tag]); }
  })();
  parser.feed('<br/><img alt=x />');
  assert.deepEqual(seen, [["start", "br", []], ["end", "br"], ["start", "img", [["alt", "x"]]], ["end", "img"]]);
});

test("start tag text and index locate the source for splicing", () => {
  const html = '😀\n<link rel="stylesheet" href="a.css">';
  const found = [];
  const parser = new (class extends HTMLParser {
    handleStarttag() { found.push([this.index, this.getStarttagText()]); }
  })();
  parser.feed(html);
  const [[index, text]] = found;
  assert.equal(html.slice(index, index + text.length), text);
});

test("unescape follows html.unescape for named, numeric and invalid references", () => {
  assert.equal(unescape("&amp;&lt&notit;&ampx&#65;&#x42;&#0;&#128;&#xD800;&#1114112;&#1;"), "&<¬it;&x" + "AB�€��");
  assert.equal(unescape("no refs"), "no refs");
});
