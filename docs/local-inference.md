# Local inference

The exercised CPU profile uses official `Qwen/Qwen3-4B-GGUF`, revision `bc640142c66e1fdd12af0bd68f40445458f3869b`, file `Qwen3-4B-Q4_K_M.gguf` (2497280256 bytes). SHA256:

```text
7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5
```

The inference image is `ghcr.io/ggml-org/llama.cpp@sha256:d4fbf665d0676b8893fae8a0c8216b217d1a9cce849e0f22fdf21832211b7056` (build 12211, commit 7d7f02875). The tested limit is 4 CPU threads,6 GiB memory,4096 context, one parallel request,256 MiB prompt RAM cache and no GPU. Quality and timing depend on this profile; this does not certify arbitrary OpenAI-compatible servers.

For a Linux Docker host, first obtain the pinned file from [the official repository](https://huggingface.co/Qwen/Qwen3-4B-GGUF/tree/bc640142c66e1fdd12af0bd68f40445458f3869b), verify its SHA256, and place it in a local `models/` directory. The following reproduces the tested server arguments with an explicit loopback port:

```sh
docker run --rm --name pactspan-local-model \
  --cpus 4 --memory 6g --memory-swap 6g --pids-limit 256 \
  --cap-drop ALL --security-opt no-new-privileges --user 65534:65534 \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --mount "type=bind,source=$(pwd)/models,target=/models,readonly" \
  -p 127.0.0.1:40003:8080 \
  ghcr.io/ggml-org/llama.cpp@sha256:d4fbf665d0676b8893fae8a0c8216b217d1a9cce849e0f22fdf21832211b7056 \
  -m /models/Qwen3-4B-Q4_K_M.gguf --alias pactspan-qwen3-4b-q4_k_m \
  --host 0.0.0.0 --port 8080 -c 4096 -t 4 -tb 4 -ngl 0 --parallel 1 --cache-ram 256 \
  --jinja --reasoning auto --chat-template-kwargs '{"enable_thinking":false}' --no-webui
```

Keep the prompt cache bounded explicitly. This pinned server defaults to 8192 MiB of RAM cache, above the container's6 GiB memory limit. In a development batch that produced sustained memory reclaim and repeated300s timeouts without an OOM kill. The failed partial run is retained separately from the later bounded-cache evaluation.

Set `PACTSPAN_MODEL_ORIGIN=http://127.0.0.1:40003` and `PACTSPAN_MODEL=pactspan-qwen3-4b-q4_k_m` in the environment of the Node server. Use no model API key. Pactspan sends nested `response_format.json_schema.schema`, Boolean `enable_thinking:false`, temperature 0 and seed 42; this fixed evaluation profile is not a claim to use every upstream recommended sampling default. A request has 120s deadline and the local CLI allows2048 output tokens. Timeout/truncation/invalid output remains a retained failure with no retry or fallback.

The model's wire deadline is null when absent, or an exact `literal` with constant `resolved:null`, `precision:"unknown"`, `zone:null`. These placeholders do not classify the source deadline as unknown. The deterministic client parser computes those fields and deadline uncertainty from the literal and source context; model-supplied computed values are schema-invalid and retained as diagnostics. Deadline postprocessing handles exact full dates, explicit offset instants, and anchored today/tomorrow wording in English/Russian with optional stated London/Moscow/UTC zone. It requires literal source wording and explicit interpretation context. Unsupported expressions, missing years/zones and ambiguous/nonexistent local times stay unresolved. Date-only values never acquire an invented midnight cutoff. The parser uses the Node runtime's ICU/IANA data; evaluation records those versions.

`PACTSPAN_MODEL_TIMEOUT_MS` can set a deadline from 100 to 300000ms; `PACTSPAN_MODEL_MAX_TOKENS` accepts16 to 2048. Defaults are 120000ms/2048 tokens. Larger CPU responses may need the longer deadline; recorded evaluation settings identify the exact bound. The UI reports extraction in progress and lets you export saved history while waiting.

Stop only the model container you created, using its displayed name/ID. Model downloads, memory, host energy and operator time are separate from Pactspan's package and are not included in a paid API cost claim.
