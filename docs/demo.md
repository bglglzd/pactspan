# Two-minute synthetic walkthrough

Run `npm run demo`, open its printed URL and load D01. This uses authored candidates and a separately mutable synthetic CRM; no model or real CRM is called.

1. Read both exact source quotes. Confirm the proposed terms. Version1 expects USD10800 on O1.
2. Read Demo CRM. Its actual value is USD12000; confirmation alone did not change it.
3. Approve the exact change, inspect the approval scope/expiry, then execute it. The amount changes in the separate Demo CRM, but the commitment stays confirmed and has no receipt.
4. Verify CRM state. A new read records a receipt for version1, O1, USD10800 and the observed revision. Expand the receipt/history to inspect its source and terms hash.
5. Expand **Edit the separate Demo CRM**, set USD11000 and apply the external edit. Verify again: the commitment becomes disputed while its prior receipt stays in history.
6. Export history and reload the page. Both stores/history persist in this browser unless browser storage is unavailable, which the interface reports.

For process persistence instead, use `npm start -- --example D01`, complete the same flow, stop the server and restart with `npm start` (omit `--example`). Local state is stored on disk. The real adapter/extractor setup is documented in [local operation](local-operation.md); the static demonstration does not substitute for that integration.
