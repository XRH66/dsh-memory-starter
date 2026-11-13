# Third-party sources and notices

本项目自身代码采用 [MIT](LICENSE)。下列第三方代码、工具、模型与服务保留各自许可；本声明不将它们统一改为 MIT。模型权重、Python 运行库、llama.cpp 二进制与 Basic Memory 软件均不在候选中分发。

## 参考与改写：Suzu Memory

- 上游：[eryucheng/suzu-memory](https://github.com/eryucheng/suzu-memory)。固定提交：[`645c862470b1a207c9904e614083f8b77a8f15bf`](https://github.com/eryucheng/suzu-memory/tree/645c862470b1a207c9904e614083f8b77a8f15bf)。
- Copyright 2026 儿玉诚也；**Apache-2.0**，完整原文随包保留在 [third-party/suzu-memory.LICENSE](third-party/suzu-memory.LICENSE)。固定上游树没有 NOTICE 文件，本文件是接入项目自行编写的来源说明。
- 发行包不含 Suzu 上游源码，只随包保留其 LICENSE。运行代码不导入上游文件；改写自上游思路的文件见下节，并在文件内保留 Apache-2.0 来源声明。
- 开发时曾在本地 `vendor/suzu-memory/` 下放过固定提交的副本作对照，它不入库，也不进入发行包。

DSH 会话开关及按需检索的方案比较也参考了 [eryucheng/dsh-suzu-memory](https://github.com/eryucheng/dsh-suzu-memory/tree/93cfd662d2662367476cfc02f3fa609a81c1bba4)。本候选不安装该第二套插件，其与核心来源分别列示，不把整个插件实现声称为本项目原创。

### Portable 原话嵌入背景适配

[embedding-material.js](lib/raw-rag/embedding-material.js)参考并改写上述固定版 [embedding-indexer](https://github.com/eryucheng/suzu-memory/blob/645c862470b1a207c9904e614083f8b77a8f15bf/packages/embedding-indexer/src/index.mjs) 的 `utteranceRetrievalContext` 与 `buildMemoryEmbeddingDocument` 思路：保留原话角色、有限上下文及可追溯来源，再交给嵌入后端。适配文件保留 Apache-2.0 来源声明。不同于上游关系图双向展开，本项目从既有原文库按同会话、同轮或紧邻上一轮取有限前文；增加本项目授权片段、来源版本复核、模型长度约束及中心原文坐标映射，不导入整套 Suzu host，也不启用其生成式背景提案／审核。

[Anthropic Contextual Retrieval](https://www.anthropic.com/research/contextual-retrieval)仅作为“编码前补语境”的原理参考，没有复制其代码或提示词。该方案用大模型生成片段背景；本次实现仅组合已保存的原话，不增加生成模型调用，也不扩展关键词索引。之后另加的可选重排默认关闭，只调用用户自己配置的 OpenAI 兼容 rerank 接口，不随包分发任何模型。

## 自有项目间复用

人设渲染和原子编辑适配来自 [XRH66/dsh-global-settings](https://github.com/XRH66/dsh-global-settings)，原代码 MIT；对应 persona 文件中保留来源和修改说明。运行时不依赖另装该仓库，候选不复制其本机配置或历史 AGENTS。

## 宿主与 Node 外部依赖

下表按本项目已安装包的 primary `package.json` 核对；实际交付依赖解析另行验收。候选不复制这些包的 `node_modules`，也不替代它们各自附带的 LICENSE/NOTICE。

| 组件 | 核对版本 / 许可 | 原始来源 |
| --- | --- | --- |
| DeepSeek Harness CLI、会话格式 catalog、session | 0.2.1-rc.5 / MIT | [DeepSeek 官方仓库](https://github.com/deepseek-ai/deepseek-harness)，包名 `@deepseek-ai/dsh`、`@deepseek-ai/dsh-session-format-catalog`、`@deepseek-ai/dsh-session` |
| Schemastery fork | 3.18.5 / MIT | 同一官方仓库 `vendor/schemastery`，包名 `@deepseek-ai/schemastery` |
| Node.js | 宿主环境提供 | [Node.js LICENSE](https://github.com/nodejs/node/blob/main/LICENSE)，包含运行时及第三方组件条款 |

Suzu 固定核心的闭包只使用内部包及 Node 内置模块；内部导入已转换，因此没有要求新装额外 Suzu workspace 包。浏览器 React 与界面模块由 DSH 宿主提供，实际源码导入集合见候选 `candidate-files.json`。

## 宿主用途路由与 Go 多连接准备工具

`scripts/dsh-memory-routing/` 和 `scripts/prepare-dsh-memory-routing.mjs` 是此前 rc5 候选使用的宿主路由、连接变换和随机身份 helper，继续使用本项目 MIT。上述工具不在当前公开发布白名单内；未来单独发布时须同时提供源码、来源说明和完整许可。

变换锚点及最小 fresh fixture 中的 DSH 片段源于官方 `@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-llm-pi-ai` **0.2.1-rc.5**，Copyright (c) 2026 DeepSeek，MIT。当前发布包不分发这些工具，也不分发本机 baseline、变换后的安装 bundle 或用户配置；完整署名与许可应在后续单独发布时一并提供。

检查还固定 `@earendil-works/pi-ai` **1.5.0**；其 primary 包清单声明 MIT，来源为 [earendil-works/pi 的 packages/ai](https://github.com/earendil-works/pi/tree/main/packages/ai)。本次没有复制或修改 SDK 源码。生成的 baseline／candidate 只是用户所选安装的本地审阅副本，不是本项目重新发布的第三方软件包；工具不应用补丁、不安装依赖、不计算新哈希。

## 旧后端：Basic Memory

[Basic Machines / Basic Memory](https://github.com/basicmachines-co/basic-memory) 是此前方案使用的独立 Python/MCP 后端，既有部署基线为 0.24.1。该版本 [pyproject.toml](https://github.com/basicmachines-co/basic-memory/blob/v0.24.1/pyproject.toml) 明确声明 **AGPL-3.0-or-later**，[LICENSE 原文](https://github.com/basicmachines-co/basic-memory/blob/v0.24.1/LICENSE)为 GNU AGPL v3。

本项目已不再包含连接或启动 Basic Memory 的代码，也不再依赖 MCP 客户端；记忆正文由本项目直接读写 Markdown Vault。Basic Memory 本身没有被复制、改许可或捆绑进本候选。既有 Markdown 与项目登记由迁移预览保留；若另外分发或部署 Basic Memory，应按其自身版本和许可处理。

## 外部向量模型与运行后端

以下是当前资源 catalog 的来源，不代表文件已经下载或通过本候选运行验收。实际制品须按各自 revision、文件名和随附许可核对。

| 资源 | 来源与许可依据 |
| --- | --- |
| BGE-small-zh-v1.5 ONNX | [Qdrant 转换，46fbe35…](https://huggingface.co/Qdrant/bge-small-zh-v1.5/tree/46fbe35fd4374a00fee7de77dfddaeb6dd6a2c59)，[固定模型卡](https://huggingface.co/Qdrant/bge-small-zh-v1.5/blob/46fbe35fd4374a00fee7de77dfddaeb6dd6a2c59/README.md)声明 MIT；[FlagEmbedding 原许可](https://github.com/FlagOpen/FlagEmbedding/blob/master/LICENSE) |
| Qwen3-Embedding-0.6B ONNX | [ONNX Community 转换，c25a394…](https://huggingface.co/onnx-community/Qwen3-Embedding-0.6B-ONNX/tree/c25a394dd583836952667c12f008335071b3f43d)的模型卡没有独立 license 字段；[Qwen 原模型卡](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/blob/main/README.md)声明 Apache-2.0。原模型许可声明不替代对转换制品来源及条款的核对 |
| Qwen3-Embedding-4B GGUF | [官方 f460253…模型卡](https://huggingface.co/Qwen/Qwen3-Embedding-4B-GGUF/blob/f4602530db1d980e16da9d7d3a70294cf5c190be/README.md)声明 Apache-2.0 |
| Qwen3-Embedding-8B GGUF | [官方 69d0e58…模型卡](https://huggingface.co/Qwen/Qwen3-Embedding-8B-GGUF/blob/69d0e58a13e463cd99a9b83e3f5fee7c10265fab/README.md)声明 Apache-2.0 |
| Python | 复用已有解释器或按安装计划准备；[Python 3.12 许可](https://docs.python.org/3.12/license.html) |
| NumPy 2.5.4 | [PyPI primary metadata](https://pypi.org/pypi/numpy/2.5.4/json)的许可表达式为 `BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0`；还需保留实际 wheel 的第三方声明 |
| Tokenizers 0.23.3 | [PyPI metadata](https://pypi.org/pypi/tokenizers/0.23.3/json)声明 Apache Software License；[上游 Apache-2.0 原文](https://github.com/huggingface/tokenizers/blob/v0.23.3/LICENSE) |
| ONNX Runtime 1.31.0 | [PyPI metadata](https://pypi.org/pypi/onnxruntime/1.31.0/json)声明 MIT；[原文](https://github.com/microsoft/onnxruntime/blob/v1.31.0/LICENSE)及[第三方声明](https://github.com/microsoft/onnxruntime/blob/v1.31.0/ThirdPartyNotices.txt) |
| FastEmbed 0.9.0 | [PyPI metadata](https://pypi.org/pypi/fastembed/0.9.0/json)声明 Apache-2.0；[上游许可](https://github.com/qdrant/fastembed/blob/v0.9.0/LICENSE) |
| llama.cpp | catalog 使用 [官方 b12110 发布](https://github.com/ggml-org/llama.cpp/releases/tag/b12110)，[MIT 原文](https://github.com/ggml-org/llama.cpp/blob/b12110/LICENSE)；实际运行包中的其他组件另按其声明 |
| 可选 CUDA 配套运行库 | 对应下载包及 [NVIDIA CUDA 12.4 EULA](https://docs.nvidia.com/cuda/archive/12.4.0/eula/index.html)；不随本候选分发 |

API 型号通过服务商 endpoint 调用，模型不在包中；服务使用条款、计费和数据处理按所选服务商执行。软件许可与服务条款分别适用。

原始安装资源、固定版本及已有校验值见 [install-catalog.js](lib/raw-rag/install-catalog.js)。直接 Python 依赖虽固定版本，传递依赖未全部锁定；手动已有制品应保留其实际来源记录，不能以 catalog 替它追认。
