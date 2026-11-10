# Pactspan

Review meeting commitments as immutable confirmed term versions. Link accepted amendments, inspect CRM differences, approve an exact change and verify it with a version-bound receipt. A CRM amount or internal draft does not prove a proposal was sent.

## Try the synthetic demo

Node22 or newer; npm is used for convenience commands. From this checkout:

```sh
npm run demo
```

Open the printed loopback URL. No dependency installation, paid model or CRM account is needed for this demo.

With a Node-only installation, use `node scripts/serve-demo.mjs` for the same static demo.

With D01 selected, confirm its sourced terms, read the Demo CRM, approve the exact amount change, execute that approval, then verify the state independently. The write acknowledgment leaves the commitment unverified. Expand the separate Demo CRM editor, change its amount and verify again to inspect the contradiction and retained receipt.

The browser demo uses authored candidates and a separate mutable synthetic CRM. It does not call an extraction model or a real CRM. Local transcript imports stay in the browser; export history before replacing a workspace. The same domain code handles quotes, versions, guards and receipts in browser and Node paths.

## Run a local workspace

```sh
npm start -- --example D01
```

Open the printed numeric loopback URL. Commitments and the separate synthetic CRM survive server/browser restarts in `.pactspan/`. Omit `--example` when restarting: that option explicitly replaces the synthetic workspace. Export history before replacing an example. Only one process can open the same data directory.

The equivalent Node-only command is `node src/cli.mjs serve --example D01`.

For a downloaded release package, extract `pactspan-0.1.0.tgz` into an empty directory, enter its `package/` folder and run that Node command. No npm install step is required. Keep the release manifest with its SHA256 digests when verifying downloaded bytes.

For an externally installed EspoCRM single-writer sandbox, set `PACTSPAN_CRM_ORIGIN`, `PACTSPAN_SINGLE_WRITER=1` and provide separate reader/writer API keys through `--keys /private/api-identities.json` (`reader.apiKey` and `writer.apiKey`) or `PACTSPAN_READ_KEY`/`PACTSPAN_WRITE_KEY`. Keys stay server-side. Then run:

```sh
npm start -- --crm espocrm --data .pactspan/espo --keys /private/api-identities.json
```

Optional extraction uses a local OpenAI-compatible `/v1/chat/completions` server. Set `PACTSPAN_MODEL_ORIGIN` to its numeric loopback origin and `PACTSPAN_MODEL` to its served model ID before starting. Import a source and choose **Extract candidates**. Each run retains all raw predictions and diagnostics; only candidates passing local shape/source checks enter the review list. Exact quotes do not establish semantic correctness or confirmation. There is no paid fallback or automatic write.

`node src/cli.mjs help` lists server, JSON action-file and export commands. [Local operation](docs/local-operation.md) explains decisions, file recovery and limits.

## Domain and adapters

- Exact JSON/TXT transcript sources, UTF-16 quote spans and explicit unknown fields.
- Human confirmation, explicit supersession/conflict resolution, prerequisite decisions and deadline precision.
- One-use, expiring approvals bound to exact version, target, before revision and payload; uncertain writes require read reconciliation.
- Fresh matching receipts for current versions. Older observations cannot erase newer contrary evidence; restart validates stored content bindings.
- EspoCRM Opportunity amount/currency client with separate reader/writer keys, typed refusals and no implicit write retries. It requires a dedicated single-writer sandbox: native `X-Version-Number` is not atomic database CAS.

This private development checkout still needs full genuine-server UI exercise, extraction evaluation, release packaging and independent acceptance. Library SDK and synthetic HTTP tests are not final artifact acceptance. The twenty [authored development cases](docs/dataset.md) are not a blind evaluation; the required held-out extraction evaluation remains pending.

[Specification](docs/spec.md) · [Architecture](docs/architecture.md) · [Data contract](docs/dataset-contract.md) · [MIT license](LICENSE)
