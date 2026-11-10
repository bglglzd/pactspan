# Evaluation results

Measurements below were captured on 2026-11-10. Automatic extraction is experimental and needs human review. The first held-out run produced no exact commitment matches. The working manual review, approval and receipt journey does not depend on model accuracy.

## Automatic extraction

The development set has twenty cases (ten English, ten Russian), 25 sources and 24 positive annotations. A separate coding-agent curator authored ten held-out cases (five English, five Russian), twelve sources and eleven positive annotations after the pipeline was frozen. These are synthetic agent-authored conversations, not customer data or a human-participant study.

| First response per source | Development v5 | First held-out v5 |
| --- | ---: | ---: |
| Completed HTTP calls / attempted calls | 25 / 25 | 12 / 12 |
| Raw predictions | 32 | 18 |
| Gold commitments | 24 | 11 |
| Exact true positives | 3 | 0 |
| False positives | 29 | 18 |
| False negatives | 21 | 11 |
| Exact precision | 9.375% | 0% |
| Exact recall | 12.5% | 0% |
| Unsupported predictions | 1 | 11 |
| Schema-invalid predictions | 0 | 0 |
| Successful empty responses | 1 | 0 |
| Median call latency | 35.754 s | 53.502 s |
| P90 call latency, nearest rank | 55.850 s | 85.419 s |
| Sum of observed call latency | 948.834 s | 792.328 s |

[Unmodified development report](evaluation-data/development-report.json) · [Unmodified first held-out report](evaluation-data/held-out-report.json)

The frozen `pactspan-extraction-score-v1` scorer requires one-to-one matches of all semantic fields, the exact deadline literal and unknown-field set, source overlap and valid supported structure. Every raw prediction contributes to the denominator, including unsupported rows and duplicates. There are no retries, best-of selection or removed error rows. No accuracy threshold was established.

Broad source-span alignment found 24/32 development predictions and 11/18 held-out predictions associated with gold spans. This is a diagnostic alignment, not semantic accuracy. Field agreement below is conditional on those aligned rows:

| Field | Development, /24 | Held-out, /11 |
| --- | ---: | ---: |
| Agreement classification | 17 | 8 |
| Owner | 18 | 9 |
| Action kind | 24 | 11 |
| Entity | 24 | 11 |
| Amount | 24 | 10 |
| Currency | 24 | 10 |
| Deadline literal | 12 | 3 |
| Resolved deadline | 15 | 9 |
| Deadline precision | 15 | 8 |
| Deadline zone | 16 | 7 |
| Literal conditions | 16 | 6 |
| Exact unknown-field set | 12 | 0 |

The held-out resolved-deadline count includes eight null/null comparisons and only one correct non-null date. It does not mean nine correctly interpreted deadlines.

## Errors and scoring limits

All eleven unsupported held-out predictions copied a source's meeting timestamp into a deadline even though those characters did not occur in the spoken text. They were rejected by the exact-source checks. This is invented deadline content, not a missing timezone implementation.

Among aligned held-out rows there were two incorrect owners, three incorrect agreement classifications, one background amount assigned to the wrong action and four rows with spurious prerequisites; categories overlap. Seven extra predictions included questions, refusals, a background draft/value, a reversed withdrawal and a no-change statement classified as proposal dispatch. Source quotes alone did not prevent these semantic errors.

The exact-record score also has representation limits. It requires complete literal wording and exact unknown-field paths. The narrow deterministic date grammar leaves some genuine wording unresolved; date-only deadlines add an explicit unknown cutoff. Generic actions with no amount/currency retain those unknowns. Some gold labels use broader uncertainty paths, and the development D12 prerequisite path differs from the normalizer's canonical path. Such differences can prevent an exact match without proving every field wrong. They do not erase the observed semantic errors. Gold, parser and scorer were not relaxed after seeing held-out output; the reported zero exact matches remains unchanged.

The parser supports a narrow English/Russian date grammar with supplied IANA interpretation context. An unsupported phrase remains unresolved even in an otherwise supported timezone. It never supplies an unstated year, timezone or date-only midnight cutoff. See [the inference contract](local-inference.md).

