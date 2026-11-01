# 变更记录

只记录对调用方可见的变化。协议版本始终是 `dsh-hub-mobile-v1`。

## 0.2.2

相对 0.2.1 新增的能力，**全部向后兼容**：0.2.1 的调用方不需要改代码，不使用新选项时行为与 0.2.1 相同。

- **`session-state` 能力位与帧**。`MobileV2Feature` 增加 `'session-state'`，在能力列表里回显。
  云节点上的 `session-state-request` 由 Hub 的 `NodeSession` 用本地快照回答，不下发 Host；
  adapter 只在有人把该帧转给它时回 `{ code: 'feature-unsupported' }`，不会静默吞掉。
- **`parkInteractions` 暂存模式（可选，默认关闭）**。传入后，未决提问与审批不再因为通道断开或未订阅
  而立刻 `next`，而是暂存到上限（默认 30 分钟，`DEFAULT_INTERACTION_PARK_MS`）再 `next`；
  不传时 `parkMs` 为 `null`，行为与 0.2.1 完全一致。
- **`session/create` 挂 Host 的默认工作区**。未配置 `chatDir` 时，先经 `workspace/initializeDefault`
  取默认工作区再建会话，手机建的会话因此出现在桌面侧栏的默认工作区里（桌面 0.2.1-rc.2 起支持该端点）；
  端点缺失时退回不带 `workspaceId` 的旧请求，`workspace/not-found` 时刷新一次工作区 id 后重试。
- **`session/list` 记录会话运行态**。`session-state` 快照需要「跑没在跑」的权威答案，不再只靠流式事件
  推断；只在 `parkInteractions` 模式下采集，未启用时零开销。
- 配套：`ensureDefaultWorkspace(refresh)` 增加 `refresh` 参数，供工作区被删后重建。

## 0.2.1

- mux 单帧上限从 256 KiB 提到 64 MiB（`session/follow` 的大帧因此能下发）。
