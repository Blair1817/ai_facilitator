# 系统更新报告（2026-08-11）

## 1. 更新概览

本次发布汇总了本地尚未进入 GitHub `main` 的完整开发成果，包括 LLM-only adaptive facilitator、共享生成与验证流程、实验流程调整、pilot 工具，以及实验数据可靠性保护。发布分支 `agent/current-updates-20260811` 直接基于 `origin/main` 创建，不修改或覆盖远端原分支历史。

## 2. 主要变更

### 2.1 LLM-only adaptive facilitator

- 移除 Python feature sidecar 依赖，语义因素由 LLM assessor 直接评估。
- Static 与 Adaptive 条件复用同一 Generator 和 Semantic Validator 路径。
- Adaptive controller 根据经过证据校验的 semantic factors，在 Expander、Challenger、Synthesiser 和 Generalist 之间选择或 abstain。
- 增加角色约束、修复循环、participant-requested `@Facilitator` Generalist，以及 stale-result 防护。
- 增加 checkpoint state、attempt/publish budget、cooldown、deduplication 和可审计 intervention history。

### 2.2 实验流程与 pilot 支持

- 完善 two-round task lifecycle、静态/自适应条件路由、Review Quiz 和最终问卷。
- 增加 browser pilot、reconnect、three-player 和 real-adaptive evaluation 工具。
- 增加系统架构、pilot 状态、LLM detector 和审计说明文档。

### 2.3 跨重启的随机化分配

- 新增 study-level、版本化的 `sequenceAllocationLedgerV1`。
- 将 S1-S4 分配记录持久化到 Empirica Global scope，而非仅保存在 Node.js 进程内存中。
- callbacks 服务重启或新建 Batch 后，可以继续已有的分配序列。
- 同一 Game 重复启动时复用原有分配，避免重复占用随机化位置。
- 迁移时会识别已有 Game 的 sequence assignment，并通过 least-used selection 修复累计不平衡。
- 当前设计假设只有一个活跃 callbacks 服务；若未来采用 active-active 多实例，需要引入外部原子分配机制。

### 2.4 LLM 请求中断审计

- 为 callbacks 进程生成唯一实例 ID。
- LLM 请求开始前写入 `llmInFlight` pending record，并在结束时写入 terminal audit record。
- 服务重启后会识别上一实例遗留的 pending request，并记录为 `INTERRUPTED_CALLBACKS_RESTART`。
- 新增 operational events，记录 callbacks 重连、缺失 round facilitation 和缺失任务计时状态等异常。
- Round 和 Stage 写入 callbacks 初始化时间与实例 ID，便于后续数据审计。

### 2.5 研究表单与聊天草稿保护

- 新增统一的 `usePersistentDraft` hook，以 participant、round、form 和 field 为维度保存浏览器本地草稿。
- 聊天输入、初始决定、最终决定、TLX、主观问卷、实验反馈、最终问题和 Review Quiz 支持刷新后恢复。
- 提交记录增加时间戳；全局退出表单会等待对应持久化结果可观测后再进入下一步。
- Review Quiz 保存每次评分结果和最终通过结果，并仅清除答错项目，保留答对项目。

### 2.6 Tajriba 数据库备份保护

- 新增 `scripts/backup-tajriba.sh`，备份现有 Tajriba JSON 数据库并生成 SHA-256 checksum。
- 新增 `scripts/safe-empirica-start.sh`，启动 Empirica 前强制执行备份。
- 若找不到 Tajriba 数据库，脚本会明确失败，而不会错误声称备份成功。
- `.empirica/backups/` 已加入 `.gitignore`；研究数据仍应复制到独立备份位置。
- README 与 PILOT_PREP 已同步更新启动、备份和导出说明。

## 3. 代码范围

- 相对远端 `main`，约 84 个文件发生变更。
- 约新增 8,600 行、删除 2,600 行，包括实现、测试、pilot 工具和研究文档。
- 新增核心模块：
  - `server/src/RandomizationLedger.mjs`
  - `server/src/InFlightAudit.mjs`
  - `client/src/hooks/usePersistentDraft.js`
  - `scripts/backup-tajriba.sh`
  - `scripts/safe-empirica-start.sh`
- 新增或扩展自动化测试，覆盖随机化 ledger、in-flight audit、研究数据持久化、Review Quiz、Final Questions 和 callbacks routing。

## 4. 验证结果

| 验证项 | 结果 | 备注 |
| --- | --- | --- |
| 服务端自动化测试 | 通过 | 223/223 tests passed |
| 服务端生产构建 | 通过 | esbuild 成功生成 `dist/index.js` |
| 客户端生产构建 | 通过 | Vite 成功生成生产 bundle |
| Shell 脚本语法检查 | 通过 | 两个备份/启动脚本均通过 `bash -n` |
| Git whitespace 检查 | 通过 | `git diff --check` 无错误 |
| 敏感信息扫描 | 通过 | tracked files 未发现高置信度 API key、token、JWT 或 private key |

客户端构建仍显示 Vite 配置和 MUI dependency sourcemap 警告，但构建成功完成；这些警告未阻止本次功能发布。

## 5. 部署与实验操作建议

1. 部署前确认线上仅运行一个 active callbacks 实例。
2. 正式实验期间使用 `./scripts/safe-empirica-start.sh` 启动 Empirica。
3. 每个 pilot 或 Game 完成后运行 `./scripts/backup-tajriba.sh`，并把备份复制到独立的研究数据存储位置。
4. 首次部署后检查 Global scope 中的 `sequenceAllocationLedgerV1`，确认 counts、assignments 和 block history 正常写入。
5. 模拟一次 callbacks 重启，确认未完成 LLM 请求会在 `llmLog` 中形成明确的 interrupted record。
6. 在正式采集前完成一次浏览器刷新测试，确认表单和聊天草稿能够恢复且最终提交数据写入 Tajriba。

## 6. 当前 GitHub 发布状态

发布目标为已有仓库 `Blair1817/ai_facilitator` 的独立分支 `agent/current-updates-20260811`。真实 `server/.env`、Empirica backups、CSV、ZIP、Python bytecode 和本地系统文件均被排除；发布不包含 API key 或实验参与者原始数据，也不会覆盖远端 `main`。
