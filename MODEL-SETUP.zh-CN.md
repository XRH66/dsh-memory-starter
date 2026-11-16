# 向量模型安装与切换

本页说明向量服务和本地向量模型怎么选、怎么生效、索引怎么建。0.7.0 起新安装默认用云端向量服务，本地模型是可选项。本机实跑覆盖 4B CUDA、0.6B CPU 和 OpenAI 兼容接口（硅基流动 `BAAI/bge-m3`）。

## 在哪里设置

打开 **记忆框架设置 → 检索模型**，分「向量」和「重排」两栏。首次使用时，向导第 4 步「配置检索模型」就是这里的向量部分，可以先跳过。没配好向量时，全文检索、最近原话和打开原话照常工作。

按意思检索还要「记忆」页的「原话检索」（配置项 `rawRecall`）开着。新安装默认开着；从旧版本升级或手动关掉的，「检索模型」页会提示先打开，打开后重启 DSH 生效。对话记忆另由每个会话的开关授权。

**云端服务（默认）**

1. 在「服务」里新建一项，填 API 地址（只接受 https，填到 `/v1` 为止，例如 `https://api.siliconflow.cn/v1`）、模型名称（例如 `BAAI/bge-m3`）、向量维数和 API Key。保存过的服务留在列表里，可以测试、编辑和删除；正在使用的服务只能改名。密钥只存在本机。
2. 勾选「我知道检索内容会发送到云端，并会产生费用」，点「保存」。
3. 重启 DSH 后切换到新模型，并自动开始建索引，进度在「状态」页。建好之前按意思检索暂不可用，全文检索照常。

**本地模型（可选）**

展开「本地模型（可选）」，选 Qwen3-Embedding 0.6B、4B 或 8B；4B／8B 可选 CPU 或 NVIDIA CUDA 12.4 运行包，BGE 的兼容资源仍在列表里。页面显示下载量、来源和设备资源建议，显存按需读取。点「下载」只保存文件、不切换模型；下载可取消，完成后选中并「保存」才启用，同样在重启 DSH 后生效。

已有模型文件可在「高级设置：已有文件与资源」里指定。手动改路径会解除原安装记录；缺文件或依赖时会提示，不会用新设置覆盖当前选择。高级设置里还有运行设备、CPU 线程和模型常驻方式（一直加载、空闲一段时间后释放、按时段常驻）。

**索引和状态**

- 「状态」页显示当前模型、索引进度和等待重启的切换。没有索引时点「准备索引」；中断后可「续建索引」，已完成的文档不重复编码。云端模型按量计费。
- 「测试连接」（云端，会产生少量费用）或「试算」（本地）用当前模型算一句话。
- 云端检索失败后会暂停，避免重复计费；测试通过后在「状态」页点「恢复使用」。
- 准备索引期间可能释放旧模型，全文检索继续可用。聊天中恰好有检索在途时，准备会提示等这次对话结束后再点。

**重排（可选）**：「重排」栏默认关闭。开启后，检索先找出一批候选（5～50 条），再交给重排模型按相关度重新排序；失败或超时沿用原来的顺序。可以用「向量」里保存过的服务，也可以单独填写地址和 Key，保存后重启 DSH 生效。

仓库内的 `scripts/raw-memory.mjs` 只是维护旧原话库的工具，不在发布包提供，也不是普通用户操作。

## 模型和资源

| 型号 | 默认本地文件 | 模型下载量 |
| --- | --- | --- |
| BGE-small-zh-v1.5 | Qdrant BGE ONNX | 约 95 MB |
| Qwen3-Embedding-0.6B | ONNX Community INT8 + tokenizer | 约 625 MB |
| Qwen3-Embedding-4B | Qwen 官方 Q4_K_M GGUF | 约 2.50 GB |
| Qwen3-Embedding-8B | Qwen 官方 Q4_K_M GGUF | 约 4.68 GB |

程序和 Python 依赖另计。新建 Python 环境的自动配方使用 3.12；满足依赖的已有环境可复用。准备器不修改系统 Python。自动 llama.cpp 包当前面向 Windows x64；其他系统或加速方式可在高级设置指定已有兼容程序。

资源建议依据可用内存、CPU 和按需读取的 NVIDIA 可用显存，属于保守预算，没有替用户跑性能测试。GPU 总容量不等于当前空闲显存。模型缺失、超时或资源不足时保留文本检索，不自动转云端。

原话（含导入的旧笔记）、人设的想法和日记、手选资料共用一个当前向量档案；把支持的 BGE 档设为当前档案时，这些内容都用它。每个模型有独立的默认相似度下限；BGE 查询按模型约定加入检索指令，检索等待按模型和设备选择，遗忘权重在最终合并排序时计算。原话正文和全文检索读本地 SQLite，人设笔记由插件直接读写 Vault。

