'use strict';
// Minimal XML reader. Enough for SVG: elements, attributes, nesting, comments,
// CDATA, processing instructions, DOCTYPE (including an internal subset).
// Returns a tree of { name, attrs, children, text }. Namespace prefixes are
// kept on `qname` and stripped from `name`.

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X'
        ? parseInt(e.slice(2), 16)
        : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENT[e] !== undefined ? ENT[e] : m;
  });
}

function parseAttrs(src) {
  const attrs = {};
  const re = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'<>`]+))/g;
  let m;
  while ((m = re.exec(src))) {
    const raw = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5];
    attrs[m[1]] = decode(raw);
  }
  return attrs;
}

function parseXML(src) {
  const root = { name: '#root', qname: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  let i = 0;
  const n = src.length;

  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      const tail = src.slice(i);
      if (tail.trim()) stack[stack.length - 1].text += decode(tail);
      break;
    }
    if (lt > i) {
      const txt = src.slice(i, lt);
      if (txt.trim()) stack[stack.length - 1].text += decode(txt);
    }

    if (src.startsWith('<!--', lt)) {
      const e = src.indexOf('-->', lt + 4);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const e = src.indexOf(']]>', lt + 9);
      const body = src.slice(lt + 9, e < 0 ? n : e);
      stack[stack.length - 1].text += body;
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (src.startsWith('<?', lt)) {
      const e = src.indexOf('?>', lt + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (src.startsWith('<!', lt)) {
      // DOCTYPE, possibly with an internal subset in brackets
      let j = lt + 2, depth = 0;
      while (j < n) {
        const c = src[j];
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
        j++;
      }
      i = j + 1;
      continue;
    }

    const gt = src.indexOf('>', lt);
    if (gt < 0) break;
    let inner = src.slice(lt + 1, gt);

    if (inner[0] === '/') {
      const qname = inner.slice(1).trim();
      const name = qname.includes(':') ? qname.split(':').pop() : qname;
      // pop to the matching open tag, tolerating mismatches
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) { stack.length = k; break; }
      }
      i = gt + 1;
      continue;
    }

    const selfClose = inner.endsWith('/');
    if (selfClose) inner = inner.slice(0, -1);
    const sp = inner.search(/[\s/]/);
    const qname = (sp < 0 ? inner : inner.slice(0, sp)).trim();
    const name = qname.includes(':') ? qname.split(':').pop() : qname;
    const node = {
      name,
      qname,
      attrs: sp < 0 ? {} : parseAttrs(inner.slice(sp)),
      children: [],
      text: '',
    };
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
    i = gt + 1;
  }
  return root;
}

function find(node, name) {
  if (node.name === name) return node;
  for (const c of node.children) {
    const r = find(c, name);
    if (r) return r;
  }
  return null;
}

module.exports = { parseXML, find, decode };
