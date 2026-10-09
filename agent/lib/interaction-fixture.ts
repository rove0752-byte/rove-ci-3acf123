// Authored inert content only. Served by Playwright routing, never by a network server.
export const fixtureUrl = 'https://rove-fixture.invalid/';
export const interactionFixture = `<!doctype html><html><head><title>Rove controlled fixture</title></head><body>
<h1>Controlled interaction fixture</h1>
<label>Draft note <input aria-label="Draft note" autocomplete="off"></label>
<label><input type="checkbox">Show details</label>
<label><input type="radio" name="view">Compact view</label>
<button type="button">Preview draft</button>
<button type="button" disabled>Unavailable</button><button type="button" hidden>Hidden control</button>
<input aria-label="Duplicate"><input aria-label="Duplicate">
<form action="/submit" method="get"><input aria-label="Account password" type="password"><input aria-label="Upload file" type="file">
<button>Submit GET</button><button formaction="/purchase">Buy now</button><button formaction="/login">Sign in</button></form>
<form action="/submit" method="post"><button>Submit POST</button></form>
<a href="/download" download>Download</a><a href="https://example.com">External page</a>
<iframe src="https://example.com/frame"></iframe><script src="https://example.com/script"></script>
<script>document.title='UNSAFE';fetch('https://example.com/write',{method:'POST'});</script>
</body></html>`;
