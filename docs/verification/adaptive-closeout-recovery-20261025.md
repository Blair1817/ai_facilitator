# Adaptive 收尾、语义重选与受限恢复实施记录

日期：2026-10-25。工作位置为既有项目仓库根目录。

本次直接衔接当前工作树的未提交修改，基线 HEAD 为 `35d61f8518e02bed7ed579380b4b6a9394e6ba12`。实施阶段没有创建其他工作树、克隆或应用目录，没有 reset、部署、启动测试服务或修改线上实验。自动回复格式放宽、统一词数计数和参与者整理等待规则一并纳入提交；原有独立 UI/ReviewQuiz 界面修改保留在本地。

## 最终运行规则

- Adaptive 在真实 deadline 剩余 180 秒、120 秒分别获得独立检查机会，不要求新增 6 条人类消息。120 秒以内按合格 INTEGRATE > SCRUTINIZE > ELICIT；普通阶段仍为 SCRUTINIZE > INTEGRATE > ELICIT。180 秒的独立检查只在存在合格整合工作时生成。
- Assessor 显式收到阶段、剩余时间、优先级、完整公开上下文及历史；返回独立 integrationCandidate。候选先经过引用、作者/消息门槛、语义历史和完整计划预检，再参与优先选择。不能把 Challenger 计划改名为 Synthesiser。已有总结仍覆盖材料时，独立收尾检查不额外生成 Static。
- 两名不同参与者对同一仍有效选项明确支持且准备结束/提交，可提前获得整合优先；第三人沉默不构成第三票。偏好、单人重复、不同选项、含糊同意、撤回、反对或要求继续均按当前公开语境重算。第三人的反对/继续请求撤销提前优先，不能撤销已经到达的固定 120 秒窗口。此状态不触碰正式投票、提交或结束逻辑。
- 识别提前收尾使用 Assessor 的语义分析及完整三人当前状态，代码检查参与者、选项、引用归属和各自最新消息边界。没有关键词投票器。两人开始公开发言后，新消息可安排后台语义检查；检查受同一 30 秒冷却和在途锁约束，合并期间的新消息。未达提前收尾条件时，后台探查不生成普通干预。此机制会增加有限的后台 Assessor 调用，日志用 `triggerSource` 区分。
- 参与者明确开始整理时继续等待；普通逐条分享不自动排除整合。这是已有的明确整理暂停，适用于初评和重选；普通 NONE 或重选没有替代需求仍进入原 Static 后备。
- Validator 判定 repetition 后，排除该问题的语义目标，只重选一次。引用 ID 或措辞变化不使同一问题重新开放；同一选项上的不同问题仍可选择。每个历史目标记录已提问、回应、新证据/条件变化；重开必须提供边界之后的准确公开引用，单纯无人回应无效。确定性完全重复检查也进入该重选流程。
- Assessor 结构可修复一次；Specialist 的格式、长度、计划外引用或语义证据失败可在同一计划、同一允许证据内修复一次；失败进入适用的原 Static 路径。Static 自己保留一次原有长度/语义修复及最终失败行为。没有自动扩大证据范围的分支。
- 每次 Adaptive 评估共用预算：Assessor 结构修复 1 次、Specialist 修复 1 次、重选 1 次、Static 自身修复 1 次；最多 13 次实际模型调用。整条链最多 90 秒，并提前于 deadline 20 秒结束；每次实际调用重新读取剩余时间和生命周期，传输超时取剩余预算与原传输超时的较小值。最后 20 秒不补跑过期检查。
- 时间触发、消息触发和提前探查共用自动在途锁。冷却/锁占用时保留待办；180 秒检查跨过 120 秒时，后者仍会补查。轮次内完成状态持久化，重复注册/恢复不重做已经完成的时间事件。阶段/轮次结束取消定时器。
- 发布前及调用边界核对原轮次、阶段、deadline、结束状态和完整公开上下文。生成中出现新总结、异议、撤回或其他公开消息时丢弃旧候选；后台评估不会显示打字提示或向参与者追加审计文字。
- Synthesiser **完整可见文本仍最多 55 个英文词**，编号、标题、段落和结尾问题全部计数；其他自动角色仍为 50。句数、分段和每选项点数限制未恢复。纯 Static 条件、主动 @Facilitator/Requested Generalist 的既有路径不使用新增 Adaptive 调度/恢复预算。

## 主要实现与例子

