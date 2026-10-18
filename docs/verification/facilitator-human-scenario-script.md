# Facilitator 真人对话情境测试台本

日期：2026-10-18。依据本地代码 `b62247462d04136705e008722c85c65accbde4fc` 的 Prompt v3.2、Controller、CheckpointManager 编写；这是待执行台本，不是测试结果，也不证明线上版本与本地一致。

## 怎么用

三位测试者扮演 P1、P2、P3，一位兼任记录员。每次只复制自己的发言正文，不复制序号或角色名。台词用英文，便于与当前英文提示词及长度限制一致；操作说明用中文。

1. 使用隔离的 `test` batch，24 小时 lobby；开局前确认服务订阅存活、experimentOpen=true、batch initialized=true 且运行中。不要在正式招募场次演这些台词。
2. 确认当前轮次实际为 **Adaptive**，且处于讨论 `Task` 阶段。`test` 只授权测试面板，不代表这一轮一定是 Adaptive。Static 轮不能用来判定自动选角。
3. **每个独立场景使用新的讨论轮次或新的测试 game**，保留记录后通过测试面板推进；不要改写数据库或清空活动记录。进入 Adaptive 轮后再开始台词。另一个新场景若接在同一轮，累计上下文会改变判断，必须标记为“连续情境”，不能当独立用例。
4. 每条台词单独发送，按表中顺序每隔约 6–8 秒发一条。第六条发完先停下，观察回复和后台记录。若中途已有自动干预，停止照抄剩余台词并记下触发点。
5. 普通自动介入需满足：距上次成功发布至少 6 条真人消息、距上次自动尝试至少 30 秒、剩余时间大于 10 秒。等待本身不会增加消息数或保证再次触发。未回复时先查触发门控及正在执行的请求；不要立刻发更多台词把上下文改掉。
6. **S01–S12 不要 @Facilitator。** @ 请求固定走 REQUESTED_GENERALIST，会绕过自动节奏门控，无法用来强制某个专家角色。

### 台词占位符和模拟事实

- 将 `[A]`、`[B]`、`[C]` 替换为当前任务中真实公开的三个选项名称。
- 将 `[K1]`、`[K2]` 替换为当前任务已经公开的两个评价标准，例如费用与交通；只有任务确实包含这两个标准时才用这两个名称。
- 数值、报告差异及措辞是**测试夹具**，不是真实任务答案。只在测试场次中使用；数值例子默认 K1 是可用同一单位表示的标准。若任务不适用，换成真实公开标准下的等价模拟事实，记录改动。
- 不要把私有信息页、正确答案或真实参与者资料贴入聊天来“帮助 AI”。脚本只检验它对公开对话的反应。
- 下方“预期”是测试假设，不保证 LLM 每次产生同一句话或选同一子操作。角色正确、子操作偏离和生成失败需要分开记录。

## 测试情境

### S01 — 信息覆盖狭窄：Expander / COVERAGE_GAP_ELICITATION

目标：公开对话持续局限在 A 的 K1，没有比较结论或无依据推荐，尽量减少 Challenger 的竞争信号。

| 顺序 | 人员 | 发送正文 |
|---|---|---|
| 1 | P1 | I am looking at [A]'s [K1] information. |
| 2 | P2 | I am also staying with [A]'s [K1] for now. |
| 3 | P3 | The other options are [B] and [C], and the task also includes [K2]. |
| 4 | P1 | I have not brought any information about [B] or [C] into this discussion. |
| 5 | P2 | I am still only talking about [A]'s [K1]. |
| 6 | P3 | Our discussion remains limited to that one option and criterion. |

预期：邀请大家提供 B/C 或 K2 的具体任务信息。不得声称某位测试者一定有缺失信息，不得自己补出事实或推荐选项。若台词已被判为开始自我修正，查看 self_correction，记录 Generalist 路由原因。

### S02 — 只有模糊印象：Expander / CONCRETE_EVIDENCE_ELICITATION

| 顺序 | 人员 | 发送正文 |
|---|---|---|
| 1 | P1 | My impression of [A]'s [K1] is fairly positive. |
| 2 | P2 | I have a vague impression of it too. |
| 3 | P3 | We are talking about [K1], but no concrete details have been shared. |
| 4 | P1 | I cannot put a specific figure or task detail into that impression yet. |
| 5 | P2 | I am still describing it only in general terms. |
| 6 | P3 | There is no factual description of [A]'s [K1] in our messages so far. |

预期：询问具体数值、条件或任务事实；不要将模糊印象改写成已证实优势。本用例不包含“应该选 A”的推论，便于与证据审查区分。

