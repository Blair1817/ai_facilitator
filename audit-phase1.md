# Phase 1 审计报告：行为契约冻结与架构冲突清单

> **范围**：仅 facilitation agent。
> **依据**：
> - `server/src/{callbacks.js, utils.js, ConditionRouting.mjs, LLMConfig.js, prompts/**, PolicyCompiler.js, SemanticAssessor.js, EvidenceChecker.js, feature_server.py}`
> - `client/src/components/{CustomChat.jsx, PlayerList.jsx}`
> - `System Design/Delibra_Agent_System_Architecture_A0_InformationUse_Revised.docx`
> - `.empirica/treatments.yaml`
> - `Literature/alsobay_bringing_2026_2026.pdf`（D.2 LLM Facilitator System Prompt，作为 Static AI prompt 来源）
>
> **不动的部分**：任务材料、HPTConfig.json、问卷、生命周期其它阶段（Break/TLX/ReviewQuiz 等）、Counterbalancing block、client 视觉设计。
>
> **本文是审计报告，不是实现。** Phase 2 才会开始改代码。
>
> **变更记录**：
> - v2（2026-08-10）：依据研究者答复，重新校准设计。Static AI ≠ Generalist：Static AI 走 Alsobay 原文 prompt（角色 `STATIC`），Generalist 走 Word §7 契约的适配版（角色 `GENERALIST`），作为 Adaptive 兜底"频率控制"。Q3 失败 checkpoint 不消耗机会。Q7 删除 ConditionRouting.mjs。Q8 不传 plan.gap。Q10 Round 切换不显示。详见 §6 / §7。
> - v3（2026-08-10，Phase 2 启动前最终版）：
>   - Q2 确认：Static AI 和 Adaptive AI 是**两个完全独立的 agent/系统**，严格不互通（不同 .md、不同 role 枚举值、不同 .env key、不同的 prompt）
>   - Q6 确认：Phase 5 完整实现（Validator LLM + repair loop + 一次 retry + specialist→generalist fallback + 每 checkpoint 最多一条）
>   - Q11 确认：校准方法 = **M**（Alsobay 281 个真实 transcript sequential replay，对照 Static vs Adaptive pipeline 行为）。注：研究者原 coder 标定任务因 coder 间一致性低（kappa 不可用）已弃用。
>   - **新约束**：feature/semantic 权重倒过来。当前 `weights = {feature: 0.6, semantic: 0.4}` 违反架构 §2 节点 4（"Features 仅作为 indicators，不直接等同于 deliberative need"）和 §7 评分公式设计本意。**Phase 4 改为 `{feature: 0.2, semantic: 0.8}`**——features 仍做 Candidate Gate 过滤（高召回），不再主导 Controller 评分。
>   - **安全问题**：`server/.env.example` 包含真实 API key（不是占位符），存在 OneDrive 同步泄露风险。建议立即轮换 key + 真实 key 写入 `server/.env`（已 gitignore）+ `.env.example` 改占位符。Phase 6 修。
>   - Q9 部分答：endpoint = `https://api.minimax.chat/v1`（`.env.example` 中的值；用户消息中说的 `.com` 与实际不一致，以 `.chat` 为准直到澄清）。API 格式仍是 OpenAI `/v1/responses` 风格，**直到 Phase 6 验证**。
>   - 准备进入 **Phase 2**：写新 `static.md` (Alsobay) + 新 `generalist.md` (Word §7) + `generation.schema.json` 加 `GENERALIST` + promptLoader 加 `getGeneralistPromptBundle()` + 启动 fail-fast + 测试。

---

## 0. 一句话结论

**当前实现违反了 Phase 1 全部 10 条核心契约中的 9 条**。最致命的两条是：

1. **Static 永远 SILENT**（`static.md` 是 skeleton，promptLoader 已正确 fail-closed）。意味着若今天就启动主实验，Static AI 条件组接收不到任何 AI 介入，跟一个隐藏的"no-AI"对照无法区分。
2. **Adaptive 把"Generalist fallback"错误实现成 ABSTAIN**（`utils.js#evaluateGate()` 只会返回 `act:true/false`，没有 Generalist 分支；top-two margin 不足 / 无角色达阈值 / 无角色过 hard gate 全部 → Abstain）。这违反 v2 设计"Adaptive 不清晰时使用 Generalist 频率控制"。

**v2 设计澄清**：Static AI（Alsobay 原文 prompt）和 Generalist（Word §7 适配版）是**两个不同 .md、两个不同 role 枚举值**。"matched"指的是**干预频率匹配**而不是 prompt 内容匹配——Generalist 在 Adaptive 里纯粹是为了不让 ABSTAIN 把介入频率拉得太低。

客户端 UI 又在错路径上读 condition（`game.get("treatment").facilitation`），加上 `treatments.yaml` 根本没定义 `facilitation` 因子，所以 `facilitation` 在客户端实际为 `undefined`，`@Facilitator` 是否在 mention 列表里只是巧合地跟当前测试场景一致。

---

## 1. 行为矩阵：当前实现 vs 目标

| | 条件 | Specialist 清晰 | Specialist 不清晰 | 操作失败 | 公开契约是否一致 |
|---|---|---|---|---|---|
| **目标（v2）** | Static AI | Static AI (Alsobay) | Static AI (Alsobay) | Abstain | ✅ |
| **目标（v2）** | Adaptive | Specialist | Generalist (adapted) | Abstain | ✅ |
| **当前** | Static | **SILENT**（prompt 缺，被 promptLoader 拦截） | **SILENT** | **SILENT**（与失败状态不可区分） | ❌ |
| **当前** | Adaptive | Specialist（仅当 ≥1 个角色同时过 hard gate、threshold、top-two margin） | **ABSTAIN**（与目标 Generalist 不符） | ABSTAIN | ❌ |

