# 升级说明

返回 [README](../../README.md)。

## 升级到 0.7.0（从 0.3～0.6）

0.7.0 去掉了整理层，搜索不再直接读取 Vault 里的旧聊天笔记。旧笔记必须用 `scripts/inherit-memory.mjs` 搬进原话库，不导入就不会进入当前搜索。

1. 备份 DSH 档案配置和记忆目录。正在写入的 SQLite 应使用在线一致快照，或先停写再复制。
2. 换上 `v0.7.0` 标签（安装命令见[安装说明](setup.md)第 3 步），按本页末尾的「重启约定」重启 DSH。
3. 从已安装的插件目录检查旧笔记：

   ```powershell
   $memoryPlugin = '<DSH 主目录>\profiles\<档案名>\node_modules\@local\dsh-basic-memory-bridge'
   node (Join-Path $memoryPlugin 'scripts\inherit-memory.mjs') check --deployment <配置文件>
   ```

   `<配置文件>` 通常是首次配置页生成的 `<DSH 主目录>/profiles/<档案名>/basic-memory-bridge/configuration.json`。

4. 看清检查结果后导入：

   ```powershell
   node (Join-Path $memoryPlugin 'scripts\inherit-memory.mjs') apply --deployment <配置文件>
   ```

5. 打开向量检索时，确认新内容进入当前模型档案。全文检索和 `memory_open` 不依赖向量；向量索引需要在「状态」页准备或继续追平。
6. 新建一个测试对话，发送一条可检索的虚构消息，确认保存、全文搜索、展开和接续都按预期工作。

### 输入和参数

默认读取部署配置对应的当前记忆库 Vault。旧 Vault 在别处时：

```powershell
node (Join-Path $memoryPlugin 'scripts\inherit-memory.mjs') check --deployment <配置文件> --vault <旧 Vault>
node (Join-Path $memoryPlugin 'scripts\inherit-memory.mjs') apply --deployment <配置文件> --vault <旧 Vault>
```

也可以从标准 JSONL 导入，或让 `check` 写出标准 JSONL：

```powershell
node (Join-Path $memoryPlugin 'scripts\inherit-memory.mjs') check --deployment <配置文件> --file <导入文件.jsonl>
node (Join-Path $memoryPlugin 'scripts\inherit-memory.mjs') check --deployment <配置文件> --vault <旧 Vault> --out <检查结果.jsonl>
```

`--vault` 和 `--file` 不能同时给出。`--include-derived` 只适用于 Vault 输入。
也可以在仓库检出目录直接运行 `node scripts/inherit-memory.mjs ...`。

### 会导入、跳过和不导入什么

会导入：

- 0.3 的 `chats/facts`、`chats/events`、`chats/history`、`chats/review` 中可识别的旧笔记；
- 0.4～0.6 中用户手写的条目，以及从 0.3 笔记迁来的条目；
- 主题页下方由用户补充的文字。

默认跳过：

- 由对话整理出来的派生条目。它们的依据通常已经在原话库里，再导一份摘要容易重复或带入推断；
- 如果确实需要，`check` 和 `apply` 都加 `--include-derived`。

不会导入：

- 主题页的固定内容；
- 条目修改前的旧版本存档；
- 只在旧数据库里的待确认整理结果；
- 无法解析文件头、版本或正文标记的笔记。

一篇 0.3 笔记已经迁成新条目时，只导入新条目。

### 写入后果

- `check` 只读；只有加 `--out` 时才写指定的 JSONL。
- `apply` 先备份原话库，再整批导入；不修改旧 Vault 文件。
- 重复运行不会重复导入相同内容。
- 导入记录标成“旧笔记（整理摘要）”，排序权重为 `0.7`，不进入短期接续。
- 全文检索和 `memory_open` 可以马上复核；向量编码在模型和档案准备好后追平。
- 没有开启向量检索也能导入；以后开启时会进入新档案的准备流程。

### 查看、撤回和恢复批次

```powershell
node (Join-Path $memoryPlugin 'scripts\inherit-memory.mjs') list --deployment <配置文件>
node (Join-Path $memoryPlugin 'scripts\inherit-memory.mjs') undo --deployment <配置文件> --batch <批次号>
node (Join-Path $memoryPlugin 'scripts\inherit-memory.mjs') restore --deployment <配置文件> --batch <批次号>
```

`undo` 用原话控制记录排除整批导入内容，`restore` 再用同一机制恢复。原话版本和批次记录不会被物理删除。

## 从 0.5.0 或 0.6.0 升级

升级到 0.7.0 时，原话库和向量档案可以先保留，但旧结构化条目不再作为当前检索来源。旧配置里的整理字段读取时忽略；旧库里的条目表和条目向量留着不读。

0.5.0～0.6.0 的「维护 → 旧记忆迁移」和“待确认”流程只属于旧版本。升级后用本文开头的 `check`／`apply` 命令，不要继续在旧界面上等待后台整理完成。

向量索引不要求整体重建：当前模型档案仍可使用，旧条目相关文档会在查询时过滤。若准备索引时发现历史遗留文档，按状态页提示处理。

## 从 0.4.0 升级

0.4.0 的 Basic Memory 依赖已经不存在，当前版本不再启动 MCP 客户端，也不需要 Basic Memory 进程。旧版本自己写在本机 Markdown 或 SQLite 中的数据不会自动删除；原话数据按当前配置继续使用，旧笔记按本文开头的继承命令评估导入。

旧配置里的整理模型、条目类型和遗忘曲线不再读取。当前遗忘只在原话排序时按统一默认值计算，不再按条目类型区分。

## 从 0.3.0 升级

0.3.0 的组合是 Basic Memory、旧记忆桥和其他可选插件。升级前：

1. 记录当前 DSH 档案、记忆库、Vault 和已装插件；
2. 备份配置和旧数据；
3. 换上新插件，先完成新记忆库或当前库的配置；
4. 用 `inherit-memory.mjs check` 确认可导入内容，再 `apply`；
5. 打开向量检索时，确认新向量档案准备完成。

旧 Vault 原文件不会被继承命令改写。新插件不会把整个 Vault 自动加入检索；当前只读 `dafeiyu/thoughts`、`dafeiyu/diary` 和用户明确选择的 Markdown。

## 从 codex-deepseek-starter 迁移

原来的 `codex-deepseek-starter` 已并入本仓库。已经安装好的 DSH 不需要为了换仓库地址重装记忆数据；继续使用现有部署目录和记忆库，只更新插件来源、安装说明和后续版本。

不要为了迁移仓库地址删除或覆盖现有记忆库。新仓库的生成器仍要求独立的新部署目录，不覆盖已有 DSH 配置。

## 重启约定

需要重启时，执行者先说明影响的对话和后台任务，把当前步骤、已改文件、备份位置和下一步写到仓库外的续接记录，再由用户手动重启。不要自动强杀进程、批量停止不认识的程序或触发电源操作。

重启后先确认实际加载的插件版本、配置文件和记忆目录，再继续导入或测试。

## 出问题时

停在出错步骤并保留错误信息。回退时换回旧插件和对应配置备份；旧版不会识别 0.7.0 新增的原话撤回、批次和向量状态，因此不要用旧备份整体覆盖新产生的数据。先单独导出或复制新数据，再决定是否恢复整个记忆库。
