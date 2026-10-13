Golden files hand-written from the fixture HTML source (not from tool output), 13 Oct 2026.
- simple: h1 "Local Simple", h2 "Section A"; 1 anchor (/links).
- links: h1 "Catalog"; 120 anchors /item/0..119 (past the old 60 cap).
- jsonld: 2 ld+json blocks: 1 valid Organization, 1 truncated (invalid) → parsed 1, invalid 1.
- table: 1 header row + 30 data rows = 31 rows (kept + omitted must equal 31).
- nav: nav block repeated twice → headings de-duplicated to Download, Navigation, then h1 "Nav page"; anchors /dl,/idx (x2) + /license = 5.
Thresholds (score.ts): headings recall ≥0.95, links recall ≥0.98, title exact, JSON-LD parsed+invalid exact, table rows accounted exactly, required links present, no error.
