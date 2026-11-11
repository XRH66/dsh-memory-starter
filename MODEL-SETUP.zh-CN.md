# 向量模型安装与切换

本页说明向量模型的资源准备、设置生效和全域索引核对。本机实跑覆盖 4B CUDA、0.6B CPU 和 OpenAI 兼容接口（硅基流动 `BAAI/bge-m3`）。

## 在哪里选择

打开 **记忆框架设置 → 检索模型**。

1. 从已登记的模型中选择要准备的档位。常用本地档位为 Qwen3-Embedding 0.6B、4B、8B，4B／8B 可选 CPU 或 NVIDIA CUDA 12.4 运行包。BGE 的兼容资源仍列在 catalog。
2. 查看下载量、模型来源和设备资源建议。显存信息按需读取，建议可以自行调整。
3. 点“下载准备并保存选择”，或在高级设置提供已有完整文件后选用已有文件。下载可取消并续接。
4. 首次使用向量时，在「记忆」页打开「原话检索」（配置项 `rawRecall`）并保存。该历史字段也用于现行 portable 的向量接线。对话记忆由独立的会话开关授权，选中会话并开启后才在后续新回合生效；旧「回答前召回」控件已从 portable 入口移除。
5. 资源准备成功后保存模型设置。若页面报告待生效，按宿主流程重新加载记忆框架，分别核对设置是否生效和实际 active 档位。资源就绪、保存选择和切换 active 是三个状态。
   现在可以一次确认走完这三步：在「检索模型」里查看目标模型，点「切换到此模型」。确认框先给出只读预估（共多少篇、可直接复用多少篇、需编码多少篇及大约字数；云端另给估算 token 数和发送地址，并须勾选“我确认本次发送范围”）。确认后会记下这次切换：需要重新加载的，重新加载后自动开始准备；同一配置内的直接开始准备。全域索引就绪后才切换 active，并清除这次切换记录；准备中断或重启后会自动续建，已完成的文档不重复编码；失败不会无限重试，状态如实显示错误并提供「重试」。没有确认过的切换时，保存、重载与启动的行为与以前完全相同。
6. 在记忆框架运行页选择「准备索引」，目标档位全域索引就绪后才切换。现行单后端在准备期间可能释放旧模型，此时文字／条目通道继续可用。准备中断时按原任务「续建索引」。聊天中恰好有检索在途时，准备会提示“对话查询正在使用向量模型，请等这次对话结束后再点击”，等对话结束后重新点即可。旧 `scripts/raw-memory.mjs index` 只补旧原话链索引，旧 `apply` 只导入该链的原句库。

高级设置保留路径、CPU 线程、检索等待上限和空闲释放时间。手动改路径会解除旧安装记录关联；缺文件或依赖时会提示，不用新设置覆盖当前选择。

## 模型和资源

| 型号 | 默认本地文件 | 模型下载量 |
| --- | --- | --- |
| BGE-small-zh-v1.5 | Qdrant BGE ONNX | 约 95 MB |
| Qwen3-Embedding-0.6B | ONNX Community INT8 + tokenizer | 约 625 MB |
| Qwen3-Embedding-4B | Qwen 官方 Q4_K_M GGUF | 约 2.50 GB |
| Qwen3-Embedding-8B | Qwen 官方 Q4_K_M GGUF | 约 4.68 GB |

程序和 Python 依赖另计。新建 Python 环境的自动配方使用 3.12；满足依赖的已有环境可复用。准备器不修改系统 Python。自动 llama.cpp 包当前面向 Windows x64；其他系统或加速方式可在高级设置指定已有兼容程序。

资源建议依据可用内存、CPU 和按需读取的 NVIDIA 可用显存，属于保守预算，没有替用户跑性能测试。GPU 总容量不等于当前空闲显存。模型缺失、超时或资源不足时保留文本检索，不自动转云端。

现行 portable 的原文、长期条目及其他已纳入的资料共用一个 active 向量档。旧固定 BGE 事实召回属于兼容链，旧 BGE 模型、索引和 profile 仍可保留为旧链或恢复资产。若明确将支持的 BGE 档设为 active，已纳入的向量域同用该档。每个模型有独立的默认相似度下限；BGE 查询按模型约定加入检索指令，检索等待按模型和设备选择，优先级衰减在最终合并排序时计算。结构化条目正文及全文检索读本地 SQLite，Markdown 笔记由插件直接读写 Vault。

**新增模型。** 结构化配置限于现有后端支持的资源、编码格式、pooling、归一化和切片约定。Agent 自动适配仍是源码中的候选研究。

## 安装来源、固定版本与许可

来源、完整 revision、文件名、大小与 SHA-256 以随包 [安装 catalog](lib/raw-rag/install-catalog.js) 为权威；下表是 2026-11-06 快照。Python 的固定版本仅覆盖直接依赖，传递依赖未完整锁定。

