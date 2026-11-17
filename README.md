# dsh-memory-starter

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）用的个人长期记忆插件，也是一个可复制、可修改的起点。非官方插件，MIT 许可。

安装从[安装说明](docs/install/setup.md)开始，升级从[升级说明](docs/install/upgrade.md)开始。整体原理见[记忆系统整体说明](docs/记忆系统整体说明.md)，一轮对话的细节见[运行流程](docs/记忆系统运行流程.md)，完整入口见[功能清单](docs/记忆系统功能清单.md)。

本仓库原名 `dsh-basic-memory-bridge`。0.4.0 起不再依赖 Basic Memory，因此项目改名为 `dsh-memory-starter`；为兼容已有安装、数据和配置，插件包名仍是 `@local/dsh-basic-memory-bridge`。

## 它做什么

- **按对话开启**：默认不读也不记。打开某个对话的记忆后，从下一新回合保存双方正文；也可以让新对话自动开启。
- **子对话默认隔离**：DSH 做任务开出的子对话默认看不到记忆工具，也不预取或附加回答规则；在「记忆 → 子对话也能用记忆」显式打开并重新加载后，子对话才能只读使用记忆，仍不会保存子对话的话或参与短期接续。
- **原话是唯一对话记录**：用户和助手的正文按提交原样进入本地原话库，保留角色、时间、回合和版本，不经过模型总结。
- **没有整理层**：0.7.0 不生成结构化条目、主题页、待确认清单或更正建议，也不监视 Vault 或后台迁移旧记忆。
- **全文、向量和重排**：原话全文是基础检索；向量按语义找候选；重排可选。向量不可用时，全文和近期原话仍可工作。
- **自动预取**：开启记忆且打开预取后，每轮先用用户原话搜索一次，默认最多附 3 条、1000 字。重排成功时采用“绝对下限 `0.02` + 本题最高分 `0.5` 倍”的双门槛。
- **回答规则**：每个开启记忆的回合都附带当前本地时间和 8 条中性事实规则，不依赖本轮是否找到材料。
- **短期接续**：新对话、换对话、连接或模型变化、上次回答未完成时，从其他对话带入一段最近原话。
- **助手原话降权**：同一回合同用户与助手都命中时，助手内容挂在用户结果下；自动预取不单独放助手原话。
- **人设笔记**：`dafeiyu_records` 维护想法、日记、图片印象和人物印象；想法、日记和手选 Markdown 可进入向量检索。
- **可撤回、可淡化**：删除原话会标记撤回；淡化只降低默认召回权重，不改正文。

## 安装

`v0.7.2` 支持 DSH `0.2.1-rc.5` 和 `0.2.2-rc.3`。DSH 0.2.2 需要 Node.js 24.9 以上；DSH 0.2.1 可用 Node.js 22.19 或 24。`v0.7.1` 及更早的标签只支持 0.2.1-rc.5，在 0.2.2 上无法启用，请用 `v0.7.2`。

1. 把插件装进 DSH 档案（固定到 `v0.7.2` 标签）：

   ```powershell
   dsh plugin --profile web add "github:XRH66/dsh-memory-starter#v0.7.2"
   ```

2. 重启 DSH，打开设置里的「记忆框架」。首次使用会按五步引导：选择只存在本机的记忆库位置，再选择哪些聊天打开记忆；新对话自动打开记忆默认不勾。
3. 按向导安排启用后，关闭 DSH 再重新打开；在命令行启动的，按 Ctrl+C 停止后重新运行同一条命令。记忆框架加载后，向导会自动进入检索模型一步。
4. 在向导里填写云端向量服务，或选择已安装的本地模型；暂时不配置可以选“先跳过”。保存模型后再重启一次 DSH，模型才生效并开始建索引。完成后设置页分为「记忆／检索模型／状态／维护」四页。
5. 向导勾选的聊天会直接打开记忆，其他聊天仍可在对话页单独打开。时区默认北京时间，可在「记忆」页修改。

没有向量模型时，全文检索和近期原话照常可用。

## 短期接续设置