> 关键差异：
> - Static AI 列"清晰/不清晰/失败"三个分支在当前实现里**全坍缩成 SILENT**（缺 Alsobay prompt）；
> - Adaptive "不清晰"分支在当前实现里**坍缩成 ABSTAIN**，而不是 Generalist；
> - 当前实现里没有"Generalist"动作路径——schema/loader/log 里都没有这个角色名（v2 设计需要新增）。

---

## 2. 逐条契约审计

### 契约 1：所有条件每新增 6 条 participant messages 获得一次相同 checkpoint

| 项 | 状态 |
|---|---|
| 当前行为 | `callbacks.js#handleChat()` 第 591 行 `if (messagesSince < 6) return;` —— Static 和 Adaptive 共用同一个 6 条计数 |
| 涉及文件 | `server/src/callbacks.js` |
| 评估 | ✅ **满足**（计数共享）。**v2 决策**（Q3 答）：**失败的 checkpoint 不消耗机会**。当前 `messagesSinceLastIntervention` 在每次发消息成功**或**失败后都重置（callbacks.js:602 紧跟 dedup check），违反 v2 决策。需要在 Phase 3 改：只有 `outcome === "PUBLISHED"` 才重置。`attemptedThisRound` / `publishedThisRound` 分开计 |
| 建议修改 | Phase 3：① reset 移到 publish 之后；② 加 `attemptedThisRound` 和 `publishedThisRound` 两个独立计数；③ 失败不消耗"机会"但消耗"尝试"；④ 防无限重试需要 interventionCapPerRound |
| 研究者待确认 | ✅ Q3 已答：失败不消耗机会 |

### 契约 2：Static AI 在合法 checkpoint 必须尝试发送 Static AI 消息

| 项 | 状态 |
|---|---|
| 当前行为 | Static 分支 `callbacks.js:631-654` 的确**总是**调用 `buildGeneratorContext("static", null, null)` 然后 `runSharedGeneration()`——**意图正确**。但 promptLoader 在 `getStaticPromptBundle()` 中检测到 `static.md` 仍有 4 个 `[[ TODO ]]` 块以及"skeelton only / content pending"标记，**直接返回 `blocked: true`**，导致 `runSharedGeneration` 在 `built.blocked` 早退，**outcome = "SILENT"** |
| 涉及文件 | `server/src/prompts/source/static.md`、`server/src/prompts/promptLoader.js:127-163`、`server/src/callbacks.js:631-654` |
| 建议修改 | **v2 决策**（Q1 答）：Static 走 Alsobay 原文 prompt（Literature/alsobay_bringing_2026_2026.pdf D.2 节），删 RATIONALE 适配 schema。Phase 2 必须：(a) `static.md` 删除所有 `[[ TODO ]]`/skeleton 标记并填入 Alsobay 原文（task 描述参数化以适配 Task A / Task B）；(b) promptLoader 在不通过时**启动阶段 fail-fast**，而不是运行中静默 |
| 实验内效度影响 | **严重**。如果用现在的代码做主实验，Static AI 条件组在 Task 阶段一条 facilitator 消息都收不到，跟"无 AI"对照混淆 |
| 研究者待确认 | ✅ Q1 已答：Static AI = Alsobay 原文 prompt（删 RATIONALE 适配 schema） |

### 契约 3：Adaptive 决策分支（Specialist / Generalist / Abstain）

| 项 | 状态 |
|---|---|
| 当前行为 | `utils.js#evaluateGate()`（utils.js:340-403）只返回 `{act: true/false, reason, scores, eligibleRoles, hardGatedRoles}`。**没有"Generalist"分支**。所有 `act: false` 的路径——time floor、no hard gate、no score ≥ threshold、top-two margin 过小——都通过 `callbacks.js:757-762` `if (!gateResult.act) return;` 直接写日志后返回 |
| 涉及文件 | `server/src/utils.js`、`server/src/callbacks.js:734-762` |
| 建议修改 | **重大**。Phase 4 必须把 `evaluateGate` 的返回类型改成 `{act: 'specialist' | 'generalist' | 'abstain', ...}`，并把以下情况映射到 `'generalist'`：<br>① top-two margin 过小（utils.js:383-394）；<br>② 没有角色过 threshold（utils.js:372-380）；<br>③ 没有角色过 hard gate（utils.js:354-364）<br>只在以下情况映射到 `'abstain'`：<br>① `remainingTime < min_time_for_intervention_seconds`（utils.js:343-351）；<br>② system failure（feature server 不可用、Assessor 返回非 success）；<br>③ cooldown / 介入上限 / 阶段非 Task（当前缺这些 check，需要 Phase 3 补） |
| 实验内效度影响 | **致命**。v2 设计明确"Adaptive 不清晰时使用 Generalist 频率控制"——但当前实现中"不清晰"变成了"不介入"。这等于把"Specialist vs Generalist"的实验变成了"Specialist vs no-AI" |
| 研究者待确认 | ① ✅ Q1 已答：Generalist ≠ Static AI，是 Adaptive 内的"频率控制"分支<br>② ✅ Q5 待答：Controller 阈值需要校准到"可用状态"（不只是占位）<br>③ ✅ Q11 待答：无 pilot 数据，需要替代校准方法 |

### 契约 4（v2 重写）：Static AI 和 Generalist 是两个不同实验条件、两个不同 .md、两个不同 role 枚举值

