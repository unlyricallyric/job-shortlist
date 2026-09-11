# 本机采集与候选发布

北京时间每天 **09:30、12:30**，通过普通 Chrome 的已登录 BOSS直聘会话进行有界公开职位采样。安装必须明确指定模式，不会因为更新代码而暗中恢复自动发布：

| 模式 | 岗位可见性 |
| --- | --- |
| `candidate-feed` | 有效来源卡片脱敏、去重后自动发布为采样候选，不需要事前批准；仅在 Pages 精确字节确认后记录发布成功 |
| `collection-only` | 只保存私有队列，整个采集过程不访问 Git、发布克隆或 Pages；需显式人工批准与发布才公开 |

两种模式都不调用模型、通知、MCP 或聊天会话。候选自动展示不等于资格通过或合格推荐。

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

默认目录 `~/Library/Application Support/job-shortlist` 使用 `0700`；配置、台账、队列、证据为 `0600`。原 JD、私人方向、资格配置、手动排除及联系人不得进入公开 Git。候选仅输出白名单卡片字段、简短来源模板与明确的信息缺失状态，不公开私有资格理由。

`review-queue.json` 以来源限定的岗位 ID 去重，保存已验证元数据、完整 JD、观察日期、意图和资格判断及人工状态。`evidenceHash` 绑定规范化的实际内容，不绑定每次重新读取的时间。相同内容复查保留批准/拒绝；内容或资格发生实质变化后原批准失效，必须重新人工审核。明确拒绝及 `manual-exclusions.json` 中的 ID 不会自动重新入选。累计证据台账不是黑名单。

仅采集成功状态为 `collected`，`publication` 为 `null`。候选模式先保存真实采样与私有证据，再从全部有效卡片及既有队列构建候选快照；私有初筛的 select/review/reject、方向不明或资格未知都不阻止展示，没有每轮新增上限。只有明确用户排除、队列人工拒绝和基本身份/隐私问题会阻止收录。JD 未读、过短、标题/ID 冲突或无法分离职责与要求时，只展示原卡片，`jdRead: false`，不采用错位正文。

本机 `status` 分开显示最近采集与最近发布。候选模式 `autoPublish: true`、`manualApprovalRequiredForVisibility: false`，仅在推送及 Pages 精确字节确认后记录 `succeeded`；Git/Pages 失败保留之前的有效发布，不能用 `collected` 冒充网站已更新。无新候选的成功采样也发布真实采样时间与计数。

## 安装与恢复

Node、系统 Perl/Fcntl、AppleScript、launchd 均从本机已有工具运行，无包依赖。Chrome 需要用户主动授予 Apple Events JavaScript 权限；程序不会改变 TCC、浏览器设置或绕过验证码。

```sh
node scheduler/cli.mjs install --mode candidate-feed \
  --repository OWNER/REPO \
  --matching /PRIVATE/matching.json \
  --ledger /PRIVATE/ledger.json \
  --ssh-key "$HOME/Library/Application Support/job-shortlist/keys/github-deploy-ed25519" \
  --known-hosts "$HOME/Library/Application Support/job-shortlist/keys/known_hosts" \
  --node "$(command -v node)"
```

安装复制代码到私有 `app/`，明确迁移到所选模式并保持暂停。仅采集模式可用 `--mode collection-only`。已有确认资格、方向策略、排除记录、证据台账与成功/失败历史保留。候选模式不保留旧 `maxNewJobs` 参数，它限制读取额度但不截断有效候选展示。缺少明确模式的旧配置不会默默恢复自动发布。

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

`request-run --controlled` 显式请求已安装 launchd 在仍暂停时运行一次配置中的模式：候选模式会实际发布，collection-only 只采集，不会自动恢复日程。`--dry-run` 无论何种模式都不会发布。`run-once`、`tick`、`retry-run` 同样遵守明确模式，不发通知。

```sh
"$NODE" "$CLI" publish-captured --run-id COMPLETED-SOURCE-RUN-ID
"$NODE" "$CLI" retry-candidate-publication
```

`publish-captured` 只从指定已完成采样的卡片及现有队列补展示，不启动 Chrome，也不改写源观察时间或该时段的采集历史。人工选入旧记录不会被降级为候选。首次公开时间保存在 `firstPublishedAtById`，同 ID 重复采样不重置日期，后续批次仅重置 `isNew`。

候选发布从写入前即持久化 `pending.json`，记录预期脱敏快照、基准提交、精确摘要和已提交阶段。取消或 Git/Pages 故障后，显式恢复或下一次实际执行的采样时段最多进行一次有界恢复，不在每分钟空闲 tick 中无限重试。恢复重新核对排除、分支/来源、精确文件内容、提交路径与远端历史，不 reset 或覆盖未知修改；未知冲突保持可见错误并停止发布。

`review-show` 仅在本机输出指定记录及原始资格说明；不要把输出发到公开仓库。`review-list` 默认列出最多 20 个待审核的主要方向、次级方向与不明确记录，按方向优先级排序，不把资格未知自动转成匹配。

## 显式反馈排除

`runtime.roleExclusionsVersion: 1` 将调度连接到本机 `role-exclusions.json` 与 `role-exclusions-history.json`，均须为 `0600` 常规文件。前者是版本化的负面类型规则选择，不含个人履历；后者只记录岗位 ID、规则类别、理由代码、依据类型与真实观察/过滤时间，不删除原证据。配置已声明却缺失、损坏或权限不安全时，任务明确失败，不悄悄关闭过滤。升级安装会校验并保留现有策略与历史。