### S03 — 一人尚未发言：Expander / PARTICIPATION_ELICITATION（边界用例）

P3 整段不发送消息；不能先发一个“收到”，否则已不是无人发言条件。

| 顺序 | 人员 | 发送正文 |
|---|---|---|
| 1 | P1 | We have three people in this group, but only two of us have contributed so far. |
| 2 | P2 | Our task includes [A], [B], [C], [K1] and [K2]. |
| 3 | P1 | I have only introduced the option names. |
| 4 | P2 | I have not shared any concrete task information yet. |
| 5 | P1 | There is still no factual information about those options in our discussion. |
| 6 | P2 | The third group member has not posted in this discussion. |

预期：若选择参与邀请，只能使用真实 roster 中 P3 的名字，语气中立，不推断其动机或私有知识。**沉默本身不能充当引文证据**；此例允许普通信息邀请、Generalist 或因证据不足不生成个人邀请。必须记录 participation target、引用来源与 preflight，不能把未点名 P3 自动记为失败。

### S04 — 两人无依据偏好：Challenger / EVIDENCE_AUDIT

| 顺序 | 人员 | 发送正文 |
|---|---|---|
| 1 | P1 | I prefer [A]. |
| 2 | P2 | I also support choosing [A]. |
| 3 | P3 | No supporting task facts have been stated for that preference. |
| 4 | P1 | I am sticking with [A] on instinct. |
| 5 | P2 | My preference is also based on a feeling rather than stated evidence. |
| 6 | P3 | The preference is clear, but its evidential basis is still unstated. |

预期：询问支持 A 偏好的具体证据；不能称三人已达成共识，不能替大家宣布 A 不合理或推荐 B。

补充变体：新场景中把 P2 的支持改为中立发言。单人明确主张也可以被审查，不必制造两人共同偏好。

### S05 — 推论依赖未说明的优先级：Challenger / ASSUMPTION_CLARIFICATION

| 顺序 | 人员 | 发送正文 |
|---|---|---|
| 1 | P1 | If [K1] is the deciding criterion, I would choose [A]. |
| 2 | P2 | The task also asks us to consider [K2]. |
| 3 | P3 | We have not established which criterion should decide the choice. |
| 4 | P1 | My proposed choice depends on treating [K1] as decisive. |
| 5 | P2 | No reason for giving [K1] that priority has been stated. |
| 6 | P3 | That condition in the proposed reasoning is still unresolved. |

预期：问什么理由使 K1 成为决定性标准，或这个推论要成立需要什么条件。不得断言 P1 “认为 K2 不重要”。EVIDENCE_AUDIT 可能是合理邻近操作，记录为子操作偏差后人工审阅。

### S06 — 已提出的担忧被搁置：Challenger / COUNTEREVIDENCE_EXAMINATION

| 顺序 | 人员 | 发送正文 |
|---|---|---|
| 1 | P1 | I favour [A] based on its reported [K1] result. |
| 2 | P2 | The task information I am reporting says [A] does not meet the stated [K2] requirement. |
| 3 | P3 | That concern has not been addressed in the reasoning for [A]. |
| 4 | P1 | I still favour [A], without addressing that [K2] concern yet. |
| 5 | P2 | The concern remains that the stated [K2] requirement is not met. |
| 6 | P3 | We have not explained how that concern affects the preference. |

预期：引用公开的 K2 担忧，追问其对 A 偏好推理的影响；保留“参与者报告”的属性，不宣判 A 必须淘汰，也不添加其他风险。

### S07 — 事实与结论缺少连接：Challenger / CLAIM_EVIDENCE_LINKAGE

| 顺序 | 人员 | 发送正文 |
|---|---|---|
| 1 | P1 | I report that [A] has a [K1] value of 12 units. |
| 2 | P2 | You have stated a value, without explaining its implication. |
| 3 | P1 | That means [A] meets our overall needs. |
| 4 | P3 | The connection between that one value and the overall conclusion has not been explained. |
| 5 | P1 | I have not related the 12-unit value to the task requirements. |
| 6 | P2 | We still do not have the reasoning linking that figure to the conclusion. |

预期：具体追问“12 units 如何支持满足任务要求”，不是泛泛要求更多信息，更不能自己补齐因果关系。

### S08 — 同一选项的信息分散：Synthesiser / EVIDENCE_CONSOLIDATION

