/**
 * mock 回复脚本：固定内容，保证 e2e 与手工演示可复现。
 *
 * 长度与速度按 S0 基线的「约 40 字/秒」设计（S0-技术验证 §6.2），
 * 这样帧率/滚动指标可以直接和 S0 比较。内容覆盖标题、列表、表格、代码块、公式，
 * 用来验证 Markdown 分块渲染不会因为接入真实通道而回退。
 */

export const MOCK_REPLY = `收到！我先按你的要求把这件事拆开做。

### 先做什么

1. 读一遍现有的接口定义，确认字段没有漂移
2. 用本地假服务跑通登录、唤醒、发送和停止
3. 断线之后带游标续传，确认不重复也不丢字

### 进度

| 阶段 | 状态 |
| --- | --- |
| 登录 | 完成 |
| 唤醒 | 进行中 |
| 通道 | 完成 |

下面是一段示例代码：

\`\`\`ts
const ticket = await hub.requestTicket(nodeId)
const link = new WsChannelLink(channelUrl(nodeId, ticket))
await link.ready()
\`\`\`

再补一段 Python，验证工具卡和代码高亮不会互相影响：

\`\`\`python
import math
values = [math.sin(i / 10) for i in range(0, 120)]
print(len(values), values[0])
\`\`\`

### 接下来

- 先把会话列表按后端缓存起来，切回来时立刻能看
- 再确认流式停止在 1 秒内生效
- 最后把附件和大文件下载留到下一个版本

行内公式也可以显示：\(E = mc^2\)。

> 提示：如果你希望我换一种更短的写法，直接说一声就行。

最后确认一下：需要我把上面的清单直接执行掉，还是先只做第一步？如果需要我边做边汇报，我也可以每完成一项就发一条进度。`

/** 首条流式回复的目标长度（按 40 字/秒 ≈ 9 秒推完）。 */
export const MOCK_TICK_MS = 25

/** 预置的一条历史对话（用于「先显示缓存、再拉 bootstrap」与历史分页）。 */
export const MOCK_HISTORY = [
  { seq: 1, role: 'user' as const, text: '你好，帮我看下今天的计划', at: 1_760_000_000_000 },
  {
    seq: 2,
    role: 'assistant' as const,
    text: `# 今天的计划

1. 先跑一遍单元测试
2. 再看一眼接口文档

\`\`\`bash
pnpm test
\`\`\`

需要我直接开始吗？`,
    tools: [] as string[],
    at: 1_760_000_001_000,
  },
]
