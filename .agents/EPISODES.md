# Episodes

<!-- Newest last. The gate appends FAIL|DONE|FINDING; past 100 entries it trims only its own oldest DONE|FAIL|learned
FINDING (git keeps them). Leads (LESSON, FINDING learn=none) stay until wrap settles them; doctor fails above 30.
Agents append `<UTC ISO> s=<session> LESSON <VAE-DIALECT>` only for a falsified HYPOTHESIS, a dead end, or a root cause.
Session start injects the 3 newest open entries: LESSON, FINDING learn=none, FAIL without a later DONE.
Wrap: EVERY lead → test | .agents/VERIFY.py rule | one MEMORY line with BC, then delete; OR delete BC evidence. -->

2026-10-29T17:11:30Z s=0e38fe37 FAIL prose
2026-10-29T17:42:35Z s=0e38fe37 DONE fp=55ee47c9f0a5 cov=83.2% paths=AGENTS.md,ARCH.md,CLAUDE.md,Makefile(+303)
2026-10-29T17:42:35Z s=0e38fe37 FINDING src/write.ts:listFiles learn=test: regression test in test/write.test.ts
2026-10-29T17:42:35Z s=0e38fe37 FINDING src/write.ts:removeEmptyDirectories learn=test: regression test in test/write.test.ts
2026-10-29T17:42:35Z s=0e38fe37 FINDING README.md:75 B01|ARCH.md:69 B01 learn=none: doc claim, not mechanically checkable
2026-10-29T17:42:35Z s=0e38fe37 FINDING src/cli.ts:log learn=none: verified by running the CLI into a non-empty dir; log format not covered by a test
2026-10-29T17:42:35Z s=0e38fe37 FINDING src/cli.ts:main --emit-intermediate-format learn=none: ordering fix verified by reading; no test
2026-10-29T17:42:35Z s=0e38fe37 FINDING README.md:77 config section learn=none: doc
2026-10-29T17:42:35Z s=0e38fe37 FINDING src/intermediate-format/overlay.ts:removeMatches learn=test: regression test in test/review-regressions.test.ts
2026-10-29T17:42:35Z s=0e38fe37 FINDING src/intermediate-format/validate-spec.ts:stripRefSiblings learn=test: regression test in test/review-regressions.test.ts
2026-10-29T17:42:35Z s=0e38fe37 FINDING src/intermediate-format/normalize.ts:normalizeServices learn=test: regression test in test/review-regressions.test.ts
2026-10-29T17:42:35Z s=0e38fe37 FINDING src/intermediate-format/filter.ts:filterSpec learn=test: regression test in test/review-regressions.test.ts
2026-10-29T17:42:35Z s=0e38fe37 FINDING src/intermediate-format/normalize.ts:makeMethodNamesUnique learn=test: regression test in test/review-regressions.test.ts
2026-10-29T17:42:35Z s=0e38fe37 FINDING src/intermediate-format/config.ts:checkKeys learn=test: regression test in test/review-regressions.test.ts
2026-10-29T17:42:35Z s=0e38fe37 FINDING src/intermediate-format/config.ts:loadConfig learn=test: regression test in test/review-regressions.test.ts
2026-10-29T17:42:35Z s=0e38fe37 FINDING src/intermediate-format/refs.ts:refPointer learn=test: regression test in test/review-regressions.test.ts
2026-10-29T17:42:35Z s=0e38fe37 FINDING src/emit/runtime/validation.ts:oneOf|transform.ts:union learn=test: regression test in test/review-regressions.test.ts
2026-10-29T17:42:35Z s=0e38fe37 FINDING src/emit/runtime/transform.ts:object learn=test: regression test in test/review-regressions.test.ts
2026-10-29T17:42:35Z s=0e38fe37 FINDING src/emit/runtime/validation.ts:checkFormat|transform.ts:date,dateTime learn=test: regression test in test/review-regressions.test.ts
2026-10-29T17:42:35Z s=0e38fe37 FINDING src/intermediate-format/normalize.ts:checkExportedNames learn=test: regression test in test/review-regressions.test.ts
2026-10-29T17:42:35Z s=0e38fe37 FINDING src/emit/runtime/fetch-send.ts:serializePath learn=test: regression test in test/review-regressions.test.ts
2026-10-29T17:42:35Z s=0e38fe37 FINDING src/emit/runtime/fetch-send.ts:serializeQuery learn=test: regression test in test/review-regressions.test.ts
2026-10-29T17:42:35Z s=0e38fe37 FINDING src/emit/runtime/json.ts:parseJson|settleUnsafeIntegers learn=test: test/services.test.ts int64-as-number regression + test/codecs.test.ts settleUnsafeIntegers
2026-10-29T17:42:35Z s=0e38fe37 FINDING plans/2026-10-28_21-51_ts-client-generator.md T02 learn=none: covered by the static prose check
2026-10-29T17:42:35Z s=0e38fe37 FINDING spec/openapi-3.1.2.md|spec/openapi-3.2.1.md T02 learn=verifier: .agents/VERIFY.py CONFIG['prose']['allow']
