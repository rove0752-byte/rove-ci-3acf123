# Rove v0.1

The web, at your command.

An early developer prototype for a public-web research API, built with eve and Playwright. This is source code, not a deployed commercial service.

## Start locally

Requires Node.js 24.

```sh
npm ci
npm run preview
```

Open http://127.0.0.1:4310. The preview supports page inspection and screenshot evidence without a model. Linux uses packaged Chromium; on macOS or Windows install a browser first:

```sh
npx playwright install chromium
```

The preview runs only on loopback. Do not expose it publicly.

## AI agent runtime

Configure AI_GATEWAY_API_KEY privately in the server environment, then use `npm run dev` (or `npm exec -- eve dev --no-ui`). The gateway credential belongs to the service operator. No secret is included in this project. The model uses the scaffold's default openai/gpt-6-luna-fast.

The approved framework build now passes. Added the required just-bash dependency and kept browser packages external so their runtime assets are preserved. The built server starts and serves the homepage and health endpoint. Live AI tasks still require a model credential and have not been verified.

## API

- GET /v1/health — setup status
- POST /v1/extract — public page text, title, links, timestamp, PNG screenshot and screenshot SHA-256
- POST /v1/agent/run — URL, task, optional outputFormat prompt hint and optional outputSchema for the data field; returns HTTP 202 with runId, sessionId and streamUrl
- GET /v1/agent/runs/:id/stream — NDJSON events, including the answer or failure

```sh
curl http://localhost:3000/v1/agent/run \
  -H 'Authorization: Bearer YOUR_ROVE_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","task":"Summarise the page with sources","outputFormat":"JSON","outputSchema":{"type":"object","required":["title"],"properties":{"title":{"type":"string"}}}}'
```

Use the port printed by eve. The plain preview responds 503 to AI tasks because it does not run the agent runtime.

## Current boundaries

- Browser contexts are fresh per page. No authentication or cookies are imported.
- JavaScript, service workers, submissions, non-GET/HEAD requests and downloads are disabled. Only the main document is fetched; images, stylesheets, fonts and other subresources are blocked before a connection. JavaScript-heavy sites will be incomplete.
- Chromium always starts behind a separate deny-all proxy process. QUIC, HTTP/3, DNS prefetch and WebRTC non-proxied UDP are disabled, Chromium hostname resolution is forced to fail, and resolver or proxy overrides cannot turn those back on. The main document is fetched by that same process, which dials only the pinned IP literal and does not query DNS or open UDP. Redirects are rechecked and pinned again. Hostname policy still rejects private and reserved answers before a fetch. `scripts/container-egress-launch.sh` applies a default-drop policy in a dedicated container namespace before the agent and browser start. It refuses host-shaped interfaces, a network namespace joined from another container, a shared process namespace, and a joined namespace that still has an ICMP socket. It clears NAT, mangle, and raw rewrites, drops DNS, QUIC, STUN, mDNS, and DNS-over-TLS in raw OUTPUT before translation, removes Docker's `docker-dns` table, and drops the privileges required to change those rules. Direct TCP, DNS, UDP, QUIC, STUN, ICMP, HTTP proxy, IPv4-mapped addresses, and IPv6 were blocked there while the same local fixtures stayed reachable with the policy off. A test-only local fixture pin can allow TCP/80 or TCP/443 to one private address. With that pin, only the approved TCP port reached the fixture, and DNS, UDP, other hosts, QUIC, WebRTC, and the HTTP proxy stayed closed. Loopback remains available for the deny proxy. Host processes are outside that namespace, so public service has to run through this entrypoint. The public browser pilot is disabled. `Dockerfile.browser-pilot` is a local proof image and is not selected for deployment.
- Production requires ROVE_API_KEY and an exact-host ROVE_ALLOWED_HOSTS allowlist. All callers currently share one operator key. This is not multi-tenant authentication.
- Page capture is limited to 30 seconds, 80 requests and 18,000 text characters. Bodies/resources are not byte-capped at the browser layer.
- Browser tools allow three document fetches per Eve session. A fourth is denied. A different host waits for approval. Direct `/v1/extract` calls are separate operator requests and do not share that counter. Optional framework tools are disabled.
- Model token budget: US$0.25 per session, 30,000 input tokens and 4,000 output tokens. Framework limits check accumulated usage before further model calls; a crossing call may exceed the configured limit. These are not hard prepaid spending caps. Browser and infrastructure costs are additional.
- Agent results are enforced with Eve outputSchema. The final answer must include status, summary, data, evidence and limitations. An optional outputSchema constrains data only, and outputFormat remains a prompt hint. The interface shows raw stream events. A parsed results view remains future work.
- No billing, background worker pool, scheduling, customer accounts or production deployment.

## Verified

`npm run typecheck` passes. `npm test` passes private-address, URL-policy and result-schema tests. `npm run test:schema` checks Eve mock-model enforcement without a paid model call. The local UI check validates Chromium launch, screenshot capture, desktop page controls, mobile overflow, blocked private targets and the AI configuration error.

```sh
node --experimental-strip-types scripts/verify-preview.mjs
```

Public website extraction and credentialed AI runs are not verified in this environment. The production build and server startup pass; homepage and health endpoint both return HTTP 200. No money has been spent or domain purchased. Rove is a working name; brand availability has not been checked.

## Next milestone

Configure a model credential in the intended runtime, then complete one public-website task end to end. Before offering customer access, enforce tenant isolation, infrastructure egress policy and ownership of run streams. Per-session page limits, token limits and the result schema are local controls. Customer billing is still absent.

## Phase 4A cloud foundation

The provider-independent job service, authenticated dashboard, worker and scheduler are documented in [docs/PHASE-4A.md](docs/PHASE-4A.md). Start the configured foundation with `npm run cloud:start` and open `/cloud`. It only executes harmless deterministic jobs; it does not call the existing browser tools or an AI provider. `db/cloud.sql` contains the private PostgreSQL schema and access controls. Prepared for a seven-day Railway Free/trial + Supabase Free experiment; no deployment or paid resources have been provisioned. The cloud-only image uses its own minimal lockfile, locks AI spending to zero and concurrency to one. See [readiness review](docs/PHASE-4A-REVIEW.md) for blockers and exact next actions.

Run `npm run test:cloud` for SQL lifecycle/restart checks and `npm run test:dashboard` for local browser verification. See [GATES.md](GATES.md) for evidence and limitations.
