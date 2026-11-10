# Third-party software

Pactspan's original source and vector identity use the MIT license in [LICENSE](LICENSE). There are no bundled third-party JavaScript runtime dependencies, CRM source, model weights or inference-server binaries.

The separately installed runtimes used during development are:

| Component | Pinned source | License |
| --- | --- | --- |
| EspoCRM10.0.12 | [19cc201e515b17898c13bb406a75531b679ab975](https://github.com/espocrm/espocrm/tree/19cc201e515b17898c13bb406a75531b679ab975) | [AGPL3.0](https://github.com/espocrm/espocrm/blob/19cc201e515b17898c13bb406a75531b679ab975/LICENSE.txt) |
| Qwen3-4B-GGUF | [bc640142c66e1fdd12af0bd68f40445458f3869b](https://huggingface.co/Qwen/Qwen3-4B-GGUF/tree/bc640142c66e1fdd12af0bd68f40445458f3869b) | [Apache2.0](https://huggingface.co/Qwen/Qwen3-4B-GGUF/blob/bc640142c66e1fdd12af0bd68f40445458f3869b/LICENSE) |
| llama.cpp | [7d7f02875](https://github.com/ggml-org/llama.cpp/tree/7d7f02875) | [MIT](https://github.com/ggml-org/llama.cpp/blob/7d7f02875/LICENSE) |

These runtimes keep their own licenses and notices. Their source/weights are obtained from the linked upstream projects, separately from Pactspan's package. See [local inference](docs/local-inference.md) for the exercised model identity and configuration.
