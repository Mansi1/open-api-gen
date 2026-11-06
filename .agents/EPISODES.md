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
2026-10-30T19:54:25Z s=2e3fd4aa FAIL tests.unit
2026-10-30T19:57:10Z s=2e3fd4aa DONE fp=f09240103d15 cov=83.2% paths=README.md,input/open-api-gen.config.json,scripts/e2e.ts,src/cli.ts(+2)
2026-10-30T21:24:00Z s=2e3fd4aa DONE fp=66cb1be61b35 cov=82.1% paths=README.md,input/open-api-gen.config.json,milkscout-api/index.ts,milkscout-api/interface/app/CertificateDto.ts(+554)
2026-11-05T00:37:50Z s=f7b31668 DONE fp=df009d13913e cov=79.1% paths=ARCH.md,README.md,input/smoke.ts,src/emit/client.ts(+21)
2026-11-05T00:37:50Z s=f7b31668 FINDING src/emit/runtime/fetch-send.ts:createFetchSend retry branch learn=none: found by reading against the Streams spec, not reproduced; edge case needs middleware that keeps a reader locked
2026-11-05T00:37:50Z s=f7b31668 FINDING test/review-regressions.test.ts:114 fetch stub learn=test: the existing regression test now reads Request.url and still pins the serialized URLs
2026-11-05T22:20:09Z s=f7b31668 DONE fp=c4501a49ce97 cov=79.1% paths=ARCH.md,README.md,input/smoke.ts,src/emit/client.ts(+21)
2026-11-05T22:20:09Z s=f7b31668 FINDING src/emit/runtime/fetch-send.ts:createFetchSend retry branch learn=test: test/services.test.ts 'a busy answer whose body middleware keeps locked is still retried' fails when the .catch guard is removed (probe run 2026-11-05) and pass
2026-11-05T22:47:15Z s=f7b31668 DONE fp=98a13dfffab4 cov=78.5% paths=ARCH.md,README.md,input/smoke.ts,src/emit/client.ts(+22)
2026-11-05T22:47:15Z s=f7b31668 FINDING src/emit/services.ts:ServiceFile.render runtime imports learn=test: test/services.test.ts 'typed errors' strict-type-checks test/fixtures/errors-3.1.yaml, which has schemas ApiError, RequestOptions, ServiceConfig used in the ser
2026-11-05T22:51:02Z s=f7b31668 DONE fp=de8f66124afd cov=78.5% paths=ARCH.md,README.md,input/open-api-gen.config.json,input/smoke.ts(+27)
2026-11-05T22:58:47Z s=f7b31668 DONE fp=d47ec9da94af cov=77.2% paths=ARCH.md,README.md,input/open-api-gen.config.json,input/smoke.ts(+29)
2026-11-05T22:58:47Z s=f7b31668 FINDING src/emit/runtime/fetch-send.ts:buildHeaders/applyAuth order learn=test: test/services.test.ts auth live test asserts a per-call authorization header wins over auth
2026-11-05T22:58:47Z s=f7b31668 FINDING src/intermediate-format/normalize.ts:normalizeSecurity learn=test: golden test/golden/intermediate-format/open-api-milkscout.json pins exactly one such warning
2026-11-05T23:04:30Z s=f7b31668 DONE fp=c998999bb76e cov=77.0% paths=ARCH.md,README.md,input/open-api-gen.config.json,input/smoke.ts(+31)
2026-11-05T23:04:30Z s=f7b31668 FINDING README.md operation servers paragraph (B evidence) learn=none: a doc example claim, not mechanically checkable
2026-11-05T23:53:51Z s=f7b31668 DONE fp=0fcacf566a23 cov=77.1% paths=ARCH.md,README.md,input/open-api-gen.config.json,input/smoke.ts(+35)
2026-11-05T23:53:51Z s=f7b31668 FINDING src/emit/runtime/validation.ts:object required check learn=test: test/services.test.ts request validation read/write-only test fails without the fix (probe 2026-11-06)
2026-11-06T00:12:44Z s=f7b31668 DONE fp=a2a2508880fe cov=77.0% paths=ARCH.md,README.md,input/open-api-gen.config.json,input/smoke.ts(+36)
2026-11-06T00:12:44Z s=f7b31668 FINDING src/emit/services.ts:directionalType (first version, replaced by src/emit/read-write.ts) learn=test: make e2e generates Stripe and GitHub and times each; a regression hangs it
2026-11-06T00:42:53Z s=f7b31668 DONE fp=cd7b22b5f69a cov=77.0% paths=ARCH.md,README.md,input/open-api-gen.config.json,input/smoke.ts(+49)
2026-11-06T00:42:53Z s=f7b31668 FINDING src/intermediate-format/bundle.ts:checkInsideRoot learn=test: test/bundle.test.ts 'files outside the reference root are refused...' includes the symlink case
2026-11-06T00:42:53Z s=f7b31668 FINDING src/intermediate-format/bundle.ts:hasExternalReference learn=test: test/bundle.test.ts discriminator mapping test
2026-11-06T00:42:53Z s=f7b31668 FINDING src/intermediate-format/bundle.ts:Bundler.walk arrays learn=none: found by reading; timing-dependent, not reproducible on demand
