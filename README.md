# DSH 长期记忆与人设

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）加上本地长期记忆和固定人设。记忆按对话开启，原话由程序保存，模型需要时自己去查；后台把聊天整理成 Markdown 条目，可以用 Obsidian 直接查看和修改。

**不需要 Codex、OpenAI 账户或任何第三方 Agent 软件。** 只要有 DSH 和你自己能用的模型服务。本仓库既是记忆插件源码，也是从安装、升级到继续改代码的统一入口。

## 开始

首版面向 Windows PowerShell，需要 Git、Node.js 22.19+ 或 24+、npm。

### 1. 准备仓库

```powershell
git clone https://github.com/XRH66/dsh-memory-starter.git
Set-Location dsh-memory-starter
npm ci
npm run check
```

### 2. 生成独立部署

输出目录必须位于仓库外，并且尚不存在：

```powershell
$deploy = Join-Path $env:LOCALAPPDATA 'dsh-memory-deployment'
node scripts/install/configure.mjs --out $deploy
```

### 3. 安装并首次配置

按[安装说明](docs/install/setup.md)安装固定版本的人设插件和本仓库记忆插件，然后启动独立 DSH，在「记忆框架」页面选择新记忆目录、整理模型和第一个对话。

已经在用 0.4.0 或 0.3.0 的，看[升级说明](docs/install/upgrade.md)。

## 组成

| 组件 | 作用 | 是否必装 |
| --- | --- | --- |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | 聊天、模型调用和插件运行环境 | 必装 |
| 本仓库记忆插件 0.5.0 | 按对话开启、原话库、按需检索、后台整理、遗忘曲线、短期接续、可选向量检索、删除原话和旧记忆迁移 | 必装 |
| [dsh-global-settings](https://github.com/XRH66/dsh-global-settings) 0.2.0 | 全局人设、自我档案、当前对话的记忆状态显示 | 推荐 |
| [Obsidian](https://obsidian.md/) | 查看、编辑记忆 Vault | 可选 |

安装说明按固定提交引用记忆插件和人设插件。历史仓库 `codex-deepseek-starter` 已并入本仓库，只保留迁移说明。

## 能做什么

- **按对话开启：** 默认不读不记；打开某个对话的记忆后，从下一回合开始保存双方实际提交的正文。
- **按需检索：** 回答前不默认塞入大包记忆。模型需要旧依据时调用 `memory_search`，需要展开时调用 `memory_open`，查看近期原文时调用 `memory_recent`。
- **后台整理：** 把获准原话整理成事实、偏好、事件、目标、计划、关系等十二类条目，写入 Markdown Vault 和本地索引。
- **短期接续：** 切换对话、模型或连接时，按设置带入其他对话最近的获准原文；正常连续聊天沿用 DSH 自己的上下文。
- **可选向量：** 支持本地 Qwen3-Embedding／BGE 和 OpenAI 兼容接口；每个模型或接口服务一份索引档案，切回时只补差量。
- **维护入口：** 可删除原话、切换记忆库、把 0.3.0 旧笔记迁移成新条目；旧文件不被修改。

## 从这里开始改

| 想改什么 | 主要入口 |
| --- | --- |
| 安装、部署生成和升级流程 | `scripts/install/`、[安装说明](docs/install/setup.md)、[升级说明](docs/install/upgrade.md) |
| 原话存储、全文检索和向量材料 | `lib/raw-rag/` |
| 向量服务、档案和模型选择 | `lib/memory-vectors.js`、`lib/unified/`、[模型设置](MODEL-SETUP.zh-CN.md) |
| 检索工具、排序和展开 | `lib/memory-query.js`、`lib/memory-query-lanes.js`、`lib/entry-priority.js` |
| 后台整理与十二类条目 | `lib/memory-organizer.js`、`lib/memory-pipeline.js`、`lib/memory-entry.js` |
| 对话开关、接续和宿主接线 | `lib/session-memory.js`、`lib/handoff.js`、`lib/platform-host.js` |
| 设置页和状态页 | `lib/client.js`、`lib/settings-host.js` |
| 可选组件补丁 | `scripts/install/optional-patches.mjs`、[可选组件](docs/install/optional-components.md) |

代码入口是 `lib/bundle-entry.js`，全部参数以 `lib/config.js` 为准。修改后运行：

```powershell
node --test --test-timeout=60000 test/*.test.js
npm run links
npm run privacy  # 在按 release-files.json 导出的干净发行目录中运行
```

## 文档

- [安装说明](docs/install/setup.md)
- [升级说明](docs/install/upgrade.md)
- [模型设置](MODEL-SETUP.zh-CN.md)
- [隐私说明](docs/install/privacy.md)
- [验证与适配边界](docs/install/validation.md)
- [可选组件补丁](docs/install/optional-components.md)
- [工程控制附录](docs/install/control.md)
- [更新记录](CHANGELOG.md)
- [第三方来源与许可](NOTICE.md)

## 数据与隐私

记忆、原话库、索引、配置和密钥都在你选的本地目录里，不在仓库里。本地存储不代表推理离线：开启记忆的对话和后台整理会把相关内容发给你选的模型；选用接口向量模型时，被索引的内容也会发给向量服务。详见[隐私说明](docs/install/privacy.md)。

## 仓库说明

本仓库原名 `dsh-basic-memory-bridge`，0.4.0 起不再依赖 Basic Memory 并改名。为了让已安装的 DSH 继续识别它，包名仍是 `@local/dsh-basic-memory-bridge`，接口路径 `/api/basic-memory-*` 和笔记来源字段 `source_plugin` 也保留旧名。

MIT。当前版本 0.5.0，适配 DSH 0.2.1-rc.5。
