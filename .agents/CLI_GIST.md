# CLI gist

<!-- Commands future agents need that the Makefile verbs do not cover (setup, env, data, deploy):
- VERIFIED[purpose] `cmd`: only after an observed success
- UNKNOWN[purpose] BC gap
Budget 2 KiB (`vae.py doctor --repo .`); entries are injected at session start. -->
- VERIFIED[verify without git] `vae.py gate` reports ∅ changes in this non-git repo; run `vae.py verify --repo .` with one `--changed <file>` per project file instead (see session 2026-10-29)
- VERIFIED[goldens] `UPDATE_GOLDEN=1 bun test test/intermediate-format.test.ts` rewrites test/golden/intermediate-format/
- VERIFIED[generated sources] `make intermediate-format-schema` after editing src/intermediate-format/types.ts; `make runtime-sources` after editing src/emit/runtime/
