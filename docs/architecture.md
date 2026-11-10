# Architecture plan

One JavaScript domain library runs in modern browsers and Node22+. Plain HTML/CSS/ES modules provide the UI; a small loopback Node server and CLI provide durable local operation and credentialed adapters. Runtime dependencies remain proportionate; no shared portfolio framework or duplicated browser/Python state machine is introduced.

Planned boundaries:

- `src/core/`: strict data validation, canonical hashes, immutable sources/versions, transitions, approvals, verification and invariants. No network or filesystem calls.
- `src/import/`: Auris segment JSON and timestamped TXT into the canonical source representation.
- `src/adapters/`: separate mutable Demo CRM, actual EspoCRM reader/writer, and actual schema-constrained local extraction. Adapters cannot bypass domain guards.
- `src/node/`: serialized durable store with atomic replacement/recovery, loopback HTTP boundary and CLI services. Persist attempts before external writes; re-read/reconcile uncertain outcomes.
- `public/`: original SVG, functional UI and static demo using the same core and explicitly synthetic adapter. No embedded credentials, private transcripts or automatic remote calls.
- `examples/development/`: predeclared bilingual sources/annotations; held-out data is sealed outside the product until the first frozen evaluation.

Node/browser Web Crypto supplies SHA256. A content hash does not authenticate a CRM action. The live server obtains observations itself rather than accepting a client-supplied fulfillment receipt. Persistent application data and secrets are ignored and excluded from packages/demo archives.

Buildless static output is copied into `dist/` with relative paths for GitHub Pages. The local workflow follows the Sites portable/local source guidance; no separate Sites account/project is necessary for the user's GitHub-hosted source and demo. A release manifest will bind the exact source, toolchain/configuration and tested package/demo digests. The server/UI lifecycle and data recovery must be independently installed and checked before release.
