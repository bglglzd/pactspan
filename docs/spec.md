# Pactspan v0.1 specification

User: an account or implementation manager checking agreed commercial terms after a meeting. Import a transcript, inspect exact quotes and unresolved fields, confirm one term version, explicitly supersede it when an amendment is accepted, inspect a CRM mismatch, approve one exact amount/currency change and independently verify the external result. A draft or CRM field match cannot prove that a proposal was sent.

Pactspan is a local application with a static, interactive synthetic demonstration. It has no recording/STT, automatic customer messaging, legal interpretation, arbitrary CRM marketplace or autonomous agreement confirmation.

## Complete representative journey

1. Meeting A accepts recording USD12,000 on opportunity O1. Extraction produces a proposed candidate, never a confirmed promise. A manager reviews its exact source, owner, deadline/unknowns and predicate, then explicitly confirms version1.
2. Meeting B accepts USD10,800 instead. Import order does not determine authority. The manager links and confirms a replacement; version1 becomes superseded and cannot execute or consume a version2 receipt.
3. A fresh read shows O1 still at USD12,000. The UI shows expected versus observed fields and one approval for O1, USD12,000→10,800. Approval binds version/terms hash, external origin/entity, before revision/value digest, payload, expiry and one-use ID.
4. Execution rechecks the current confirmed version, prerequisites, approval and fresh before state. A supported optimistic revision guard must hold before the PUT. Persist an attempt before writing; uncertain responses require read reconciliation, not a blind second write.
5. A separate reader credential makes a new GET. Only matching identity, amount/currency, current version/terms and resolved conditions can produce a fulfillment receipt. The write response or a supplied JSON receipt cannot establish fulfillment.
6. Restart and repeated import/approval preserve history and produce no second logical fulfillment. A later contrary CRM observation disputes a current-state promise without erasing the earlier receipt. A separate promise to send a proposal remains unverified when only its draft or CRM amount exists.

## Domain

Immutable sources contain original text, title, explicit meeting anchor/zone or null, speaker mappings and ordered timestamped segments. Existing Auris segment JSON and its timestamped TXT shape are import targets. No private recordings or transcripts are used. Source identity binds content and interpretation metadata; an identical reimport deduplicates, an edited text/context is a distinct source.

Candidates retain source IDs, exact segment-relative UTF-16 spans/quotes, agreement classification, owner, terms, conditions, deadline and explicit unknowns. A unique exact quote can resolve omitted offsets; repeated/altered/missing quotes are unsupported. Cross-turn acceptance cites both proposal and acceptance. Speaker labels are not verified real-world identity or authority. Imported instructions remain data.

The executable live predicate is `crm.amount`: one identified EspoCRM Opportunity must currently match an explicit amount/currency. Money is a canonical decimal string, never floating point arithmetic or an inferred discount calculation. `proposal.sent` and other promises can be tracked but remain unfulfilled unless a separately supported event predicate is implemented and independently exercised. Current values do not prove historical sending or on-time execution.

Each commitment has immutable numbered versions, a terms hash, source evidence, explicit manager confirmation, optional supersession, verification predicate and append-only transition/attempt history. Lifecycle states are proposed, confirmed, superseded, fulfilled, disputed and overdue. Rejection is a retained decision, not an automatically confirmed commitment. No model output can confirm, supersede, approve a write or fulfill.

Confirmation records the exact terms, owner mapping, unknowns, conditions and actor decision. Required execution fields and unresolved conditions block writes/fulfillment with explicit reasons. A source-supported promise without a stated owner must not guess one. Human corrections are separate decisions, not fabricated transcript quotes. Conflicting confirmed terms remain disputed until an explicit resolution; newest text alone cannot supersede an agreement. Supersession cannot form a cycle or target another commitment accidentally.

Deadlines preserve literal wording and precision. Relative dates require explicit meeting anchor and IANA zone. Missing date/year/zone, ambiguous/nonexistent local times and unsupported expressions remain unresolved. Date-only values do not invent midnight; a cutoff requires a separate decision. An observed match after a deadline does not prove when the external event happened. Overdue is an evidence/state condition and its history persists after later fulfillment.

## Integration and trust boundary

Offline UI uses a separately mutable Demo CRM, clearly labeled synthetic. The same domain functions drive browser and Node journeys; demo fixtures cannot stand in for the real adapter or automatic extraction. Static hosting makes no credentialed local/CRM calls. Local Node server binds loopback, keeps API/model credentials server-side and restricts mutation origin/requests; untrusted sources/candidates cannot choose target URLs or tool calls.

The supported real adapter is externally installed, unmodified EspoCRM Community in a dedicated single-writer sandbox. Use separate read-only and narrowly scoped writer API users; no runtime admin key. On pinned10.0.12, `X-Version-Number` performs a pre-save stale-change check rather than atomic database CAS. Observed conflicting stale writes return409, but this does not guarantee arbitrary concurrent interleavings. Writes require explicit single-writer configuration and a fresh before-state check; multiple independent writers are outside scope. Forbidden-field updates may return200 with fields stripped and revision metadata advanced; permission checks inspect actual business fields. Deleted records can return200 with `deleted:true` and must be rejected.

Receipt fields include commitment/version/terms hash, predicate, confirmation, adapter/mode/origin/entity, observed fields/revision, observation time, sanitized response digest and optional approval/attempt. Hashes are integrity bindings, not signatures or proof of customer receipt. Imported receipts require fresh external verification. Domain amounts use decimal strings up to1000000000 with at most two fractional digits; the adapter validates exact numeric-wire round trips and the target's supported currencies.

Automatic extraction uses a schema-constrained OpenAI-compatible local model with a recorded model/server/configuration. Validate structure and quotes independently. Manual annotations stay labeled manual; an unavailable or inaccurate model is reported, with no paid fallback or fixture substitution.

## Observable acceptance

- Thirty authored EN/RU scenarios with explicit annotations, including at least ten genuinely held out from model/prompt/configuration tuning. Development data precedes extraction tuning; blind data follows configuration freeze. Publish first-run precision/recall, TP/FP/FN/abstentions, field/source validity, missed conflicts, wrong fulfillment, latency/resource scope and failures.
- Every fulfillment has a matching supported receipt and exact version/entity/predicate; wrong entity, stale version/approval, missing condition, draft-only evidence and contradictory state cannot silently fulfill.
- Confirmed replacements supersede only explicit linked versions, independent of arrival order. Repeated sources/approvals and restart do not duplicate a commitment or logical fulfillment.
- Real EspoCRM read→approved guarded PUT→separately authenticated GET, forbidden-write negative checks, stale revision/refused approval and uncertain-response reconciliation are exercised. No general Salesforce/HubSpot compatibility is claimed.
- Clean artifact install, local UI, static interactive demo, English docs/license/notices, actual mobile/desktop/keyboard screenshots, measured workload and independent current-SHA/source+artifact acceptance pass before publication.

## Design

Use a small original vector mark and a quiet cool neutral palette with restrained translucent controls. Screens contain commitment/version list, exact source, term changes, required decisions, CRM comparison and receipt/history. Status always has a reason. No slogans, promotional hero, decorative counters, unsupported confidence badges or repeated explanations. Every control changes a useful state or opens relevant evidence.
