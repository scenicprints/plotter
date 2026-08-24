// Hand the built exe to another machine on the network.
//
//     npm run serve            (then open the printed URL on the other PC)
//
// Plain Node, no dependencies, nothing installed anywhere. It serves ONLY the
// files it lists, read-only, on the local network. Stop it with Ctrl+C.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 8099;
const DIST = path.join(__dirname, 'dist');
const FILES = ['Plotter.exe'];

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push({ name, address: ni.address });
    }
  }
  return out;
}

const human = (n) => (n < 1024 ? `${n} B`
  : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB`
  : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB`
  : `${(n / 1024 ** 3).toFixed(2)} GB`);

function sha256(file) {
  return new Promise((res, rej) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d))
      .on('end', () => res(h.digest('hex'))).on('error', rej);
  });
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function page(items) {
  const rows = items.map((f) => `
      <a class="row" href="/${encodeURIComponent(f.name)}" download>
        <span class="nm">${esc(f.name)}</span>
        <span class="sz">${esc(f.size)}</span>
        <span class="dl">Download</span>
      </a>
      <div class="meta">built ${esc(f.built)} &middot; sha256 ${esc(f.sha)}</div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Plotter download</title><style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  background:#181613;color:#EFE9DE;font:15px/1.6 "Segoe UI",system-ui,sans-serif}
.card{width:min(560px,92vw);background:#211E19;border:1px solid #37312A;border-radius:14px;padding:26px 24px}
h1{margin:0 0 4px;font-size:19px;letter-spacing:.2px}
p.sub{margin:0 0 20px;color:#A2988A;font-size:13px}
.row{display:flex;align-items:center;gap:14px;text-decoration:none;color:inherit;
  border:1px solid #4A4338;border-radius:10px;padding:13px 15px;background:#282420}
.row:hover{border-color:#E0A15A}
.nm{flex:1;font-family:Consolas,ui-monospace,monospace;font-size:14px}
.sz{color:#A2988A;font-size:13px}
.dl{color:#181613;background:#E0A15A;border-radius:7px;padding:5px 13px;font-size:13px;font-weight:600}
.meta{color:#7C7365;font-size:11px;font-family:Consolas,ui-monospace,monospace;
  margin:8px 2px 18px;word-break:break-all}
.note{color:#7C7365;font-size:12px;border-top:1px solid #37312A;padding-top:14px;margin-top:4px}
</style></head><body><div class="card">
<h1>Plotter</h1>
<p class="sub">CR-6 SE pen plotter control. Portable, no install.</p>
${rows}
<div class="note">Windows will warn that it is from an unknown publisher, because it
is not code-signed. Choose More info, then Run anyway.</div>
</div></body></html>`;
}

(async () => {
  const items = [];
  for (const name of FILES) {
    const file = path.join(DIST, name);
    if (!fs.existsSync(file)) {
      console.error(`  ${name} is not built yet. Run: npm run dist`);
      process.exit(1);
    }
    const st = fs.statSync(file);
    items.push({
      name,
      file,
      bytes: st.size,
      size: human(st.size),
      built: st.mtime.toISOString().slice(0, 16).replace('T', ' '),
      sha: await sha256(file),
    });
  }

  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    if (url === '/' || url === '/index.html') {
      const body = page(items);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(body);
    }
    // Serve only what is listed. No path joining from user input, so there is
    // nothing to traverse out of.
    const item = items.find((f) => '/' + f.name === url);
    if (!item) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }

    const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    let start = 0, end = item.bytes - 1, code = 200;
    const head = {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${item.name}"`,
      'accept-ranges': 'bytes',
    };
    if (range) {
      // Resume support matters: this is ~90 MB over Wi-Fi.
      start = range[1] ? parseInt(range[1], 10) : 0;
      end = range[2] ? parseInt(range[2], 10) : item.bytes - 1;
      if (!(start <= end && end < item.bytes)) {
        res.writeHead(416, { 'content-range': `bytes */${item.bytes}` });
        return res.end();
      }
      code = 206;
      head['content-range'] = `bytes ${start}-${end}/${item.bytes}`;
    }
    head['content-length'] = end - start + 1;
    res.writeHead(code, head);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(item.file, { start, end }).pipe(res);
    console.log(`  -> ${req.socket.remoteAddress} ${item.name} ${code === 206 ? `${start}-${end}` : 'full'}`);
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log('\n  Serving ' + DIST);
    for (const f of items) console.log(`    ${f.name}  ${f.size}  sha256 ${f.sha}`);
    console.log('\n  Open one of these on the other computer:');
    for (const a of lanAddresses()) console.log(`    http://${a.address}:${PORT}/     (${a.name})`);
    console.log('\n  Ctrl+C to stop. If the other PC cannot connect, allow Node.js');
    console.log('  through Windows Firewall on a private network.\n');
  });
})();
