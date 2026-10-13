// Fixture web server: virtual hosts by Host header. Reachable only from the proxy's upstream network.
import { createServer } from 'node:http';
const robots = {
  'allowed.test': 'User-agent: *\nDisallow: /private\nAllow: /private/public-ok\n\nUser-agent: OtherBot\nDisallow: /\n',
  'other.test': 'User-agent: RoveStageA\nDisallow: /a\n\nUser-agent: *\nDisallow:\n',
};
const img = (n, host = 'allowed.test') => Array.from({ length: n }, (_, i) => `<img src="http://${host}/img/${i}.png">`).join('');
const pages = {
  '/': '<title>Allowed home</title><h1>Home</h1><a href="/a">A</a>',
  '/a': '<title>Page A</title><h1>A</h1><p>Read-only fixture.</p>',
  '/offlist': '<title>Off-list subresource</title><img src="http://evil.test/x.png">',
  '/burst': '<title>Burst</title>' + img(20),
  '/flood': '<title>Flood</title>' + img(80),
  '/robots-trap': '<title>Robots trap</title><script>location="/private/x"</script>',
  '/sub-redir': '<title>Subresource redirect</title><img src="/img-redir-off">',
  '/private/x': '<title>Disallowed</title>',
  '/private/public-ok': '<title>Allowed by longer Allow</title>',
};
const redirects = { '/redir-same': '/a', '/redir-cross': 'http://other.test/', '/redir-off': 'http://evil.test/', '/img-redir-off': 'http://evil.test/x.png' };
createServer((req, res) => {
  const host = (req.headers.host || '').split(':')[0];
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/robots.txt') { res.writeHead(robots[host] ? 200 : 404, { 'content-type': 'text/plain' }); return res.end(robots[host] || ''); }
  if (redirects[path]) { res.writeHead(302, { location: redirects[path], 'set-cookie': 'x=1' }); return res.end(); }
  if (path.startsWith('/img/')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(Buffer.alloc(68)); }
  if (path === '/big') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(Buffer.alloc(6_000_000)); }
  if (path === '/hang') return;
  const body = pages[path];
  if (body == null) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<!doctype html><html><body>${body}<p>host=${host}</p></body></html>`);
}).listen(80, () => console.log('fixture listening'));
