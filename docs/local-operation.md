# Local operation

Node22+ is required. No dependency installation is needed. `npm start -- --example D01` starts a persistent synthetic workspace; `npm run demo` starts the browser-only static demonstration. Both print a numeric loopback URL and PID. Stop the process with Ctrl+C; do not expose either server through a public tunnel.

`npm start -- --data /your/local/directory --port 49500` reopens an existing local workspace. The server binds only127.0.0.1. `--example D01` explicitly resets synthetic data, so omit it on normal restart. A real EspoCRM workspace starts empty and cannot load prepared examples or edit CRM state through the synthetic operator control.

## Decisions and external state

Import transcript JSON/TXT, inspect the source and add a manual candidate or use the configured local extractor. Prepared examples are authored, not model output. Model runs preserve raw count, unsupported predictions, configuration and response digests in `runs/`. Export a run before sharing it: it contains the actual transcript/request/response and is private application data.

Each local workspace retains up to200 extraction runs. The limit refuses a new request before inference and preserves prior evidence. Export and choose a separate data directory to continue; the application never silently prunes its history. Transcript files must be valid UTF-8 and at most256KiB.

Confirm sourced terms explicitly. Replacement references the current confirmed version; otherwise conflicting confirmed terms remain disputed. Unmapped ownership, unsupported quotes, uncertain required fields and missing condition decisions block execution. A prerequisite decision is a manager attestation, not third-party proof.

Read the CRM comparison, approve one exact change, then execute that approval. Approval lasts at most one hour (UI: fifteen minutes). The server refuses a changed before-state rather than approving new values silently. A write ACK remains unverified. **Verify CRM state** uses a new reader request and records a receipt for the exact current version only. A later rollback leaves the previous receipt in history and disputes the current state.

An uncertain or pending write blocks further writes for the same configured CRM/entity, including newer versions. Use **Reconcile prior attempt**. A matching fresh read can resolve its effect; a nonmatching read cannot prove that a timed-out request will never commit. Reconciliation alone does not mark fulfillment. There are no automatic PUT retries.

## Configuration

EspoCRM10.0.12 is the exercised target. Use a dedicated sandbox with one writer. Native `X-Version-Number` is a pre-save check, not atomic database compare-and-swap; arbitrary concurrent writers are outside scope. The writer should edit only Opportunity amount/currency, with no create/delete privileges. Use a separate read-only API user. Secrets are accepted through environment variables or the operator-selected JSON file, never browser forms or transcript content. HTTP is allowed only for numeric loopback CRM origins; remote CRM origins require HTTPS.

For local extraction, configure a compatible server with the expected model ID, nested `response_format.json_schema.schema` support and `chat_template_kwargs.enable_thinking:false`. Pactspan sends no key, permits only numeric loopback origins, and does not retry/fallback. The current request is temperature0/seed42, up to2048 output tokens in the local CLI, response bound256KiB and120s deadline. Exact model/runtime/quality evidence remains a release prerequisite. A valid JSON response or quote is not a semantic accuracy measurement.

## Files and recovery

`state.json` holds a revision/checksum envelope with the domain and metadata. `demo-crm.json` is the separate synthetic external store. `runs/*.json` retains extraction evidence. Keep the entire data directory private and back it up while the server is stopped. Hashes detect inconsistency; they are not signatures or a defense against a malicious local owner.

An active owner lock prevents another process from opening the same directory. A dead owner is moved into a nonce-named nonempty tombstone; its data is preserved. An unknown/malformed lock is refused for inspection. No process is killed and no recursive directory deletion is used. After an abnormal stop, reopen the same directory and reconcile pending attempts before writing.

Corrupt current state fails closed and is never replaced with an older automatic backup. Stop the server and preserve the original files before repair. A store-level export can retain raw valid UTF-8 even if JSON/domain validation fails:

```js
import { WorkspaceStore } from './src/local/store.mjs';
const store = await WorkspaceStore.open('/your/local/directory');
try { console.log(await store.raw()); } finally { await store.close(); }
```

If storage does not acknowledge a commit, further decisions freeze until restart. On Unix the application syncs the renamed directory; Windows provides file fsync/atomic rename but no directory fsync through this Node API, so sudden power-loss durability of the directory entry is not claimed.

## JSON action files

`node src/cli.mjs action decision.json --data .pactspan` executes one decision and closes the lock. For example:

```json
{"action":"loadExample","args":{"id":"D01"}}
```

Supported decisions are `importSource`, `propose`, `confirm`, `decideCondition`, `resolveConflict`, `read`, `approve`, `execute`, `verify`, `reconcile`, `checkDeadlines`, and synthetic-only `setClock`/`operatorChange`/`loadExample`. `extract` requires a configured local model. Input fields are closed and validated. Confirmation binds the configured target; approval includes the reviewed before-state; execution accepts an approval ID. No raw update, supplied observation or imported receipt endpoint is exposed. Use the UI to inspect and approve rather than constructing decisions blindly.
