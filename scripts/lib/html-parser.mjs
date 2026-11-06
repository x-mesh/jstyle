// Port of CPython 3.13.13 html.parser.HTMLParser and html.unescape.
// build_explorer splices edits into the original text at the offsets this
// parser reports, so tokenizing and positions must match the Python parser
// exactly; a spec tree parser would insert implied tags and move offsets.
// Offsets count UTF-16 code units, so they index JavaScript strings directly.
import { readFileSync } from "node:fs";

import { pyStrip } from "./pycompat.mjs";

const HTML5 = JSON.parse(readFileSync(new URL("./html-entities.json", import.meta.url), "utf8"));

const INVALID_CHARREFS = new Map([
  [0x00, "�"], [0x0d, "\r"], [0x80, "€"], [0x81, "\x81"], [0x82, "‚"], [0x83, "ƒ"],
  [0x84, "„"], [0x85, "…"], [0x86, "†"], [0x87, "‡"], [0x88, "ˆ"], [0x89, "‰"],
  [0x8a, "Š"], [0x8b, "‹"], [0x8c, "Œ"], [0x8d, "\x8d"], [0x8e, "Ž"], [0x8f, "\x8f"],
  [0x90, "\x90"], [0x91, "‘"], [0x92, "’"], [0x93, "“"], [0x94, "”"], [0x95, "•"],
  [0x96, "–"], [0x97, "—"], [0x98, "˜"], [0x99, "™"], [0x9a, "š"], [0x9b, "›"],
  [0x9c, "œ"], [0x9d, "\x9d"], [0x9e, "ž"], [0x9f, "Ÿ"],
]);

const INVALID_CODEPOINTS = new Set([
  0x1, 0x2, 0x3, 0x4, 0x5, 0x6, 0x7, 0x8, 0xb, 0xe, 0xf,
  ...range(0x10, 0x1f), ...range(0x7f, 0x9f), ...range(0xfdd0, 0xfdef), 0xfffe, 0xffff,
  ...range(1, 0x10).flatMap((plane) => [plane * 0x10000 + 0xfffe, plane * 0x10000 + 0xffff]),
]);

function range(first, last) {
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

const CHARREF = /&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/gu;

function replaceCharref(_, ref) {
  if (ref[0] === "#") {
    const digits = ref.replace(/;$/, "");
    const num = digits[1] === "x" || digits[1] === "X" ? parseInt(digits.slice(2), 16) : parseInt(digits.slice(1), 10);
    if (INVALID_CHARREFS.has(num)) return INVALID_CHARREFS.get(num);
    if ((num >= 0xd800 && num <= 0xdfff) || num > 0x10ffff) return "�";
    if (INVALID_CODEPOINTS.has(num)) return "";
    return String.fromCodePoint(num);
  }
  if (Object.hasOwn(HTML5, ref)) return HTML5[ref];
  const chars = Array.from(ref);
  for (let length = chars.length - 1; length > 1; length -= 1) {
    const prefix = chars.slice(0, length).join("");
    if (Object.hasOwn(HTML5, prefix)) return HTML5[prefix] + chars.slice(length).join("");
  }
  return "&" + ref;
}

export function unescape(text) {
  return text.includes("&") ? text.replace(CHARREF, replaceCharref) : text;
}

const ATTR_CHARREF = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*)[;=]?/g;

function unescapeAttrValue(value) {
  return value.replace(ATTR_CHARREF, (ref) => {
    if (ref.startsWith("&#")) return unescape(ref);
    if (!ref.endsWith("=") && Object.hasOwn(HTML5, ref.slice(1))) return unescape(ref);
    return ref;
  });
}

