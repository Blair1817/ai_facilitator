# Static 发送与倒计时恢复：本地修复与验收

日期：2026-10-30（Europe/London）。基线：`main@93ee9694e9564c58732e5623fa4a1accdb732bb0` 加本次修复。此前 stash 保留。离线验收完成后，用户授权将修复提交并推送到 GitHub；没有部署、重启或变更 Azure/批次/真实参与者数据。

## 完成的修复

1. **模型不再占用 SDK 事件锁。** `dispatchChat` 是实际注册的短 listener；同步认领人类消息游标后，由受观察的后台任务完成模型生成/验证。自动请求继续复用原有 in-flight 互斥；显式请求按消息 ID 去重。Practice 主动请求也不再在 SDK listener 内等待模型。后台异常有 catch/finally 和终态审计。
2. **聊天 ACK 与模型解耦并显式 flush。** 正常、重复及无当前阶段请求都有回执。canonical 消息已保存但处理结果未保存时，重试会查找已有消息返回 accepted，避免重复追加。
3. **发送等待可恢复。** 待确认请求按参与者、轮次和阶段保存；10 秒未确认显示状态和 Retry sending。重试保留正文与 requestId，仅更新传输时间。刷新后能恢复 pending；确认后清除；迟到 ACK 不清除后来的草稿。输入在确认前保留保护，不能用新 ID 默默重复发送。
4. **讨论超时双重恢复。** 独立服务端 scheduler 使用绝对 deadline，并在原生定时器到期后留 1 秒宽限。加载 game/stage、ready 与既有 stage 恢复时重新注册，不重置讨论时长；前端在到期后每 2 秒补发，直到观察到结束，不因全员 Ready 而跳过。服务端检查原轮次/阶段、结束状态及自己的时钟。已写入的旧 recovery marker 不能单独阻止补偿。
5. **Static 截止保护与整链取消。** 自动发布补齐 deadline/round-ended 校验；模型实际调用受总预算和截止时间约束。`LLM_CHAIN_TIMEOUT_MS` 默认 90000，包含生成、验证、修复和 matched delay。阶段/游戏结束会取消在途请求；即使 provider 忽略 AbortSignal，也通过 Promise race 结束等待。matched delay 可取消。Static 最后 10 秒不启动、Adaptive 最后 20 秒等既有触发规则保留。
6. **合并交付不漏计。** 持久化每轮 human cursor，补计一次 callback 看到的全部新消息；固定 nudge 接在新消息后面不会遮住它们。多个合并到达的主动 @ 请求分别回复、共享正确的人类计数，重复交付不重复回复。发布记录使用实际发布时的人类计数边界，防止 async flush 期间后续新消息被清零。
7. **消息与审计身份可靠。** 同毫秒内生成回复和 fallback 均有唯一消息 ID。后台任务完成跨过 round 切换时，研究镜像核对 origin round，避免把旧任务记入新轮次；找不到原轮次时保留 Tajriba 原审计，不误写镜像。
8. **Export SDK 清理异步拒绝。** 对当前安装 SDK `stop()` 忽略的 graphql-ws `dispose()` Promise 显式观察；注册连接和 admin 连接均覆盖。非法 1006 close-frame 回归及退出清理通过。该兼容处理针对锁定依赖内部 `_wsClient`，升级 SDK 时需复核。

## 验证

- 全量枚举 `server/src/**/*.test.mjs`：**842 tests，842 pass，0 fail，0 skipped**。使用本地 loopback 权限验证 export HTTP/WebSocket，不调用真实模型。
- 新增 `server/src/DispatchReliability.test.mjs`：**11/11**。覆盖真实已安装 SDK 的 shared mutex/lockedAsyncSubscribe 与实际注册的 dispatch、慢模型期间 ACK/超时推进、永不返回 provider 的取消、Static 跨 deadline、canonical append 后 ACK 丢失、恢复过期阶段、批量人类消息后固定 nudge、多个显式请求、matched delay 超时、半写入 recovery marker、同毫秒 fallback ID。
- 后端与前端生产构建通过；前端仍有现有依赖 sourcemap 警告，构建退出成功。`git diff --check` 通过。
- Headless Chromium 运行实际 `CustomChat` 与 `DiscussionAdvanceGuard`（其余页面组件和 Empirica hooks 为合成 fixture）：缺失 ACK 后重试提示、刷新恢复 pending、重试沿用 ID/内容、确认后解锁、迟到 ACK 保留后来草稿、全员 Ready 后 deadline 仍重复恢复，均通过，0 page errors。
- 浏览器 fixture 将 10 秒等待和 2 秒重试缩短，仅用于验证状态流；运行代码仍为 10 秒与 2 秒。CLI 包未缓存，使用已安装 Playwright 库及已有 Chromium；没有下载浏览器或 npm 包。
- 证据与 runtime SHA-256：`outputs/diagnosis-2026-10-30/repair-*.log`、`repair-source-hashes.json`、`static-ui-check.png`；该目录被 Git 忽略，fixture 含本机路径，不提交。

## 实验规则与验收范围

保留六条门槛、30 秒 attempt cooldown、现有生成/验证策略、role 选择、时间 floor 与参与者请求分账。本次没有新增“没有新消息也定时再调用模型”的干预策略。正常上下文作废/验证失败仍可能不发布，修复不承诺每六条必然出现一条回复。

上述是本地源码与合成故障注入证据：SDK 调度测试使用真实锁原语，未启动完整 Azure/Tajriba 三人实验；浏览器 fixture 不代表真实网络、服务器和研究模型的整链验收。部署时须使用已提交的 HEAD，按 Azure 不可变镜像流程构建/更新 revision；在隔离测试批次执行三人发送、慢模型、超时与重连演练，并核对真实 scopedAttributes 订阅活性。当前线上镜像/probes 未核验，不能把此记录写成“线上已修复”。既有 Tajriba partial-freeze 也不能凭这些测试认定已修好。
