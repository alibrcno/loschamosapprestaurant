// Imita a Vercel en local: /api/* → .build/api/*.js (exporta GET/POST…), lo demás desde public/
const http = require('http'), fs = require('fs'), path = require('path');
const RAIZ = process.argv[2];
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    const archivo = path.join(RAIZ, '.build', 'api', 'index.js');
    const fn = require(archivo)[req.method];
    if (!fn) { res.writeHead(405); return res.end('{}'); }
    const cuerpo = await new Promise((ok) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => ok(b)); });
    const r = await fn(new Request('http://localhost' + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : cuerpo }));
    res.writeHead(r.status, Object.fromEntries(r.headers)); return res.end(await r.text());
  }
  const f = path.join(RAIZ, 'public', url.pathname === '/' ? 'index.html' : url.pathname);
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html; charset=utf-8' : f.endsWith('.css') ? 'text/css' : 'text/javascript' });
  fs.createReadStream(f).pipe(res);
}).listen(8770);
