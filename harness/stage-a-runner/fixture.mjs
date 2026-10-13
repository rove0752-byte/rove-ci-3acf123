// Fixture web server: serves several virtual hosts by Host header. Reachable only from the proxy's upstream network.
import { createServer } from 'node:http';
const robots = { 'allowed.test': 'User-agent: *\nDisallow: /private\n', 'other.test': 'User-agent: *\nDisallow:\n' };
const img = (n, host = 'allowed.test') => Array.from({ length: n }, (_, i) => `<img src="http://${host}/img/${i}.png">`).join('');
const pages = {
  '/': '<title>Allowed home</title><h1>Home</h1><a href="/a">A</a>',
  '/a': '<title>Page A</title><h1>A</h1><p>Read-only fixture.</p>',
  '/offlist': '<title>Off-list subresource</title><img src="http://evil.test/x.png">',
  '/burst': '<title>Burst</title>' + img(20),
  '/robots-trap': '<title>Robots trap</title><a href="/private/x">x</a><script>location="/private/x"</script>',
  '/private/x': '<title>Disallowed</title>',
  '/hang': null,
};
createServer((req, res) => {
  const host = (req.headers.host || '').split(':')[0];
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/robots.txt') { res.writeHead(robots[host] ? 200 : 404, { 'content-type': 'text/plain' }); return res.end(robots[host] || ''); }
  if (path.startsWith('/img/')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(Buffer.alloc(68)); }
  if (path === '/hang') return; // never answers
  const body = pages[path];
  if (body == null) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<!doctype html><html><body>${body}<p>host=${host}</p></body></html>`);
}).listen(80, () => console.log('fixture listening'));
