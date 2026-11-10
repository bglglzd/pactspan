# Synthetic corpus

`examples/development/D01.json` through `D20.json` contain twenty authored synthetic scenarios: ten English and ten Russian. They were manually specified by a coding agent on 2026-11-10 against [the dataset contract](dataset-contract.md), using the specification-only base `ea41e15f8b8772c352caab02021e7ee9c16ea3ae`. They are not recorded conversations, customer research, human participant studies, or outputs from an extraction model. Names, commercial terms, CRM records and 2030 meeting times are fictional.

Gold labels and journey outcomes were chosen from the authored conversation and product specification. Mechanical formatting and UTF-16 span calculation do not infer agreement, terms or expected state. No extractor, model endpoint or implementation replay was used to generate the annotations or expected results. These files are development data available for tuning; they are not a blind evaluation set.

An extraction request must contain only the source material and its supplied interpretation context. Do not send `annotations`, `negative_evidence`, `journey` or `expected` to the model, and do not count authored adversarial candidate probes as observed model errors.

## Contents

| Case | Language | Required distinction |
| --- | --- | --- |
| D01 | EN | Explicit accepted amount, human confirmation, approved change and fresh read |
| D02 | RU | A false prerequisite blocks action and fulfillment despite matching CRM values |
| D03 | EN | A refused counteroffer does not create a confirmed action |
| D04 | RU | A suggested discussion has no agreed amount or commitment |
| D05 | EN | An accepted action with no owner remains unconfirmed |
| D06 | RU | A relative deadline uses the supplied meeting date and Moscow zone |
| D07 | EN | Date-only precision and a repeated London wall time stay distinct |
| D08 | RU | An accepted amendment supersedes explicit terms despite reversed import order |
| D09 | EN | A later unaccepted proposal cannot replace the accepted version |
| D10 | RU | Accepted conflicting currencies require an explicit resolution |
| D11 | EN | Altered/missing quotes and quoted instructions cannot authorize transitions |
| D12 | RU | An unresolved pronoun, two Alexeys and an unknown prerequisite remain explicit |
| D13 | EN | A draft and current CRM amount cannot verify proposal dispatch |
| D14 | RU | Correct values on the wrong entity cannot fulfill |
| D15 | EN | Old-version proof is refused; later fulfillment preserves overdue history |
| D16 | RU | Restart/repetition creates no second logical write or fulfillment |
| D17 | EN | Identical source/context deduplicates; edited text remains a separate source |
| D18 | RU | Expired or changed approval scope cannot reach CRM |
| D19 | EN | A timed-out write stays uncertain through restart until a fresh read |
| D20 | RU | A later contrary CRM state disputes the promise and preserves its earlier receipt |

## Reading the labels

Each annotation's `evidence` is an array of exact spans within its `source`. `segment` is zero-based; `start` is inclusive and `end` exclusive, measured in UTF-16 code units. An accepted cross-turn statement includes both the action and acceptance spans. D11 places an emoji before a quote so code-point or UTF-8-byte offsets cannot accidentally pass as UTF-16 offsets. Prediction probes with deliberately invalid quotes appear only in D11's journey; they are not valid gold source spans and must remain visible as unsupported predictions.

`agreement` describes the language, not the application's lifecycle. Even accepted wording begins as a proposed application candidate until a manager decision. Explicit proposals can be candidates without being accepted; refusal/aspiration text is separate negative evidence. `owner` is a mapped fictional person ID or null, never inferred from a speaker's apparent authority. D05 and D12 retain missing ownership. Participant mappings describe the synthetic source, not verified real identities.

`due` contains `literal`, `resolved`, `precision` (`instant`, `date`, `unknown`) and `zone`. Unknown values are null and named in `unknown_fields`. D07's instant precision describes the requested time granularity; its null resolved value records the DST ambiguity. A date-only deadline supplies no implicit midnight cutoff. Relative resolutions use the explicit source anchor and IANA zone. Amounts are literal decimal strings; no discount calculation or currency inheritance is part of gold. `conditions` contains literal text, known/unknown status and, when known, a Boolean value.

The CRM snapshot is the state at journey start, which can be later than the recorded conversation. It is not a source for extracting unstated terms. For example, D02 deliberately begins with a matching current amount despite the unmet condition. An observation with O2 is not an observation of O1. Synthetic CRM revision numbers are separate from commitment versions.

## Declarative journeys

Before model evaluation, executable replay found four oracle inconsistencies: D08/D16/D18 used approvals longer than the specified one-hour limit, and D10 numbered both conflicting versions1. The journey parameters now use45-minute approvals and D10's second confirmed version2. Source text, semantic annotations and quotes were unchanged; these were workflow-oracle corrections, not model-output-based relabeling.

Journeys are independent author-written specifications, not executable commands or captured implementation output. `action` names describe a decision, observation, attempted action or external change. `expected_state`/`refusal_reason` specify the intended result. The `manager` actor and `reader` role are synthetic application roles. An absent refusal does not waive the normal version, scope, prerequisite or fresh-read guards.

`expected.commitments` identifies the annotated version and final lifecycle. `receipt_count` counts logical fulfillment receipt bindings, not every observation; repeated matching reads can be retained without another logical fulfillment. `logical_writes` counts successful Pactspan external changes, excluding external operator edits and refused local requests. D19's `persisted_attempts` counts external write attempts, excluding its guarded refusal to send again. D15's current match supplies no proof of on-time execution, and D20 retains its earlier receipt while ending disputed. These distinctions must survive any later executable test mapping.

## Authoring checks and remaining scope

Authoring validation found twenty unique case IDs, exactly ten EN/ten RU, 24 annotations, 46 positive source spans and 12 negative source spans. Source/speaker/owner/entity/annotation/approval references and exact UTF-16 quote slices were checked; a separate Python check verified all 58 spans by slicing UTF-16 bytes. Dates, currencies, amounts and expected histories were inspected against the authored text, and the London repeated local time was checked with IANA timezone formatting. Data contains no credentials, real customer identifiers, private contacts, network configuration or recording material.

These checks establish corpus integrity, not extraction quality. A separate coding-agent curator authored `examples/held-out/H01.json` through `H10.json` after the extraction pipeline/runtime was frozen on2026-11-10 at15:17:22UTC. The ten cases contain five English and five Russian scenarios, twelve sources and eleven positive annotations. Their first scored run completed at15:42:19UTC; the implementer opened the sealed sources, labels and results at15:47:40UTC. No predictor or label changes followed that reveal. The published set is now available for inspection and regression; it is no longer unseen data for future tuning.

The thirty manual domain journeys pass with supplied gold decisions. That result is separate from the measured automatic extraction, whose first held-out exact-record precision/recall are both0. Read [results and limitations](evaluation-results.md), including uncertainty-label mismatches and the narrow deadline grammar. All original first-run reports and earlier development results are retained. This is synthetic agent-authored data, not a customer or human-participant study; no score threshold was established.
