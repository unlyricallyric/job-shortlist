# 本机定时采样

这是 macOS 用户级服务，不依赖聊天会话、Copilot CLI、MCP、付费模型或 API Key。北京时间每天 **09:30、12:30**，在普通 Chrome 的已登录 BOSS直聘会话中进行有界公开职位采样、确定性规则初筛，并将经过验证的累计快照发布至 GitHub Pages。

## 运行边界

- 使用中文职责关键词轮换查询上海职位；每轮最多 3 个查询、每个查询 15 张卡片、8 个完整 JD、3 条新增公开记录，整轮不超过 30 分钟。不设置工作经验 URL 参数或薪资门槛。
- 只通过 Chrome 已授权的 Apple Events JavaScript 读取公开搜索卡片和匹配的职位详情。不会读取 Cookie、简历、消息或账号面板，也不会沟通、收藏、投递或修改账户。不会绕过验证码或启用自动化伪装。
- 验证码、登录失效、详情与岗位 ID/标题不一致、网络或页面结构异常均显式失败，不当作“没有岗位”。自动时段失败后不在每分钟重复重试；下一时段才再次尝试。
- 职责与任职要求一起决定规则初筛。未能确认的硬性要求进入本机私有复核记录。新规则初筛不代表满足全部资格；既有人工辅助评估不会被自动覆盖。原 JD 只保存在私有运行目录，公开摘要使用通用改写，不公开个人匹配配置。
- 无法读取薪资字形时保留 `null`，不解码猜测、不推算年薪。旧岗位已确认薪资保持原值，缺席一次采样不删除；仅真正再观察到时才更新 `lastSeen`。
- 本机只自动采样 BOSS直聘。已收录的官网、猎聘岗位及其原观察日期可以保留，不表示其他来源本轮也重新采集。

## 前提

Mac 必须有已登录的图形用户会话、网络、普通 Chrome 的有效登录及用户主动授予的 Apple Events 权限。Chrome 的“允许来自 Apple 事件的 JavaScript”需要由用户开启；本程序不会更改浏览器设置或代为处理验证码。

服务附带可撤销的 **仅接通电源时** `caffeinate -s` 辅助，在启用期间避免 AC 空闲系统睡眠；执行中的单轮使用有界 `caffeinate -i`。不会强制亮屏、改变全局电源设置，不能保证合盖、手动睡眠、关机或退出登录后仍按时运行。电池供电且空闲睡眠时可能延迟，唤醒后只补最近一个未尝试时段，不循环追赶所有旧时段。

## 私有配置与认证

默认运行目录为 `~/Library/Application Support/job-shortlist`。目录权限 `0700`，配置、状态、证据文件为 `0600`，不得加入 Git。`matching.json` 使用 `screening.mjs` 定义的私有能力确认结构；`ledger.json` 记录来源限定的已读卡片及完整 JD 唯一 ID，提供可靠的累计基线。

发布使用单仓库读写 deploy key，以及通过 GitHub 官方 HTTPS 元数据/文档核对的 SSH 主机公钥。密钥与 `known_hosts` 放在运行目录的 `keys/` 下。守护进程使用 `IdentitiesOnly`、禁用 SSH agent、严格主机核对，不依赖注入的 GitHub token、全局 SSH 配置或 `gh auth`。私钥不得上传到仓库、写入 plist 或前端。

## 安装

先准备已确认的私有匹配配置、唯一 ID 基线及仓库 deploy key；以下仅为参数示例，不会自动创建或上传密钥。Node 路径应使用稳定的绝对路径，例如 Homebrew 的 `bin/node` 链接，而不是临时应用缓存。

```sh
node scheduler/cli.mjs install \
  --repository OWNER/REPO \
  --matching /PRIVATE/matching.json \
  --ledger /PRIVATE/ledger.json \
  --ssh-key "$HOME/Library/Application Support/job-shortlist/keys/github-deploy-ed25519" \
  --known-hosts "$HOME/Library/Application Support/job-shortlist/keys/known_hosts" \
  --node "$(command -v node)"
```

