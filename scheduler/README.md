# 本机采集与人工复核

默认且唯一可启用的调度模式为 **`collection-only`**：北京时间每天 **09:30、12:30**，通过普通 Chrome 的已登录 BOSS直聘会话进行有界公开职位采样，保存到本机私有复核队列。**采集过程不访问 Git、发布克隆、GitHub API 或 Pages，不自动发布岗位，不调用模型、通知、MCP 或聊天会话。**

## 方向与资格分开

`intent-policy.json` 是独立的、明确版本化的私人方向配置，不改变 `matching.json` 中已经确认或仍然未知的资格事实。商业伙伴拓展、渠道经营、生态协作按实际职责判断；独立谈判、成交责任、技术资源、行业经验等要求单独保留为待确认条件。

主要职责为内容、活动或需求生成时，不因偶尔涉及伙伴就变成伙伴发展岗位；真正的伙伴经营岗位也不因含联合活动而被归为市场岗。私有队列中的 `primary`、`secondary`、`unclear`、`outside` 是**方向判断**，不是资格或录用概率。

默认六项中文轮换为：

| 查询 | 行业 |
| --- | --- |
| 渠道经理 | 软件 |
| 渠道拓展 | 云 |
| 生态合作经理 | 软件 |
| 渠道运营 | 软件 |
| 渠道经理 | 计算机服务 |
| 生态合作 | 云 |

所有查询固定上海，不设置工作经验 URL 参数、薪资下限或英语排除。每轮最多 3 个查询、每个查询 15 张卡片、8 份完整 JD、30 分钟；跨非空查询公平分配额度，优先未读或变化记录，同时保留有界的过期复查机会，不是自动学习或无限扩张搜索。

## 私有数据与复核队列

默认目录 `~/Library/Application Support/job-shortlist` 使用 `0700`；配置、台账、队列、证据为 `0600`。原 JD、私人方向、资格配置、未入选记录与手动排除不得进入公开 Git。

`review-queue.json` 以来源限定的岗位 ID 去重，保存已验证元数据、完整 JD、观察日期、意图和资格判断及人工状态。`evidenceHash` 绑定规范化的实际内容，不绑定每次重新读取的时间。相同内容复查保留批准/拒绝；内容或资格发生实质变化后原批准失效，必须重新人工审核。明确拒绝及 `manual-exclusions.json` 中的 ID 不会自动重新入选。累计证据台账不是黑名单。

采集完成状态为 `collected`，不同于 `dry-run` 或 `published`；`publication` 必须为 `null`。本机 `status` 单独显示最近采集、最近真正发布、待复核数和下次时段。新的采集不会覆盖上次有效发布或写入网页状态。

## 安装与恢复

Node、系统 Perl/Fcntl、AppleScript、launchd 均从本机已有工具运行，无包依赖。Chrome 需要用户主动授予 Apple Events JavaScript 权限；程序不会改变 TCC、浏览器设置或绕过验证码。

```sh
node scheduler/cli.mjs install --mode collection-only \
  --repository OWNER/REPO \
  --matching /PRIVATE/matching.json \
  --ledger /PRIVATE/ledger.json \
  --ssh-key "$HOME/Library/Application Support/job-shortlist/keys/github-deploy-ed25519" \
  --known-hosts "$HOME/Library/Application Support/job-shortlist/keys/known_hosts" \
  --node "$(command -v node)"
```

安装复制代码到私有 `app/`，明确迁移为采集模式、关闭自动发布、建立独立方向策略及复核队列，并保持暂停。已有确认资格、排除记录、证据台账与成功/失败历史保留。缺少明确模式的旧配置不会默默恢复自动发布。

`com.job-shortlist.scheduler` 每 60 秒检查实际上海时间；`com.job-shortlist.keep-awake` 仅在启用时通过 `caffeinate -s` 避免接通电源后的空闲系统睡眠。每轮仅临时使用 `caffeinate -i`。不会强制亮屏、改变系统电源设置，也不能保证合盖、手动睡眠、退出登录、断网后按时运行。