**档案。** 每个向量模型各有一个索引档案：本地 0.6B、4B、8B 各一份；云端按接口地址和模型名区分。切走后档案和索引原样保留；切回同一档案时沿用原索引，只补切走期间新增、修改或删除的内容。换模型文件目录、运行程序路径或密钥不会重建；换量化文件或接口模型名会形成另一个档案。

**新增模型。** 结构化配置限于现有后端支持的资源、编码格式、pooling、归一化和切片约定。Agent 自动适配仍是源码中的候选研究。

## 安装来源、固定版本与许可

来源、完整 revision、文件名、大小与 SHA-256 以随包 [安装 catalog](lib/raw-rag/local/install-catalog.js) 为权威；下表是 2026-11-06 快照。Python 的固定版本仅覆盖直接依赖，传递依赖未完整锁定。

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

接口模型选「自定义 API」，填 OpenAI 兼容的地址（只接受 https）、模型名、维数和密钥；旧版的百炼预设仍能读取，但不再出现在下拉里。填写并勾选费用确认后才使用。建索引和查询时，开了记忆的对话原话、导入的旧笔记、人设的想法日记和手选 Markdown 可能发给向量服务；首次建索引和以后的增量都可能产生嵌入费用，与作答费用分开计算。保存配置不会请求 API，不提供自动付费试跑。

密钥按服务保存，并绑定到规范化后的 API 地址（含业务空间／网关路径）。编辑服务时密钥留空就沿用原密钥；改了地址要填写这个地址对应的密钥，或在「云端参数」里改用环境变量。保存失败时保留原配置；取消待切换会保留当前配置。保存成功不等于服务可用，真实服务的认证、型号与返回格式以实际调用为准，可以先点「测试」。

维数要和模型实际输出一致（如 `BAAI/bge-m3` 为 1024）；留空按 1024 处理。默认不把维数发给服务商；只有模型支持指定输出维数（如 Qwen3-Embedding、text-embedding-3）时，才勾选「向服务商请求这个维数」，服务商会按填写的维数返回。改了维数等于换了一个索引档案，原档案保留。

保存过的服务最多 20 个。选择后可直接保存模型而不重填 Key；编辑和删除在「检索模型」页完成，密钥文件路径不会返回页面。

本地向量不产生向量 API 调用费用，仍会使用本机计算、内存和存储。页面记录服务商报告的云端用量，未知用量单列，最终金额以服务商账单为准。

## 索引档案与回退

「检索模型」页下方的「索引档案」表列出建过索引的模型档案：显示名、维数、文档数、最后更新、估算占用和状态（使用中、已选待切换、可切回、未建索引）。「切换到此档案」沿用原索引，只补切走期间变化的部分；没建过索引的显示「切换并从头建索引」。云端档案对应的服务要先在上面重新添加。

不再使用的模型可以点「清理此模型的索引」释放磁盘，下次切回需全量重建；正在使用、待切换或正在准备的模型不能清理。索引每次建好后，同一模型只保留最近 5 份快照，更早的自动清理；正在被检索使用的快照会保留到检索结束。

模型、下载和环境放在记忆根的缓存／runtime 目录，安装记录单独保存，不会放进 Vault 正文。失败文件与未完成下载保留，已有不符文件不自动覆盖。

## 命令行

在插件目录中，专用命令与设置页共用同一安装器：

```powershell
node scripts/embedding-model.mjs plan --deployment '<部署文件完整路径>' --model 'Qwen/Qwen3-Embedding-0.6B'
node scripts/embedding-model.mjs prepare --deployment '<部署文件完整路径>' --model 'Qwen/Qwen3-Embedding-0.6B' --download
node scripts/embedding-model.mjs status --deployment '<部署文件完整路径>'
node scripts/embedding-model.mjs cancel-staged --deployment '<部署文件完整路径>'
node scripts/embedding-model.mjs restore --deployment '<部署文件完整路径>'
```

已有文件使用 `--reuse`，可用 `--python`、`--onnx`、`--tokenizer`、`--gguf`、`--server`、`--bge-dir`、`--cache` 指定路径。4B/8B 自动准备可用 `--acceleration cpu|cuda`。不要把 API Key 放到命令行。

`restore` 默认切回最近一次换下来的向量设置（也可用 `--id` 指定历史项），下次重新加载后生效；原话、导入记录、来源控制和用量账本都不动。恢复云端设置时按那次设置的地址核对凭据，已绑定到其他地址的凭据会被拒绝；恢复云端设置要加 `--allow-cloud`。不要用旧数据库或旧记忆目录整体覆盖来回退程序。

可以让执行助手照此准备依赖、查看进度；无需让它修改正在运行的 DSH 或插件源码。宿主或插件程序的切换由维护者按空闲窗口和对应版本说明处理。

### 检索等待

按需工具把全文和向量分路执行，没完成的通道单独报告。向量查询的默认等待按模型和设备选择，可在「云端参数」或高级设置里用 `rawRecallQueryWaitMs` 显式覆盖；冷加载和建索引有自己的进度，后台补建不作为本次回答的前置。DSH 主线程被别的插件卡住的时间不算进检索时限。
