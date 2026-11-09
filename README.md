# dsh-basic-memory-bridge

**交付状态（0.3.0）。** 本版源码对应本机日常使用的 portable 主链。复现该链路的通用安装包尚未生成，对应配置的干净安装仍待验收。QQBridge 附加模块和完整 unified／Suzu 候选不随普通包发行。starter 的公开固定组合仍属旧版兼容部署。

本页说明模式、旧版安装和现行 portable 的设置入口。源码工作副本的 `docs/项目导航.md` 索引本机运行流程、项目状态和开发记录；这些资料只在源码工作副本查阅。源码中的 `release-files.json` 是发行白名单，普通 npm 包选取其中的运行文件与随包说明。

把官方 Basic Memory 接入 DeepSeek Harness 的个人长期记忆流程。非官方插件；MIT。

本仓库同时保留旧版自动召回和逐轮提炼，以及 portable 中的正向授权、程序存原文、按需查询、后台合批和结构化条目。想法与日记以 Markdown 保存。启用的入口决定实际行为。

旧版配套组合（DSH 记忆与人设，可选第三方 Agent 共享维护）见 [codex-deepseek-starter](https://github.com/XRH66/codex-deepseek-starter)。单独部署旧记忆桥见下方兼容接入。

## 运行模式

| 模式 | 用途 |
| --- | --- |
| `portable` | 日常个人记忆入口。使用私有 Basic Memory 连接和原文库。启用正向授权时，用户逐会话开启记忆，当前模型按需调用搜索和展开。 |
| `legacy` | 旧宿主与公开兼容用法。按配置启用原始 Basic Memory MCP、旧自动召回及旧捕获。下方 legacy 接入章节说明这条路径。 |
| `unified` | 独立 unified／Suzu 候选宿主，需单独准备。构建与配置说明在源码工作副本的 `UNIFIED-MEMORY.zh-CN.md`。 |

现行 portable 默认不读不记。在「记忆框架」选中会话并打开对话记忆，从后续新回合开始保存双方正文；需要时由对话模型调用工具搜索、展开。固定人设独立保留，自我档案按会话授权读取。向量选择、全域索引准备和切换见[随包模型说明](MODEL-SETUP.zh-CN.md)。

日常 portable 的加载身份可在「记忆框架」和 `/api/basic-memory-settings/sessions` 的 `runtime: "loaded"` 核对。私有 Basic Memory 连接由记忆框架管理。

## 旧版兼容安装前置

下方公开固定的 legacy 组合已验证 DSH 0.2.1-rc.2，使用 Basic Memory 0.24.1、Node.js 22.19+ 或 24+。本机现行 portable 使用 DSH 0.2.1-rc.5、Node.js 24.9+；DSH 0.2.2-alpha.2 的兼容另行验收。

[Basic Memory 官方仓库](https://github.com/basicmachines-co/basic-memory)、[官方安装说明](https://docs.basicmemory.com/local/local-install)：

```powershell
uv tool install basic-memory==0.24.1
```

[Obsidian 官方发布仓库](https://github.com/obsidianmd/obsidian-releases)：

```powershell
winget install --exact --id Obsidian.Obsidian --source winget
```

不打包这两个软件、虚拟环境、个人 Vault 或数据库。Obsidian客户端不适用本仓库 MIT 许可。

## Legacy 兼容接入（可选）

以下命令在选定的独立 Harness profile 安装旧版 `legacy` 组件。桥使用 starter 0.3.0 的固定提交，第三方会话设置使用 2026-10-25 的固定 dist。现行 portable 使用私有连接和自己的会话开关。

```powershell
dsh plugin --profile web add github:XRH66/dsh-basic-memory-bridge#8180905355e5d59d81c3e867681cf68165509435
dsh plugin --profile web add github:u9521/dsh-session-settings#237537bb11663fd02bb14e5b415c92ff1a4320cd
```

1. 在仓库外选择数据目录，创建其 `vault` 子目录。设置 `BASIC_MEMORY_CONFIG_DIR` 为同一数据目录下的 `basic-memory-state`，使项目登记与MCP使用相同配置。
2. 用官方CLI登记：`basic-memory project add personal <vault绝对路径> --local`。
3. 在 dsh-session-settings 导入 MCP JSON，server名称必须是 `basic_memory`：

```json
{
  "mcpServers": {
    "basic_memory": {
      "transport": "stdio",
      "command": "basic-memory",
      "args": ["mcp", "--project", "personal"],
      "env": { "BASIC_MEMORY_CONFIG_DIR": "<与登记时相同的绝对路径>" }
    }
  }
}
```

4. 按实际环境替换尖括号内容；若服务进程找不到命令，使用 `Get-Command basic-memory` 返回的实际程序路径。探测工具后，只在需要 legacy 个人记忆的聊天会话勾选此 MCP，确认模型可见 `mcp__basic_memory__search_notes`、`read_note`、`write_note` 等。工程派工工作区保持关闭；不要全局启用后再依赖各会话逐一关闭。
5. 给 `id: basic-memory-bridge` 的 Cordis配置设置 `project: personal`、`vaultPath: <同一个vault绝对路径>`。该插件不会替你挂载MCP，也不会自动修改会话开关。

Legacy 模式的所有启用会话共享 `personal` 库；portable 模式使用独立连接访问同一记忆根下的 `main` 项目。两种模式的管理状态及人工待审清单都位于 Vault 同级 `management/`，不进入记忆索引。

## 可选人设和状态面板

[dsh-global-settings](https://github.com/XRH66/dsh-global-settings)独立提供全局人设、自我档案与当前会话记忆状态显示。双方需要指向相同的自我档案及管理目录；没有它也能执行本插件的记忆流程。

## 参数与边界

本节为旧自动召回与逐轮整理的兼容参数。现行 portable 的会话入口见[运行模式](#运行模式)，向量设置见[随包模型说明](MODEL-SETUP.zh-CN.md)。

默认事实召回3条/1200字符，个人记录2条/1600字符，索引1页/600字符；统一记忆上下文上限2400字符，前台召回各有1.5秒预算。近期动态默认最近48小时、最多8条/500字符；近期对话独立按估算16384 tokens容量保留，容量估算不等于模型账单。后台整理默认最多8192输出 tokens、90秒超时，连续自动失败默认3次后暂停。遗忘默认30天半衰期、普通召回门槛0.1、权重底值0.01；降低检索权重，不自动物理删除。强化沿用既有模型整理调用、24小时冷却和持久操作标识；语义判断仍可能漏记或误记。

自我档案不参加日常遗忘。日记每天最多3条，想法和日记按条目独立计算权重，主观内容不当作用户事实。索引目前不自动合并、拆分、删除或重命名主题。

代码限制该插件所在agent调用永久删除工具，但这不是Basic Memory服务端的访问控制；其他客户端仍由其自身权限决定。当前不提供多人或群聊的隐私隔离。全部参数以 [lib/config.js](lib/config.js) 为准。


## 旧版原话检索（默认本地，默认关闭）

本节说明当前源码保留的兼容原话链，按完整轮次归档。该链及下方的旧原话 CLI 晚于上文的公开固定桥版本。现行 portable 按消息保存并通过按需工具检索，全域索引从记忆框架运行页管理。见[随包模型说明](MODEL-SETUP.zh-CN.md)。

在现有事实、近期对话和作答链路之外，使用同一个**按完整轮次保存原话**的检索入口。原话与文本索引保存在本地；向量模型默认本地，也可由用户明确选择云端 API：

- 只在成功完成、未被中断、非纯净模式且包含直接用户消息的回合归档；工具输出、记忆桥自己注入的内容和检索材料不作为用户原话写回。
- 一轮作为检索单位，保存说话人、时间、会话、原文和偏移；同一轮内按原句展示，改口尾句不会被固定句数截断。
- 原话提交时在同一 SQLite 事务内建立文本索引；中文短词和完整编号不依赖模型。回答前在当前主体、可见时间与来源控制内取得文本和当前模型的向量候选，每路最多 40 个；按来源版本合并的候选池最多 80 个，再按名次融合默认取最多 10 轮（`rawRecallTop` 可配置 1–12）。正式原话路径尚未接入模型重排，也没有重排开关；云端只有选中并授权后才调用。
- 短轮继续整轮展示；长轮超预算时选择相关原句和相邻条件，保留否定、例外、期限与原说话人，不生成摘要。无法容纳完整条件时跳过，不截断成另一种意思。
- 已有近期页中能追溯到同一原消息（同 ID、同角色）的原句只跳过对应句；不同来源的同文不会被字符串去重误删。已注入的事实如果没有原消息身份，不按字符串跨消息排除，可能和会话原话各出现一次。
- 原话库是管理目录下独立 SQLite，不改 Basic Memory 笔记；默认位置为 `management/raw-recall/raw-recall.sqlite`，可用 `rawRecallDbPath` 指定。
- 不随包提供模型。只用文本检索不要求嵌入模型；启用语义检索前把模型放到本机缓存或模型目录，进程设置 `HF_HUB_OFFLINE=1`，不会自动联网下载。模型缺失、故障或新档位尚无向量时，已提交的文本仍可查；已有文本命中时不等待全部向量补建，向量查询遵循设置的等待上限，到期使用现成文本证据；切换本地轻量模型时界面建议 3 秒，CPU 4B/8B 建议 10 秒，以覆盖冷启动，模型已就绪时会提前返回。

## 现行 portable 模型设置

### 部署 JSON 层级

`rawRecall` 不是部署 JSON 的根字段。它和模型路径一起放在 `memory` 对象里；根节点同时要有个人目录、明确的本地主体和本次授权的 DSH 会话：

```json
{
  "ownerDirectory": "<个人记忆目录绝对路径>",
  "ownerSubject": "owner:local",
  "socialRoot": "<群目录绝对路径>",
  "dshHome": "<DSH目录绝对路径>",
  "dshSessionIds": ["session-<your-session-id>"],
  "backend": {
    "command": "<basic-memory 可执行文件>",
    "embeddingCache": "<FastEmbed 缓存根目录>",
    "offline": true
  },
  "memory": {
    "autoRecall": true,
    "autoCapture": true,
    "recentContext": true,
    "rawRecall": true,
    "rawRecallModel": "Qwen/Qwen3-Embedding-0.6B",
    "rawRecallPython": "<已安装 onnxruntime 和 tokenizers 的 python 可执行文件>",
    "rawRecallOnnxModel": "<model_int8.onnx 的本地路径>",
    "rawRecallOnnxTokenizer": "<tokenizer.json 的本地路径>"
  }
}
```

直接构造 portable 宿主时，同一份内容放在 `personal.memory`，不是构造参数的根节点：`personal: { directory, sessionIds, ownerSubject, memory: { ... } }`。`dshSessionIds` 与 `ownerSubject` 必须来自这个部署实例；不依赖 QQ，也不是任意 legacy 配置。只绑定实际要授权原话检索的会话，未列出的会话不会拿到原话。

轻量档只替换 `memory` 中的模型字段：`rawRecallModel: "BAAI/bge-small-zh-v1.5"`，并填写 `rawRecallPython` 与 `rawRecallCacheDir`，不要保留 Qwen 的 ONNX 路径。均衡档使用上面的 Qwen 0.6B 字段。切换 `rawRecallModel` 后，向量按模型身份隔离，不会把旧模型向量当作新模型结果。模型文件、解释器、缓存目录和 SQLite 都不进发行包；是否把原话保存在本机，由启用者自己决定。

### 用户选择向量模型（Embedding）

完整用户说明随包提供：[向量模型安装与切换](MODEL-SETUP.zh-CN.md)。选项位于「记忆框架 → 检索模型」；已有文件放在高级设置，普通用户可直接查看资源建议并准备所选型号。准备、保存、取消和恢复均已实现；已有文件配置有指定范围的运行记录，自动下载／新建环境及云端实际调用尚未完成同等运行验收。首次使用还须在「维护 → 记忆功能」开启“本地原话检索”，保存功能开关与模型选择后重载；准备模型本身不会开启该功能。

设置页「记忆 / 检索模型 / 状态 / 维护」中的「检索模型」提供以下选择；这里只选择检索用的向量模型，不改变作答或事实整理模型。正式原话链路未实现模型重排。保存后下次重新加载生效，可取消待切换。查看或保存文本选择不会启动模型；安装和试跑由单独的模型准备按钮执行。

| 选项 | 运行方式 | 向量维度 | 需要配置 |
| --- | --- | ---: | --- |
| BGE-small-zh-v1.5 | 本地 FastEmbed / CPU | 512 | Python、已有缓存；非标准缓存可设 `rawRecallBgeModelDir` |
| Qwen3-Embedding-0.6B | 本地 ONNX INT8 / CPU | 1024 | Python、ONNX 文件、tokenizer.json |
| Qwen3-Embedding-4B | 本地 GGUF / llama.cpp | 2560 | GGUF、llama-server；CPU 或用户选用显卡 |
| Qwen3-Embedding-8B | 本地 GGUF / llama.cpp | 4096 | 同上，但需要对应的 8B 权重与更多资源 |
| qwen3.7-text-embedding | 用户选用云端 API | 2560 默认，可选其他支持维度 | API 地址、密钥及云端使用确认 |
| qwen3.7-text-embedding-flash | 用户选用云端 API | 1024 默认，可选其他支持维度 | 同上 |
| text-embedding-v4 | 用户选用云端 API | 1024 默认，可选其他支持维度 | 同上 |

本地 Qwen 原版规格见[官方型号表](https://huggingface.co/Qwen/Qwen3-Embedding-4B#qwen3-embedding-series-model-list)，云端选项及地域地址见[百炼 Embedding 接口](https://help.aliyun.com/zh/model-studio/embedding-interfaces-compatible-with-openai)。本地量化权重由使用者安装，模型名称不是质量保证；既有本地实跑仅覆盖文首所列场景，不构成七项预设的通用质量排名。

### Embedding、安装依赖与运行时的来源和许可

以下是 2026-11-06 的安装配方快照；来源、完整 revision、文件名、大小与 SHA-256 以 [`lib/raw-rag/install-catalog.js`](lib/raw-rag/install-catalog.js) 为权威。安装器从 Hugging Face／llama.cpp 官方发布地址获取所选制品，从 PyPI 安装固定版本的直接依赖；传递依赖未完整锁定。

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

本仓库根目录 [MIT 许可](LICENSE)说明本项目自研代码；第三方模型、转换文件、依赖和运行库保留各自许可及声明。表中分别链接模型卡声明和许可原文；0.6B 转换仓库未单独声明许可，不能据原模型声明推定转换制品的全部许可关系。原项目 `master/main` 入口只用于追溯声明，不是安装版本依据；下载配方仍按 catalog 的固定 revision。使用已有文件时，其来源、版本和许可由该制品自身记录确定。

既有运行记录使用的 0.6B `model_int8.onnx` 与 llama.cpp b12102，不等同于自动配方的 `model_quantized.onnx` 与 b12110。已有文件实跑不能作为这些自动下载制品已经运行验收的证明。

各预设共用 `prepare → planChunks → embed → status / dispose` 接口。Qwen 查询指令只由框架加入一次，BGE、Qwen 和服务商各按自己的编码约定处理。llama.cpp 和云端复用同一个 `/embeddings` 客户端，轻量 FastEmbed／ONNX 保留直接调用。向量片段按模型输入上限规划，云端预设采用保守的字节上界，实际费用以服务商记录为准。

4B / 8B 的 `memory` 配置使用：

```json
{
  "rawRecall": true,
  "rawRecallModel": "Qwen/Qwen3-Embedding-4B",
  "rawRecallGgufModel": "<对应模型的 GGUF 完整路径>",
  "rawRecallLlamaServer": "<llama-server 程序完整路径>",
  "rawRecallLlamaGpuLayers": 0,
  "rawRecallThreads": 4
}
```

选择 8B 时同时更换模型名和权重文件。设备默认 `auto`：4B 优先使用显卡，8B 配置 CUDA `llama-server` 时也优先使用显卡；不可用且满足回退条件时使用 CPU。本地向量模型加载后默认一直常驻（`rawRecallIdleMs: 0`），也可改为空闲释放，或通过 `rawRecallResidentHours` 按时段常驻；每回合开始会触发预热。现行按需工具分四路执行原文文字、结构化条目、旧条目和向量查询，向量通道最多取 10 条候选，结果带 `label` 和 `localTime`。全域索引在「状态」页选择「准备索引」，中断后按原任务「续建索引」。档位准备就绪才切换 active；资源下载、保存选择和索引切换分别核对。见[模型选择步骤](MODEL-SETUP.zh-CN.md#在哪里选择)。

本地身份包含资产内容摘要、引擎／依赖、编码约定与维度。未变资产的摘要缓存可复用，不同身份的向量分开保存。档位准备期间，文字和条目查询仍可使用；全域覆盖以运行页进度为准。

云端默认禁止。除模型名外还需 `rawRecallAllowCloud: true`；界面密钥单独保存在管理目录，配置只保存文件引用，响应不回显密钥，也可通过 `rawRecallApiKeyEnv` 指定环境变量。现行portable将凭据绑定到服务地址，换地址需新凭据或明确复用；保存不请求API，详见[模型设置](MODEL-SETUP.zh-CN.md)。API 地址使用完整的 compatible-mode/v1 基地址，支持百炼业务空间域名。选中云端后，新聊天及需要补建的已授权历史都会产生向量 API 用量；重排仍未启用。

云端调用记录模型、用途、请求 ID、耗时及服务商报告的 token，不保存输入正文或密钥；没有 usage 的失败记作未知，不能计为零费用。失败后暂停该实例的云端调用，检查配置并重新加载后再重试，不在每次聊天中循环重发同一批。界面显示已加载索引进度和已记录的云端用量；最终金额以服务商账单为准。

模型后端、设置暂存、密钥存取及恢复机制已实现。本地 0.6B 有原位链路记录，4B/8B 有 CPU 小库及已有文件配置保存记录；密钥／云端实际调用、空机器安装、完整切档生命周期与恢复异常路径不能据此视为通过。实施、部署和进一步验收按当时授权分别进行。

设置页新增的准备器与 `scripts/embedding-model.mjs` 共用一份固定版本配方、下载续接、文件校验和待切换保存逻辑。只按所选型号准备资源，不启动模型或请求向量 API；完整原话和旧身份索引保留。保存/重载前核对文件、依赖及已有安装记录，不完整时继续使用旧设置；最近五组向量设置可恢复。已保存选择与运行状态回执分别记录，回执失败不会谎报配置未保存。

现行向量档位由记忆框架统一管理。自动运行包以 Windows x64 CPU／CUDA 12.4 为主，其他系统可使用已有兼容程序。模型加载后默认常驻，也可设置空闲释放或按时段常驻；CPU 线程与检索等待上限见[模型设置](MODEL-SETUP.zh-CN.md#在哪里选择)。

## 兼容原话链的来源、CLI 与验证

### 原话与事实的来源联动

仍由原有后台整理及 `applyMemoryActions` 写入事实，不增加第二个事实整理模型。新事实的当前内容会记录可取得的来源身份与证据；原轮已成功归档并可核实时，还会绑定原轮版本及原文校验值。原话关闭、归档未完成／失败或其他未归档入口产生的新事实，也可能只有未完整追踪的来源，不能一律视为版本链齐全；原有 `sources` 审计记录继续保留，但旧值的来源不自动当作新值的支持。

完整重述可形成独立支持；局部补充保留旧内容所依赖的来源。已有整理调用通过可选 `support_mode` 区分两者，并用 `context_refs` 登记解决指代所必需的前情；已排除的前情不进入新的整理输入。旧任务缺字段时保留已有依赖，不另开一次模型判断。准备好的动作绑定原来源快照和前情身份，重启不重新猜编号。改口仍按原流程保存历史，历史依赖旧值的来源，不错误归到纠正它的新消息。

事实召回、索引读回及最终合并会核对当前来源。明确排除、隐藏或改写使必要来源失效时，停止自动注入对应派生内容；其他独立来源仍有效则可保留。原话检索关闭不会解除已经记录的来源排除。后台写入前也核对来源，过期任务不能继续按旧输入落笔。失效判断不批量删除或改写笔记。

人工编辑的当前正文独立保留；来源检查不拿旧元数据覆盖它，普通附注也不自动变成新的事实证据。旧笔记只使用已有的来源标识，缺少原轮版本的记录保持“旧来源未完整追踪”，不伪造历史版本。单独安装的 QQBridge 附加模块（不随普通包发行）在 QQ 私聊和明确授权的个人记忆跨范围读取时复用同一来源检查，未新增 QQ 原话归档链路。

事实与原话之间只有“同一消息、同一原轮版本、事实里实际展示的逐字原句”可以覆盖去重。改写摘要、人工正文和缺版本来源不会误删另一条原话。来源检查和去重均为本地计算，不新增模型请求；提示词字段会增加少量输入/输出内容，实际 token 与延迟尚未测量。来源联动已实现；既有自然聊天与回归记录覆盖其指定场景，不代表所有来源缺失、失效及人工编辑组合均已运行验收。

### 历史导入、全历史检索与原句管理

**以下 CLI 只操作旧原话链。** `raw-memory.mjs apply` 把已预览的旧 DSH 聊天导入兼容原句库；`raw-memory.mjs index` 补齐该库当前模型的缺失向量。现行 portable 的全域索引用记忆框架运行页「准备索引／续建索引」，旧 CLI 不会为现行链补录旧会话。见[全域索引步骤](MODEL-SETUP.zh-CN.md#在哪里选择)。

旧链导入不重新作答、不重跑事实整理，也不调用重排。向量由选中的模型生成；选用云端时，补建旧原话也会发送给该 API 并产生用量。仅在明确要操作旧原句库时，先核对部署文件和模型，再开启该库的 `rawRecall`。

```powershell
$deploymentFile = Read-Host '部署配置文件的完整路径'
$historyDir = Join-Path $env:LOCALAPPDATA 'dsh-memory-history'
$historyPlan = Join-Path $historyDir 'reviewed-plan.json'

# 先预览。只有确认纯净模式默认关闭时，才加 --normal-default。
node scripts/raw-memory.mjs preview --deployment $deploymentFile --normal-default --out $historyPlan

# 仅导入旧原句库。可先导入少量，同一计划可续导。
node scripts/raw-memory.mjs apply --plan $historyPlan --max-turns 100
node scripts/raw-memory.mjs apply --plan $historyPlan
node scripts/raw-memory.mjs status --deployment $deploymentFile

# 仅补齐旧原句库的向量。现行全域索引使用记忆框架运行页。
node scripts/raw-memory.mjs index --deployment $deploymentFile
```

预览只列来源、数量和跳过原因，不输出聊天正文。只处理部署授权的会话、直接用户消息和完成回合的最终助手正文；不导入工具结果、召回注入、继承副本、中断回合、记忆控制请求和明确的 SessionRelay 派工信封。已混用纯净模式、旧模式记录无法判定的会话整段跳过。未确认默认模式时，缺少模式记录的旧会话也跳过。`--exclude-session` 可重复传入，显式排除执行者或测试会话。

源会话、权限、主人主体或模式改变时会停止并要求重新预览；保留已经完成的本地检查点。Ctrl+C 可中断，随后使用同一计划续导。源文改变后重新预览，未变化的轮次复用原向量，仅重建改变的轮次。文件本身不会被导入器改写。当前读取器使用随依赖安装的 DSH 0.2.1-rc.5 格式目录，逐个解开追加压缩帧；超过文件或解压帧容量的来源会明确报告，不能把跳过视作导入成功。

旧链按主体、模型和可见时间分页搜索向量，并在同一原句库查询独立文本索引。只在内存保留有界候选，最终仍受原句 600 字符、总记忆 2,400 字符的默认预算约束；同来源已显示的原句继续去重。部分扫描记录 `partial` 和扫描量，文本/向量路径与向量故障状态分开报告；取消则丢弃本轮结果。首次打开旧库会事务回填文本索引，不改原话和旧向量；来源哈希过期的文本索引不会命中，并在重新打开时修复。

不启动模型查询原话，或按准确原消息 ID 与时间范围查询：

```powershell
node scripts/raw-memory.mjs query --deployment $deploymentFile --query '借阅卡 731' --text-only
node scripts/raw-memory.mjs query --deployment $deploymentFile --message 'original-message-id' --text-only
node scripts/raw-memory.mjs query --deployment $deploymentFile --query '纸鹤' --text-only --since '2026-11-01T00:00:00+08:00' --until '2026-11-06T00:00:00+08:00'
```

`--since/--until` 限定聊天记录的时间，不代替自然语言事件日期理解。文本索引按中文相邻字词、完整数字及标识符匹配；不会自动推断人物别名或同义词，换种说法的召回继续由向量负责。BM25 与向量分数按名次融合，不能当事实可信度。

管理原句可使用确切来源，不用再调用一个语言模型：

```powershell
# 会话 ID、原消息 ID 从授权来源记录中取；排除会联动依赖该来源的自动事实。
node scripts/raw-memory.mjs control --deployment $deploymentFile --message 'original-message-id' --weight 0.5
node scripts/raw-memory.mjs control --deployment $deploymentFile --session 'session-to-exclude' --exclude
node scripts/raw-memory.mjs control --deployment $deploymentFile --session 'session-to-exclude' --include
node scripts/raw-memory.mjs sync-softening --deployment $deploymentFile
```

降权保留原文，强线索仍可召回；排除的原句不会因重启、重导或切换模型而恢复。`--include` 解除该操作员排除，不撤销事实本身的关联降权。`soften_memory` 继续支持事实与个人记录，并支持 `rawMessageId`；能追溯到原消息的事实降权会同步到对应整轮原句，缺少来源则不猜测关联。首次访问和导入也会读取现有事实降权元数据。原句排除不删除事实笔记或原始聊天；当前实现会停止注入必要来源已失效的派生事实，人工正文和其他独立来源分别处理。批量导入和 CLI 管理修改前自动保留 SQLite 备份，位置在原句库旁的 `backups/`，不进入记忆索引。

### 结构验证与关闭

```powershell
npm run verify:raw-recall
```

这是**无模型**的结构回归，使用临时 SQLite 和确定性嵌入替身，验证整轮偏移、覆盖去重、正常关闭排空、丢向量恢复、主体隔离、无模型文本查询与长句关键条件，以及关闭／冷库时原有事实预算不被预扣。真实本地模型的历史两进程验收记录可从源码工作副本的 `docs/项目导航.md` 查阅。

回退时把 `rawRecall` 设为 `false` 并重载插件；已有原话库不会自动删除，便于先保留证据。确认不再需要后，再在插件停止时按自己的备份策略处理 `management/raw-recall/raw-recall.sqlite`。阶段A未验证多用户共享、云端模型、重排和更大规模语料，不应当作这些场景的现成能力。

## 开发与升级

```powershell
npm ci
npm test
npm run privacy
```

`npm run privacy` 会遍历整个目录，要求每个文件都在 `release-files.json` 内，所以要在只含发行文件的干净副本里运行，例如新克隆的仓库或按白名单导出的目录。源码工作副本里的本地资料、模型缓存和实验目录会导致检查失败。

测试使用虚构工具、临时 Vault 和模拟模型，不调用模型 API、不读取正式库。`npm ci` 安装全部测试依赖：`@deepseek-ai/cordis@4.0.5`、`@deepseek-ai/dsh-scope@0.2.1-rc.5`、`@deepseek-ai/dsh-session@0.2.1-rc.5`、`@deepseek-ai/dsh-session-format-catalog@0.2.1-rc.5`，以及已固定提交的 `@local/dsh-global-settings`。前三项用于原生 Session 事件时序与严格持久化回放回归，均通过包名导入，无需本机安装路径。跨仓库状态测试要求人设插件与本版本接口一致；整套发布时须同步其固定提交。

0.2.0 将过期记忆上下文清理移到原生 Session 已打开 step 的请求边界，保留原始事件历史，并验证严格回放。

0.3.0 发布 portable 个人记忆主链：逐会话正向授权、只保存双方正文的原文库、按变化补入近期原文（4K／8K／自定义至 16K，按本地时间标明）、`memory_search`／`memory_open`／`memory_recent` 按需查回、后台合批整理为十二类条目并支持审核，以及统一向量档位（本地或兼容 API）。整理器使用独立的默认 32768 tokens／10 分钟预算，不沿用旧版 `captureMaxTokens`／`captureTimeoutMs`；推理档位默认沿用模型，可用 `organizerReasoningEffort` 指定。结构化条目正文及全文索引写入本地 SQLite，正常结构化检索不经 Basic Memory，Markdown 仍是编辑面。本地向量模型加载后默认一直常驻，可改为空闲释放或按时段常驻，每回合开始预热。原话向量可带同会话的有限获准前文（最多 4 条、2000 字符）。索引交接、发送前来源复核、维护对账和 API 地址／凭据绑定的修复一并包含。普通包不再包含 QQBridge 附加模块。旧「回答前召回」开关已从 portable 设置移除，legacy 模式行为不变。

升级步骤见 [升级指南](https://github.com/XRH66/codex-deepseek-starter/blob/main/docs/upgrade.md)，旧记忆迁移见 [记忆迁移指南](https://github.com/XRH66/codex-deepseek-starter/blob/main/docs/memory-migration.md)。升级在会话空闲时更新选定 profile 的插件并重载；不要在补写队列未处理完时切换数据目录。配置、Vault 与管理目录在仓库外。rc5 portable 日常链路及后续 0.6B 本地运行已有指定场景的验收记录，但仍须以目标机器的插件版本、配置和召回结果为准。

## 本次发布与维护边界

本页说明当前源码功能，不代表这些改动已发布或用户的运行进程已经更新。升级先核对版本和路径、备份，再按[统一升级指南](https://github.com/XRH66/codex-deepseek-starter/blob/main/docs/upgrade.md)操作。每次涉及重启，先确认授权范围、会话与后台任务空闲并保存本地续接记录；用户已授权执行者重启时可通过正常服务操作执行，随后核验实际加载。旧库整理在基础设施验收后单独执行。