## Runtime and cost

Both final v5 sets used the same CPU profile:

- Official `Qwen/Qwen3-4B-GGUF`, revision `bc640142c66e1fdd12af0bd68f40445458f3869b`, `Qwen3-4B-Q4_K_M.gguf`; SHA256 `7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5`.
- llama.cpp build 12211, commit `7d7f02875`, image digest `d4fbf665d0676b8893fae8a0c8216b217d1a9cce849e0f22fdf21832211b7056`.
- Linux x64 shared host with sixteen logical CPUs; container limit four CPUs, four inference threads, 6 GiB memory, no swap, 4096 context tokens, one parallel request, no GPU, 256 MiB prompt RAM cache.
- Node 22.22.1; `pactspan-extraction-v5`, deadline parser v2; temperature 0, seed 42, non-thinking mode, 2048 output-token limit, 300-second request deadline.
- Configuration SHA256 `5651b16dece3b263fd5d11ebe95a4e5e332e95b8493c051c596d084426bc40a8`.

Timing is per source call, not a benchmark of arbitrary meeting length or a controlled comparison across hardware. No paid API was used. Host energy, hardware, model download and operator time were not priced; the measurements do not establish zero total processing cost. [Reproduction setup](local-inference.md).

## Manual domain journeys

All thirty authored manual journeys passed against the actual domain engine and separate Demo CRM. Gold supplies candidate terms and human decisions; this does not measure automatic extraction or population-level safety.

| Observed assertion or operation | Result |
| --- | ---: |
| Cases / failed cases | 30 / 0 |
| Receipt-to-version binding violations | 0 |
| Unexpected fulfillment in 114 nonfulfilled step assertions | 0 |
| Missed disputes in 10 specified disputed step assertions | 0 |
| Successful logical writes | 9 |
| Logical fulfillments | 11 |

The 30-case replay took 150.517 ms in one observed pass on Windows x64, Node 24.19.0, Intel Core i7-12700K with twenty logical CPUs. It uses in-memory serialization for its restart steps, supplied deadline values and explicitly injected reader/write faults. It is not a disk-crash, natural-language date or refusal-classification measurement. Separate integration tests exercise filesystem/process recovery. These counts refer to step assertions, which can revisit the same commitment. [Per-case results and limits](evaluation-data/manual-journeys.json).

## Freeze and retained experiments

The final pipeline/runtime was frozen at 15:17:22 UTC. The separate curator created the held-out set at 15:23:43 and sealed it at 15:27:47. The first held-out score finished at 15:42:19; the implementer first opened its sources, labels and results at 15:47:40. The published held-out files are now regression data, not unseen data for future tuning. Any later tuning needs a new held-out set.

Earlier development results remain available:

| Experiment | Observed result |
| --- | --- |
| v3, default cache | 25 completed calls; 1 TP, 32 FP, 23 FN; precision 3.03%, recall 4.17%; median 60.457 s |
| v4, default cache, interrupted | 8 completed calls, 5 timeouts, 1 pending call and 11 sources not attempted; no complete score |
| v4, 256 MiB cache | 25 completed calls; 1 TP, 30 FP, 23 FN; precision 3.23%, recall 4.17%; median 30.332 s |
| v5, 256 MiB cache | Final development result above; some field diagnostics worsened |

The interrupted container had a 6 GiB cap while the server's default prompt RAM cache was 8192 MiB. Measured reclaim/refault pressure and repeated 300-second timeouts led to stopping that run; no OOM kill occurred. Its partial results were not assigned a complete score. Later runs bounded the cache explicitly. Prompt/output changes and shared-host conditions prevent attributing all latency or quality differences to that resource change.

[Retained experiment history and report digests](evaluation-data/history.json) · [v3 report](evaluation-data/baseline-v3-report.json) · [v4 bounded-cache report](evaluation-data/development-v4-report.json) · [Dataset provenance](dataset.md)