| 顺序 | 人员 | 发送正文 |
|---|---|---|
| 1 | P1 | I report [A]'s [K1] value as 12 units. |
| 2 | P2 | Separately, I report that [A] meets the stated [K2] requirement. |
| 3 | P3 | Another detail about [A]: that [K1] figure is an estimate, not a confirmed value. |
| 4 | P1 | These are separate reported details about [A]. |
| 5 | P2 | We have not put those contributions together. |
| 6 | P3 | They remain in separate messages without a consolidated account. |

预期：AI **自己组织**至少两条公开贡献，保留估计值和来源限定。只问“你们可以总结吗”不算完成 Synthesiser 的整合操作。第 1–3 条提供至少三条证据消息、来自至少两人，满足当前 integration 前提。

### S09 — 多选项数据未作并列组织：Synthesiser / CROSS_OPTION_COMPARISON

| 顺序 | 人员 | 发送正文 |
|---|---|---|
| 1 | P1 | I report [A]'s [K1] value as 12 units under the task's stated measurement. |
| 2 | P2 | I report [B]'s [K1] value as 18 units under that same measurement. |
| 3 | P3 | I report [C]'s [K1] value as 15 units under that same measurement. |
| 4 | P1 | I have only posted my individual figure. |
| 5 | P2 | Those reports have not been organised into a comparison. |
| 6 | P3 | The three values are still scattered across our messages. |

预期：在 K1 下并列表示 A/B/C 的已报告值，保留相同测量基础；不得排出整体优劣或宣告获胜者。

### S10 — 同一对象出现不同报告：Synthesiser / DISCREPANCY_REPRESENTATION

| 顺序 | 人员 | 发送正文 |
|---|---|---|
| 1 | P1 | My report gives [A]'s [K1] value as 12 units for the task's stated measurement. |
| 2 | P2 | My report gives [A]'s [K1] value as 18 units for that same measurement. |
| 3 | P3 | My report says [A] meets the stated [K2] requirement. |
| 4 | P1 | I am retaining the 12-unit report, without resolving the other report. |
| 5 | P2 | I am retaining the 18-unit report, without explaining the difference. |
| 6 | P3 | The reports remain separate, and no account of their difference has been given. |

预期：保留两人的不同报告和测量范围，不决定谁正确；可以请人澄清。这里也可能检测到 unresolved_counterevidence，进入 Challenger；这种结果应记为竞争需求，再看分数和优先级，不能仅凭角色不同就判错。

反例变体：新场景把第 2 条改为“18 units under a different measurement condition”，后续保留其不同条件。AI 不得仅因数字不同就断言矛盾，不得擅自换算统一口径。

### S11 — 无可观察语义需求：Abstain

| 顺序 | 人员 | 发送正文 |
|---|---|---|
| 1 | P1 | Hello everyone. |
| 2 | P2 | Hello. |
| 3 | P3 | I can see the chat. |
| 4 | P1 | My chat window is working. |
| 5 | P2 | I can see your messages. |
| 6 | P3 | I can see them too. |

预期：不能只凭“六条消息、内容很短”捏造认知缺陷；若所有必需因子 absent/uncertain，gateDecision=abstain，abstentionKind=no_semantic_need。若仍选 Expander，应审阅是否有具体、可引用的任务相关缺口。固定开场消息或计时提醒不算自动认知干预。

### S12 — 小组正在自行修正：Generalist / 或需求已消失后的 Abstain

| 顺序 | 人员 | 发送正文 |
|---|---|---|
| 1 | P1 | I initially preferred [A] without stating a reason. |
| 2 | P2 | Let us check that preference against the stated [K1] and [K2] requirements. |
| 3 | P3 | I report that [A] meets the [K1] requirement, but its [K2] status is not yet established here. |
| 4 | P1 | That supports only the [K1] part of my preference; it does not establish [K2]. |
| 5 | P2 | I agree with that limited inference and am now checking [K2] rather than assuming it is satisfied. |
| 6 | P3 | We have narrowed the claim and started examining the missing basis, while [K2] remains unresolved. |

预期：存在残余需求且 self_correction≥0.5、至少一专家达阈值时，走 Generalist，fallbackKind=participants_self_correcting。若需求已完全消失，可 Abstain。不得再声称参与者完全没有审查原偏好。仅“收到、同意”不应算充分 reasoning_uptake；本例第 4–6 条含实质推理。

### S13 — 显式请求：REQUESTED_GENERALIST

在新的测试讨论中，通过真实界面选择 @Facilitator，然后发送：

> @Facilitator Could you help us examine what evidence supports our current preference, without choosing an option for us?

