# Static 发送与倒计时卡住：深入排查和修复方案

> 后续状态：方案已在本地实施并验证。请以 [修复与验收记录](2026-10-30-static-repair-completed.md) 为准；本文保留排查/方案阶段的历史状态。

日期：2026-10-30（Europe/London）
代码：main `93ee9694e9564c58732e5623fa4a1accdb732bb0`
状态：完成离线诊断和调度可行性原型；未修改运行代码、未部署、未调用真实模型或更改实验状态。

## 1. 结论：先修 SDK 事件阻塞，再修恢复缺口

两个表面症状存在同一条可复现的阻塞链：

1. 第六条人类消息触发 Static 的 `handleChat`。
2. SDK 在共享事件锁内等待回调；`handleChat` 又等待 Generator、Validator 以及可能的修复调用。
3. 后续 `humanMessageRequest`（聊天发送）和 `discussionAdvanceRequest`（超时恢复）等事件只能排队。
4. 客户端发送后设置 `pendingRequestId`，没有回执就一直禁用输入/发送。
5. 浏览器本地倒计时可以继续走到零，服务器的回调与推进逻辑却仍在等待模型。
6. 模型结束后，聊天才被处理。此时 deadline 可能已到，原本及时点击发送的消息会被判为 `discussion_closed`；Static 自身还可能在该阶段尚未结束时发布过期回复。

这比单独的“前端没有超时重试”更上游。只给前端加定时器，恢复请求仍会排在同一把锁后，不能解决模型期间的停顿。

本次复现证明当前依赖与源码组合具备该故障机制；没有用户原场次日志或 Azure 活跃镜像，不能声称已确认那一次事故的唯一现场根因。其他条件通过同一 callbacks 入口也可能受影响，不是 Static 模型策略专属。

## 2. 证据与测试边界

### 2.1 安装的真实 SDK

- `server/node_modules/@empirica/core/dist/chunk-LPBU7J6R.js:83`：Cake 创建共享 `Mutex`。
- 同文件 `startAttribute`（约 271–312 行）：使用该 mutex 的 `lockedAsyncSubscribe`，并 `await callback.callback(...)`。
- 同文件 `startTransitionAdd`：阶段 transition 订阅同样使用 Cake mutex。
- `chunk-WGYNSNUC.js:115`：`lockedAsyncSubscribe` acquire 后 `await fn(val)`，只有 fn 结束才 finally release。
- `server/src/callbacks.js:2403`：聊天监听直接注册 `handleChat`。
- `callbacks.js` Static 分支（约 2145–2192 行）：在该回调内等待完整 `runSharedGeneration`。
- `LLMTransport.mjs` 默认单次请求超时为 90 秒。Static 没有与当前 deadline 绑定的整链时间预算；多个串行调用及修复能累计更长等待。此处没有声称每次故障都等待了这些时长。

### 2.2 本次两项补测：2/2 通过

证据：被 Git 忽略的 `outputs/diagnosis-2026-10-30/static-sdk-lock.test.mjs` 和 `static-sdk-lock.log`。
执行：`node --test --test-reporter=tap outputs/diagnosis-2026-10-30/static-sdk-lock.test.mjs`。

测试使用真实 callbacks、真实已安装 SDK 的 `lockedAsyncSubscribe`、真实 Mutex/Subject，三个订阅共用一把锁；模型用可控 Promise 代替，不连接外部 API。它验证 SDK 锁原语与项目回调的组合，未启动完整 Tajriba/AdminContext。

| 场景 | 观察结果 |
|---|---|
| Static Generator 保持未完成，随后提交人类消息和超时恢复 | 两个 handler 都未进入；没有聊天回执，stage 未结束。释放模型 Promise 后它们依次执行；人类消息因处理时已过期被拒。 |
| 调度原型让事件回调返回，模型在后续任务运行 | 模型仍未完成时，人类消息已 accepted，deadline 恢复已结束 stage；之后放行模型，结果因阶段结束被丢弃，llmInFlight 清空。 |

调度原型仅证明解除事件锁占用可切断阻塞链，不是可直接投产的完整补丁。它尚未包含生产需要的原子任务认领、显式持久化 flush、崩溃恢复等机制。

此前测试 harness 直接调用 `handleChat`、使用 Fake Collector，未模拟 SDK 共享 mutex。因此“慢模型时仍可并发处理消息”的旧模拟通过，不足以证明真实事件调度正常。这是前一份排查需要补充的关键限制。

## 3. 推荐修复设计

### A. P0：拆分短事件处理与长模型任务

新增一个由 callbacks 进程管理的任务调度器，例如 `FacilitatorJobRunner.mjs`。将聊天处理拆为三个阶段：