每次 `resume` 单独设置 **下一个未来时段** 的启用边界，不伪造成功记录、不消费历史时段、不立即重放暂停期间的旧任务。启用后的正常唤醒只补最近一个漏掉时段，不循环追赶。手动受控验收不消费自动时段。

## 常用命令

```sh
NODE=/opt/homebrew/bin/node
CLI="$HOME/Library/Application Support/job-shortlist/app/scheduler/cli.mjs"
"$NODE" "$CLI" status
"$NODE" "$CLI" review-list --limit 20
"$NODE" "$CLI" review-show --id SOURCE-JOB-ID
"$NODE" "$CLI" request-run --controlled
"$NODE" "$CLI" resume
"$NODE" "$CLI" pause
"$NODE" "$CLI" uninstall
```

`request-run --controlled` 是显式请求已安装 launchd 在仍暂停时完成一次**真实采集与队列写入**，不是发布或自动恢复；仅在需要验收时人工调用。`run-once`、`tick`、`retry-run` 在采集模式下同样绝不触发 Git、网页数据更新或通知。`--dry-run` 标记非正式采集试验，仍可保存私有复核证据，但不会自动批准。

`review-show` 仅在本机输出指定记录及原始资格说明；不要把输出发到公开仓库。`review-list` 默认列出最多 20 个待审核的主要方向、次级方向与不明确记录，按方向优先级排序，不把资格未知自动转成匹配。

## 明确人工批准与发布

使用 `review-show` 阅读当前证据，人工准备一个私有 JSON：

```json
{
  "version": 1,
  "approvals": [
    {
      "id": "SOURCE-JOB-ID",
      "evidenceHash": "CURRENT_64_CHARACTER_SHA256",
      "job": {}
    }
  ]
}
```

`job` 必须是完整 v1 的人工改写公开记录，不能是空对象或原文。ID/来源/标题/公司/地点必须对应当前证据，时间不得伪造，摘要须脱敏；不得把待确认资格写成已满足。短哈希或旧哈希都不接受。

```sh
"$NODE" "$CLI" review-approve --file /PRIVATE/approved-jobs.json
"$NODE" "$CLI" publish-reviewed --ids SOURCE-JOB-ID
"$NODE" "$CLI" review-reject --id SOURCE-JOB-ID --evidence-hash CURRENT_SHA256
```

批准只改变私有状态。**只有第二个显式命令才允许发布**；它再次核对当前证据/批准/排除记录，使用独立 `publish/` 克隆及仓库专用 deploy key，并只提交已批准的脱敏快照。仍未审核的记录、失效批准、资格明确不满足或排除 ID 不会被推送。原始岗位对象只重置 `isNew` 标记；新的人工入选时间记录于 `firstPublishedAtById`，不重写首次观察日期。旧记录没有此字段时沿用原日期视图语义。

网络/Pages 确认失败后，`review-publication-pending.json` 保留精确提交、摘要和批准哈希。手动 `retry-reviewed-publication` 会重新验证批准未失效、未被拒绝/排除、提交/路径/摘要及远端历史一致，再重试或确认发布；调度不会自动调用它。旧的自动发布恢复命令已禁用。

## 安全与故障处理

所有采集/人工队列修改/发布使用同一内核 `flock`，拥有者声明采用不可覆盖的原子发布。程序退出会释放管道及锁；超时/取消清理仅限自己创建的子进程组。任务标签丢失可创建新的任务标签，仍存在但导航到非允许页面则阻塞，不复用其他用户页面。

登录、验证码、未知加载、错 ID 和标题不一致都不会被当成有效完整 JD；明确的短正文和稳定标题冲突仅私有隔离。规则未识别不代表市场无岗位。日志有界、仅记录通用运行码和计数，daemon 不在完成/失败时输出大块 stdout 或发通知。无法据此承诺第三方应用卡死已解决。

`pause` 取消活动工作并卸载 AC 辅助；`uninstall` 进一步卸载服务/plist，但保留私有证据及 deploy key。GitHub 密钥撤销是所有者独立操作，不在守护进程中保存广泛权限。

验证使用既有 `node --test`；后台浏览器权限与是否影响其他应用还需要一次受控的真实采集验收。
