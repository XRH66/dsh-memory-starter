# 安装：DSH 记忆与人设

返回 [README](../../README.md)。以下步骤面向 Windows PowerShell，会建立一套**独立**的 DSH 部署（单独的 DSH 目录、单独的端口），不碰你已有的 DSH。

## 1. 准备 DSH 和本仓库

当前源码支持 DSH `0.2.1-rc.5` 和 `0.2.2-rc.3`。DSH 0.2.2 需要 Node.js 24.9 以上；DSH 0.2.1 可用 Node.js 22.19 或 24。公开标签 `v0.7.1` 只支持 0.2.1-rc.5；0.2.2-rc.3 的兼容修复尚未发布，验证 rc.3 时要使用当前源码或完整提交号，不要用 `v0.7.1`。另需 Git 和 npm。还没有 DSH 的话，按[官方项目](https://github.com/deepseek-ai/deepseek-harness)安装适配版本；下面默认安装仍在日常使用的 0.2.1，也可以改用 0.2.2：

```powershell
npm install --global @deepseek-ai/dsh@0.2.1-rc.5
# 或：npm install --global @deepseek-ai/dsh@0.2.2-rc.3
dsh --version
```

已经装了其他版本时，先确认兼容再决定是否替换。然后准备本仓库：

```powershell
git clone https://github.com/XRH66/dsh-memory-starter.git
Set-Location dsh-memory-starter
$starter = (Get-Location).Path
npm ci
npm run check
```

## 2. 生成独立部署

`$deploy` 必须是仓库外、还不存在的新目录，生成器不会覆盖已有目录：

```powershell
$deploy = Join-Path $env:LOCALAPPDATA 'dsh-memory-deployment'
node scripts/install/configure.mjs --out $deploy
if ($LASTEXITCODE -ne 0) { throw '生成配置失败' }
$paths = Get-Content (Join-Path $deploy 'paths.json') -Raw | ConvertFrom-Json
```

生成两个文件，只生成配置，不安装、不启动：

- `paths.json`：DSH 目录、建议的记忆目录、人设和自我档案的位置，以及要安装的插件清单。
- `dsh.patch.yml`：人设插件的配置（自我档案路径、记忆状态目录）。记忆插件不需要在这里配置，首次配置在页面上完成。

## 3. 安装插件

> **版本**：下面固定安装 `v0.7.1` 标签。要验证还没打标签的源码时，把 `$memoryRef` 换成完整提交号，并记录未提交的修改，不要把工作树当成公开发布版。

先让当前终端指向这套部署（只设置环境变量，不启动服务）：

```powershell
. (Join-Path $starter 'scripts/install/use-deployment.ps1') -Deployment $deploy
```

再安装固定版本的两个插件：

```powershell
$memoryRef = 'v0.7.1'                                        # dsh-memory-starter 0.7.1
$settingsCommit = 'f5778e8a7ddcf2be5ba83f895db587b384455a78' # dsh-global-settings 0.2.0
dsh plugin --profile web add "github:XRH66/dsh-memory-starter#$memoryRef"
dsh plugin --profile web add "github:XRH66/dsh-global-settings#$settingsCommit"
```

人设插件可以不装；不装时记忆照常工作，只是没有全局人设和状态面板。

## 4. 人设与自我档案（可选）

复制虚构的起始示例，之后改成自己的内容。已有文件时命令会停下，不会覆盖：

```powershell
if ((Test-Path -LiteralPath $paths.persona) -or (Test-Path -LiteralPath $paths.selfProfile)) { throw '已有人设或自我档案，请先查看，不要覆盖' }
New-Item -ItemType Directory -Force (Split-Path $paths.persona) | Out-Null
Copy-Item (Join-Path $starter 'examples/persona.md') $paths.persona
Copy-Item (Join-Path $starter 'examples/self-profile.md') $paths.selfProfile
```

## 5. 启动并完成首次配置

```powershell
& (Join-Path $starter 'scripts/install/use-deployment.ps1') -Deployment $deploy -Start
```

DSH 在本机 8931 端口启动，打开启动日志给出的登录地址。端口被占用时，先确认是不是自己的旧实例，不要停掉不认识的程序。

1. 在 DSH 里配置你自己的模型服务。
2. 打开设置里的「记忆框架」。首次使用会显示五步向导。第 1 步选记忆库位置：默认填 `paths.json` 里的 `memoryDirectory`，也可以直接改，或用「选择文件夹…」；位置有别的文件时，按提示在该位置新建子文件夹。
3. 第 2 步选择哪些聊天在启用后直接打开记忆，「以后新建的对话自动打开记忆」默认不勾。第 3 步安排启用后，关闭 DSH 再重新打开；在命令行启动的，按 Ctrl+C 停止后重新运行同一条命令。
4. 重启后向导会自动进入第 4 步。填写云端向量服务、模型名、维数和 API Key，并确认检索内容会发送到云端、产生费用；也可以选择已安装的本地模型，或暂时“先跳过”。例如使用硅基流动时，地址填 `https://api.siliconflow.cn/v1`，向量模型填 `BAAI/bge-m3`，维数填 `1024`，API Key 填你自己的密钥，不要写进仓库。保存后要再重启一次 DSH，模型才生效并自动开始建索引。按意思检索还需要「记忆」页的「原话检索」开着，新安装默认开着；从 `v0.7.0` 升级来的可能关着，「检索模型」页会提示，做法见[升级说明](upgrade.md)。
5. 第 5 步核对记忆库位置、已打开记忆的聊天、新对话默认设置和检索模型状态。完成后「记忆框架」回到「记忆／检索模型／状态／维护」四页。其他聊天仍可在对话页单独打开记忆；向量服务以后也能在「检索模型」页补配。

本地模型是单独的可选项，在「检索模型」页展开「本地模型（可选）」后选择。它需要下载模型文件、占用本机内存和显卡，但不依赖云端向量服务；已安装本地模型的旧配置升级后仍保持原模型。

「回答前预先带上相关记忆」默认开启，每轮最多附带 3 条、1000 字以内；可以在「记忆」页关闭。候选只是检索线索，模型仍可按需调用 `memory_search` 等工具。

## 短期接续

在「记忆 → 短期接续」中设置 `handoffTokens`：默认 4096 tokens，预设 4K 和 8K，自定义范围为 1～16384。它只控制接续材料的总预算，按估算 tokens 计量。

配置文件中的 `handoffMaxAgeHours` 控制只取最近多少小时内的原话：默认 72，整数范围为 1～8760；超出范围按默认值处理。比窗口更早或没有时间的原话不会进入接续。这个字段没有单独的设置页入口。

接续只从原话库选取，不读取模型整理摘要；导入的旧笔记默认也不进入接续。

## 数据目录

聊天原话、全文投影和运行状态位于记忆目录的 `management/` 下；完整原话库和向量文件不要手动修改。

`vault/` 保存人设笔记、想法、日记、图片和手选 Markdown。可以用 Obsidian 把它当作 Vault 打开，但当前检索不会自动扫描整个 Vault：只有 `dafeiyu/thoughts`、`dafeiyu/diary` 和「维护 → 手选检索资料」中明确选择的文件会进入向量检索。

0.3～0.6 的旧聊天笔记不会从 `vault/` 直接进入当前搜索，升级时从已安装的插件目录运行继承脚本：

```powershell
$memoryPlugin = '<DSH 主目录>\profiles\<档案名>\node_modules\@local\dsh-basic-memory-bridge'
node (Join-Path $memoryPlugin 'scripts\inherit-memory.mjs') check --deployment <配置文件>
```

确认后再用同一入口执行 `apply`。也可以回到仓库检出目录，直接运行 `node scripts/inherit-memory.mjs ...`。

## 新开终端时

```powershell
$starter = (Resolve-Path '<dsh-memory-starter 仓库目录>').Path
$deploy = Join-Path $env:LOCALAPPDATA 'dsh-memory-deployment'
. (Join-Path $starter 'scripts/install/use-deployment.ps1') -Deployment $deploy
```

把尖括号换成实际目录。点调用只设置当前终端的环境变量，不启动服务；加 `-Start` 才启动。

## 接入已有的 DSH

不想另起一套时，也可以直接在现用的 DSH 档案里执行第 3 步的 `dsh plugin add`（不要设置 `DSH_HOME`），重启后同样在「记忆框架」页面完成首次配置。记忆目录要用一个新目录。动现用实例前，先确认没有对话或后台任务在跑。

验证范围见 [验证记录](validation.md)。