| 项 | 状态 |
|---|---|
| 当前行为 | **完全不成立**——Static 走 `getStaticPromptBundle()` (base.md + skeleton static.md)；Adaptive 一旦 gate act:false 直接 ABSTAIN，没有任何"Generalist"路径存在 |
| 涉及文件 | 同契约 2/3 |
| **v2 决策** | **Static AI 和 Generalist 不是同一个 prompt**。两条理由：<br>① Static 是 Alsobay 复刻，prompt 必须跟原文一致；<br>② Generalist 是 Adaptive 兜底，prompt 必须适配我们的 schema 和 Word §7 契约（不能要 RATIONALE 字段、不能要 scoreboard 类主动 steering） |
| 新契约 4 内容 | Static 条件 → `STATIC` role → `static.md` (Alsobay 原文，删 RATIONALE + 参数化 task 描述)<br>Adaptive-fallback → `GENERALIST` role → `generalist.md` (Word §7 契约 + 适配 schema)<br>两者**必须共享**：`base.md`、模型参数、context 格式、Validator、发布函数<br>"matched"指的是**干预频率匹配**（不消耗机会，cap、cooldown 一致），不是 prompt 内容匹配 |
| 涉及文件 (v2) | `prompts/source/static.md`（重写）、`prompts/source/generalist.md`（新建）、`prompts/source/generation.schema.json`（enum 加 `STATIC` 和 `GENERALIST`）、`prompts/source/promptLoader.js`（新增 `getGeneralistPromptBundle()`）|
| 研究者待确认 | ✅ Q1 已答：Static ≠ Generalist，v2 设计如上 |
| 建议修改 | Phase 2/4 必须：① 提取 `getGeneralistPromptBundle()` 作为唯一来源；② 写测试：getStaticPromptBundle() 的 `content` 字符串 === getGeneralistPromptBundle() 的 `content` 字符串（字符级别） |
| 实验内效度影响 | **致命**——这是"Matched Generalist"这个条件名字的核心，否则两个条件就不可比 |
| 研究者待确认 | 是否允许 Static / Adaptive-fallback 在选择 bundle 时**允许**共享 `relevantDiscussionState` 字段（PolicyCompiler.plan.gap）？若允许，Adaptive 的 Generalist 会"知道"一次评估的结果，Static 不会——会影响对照等价性 |

### 契约 5：两种条件必须共享 Generator、模型参数、公开上下文、Validator 和发布函数

| 项 | 状态 |
|---|---|
| 当前行为 | ✅ **基本满足**。`buildGeneratorContext()` / `runSharedGeneration()` / `postGeneratorResultIfValid()` 都是 Static 和 Adaptive 共用同一个函数；同一个 `getLLMResponse`（同一 `openaiModel`、`llmAPIEndpoint`、`llmMaxOutputTokens`）；同一个 `validation.schema.json` 校验 schema（虽然 live path 不调用它，只跑 `runDeterministicValidation`）。`base.md` 也共用 |
| 涉及文件 | `server/src/callbacks.js:132-238`、`server/src/prompts/GeneratorContract.mjs` |
| 评估 | ✅。**v2 决策**（Q1 答）：`generation.schema.json` 的 `role` enum 最终用 `["STATIC", "GENERALIST", "INFORMATION_EXPANDER", "EVIDENCE_CHALLENGER", "INFORMATION_SYNTHESISER"]` 五个值——`STATIC` 是 Static AI facilitator 专用，`GENERALIST` + 三个 Specialist 是 Adaptive AI facilitator 专用 |
| 建议修改 | Phase 2 一开始就**先**决定 schema 枚举（v2 已是 `STATIC` + `GENERALIST` + 3 Specialist），然后全文统一：`generation.schema.json` / `promptLoader.metadata.generationRole` / `postGeneratorResultIfValid` 的 `expectedRole` 比较 / 日志 / 测试，任何一处混用都立刻报错 |
| 研究者待确认 | ✅ Q1 已答：enum = `STATIC / GENERALIST / INFORMATION_EXPANDER / EVIDENCE_CHALLENGER / INFORMATION_SYNTHESISER` |

### 契约 6：Specialist 只能是 expander、challenger、synthesiser

| 项 | 状态 |
|---|---|
| 当前行为 | `utils.js:65` `export const ROLES = ["expander", "challenger", "synthesiser"]`；`utils.js:72` `ROLE_PRIORITY = ["challenger", "synthesiser", "expander"]`（与 Spec §7 一致：Scrutiny > Integration > Expansion）。`promptLoader.js:88-92` 的 `ADAPTIVE_ROLE_FILES` 也只列这三个。schema `generation.schema.json` 枚举是 `INFORMATION_EXPANDER / EVIDENCE_CHALLENGER / INFORMATION_SYNTHESISER` |
| 涉及文件 | `server/src/utils.js`、`server/src/prompts/promptLoader.js`、`server/src/prompts/source/generation.schema.json` |
| 评估 | ✅ **满足**。v2 决策后 `ROLES` 仍为 3 个 Specialist（不变）。`GENERALIST` 不在 `ROLES` 里——它是 Adaptive 的"非 Specialist"分支，promptLoader 单独处理，不走 Controller 的 specialist 选择 |
| 建议修改 | Phase 2 添加测试：`getCandidateRoles(features)` 对任何 `features` 输入，返回值 ⊆ `["expander", "challenger", "synthesiser"]`；`generation.schema.json` enum 与 utils ROLES 一一对应（`STATIC` 和 `GENERALIST` 是两个 facilitator 的不同 mode，不在 `ROLES` 里）；promptLoader 的 `ADAPTIVE_ROLE_FILES` 键集合 === utils ROLES |
| 研究者待确认 | 无 |

