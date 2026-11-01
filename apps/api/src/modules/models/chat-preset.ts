import type { PatchEntry } from './patch-entries.js'

/**
 * 「普通对话」Agent 预设（WP40d，docs/05 §4「普通对话」预设）。
 *
 * DSH 0.2.1-rc.2 的 preset 机制（`@deepseek-ai/dsh-agent-preset` + 注册表
 * `@deepseek-ai/dsh-agent-preset-registry`）：预设就是一行 patch 条目，
 * `config.plugins` 决定这个会话挂哪些子插件；注册表的 `default` 决定新会话默认用哪个预设。
 * 因此「下发预设」不需要装任何插件，只要把下面两段写进 `managed.patch.yml`（ro 挂载 + `--patch`），
 * 走的就是 Hub 现有的 managed 下发通道（docs/21 的统一入口最终落到这里）。
 *
 * 预设 id 用 `chat`（稳定标识，会话日志里记的是它）；行 id 用 `preset-chat`（patch 用）。
 * 名字给用户看的是「普通对话」。
 */
export const CHAT_PRESET_ID = 'chat'
export const CHAT_PRESET_ROW_ID = 'preset-chat'
export const CHAT_PRESET_NAME = '普通对话'
export const CHAT_PRESET_DESCRIPTION = '手机 App 默认：简短中文回答，自动使用搜索、计算与画图'

/**
 * 提问工具的前台等待秒数（WP47）。等于 DSH 插件自己的默认值 120：
 * 有手机持着 `userQuestions/attachWait` 的 claim 时这个 deadline 不算（claim 期间定时器停摆），
 * 只有「没人看着」时才计时；到点返回 pending，不是错误。
 */
export const ASK_USER_TIMEOUT_SECONDS = 120
export const AGENT_PRESET_REGISTRY_ROW_ID = 'agent-preset-registry'

/**
 * 系统提示：面向普通用户，不假设对方是程序员。
 *
 * 三个硬要求在文本里逐条点名（C0 阻断项 / 04 文档 §4.3）：中文简洁、不主动展示命令行细节、
 * 不擅自删除用户文件。能力部分要跟镜像实际能力一致：`dshhub/runtime:0.2.1-rc.2-chat1`
 * 已装 numpy/pandas/matplotlib/scipy/openpyxl，matplotlib 默认 Agg + Noto Sans CJK SC。
 */
export const CHAT_PRESET_PERSONA = `你是 DSH Hub 手机 App 里的中文助手，正在和一位普通用户对话。用户不一定是程序员。

说话方式：
- 用简体中文回答。先给结论，再按需要补一两句理由或步骤；能一句说清就不写一段。
- 语气自然、友好、有耐心。不要长篇大论，不要堆列表。
- 不主动展示命令行、代码、文件路径、日志、工具名或内部实现细节；用户明确要看时再给。
- 需要用户做选择时，用一两句话说明选项和影响，然后停下来等回答。

你可以直接使用这些能力（需要时自己动手，不要让用户去操作）：
- 联网搜索与抓取网页：回答涉及最新消息、价格、天气、新闻、具体网页内容的问题时先查再答。
- 计算与数据处理：用 bash 工具运行 python3。环境里已经装好 numpy、pandas、matplotlib、scipy、openpyxl，
  可以直接算数、读 Excel/CSV、做统计。
- 画图：matplotlib 已经配置好中文字体（Noto Sans CJK SC），中文标题、坐标轴和刻度不会出现方块；
  默认 Agg 后端，不需要显示器，保存成 PNG 即可。
- 交付文件：把图片和生成的文件保存到当前工作目录的 outputs/ 下（例如 outputs/chart.png，
  需要时先 mkdir -p outputs），然后用 present 工具（交付物）展示给用户，手机端会直接显示或提供下载。
  手机端的对话目录通常是 /workspace/chat，产物放它的 outputs/ 里最容易被手机发现。
- 记忆：如果你的工具列表里有记忆（memory）相关工具，就用它记住用户的长期偏好；没有就不要假装记得。
- 需要用户确认或补充信息时，可以用提问工具，把问题写得短而具体。

边界：
- 向用户提问后如果没拿到回答（超时、出错、无人应答），不要替用户做决定：删除、覆盖、移动、清空
  这类破坏性或不可逆的操作一律停手，说明你在等用户确认，然后结束这一轮。只读查证、整理和
  生成新文件可以继续。
- 不要删除、覆盖、移动用户的文件，除非用户明确要求；不确定时先问。
- 不编造搜索结果、数据或引用。查不到或做不到就直说，并给出替代方案。
- 不输出密钥、密码、令牌等内容。`