安装会复制程序到运行目录的 `app/`，创建独立的 `publish/` 克隆和两个任务专用 LaunchAgent：

| 服务 | 作用 |
| --- | --- |
| `com.job-shortlist.scheduler` | RunAtLoad、每 60 秒检查上海墙上时间和持久化时段记录 |
| `com.job-shortlist.keep-awake` | 仅启用期间的 AC 防空闲系统睡眠辅助 |

初次安装是暂停状态。可以用 `--adopt-window <ID> --adopt-tab <ID>` 接管**明确属于此任务**的 BOSS 搜索标签，不要传入用户其他标签。未指定时，程序会寻找 BOSS 标签以创建自己的后台搜索标签，不激活 Chrome。标签句柄只保存在私有状态中，每次脚本执行都核对公开来源和路径。用户关闭或导航离开任务标签后，应重新指定任务标签，不会擅自使用其他网站。

## 控制命令

以下命令使用安装后的固定路径，不依赖当前仓库工作目录：

```sh
NODE=/opt/homebrew/bin/node
CLI="$HOME/Library/Application Support/job-shortlist/app/scheduler/cli.mjs"

"$NODE" "$CLI" preflight
"$NODE" "$CLI" run-once --dry-run
"$NODE" "$CLI" resume
"$NODE" "$CLI" request-run
"$NODE" "$CLI" status
"$NODE" "$CLI" pause
"$NODE" "$CLI" uninstall
```

`preflight` 只读验证；`--dry-run` 读取真实公开岗位并保存私有证据/候选结果，但没有 Git 提交或推送。`request-run --dry-run` 与 `request-run` 分别请求由**已安装的 launchd 进程**执行试跑/实际发布，方便验证后台权限，不应将交互 shell 成功当成 launchd 授权证明。`run-once` 可直接手动运行，同样受唯一运行锁保护。

`status` 显示启用状态、下两个北京时间时段、上次真实执行/发布结果和待确认的发布记录。`pause` 停止后续工作、取消正在执行的任务并卸载防睡眠辅助；`uninstall` 再卸载调度服务并删除这两个 plist，保留私有配置、证据和 deploy key。撤销 GitHub deploy key 是另一个操作，应在 GitHub 仓库的 Deploy keys 设置中由所有者完成，守护进程不保存用来撤销密钥的广泛权限。

## 状态、恢复和发布

单轮使用排他锁，失败、阻塞、取消与成功分别持久化。自动时段在开始前记为已尝试，进程重启不会把失败时段当作尚未开始而无限循环。日志只记录通用错误码和计数，单文件有界轮转；保留最近 30 轮私有证据。

发布克隆不能包含用户未提交工作；发现意外改动、非快进历史或采样期间远端更新时会阻止写入。推送只包含验证后的 `docs/data/jobs.json`，不推送私有配置、原始 JD 或复核记录。**只有推送完成且公开 Pages 返回完全一致的数据后才记为执行成功**。若推送或 Pages 确认失败，`pending.json` 和发布克隆保留待检查的提交，不自动丢弃或重置历史；后续采样发布会阻塞，避免覆盖待核对结果。先暂停服务并检查本机状态，确认后可恢复并显式运行 `retry-publication`。该命令核对提交、仅有的数据路径、摘要和远端父提交后重试/验证，不把原本失败或取消的运行改记为成功。远端已发生其他修改时会继续阻塞，勿使用破坏性重置。

站点显示的是已发布快照和最近发布的调度说明，不是本机实时状态。页面不会自行轮询；重新加载读取最新数据。超过最近时段且未收到新快照时会提示可能延迟/失败。准确的暂停、取消、错误状态以本机 `status` 为准。

## 验证

```sh
node --test
```

测试包含北京时间/DST、最新时段补跑、重复运行锁、暂停/失败、去重计数、来源/身份校验、薪资未知值、保守职责初筛、数据保留和静态网站兼容性。运行权限还必须通过一次真实的 `request-run` 验证。