### 契约 7：Generalist 不是第四个 specialist role

| 项 | 状态 |
|---|---|
| 当前行为 | v2 设计下 `generation.schema.json` 的 `role` enum 五个值：`STATIC` / `GENERALIST` / `INFORMATION_EXPANDER` / `EVIDENCE_CHALLENGER` / `INFORMATION_SYNTHESISER`。**Generalist 明确不是 Specialist**——它跟 `STATIC` 一样由 promptLoader 单独处理（在 Adaptive 路径下作为"频率控制"分支），不走 Controller 的 specialist scoring |
| 涉及文件 | `server/src/prompts/source/generation.schema.json`、`server/src/prompts/promptLoader.js` |
| 评估 | ✅ **v2 满足**。`GENERALIST` 是 Adaptive facilitator 的"control mode"（不是 Specialist）；`STATIC` 是 Static facilitator 的"only mode"。两个 facilitator 各自有独立的 .md（`static.md` vs `generalist.md`），promptLoader 各自 bundle |
| 建议修改 | Phase 2 加测试：① `getStaticPromptBundle()` → `role: STATIC`；② `getGeneralistPromptBundle()` → `role: GENERALIST`；③ `getAdaptivePromptBundle("generalist")` 也走 `generalist.md`（不是 `STATIC`）；④ Specialist 路径不会返回 `GENERALIST` |
| 研究者待确认 | ✅ Q1 已答 |

### 契约 8：Generator 不得决定 WAIT/ACT、条件或角色

| 项 | 状态 |
|---|---|
| 当前行为 | ✅ `base.md` 第 14-19 行明确："`SELECTED_ROLE` is fixed by the Controller. Do not calculate features, apply thresholds, diagnose the discussion, evaluate role eligibility, select another role, or reconsider the assigned role. Do not disclose features, thresholds, assessment results, Controller reasoning, or why this intervention was requested." |
| 涉及文件 | `server/src/prompts/source/base.md` |
| 评估 | ✅ **满足**。 |
| 建议修改 | 无 |
| 研究者待确认 | 无 |

### 契约 9：任何无效输出 fail closed，不得发布未验证消息

| 项 | 状态 |
|---|---|
| 当前行为 | `callbacks.js#runSharedGeneration()` 第 175-232 行有完整 fail-closed 链路：blocked → SILENT；stale → SILENT；API 错误 → SILENT；JSON 解析失败 → SILENT；schema 校验失败 → SILENT；确定性校验失败 → SILENT；最后才 publish。`postGeneratorResultIfValid` 还有最后一道防 line |
| 涉及文件 | `server/src/callbacks.js:172-238`、`server/src/callbacks.js:539-556` |
| 评估 | ✅ **满足**。但 `postGeneratorResultIfValid` **没有**检查"修复后内容"——Phase 5 引入 repair loop 时要小心：不能 publish 任何未通过最终 Validator 的候选 |
| 建议修改 | Phase 5 在引入 repair 时再次检查 |
| 研究者待确认 | 无 |

### 契约 10：不得向 LLM 发送私人报告、正确答案、参与者身份信息或隐藏资料

| 项 | 状态 |
|---|---|
| 当前行为 | `DynamicContext.mjs#buildDynamicUserContext()` 第 41-49 行注释 + 行为都明确：只读 `chat`（公开 + AI）；AI 消息只通过 `recentAiMessageTexts` 暴露以避免重复；不读 `player.round.playerContent`（private profile）、不读正确答案。`base.md` 也明文禁止 |
| 涉及文件 | `server/src/prompts/DynamicContext.mjs`、`server/src/prompts/source/base.md` |
| 评估 | ✅ **满足**。 |
| 建议修改 | 无 |
| 研究者待确认 | 无。但 Phase 7 端到端测试时**必须**包含一个"私有信息泄露检测"用例 |

---

## 3. 特别检查项

### 3.1 Adaptive 把 Generalist fallback 错误实现为 ABSTAIN

**结论**：确认。`utils.js#evaluateGate()` 只会返回 `act: true/false`，没有 Generalist 分支。
**修法**：见契约 3 建议。Phase 4 主任务。

### 3.2 Static prompt 是 skeleton，导致永远 SILENT

**结论**：确认。`static.md` 第 8 行自标 "Status: skeleton only"，并含 4 个 `[[ TODO ]]` 块；`promptLoader.getStaticPromptBundle()` 第 150-156 行 `if (incomplete.length > 0) return { blocked: true, ... }`——正确 fail-closed。
**修法**：Phase 2 主任务。

### 3.3 ConditionRouting.mjs 与 live callbacks 状态矛盾

**结论**：确认。`ConditionRouting.mjs#INTERVENTION_HANDLER_IMPLEMENTED` 把 static/adaptive 都标 `false`，`resolveFacilitationDispatch()` 任何 `facilitation` ∈ {static, adaptive} 都返回 `eligible: false`。但 `grep` 显示 `callbacks.js` **从未** import 这个模块——所以 `ConditionRouting.mjs` 是**纯死代码**，跟 live path 没有冲突，因为它根本不参与 live path。问题在于它存在并误导后续读代码的人。
**修法**：Phase 6 二选一：① 删除整个文件；② 让 callbacks.js 真的用它（更统一但需要审慎改 dispatch 逻辑）。
**研究者待确认**：二选一倾向。

### 3.4 客户端是否还错误读取 `treatment.facilitation` 而不是 `round.facilitation`