const INTERESTING_NORMAL = /[&<]/g;
const INCOMPLETE = /&[a-zA-Z#]/y;
const ENTITYREF = /&([a-zA-Z][-.a-zA-Z0-9]*)[^a-zA-Z0-9]/y;
const CHARREF_TOKEN = /&#(?:[0-9]+|[xX][0-9a-fA-F]+)[^0-9a-fA-F]/y;
const INCOMPLETE_CHARREF = /&#(?:[0-9]|[xX][0-9a-fA-F])/y;
const STARTTAGOPEN = /<[a-zA-Z]/y;
const ENDTAGOPEN = /<\/[a-zA-Z]/y;
const PICLOSE = />/g;
const COMMENTCLOSE = /--!?>/g;
const COMMENTABRUPTCLOSE = /-?>/y;
const AMP_END = /[\t\n\r\f ;]/g;
const TAGFIND_TOLERANT = /([a-zA-Z][^\t\n\r\f />]*)(?:[\t\n\r\f ]|\/(?!>))*/y;
const ATTRFIND_TOLERANT = /((?<=['"\t\n\r\f /])[^\t\n\r\f />][^\t\n\r\f /=>]*)([\t\n\r\f ]*=[\t\n\r\f ]*('[^']*'|"[^"]*"|(?!['"])[^>\t\n\r\f ]*))?(?:[\t\n\r\f ]|\/(?!>))*/y;
const LOCATETAGEND = /[a-zA-Z][^\t\n\r\f />]*[\t\n\r\f /]*(?:(?<=['"\t\n\r\f /])[^\t\n\r\f />][^\t\n\r\f /=>]*(?:[\t\n\r\f ]*=[\t\n\r\f ]*(?:'[^']*'|"[^"]*"|(?!['"])[^>\t\n\r\f ]*))?[\t\n\r\f /]*)*>?/y;

function matchAt(pattern, text, index) {
  pattern.lastIndex = index;
  return pattern.exec(text);
}

const searchFrom = matchAt;

export class HTMLParser {
  static CDATA_CONTENT_ELEMENTS = ["script", "style", "xmp", "iframe", "noembed", "noframes"];
  static RCDATA_CONTENT_ELEMENTS = ["textarea", "title"];

  #starttagText = null;

  constructor({ convertCharrefs = true, scripting = false } = {}) {
    this.convertCharrefs = convertCharrefs;
    this.scripting = scripting;
    this.reset();
  }

  reset() {
    this.rawdata = "";
    this.lasttag = "???";
    this.interesting = INTERESTING_NORMAL;
    this.cdataElem = null;
    this.supportCdata = true;
    this.escapable = true;
    this.lineno = 1;
    this.offset = 0;
    this.index = 0;
  }

  feed(data) {
    this.rawdata += data;
    this.goahead(false);
  }

  close() {
    this.goahead(true);
  }

  getpos() {
    return [this.lineno, this.offset];
  }

  getStarttagText() {
    return this.#starttagText;
  }

  setCdataMode(elem, { escapable = false } = {}) {
    this.cdataElem = elem.toLowerCase();
    this.escapable = escapable;
    if (this.cdataElem === "plaintext") {
      this.interesting = /$/g;
    } else if (escapable && !this.convertCharrefs) {
      this.interesting = new RegExp(`&|</${this.cdataElem}(?=[\\t\\n\\r\\f />])`, "gi");
    } else {
      this.interesting = new RegExp(`</${this.cdataElem}(?=[\\t\\n\\r\\f />])`, "gi");
    }
  }

  clearCdataMode() {
    this.interesting = INTERESTING_NORMAL;
    this.cdataElem = null;
    this.escapable = true;
  }

  setSupportCdata(flag = true) {
    this.supportCdata = flag;
  }

  updatepos(i, j) {
    if (i >= j) return j;
    const rawdata = this.rawdata;
    let newlines = 0;
    let last = -1;
    for (let at = rawdata.indexOf("\n", i); at !== -1 && at < j; at = rawdata.indexOf("\n", at + 1)) {
      newlines += 1;
      last = at;
    }
    if (newlines) {
      this.lineno += newlines;
      this.offset = j - (last + 1);
    } else {
      this.offset += j - i;
    }
    this.index += j - i;
    return j;
  }