1. **短事件阶段**：校验消息/round/stage、按 messageId 去重、更新计数、判断已有 checkpoint 条件；在短事务中认领任务并写入 PENDING、origin IDs、snapshot boundary、serverInstanceId。保存后将任务交给调度器，结束 SDK listener。短事务中不等待模型。
2. **后台计算阶段**：在 SDK listener 返回后运行已有 Generator/Validator/修复；所有异常被接住，任务有明确总时限与取消信号。只保留少量在途任务，不为每条消息排入一个新的模型任务。
3. **短发布阶段**：按 game 串行提交，重新核对 originating round/stage、ended、deadline、当前上下文、任务是否仍有效；原子地写消息、recordPublish、计数及终态审计，显式 flush。队列不跨模型等待持锁。

实施要求：

- 不可只把现有调用换成 `void handleChat(...)`。必须先完成消息去重和任务认领，防止同一事件/六条门槛启动多个后台任务；任务必须有 catch/finally。
- 人类消息接受与 ACK 作为短 handler 完成，保存 canonical message 和处理结果后及时 flush。主动 @ 的模型回复随后异步执行，不能阻塞 ACK。Practice 主动请求同理。
- Static、Adaptive 消息触发和 Requested Generalist 使用同一调度基础设施；Adaptive scheduler 也接入相同任务认领，避免前后台同时启动自动任务。
- 自动任务继续复用既有互斥语义，主动请求继续遵守既有 supersede 规则。基础调度修复不改 need 判定、role 抽签、6 条门槛、30 秒冷却、词数或提示词。
- 发布事务与人类计数更新共用短的应用层串行边界；不要让 recordPublish 的全量状态回写覆盖生成期间已处理的新消息，也不要将生成期间的旧快照直接写回。
- 后台运行不再享受 SDK 的 postCallback 自动 flush；所有新任务/ACK/发布/终态写入必须显式处理 flush 及失败。
- 每条任务 finally 清理 typing/in-flight 并写终态；对 flush 失败保留可恢复记录，不能将未持久化消息提前报为已发送。callbacks 重启时核对既有消息与终态，禁止同任务重复发布。

### B. P1：服务器负责超时结束，浏览器负责补发恢复

新增独立的 `DiscussionDeadlineScheduler.mjs`，其职责仅为 Discussion 生命周期，不做模型调用。

- 基于持久化绝对 deadline，在服务端时钟到期后检查 originating game/round/stage；必要时经过小幅 native-transition 宽限再补偿结束。
- 在 stage start、已初始化 stage 的恢复和 callbacks ready/活跃阶段重载时重新注册。`formalStageStartHandled=true` 不能阻止恢复定时器；过期活跃 Task 应立即进入补偿检查。
- 以 game+round+stage 为幂等键。阶段已结束、当前 stage 改变、游戏结束则取消；不因 allReady 跳过 deadline 检查。保持到期前的原生全员 Ready 提前推进机制。
- 模型尚未完成不阻止结束。阶段终止会取消任务，迟到结果没有发布权限。
- `DiscussionAdvanceGuard` 到期后每隔约 2 秒发恢复请求，直至观察到 stage 已推进/ended；移除“一次发出即永久去重”的行为。每次传输带不同 attempt 标识；服务端结束语义仍按 stage 幂等。
- 所有请求由服务端复核时间；客户端时钟偏快导致的提前请求只会被拒/等待，后续请求仍可成功。客户端不自行 set ended，也不把 allReady 当作推进已经完成。
- 提供可诊断的状态/回执（too_early、already_ended、recovered）。补偿路径需与真实 native Step 并发测试，不能以一个本地布尔值声称彻底消除原生 transition 竞争。

### C. P1：聊天发送有可恢复的等待状态

涉及 `CustomChat.jsx` 和 `humanMessageRequest` handler。

- 保存未确认请求的完整快照：requestId、roundId、stageId、原消息正文；保留草稿。
- 等待一段可配置时间后，显示“尚未确认发送”，提供“重试发送”。不要直接显示“发送失败”，因为服务器可能已保存只是 ACK 未到。
- 重试复用原 requestId/内容，仅增加 transport attempt/发送时间，确保属性再次发送；不能新建消息 ID。
- 服务端继续按 player+requestId 去重，重复请求返回原处理结果；可额外检查正文/轮次绑定，拒绝同 ID 不同内容。利用 canonical messageId 检查 ACK 写入前崩溃的半完成状态，避免只依赖 processed map。
- 接受/拒绝/重复回执都显式 flush。ACK 返回成功后才清草稿；没有当前游戏/阶段的路径也应返回可识别拒绝，而不是静默 return。
- 同一未确认请求不允许偷偷创建新 ID 再发。页面重载/重连恢复同一 pending 请求；跨 round/stage 时保留原上下文供查验，不重定向到新轮次发送。
- 重新收到迟到 ACK 时，按 requestId 处理；不能清空用户后来编辑的新草稿。

### D. P1：Static 生成与发布统一遵守 deadline

