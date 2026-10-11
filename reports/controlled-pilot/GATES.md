# Gates: controlled read-only pilot rehearsal

OWNS: scripts/readonly-pilot.ts, scripts/scan-leaks.mjs, tests/readonly-pilot.test.ts, reports/controlled-pilot/GATES.md

Scope: The rehearsal for one public page stays NO-GO, leaks stay absent, and the regression suite passes.

- [x] G1: Committed and untracked source contains no live credential patterns
  CHECK: node scripts/scan-leaks.mjs
  EXPECT: secret scan passed
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/jacksontaylor/rove; path=a871bff92899/18 entries; EXPECT=matched; output-sha256=6b0bc342e769e989b43e39671b595e1c08bd8b0cbc6019e296e26ddfe3f33c7f; output-bytes=19

- [x] G2: The single-page rehearsal refuses execution and every other target
  CHECK: node --experimental-strip-types --test tests/readonly-pilot.test.ts
  EXPECT: fail 0
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/jacksontaylor/rove; path=a871bff92899/18 entries; EXPECT=matched; output-sha256=e12332b059d883239b02dcbf99346707dc2c8af15fbc52e745e055a782618383; output-bytes=274

- [x] G3: The regression suite passes
  CHECK: npm test
  EXPECT: fail 0
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/jacksontaylor/rove; path=a871bff92899/18 entries; EXPECT=matched; output-sha256=a063bf5f9639e97b1503cf5c25859e483c7418802f915f7a449e7b69706647ec; output-bytes=5921

- [x] G4: Typecheck passes
  CHECK: npx tsc --noEmit --pretty false && node -e "console.log('Typecheck passed')"
  EXPECT: Typecheck passed
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/jacksontaylor/rove; path=a871bff92899/18 entries; EXPECT=matched; output-sha256=0e4e51daca6975cc097bc94fa8e9efde47c33072ce3946676ee1dafd821e5125; output-bytes=17
