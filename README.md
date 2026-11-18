<h1 align="center">dsh-memory-starter</h1>
<h3 align="center">DeepSeek Harness 个人长期记忆插件</h3>
<p align="center">按对话开启，原话原样存在本机；之后用全文、向量和重排帮模型找回你说过的话。</p>
<p align="center"><strong>v0.7.2 · DSH 0.2.1-rc.5 / 0.2.2-rc.3 · Windows</strong></p>
<p align="center">
  <a href="docs/install/setup.md">安装</a> ·
  <a href="MODEL-SETUP.zh-CN.md#推荐硅基流动免费向量和重排">配置检索模型</a> ·
  <a href="docs/install/upgrade.md">升级</a> ·
  <a href="docs/记忆系统功能清单.md">功能清单</a> ·
  <a href="docs/记忆系统整体说明.md">工作原理</a> ·
  <a href="docs/install/privacy.md">隐私</a> ·
  <a href="CHANGELOG.md">更新日志</a>
</p>

dsh-memory-starter 是给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）用的记忆插件。打开某个对话的记忆后，你和助手说的话会按原样保存在本机；以后在任何开了记忆的对话里，模型都能查到这些原话，接得上以前聊过的事。非官方插件，MIT 许可。

## 可以做什么

- **按对话开启**：默认不读也不记，哪个对话打开记忆才保存；也可以让新对话自动打开。
- **原话原样保存**：用户和助手的正文按回合存进本地原话库，带角色和时间，不经过模型总结或改写。
- **找回以前说过的话**：全文检索开箱即用；配上向量和重排后，换个说法问也能找到。
- **回答前自动带上相关记忆**：每轮先查一次，最多附上 3 条相关原话；模型也可以自己再搜。
- **换对话接得上**：新开对话、换模型或上次回答中断时，自动带上最近聊过的内容。
- **能删能淡化**：在设置页删除某条原话，或让模型以后少提某件事。

## 为什么用它

- **记录不会被改写**：原话库是唯一的对话记录，向量和重排只负责找，不负责改。查到的就是你当时说的话。
- **数据在你自己的电脑上**：记忆库放在你选的目录里，仓库和插件目录不存任何记忆正文。
- **出问题时退回可用状态**：向量或重排服务出错、超时，会退回全文检索，不会让聊天卡住或把错误抛给你。
- **子对话默认不碰记忆**：DSH 做任务开出的子对话默认不能读记忆，需要时在设置页打开，也只能读、不会存。
- **两个 DSH 版本都能用**：同时支持 DSH 0.2.1-rc.5 和 0.2.2-rc.3。

## 快速开始

1. 把插件装进 DSH（DSH 0.2.2 需要 Node.js 24.9 以上）：

   ```powershell
   dsh plugin --profile web add "github:XRH66/dsh-memory-starter#v0.7.2"
   ```

2. 重启 DSH，打开设置里的「记忆框架」，按五步向导选记忆库位置和要打开记忆的对话。
3. 向导第 4 步配置检索模型，推荐用硅基流动的免费模型（见下一节）；暂时不配也可以「先跳过」，全文检索照常可用。
4. 再重启一次 DSH。在开了记忆的对话里说一句话，新开一个对话问起它，能答出来就成功了。

想单独建一套 DSH、安装人设插件，或接入已有的 DSH，看[安装说明](docs/install/setup.md)；从旧版本升级看[升级说明](docs/install/upgrade.md)。

## 推荐的检索模型

| 用途 | 模型 | 服务 |
| --- | --- | --- |
| 向量 | `BAAI/bge-m3`（1024 维） | [硅基流动](https://cloud.siliconflow.cn)，免费 |
| 重排 | `BAAI/bge-reranker-v2-m3` | 硅基流动，免费 |

截至 2026-11-17，这两个模型在硅基流动价格页都标为免费；带 `Pro/` 前缀的同名模型收费，不要选错。用了云端模型，被检索的原话会发到硅基流动；不想让内容离开本机，可以用本地模型或只用全文检索。逐步填法见[配置检索模型](MODEL-SETUP.zh-CN.md#推荐硅基流动免费向量和重排)。

## 文档

| 我想… | 看这里 |
| --- | --- |
| 从零安装，或接入已有的 DSH | [安装说明](docs/install/setup.md) |
| 配置向量、重排或本地模型 | [向量模型说明](MODEL-SETUP.zh-CN.md) |
| 从旧版本升级，或把 DSH 升到 0.2.2 | [升级说明](docs/install/upgrade.md) |
| 导入 0.3～0.6 的旧笔记 | [升级说明 · 旧笔记导入](docs/install/upgrade.md#升级到-07x从-0306) |
| 查某个功能在哪里设置 | [功能清单](docs/记忆系统功能清单.md) |
| 了解记忆怎么存、怎么找 | [整体说明](docs/记忆系统整体说明.md) · [运行流程](docs/记忆系统运行流程.md) |
| 知道哪些内容会离开本机 | [隐私与公开边界](docs/install/privacy.md) |
| 看验证过什么 | [验证记录](docs/install/validation.md) |
| 让 Codex 等 Agent 控制 DSH 工程会话 | [工程控制附录](docs/install/control.md) |

可选的 [dsh-global-settings](https://github.com/XRH66/dsh-global-settings) 提供全局人设、自我档案和记忆状态面板，不装也不影响记忆功能。

## 问题反馈

遇到问题可以[提交 Issue](https://github.com/XRH66/dsh-memory-starter/issues)，请写明 DSH 版本、插件版本、操作步骤和设置页上的提示。不要贴密钥、记忆原文或含个人信息的日志。

## 开发

```powershell
npm ci
npm test
npm run release:check
```

测试使用临时目录和虚构数据，不读真实记忆，也不调用付费模型。`release:check` 在隔离环境中导出发布文件，再跑测试、隐私检查和链接检查。

<details>
<summary>代码位置</summary>

| 位置 | 内容 |
| --- | --- |
| `lib/bundle-entry.js` | 插件入口：未配置时提供设置页，配置后启动记忆 |
| `lib/platform-host.js`、`lib/personal-runtime.js` | 记忆运行时和设置路由组装 |
| `lib/session-memory.js`、`lib/host-compat.js` | 按对话授权、子对话判断和只读接口 |
| `lib/message-recorder.js`、`lib/raw-rag/` | 原话保存、全文投影和向量来源 |
| `lib/memory-query.js` | 预取、检索、展开、近期原话和回答规则 |
| `lib/handoff.js` | 短期接续 |
| `lib/memory-documents.js` | 原话、人设笔记和手选资料的统一向量来源 |
| `lib/client.js` | 设置页和对话页开关 |
| `scripts/inherit-memory.mjs` | 旧笔记继承命令 |

全部参数以 [lib/config.js](lib/config.js) 为准。`package.json` 的 `files` 描述 DSH 安装包内容，`release-files.json` 描述源码发行内容，两者范围不同是有意的。

</details>

本仓库原名 `dsh-basic-memory-bridge`，0.4.0 起不再依赖 Basic Memory 后改名；为兼容已有安装和数据，插件包名仍是 `@local/dsh-basic-memory-bridge`。

## 许可

本项目代码采用 [MIT](LICENSE)。模型、Python 依赖、llama.cpp 等第三方组件保留各自许可，见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