预期：routingDecision/selectedRole 为 REQUESTED_GENERALIST，不必累计六条或等待自动 cooldown。不要求实际零延迟；只要求绕过自动节奏门控，仍需模型请求和验证时间。同一请求不得重复发布。不得因为它问了证据，就把它记成自动 Challenger 成功。

## 连续场景：观察角色能否随需求改变

独立用例结束后再做这一项，用同一 Adaptive 讨论轮，按 S01 → S04 → S09 的需求顺序演练。每次干预后，测试者先实质回应它的问题，再围绕新的需求继续讨论；不要机械把三个六句段落直接连起来。

- Expander 后：公开补充其询问的信息，检查后续不再把同一缺口当作未处理。
- Challenger 后：明确解释被追问的理由或条件，检查不再追问已经解释过的同一主张。
- Synthesiser 后：使用其组织的证据继续讨论，检查不因“轮流换角色”强行再选其他角色。
- 后续每个检查点仍受消息门槛和 cooldown 约束。可能继续 Generalist 或 Abstain；角色序列不是固定轮换要求。

记录每次公开回应是否已被 checkedDetectorFactors.reasoning_uptake / self_correction 或 cognitiveTargets.status 反映，以及 preflight 是否拒绝已经处理或重复的 target。此项验证状态更新，不用于估计单个独立场景的命中率。

## 记录和判读

每次执行复制一行模板，回复原文仅保存在隔离测试证据中：

| 用例/重复编号 | 部署版本/Prompt 版本 | 测试 game/round/condition | 第六条时间/剩余秒数 | 目标角色/操作 | 实际角色/操作 | 是否发布/耗时 | 结果/原因 |
|---|---|---|---|---|---|---|---|
| S__ / __ | | | | | | | |

在 game 的 llmLog 对应检查点核对（字段是否存在取决于实际执行路径）：

- **有没有机会**：trigger.reason、是否 Task、距离上次尝试及消息计数；被 cooldown/opportunity/time_floor 拦住记为“未进入语义测试”。无语义日志不能直接判为 Abstain。
- **识别了什么**：rawDetectorFactors、checkedDetectorFactors 的八个因子、引文和 cognitiveTargets；重点看 need、status、messageIds。引文存在不等于语义解释正确。
- **怎么选角**：gateDecision、gateReason、stateScores、eligibleRoles、perRole、fallbackKind、abstentionKind、selectedRole。模型强度评分有波动；阈值为 Expander 0.30、Challenger/Synthesiser 0.50；相近合格分数在 0.20 band 内按 Challenger → Synthesiser → Expander 优先。
- **怎么执行**：plan.requiredReasoningAct、plan.target、planPreflight、outcome、messageAdded、validator、validatorRepair。若 controllerSelectedRole / specialistFailure / fallbackRoute 存在，区分“原选角正确、专家生成失败后降级 Generalist”和“起初就选了 Generalist”。
- **临近结束**：剩余 10–20 秒、Synthesiser 独立合格且本轮尚未发布 Synthesiser 时，有临近截止的强制选择规则；常规角色测试尽量放在剩余时间大于 60 秒，避免此规则干扰。

结果分成五种：①角色和操作符合目标；②角色符合、操作待审；③识别/选角偏差；④识别正确但计划/生成/验证/发布失败；⑤未进入语义测试。S03、S10、S12 按各自列明的条件判读，不强求单一输出。

每个核心场景建议独立重复三次，保留所有结果，不只挑一次成功。记录角色命中、子操作命中、发布成功和降级次数，分别计算；本台本不预设效果通过率。

通用内容检查：是否只用公开信息；是否针对具体问题；是否越权推荐、排名、分配权重；是否捏造事实、动机或共识；是否重复已解决问题。当前运行时自动 Expander/Challenger/Generalist 上限 50 个英文词，Synthesiser 上限 55 个英文词，均最多三句；REQUESTED_GENERALIST 按独立请求策略审阅。

## 源码依据

- `server/src/prompts/source/runtime/specialist/assessor.md`：八因子和目标定义。
- `server/src/CognitiveOperations.mjs`：十种认知操作映射。
- `server/src/utils.js`：阈值、自我修正路由、优先级及临近截止规则。
- `server/src/CheckpointManager.mjs`：自动门控与 @ 请求绕过规则。
- `server/src/PlanPreflight.mjs`、`server/src/callbacks.js`：证据前提、重复目标及专家失败降级。
- `server/src/prompts/PromptRuntime.mjs`：当前长度上限。

执行状态：尚未运行真人、浏览器或真实模型测试；未部署或变更 Azure。
