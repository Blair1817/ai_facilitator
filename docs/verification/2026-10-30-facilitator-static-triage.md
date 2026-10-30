# 消息计数、角色选择与 Static 卡住排查

> 后续状态：方案已在本地实施并验证。请以 [修复与验收记录](2026-10-30-static-repair-completed.md) 为准；本文保留排查/方案阶段的历史状态。

日期：2026-10-30（Europe/London）。代码基线：main `93ee9694e9564c58732e5623fa4a1accdb732bb0`。
范围：源码、Git 历史、真实 callbacks 的离线模拟、现有专项回归。没有修改运行逻辑、调用真实模型、部署、重启或更改实验状态。本机未发现 Azure CLI，本次未核验 Azure 活跃镜像、运行日志或订阅，因此“代码已有修复”不代表“线上已部署并修复”。


> 后续深入排查已补测真实 SDK 共享事件锁：模型等待会阻塞聊天 ACK 与超时恢复。详见 [Static 发送与倒计时修复方案](2026-10-30-static-send-deadline-repair-plan.md)。前文 Fake Collector 测试不覆盖该调度层。

## 逐项状态

| 用户反馈 | 最新代码状态 | 证据及限制 |
|---|---|---|
| participation balance 如何计数 | 已实现确定性参与计数 | CognitiveOperations.mjs: countPublicMessagesByName 只统计名单中的公开参与者消息。零发言且别人已发言，或别人平均至少 2 条且本人少于该均值的一半，成为 quiet 候选。普通 checkpoint 随机池包含一个合格 quiet 候选，不保证每次选择。 |
| “No rush …”是否计入六条、占用干预 | 已隔离；不是当前计数根因 | 固定 90 秒 silence watchdog 提示，DETERMINISTIC_FIXED、countsAsIntervention=false；不增加 humanMessageCount、不重置 messagesSinceLastPublish，也不会使在途自动生成作废。现有和补充 callbacks 测试均通过。 |
| “Hi, Green—glad you’re here …”如何计数 | 无法从显示文字确定来源 | 当前源码未找到这段固定文案。Facilitator 显示名不能区分自动生成、主动请求回复与固定提示。若为主动 @ 回复，最新代码已单独计 totalParticipantRequestReplies、不重置六条门槛；若是自动 checkpoint 生成，成功发布后会重置门槛。需要原消息 facilitatorOrigin/facilitatorTrigger/countsAsIntervention/auditRequestId 才能判定。 |
| 取消 roles 优先级 | 已实现，93ee969 | 三类 need 独立判断、分别验据；先在合格 role 中等概率抽取，再在该 role 的候选中抽取。不是所有候选平铺抽签。连续两次相同 Specialist role、有其他 role 可选时避开第三次相同。 |
| roles 是否完全没有特殊顺序 | 仍有明确例外 | 最近 12 条公开人类消息中完全未发言者，Adaptive checkpoint 可由 silence rule 强制邀请，不调用 detector；每人每轮最多两次，间隔至少 12 条人类消息。180/120 秒及提前收尾的 scheduler 检查仍只允许整合；参与者明确整理中仍可 defer。普通 need 之间的固定优先级已取消。 |
| Static 自动回复很少、发不出 | 已修主要已知原因，但不是保证每六条必发 | 49442c0：生成期间新增 1–2 条人类消息仍允许发布，超过 2 条仍作废；默认 6 秒 matched delay 已改为 0。93ee969：固定 nudge 不再使在途自动回复作废。主动请求产生的新 LLM 回复仍使旧自动回复失效。 |
| 参与者发送后输入框锁死 | 恢复缺口仍存在 | CustomChat.jsx: pendingRequestId 非空时禁用输入/发送，仅匹配 humanMessageRequestResult 才清除。没有发送回执超时或重试路径。服务端 callbacks/连接异常导致回执不返回时，会持续等待；这不是 Static 专属。未重现用户原会话，不能断言原故障一定由此导致。 |
| Static 倒计时结束后卡住 | 有旧恢复路径，尚未完全解决 | DiscussionAdvanceGuard 仅在 deadline+100ms（客户端时钟）发送一次请求，并用 lastRequestKey 去重；allReady 时完全跳过恢复。服务端按自己的 Date.now 检查，提前到达会拒绝且没有 ACK/重试。补充真实 listener 模拟证明：提前请求被拒，时间流逝不会重新触发，新的重试请求才结束阶段。若原生 Step 正常则无需恢复；原生推进漏失时此缺口才影响流程。 |
| Static 截止后的发布保护 | 未修，已离线复现 | callbacks.js canPublishFacilitatorResult 仅对 Adaptive 自动结果加 deadline/round-ended 检查。Static 在模型调用期间跨过 deadline、Task 未真正结束的模拟中仍成功发布。它是终止边界缺陷，不足以单独证明它导致用户的倒计时卡住。 |
| callbacks 崩溃但网页仍活着 | 有代码修复，仍需部署验收 | e84c084 给 export SDK 注册 error listener，并提供 callbacks healthz + Azure HTTP probe YAML fragment。断言能抵御非法 1006 close frame并继续查询；但当前本地测试退出时仍报告 after-hook 异步 unhandledRejection。不可写成整项完全通过。fragment 也不证明在线配置已应用。Tajriba 既有订阅 partial-freeze 仍没有本次修复证据。 |