在「记忆 → 短期接续」中可以设置 `handoffTokens`：

- 默认 4096 tokens；
- 预设 4K 和 8K；
- 自定义范围 1～16384 tokens；
- 按估算 tokens 计量，保留越多，模型输入消耗越多。

配置文件中的 `handoffMaxAgeHours` 控制只取最近多少小时内的原话：

- 默认 72；
- 整数范围 1～8760；
- 超出范围按默认值处理；
- 比窗口更早或没有时间的原话不进入接续；
- 没有单独的设置页入口。

这两个字段只控制短期接续。自动预取的条数和字符上限是另一组设置。

## 数据放在哪里

所有记忆正文和索引数据都在你选的记忆目录中，仓库和插件目录不保存记忆正文：

- `vault/`：人设、想法、日记、图片和手选 Markdown 等文件；
- `management/raw-recall/raw-recall.sqlite`：未覆盖自定义路径时的原话、原话版本和全文投影；
- `management/vectors/`：统一向量档案、队列和索引状态；
- `management/` 下的其他文件：对话授权、只读标记、接续状态和索引运行信息。

原话库是聊天记忆的权威记录。`vault/` 里的人设笔记是助手自己的主观记录，不是用户说过的话；不要把两者混在一起理解。

记忆在本地，不代表模型推理也在本地。开启记忆的对话会发给当前对话模型；使用云端向量或重排服务时，被编码或送给重排服务的内容也会离开本机。密钥单独保存，设置页不回显。

## 从 0.3～0.6 升级

0.7.0 不再直接搜索 Vault 中的旧聊天笔记，也没有旧版「维护 → 旧记忆迁移」的后台整理流程。旧笔记要用继承命令搬进原话库。

```powershell
$memoryPlugin = '<DSH 主目录>\profiles\<档案名>\node_modules\@local\dsh-basic-memory-bridge'
node (Join-Path $memoryPlugin 'scripts\inherit-memory.mjs') check --deployment <配置文件>
node (Join-Path $memoryPlugin 'scripts\inherit-memory.mjs') apply --deployment <配置文件>
node (Join-Path $memoryPlugin 'scripts\inherit-memory.mjs') list --deployment <配置文件>
node (Join-Path $memoryPlugin 'scripts\inherit-memory.mjs') undo --deployment <配置文件> --batch <批次号>
node (Join-Path $memoryPlugin 'scripts\inherit-memory.mjs') restore --deployment <配置文件> --batch <批次号>
```

也可以在仓库检出目录直接运行 `node scripts/inherit-memory.mjs ...`。

`<配置文件>` 通常是首次配置页生成的 `<DSH 主目录>/profiles/<档案名>/basic-memory-bridge/configuration.json`。

常用参数：

- `--vault <旧 Vault>`：从另一个旧 Vault 读取；不给时读取当前记忆库的 `vault/`。
- `--file <JSONL>`：改用标准继承文件，不能和 `--vault` 同时给出。
- `--include-derived`：只对 Vault 输入有效，连同对话整理出来的派生条目一起导入。
- `--out <JSONL>`：只用于 `check`，把可导入记录另存为标准格式。

默认行为：

- `check` 只读，列出各类笔记的导入、跳过和冲突数量；
- `apply` 先检查、备份原话库、再整批导入；
- 旧 Vault 原文件不改，重复运行不会重复导入；
- 0.3 旧笔记、0.4～0.6 手写或从 0.3 迁来的条目、主题页用户补充可以导入；
- 从对话整理出来的派生条目默认跳过，主题页固定内容、条目旧版存档和只在旧数据库里的整理结果不导入；
- 导入记录标成“旧笔记（整理摘要）”，排序权重为 `0.7`，不进短期接续；
- 全文检索可以马上找到；向量索引需要当前模型准备好后追平；
- `undo` 和 `restore` 只改导入批次的可见状态，不物理删除原话。

更完整的步骤和边界见[升级说明](docs/install/upgrade.md)。

## 删除、淡化和只读

