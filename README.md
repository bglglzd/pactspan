# Pactspan

Review meeting commitments as immutable confirmed term versions. Link accepted amendments, inspect CRM differences, approve an exact change and verify it with a version-bound receipt. A CRM amount or internal draft does not prove a proposal was sent.

## Try the synthetic demo

Node22 or newer. From this checkout:

```sh
npm run demo
```

Open the printed loopback URL. No dependency installation, paid model or CRM account is needed for this demo.

With D01 selected, confirm its sourced terms, read the Demo CRM, approve the exact amount change, execute that approval, then verify the state independently. The write acknowledgment leaves the commitment unverified. Expand the separate Demo CRM editor, change its amount and verify again to inspect the contradiction and retained receipt.

The browser demo uses authored candidates and a separate mutable synthetic CRM. It does not call an extraction model or a real CRM. Local transcript imports stay in the browser; export history before replacing a workspace. The same domain code handles quotes, versions, guards and receipts in browser and Node paths.

## Domain and adapters

- Exact JSON/TXT transcript sources, UTF-16 quote spans and explicit unknown fields.
- Human confirmation, explicit supersession/conflict resolution, prerequisite decisions and deadline precision.
- One-use, expiring approvals bound to exact version, target, before revision and payload; uncertain writes require read reconciliation.
- Fresh matching receipts for current versions. Older observations cannot erase newer contrary evidence; restart validates stored content bindings.
- EspoCRM Opportunity amount/currency client with separate reader/writer keys, typed refusals and no implicit write retries. It requires a dedicated single-writer sandbox: native `X-Version-Number` is not atomic database CAS.

The live UI/server/extraction workflow and release packaging are still being integrated in this private development checkout. Library SDK exercise is not a final artifact acceptance result. The twenty [authored development cases](docs/dataset.md) are not a blind evaluation; the required held-out extraction evaluation remains pending.

[Specification](docs/spec.md) · [Architecture](docs/architecture.md) · [Data contract](docs/dataset-contract.md) · [MIT license](LICENSE)