## 六条触发的准确含义

六条是“上次自动成功发布后，经过 callbacks 处理的人类消息”门槛，还同时受 30 秒 attempt cooldown、Task 生命周期、在途锁、剩余时间和生成/验证结果约束。Static 最后 10 秒不新启动自动尝试；Adaptive 为最后 20 秒。它不是第六条一到就保证出现回复。

尝试失败不清空六条计数，但会记录 attempt 冷却；Static 没有独立的冷却结束重试定时器，失败后没有新消息时不会自动再试。累计人类消息足够但未发出，要看 llmLog.reason/outcome、failureStage、上下文漂移和在途状态，不能仅看界面条数。

另一个条件性计数风险：handleChat 每次只处理 transcript 最后一条人类消息并 +1。若一次 callback 看到多条新到消息（例如订阅恢复或合并交付），它不会按未处理 ID 补计。补充模拟一次交付三条只计 1；尚未验证线上 SDK 是否在用户故障时发生了这种交付，不将其列为已确认现场根因。

## 本次验证

1. 现有专项（NeedDetector、CheckpointManager、BackendReliability、DiscussionOpening、StageStartDispatch、ExportConnection、AdaptivePipeline）：106 通过，1 项因 sandbox 禁止本地 listen 而失败。
2. 生命周期补充（ExperimentRedesign、LifecycleForms、ExperimentPolicies、AdaptiveRecovery）：54/54 通过。部分前端生命周期测试为源码断言，不等于浏览器断线实测。
3. 新增临时诊断复现：4/4 通过，覆盖非人类消息不计数、提前 deadline 请求与重试、Static 跨 deadline 发布、一次 callback 多消息漏计。后两项“通过”表示成功复现现有缺陷，不代表已修复。
4. 放开本地 loopback 后单独重跑 ExportConnection：非法 1006 核心测试断言通过；文件级结果失败，原因是 after hook 结束后发生异步 unhandledRejection。未将其归为纯权限问题，也未将其直接等同于线上崩溃复现。
5. 诊断前工作树干净，未修改运行代码。模型调用均由 fetch stub 代替。真实 Azure/浏览器/LLM 检查未执行。

证据保存在被 Git 忽略的 `outputs/diagnosis-2026-10-30/`：四份测试日志及本机临时诊断脚本（脚本包含本机路径，不提交）。

## 后续优先修复与验收

- P1：讨论超时恢复增加重复、幂等的服务端校验；不要因 allReady 跳过 deadline 恢复。验证客户端时钟提前、回执丢失、callbacks 重连与原生推进遗漏，避免与正常 Step 重复结束竞争。
- P1：聊天发送回执等待增加可恢复状态，重试复用同一 requestId 并保留草稿，利用现有服务端 processedHumanMessageRequests 去重；不得简单解锁并用新 ID 重发造成重复消息。
- P1：Static 自动发布采用截止时间校验，验证生成/验证跨 deadline 均不得发布。
- P2：验证真实 SDK 恢复/批量交付行为；若能合并多条更新，应按未处理 messageId 补计人类消息，而不是回调次数。
- P2：定位 ExportConnection 测试退出后的异步拒绝，确保 SDK 重连停止与 pending Promise 的生命周期完整。
- Azure 验收：读取活跃 revision/image/probes，核对包含上述提交；进行 scopedAttributes 真实订阅检查，再进行 Static 三人发送/超时/断线恢复演练。HTTP 200 或 healthz 单独不能证明 Tajriba 订阅活性。