| 组件 | 安装来源与固定版本 | 许可声明与原文入口 |
| --- | --- | --- |
| BGE-small-zh-v1.5 | [Qdrant ONNX 转换，46fbe35…](https://huggingface.co/Qdrant/bge-small-zh-v1.5/tree/46fbe35fd4374a00fee7de77dfddaeb6dd6a2c59)，`model_optimized.onnx` 及配套文件 | [固定模型卡的 MIT 声明](https://huggingface.co/Qdrant/bge-small-zh-v1.5/blob/46fbe35fd4374a00fee7de77dfddaeb6dd6a2c59/README.md)；[原项目 FlagEmbedding 的 MIT 原文](https://github.com/FlagOpen/FlagEmbedding/blob/master/LICENSE) |
| Qwen3-Embedding-0.6B | [ONNX Community 转换，c25a394…](https://huggingface.co/onnx-community/Qwen3-Embedding-0.6B-ONNX/tree/c25a394dd583836952667c12f008335071b3f43d)，`onnx/model_quantized.onnx` 与 `tokenizer.json` | [转换模型卡](https://huggingface.co/onnx-community/Qwen3-Embedding-0.6B-ONNX/blob/c25a394dd583836952667c12f008335071b3f43d/README.md)未单独声明许可；[原模型卡](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/blob/main/README.md)声明 Apache-2.0，[许可原文](https://www.apache.org/licenses/LICENSE-2.0.txt) |
| Qwen3-Embedding-4B | [Qwen 官方 GGUF，f460253…](https://huggingface.co/Qwen/Qwen3-Embedding-4B-GGUF/tree/f4602530db1d980e16da9d7d3a70294cf5c190be)，Q4_K_M | [固定模型卡的 Apache-2.0 声明](https://huggingface.co/Qwen/Qwen3-Embedding-4B-GGUF/blob/f4602530db1d980e16da9d7d3a70294cf5c190be/README.md)；[许可原文](https://www.apache.org/licenses/LICENSE-2.0.txt) |
| Qwen3-Embedding-8B | [Qwen 官方 GGUF，69d0e58…](https://huggingface.co/Qwen/Qwen3-Embedding-8B-GGUF/tree/69d0e58a13e463cd99a9b83e3f5fee7c10265fab)，Q4_K_M | [固定模型卡的 Apache-2.0 声明](https://huggingface.co/Qwen/Qwen3-Embedding-8B-GGUF/blob/69d0e58a13e463cd99a9b83e3f5fee7c10265fab/README.md)；[许可原文](https://www.apache.org/licenses/LICENSE-2.0.txt) |
| Python 解释器 | 复用已有安装；自动新建虚拟环境要求 3.12，补丁版本未锁定 | [Python 3.12 许可及所含软件说明](https://docs.python.org/3.12/license.html) |
| NumPy | [numpy 2.5.4，PyPI](https://pypi.org/project/numpy/2.5.4/)，[上游源码](https://github.com/numpy/numpy/tree/v2.5.4) | [该版本许可原文及第三方条款](https://github.com/numpy/numpy/blob/v2.5.4/LICENSE.txt)；二进制包还应查其自带许可 |
| Hugging Face Tokenizers | [tokenizers 0.23.3，PyPI](https://pypi.org/project/tokenizers/0.23.3/)，[上游源码](https://github.com/huggingface/tokenizers/tree/v0.23.3) | [该版本 Apache-2.0 原文](https://github.com/huggingface/tokenizers/blob/v0.23.3/LICENSE) |
| ONNX Runtime | [onnxruntime 1.31.0，PyPI](https://pypi.org/project/onnxruntime/1.31.0/)，[上游源码](https://github.com/microsoft/onnxruntime/tree/v1.31.0) | [该版本 MIT 原文](https://github.com/microsoft/onnxruntime/blob/v1.31.0/LICENSE)及[第三方声明](https://github.com/microsoft/onnxruntime/blob/v1.31.0/ThirdPartyNotices.txt) |
| FastEmbed（BGE 使用） | [fastembed 0.9.0，PyPI](https://pypi.org/project/fastembed/0.9.0/)，[上游源码](https://github.com/qdrant/fastembed/tree/v0.9.0) | [该版本 Apache-2.0 原文](https://github.com/qdrant/fastembed/blob/v0.9.0/LICENSE) |
| llama.cpp | [官方 b12110 发布包](https://github.com/ggml-org/llama.cpp/releases/tag/b12110)，Windows x64 CPU 或 CUDA 12.4 包 | [b12110 的 MIT 原文](https://github.com/ggml-org/llama.cpp/blob/b12110/LICENSE)；包内其他组件另看所附声明 |
| CUDA 配套运行库 | 同一 [b12110 发布页](https://github.com/ggml-org/llama.cpp/releases/tag/b12110)的 `cudart-llama-bin-win-cuda-12.4-x64.zip` | [NVIDIA CUDA 12.4 条款原文入口](https://docs.nvidia.com/cuda/archive/12.4.0/eula/index.html)；具体运行库以实际下载包内的许可／声明为准 |

本仓库 [MIT 许可](LICENSE)说明自研代码；第三方组件保留各自许可和声明。0.6B 转换仓库未单独声明许可，表中原模型的 Apache-2.0 声明不能用来推定转换制品的全部许可关系。`main/master` 只作为原声明追溯入口，不替代 catalog 的安装 revision。已有文件以其自身来源记录为准。

既有实跑使用的 0.6B `model_int8.onnx`、llama.cpp b12102 与自动配方的 `model_quantized.onnx`、b12110 不同；已有文件实跑不证明自动配方制品已通过运行验收。

## 云端费用

接口模型选「自定义 API」，填 OpenAI 兼容的地址（只接受 https）、模型名、维数和密钥；旧版的百炼预设仍能读取，但不再出现在下拉里。填写并明确选择后才使用。查询和全域索引选中的资料可能发给向量服务，包括获准原文、长期条目、想法日记及手选 Markdown；首次准备和后续增量均可能产生嵌入费用；它与作答、后台整理费用分别计算。保存配置不会请求 API，不提供自动付费试跑。

现行 portable 设置把密钥引用绑定到规范化后的 API 地址（含业务空间／网关路径）。同一服务留空可保留；换服务须填写新密钥、在专家设置选择新的环境变量，或明确勾选当前地址可以复用已有凭据。改地址后复用勾选会清除，保存失败仍保留原配置；取消待切换会保留当前配置。此绑定与本地模拟服务验证已完成，真实服务的认证、型号与返回格式仍需对应服务的实际联调，不能据保存成功认定其可用。

自定义 API 还可以把用过的地址、模型名和维数保存为「已保存的服务」，最多 20 个。选择后可直接保存模型而不重填 Key；编辑和删除在「检索模型」页完成，正在使用的服务只能改名、不能删除，密钥文件路径不会返回页面。

本地向量不产生向量 API 调用费用，仍会使用本机计算、内存和存储。页面记录服务商报告的云端用量，未知用量单列，最终金额以服务商账单为准。

## 自动化与恢复

在插件目录中，专用 CLI 与设置页共用同一安装器：

```powershell
node scripts/embedding-model.mjs plan --deployment '<部署文件完整路径>' --model 'Qwen/Qwen3-Embedding-0.6B'
node scripts/embedding-model.mjs prepare --deployment '<部署文件完整路径>' --model 'Qwen/Qwen3-Embedding-0.6B' --download
node scripts/embedding-model.mjs status --deployment '<部署文件完整路径>'
node scripts/embedding-model.mjs cancel-staged --deployment '<部署文件完整路径>'
node scripts/embedding-model.mjs restore --deployment '<部署文件完整路径>'
```

已有文件使用 `--reuse`，可用 `--python`、`--onnx`、`--tokenizer`、`--gguf`、`--server`、`--bge-dir`、`--cache` 指定路径。4B/8B 自动准备可用 `--acceleration cpu|cuda`。不要把 API Key 放到命令行。

可以让执行助手照此准备依赖、查看进度；无需让它修改正在运行的 DSH 或插件源码。宿主或插件程序的切换由维护者按空闲窗口和对应版本说明处理。

界面“恢复上次向量设置”和 CLI restore 都只切向量配置，保留新增聊天、事实、原话、来源控制及账本。恢复云端历史设置时按该历史项的地址校验或补绑定凭据，已绑定到其他地址的凭据会被拒绝。恢复需再次确认云端费用，CLI 使用 `--allow-cloud`。不要用旧数据库或旧记忆目录整体覆盖来回退程序。

界面上的「恢复上次向量设置」也走同一个确认：确认后重新加载会自动补齐该模型的已有索引，只编码这期间变化的部分。每张模型的状态行显示「使用中」「可立即切回」「可切回，需补 N 篇」「切换中」「未建索引」等。不再使用的模型可以点「清理此模型的索引」释放磁盘，下次切回需全量重建；正在使用、待切换或正在准备的模型不能清理。索引每次建好后，同一模型只保留最近 5 份快照，更早的自动清理；正在被检索使用的快照会保留到检索结束。

注意：模型文件所在目录或其他非运行参数变化会被视为新的索引，预估里会如实显示为全部需编码。

模型、下载和环境放在记忆根的缓存/runtime 目录，安装记录单独保存；不会放进 Vault 正文。失败文件与未完成下载保留，已有不符文件不自动覆盖。


### 冷启动等待

现行按需工具将文字、条目和向量分路执行，未完成通道单独报告。向量查询的默认等待按模型和设备选择，可用 `rawRecallQueryWaitMs` 显式覆盖；冷加载和全域索引准备有自己的进度，后台补建不作为本次回答的前置。冷启动端到端表现和前台、向量、后台整理共享资源时的长时表现仍待独立验收。