**结论**：确认。`CustomChat.jsx:208` `const { facilitation } = game.get("treatment");` 和 `PlayerList.jsx:9` 同一行。但 `treatments.yaml` 实际**没有** `facilitation` 因子（只有 playerCount / gameDuration / phase1Duration / introDuration / hiddenInfoCue）。`game.addRound({ facilitation: ... })` 把 facilitation 写到 **round** 而不是 treatment。

所以 client 拿到的 `facilitation` 是 `undefined`。`if (facilitation != "none" && facilitation != "human")` 比较 `undefined != "none"` 为 `true`——`@Facilitator` 总是出现在 mention 列表、`Facilitator` 总是出现在 PlayerList。这恰好"看起来对"，但**条件**是错的。**Round 1 是 Static vs Adaptive** 这一信息对客户端不可见，UI 上无法区分。

**修法**：Phase 6。`useRound()` 替换 `useGame().get("treatment")`：`const { facilitation } = useRound().get("facilitation")`。
**研究者待确认**：✅ Q10 已答：Round 切换不显示 UI 提示。

### 3.5 @Facilitator 是否真的有明确语义

**结论**：**v2 决策**（Q8 已答）——@Facilitator 触发**即时回应（mention checkpoint）**。当前实现**完全没有** mention 处理，`callbacks.js` 把所有 mention 消息按 6 条 checkpoint 的 1 条处理。

**修法**：Phase 6。需要：
- 在 `handleChat`（或新 handler）里检测 `lastMessage.text` 含 `@[Facilitator]`
- 触发独立 mention checkpoint，不等 6 条
- mention checkpoint 走跟常规 checkpoint **同一套 condition 逻辑**（Static 走 STATIC prompt；Adaptive 走 specialist/generalist/abstain）
- **机会匹配**：mention 计数在两种 condition 下都要被记录；同一轮同一 facilitator 的 mention cooldown；mention 触发后**不计**进 6 条计数
- UI 上提示参与者 "@Facilitator 会即时回应"（Q10 决策不影响这个——Q10 是 Round 切换提示，不是 mention 提示）
**研究者待确认**：✅ Q8 已答：即时回应 | ⏳ mention cooldown 数值待 Phase 3 与 Q6 一起定。

---

## 4. 其它发现（非 Phase 1 契约，但相关）

### 4.1 模型版本未冻结

`callbacks.js:16` `const openaiModel = process.env.OPENAI_MODEL || "gpt-4o";` —— `gpt-4o` 是 alias，会随 OpenAI 滚动更新指向新 snapshot。Word §10 要求"模型版本冻结"。

**Phase 6 修法**：env 默认值改具体 snapshot（如 `gpt-4o-2024-08-06`）并写进 `systemInfo`。
**研究者待确认**：⏳ Q9 部分已答（先跑通 minimax API，模型之后改），具体 API 配置和 endpoint 待 Q9 澄清。

### 4.2 无 `OPENAI_API_KEY` fail-fast

`callbacks.js:34` `Authorization: Bearer ${process.env.OPENAI_API_KEY}` —— 若 key 缺失，fetch 会发送 `Bearer undefined` 然后 401，但实验已经启动。Phase 6 修法：`onGameStart` / `onRoundStart` 启动时校验 `process.env.OPENAI_API_KEY`，缺失则 throw。

### 4.3 Feature server 在 LLM 决策中权重低且无 Generalist 路径

`utils.js#computeRoleScore()` 使用 `THRESHOLDS.weights = {feature: 0.6, semantic: 0.4, persistence: 0, stage_fit: 0, penalty: 0}`——`persistence` 和 `stage_fit` 永远为 0。
- `computeStageFit()` 永远返回 0（utils.js:305-307），因为 `feature_server.py` **没有** `discussion_stage` signal。
- `feature_server.py` 只返回 5 个 feature（gini/novelty/redundancy/agreement/justification），**缺**架构文档 §2 要求的：`option/criterion coverage`、`contribution distribution`、`evidence-to-claim linkage`、`cross-option comparison coverage`、`unresolved counterevidence`、`discussion stage`、`prior reasoning uptake`。
- Word §2 节点 4 还要求"缺失 feature 标记 unavailable，不用默认值伪造完整状态"——当前 `extractFeatures` 失败时直接 return，行为对；但**成功时**也用 `0` 当默认值（feature_server 在空 messages 时返 0.0，gini 0、novelty 1.0、agreement 0、justification 0），这是合规的（只是表征"无消息"），但容易误读为"零信号"。

**Phase 3 修法**：扩展 feature_server + 删/重写 Gini（已不参与角色决策，仅作 diagnostic-only 或删除）。
**研究者待确认**：⏳ Q5 部分已答（Controller 要校准到"可用状态"），feature_server 扩展范围待 Q11 答完后定。

### 4.4 role 枚举名跨文件不一致

**v2 决策**（Q1 答）——五个枚举值确定：
| 文件 | 角色名 |
|---|---|
| `utils.js` `ROLES` | `expander` / `challenger` / `synthesiser`（小写，3 Specialist） |
| `promptLoader.ADAPTIVE_ROLE_FILES` | `expander` / `challenger` / `synthesiser` |
| `promptLoader.getGeneralistPromptBundle()` | **新增** `generalist` |
| `promptLoader.getStaticPromptBundle()` | **新增** `static` |
| `generation.schema.json` enum | `STATIC` / `GENERALIST` / `INFORMATION_EXPANDER` / `EVIDENCE_CHALLENGER` / `INFORMATION_SYNTHESISER` |

utils 内部 lowercase 字符串作为 Controller 内部 key；promptLoader 映射到 schema enum 的大写常量；`STATIC` 和 `GENERALIST` 各自独立，不在 `ROLES`（Specialist 集合）里。

### 4.5 缺少 `relevantDiscussionState` 字段

