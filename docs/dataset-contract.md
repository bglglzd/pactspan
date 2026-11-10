# Predeclared dataset contract

This contract is fixed before extractor implementation. It describes authored synthetic data, not completed annotations or measured accuracy. Development cases D01..D20 cover the twenty families recorded in the private preparation plan, ten EN and ten RU. Each is a separate JSON file with the following keys:

```json
{
  "schema_version": 1,
  "id": "D01",
  "language": "en",
  "title": "Short factual case label",
  "sources": [{
    "id": "meeting-a",
    "title": "Synthetic meeting",
    "meeting_at": "2030-01-08T09:00:00Z",
    "time_zone": "Europe/Moscow",
    "participants": [{"speaker": "Alex", "person_id": "alex"}],
    "segments": [{"speaker": "Alex", "start_secs": 0, "end_secs": 5, "text": "Exact authored text."}]
  }],
  "annotations": [],
  "negative_evidence": [],
  "crm_initial": [],
  "journey": [],
  "expected": {"wrong_fulfillments": 0, "reason": "Manually specified end-state or refusal rule"}
}
```

An annotation has `id`, `source`, `agreement` (accepted/proposed/conditional/unknown), `evidence` (`segment` zero-based index, exact `quote`, UTF-16 `start`/`end`), `owner` (mapped person ID or null), `kind` (crm.amount/proposal.sent/other), `entity_id`, `amount` (explicit canonical decimal string or null), `currency`, `due` (literal wording, resolved instant/date or null, precision and zone), `conditions` (literal text and known/unknown status), `unknown_fields`, and optional `supersedes`/`conflicts_with` annotation references. Quotes are chosen from the source; arithmetic, currency, authority and deadlines cannot be invented.

`negative_evidence` records exact source/segment/quote and a reason such as refusal, aspiration, question, quoted speech or unresolved pronoun. An explicit proposed/conditional action can be a candidate; a refused/noncommittal statement is not a positive commitment candidate. Agreement classification and field accuracy are evaluated separately from candidate detection. Invalid source quotes remain unsupported and are counted/reported; they cannot disappear into a perfect-looking precision score. Duplicate predictions cannot match one gold item more than once.

`journey` is a declarative author-written sequence: action, annotation/version/entity reference, relevant values and the expected state/refusal reason. It is an independent specification, not executable code or an output copied from the eventual implementation. Include manager confirmation, explicit supersession/conflict, separate CRM observations/action approvals/attempts, restart/repeated events and unsupported evidence where relevant. `expected` records final lifecycle/history/receipt constraints. CRM examples use synthetic O1/O2, explicit amount/currency/revision and no credentials or real customer identifiers.

At least ten blind cases H01..H10 are authored by an independent curator only after model/prompt/configuration and development evaluation freeze. Their exact texts/labels stay outside the implementer's source until the first scored run. Record dataset/configuration digests first; do not tune on the blind cases. Publish the original first-run results and error analysis. Subsequent tuning needs a new blind set; a rerun of revealed data is regression evidence, not a new holdout result.
