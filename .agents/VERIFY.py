"""Project-local verifier policy. Agents MAY extend it; every gate executes it fail-closed."""

CONFIG = {
    "coverage_min": 60,
    "lint_command": None,          # None → `make lint` (uv run ruff check . | bunx oxlint --deny-warnings).
    "test_command": None,          # None → `make test`. Commands run in the repo root.
    "coverage_command": None,      # None → `make coverage`; output needs `TOTAL <n>%` or an `All files |…|` table.
    "integration_commands": [],    # [] → `make integration` if present.
    "e2e_commands": [],            # [] → `make e2e`: build + consume the publishable artifact.
    "e2e_paths": [],               # globs e2e depends on, e.g. ["web/*"]: e2e reruns only when one (or a build file) changed; [] → any code file.
    "timeout_s": 180,
    # `init` on a GitHub remote writes .github/workflows/verify.yml (uv/bun via their official setup actions) unless a
    # workflow already runs `make verify`, these commands or every verify verb. None → make setup, make verify.
    "ci": None,                    # None | False (no CI workflow) | ["make setup", "make ci"] (one step each)
    "layout": True,                # Makefile verbs + gitignored secrets, runtime state, dist/, caches and package folders.
    "strict": True,               # docs.pages, gitignore and package block; False makes them warnings (a project created before 0.6.0 has False).
    "gitignore_exempt": [],        # required ignore lines this project may skip, e.g. ["dist/"] for a GitHub Action that commits its build.
    "toolchain": True,             # new (sub)projects start on bun (JS/TS) / uv (Python): newly added npm/yarn/pnpm/poetry/pipenv/pdm/pip lockfiles fail.
    # Static check of every changed doc page (*.md|*.mdx|*.markdown); False disables it.
    # allow: {glob: characters a page may use as house style}, e.g. {"docs/de/*.md": "\u201e\u201c"} for German quotes.
    # phrases: extra slop regexes (any language), case-insensitive, flagged as findings.
    # HYPOTHESIS: most projects need no allow entry; add one only for a page whose house style needs a flagged character.
    # README.md covers the root and each package with a changed CLI|API; ARCH.md each package with changed production code
    # or deployment|schema files. A page covers the folders below it up to the next package manifest; tests, examples,
    # docs, config and data need none.
    "readme": {"exclude": []},     # folder globs exempt from README.md coverage; False drops it (the root still needs one)
    "arch": {"exclude": []},       # folder globs exempt from ARCH.md coverage; False drops it
    # Changed package.json: packageManager, description, license, author; new packages also type, linter, library build.
    "package": {"manager": "bun", "type": "module", "lint": "oxlint", "library_build": "pkgroll"},  # False disables
    "prose": {"allow": {"spec/openapi-3.1.2.md": "\u2013\u2014", "spec/openapi-3.2.1.md": "\u2013\u2014"}, "phrases": []},  # verbatim upstream OpenAPI spec copies
}

# Deterministic invariants only; no semantic guesses.
# kinds: command | file_exists | contains | regex | not_regex
# scope: "path" = one exact file; "glob" = every changed code file matching (fnmatch); "glob" + "docs": True = every
# changed doc page matching, e.g. {"id": "docs.arch.diagram", "kind": "contains", "path": "docs/ARCHITECTURE.md",
# "text": "```mermaid", "claim": "architecture page keeps its diagram"}.
RULES = [{
    "id": "tests.no-mocks",
    "kind": "not_regex",
    "glob": "*",
    # Every alternative contains an escape, so this file never matches its own pattern.
    "pattern": r"unittest\.mock|from\s+unittest\s+import\s+mock|MagicMock\(|mock\.patch|mocker\.|"
               r"jest\.(?:mock|fn|spyOn)\(|vi\.(?:mock|fn|spyOn)\(|sinon\.|gomock\.|mock\.Mock\b|Mockito\.|@Mock\s|mockk\(|"
               r"@Mock(?:ito)?Bean\b|new\s+Mock<|Mock\.Of<|Substitute\.For<|A\.Fake<|mockall:{2}|#\[automock\]",
    "claim": "tests exercise real subsystems, not mock frameworks",
}, {
    "id": "tests.await-rejects",
    "kind": "not_regex",
    "glob": "test/*.test.ts",
    # An un-awaited `expect(p).rejects` resolves after the test ends, so the assertion never fails the test.
    "pattern": r"(?m)^(?![^\n]*\bawait\b)[^\n]*\bexpect\((?:(?!\n\s*\n).)*?\)\s*\.(?:rejects|resolves)\b",
    "claim": "every expect(...).rejects|resolves in bun tests is awaited",
}, {
    "id": "ts.no-declare-call",
    "kind": "not_regex",
    "glob": "*.ts",
    # Bun's transpiler reads a statement starting with `declare(` as an ambient declaration and drops it silently.
    "pattern": r"(?m)^\s*(?:return\s+)?declare\s*\(|\bfunction\s+declare\s*\(",
    "claim": "no function named declare (Bun strips `declare(...)` statements)",
}, {
    "id": "source.no-raw-line-separators",
    "kind": "not_regex",
    "glob": "*.ts",
    # A raw U+2028/U+2029 ends a regex or string literal; write the escape sequence instead.
    "pattern": "[\u2028\u2029]",
    "claim": "TypeScript sources contain no raw U+2028/U+2029 characters",
}, {
    "id": "emit.quoted-module-paths",
    "kind": "not_regex",
    "glob": "src/emit/*.ts",
    # Module paths can come from the config (hook imports); paste them only through names.ts quote().
    "pattern": r"from '\$\{",
    "claim": "generated import/export paths are built with quote(), never interpolated into '...'",
}]
