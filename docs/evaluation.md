# Extraction evaluation protocol

`await scoreExtractions(fixtures, runs)` from `src/evaluation/extraction.mjs` scores retained extraction artifacts. It makes no model or network calls. Protocol ID: `pactspan-extraction-score-v1`. Tests use small authored examples, not customer data, model outputs or a holdout study.

Freeze the source/package, evaluator, prompt/schema, generation settings, model/weights/server and deterministic postprocessor before the first scored run. Record their digests and retain each first response or failure. Development fixtures may be used for tuning; the later independently authored blind set must remain unread until the first frozen evaluation. No quality threshold is established here, and this protocol does not itself complete the required thirty-case dataset.

## Inputs and source identity

Supply the complete fixtures and one run for **every fixture source**, including sources with no positive annotations:

```js
const runs = [{
  case_id: 'D01',
  source_alias: 'meeting-a',
  source_id: canonicalSource.id,
  result,                         // full extractCandidates return value
  elapsed_ms: 123
}];
// A failed call instead supplies failure:{code,message,evidence} and elapsed_ms.
const report = await scoreExtractions(fixtures, runs);
```

The evaluator recomputes each source ID with `makeSource`; fixture aliases are not content identities. It rejects missing, duplicate, unknown or mismatched case/source runs, mismatched embedded source IDs, duplicate raw indices and inconsistent raw/response records. Every report retains the original input `run_index`. Multiple calls for one source cannot be selected as best-of-N. The driver must capture the first call; an evaluator cannot discover an attempt withheld before its input was supplied.

Gold is used only inside scoring. Send only the canonical source whitelist to the extractor: never annotations, negative evidence, journeys, expected states or this report. The evaluator does not forward anything to a model.

## Raw inventory and failures

Use the complete adapter result, not filtered controller candidates. When retained response content parses, its entire `candidates` array determines inventory; indexed wrapper `.raw` must agree. Otherwise `raw_candidate_count` and complete `raw_index` records establish the inventory. Missing captured slots become explicit placeholder false positives. Invalid/null/unsupported and duplicate predictions retain their raw indices; schema failures cannot disappear. A duplicate prediction can match at most one gold record.

Failures are never successful empty arrays. A failed call cannot earn a TP, even if partial content looks correct. Known failed counts contribute FP placeholders and retain all gold FN. If raw cardinality is unknown, primary `fp`, prediction count and precision remain `null`; `known_predictions`, `fp_known_lower_bound`, unknown-run counts and a labelled precision upper bound expose the available evidence. Recall still counts the unrecovered gold as FN. Source/quote validity rates also remain unknown when their denominator is incomplete. Nonconforming multiple-choice envelopes are failed artifacts; all parsable choices are retained rather than selecting the best one.

`successful_empty`/`abstentions` mean only a completed zero-candidate output. Unknown/refused agreement labels are still predictions. Zero denominators yield `null`, never a manufactured1. Captured output bounds are finite; impossible count/index metadata fails loudly rather than producing a score from truncated records.

## Pipeline authentication and strict matching

Each raw record is independently checked against the frozen candidate schema. Citations are rechecked against the bound original source using UTF-16 spans; a missing unique quote can derive offsets, while repeated, altered or invalid quotes remain unsupported. An extra source claim cannot redirect a citation.

The semantic record is recomputed from raw terms with the actual `terms`, `resolveDeadline`, `deadlineUnknowns` and explicit-null unknown-field rules. Supplied normalized terms/unknowns must agree. Thus canonical money and the deterministic deadline/unknown pipeline are allowed, while a wrapper cannot repair an erroneous amount, owner, entity, currency, prerequisite or arbitrary uncertainty. Raw output remains visible. Deadline resolution is a separate deterministic component, not evidence that the model inferred the resolved date.

A strict edge requires valid schema/support and at least one positive intersection between an exact supported predicted source span and a gold span on the **same source and indexed segment**. A paraphrased quote never qualifies. Every primary field must also match:

- Agreement, kind, entity, canonical amount, currency and owner.
- Deadline literal, normalized resolved instant/date, precision and zone.
- Prerequisite literals and the declared unknown-field set.

Statement wording is ignored. Absent deadline/null/empty literal representations share an explicit unknown deadline representation; offsets for equal instants normalize to UTC, date-only precision remains a date, and IANA zone text is otherwise exact. Prerequisite literal order is irrelevant but multiplicity is retained. Unknown fields are compared as a set. Raw condition known/value claims are scored separately as `conditions.claims`; they grant no manager attestation and are not part of the primary strict semantic criterion.

This strict record score is format-sensitive: a different exact deadline substring or a different free-form unknown-field label can fail it even when typed business values agree. Legacy development gold includes a business-specific `conditions.budget_approval` label. Such mismatches remain counted and visible; no alias is chosen after seeing predictions. Read the individual field errors, conditional alignment coverage and all unmatched outputs alongside strict precision/recall. Do not interpret this exact record score as independently judged general semantic accuracy.

Strict TP is a maximum one-to-one bipartite matching. All other known raw predictions are FP and unmatched gold is FN. The report gives TP/FP/FN and precision/recall, with explicit matched/unmatched indices, gold IDs and errors. Exact citation validity alone is not semantic accuracy, and source overlap does not prove complete evidence coverage or agreement authority.

## Detection and diagnostic fields

Detection is a separate maximum one-to-one matching using any locally supported positive source overlap, even when other predicted fields or schema are wrong. It is source-aligned presence, not independent semantic detection accuracy. Within maximum cardinality, diagnostic alignment prefers strict-compatible pairs, then stable raw-index/gold-order traversal. It never sacrifices detection cardinality to select a better-looking record. Alternative source-overlap gold choices are retained in each aligned pair. This avoids arbitrarily swapping two correct candidates that cite the same whole turn.

Field accuracy is computed over **all aligned records**, including non-strict residuals, not just strict TP. Each field reports correct/total and conditional accuracy. Report its alignment coverage and unmatched/duplicate FP alongside it: a high conditional field score cannot erase unaligned errors. Field errors and explicit source-aligned alternatives remain inspectable.

## Workload, language, latency and cost

The same metrics are broken down by fixture language. Workload records cases, sources, segments and UTF-16/UTF-8 text size. `elapsed_ms` is supplied by the driver for each attempted call, including failures. Median averages the middle pair; p90 uses nearest rank. Missing timings are counted; summed call durations are not claimed as parallel wall-clock time.

Usage totals are sums of valid model-reported token counts with reported/missing coverage. Monetary cost remains unknown: no current pricing, electricity, hardware amortization or zero-cost claim is inferred. The function evaluates the supplied artifacts; freeze provenance and honest complete capture remain the driver's responsibility.

Run the protocol tests with `node --test tests/extraction-evaluation.test.mjs` on Node22+. Synthetic tests cover one-to-one matching, duplicate/error denominators, missing bindings, normalized-wrapper integrity, pipeline deadline processing and separate condition claims. They are not measured model quality.