`PROMPT_MODULE_STATUS.md:44` 明确：`RELEVANT_DISCUSSION_STATE` 在 prompt_design_specification 里被列但**从未被发送**给 LLM。`DynamicContext.mjs:78` 现在 `relevantDiscussionState: plan ? plan.gap : undefined`——仅 Adaptive-Specialist 路径下有值。

**v2 决策**（Q8 答）：Generalist 不接收 `plan.gap` 也不接收 `plan.evidenceIds`——Generalist 跟 Static AI 看到的世界完全一样。"matched"指频率不指信息边界。Phase 4 实现时，Generalist 路径下不传 `plan` 参数给 `buildDynamicUserContext()`。

### 4.6 缺少 Validator LLM

`validatorPlaceholder.js` 第 12-19 行明确：live path **不**调用任何 Validator LLM，只有 `runDeterministicValidation()`。

**v2 决策**（Q6 部分答）：按正式实验要求准备——见 §6 Q6 待澄清。架构文档 §5 节点 11 写 "rules checks + optional independent semantic validator LLM"。Phase 5 修法：包含 Validator LLM 接入 + repair loop（具体范围待 Q6 澄清）。

### 4.7 缺少修复/再生成 loop

`regenerationPlaceholder.js` 注释明确 live path **只有一次** Generator 尝试。架构文档 §5 节点 11 写 "失败后确定性修复，最多 regenerate 一次"。

**v2 决策**（Q6 部分答）：按正式实验要求准备，Phase 5 引入：① 确定性修复优先；② 最多 regenerate 一次；③ Specialist 修复失败可降级到 Generalist；④ Generalist 再失败则 ABSTAIN；⑤ 一个 checkpoint 最多发布一条消息。具体细节待 Q6 澄清。

### 4.8 干预上限不存在

`callbacks.js` 没有"per-round 介入上限"。架构文档 §2 节点 2 写"cooldown、介入上限达到或剩余时间不足时跳过"——当前实现既无 cooldown 也无 cap。
- `messagesSinceLastIntervention` 在每次 handleChat 计数后立即重置（无论成功失败），但**没有**独立 cooldown timer。
- 没有 `round.get("interventionsThisRound")` 这种计数。

**v2 决策**（Q4 答）：Phase 3 加入 `interventionCapPerRound=3` + `cooldownMs=30000` + `min_time_for_intervention_seconds=10`，并配套测试。失败的 checkpoint 不消耗"机会"但消耗"尝试"（Q3）。

### 4.9 checkpoint stale protection 仅在两处

`callbacks.js:189-197`（Generator 后）、`callbacks.js:669-678`（Feature 后）、`callbacks.js:710-718`（Assessor 后）—— 三处都有 stale check。✅ 满足。

### 4.10 AI 消息不计数

`callbacks.js:576-578`：`if (lastMessage.sender.id === "ai") return;` —— 每次 handleChat 触发时如果最后一条是 AI 消息就早退。`humanMessageCount` 是在这个检查之后才 `++`（callbacks.js:585），所以 AI 消息确实不计数。✅ 满足。

### 4.11 checkpoint 去重

`callbacks.js:600-601`：`if (currentRound.get("lastHandledCheckpoint") === humanMessageCount) return; currentRound.set("lastHandledCheckpoint", humanMessageCount);` ✅ 满足。

### 4.12 Stage 必须是 Task

`callbacks.js:580-581`：`if (currentStageName !== "Task") return;` ✅ 满足。

### 4.13 失败 checkpoint 是否消耗机会

`callbacks.js:600-602` 在判断去重后**立即** `game.set("messagesSinceLastIntervention", 0)`，无论后续 LLM 是 PUBLISHED 还是 SILENT。意味着：
- ✅ 失败（blocked/ABSTAIN/API error/stale/parse/schema/deterministic 失败）都消耗机会
- ✅ 两种条件都这样

✅ 满足"两种条件一致"。但**消耗机会的语义**是不是研究者想要的——如果想要"失败的 checkpoint 不消耗机会，机会给下一轮"，则需改。

**研究者待确认**：契约 1 注 + 4.13 同问题：失败是否消耗机会？

### 4.14 Gini / facilitator-role 仍存在但已不参与决策

`feature_server.py` 仍计算 `gini_score` 并返回；`utils.js:171-177` `computeGini()` 工具函数保留（仅供测试）；utils.js 注释明确 facilitator 角色已移除。✅ 满足"明确标记为 diagnostic-only"。

**Phase 3 修法**：feature_server 可以删 `gini_score` 字段；utils.js 的 `computeGini` 标注 diagnostic-only。

### 4.15 评估日志完整

`callbacks.js#handleChat()` 构造的 `logEntry` 已记录：timestamp、roundIndex、facilitation、humanMessageCount、messagesSinceLastIntervention、remainingTime、timeElapsed、requestMade、requestSuccess、messageAdded、outcome、model、reason、routingDecision（Static 路径）、featureLatency、featureScores、candidateRoles、rawFactors、checkedFactors、gateDecision、gateReason、eligibleRoles、stateScores、assessorError、selectedRole、forced、reasoning、plan、promptMetadata、schemaErrors、deterministic、llmAction、messagesOAIFormat。

✅ 满足 §6 节点 13 Logging & Tracing 的大部分要求。缺：
- 修复/回退过程（因为没有 repair）
- 后续 uptake（架构 §6 节点 12 提到，但需要 Round 之外的状态机跟踪——可能超出 Phase 1 范围）

### 4.16 Stage name 比较

