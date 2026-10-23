# Facilitator quality verification before GitHub push — 2026-10-23

本次验收没有发现阻断推送的问题。结论仅适用于本轮合成测试，不等同于正式研究或 Azure 部署验收。

## Results

- Validator 固定正反例：13 类 × 3 次，**39/39**。包括正确接受澄清/安全替代答复，以及拒绝虚构、越权推荐、私有推断、三点汇总、提前选择问法和单纯拒绝。
- 真实 callbacks 完整链路：7 类 × 3 次，**21/21**。Expander、Challenger、Synthesiser、纯问候、请求澄清、要求选答案和健康自我修正均按预期路由，且发布经过验证的模型回复；没有技术失败提示。
- 全量离线 server 检查：**762/762**。之后两次 prompt 边界修复的针对性回归分别 **139/139**、**80/80**。用例有重叠，不合计为独立测试数。
- 服务端 production bundle 成功，构建后 prompt integrity=true。由于本机 npm esbuild shim 损坏，使用 package.json 的同等参数通过 esbuild API 构建；没有修改依赖安装文件。
- 最终完整链路：57 次 API 请求，检查点耗时中位数约 6.215 秒；Validator 回放 39 次请求。配置模型 gpt-5.6-luna。

## Fixes included

1. 官方 OpenAI Validator 使用 strict JSON Schema，同时保留本地十三字段校验与原有修复/发布门槛。兼容网关不发送其不支持的参数。
2. 为需要判断的阶段设置经过回放验证的推理预算，并记录实际请求策略。模型未切换；completion budget 包含推理 token。
3. Synthesiser 在适用的 OpenAI 汇总/比较路径先返回每个选项最多两个带来源的条目，再排成原有消息结构，之后照常进行机械与语义验证。不是通过截断模型文本绕过检查。
4. 补齐 Validator 的剩余时间上下文、Specialist 操作标准以及请求澄清的规则。
5. 本次再测复现并修复两个契约缺口：指出“缺乏依据”不等于已经在修正；已拒绝代选并提出聚焦的公开比较问题属于有效安全替代答复。新增健康自我修正和“只拒绝、不帮助”的反例，避免放宽为无条件接受。

前两轮 pre-push 失败及最终成功输出都保存在 [evidence.json](evidence.json)，不删除失败样本或改写 gold labels。重复的完整 prompt 载荷未加入本精简证据；prompt 源文件、[manifest](prompt-manifest.json)、[代码 hashes](source-hashes.json)及逐条候选、引文和判定可供复核。

## Reproduce

从 server 目录运行：

```sh
rtk proxy node scripts/evaluate-facilitator-quality.mjs --live --repeats=3
rtk proxy node scripts/evaluate-facilitator-pipeline.mjs --live --repeats=3
rtk proxy node --test --test-reporter=spec src/*.test.mjs src/prompts/*.test.mjs
```

真实模型脚本使用本地 .env，分别最多 40/90 次请求；不会连接 Tajriba/Azure。API key 不在提交范围。当前样本未覆盖所有连续对话、浏览器并发场景或 MiniMax 的真实模型表现；不能将测试通过率当作研究效果证明。没有修改研究条件、自动介入节奏或部署 Azure。

本次只提交 Facilitator 修复、测试脚本/夹具与本验证包；其他工作区文档内容和文件权限变化保留原样。