规则只处理明确反馈的岗位类型，并区分标题实际职务、JD 职责主体和任职要求/晋升/汇报语境。NFKC、空格及标点规范化只用于匹配，不改写公开原文。渠道/伙伴共同销售、赋能及伙伴收入指标不等于自己开发、签约、回款；仅卡片或详情身份无法确认时，不借用错位或其他日期的 JD。没有明确排除依据的候选继续可见。

规则在完整 JD 额度分配前和每次候选合并时执行，也覆盖积压补展示及待发布恢复。已经因反馈过滤的 ID 不因后续稀疏卡片而重新出现；原逐 ID 人工拒绝始终优先。已人工选入的记录保持原选择，可能冲突只记在私有维护结果，不能把历史选择伪装成新拒绝。

```sh
"$NODE" "$CLI" filter-candidates
```

此命令仅按当前私有政策清理公开候选，使用独立发布克隆和现有精确字节确认流程，不启动采集；保留原采样时间、计数、观察时间、首次展示日期及保留记录的批次新增标记。`role-exclusion-cleanup.json` 记录本次移除与保留的原人工选择冲突，不能上传公开仓库。

未来确有新的明确人工意图覆盖类型规则时，仍需当前源证据及普通 `review-approve`，然后仅在该次人工发布使用 `publish-reviewed --ids ... --override-role-exclusions`。旧批准或默认发布不能覆盖后来添加的反馈；覆盖不适用于明确逐 ID 拒绝，也不会自动确认任职资格。

### 扩展职能政策与全量复查

`role-feedback-v2` / `version: 2` 增加技术职业及明确的其他职能过滤。`runtime.roleExclusionsVersion` 必须与实际政策版本一致。旧 v1 历史项保留原 `policyId`、版本、理由和时间，新项按 v2 追加；不得靠把历史记录改成新版来伪造判断。已声明版本的政策缺失、版本冲突或无效历史会明确阻止发布。普通安装升级保留实际私人政策，不自动改写其版本或确认资格。

技术规则识别岗位本身的工程、架构、算法、GPU/容器/系统开发、专业技术实施等职责，以及明确必需的编程、部署、排障、系统设计能力。技术产品名、合作对象、汇报 CTO、晋升路径或仅优先技术经验不等同于当前工程职责；业务开发与伙伴开发不是软件开发，计算机专业要求本身不证明工作是编码。非技术伙伴经营、普通商业培训及职责不明确的候选继续展示。

当前全部岗位需要重新审核时，使用完整且来源快照绑定的私有文件：

```json
{
  "version": 1,
  "publicSha256": "SHA256_OF_CURRENT_PUBLIC_JSON_BYTES",
  "decisions": [
    {"id": "SOURCE-JOB-ID", "decision": "remove", "category": "technical-function"}
  ]
}
```

每个当前 ID 必须且只能出现一次，不能只提交部分移除名单；`decision` 为 `remove`、`retain` 或 `uncertain`，后两者的 `category` 为 `null`。移除类别须属于当前 v2 政策；快照字节变化时整次操作失败，不猜测增删记录。实际文件必须覆盖所有已选入和候选记录，上例仅示意一个字段结构。

```sh
"$NODE" "$CLI" publish-full-review --file /PRIVATE/full-review.json
```

该人工命令只按明确审核 ID 撤下岗位，既可撤下候选，也可撤下先前人工选择。它沿用候选快照裁剪器，保留其他对象与所有首次展示/观察记录，只刷新维护发布时间；不启动浏览器。移除 ID 追加到原 `manual-exclusions.json`，旧拒绝项、队列证据和批准内容不被覆盖。`full-relevance-reviews/` 保存私有摘要绑定、逐 ID 结果和发布回执，禁止上传。

提交或 Pages 失败时明确拒绝仍持久生效，既有 `pending.json` 和 `retry-candidate-publication` 路径负责精确恢复；只有确认公开字节后才标记完成。旧人工批准、旧候选积压、旧待发布提交都不能绕过新的逐 ID 拒绝。重新采样的未知或商业相关候选仍走自动展示，不恢复前置审批。

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

批准只改变私有人工选择状态，第二个命令显式发布已选入标记与批准的脱敏摘要；它再次核对当前证据/批准/排除记录。候选模式不需要这些操作才可见，但人工选入仍需这个独立路径。已展示候选可原 ID 升级为已选入，不重复添加、不重置首次公开/观察时间；原有已选入对象不被自动候选数据覆盖。

网络/Pages 确认失败后，`review-publication-pending.json` 保留精确提交、摘要和批准哈希。手动 `retry-reviewed-publication` 会重新验证批准未失效、未被拒绝/排除、提交/路径/摘要及远端历史一致，再重试或确认发布；调度不会自动调用它。旧的自动发布恢复命令已禁用。

## 安全与故障处理

所有采集/人工队列修改/发布使用同一内核 `flock`，拥有者声明采用不可覆盖的原子发布。程序退出会释放管道及锁；超时/取消清理仅限自己创建的子进程组。任务标签丢失可创建新的任务标签，仍存在但导航到非允许页面则阻塞，不复用其他用户页面。

登录、验证码、未知加载、错 ID 和标题不一致都不会被当成有效完整 JD；冲突正文只私有隔离，但已验证的原岗位卡片可以作为详情待确认候选展示。规则未识别不代表市场无岗位。日志有界、仅记录通用运行码和计数，daemon 不在完成/失败时输出大块 stdout 或发通知。无法据此承诺第三方应用卡死已解决。

`pause` 取消活动工作并卸载 AC 辅助；`uninstall` 进一步卸载服务/plist，但保留私有证据及 deploy key。GitHub 密钥撤销是所有者独立操作，不在守护进程中保存广泛权限。

验证使用既有 `node --test`；后台浏览器权限与是否影响其他应用还需要一次受控的真实采集验收。
