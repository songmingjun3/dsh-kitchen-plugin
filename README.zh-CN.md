# dsh-dkitchen

[![Tests](https://github.com/songmingjun3/dsh-kitchen-plugin/actions/workflows/tests.yml/badge.svg)](https://github.com/songmingjun3/dsh-kitchen-plugin/actions/workflows/tests.yml)
[![Release](https://img.shields.io/github/v/release/songmingjun3/dsh-kitchen-plugin)](https://github.com/songmingjun3/dsh-kitchen-plugin/releases/latest)
[![License](https://img.shields.io/github/license/songmingjun3/dsh-kitchen-plugin)](LICENSE)

[English](README.md) | **简体中文**

一个 DeepSeek Harness 插件，把一个仓库变成一间厨房：岗位、票、长任务，以及任务结束时唤醒会话的那只铃。

装上这个 bundle 就等于装完了全部。工具通过 `ctx.tools` 注册在 harness 进程内部，所以没有包要安装，没有单独的 profile 要启动，没有 broker 要运行，也没有 MCP server 要拉起。不需要在旁边维持任何进程。

> **本项目基于 [917Dhj/dkitchen](https://github.com/917Dhj/dkitchen)。** 厨房本身——岗位划分、票的流转、后厨规矩，以及唤醒会话的那只铃——是 [917Dhj/dkitchen](https://github.com/917Dhj/dkitchen) 的设计，本插件是它到 DeepSeek Harness 插件运行时的移植。见[致谢](#致谢)。

## 安装

**从 Discover 安装。** 在 harness 中打开 **Plugins → Discover**，添加这个索引

```text
https://raw.githubusercontent.com/songmingjun3/dsh-kitchen-plugin/main/docs/market/index.json
```

然后安装 `dkitchen`。索引里钉死的是本仓库的一个确切 commit，所以你装到的就是某个 release 指明的那一份。

**从 release 安装。** 在 [Releases](https://github.com/songmingjun3/dsh-kitchen-plugin/releases) 下载某个 tag 的源码包，解压后把 **Plugins → install bundle** 指向这个目录。

两种方式最终都一样：harness 会把 `cordis.patch.yml` 组合进 profile 并加载 `index.js`。如果 harness 没有自动加载，重启一次。首次启动时，bundle 还会把初始化 skill 装进机器级的 skill 目录，所以每个项目里都能用 `/setup-dkitchen`。

如果 bundle 注册某个工具失败，它是**静默**的——进程照常运行，只是那个工具不见了。在 `cordis.patch.yml` 里把 `debug` 设为 `true`，就能让每次注册都输出到 stderr。

## 它给会话带来什么

| 分组 | 工具 |
| --- | --- |
| 会话 | `dkitchen_new_session`、`dkitchen_send`、`dkitchen_read`、`dkitchen_info`、`dkitchen_rename`、`dkitchen_list_sessions`、`dkitchen_board`、`dkitchen_session_status` |
| 长任务 | `dkitchen_launch`、`dkitchen_logs`、`dkitchen_stop`、`dkitchen_run_status` |
| 票 | `dkitchen_relay`、`dkitchen_merge`、`dkitchen_log`、`dkitchen_executor_status` |
| 监视 | `dkitchen_watch`、`dkitchen_watch_state` |
| 配置 | `dkitchen_config`、`dkitchen_check_refs`、`dkitchen_status` |

票相关的工具需要 `gh` CLI。没有安装时它们会直接说明，其余工具照常工作。

## 仓库如何配置自己的厨房

每次调用都从**会话所在仓库**解析 `.dkitchen.toml`，而不是从 harness 碰巧启动的那个目录——一个 harness 进程服务多个仓库。

```toml
repo = "owner/name"

[kitchen]
stations = ["orchestrator", "designer", "verifier", "executor"]

[harness]
default_provider = "trae"
default_model = "deepseek-v4.1-flash"

[models.executor]
model = "deepseek-v4.1-flash"

[approval]
allow = ["dkitchen_*"]
```

`dkitchen_status` 报告某个仓库解析出了什么，其中 `rootSource` 说明仓库是怎么确定的：`argument`、`session` 或 `process`。`process` 意味着仓库是猜出来的，而不是已知的。

## 两个刻意的行为

**`[approval]` 按规则作答，默认一律交回。** harness 本来就会用自己的面板询问用户，插件如果抢在前面作答，就把这个决定权拿掉了。在 `allow` 里列出的工具会被直接放行，这正是无人值守的厨房能跑它被配置去跑的事情的原因；其余的一律调用 `next()` 交回面板。没有 `[approval]` 段时，插件完全不改变任何权限行为。

**后台任务的结束以会话通知的形式送达。** 由 `ctx.jobs` 宣告，所以发起任务的会话不需要轮询。

## 这个 bundle 增加的页面

`client.js` 会在 **Plugins** 中本 bundle 的页面上加一段内容，报告 bundle 是否已安装、是否启用，以及仓库的配置文件在哪里。没有按钮，因为这里没有任何东西需要运行。

## 目录结构

| 路径 | 作用 |
| --- | --- |
| `index.js` | 挂载插件：注入的服务、按每次调用解析配置、注册工具 |
| `lib/` | 工具，以及工具背后的规则 |
| `kitchen/` | 初始化 skill 渲染进目标仓库的岗位规则 |
| `skills/setup-dkitchen/` | 初始化 skill，附一个只依赖 Node 的渲染器 |
| `scripts/market.mjs` | 生成并校验 `docs/market/index.json` |
| `docs/plugin.md` | 用户指南：安装、每个工具、每个 `.dkitchen.toml` 配置项 |
| `tests/` | 测试套件：`node --test "tests/*.test.mjs"` |

本仓库**就是**这个 bundle：`package.json`、`index.js`、`lib/` 都在根目录，这也是 market 索引里不写 `path` 的原因。

## 开发

```bash
node --test "tests/*.test.mjs"     # 测试套件，无需先安装任何依赖
node scripts/market.mjs index --check
```

在受限 shell 下的 Windows 上，`node --test` 无法为每个测试文件派生子进程；这种情况下改用 `node --test --experimental-test-isolation=none "tests/*.test.mjs"`。

发布流程：把 `package.json` 里的 `version` 改好，然后推一个与之匹配的 tag（例如 `v1.0.0`）。release workflow 会校验两者一致、跑测试、为该 tag 的 commit 重新生成 market 索引，并发布 GitHub release。

## 致谢

这个插件是移植，不是原创设计。它实现的这间厨房——职责固定的岗位、用 GitHub issue 当票来交接工作、每条留言开头固定的状态块、什么时候必须停下发问的规矩，以及长任务退出时唤醒会话的那只铃——都来自 **[917Dhj/dkitchen](https://github.com/917Dhj/dkitchen)**。本仓库**刻意**紧贴它的功能设计：术语、拒绝的条件、以及总编排执行动作的顺序，都力求与之一致。感谢 917Dhj/dkitchen 把这件事想清楚并写了下来。

不同的地方在运行时，不在厨房。那个项目在进程**外部**驱动 DeepSeek Harness 会话——一个命令行工具、一个 broker、一个 MCP server、一个独立的 profile。本项目把同一批工具通过 `ctx.tools` 注册在 harness **内部**，所以装上 bundle 就装完了。行为上力求保持一致；凡是移植时不得不做选择的地方，选择都记录在做出该选择的那次提交和对应的测试里。

再往前追溯，这个比喻和这套工作流的很多部分还有更早的来源：米其林后厨这个比喻来自 Lauren Tan（[Poteto](https://github.com/poteto)），用 GitHub issue 管票的做法最初改自 [Matt Pocock 的 skills](https://github.com/mattpocock/skills) 里的 issue tracker 配置。

## 许可证

[MIT](LICENSE)