- `server/src/AdaptiveRecovery.mjs`：共享恢复/时间预算、一次语义重选、后备路由。
- `server/src/AdaptiveCloseoutScheduler.mjs`：deadline 定时、冷却合并、持久化完成状态、生命周期取消。
- `server/src/AdaptiveEvidence.mjs`：可核验的提前收尾、目标语义关系和候选选择。
- `server/src/callbacks.js`：共用锁、生成/验证/发布链路、超时、上下文再检查、审计与生命周期接线。
- `SemanticAssessor.js`、`EvidenceChecker.js`、`PolicyCompiler.js`、`PlanPreflight.mjs`、`utils.js`：结构修复、阶段传递、独立候选预检、去除末段强制 nudge。
- `server/src/prompts/source/runtime/specialist/`：规则/schema 同步；新增 C-01 至 C-05 五个完整收尾/重选 few-shot，保留既有 A/G 普通示例。
- `server/test/fixtures/adaptive-closeout-examples.json`：上述 5 个可执行例子。
- `server/test/fixtures/adaptive-closeout-replay.json`：真实测试 10 个检查点，含公开上下文、历史输出和来源 SHA-256；提取脚本为 `server/scripts/extract-adaptive-closeout-replay.py`。
- GitHub 提交版本已将场次和参与者 ID 替换为匿名标识，删除头像/颜色元数据，时间转为首条消息起的相对毫秒，并省略与任务无关的个人饮食说明。这里的“公开上下文”指原讨论小组内可见的材料。原始聊天、审计、测试日志和迁移备份均留在被忽略的 `outputs/`；测试直接读取已脱敏 fixture，不需要原始数据。提取脚本仅供持有本地原始证据时重新生成。
- participant_sim 镜像与 manifest/hash 已同步；25 个 runtime 文件的哈希及镜像一致。既有 control/frozen 内容未因本次收尾规则被改写。

审计增加/保留 `triggerSource/triggerSources`、实际 scheduling 阶段、整合检查结果与未选择原因、earlyCloseout 支持者/证据、semanticReview、excludedSemanticTargets、reselectionResult、每次调用时间/类型、实际修复与调用计数、specialistFailures、fallbackOutcome 和 cancellation。没有声称评估未返回的候选；缺失观察记为未评估。未执行修复不再写“已耗尽两次修复”。

## 验证

- 新增三组测试：`AdaptiveRecovery.test.mjs`、`AdaptiveCloseout.test.mjs`、`AdaptivePipeline.test.mjs`，共 32 项通过。
- 完整测试：**827 项通过，0 失败**（含上述专项），最终日志为 `outputs/adaptive-closeout-full-tests-final.log`。
- 后端、前端生产构建均通过。前端仍输出现有依赖 sourcemap 警告，不影响构建成功。
- `git diff --check` 通过。
- GitHub 提交准备：脱敏后 13 项 pipeline 测试通过；另对暂存版本的 ReviewQuiz 测试及界面源码执行 17 项检查并通过，确认仅提交后端生命周期断言调整，独立界面修改未混入。待提交文件检查未发现密钥或个人电脑路径。
- 原始 `transcript.md`、`llm-audit.jsonl`、`diagnostic-summary.json` 的 SHA-256 与提取时一致，未修改原始证据。
- 真实检查点 6、8、10、13、15、21、27、33、39、45 已纳入离线回放；33 单独验证 repetition → 一次重选 → NONE → Static，未预设 INTEGRATE；45 的约 18.7 秒剩余时间使实际调用数为 0。提前的 180/120 窗口使用可控时钟另测。
- 覆盖普通/收尾优先级、材料不足、已经总结、提前结束正反例、同选项不同问题、实质新证据、没有回应、结构/引用/语义/长度修复、并发/冷却/恢复、跨阶段/新消息取消，以及 55 词与格式兼容性。

测试分层：可控时钟和证据/预算测试是确定性测试；端到端测试运行真实 callbacks，使用 Fake Empirica 和模拟模型输出；历史回放使用真实公开输入及历史模型产物，但后续响应/判定为离线模拟。**真实模型调用量为 0**，没有为测试更改现有模型/API 配置。不能以 mock 通过宣称真实模型的响应率、语义判断或主观质量已改善。

## 仍需真实讨论验证

提前收尾、语义等价、材料是否充分以及总结是否完整仍依赖模型理解。代码核验身份、原文、时效和结构，独立 Validator 核验生成内容，但这些检查不能把语义判断变成确定事实。需在后续正式授权的真实模型/三人讨论测试中检查触发准确率、误报、延迟、后台探查成本和实际 Synthesiser 表现。当前 90 秒整链上限是明确的工程预算，不是经过本次真实实验校准的性能结论。