  goahead(end) {
    const rawdata = this.rawdata;
    let i = 0;
    const n = rawdata.length;
    while (i < n) {
      let j;
      if (this.convertCharrefs && !this.cdataElem) {
        j = rawdata.indexOf("<", i);
        if (j < 0) {
          const amppos = rawdata.lastIndexOf("&");
          if (amppos >= Math.max(i, n - 34) && !searchFrom(AMP_END, rawdata, amppos)) break;
          j = n;
        }
      } else {
        const match = searchFrom(this.interesting, rawdata, i);
        if (match) {
          j = match.index;
        } else {
          if (this.cdataElem) break;
          j = n;
        }
      }
      if (i < j) {
        this.handleData(this.convertCharrefs && this.escapable ? unescape(rawdata.slice(i, j)) : rawdata.slice(i, j));
      }
      i = this.updatepos(i, j);
      if (i === n) break;
      if (rawdata.startsWith("<", i)) {
        let k;
        if (matchAt(STARTTAGOPEN, rawdata, i)) k = this.parseStarttag(i);
        else if (rawdata.startsWith("</", i)) k = this.parseEndtag(i);
        else if (rawdata.startsWith("<!--", i)) k = this.parseComment(i);
        else if (rawdata.startsWith("<?", i)) k = this.parsePi(i);
        else if (rawdata.startsWith("<!", i)) k = this.parseHtmlDeclaration(i);
        else if (i + 1 < n || end) {
          this.handleData("<");
          k = i + 1;
        } else break;
        if (k < 0) {
          if (!end) break;
          if (matchAt(STARTTAGOPEN, rawdata, i)) {
            // An unterminated start tag at EOF is dropped, as in CPython.
          } else if (rawdata.startsWith("</", i)) {
            if (i + 2 === n) this.handleData("</");
            else if (!matchAt(ENDTAGOPEN, rawdata, i)) this.handleComment(rawdata.slice(i + 2));
          } else if (rawdata.startsWith("<!--", i)) {
            let stop = n;
            const tail = rawdata.slice(i + 4);
            for (const suffix of ["--!", "--", "-"]) {
              if (tail.endsWith(suffix)) {
                stop -= suffix.length;
                break;
              }
            }
            this.handleComment(rawdata.slice(i + 4, stop));
          } else if (rawdata.startsWith("<![CDATA[", i) && this.supportCdata) {
            this.unknownDecl(rawdata.slice(i + 3));
          } else if (rawdata.slice(i, i + 9).toLowerCase() === "<!doctype") {
            this.handleDecl(rawdata.slice(i + 2));
          } else if (rawdata.startsWith("<!", i)) {
            this.handleComment(rawdata.slice(i + 2));
          } else if (rawdata.startsWith("<?", i)) {
            this.handlePi(rawdata.slice(i + 2));
          } else {
            throw new Error("we should not get here!");
          }
          k = n;
        }
        i = this.updatepos(i, k);
      } else if (rawdata.startsWith("&#", i)) {
        let match = matchAt(CHARREF_TOKEN, rawdata, i);
        if (match) {
          this.handleCharref(match[0].slice(2, -1));
          let k = i + match[0].length;
          if (rawdata[k - 1] !== ";") k -= 1;
          i = this.updatepos(i, k);
          continue;
        }
        match = matchAt(INCOMPLETE_CHARREF, rawdata, i);
        if (match) {
          if (end) {
            this.handleCharref(rawdata.slice(i + 2));
            i = this.updatepos(i, n);
          }
          break;
        } else if (i + 3 < n) {
          this.handleData("&#");
          i = this.updatepos(i, i + 2);
        } else break;
      } else if (rawdata.startsWith("&", i)) {
        let match = matchAt(ENTITYREF, rawdata, i);
        if (match) {
          this.handleEntityref(match[1]);
          let k = i + match[0].length;
          if (rawdata[k - 1] !== ";") k -= 1;
          i = this.updatepos(i, k);
          continue;
        }
        match = matchAt(INCOMPLETE, rawdata, i);
        if (match) {
          if (end) {
            this.handleEntityref(rawdata.slice(i + 1));
            i = this.updatepos(i, n);
          }
          break;
        } else if (i + 1 < n) {
          this.handleData("&");
          i = this.updatepos(i, i + 1);
        } else break;
      } else {
        throw new Error("interesting.search() lied");
      }
    }
    if (end && i < n) {
      this.handleData(this.convertCharrefs && this.escapable ? unescape(rawdata.slice(i, n)) : rawdata.slice(i, n));
      i = this.updatepos(i, n);
    }
    this.rawdata = rawdata.slice(i);
  }

  parseHtmlDeclaration(i) {
    const rawdata = this.rawdata;
    if (rawdata.startsWith("<!--", i)) return this.parseComment(i);
    if (rawdata.startsWith("<![CDATA[", i) && this.supportCdata) {
      const j = rawdata.indexOf("]]>", i + 9);
      if (j < 0) return -1;
      this.unknownDecl(rawdata.slice(i + 3, j));
      return j + 3;
    }
    if (rawdata.slice(i, i + 9).toLowerCase() === "<!doctype") {
      const gtpos = rawdata.indexOf(">", i + 9);
      if (gtpos === -1) return -1;
      this.handleDecl(rawdata.slice(i + 2, gtpos));
      return gtpos + 1;
    }
    return this.parseBogusComment(i);
  }

