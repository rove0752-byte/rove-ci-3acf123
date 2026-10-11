# Gates: container egress boundary

OWNS: agent/lib/container-egress.ts, scripts/container-egress-entry.ts, scripts/container-egress-probe.ts, scripts/container-egress-launch.sh, scripts/verify-container-egress.mjs, tests/container-egress.test.ts, Dockerfile.browser-pilot

Scope: Deny outbound traffic from the browser and agent inside a dedicated container. Refuse shared namespaces. Keep the public pilot closed. A local fixture pin may open only TCP/80 or TCP/443 to one private address.

- [x] G1: Compiled egress policy drops external IPv4 and IPv6, refuses public pins, and checks the namespace shape
  CHECK: node --experimental-strip-types --test tests/container-egress.test.ts
  EXPECT: fail 0
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/jacksontaylor/rove; path=a871bff92899/18 entries; EXPECT=matched; output-sha256=d95b1c2611f668c69e841c20f1dcaf8e4cde30ee171f2ebdf8155394a811f379; output-bytes=533

- [x] G2: Agent and browser processes cannot bypass the container policy, and a local fixture pin does not open other paths
  CHECK: node scripts/verify-container-egress.mjs
  EXPECT: Container egress verification passed
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/jacksontaylor/rove; path=a871bff92899/18 entries; EXPECT=matched; output-sha256=1134543c8b0fbcf347e3803aea93e74ab601c22682aec06be63f3a2f64186ebc; output-bytes=2253

- [x] G3: Existing regression tests still pass
  CHECK: npm test
  EXPECT: fail 0
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/jacksontaylor/rove; path=a871bff92899/18 entries; EXPECT=matched; output-sha256=e74f9703533bf023abbcff660cfc447e1ec9b2dd0c55d969cbcb4b1f5a21b23c; output-bytes=5672

- [x] G4: Typecheck passes
  CHECK: npx tsc --noEmit --pretty false && node -e "console.log('Typecheck passed')"
  EXPECT: Typecheck passed
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/jacksontaylor/rove; path=a871bff92899/18 entries; EXPECT=matched; output-sha256=0e4e51daca6975cc097bc94fa8e9efde47c33072ce3946676ee1dafd821e5125; output-bytes=17