- 在模型调用前、调用后以及最终提交前检查游戏/round/stage 是否仍有效、是否 ended、服务端 deadline 是否已到。Static 自动路径补齐当前仅 Adaptive 具有的截止检查。
- 每个实际模型调用的 timeout 取“配置的单次上限、整链剩余预算、deadline 剩余时间”的最小值；阶段结束主动 abort；不能用新的不受控 Promise 延长实际请求。
- 整链时限包含 matched delay、Generator、Validator、修复。预算耗尽写明确终态，finally 清理任务与 typing，不生成未经验证的占位回复。
- 保留 Static 最后 10 秒不启动自动尝试的规则；不要直接复制 Adaptive 最后 20 秒策略而改变实验条件。总预算值须显式配置、记录且验收，不能宣称已经过延迟校准。
- 将 `deadline_expired`、`context_stale`、`validator_unavailable`、`provider_timeout` 等区分记录，方便判断“正常未发布”与“系统卡住”。

### E. P2：修复漏计风险与待办丢失，不擅自增加干预频率

- 人类计数按已接受 canonical message ID 推进，补处理一次 callback 看到的全部未处理消息；不按 callback 次数计数。固定提示和 AI 回复继续排除。
- 采用持久化 transcript cursor/处理边界，并测试旧游戏迁移、重连、重复事件和新 round 重置，不使用仅保存在内存的 Set。
- 生成期间的新消息必须及时处理并参与上下文有效性检查；解除共享锁后，现有“两条容忍度”才会在真实并发讨论中充分发挥作用。不能为了保证发布而放行过期内容。
- 对“已满足门槛但因在途/冷却暂缓”的现有机会保留可观察待办；是否允许没有新消息时在冷却结束自动重试，需要作为明确的实验触发策略决定。首轮可靠性补丁先不新增定时模型重试、不改30秒与六条规则。

## 4. 验收矩阵（必须加入真实 SDK 调度层）

| 输入故障 | 应有行为 |
|---|---|
| Generator/Validator 保持未返回 | 聊天 ACK、Ready、deadline handler 可在模型未完成时运行；不能只断言最终会完成。 |
| 第六条重复通知、批量交付三条、回调重放 | 按新消息 ID 计数；同一 checkpoint 无重复任务/发布；六条计数不由固定提示重置。 |
| 发送已入库但 ACK 丢失；重复同 ID 重试 | 可恢复，最多一条 canonical 消息，最终返回原结果。 |
| callbacks 在消息保存后、ACK 前重启 | 同 ID 重试查到已接受消息，不重复入库；草稿与 pending 可恢复。 |
| 客户端时钟提前/滞后、超时请求丢失、全员 Ready 但原生推进漏失 | 服务端 deadline 补偿仍结束；客户端持续补发直到观察到完成。 |
| 原生 Step 与补偿定时器并发 | 只结束当前阶段，无跳过下一阶段、无重复终态写入；通过完整 Tajriba 连接验收。 |
| callbacks 在 deadline 前/后重启 | 按已有绝对 deadline 恢复，不能重新开始完整时长。 |
| Static 在 Generator/Validator/repair 期间跨 deadline | abort 或丢弃，无迟到发布，typing/in-flight 归零，终态只写一次。 |
| 轮次切换、游戏结束、主动请求 supersede | 旧任务不能向新阶段发布，锁/队列及时释放。 |
| 两场游戏同时运行，一场模型挂起 | 另一场聊天与阶段推进仍可处理；任务隔离按 game/round/stage。 |

本地验收使用可控时钟、deferred 模型 Promise、真实 SDK 锁/调度接线；前端还需真实浏览器断网/重连和迟到 ACK 测试。端到端离线测试不能仅用 Fake Collector 或源码正则。

## 5. 实施与上线顺序

1. 先把本次 SDK 锁复现变成稳定回归，并增加阶段结束/消息 ACK 不等待模型的失败测试。
2. 实现 A（事件与模型解耦）和 D（deadline/清理），再实现 B、C；各修复分别提交，便于定位与回退。修复过程中不得覆盖现有 stash 或更改研究提示词。
3. 运行受影响源测试与 build；补真实 SDK/浏览器/本地 Tajriba 故障注入。检验新后台并发下的计数、publication 原子性和 stale discard，不仅检查响应速度。
4. 检查当前 Azure 活跃镜像/revision/probes，再用已提交代码构建不可变镜像，按项目 Azure 流程部署。当前“本机拉取了 main”不改变已部署镜像。
5. 在隔离测试批次完成三人 Static 讨论：正常六条 checkpoint、慢模型期间发送、deadline 到期、重连、Ready、FinalDecision 均验证。保留 revision/image、审计、ACK/事件队列延迟和 subscription 活性证据。此步骤不得混入正式批次。
6. 只有完整部署和三人验收通过后，才将问题标为“线上已修复”。callbacks healthz 不替代 Tajriba scopedAttributes 订阅活性检查；partial-freeze 仍是独立运行风险。