- 「维护 → 删除原话」按 1～100 字关键词搜索，确认后把单条原话标为撤回；正文版本保留用于追溯。
- `soften_memory` 只降低一条已保存原话所在回合的默认召回权重，原文保留，强线索仍可能召回。
- 只读会话通过 `sessionMemory.setReadOnly(sessionId, true)` 接口设置；当前没有设置页开关。
- 导入的旧笔记可用 `inherit-memory.mjs undo` 按批次撤回，再用 `restore` 恢复。

## 可选：人设和状态面板

[dsh-global-settings](https://github.com/XRH66/dsh-global-settings) 提供全局人设、自我档案和对话记忆状态显示。不装它不影响记忆核心功能。

## 开发

```powershell
npm ci
npm test
npm run release:check
```

测试使用临时目录和虚构数据，不读真实记忆，也不调用付费模型。`npm run release:check` 会检查发布白名单，在隔离的临时 HOME、缓存和凭据环境中导出文件，再运行测试、隐私检查和链接检查。

`package.json` 的 `files` 描述 DSH 安装包内容；`release-files.json` 描述可复现的源码发行内容。两者范围不同是有意的。

主要代码：

| 位置 | 内容 |
| --- | --- |
| `lib/bundle-entry.js` | 插件入口：未配置时提供设置页，配置后启动记忆 |
| `lib/platform-host.js`、`lib/personal-runtime.js` | 记忆运行时和设置路由组装 |
| `lib/session-memory.js` | 按对话授权和只读接口 |
| `lib/message-recorder.js`、`lib/raw-rag/` | 原话保存、全文投影和向量来源 |
| `lib/memory-query.js` | 预取、检索、展开、近期原话和回答规则 |
| `lib/handoff.js` | 短期接续 |
| `lib/memory-documents.js` | 原话、人设笔记和手选资料的统一向量来源 |
| `scripts/inherit-memory.mjs` | 旧笔记继承命令 |
| `lib/client.js` | 设置页和对话页开关 |

全部参数以 [lib/config.js](lib/config.js) 为准。

## 版本

**0.7.2（2026-11-17）**

- 同时支持 DSH `0.2.1-rc.5` 和 `0.2.2-rc.3`（0.2.2 需要 Node.js 24.9 以上）；0.7.1 及更早在 0.2.2 上无法启用。
- DSH 做任务开出的子对话默认不接入记忆；设置页「记忆功能」新增「子对话也能用记忆」开关，打开后子对话只读使用记忆，仍不保存子对话的话。

**0.7.1（2026-11-16）**

- 新安装默认打开「原话检索」。0.7.0 新装时它是关着的，向导里配好的向量模型其实没有用来检索；从 0.7.0 升级的按[升级说明](docs/install/upgrade.md)打开它。
- 「原话检索」关着时，「检索模型」页不再显示“使用中”；向导提醒第 4 步保存的模型要再重启一次才生效。
- 没配向量模型时导入旧笔记不再整批失败；向导步骤条、待生效刷新等界面小修；重写向量模型说明。

**0.7.0（2026-11-16）**

- 去掉整理层、结构化条目、待确认清单、主题页维护、Vault 监视和后台旧记忆迁移。
- 检索改为原话全文、原话向量和可选重排；不再直接读 Vault 旧聊天笔记。
- 新用户默认云端向量档位 `custom-api`，本地模型改为可选。
- 旧笔记统一用 `scripts/inherit-memory.mjs` 导入原话库。
- 每个开启记忆的回合都携带回答规则。
- 增加助手原话降权与配对、当前状态偏向新记录、宿主卡顿不计检索时间、超时保留已有结果。
- 短期接续增加 72 小时默认时间上限，配置项为 `handoffMaxAgeHours`。
- 首次使用改为五步向导，可以选择记忆库位置；修复 0.6.0 首次配置后原话保存失败。

0.6.0 及以前的完整更新见 [CHANGELOG.md](CHANGELOG.md)。

## 许可

本项目代码采用 [MIT](LICENSE)。模型、Python 依赖、llama.cpp 等第三方组件保留各自许可，见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