`callbacks.js:581` 用 `currentStageName !== "Task"`，但 `game.currentStage?.get("name") !== "Task"`（callbacks.js:192/672/714）—— 两种写法并存但等价。✅ 一致。

### 4.17 build pipeline

`package.json` `build` 脚本是 rsync（不带 js/mjs 文件）然后 esbuild 打包 index.js。**问题**：rsync 排除 `*.js` 和 `*.mjs` 意味着 `dist/` 里**没有** .js 源文件副本，但 esbuild 把 `src/index.js` 整体 bundle 成 `dist/index.js`。然后 `promptLoader.js` 假设 `process.argv[1] = dist/index.js`，从 `dist/prompts/source/` 读 .md 文件。

**rsync 的 `--exclude=*.js --exclude=*.mjs` 实际**只**排除了源码 .js/.mjs 副本。`--exclude=*.js` + `src/*` 会 rsync 出：.json, .toml, .yaml, .py, .md 子目录等。看当前 src 树没有 .toml/.yaml，所以 prompt source 应该会 rsync 过去。**但是**——我应该**真的构建**一次并检查 dist/prompts/source/ 是否齐全。这是 Phase 2 任务，**现在标记为待验证**。

### 4.18 tests 与 node:test 不兼容

`package.json` 没声明 `test` script。当前仓库里有大量 `.test.mjs` 文件（utils.test.mjs、prompts/*.test.mjs 等）。PROMPT_MODULE_STATUS 注释说 "node:test runner"，但**没**看到 `node --test` 的 npm script——需要 Phase 6 确认能否跑。

### 4.19 没有 @Facilitator mention 的服务端处理

见 §3.5。

### 4.20 没有 startup self-check

`onGameStart` 不验证：API key、feature server 可用、prompt bundle 完整可加载、prompt bundle 是否有 skeleton 标记。Phase 6 修法。

---

## 5. 阻塞 / 风险汇总（v2 更新）

| 等级 | 阻塞 | 影响 | v2 状态 |
|---|---|---|---|
| 🔴 P0 | `static.md` 是 skeleton → Static AI 永远 SILENT | 主实验 Static AI 条件不可用 | Phase 2 用 Alsobay 原文重写 |
| 🔴 P0 | Adaptive 无 Generalist fallback → 所有"不清晰"路径都 ABSTAIN | 违反 v2 设计"频率控制" | Phase 4 新增 generalist.md + evaluateGate 改三态 |
| 🔴 P0 | OPENAI_API_KEY 未 fail-fast | 实验中后期才发现，浪费配额 + 数据不可用 | Phase 6 修 |
| 🔴 P0 | Controller 阈值是占位 (margin=0.05, weights 不平衡) | Adaptive 决策可能不稳定 | ✅ Q5 已答要校准；Phase 4 做（待 Q11 校准方法答） |
| 🟠 P1 | 客户端读 `treatment.facilitation`（永远 undefined） | UI 与服务端实际 facilitation 不同步，ParticipantList/Mention 行为巧合"对" | Phase 6 修 |
| 🟠 P1 | role 枚举名跨文件不一致 | v2 决策已定（5 值），需要 Phase 2 全文统一 | Phase 2 同步改 |
| 🟠 P1 | @Facilitator 无明确语义 | ✅ Q8 已答：即时回应；Phase 6 加 mention checkpoint 路径 | 待 Phase 6 实现 |
| 🟠 P1 | 无 Validator LLM（live path） | ✅ Q6 部分答：按正式实验要求；Phase 5 加 | 待 Q6 范围澄清 |
| 🟠 P1 | 无 repair / retry loop | ✅ Q6 部分答：按正式实验要求；Phase 5 加 | 待 Q6 范围澄清 |
| 🟡 P2 | 无 cooldown / 介入上限 | ✅ Q4 答：cap=3, cooldown=30s；Phase 3 加 | Phase 3 实现 |
| 🟡 P2 | `gpt-4o` alias 未冻结 snapshot | ⏳ Q9 答：先用 minimax API 跑通，之后改模型；Phase 6 改 | 待 Q9 澄清 |
| 🟡 P2 | feature_server 缺 6/7 个 feature signal | Word §2 节点 4 描述能力不足 | Phase 3 扩展（范围待 Q11 答） |
| 🟡 P2 | Gini 仍计算但只 diagnostic | 性能/可读性 | Phase 3 改 diagnostic-only 或删 |
| 🟡 P2 | 旧的 `ConditionRouting.mjs` 死代码 | ✅ Q7 答：删 | Phase 6 删 |
| 🟡 P2 | tests 无统一 runner script | Phase 6 修 | Phase 6 修 |
| 🟡 P2 | 失败 checkpoint 消耗机会 | ✅ Q3 答：不消耗；Phase 3 改 | Phase 3 实现 |

---

## 6. 研究者确认状态（v2 更新）

| # | 问题 | 涉及契约 | 状态 |
|---|---|---|---|
| Q1 | Static AI 和 Generalist 的具体 prompt 文字 | 2, 4 | ✅ **已答**（v2）：Static AI = Alsobay D.2 原文（删 RATIONALE）；Generalist = Word §7 适配版 |
| Q2 | `generation.schema.json` 的 role enum 命名 | 4, 5, 7 | ✅ **已答**（v2）：`STATIC / GENERALIST / INFORMATION_EXPANDER / EVIDENCE_CHALLENGER / INFORMATION_SYNTHESISER` |
| Q3 | 失败的 checkpoint 是否消耗机会？ | 1, 4.13 | ✅ **已答**：不消耗（仅消耗"尝试"，有 cap 限制） |
| Q4 | `top-two margin` / `min_time` / cap / cooldown 数值 | 3, 4.8 | ✅ **已答**（用建议默认）：margin=0.05 占位待校准；min_time=10s；cap=3；cooldown=30s |
| Q5 | Controller 阈值是否要校准 | 3, 4.3 | ✅ **已答**：要，至少到可用状态。具体校准方法 ⏳ Q11 待答 |
| Q6 | Validator LLM + repair loop 启用？ | 4.6, 4.7 | ⏳ **待澄清**：你说"按照正式实验要求准备，这个直接会上线正式实验平台"——是 enable Validator LLM + 一次 retry 的全套？还是只 enable repair 不调 LLM 的 Validator？ |
| Q7 | `ConditionRouting.mjs` 删还是接？ | 3.3 | ✅ **已答**：删 |
| Q8 | @Facilitator 语义 | 3.5 | ✅ **已答**：即时回应；Phase 6 实现 mention checkpoint |
| Q9 | 模型/API 选型 | 4.1 | ⏳ **待澄清**：你说"用 minimax API 跑通"——minimax API 的 endpoint、auth 方式、response 格式是什么？跟当前 OpenAI 调用方式有差异（chat completions vs responses）需要适配 |
| Q10 | Round 切换 UI 提示 | 3.4 | ✅ **已答**：不显示 |
| Q11 | 没有 pilot 怎么校准 | 5（Q5 关联） | ⏳ **待答**：候选方案见 §8 |
| Q12 | Adaptive-fallback 是否带 `plan.gap`？ | 4.5 | ✅ **已答**：不带。Generalist 跟 Static AI 看到的世界完全一样 |

---

## 7. Phase 2–7 进入条件

按 Phase 1 prompt 的要求，本审计**不进入下一阶段**。但要标记进入条件：

- ✅ **Q1（Static AI / Generalist 文字）已答**，可以进 Phase 2 重写 `static.md` + 新建 `generalist.md`。
- ⏳ Q6（Validator / repair 范围）需要澄清，否则 Phase 5 没法动手。
- ⏳ Q9（API 选型）需要澄清，否则 Phase 6 没法做 fail-fast 和版本冻结。
- ⏳ Q11（校准方法）需要澄清，否则 Phase 4 Controller 校准没法做。
- Q4 数值已确认（占位也行），Phase 3 可以开始。

---

## 8. Q11 校准方法候选（无 pilot 数据下）

由于你提到没有 pilot，Controller 阈值无法通过传统 pilot 校准。可选方案：

**方案 A：Synthetic minimal-pair replay（推荐）**
- 用 Alsobay 论文附录提供的 30 个 fact + 5 个信息集，自己构造 50–100 段合成讨论 transcript
- 每段针对一个目标 factor（比如"高 agreement + 低 justification" → 应该 challenger；"高 novelty 低 coverage" → 应该 expander；"证据分散" → 应该 synthesiser）
- 把这些 transcript 喂给 feature_server + Assessor + Controller，记录每次决策
- 手动验证决策是否符合预期；如果不符合，调阈值/权重
- 优点：不需要真实参与者，不需要 pilot；缺点：synthetic 数据可能不反映真实讨论模式

**方案 B：Alsobay 真实 transcript sequential replay**
- 复用 Alsobay 281 个 group 的真实 transcript（osfstorage-archive/data/transcripts_readable.txt）
- 按原始消息顺序**重放**进我们的 pipeline（不调 LLM，用 mock 评估），记录 Controller 决策
- 优势：真实讨论模式；缺点：Alsobay 是 Static 条件，没有 Specialist 的 ground truth

**方案 C：Research-team expert review**
- 准备 20–30 个典型讨论场景（书面描述）
- 由研究团队（包括你）逐一判断：当前讨论状态对应哪个 specialist？如果不确定，应走 generalist？
- 把这些判断作为 ground truth，调阈值让 Controller 输出一致
- 优点：研究团队的主观判断就是 ground truth；缺点：样本小，inter-rater reliability 未知

**方案 D：A + C 组合（推荐）**
- 先用方案 C 定 ground truth（20-30 个）
- 再用方案 A 扩展测试集（50-100 个）
- 双向验证 + 阈值调优

**建议**：方案 D。

研究者答复时只需选一个（或组合），以及：
- ground truth 来源（research team / 已有 Alsobay 标注 / 都用）
- 目标精度（≥80% 一致 / ≥90% / 不量化先看趋势）

---

## 9. 我建议的下一步（v2 更新）

1. **等你答 Q6、Q9、Q11** —— 这三个不答我没法真正动手。
2. 答完之后我按这个顺序推进：
   - **Phase 2**：重写 `static.md`（Alsobay 原文删 RATIONALE + 参数化 task 描述）+ 新建 `generalist.md`（Word §7 适配版）+ 修 `generation.schema.json` enum + 修 `promptLoader.js` 加 `getGeneralistPromptBundle()` + 加 fail-fast 启动检查
   - **Phase 3**：Checkpoint manager（cap=3, cooldown=30s, 失败不消耗机会）+ AgentState 结构化 + 扩展 feature_server
   - **Phase 4**（Q11 答后做）：Assess/Check/Controller 三态 + Q5 校准（用方案 D）+ 移除 `persistence/stage_fit/penalty` 中权重为 0 的假功能
   - **Phase 5**（Q6 答后做）：Policy Compiler 扩 schema + Validator 接入 + repair loop
   - **Phase 6**（Q9 答后做）：删 ConditionRouting.mjs + API key fail-fast + 模型版本冻结 + mention checkpoint + client 修 round.facilitation + startup self-check

**Phase 1 审计到此停止。** Q6/Q9/Q11 答完我就进 Phase 2。
