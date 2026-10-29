# Agent memory

<!-- One tagged line per durable fact NOT derivable from code, git or docs:
- VERIFIED[scope] fact BC evidence
- HYPOTHESIS[scope] claim BC observation; falsifier=`cmd`
- UNKNOWN[scope] gap BC missing evidence
[scope] = the narrowest path|module|command|condition the evidence covers, not a topic: the entry decides nothing
outside it, and recurrence inside one subsystem never widens it.
Every line carries its BC and stays ≤240 chars. Replace stale lines instead of appending.
Mechanizable lessons belong in tests or .agents/VERIFY.py.
Budget 4 KiB (`vae.py doctor --repo .`); entries are injected at session start. -->
- VERIFIED[devDeps typescript] pinned 6.0.3 NOT 7.x BC typescript@7.0.2 exports only `unstable/*` (no `createProgram`); TS6 needs `"types": ["bun"]` in tsconfig (default types=[])
- VERIFIED[spec validation] use @hyperjump/json-schema/openapi-3-{0,1,2}, NOT ajv BC ajv 8.20 rejects valid 3.1/3.2 docs via schema-base `$dynamicRef`
- VERIFIED[bun transpiler] a statement `declare(x)` is silently dropped (ambient declaration) BC normalize lost all components until renamed; rule ts.no-declare-call
- VERIFIED[code style, all src/test] human requires full descriptive names (no `(i) =>`, `s`, `p`, `ctx`, `decl`, `doc`) and plain statements over shortcut one-liners BC human request 2026-10-28