  parseComment(i, report = true) {
    const rawdata = this.rawdata;
    let match = searchFrom(COMMENTCLOSE, rawdata, i + 4);
    if (!match) {
      match = matchAt(COMMENTABRUPTCLOSE, rawdata, i + 4);
      if (!match) return -1;
    }
    if (report) this.handleComment(rawdata.slice(i + 4, match.index));
    return match.index + match[0].length;
  }

  parseBogusComment(i, report = true) {
    const rawdata = this.rawdata;
    const pos = rawdata.indexOf(">", i + 2);
    if (pos === -1) return -1;
    if (report) this.handleComment(rawdata.slice(i + 2, pos));
    return pos + 1;
  }

  parsePi(i) {
    const rawdata = this.rawdata;
    const match = searchFrom(PICLOSE, rawdata, i + 2);
    if (!match) return -1;
    this.handlePi(rawdata.slice(i + 2, match.index));
    return match.index + 1;
  }

  parseStarttag(i) {
    this.#starttagText = null;
    const endpos = this.checkForWholeStartTag(i);
    if (endpos < 0) return endpos;
    const rawdata = this.rawdata;
    this.#starttagText = rawdata.slice(i, endpos);

    const attrs = [];
    const match = matchAt(TAGFIND_TOLERANT, rawdata, i + 1);
    let k = i + 1 + match[0].length;
    const tag = match[1].toLowerCase();
    this.lasttag = tag;
    while (k < endpos) {
      const m = matchAt(ATTRFIND_TOLERANT, rawdata, k);
      if (!m) break;
      const [, attrname, rest] = m;
      let attrvalue = m[3];
      if (!rest) {
        attrvalue = null;
      } else if ((attrvalue[0] === "'" && attrvalue.at(-1) === "'") || (attrvalue[0] === '"' && attrvalue.at(-1) === '"')) {
        attrvalue = attrvalue.slice(1, -1);
      }
      if (attrvalue) attrvalue = unescapeAttrValue(attrvalue);
      attrs.push([attrname.toLowerCase(), attrvalue]);
      k += m[0].length;
    }

    const tail = pyStrip(rawdata.slice(k, endpos));
    if (tail !== ">" && tail !== "/>") {
      this.handleData(rawdata.slice(i, endpos));
      return endpos;
    }
    if (tail.endsWith("/>")) {
      this.handleStartendtag(tag, attrs);
    } else {
      this.handleStarttag(tag, attrs);
      if (HTMLParser.CDATA_CONTENT_ELEMENTS.includes(tag) || (this.scripting && tag === "noscript") || tag === "plaintext") {
        this.setCdataMode(tag, { escapable: false });
      } else if (HTMLParser.RCDATA_CONTENT_ELEMENTS.includes(tag)) {
        this.setCdataMode(tag, { escapable: true });
      }
    }
    return endpos;
  }

  checkForWholeStartTag(i) {
    const rawdata = this.rawdata;
    const match = matchAt(LOCATETAGEND, rawdata, i + 1);
    const j = i + 1 + match[0].length;
    return rawdata[j - 1] === ">" ? j : -1;
  }

  parseEndtag(i) {
    const rawdata = this.rawdata;
    if (rawdata.indexOf(">", i + 2) < 0) return -1;
    if (!matchAt(ENDTAGOPEN, rawdata, i)) {
      if (rawdata[i + 2] === ">") return i + 3;
      return this.parseBogusComment(i);
    }
    const located = matchAt(LOCATETAGEND, rawdata, i + 2);
    const j = i + 2 + located[0].length;
    if (rawdata[j - 1] !== ">") return -1;
    const tag = matchAt(TAGFIND_TOLERANT, rawdata, i + 2)[1].toLowerCase();
    this.handleEndtag(tag);
    this.clearCdataMode();
    return j;
  }

  handleStartendtag(tag, attrs) {
    this.handleStarttag(tag, attrs);
    this.handleEndtag(tag);
  }

  handleStarttag() {}
  handleEndtag() {}
  handleCharref() {}
  handleEntityref() {}
  handleData() {}
  handleComment() {}
  handleDecl() {}
  handlePi() {}
  unknownDecl() {}
}
