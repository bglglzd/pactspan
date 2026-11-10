# Contributing

From a repository checkout, use Node22+ and a separate branch. No runtime dependencies or package installation are required. Tests are included in the repository, not the release package.

```sh
node --test
node --check public/app.mjs
node scripts/build-demo.mjs
```

Keep the domain independent of network, filesystem and UI. New fulfillment predicates need observable independent evidence and failure/recovery checks. An ACK, draft, model assertion or imported receipt must never prove fulfillment. Preserve exact sources, immutable confirmed versions and one-use approval bindings.

Add outcome-based regressions for broken journeys. Keep authored/manual data, automatic predictions and external observations distinct. Do not tune against the published first-run holdout and present a rerun as new blind evidence. Document model/configuration changes and unsupported cases.

Use synthetic transcripts and CRM records in issues, tests and screenshots. Never commit application data, API keys, private contacts or real customer transcripts. Explain intended behavior and reproduce a failure with the smallest synthetic case.

The static builder refuses unmanaged or modified output. Preserve that directory and use `node scripts/build-demo.mjs --out a-fresh-directory` rather than deleting unknown files. Product runtime state is private and excluded from packages.