/** 预设挂载的子插件：够用即可，不装开发者工具（子代理、工作流、计划模式等） */
function chatPresetPlugins(): Record<string, unknown>[] {
  return [
    {
      id: 'persona',
      name: '@deepseek-ai/dsh-persona',
      config: {
        prefix: CHAT_PRESET_PERSONA,
        // 用这段文字替换默认的系统提示段，避免开发者口吻的默认提示混进来
        complete: true,
        // 不往提示里塞 checkout 路径、GUI URL 之类的运行时信息（普通用户不需要，也怕泄露内部结构）
        includeRuntimeContext: false,
      },
    },
    { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
    // 运行时镜像只有 Linux：直接用 tool-bash，不挂 pwsh（避免 !js 条件在 YAML 里被改写）
    { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' },
    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
    // `sampleOverCapGlobResults` 是必填（不带会被 agent-preset 的激活审计拒绝：invalid config）
    {
      id: 'tool-fs-search',
      name: '@deepseek-ai/dsh-tool-fs-search',
      config: { sampleOverCapGlobResults: false },
    },
    {
      id: 'tool-web',
      name: '@deepseek-ai/dsh-tool-web',
      config: { fetch: true, searchTimeoutMs: 60_000 },
    },
    // 提问工具用 **timed** 模式（WP47）。DSH 0.2.1-rc.2 的 `dsh-tool-ask-user` 有
    // `mode: 'legacy' | 'timed'` + `timeout`（秒，默认 120）：legacy 是阻塞等待，没有应答者
    // （手机通道断开时 Hub adapter 撤回 = 无人 accepted）会直接抛 NO_PROVIDER 错误；
    // timed 走 `userQuestions.askTimed`，NO_PROVIDER 与 deadline 都收敛成同一条成功结果
    // `{"pending":true,"callId":…,"message":"…Do not treat this as permission."}`，
    // 提问留在投影里、手机回来还能答。`timeout` 写死 120（= DSH 默认值），不留给版本漂移。
    // 注意：模型仍可显式传 `timeout: -1` 退回阻塞路径，这条靠系统提示的护栏兜。
    {
      id: 'tool-ask-user',
      name: '@deepseek-ai/dsh-tool-ask-user',
      config: { mode: 'timed', timeout: ASK_USER_TIMEOUT_SECONDS },
    },
    { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
    // 长对话压缩 + 大工具输出裁剪：普通用户不会主动「压缩上下文」，得靠预设兜住
    {
      id: 'compaction',
      name: 'cordis:group',
      group: true,
      isolate: { compaction: true, toolResultPruner: true },
      config: [
        { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
        { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
        {
          id: 'tool-result-pruner',
          name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
          config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
        },
      ],
    },
  ]
}

/**
 * 写进 `managed.patch.yml` 的「普通对话」条目：
 * 1. `insert` 一行新的 agent-preset（DSH 的 preset 不支持目录扫描，新增预设就是插一行）；
 * 2. 把注册表默认预设改成 `chat`，新会话不指定预设时就用它。
 */
export function chatPresetEntries(): PatchEntry[] {
  return [
    {
      insert: [
        {
          id: CHAT_PRESET_ROW_ID,
          name: '@deepseek-ai/dsh-agent-preset',
          config: {
            id: CHAT_PRESET_ID,
            name: CHAT_PRESET_NAME,
            description: CHAT_PRESET_DESCRIPTION,
            order: 0,
            plugins: chatPresetPlugins(),
          },
        },
      ],
    },
    { id: AGENT_PRESET_REGISTRY_ROW_ID, config: { default: CHAT_PRESET_ID } },
  ]
}
