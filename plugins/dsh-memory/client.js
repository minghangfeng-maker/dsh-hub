/**
 * dsh-memory —— Client 半（浏览器）。在「设置」里加一页「记忆」：
 * 概览 / 记忆文件 / 会话记忆 / 整理 / 收件箱，以及一个全屏的记忆图谱弹窗。
 *
 * 数据通道：同源 fetch 到 Host 半注册的 `/memory/api`（契约见 DESIGN.md §9、§11.1）。
 *
 * 写法规约（照抄本仓其它插件的 client.js）：
 *   - 只从浏览器模块表 require('react')，不 import 任何 harness 客户端包；
 *   - 浏览器侧 URL 先用**文档相对**形式（'memory/api/...'），网络错误再退回根绝对形式；
 *   - 文案全部走 ctx.locale（扁平字典，{name} 插值），zh / en 两份；
 *   - 样式只用 --dsw-alias-* 主题 token + 自己的 class 前缀 dsh-memory-；
 *   - 组件自带 error boundary：出错时显示错误卡片，而不是把 slot 渲染成空白；
 *   - **两个分支都渲染 `<style>`** —— 只在错误分支渲染会让正常路径没有样式。
 *
 * 交互约定：
 *   - 阅读区最大宽度 760px；记忆文件（列表+详情）和图谱可以更宽；
 *   - 加载、空、错误、未保存四种状态都有明确呈现；
 *   - 图谱：滚轮缩放、拖画布、拖节点、悬停提示、点击条目跳转、筛选、Esc 关闭；
 *     超过 300 个条目节点时默认隐藏冷条目并提示。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-memory',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'memory'
    const RELATIVE_ROUTE = 'memory/api'
    const ABSOLUTE_PATH = '/memory/api'
    const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
    const TYPES = ['user', 'feedback', 'project', 'reference']

    /* ────────────────────────────── 文案 ────────────────────────────── */

    const zh = {
      title: '记忆',
      lead: '跨会话的长期记忆和本会话钉住的笔记。所有修改都留日志，可以撤销。',
      tabOverview: '概览',
      tabFiles: '记忆文件',
      tabSessions: '会话记忆',
      tabConsolidate: '整理',
      tabInbox: '收件箱',
      loading: '读取中…',
      refreshing: '刷新中…',
      reload: '刷新',
      retry: '重试',
      loadFailed: '读取失败：{message}',
      saveFailed: '保存失败：{message}',
      actionFailed: '操作失败：{message}',
      crashed: '面板出错了：{message}',
      empty: '暂无内容。',
      unsaved: '未保存',
      saved: '已保存',
      saving: '保存中…',
      save: '保存',
      cancel: '取消',
      close: '关闭',
      never: '从未',
      chars: '{n} 字',
      unknown: '未知',
      scopeGlobal: '全局',
      scopeWorkspace: '本工作区',
      scopeAll: '全部作用域',
      scopeOther: '作用域 {scope}',
      tierHot: '热',
      tierCold: '冷',
      tierArchived: '归档',
      tierAll: '全部层级',
      typeUser: '用户',
      typeFeedback: '反馈',
      typeProject: '项目',
      typeReference: '参考',
      typeAll: '全部类型',
      tagAll: '全部标签',
      pinnedMark: '📌',
      staleMark: '⚠️',
      pinned: '已置顶',
      pin: '置顶',
      unpin: '取消置顶',

      /* 概览 */
      overviewLead: '各作用域的条目、热层预算和整理时间。热记忆直接进索引，冷记忆经主题页两跳可达。',
      statTotal: '条目',
      statHot: '热',
      statCold: '冷',
      statArchived: '归档',
      statStale: '过期',
      budgetTitle: '热层预算',
      budgetUsage: '{used} / {budget} 字（{pct}%）',
      budgetPinned: '其中 pinned {n} 字',
      budgetOverflow: 'pinned 条目已超出预算，索引会变长',
      lastRun: '上次整理',
      nextRun: '下次整理',
      warningsTitle: '警告',
      noWarnings: '没有警告。',
      inboxTitle: '收件箱',
      inboxPending: '{n} 条待审批',
      inboxNone: '没有待审批的提议',
      openGraph: '查看记忆图谱',
      goInbox: '去审批',
      home: '数据目录',
      overviewEmpty: '还没有记忆条目。模型调用 memory_write 后，这里会出现第一条。',
      scopeBudgetUnknown: '预算未知',

      /* 记忆文件 */
      filesLead: '左边筛选，右边查看和编辑。保存会写 journal，可以撤销。',
      searchPlaceholder: '搜索 name、描述或标签…',
      resultCount: '{n} 条',
      noResults: '没有匹配的记忆。试试放宽筛选条件。',
      selectHint: '从左侧选择一条记忆查看详情。',
      detailLoading: '读取条目…',
      archiveAction: '归档',
      restoreAction: '恢复',
      archiveHint: '归档后不进入索引，随时可以恢复。',
      archivedNoBody: '归档条目的正文不在活动目录里；恢复后即可查看和编辑。',
      archiveDone: '已归档，可以在「归档」层级里恢复。',
      restoreDone: '已恢复。',
      staleHint: '这条记忆已过期，建议核实后更新 verified_at。',
      editorLabel: 'Markdown 原文',
      saveHint: '保存会校验 frontmatter；name 不能在这里改名。',
      nameInvalid: 'name 只能用小写字母、数字和连字符（1–64 个字符）',
      nameMismatch: 'name 必须与当前条目的身份键一致；要改名请新建条目。',
      dirtyBlockedAction: '有未保存的修改，先保存或放弃后再执行这个操作。',
      unsavedSwitchTitle: '当前修改还没保存',
      unsavedSwitchBody: '切换条目会丢失这些修改。',
      discardSwitch: '放弃并切换',
      saveAndSwitch: '保存并切换',
      fieldsTitle: '字段',
      fieldDescription: '描述',
      fieldType: '类型',
      fieldScope: '作用域',
      fieldTags: '标签',
      fieldLinks: '链接',
      fieldPinned: '置顶',
      fieldCreated: '创建',
      fieldUpdated: '更新',
      fieldVerified: '核实',
      fieldSource: '来源',
      fieldChars: '文件大小',
      fieldHeat: '热度',
      fieldHits: '读取',
      fieldLastUsed: '最近使用',
      statsTitle: '使用统计',
      relatedTitle: '关联',
      relatedLinks: '链接',
      relatedTags: '同标签',
      noRelated: '没有关联条目。',
      emptyBody: '（正文为空）',
      detailTitleFallback: '条目',
      linkCrossScope: '跨作用域',

      /* 会话记忆 */
      sessionsLead: '本会话钉住的笔记，只读。上下文压缩后会逐字恢复，不交给摘要模型改写。',
      sessionUpdated: '更新于 {time}',
      sessionNotes: '{n} 条笔记',
      sessionPromoted: '{n} 条已晋升',
      noSessions: '还没有会话记忆。',
      noteConstraint: '约束',
      noteDecision: '决定',
      noteFact: '事实',
      noteTodo: '待办',
      sessionReadOnly: '只读',

      /* 整理 */
      scheduleTitle: '定时整理',
      scheduleLead: '设置保存在 settings.json，改完立即生效。',
      scheduleHint: '轻整理不调模型；深整理会合并重复、归一标签、标记过期。',
      enableSchedule: '启用定时整理',
      deepFrequency: '深整理频率',
      freqDaily: '每天',
      freqWeekly: '每周',
      freqOff: '关闭',
      deepTime: '深整理时间',
      idleMinutes: '空闲补跑（分钟）',
      idleHint: '无活跃会话持续这么久后，补跑当天没跑的深整理；0 表示关闭。',
      modelLabel: '深整理使用的模型',
      modelDefault: 'DSH 默认模型',
      modelPlaceholder: 'DSH 默认模型（留空）',
      modelHint: 'provider/model，例如 deepseek/deepseek-chat；留空用默认模型。',
      invalidModel: '模型格式应为 provider/model；留空表示使用 DSH 默认模型。',
      maxLlmCalls: '每次尝试的 LLM 调用上限',
      inboxReview: '收件箱审阅',
      inboxReviewHint: '深整理时由 AI 审阅子代理提交的记忆请求：够格的直接写入，拿不准的继续留在收件箱等你批准。',
      inboxReviewAi: 'AI 自动决策',
      inboxReviewUser: '用户手动审批',
      settingsSaved: '设置已保存',
      invalidNumber: '请填写有效数字',
      invalidTime: '请填写 HH:MM 格式的时间',
      scheduleOffHint: '定时整理已关闭，只能手动运行。',
      runTitle: '立即整理',
      runLight: '立即轻整理',
      runDeep: '立即深整理',
      runLightHint: '重算冷热、重建索引，不调用模型。',
      runDeepHint: '会调用模型，受调用上限约束，可被抢占并在空闲后续跑。',
      runRunning: '运行中…',
      runDone: '已完成',
      runPaused: '已暂停',
      runError: '失败',
      runCanceled: '已取消',
      runStep: '当前步骤：{step}',
      runProgress: '{done} / {total}',
      runLlm: '模型调用 {n} 次',
      runInbox: '收件箱审阅：批准 {approved}，拒绝 {rejected}，留给用户 {deferred}',
      runsTitle: '最近运行',
      runsHint: '最近 10 次运行记录。',
      noRuns: '还没有整理记录。',
      runEntries: '{n} 条日志',
      runModeLight: '轻整理',
      runModeDeep: '深整理',
      runModeGeneric: '整理运行',
      undoRun: '撤销整次运行',
      undoEntry: '撤销',
      undoArmed: '确认撤销？',
      undoDone: '已撤销 {n} 条',
      showJournal: '展开日志',
      hideJournal: '收起日志',
      entryUndone: '已撤销',
      noJournalForRun: '这次运行没有日志。',
      journalActor: '执行者',
      journalName: '条目',
      actorModel: '模型',
      actorUser: '你',
      actorConsolidate: '整理',
      opCreate: '创建',
      opUpdate: '更新',
      opArchive: '归档',
      opRestore: '恢复',
      opMerge: '合并',
      opRetag: '改标签',
      opUndo: '撤销',
      settingsLead: '配置保存在 settings.json，不写进插件 config。',
      runNoteDone: '整理完成，索引已更新。',
      runNoteError: '整理失败：{message}',

      /* 收件箱 */
      inboxLead: '模型、子代理或深整理提交的修改提议。深整理时 AI 会审阅子代理的提议（可在「整理」里关闭），其余等用户批准后才会写入。',
      proposalMerge: '合并',
      proposalCreate: '新建',
      proposalUpdate: '更新',
      proposalRetag: '改标签',
      proposalArchive: '归档',
      approve: '批准',
      reject: '拒绝',
      approving: '处理中…',
      approved: '已批准',
      rejected: '已拒绝',
      reason: '原因',
      fromActor: '来自 {actor}',
      diffBefore: '改前',
      diffAfter: '改后',
      diffEmpty: '（无改动）',
      noInbox: '收件箱是空的。',
      inboxEmptyHint: '整理或子代理有新提议时会出现在这里。',
      proposalDiffTitle: '改动内容',

      /* 图谱 */
      graphTitle: '记忆图谱',
      graphLead: '节点大小表示热度，颜色表示类型。滚轮缩放，拖画布或节点；点击条目跳到「记忆文件」。',
      graphLoading: '正在计算图谱…',
      graphFailed: '图谱加载失败：{message}',
      graphEmpty: '还没有可以展示的记忆。',
      graphFilterEmpty: '当前筛选没有节点',
      graphFilterEmptyHint: '试试显示冷条目，或者把作用域切回全部。',
      filterScope: '作用域',
      filterHotOnly: '只看热记忆',
      filterCold: '显示冷条目',
      filterTags: '显示标签',
      filterCoread: '显示共读边',
      hideColdHint: '共 {n} 个条目节点，已默认隐藏 {m} 条冷记忆。',
      edgeTag: '标签',
      edgeLink: '链接',
      edgeCoread: '共读',
      nodePinnedTip: '置顶',
      nodeStaleTip: '过期',
      nodeHotTip: '热记忆',
      nodeColdTip: '冷记忆',
      zoomIn: '放大',
      zoomOut: '缩小',
      resetView: '重置视图',
      closeGraph: '关闭图谱',
      nodeCount: '节点 {n} · 边 {m}',
      graphHint: '点击条目节点跳转；Esc 关闭',
      graphLegend: '图例',
      tagNode: '标签',
      graphScopeAll: '全部作用域',
      graphScopeGlobal: '全局',
      graphScopeWorkspace: '本工作区',
      graphScaleHint: '滚轮缩放',
      graphNoCoread: '没有共读边',
      graphTagCount: '{n} 条',
    }

    const en = {
      title: 'Memory',
      lead: 'Long-term memory across sessions plus notes pinned in this one. Every change is journaled and can be undone.',
      tabOverview: 'Overview',
      tabFiles: 'Memory files',
      tabSessions: 'Session notes',
      tabConsolidate: 'Consolidate',
      tabInbox: 'Inbox',
      loading: 'Loading…',
      refreshing: 'Refreshing…',
      reload: 'Reload',
      retry: 'Retry',
      loadFailed: 'Load failed: {message}',
      saveFailed: 'Save failed: {message}',
      actionFailed: 'Action failed: {message}',
      crashed: 'Panel crashed: {message}',
      empty: 'Nothing here yet.',
      unsaved: 'Unsaved',
      saved: 'Saved',
      saving: 'Saving…',
      save: 'Save',
      cancel: 'Cancel',
      close: 'Close',
      never: 'Never',
      chars: '{n} chars',
      unknown: 'Unknown',
      scopeGlobal: 'Global',
      scopeWorkspace: 'This workspace',
      scopeAll: 'All scopes',
      scopeOther: 'Scope {scope}',
      tierHot: 'Hot',
      tierCold: 'Cold',
      tierArchived: 'Archived',
      tierAll: 'All tiers',
      typeUser: 'User',
      typeFeedback: 'Feedback',
      typeProject: 'Project',
      typeReference: 'Reference',
      typeAll: 'All types',
      tagAll: 'All tags',
      pinnedMark: '📌',
      staleMark: '⚠️',
      pinned: 'Pinned',
      pin: 'Pin',
      unpin: 'Unpin',

      overviewLead: 'Counts, hot-index budget and consolidation times per scope. Hot memories go straight into the index; cold ones are two hops away through topic pages.',
      statTotal: 'Items',
      statHot: 'Hot',
      statCold: 'Cold',
      statArchived: 'Archived',
      statStale: 'Stale',
      budgetTitle: 'Hot budget',
      budgetUsage: '{used} / {budget} chars ({pct}%)',
      budgetPinned: '{n} chars from pinned items',
      budgetOverflow: 'Pinned items already exceed the budget; the index will grow',
      lastRun: 'Last run',
      nextRun: 'Next run',
      warningsTitle: 'Warnings',
      noWarnings: 'No warnings.',
      inboxTitle: 'Inbox',
      inboxPending: '{n} awaiting review',
      inboxNone: 'Nothing awaiting review',
      openGraph: 'View memory graph',
      goInbox: 'Review',
      home: 'Data dir',
      overviewEmpty: 'No memories yet. The first one appears after the model calls memory_write.',
      scopeBudgetUnknown: 'Budget unknown',

      filesLead: 'Filter on the left, read and edit on the right. Saves are journaled and can be undone.',
      searchPlaceholder: 'Search name, description or tags…',
      resultCount: '{n} items',
      noResults: 'No matching memories. Try widening the filters.',
      selectHint: 'Pick a memory on the left to see its details.',
      detailLoading: 'Loading item…',
      archiveAction: 'Archive',
      restoreAction: 'Restore',
      archiveHint: 'Archived items leave the index and can be restored anytime.',
      archivedNoBody: 'The body of an archived item is not in the active directory; restore it to view and edit.',
      archiveDone: 'Archived. Restore it from the Archived tier.',
      restoreDone: 'Restored.',
      staleHint: 'This memory is stale. Verify it and update verified_at.',
      editorLabel: 'Raw Markdown',
      saveHint: 'Saving validates the frontmatter; name cannot be renamed here.',
      nameInvalid: 'name must be lowercase letters, digits and hyphens (1–64 chars)',
      nameMismatch: 'name must match the current identity key; create a new item to rename.',
      dirtyBlockedAction: 'You have unsaved changes. Save or discard them before this action.',
      unsavedSwitchTitle: 'Unsaved changes',
      unsavedSwitchBody: 'Switching items will discard these edits.',
      discardSwitch: 'Discard and switch',
      saveAndSwitch: 'Save and switch',
      fieldsTitle: 'Fields',
      fieldDescription: 'Description',
      fieldType: 'Type',
      fieldScope: 'Scope',
      fieldTags: 'Tags',
      fieldLinks: 'Links',
      fieldPinned: 'Pinned',
      fieldCreated: 'Created',
      fieldUpdated: 'Updated',
      fieldVerified: 'Verified',
      fieldSource: 'Source',
      fieldChars: 'Size',
      fieldHeat: 'Heat',
      fieldHits: 'Reads',
      fieldLastUsed: 'Last used',
      statsTitle: 'Usage',
      relatedTitle: 'Related',
      relatedLinks: 'Links',
      relatedTags: 'Same tags',
      noRelated: 'No related items.',
      emptyBody: '(empty body)',
      detailTitleFallback: 'Item',
      linkCrossScope: 'Cross-scope',

      sessionsLead: 'Notes pinned in this session, read-only. They are restored verbatim after compaction, never rewritten by the summarizer.',
      sessionUpdated: 'Updated {time}',
      sessionNotes: '{n} notes',
      sessionPromoted: '{n} promoted',
      noSessions: 'No session notes yet.',
      noteConstraint: 'Constraint',
      noteDecision: 'Decision',
      noteFact: 'Fact',
      noteTodo: 'Todo',
      sessionReadOnly: 'Read-only',

      scheduleTitle: 'Scheduled consolidation',
      scheduleLead: 'Stored in settings.json and applied immediately.',
      scheduleHint: 'Light runs avoid the model; deep runs merge duplicates, normalize tags and mark stale items.',
      enableSchedule: 'Enable scheduled runs',
      deepFrequency: 'Deep run frequency',
      freqDaily: 'Daily',
      freqWeekly: 'Weekly',
      freqOff: 'Off',
      deepTime: 'Deep run time',
      idleMinutes: 'Idle catch-up (minutes)',
      idleHint: 'Run a missed deep pass after this long without an active session; 0 disables it.',
      modelLabel: 'Model for deep runs',
      modelDefault: 'DSH default model',
      modelPlaceholder: 'DSH default model (leave blank)',
      modelHint: 'provider/model, e.g. deepseek/deepseek-chat. Blank = DSH default.',
      invalidModel: 'Model must be provider/model; leave blank for the DSH default.',
      maxLlmCalls: 'LLM call cap per attempt',
      inboxReview: 'Inbox review',
      inboxReviewHint: 'Deep runs let the AI review memory requests from subagents: clear ones are written, uncertain ones stay in the inbox for you.',
      inboxReviewAi: 'AI decides automatically',
      inboxReviewUser: 'Ask me every time',
      settingsSaved: 'Settings saved',
      invalidNumber: 'Enter a valid number',
      invalidTime: 'Enter time as HH:MM',
      scheduleOffHint: 'Scheduled runs are off; manual runs still work.',
      runTitle: 'Run now',
      runLight: 'Run light pass',
      runDeep: 'Run deep pass',
      runLightHint: 'Recompute heat and rebuild indexes without calling a model.',
      runDeepHint: 'Calls a model, respects the call cap, and may pause and resume when idle.',
      runRunning: 'Running…',
      runDone: 'Done',
      runPaused: 'Paused',
      runError: 'Failed',
      runCanceled: 'Canceled',
      runStep: 'Step: {step}',
      runProgress: '{done} / {total}',
      runLlm: '{n} model calls',
      runInbox: 'Inbox review: {approved} approved, {rejected} rejected, {deferred} left for you',
      runsTitle: 'Recent runs',
      runsHint: 'The latest 10 runs.',
      noRuns: 'No consolidation runs yet.',
      runEntries: '{n} log entries',
      runModeLight: 'Light',
      runModeDeep: 'Deep',
      runModeGeneric: 'Consolidation',
      undoRun: 'Undo whole run',
      undoEntry: 'Undo',
      undoArmed: 'Confirm undo?',
      undoDone: 'Undid {n} entries',
      showJournal: 'Show log',
      hideJournal: 'Hide log',
      entryUndone: 'Undone',
      noJournalForRun: 'This run has no log entries.',
      journalActor: 'Actor',
      journalName: 'Item',
      actorModel: 'Model',
      actorUser: 'You',
      actorConsolidate: 'Consolidator',
      opCreate: 'Create',
      opUpdate: 'Update',
      opArchive: 'Archive',
      opRestore: 'Restore',
      opMerge: 'Merge',
      opRetag: 'Retag',
      opUndo: 'Undo',
      settingsLead: 'Stored in settings.json, not in the plugin config.',
      runNoteDone: 'Run finished; indexes are up to date.',
      runNoteError: 'Run failed: {message}',

      inboxLead: 'Proposals from the model, subagents or deep runs. Deep runs let the AI review subagent proposals (toggle under Consolidation); everything else waits for your approval.',
      proposalMerge: 'Merge',
      proposalCreate: 'Create',
      proposalUpdate: 'Update',
      proposalRetag: 'Retag',
      proposalArchive: 'Archive',
      approve: 'Approve',
      reject: 'Reject',
      approving: 'Working…',
      approved: 'Approved',
      rejected: 'Rejected',
      reason: 'Reason',
      fromActor: 'From {actor}',
      diffBefore: 'Before',
      diffAfter: 'After',
      diffEmpty: '(no changes)',
      noInbox: 'The inbox is empty.',
      inboxEmptyHint: 'Proposals from consolidation or subagents show up here.',
      proposalDiffTitle: 'Changes',

      graphTitle: 'Memory graph',
      graphLead: 'Node size is heat, color is type. Scroll to zoom; drag the canvas or nodes. Click an item to open it under Memory files.',
      graphLoading: 'Building graph…',
      graphFailed: 'Graph failed to load: {message}',
      graphEmpty: 'No memories to display yet.',
      graphFilterEmpty: 'No nodes match these filters',
      graphFilterEmptyHint: 'Show cold items or switch the scope back to all.',
      filterScope: 'Scope',
      filterHotOnly: 'Hot only',
      filterCold: 'Show cold',
      filterTags: 'Tags',
      filterCoread: 'Co-read',
      hideColdHint: '{n} item nodes; {m} cold memories hidden by default.',
      edgeTag: 'Tag',
      edgeLink: 'Link',
      edgeCoread: 'Co-read',
      nodePinnedTip: 'Pinned',
      nodeStaleTip: 'Stale',
      nodeHotTip: 'Hot',
      nodeColdTip: 'Cold',
      zoomIn: 'Zoom in',
      zoomOut: 'Zoom out',
      resetView: 'Reset view',
      closeGraph: 'Close graph',
      nodeCount: '{n} nodes · {m} edges',
      graphHint: 'Click an item to open it; Esc closes',
      graphLegend: 'Legend',
      tagNode: 'Tag',
      graphScopeAll: 'All scopes',
      graphScopeGlobal: 'Global',
      graphScopeWorkspace: 'This workspace',
      graphScaleHint: 'Scroll to zoom',
      graphNoCoread: 'No co-read edges',
      graphTagCount: '{n} items',
    }

    /* ────────────────────────────── 样式 ──────────────────────────────
       只用 --dsw-alias-* / --dsw-radius-*，每个 var 都带兜底值。
       字号基准 13px；标题 17px；辅助信息 11–12px，逐层收紧。 */

    const CSS = `
.dsh-memory { max-width: 760px; padding: 2px 0 36px; color: var(--dsw-alias-label-primary, #1a1a1a);
  font-size: 13px; line-height: 1.65; }
.dsh-memory--wide { max-width: 1160px; }
.dsh-memory *, .dsh-memory *::before, .dsh-memory *::after { box-sizing: border-box; }

.dsh-memory-hd { display: flex; align-items: flex-start; gap: 16px; margin-bottom: 14px; }
.dsh-memory-hd-txt { flex: 1 1 auto; min-width: 0; }
.dsh-memory-hd-actions { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.dsh-memory-h1 { font-size: 17px; font-weight: 600; line-height: 1.4; margin: 0 0 6px; letter-spacing: .01em; }
.dsh-memory-lead { font-size: 13px; line-height: 1.65; margin: 0; color: var(--dsw-alias-label-secondary, #5c5c5c); max-width: 720px; }
.dsh-memory-hr { height: 1px; background: var(--dsw-alias-border-l2, #e8e8e8); border: 0; margin: 16px 0 18px; }

/* 页签 */
.dsh-memory-seg { display: inline-flex; flex-wrap: wrap; gap: 2px; padding: 3px; border-radius: var(--dsw-radius-lg, 10px);
  background: var(--dsw-alias-bg-layer-2, #f0f1f3); margin-bottom: 16px; max-width: 100%; }
.dsh-memory-tab { appearance: none; border: 0; cursor: pointer; font: inherit; font-size: 12.5px; line-height: 1;
  padding: 8px 13px; border-radius: calc(var(--dsw-radius-lg, 10px) - 3px); background: transparent;
  color: var(--dsw-alias-label-secondary, #5c5c5c); white-space: nowrap; display: inline-flex; align-items: center; gap: 6px;
  transition: background .12s, color .12s; }
.dsh-memory-tab:hover { color: var(--dsw-alias-label-primary, #1a1a1a); }
.dsh-memory-tab[aria-selected="true"] { background: var(--dsw-alias-bg-base, #fff); color: var(--dsw-alias-label-primary, #1a1a1a);
  font-weight: 600; box-shadow: 0 1px 3px rgba(0,0,0,.09); }
.dsh-memory-tab-count { font-size: 10px; line-height: 1; min-width: 16px; padding: 2px 4px; border-radius: 999px;
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 24%, transparent);
  color: color-mix(in srgb, var(--dsw-alias-state-warn-label, #dd8629) 55%, var(--dsw-alias-label-primary, #1a1a1a)); }

/* 按钮 */
.dsh-memory-btn { appearance: none; font: inherit; font-size: 12.5px; line-height: 1; cursor: pointer;
  padding: 8px 14px; border-radius: var(--dsw-radius-md, 8px); font-weight: 500; white-space: nowrap;
  border: 1px solid var(--dsw-alias-border-l3, #d9d9d9);
  background: var(--dsw-alias-bg-base, #fff); color: var(--dsw-alias-label-primary, #1a1a1a);
  transition: background .12s, border-color .12s, opacity .12s; }
.dsh-memory-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-1, #f4f4f5); }
.dsh-memory-btn:active:not(:disabled) { transform: translateY(.5px); }
.dsh-memory-btn:focus-visible { outline: 2px solid color-mix(in srgb, var(--dsw-alias-brand-primary, #1a1a1a) 35%, transparent); outline-offset: 1px; }
.dsh-memory-btn:disabled { opacity: .45; cursor: default; }
.dsh-memory-btn.primary { background: var(--dsw-alias-button-primary-fill, #1a1a1a); border-color: transparent;
  color: var(--dsw-alias-button-contrast-fill, #fff); }
.dsh-memory-btn.primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, #333); opacity: .94; }
.dsh-memory-btn.ghost { border-color: transparent; background: transparent; color: var(--dsw-alias-label-secondary, #5c5c5c); }
.dsh-memory-btn.ghost:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-1, #f4f4f5); color: var(--dsw-alias-label-primary, #1a1a1a); }
.dsh-memory-btn.danger { color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #c0392b) 70%, var(--dsw-alias-label-primary, #1a1a1a));
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #c0392b) 30%, transparent); }
.dsh-memory-btn.danger:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #c0392b) 8%, transparent); }
.dsh-memory-btn.small { font-size: 11.5px; padding: 6px 9px; }
.dsh-memory-grow { flex: 1 1 auto; min-width: 4px; }
.dsh-memory-icon-btn { appearance: none; border: 1px solid var(--dsw-alias-border-l3, #d9d9d9); background: var(--dsw-alias-bg-base, #fff);
  color: var(--dsw-alias-label-secondary, #5c5c5c); cursor: pointer; font: inherit; font-size: 13px; line-height: 1;
  width: 30px; height: 30px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; }
.dsh-memory-icon-btn:hover { color: var(--dsw-alias-label-primary, #1a1a1a); background: var(--dsw-alias-bg-layer-1, #f4f4f5); }

/* 表单控件 */
.dsh-memory-select, .dsh-memory-input { height: 30px; border: 1px solid var(--dsw-alias-border-l3, #d9d9d9);
  border-radius: 7px; background: var(--dsw-alias-bg-base, #fff); color: var(--dsw-alias-label-primary, #1a1a1a);
  font: inherit; font-size: 12.5px; padding: 0 9px; max-width: 100%; }
.dsh-memory-select:focus, .dsh-memory-input:focus, .dsh-memory-editor:focus {
  outline: none; border-color: var(--dsw-alias-brand-primary, #2b6cff);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary, #2b6cff) 15%, transparent); }
.dsh-memory-input[type="search"] { appearance: none; }
.dsh-memory-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.dsh-memory-field-label { font-size: 11.5px; font-weight: 600; color: var(--dsw-alias-label-secondary, #5c5c5c); }
.dsh-memory-field-hint { font-size: 11px; line-height: 1.55; color: var(--dsw-alias-label-tertiary, #8a8a8a); }
.dsh-memory-switch { display: inline-flex; align-items: center; gap: 8px; font-size: 12.5px; cursor: pointer; user-select: none; }
.dsh-memory-switch input { width: 15px; height: 15px; margin: 0; accent-color: var(--dsw-alias-brand-primary, #1a1a1a); }
.dsh-memory-check { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--dsw-alias-label-secondary, #5c5c5c);
  cursor: pointer; user-select: none; white-space: nowrap; }
.dsh-memory-check input { margin: 0; width: 13px; height: 13px; accent-color: var(--dsw-alias-brand-primary, #1a1a1a); }

/* 卡片 / 提示 */
.dsh-memory-card { border: 1px solid var(--dsw-alias-border-l2, #e6e6e6); border-radius: var(--dsw-radius-lg, 10px);
  background: var(--dsw-alias-bg-base, #fff); padding: 14px 16px; }
.dsh-memory-card + .dsh-memory-card { margin-top: 12px; }
.dsh-memory-card-hd { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
.dsh-memory-card-title { font-size: 13px; font-weight: 600; margin: 0; }
.dsh-memory-note { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; line-height: 1.6;
  padding: 9px 12px; border-radius: var(--dsw-radius-md, 8px); border: 1px solid transparent; margin-top: 10px; }
.dsh-memory-note.ok { color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #137a3d) 55%, var(--dsw-alias-label-primary, #1a1a1a));
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #137a3d) 9%, transparent);
  border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #137a3d) 20%, transparent); }
.dsh-memory-note.err { color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #c0392b) 68%, var(--dsw-alias-label-primary, #1a1a1a));
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #c0392b) 8%, transparent);
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #c0392b) 22%, transparent); }
.dsh-memory-note.warn { color: color-mix(in srgb, var(--dsw-alias-state-warn-label, #8a6d00) 70%, var(--dsw-alias-label-primary, #1a1a1a));
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #e6a014) 11%, transparent);
  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #e6a014) 26%, transparent); }
.dsh-memory-note.info { color: var(--dsw-alias-label-secondary, #5c5c5c);
  background: var(--dsw-alias-bg-layer-1, #f7f7f8); border-color: var(--dsw-alias-border-l2, #e6e6e6); }

/* 加载 / 空 / 错误 */
.dsh-memory-loading { display: flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-tertiary, #8a8a8a);
  font-size: 12.5px; padding: 10px 0; }
.dsh-memory-spinner { width: 13px; height: 13px; border-radius: 999px; flex: 0 0 auto;
  border: 2px solid var(--dsw-alias-border-l3, #d9d9d9); border-top-color: var(--dsw-alias-label-secondary, #5c5c5c);
  animation: dsh-memory-spin .8s linear infinite; }
@keyframes dsh-memory-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .dsh-memory-spinner { animation: none; } }
.dsh-memory-state { border: 1px dashed var(--dsw-alias-border-l3, #d9d9d9); border-radius: var(--dsw-radius-lg, 10px);
  padding: 36px 22px; text-align: center; color: var(--dsw-alias-label-secondary, #5c5c5c); font-size: 12.5px; line-height: 1.7; }
.dsh-memory-state-title { font-weight: 600; color: var(--dsw-alias-label-primary, #1a1a1a); margin-bottom: 4px; }
.dsh-memory-state .dsh-memory-btn { margin-top: 12px; }
.dsh-memory-state.err { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #c0392b) 30%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #c0392b) 4%, transparent);
  color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #c0392b) 60%, var(--dsw-alias-label-primary, #1a1a1a)); }

/* chips */
.dsh-memory-chip { display: inline-flex; align-items: center; gap: 4px; height: 19px; padding: 0 7px; border-radius: 999px;
  font-size: 10.5px; line-height: 1; white-space: nowrap; background: var(--dsw-alias-bg-layer-2, #eee);
  color: var(--dsw-alias-label-secondary, #5c5c5c); max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.dsh-memory-chip.tag { background: color-mix(in srgb, var(--dsw-alias-link, #2563eb) 9%, transparent);
  color: color-mix(in srgb, var(--dsw-alias-link, #2563eb) 62%, var(--dsw-alias-label-primary, #1a1a1a)); }
.dsh-memory-chip.tier-hot { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 15%, transparent);
  color: color-mix(in srgb, var(--dsw-alias-state-warn-label, #dd8629) 60%, var(--dsw-alias-label-primary, #1a1a1a)); }
.dsh-memory-chip.tier-cold { background: var(--dsw-alias-bg-layer-2, #eee); color: var(--dsw-alias-label-tertiary, #8a8a8a); }
.dsh-memory-chip.tier-archived { background: var(--dsw-alias-bg-layer-2, #eee); color: var(--dsw-alias-label-tertiary, #8a8a8a);
  text-decoration: line-through; }
.dsh-memory-chip.type-user { --dm-type: #3b82f6; }
.dsh-memory-chip.type-feedback { --dm-type: #a855f7; }
.dsh-memory-chip.type-project { --dm-type: #d99a1b; }
.dsh-memory-chip.type-reference { --dm-type: #14b8a6; }
.dsh-memory-chip.type-user, .dsh-memory-chip.type-feedback, .dsh-memory-chip.type-project, .dsh-memory-chip.type-reference {
  background: color-mix(in srgb, var(--dm-type, #888) 13%, transparent);
  color: color-mix(in srgb, var(--dm-type, #888) 55%, var(--dsw-alias-label-primary, #1a1a1a)); }
.dsh-memory-mark { font-size: 11px; line-height: 1; display: inline-flex; align-items: center; color: var(--dsw-alias-label-tertiary, #8a8a8a); }
.dsh-memory-pin-icon { display: inline-block; vertical-align: -1px; flex: 0 0 auto; color: inherit; }
.dsh-memory-mark.stale { opacity: .85; }
.dsh-memory-meta { font-size: 11px; color: var(--dsw-alias-label-tertiary, #8a8a8a); display: flex; flex-wrap: wrap;
  align-items: center; gap: 3px 10px; font-variant-numeric: tabular-nums; }
.dsh-memory-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Noto Sans Mono CJK SC", monospace;
  font-size: 11px; color: var(--dsw-alias-label-tertiary, #8a8a8a); word-break: break-all; line-height: 1.55; }

/* 概览 */
.dsh-memory-overview-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
.dsh-memory-scopes { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 12px; }
.dsh-memory-scope { border: 1px solid var(--dsw-alias-border-l2, #e6e6e6); border-radius: var(--dsw-radius-lg, 10px);
  background: var(--dsw-alias-bg-base, #fff); padding: 14px 16px; min-width: 0; }
.dsh-memory-scope-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.dsh-memory-scope-name { font-size: 13px; font-weight: 600; }
.dsh-memory-scope-code { font-size: 10px; color: var(--dsw-alias-label-tertiary, #8a8a8a);
  font-family: ui-monospace, Menlo, monospace; word-break: break-all; margin-top: 1px; }
.dsh-memory-stat-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 7px; margin: 12px 0 10px; }
.dsh-memory-stat { background: var(--dsw-alias-bg-layer-1, #f7f8fa); border-radius: 7px; padding: 7px 9px; min-width: 0; }
.dsh-memory-stat-num { font-size: 17px; font-weight: 600; line-height: 1.25; font-variant-numeric: tabular-nums; }
.dsh-memory-stat-label { font-size: 10px; color: var(--dsw-alias-label-tertiary, #8a8a8a); line-height: 1.4; }
.dsh-memory-budget { margin: 10px 0 8px; }
.dsh-memory-budget-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
  font-size: 11px; color: var(--dsw-alias-label-secondary, #5c5c5c); }
.dsh-memory-budget-track { height: 7px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2, #eee);
  overflow: hidden; margin-top: 5px; }
.dsh-memory-budget-fill { height: 100%; border-radius: inherit; background: var(--dsw-alias-brand-primary, #1a1a1a); }
.dsh-memory-budget-fill.warn { background: var(--dsw-alias-state-warn-primary, #f59e0b); }
.dsh-memory-warning { display: flex; gap: 8px; align-items: flex-start; font-size: 12px; line-height: 1.6;
  padding: 7px 0; border-top: 1px solid var(--dsw-alias-border-l1, #f2f2f2); }
.dsh-memory-warning:first-of-type { border-top: 0; padding-top: 0; }
.dsh-memory-warning-level { flex: 0 0 auto; font-size: 10px; line-height: 1.5; padding: 1px 6px; border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2, #eee); color: var(--dsw-alias-label-tertiary, #8a8a8a); margin-top: 1px; }
.dsh-memory-warning.warn .dsh-memory-warning-level { color: color-mix(in srgb, var(--dsw-alias-state-warn-label, #dd8629) 65%, var(--dsw-alias-label-primary, #1a1a1a));
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 14%, transparent); }
.dsh-memory-warning.error .dsh-memory-warning-level { color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #c0392b) 65%, var(--dsw-alias-label-primary, #1a1a1a));
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #c0392b) 12%, transparent); }
.dsh-memory-inbox-card { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.dsh-memory-inbox-num { font-size: 26px; font-weight: 600; line-height: 1; font-variant-numeric: tabular-nums; }

/* 记忆文件 */
.dsh-memory-files { display: grid; grid-template-columns: minmax(250px, 340px) minmax(0, 1fr); gap: 16px; align-items: start; }
.dsh-memory-list-pane { border: 1px solid var(--dsw-alias-border-l2, #e6e6e6); border-radius: var(--dsw-radius-lg, 10px);
  overflow: hidden; display: flex; flex-direction: column; min-width: 0;
  max-height: min(660px, calc(100vh - 260px)); }
.dsh-memory-filters { padding: 11px 12px; border-bottom: 1px solid var(--dsw-alias-border-l2, #e6e6e6);
  background: var(--dsw-alias-bg-layer-1, #f7f8fa); display: flex; flex-direction: column; gap: 7px; }
.dsh-memory-filter-row { display: flex; gap: 6px; flex-wrap: wrap; }
.dsh-memory-filter-row .dsh-memory-select { flex: 1 1 0; min-width: 70px; height: 28px; font-size: 11.5px; padding: 0 6px; }
.dsh-memory-search { width: 100%; height: 30px; }
.dsh-memory-resultbar { display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 7px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1, #f2f2f2);
  font-size: 11px; color: var(--dsw-alias-label-tertiary, #8a8a8a); }
.dsh-memory-list { overflow-y: auto; flex: 1 1 auto; min-height: 120px; }
.dsh-memory-list-state { padding: 18px 14px; font-size: 12px; color: var(--dsw-alias-label-secondary, #5c5c5c); text-align: center; line-height: 1.65; }
.dsh-memory-row { display: block; width: 100%; text-align: left; font: inherit; color: inherit; background: transparent;
  border: 0; border-left: 2px solid transparent; border-bottom: 1px solid var(--dsw-alias-border-l1, #f2f2f2);
  padding: 9px 11px 10px; cursor: pointer; }
.dsh-memory-row:last-child { border-bottom: 0; }
.dsh-memory-row:hover { background: var(--dsw-alias-bg-layer-1, #f7f8fa); }
.dsh-memory-row[aria-selected="true"] { background: color-mix(in srgb, var(--dsw-alias-brand-primary, #1a1a1a) 5%, var(--dsw-alias-bg-base, #fff));
  border-left-color: var(--dsw-alias-brand-primary, #1a1a1a); }
.dsh-memory-row-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
.dsh-memory-row-name { font-size: 12.5px; font-weight: 600; flex: 0 1 auto; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-memory-row-marks { margin-left: auto; flex: 0 0 auto; display: inline-flex; align-items: center; gap: 3px; }
.dsh-memory-row-desc { font-size: 11.5px; line-height: 1.5; color: var(--dsw-alias-label-secondary, #5c5c5c); margin-top: 2px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; word-break: break-word; }
.dsh-memory-row-meta { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; margin-top: 6px; }
.dsh-memory-row-meta .dsh-memory-meta { font-size: 10px; }
.dsh-memory-detail { border: 1px solid var(--dsw-alias-border-l2, #e6e6e6); border-radius: var(--dsw-radius-lg, 10px);
  overflow: hidden; min-width: 0; }
.dsh-memory-detail-hd { padding: 13px 16px; border-bottom: 1px solid var(--dsw-alias-border-l1, #f2f2f2); }
.dsh-memory-detail-title { font-size: 15px; font-weight: 600; line-height: 1.4; word-break: break-all; }
.dsh-memory-detail-desc { font-size: 12.5px; color: var(--dsw-alias-label-secondary, #5c5c5c); line-height: 1.6;
  margin-top: 3px; word-break: break-word; }
.dsh-memory-detail-badges { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
.dsh-memory-detail-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.dsh-memory-detail-body { padding: 14px 16px 16px; }
.dsh-memory-meta-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(125px, 1fr)); gap: 10px 16px; margin-bottom: 14px; }
.dsh-memory-meta-item { min-width: 0; }
.dsh-memory-meta-k { font-size: 10px; color: var(--dsw-alias-label-tertiary, #8a8a8a); letter-spacing: .02em; margin-bottom: 1px; }
.dsh-memory-meta-v { font-size: 11.5px; line-height: 1.55; word-break: break-word; }
.dsh-memory-subhead { font-size: 10.5px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
  color: var(--dsw-alias-label-tertiary, #8a8a8a); margin: 16px 0 7px; }
.dsh-memory-editor { display: block; width: 100%; min-height: 320px; resize: vertical; padding: 12px 14px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Noto Sans Mono CJK SC", monospace;
  font-size: 12px; line-height: 1.75; tab-size: 2; color: var(--dsw-alias-label-primary, #1a1a1a);
  background: var(--dsw-alias-bg-base, #fff); border: 1px solid var(--dsw-alias-border-l3, #d9d9d9);
  border-radius: var(--dsw-radius-md, 8px); }
.dsh-memory-readonly { margin: 0; padding: 12px 14px; max-height: 420px; overflow: auto; white-space: pre-wrap;
  word-break: break-word; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Noto Sans Mono CJK SC", monospace;
  font-size: 12px; line-height: 1.75; color: var(--dsw-alias-label-secondary, #5c5c5c);
  background: var(--dsw-alias-bg-layer-1, #f7f8fa); border: 1px solid var(--dsw-alias-border-l2, #e6e6e6);
  border-radius: var(--dsw-radius-md, 8px); }
.dsh-memory-savebar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.dsh-memory-dirty { font-size: 11px; line-height: 1.4; padding: 3px 8px; border-radius: 999px;
  color: color-mix(in srgb, var(--dsw-alias-state-warn-label, #dd8629) 65%, var(--dsw-alias-label-primary, #1a1a1a));
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 14%, transparent); }
.dsh-memory-guard { border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 30%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 8%, transparent);
  border-radius: var(--dsw-radius-md, 8px); padding: 10px 12px; margin-bottom: 10px;
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; line-height: 1.55; }
.dsh-memory-guard-txt { flex: 1 1 200px; min-width: 0; }
.dsh-memory-guard-title { font-weight: 600; }
.dsh-memory-related { display: flex; flex-wrap: wrap; gap: 5px; }
.dsh-memory-related-btn { appearance: none; font: inherit; font-size: 11px; line-height: 1.4; cursor: pointer;
  padding: 4px 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2, #e6e6e6);
  background: var(--dsw-alias-bg-layer-1, #f7f8fa); color: var(--dsw-alias-label-secondary, #5c5c5c);
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-memory-related-btn:hover { color: var(--dsw-alias-label-primary, #1a1a1a); border-color: var(--dsw-alias-border-l3, #d9d9d9); }
.dsh-memory-related-group + .dsh-memory-related-group { margin-top: 8px; }
.dsh-memory-related-label { font-size: 10px; color: var(--dsw-alias-label-tertiary, #8a8a8a); margin-bottom: 4px; }
.dsh-memory-detail-empty { padding: 46px 24px; text-align: center; color: var(--dsw-alias-label-secondary, #5c5c5c);
  border: 1px dashed var(--dsw-alias-border-l3, #d9d9d9); border-radius: var(--dsw-radius-lg, 10px); font-size: 12.5px; line-height: 1.7; }

/* 会话记忆 */
.dsh-memory-session-hd { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
.dsh-memory-session-id { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px; color: var(--dsw-alias-label-secondary, #5c5c5c); word-break: break-all; }
.dsh-memory-session-meta { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #8a8a8a); margin-bottom: 8px; }
.dsh-memory-note-row { display: flex; gap: 9px; padding: 9px 0; border-top: 1px solid var(--dsw-alias-border-l1, #f2f2f2); }
.dsh-memory-note-row:first-child { border-top: 0; padding-top: 0; }
.dsh-memory-note-kind { flex: 0 0 auto; font-size: 10px; line-height: 1.6; padding: 1px 7px; border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2, #eee); color: var(--dsw-alias-label-secondary, #5c5c5c); margin-top: 1px; }
.dsh-memory-note-kind.constraint { background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #c0392b) 10%, transparent);
  color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #c0392b) 55%, var(--dsw-alias-label-primary, #1a1a1a)); }
.dsh-memory-note-kind.decision { background: color-mix(in srgb, #3b82f6 12%, transparent);
  color: color-mix(in srgb, #3b82f6 55%, var(--dsw-alias-label-primary, #1a1a1a)); }
.dsh-memory-note-kind.todo { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 15%, transparent);
  color: color-mix(in srgb, var(--dsw-alias-state-warn-label, #dd8629) 60%, var(--dsw-alias-label-primary, #1a1a1a)); }
.dsh-memory-note-text { flex: 1 1 auto; min-width: 0; font-size: 12.5px; line-height: 1.65;
  white-space: pre-wrap; word-break: break-word; }
.dsh-memory-note-at { flex: 0 0 auto; font-size: 10px; color: var(--dsw-alias-label-tertiary, #8a8a8a); padding-top: 2px; }

/* 整理 */
.dsh-memory-form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px 16px; }
.dsh-memory-form-wide { grid-column: 1 / -1; }
.dsh-memory-runbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-memory-progress { margin-top: 10px; border: 1px solid var(--dsw-alias-border-l2, #e6e6e6);
  background: var(--dsw-alias-bg-layer-1, #f7f8fa); border-radius: var(--dsw-radius-md, 8px); padding: 10px 12px; }
.dsh-memory-progress-head { display: flex; align-items: center; justify-content: space-between; gap: 8px;
  font-size: 11.5px; color: var(--dsw-alias-label-secondary, #5c5c5c); }
.dsh-memory-progress-track { height: 6px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2, #eee);
  overflow: hidden; margin-top: 7px; }
.dsh-memory-progress-fill { height: 100%; border-radius: inherit; background: var(--dsw-alias-brand-primary, #1a1a1a);
  transition: width .3s ease; }
.dsh-memory-progress-fill.paused { background: var(--dsw-alias-state-warn-primary, #f59e0b); }
.dsh-memory-progress-fill.error { background: var(--dsw-alias-state-error-primary, #c0392b); }
.dsh-memory-run-status { font-size: 10px; line-height: 1.5; padding: 1px 7px; border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2, #eee); color: var(--dsw-alias-label-secondary, #5c5c5c); }
.dsh-memory-run-status.done { background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 14%, transparent);
  color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 55%, var(--dsw-alias-label-primary, #1a1a1a)); }
.dsh-memory-run-status.running { background: color-mix(in srgb, var(--dsw-alias-link, #2563eb) 12%, transparent);
  color: color-mix(in srgb, var(--dsw-alias-link, #2563eb) 65%, var(--dsw-alias-label-primary, #1a1a1a)); }
.dsh-memory-run-status.paused { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 15%, transparent);
  color: color-mix(in srgb, var(--dsw-alias-state-warn-label, #dd8629) 60%, var(--dsw-alias-label-primary, #1a1a1a)); }
.dsh-memory-run-status.error { background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #c0392b) 11%, transparent);
  color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #c0392b) 60%, var(--dsw-alias-label-primary, #1a1a1a)); }
.dsh-memory-run-item { border: 1px solid var(--dsw-alias-border-l2, #e6e6e6); border-radius: var(--dsw-radius-md, 8px);
  margin-top: 8px; overflow: hidden; background: var(--dsw-alias-bg-base, #fff); }
.dsh-memory-run-hd { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; padding: 9px 11px; }
.dsh-memory-run-id { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 10.5px;
  color: var(--dsw-alias-label-tertiary, #8a8a8a); }
.dsh-memory-run-body { border-top: 1px solid var(--dsw-alias-border-l1, #f2f2f2); padding: 4px 11px 8px;
  background: var(--dsw-alias-bg-layer-1, #f7f8fa); }
.dsh-memory-jrow { display: flex; align-items: baseline; gap: 5px 9px; flex-wrap: wrap; padding: 7px 0;
  border-top: 1px dashed var(--dsw-alias-border-l2, #e6e6e6); font-size: 11px; line-height: 1.55; }
.dsh-memory-jrow:first-child { border-top: 0; }
.dsh-memory-jtime { font-family: ui-monospace, Menlo, monospace; font-size: 10px; color: var(--dsw-alias-label-tertiary, #8a8a8a); }
.dsh-memory-jname { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 10.5px;
  flex: 1 1 160px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-memory-jreason { flex: 1 1 100%; color: var(--dsw-alias-label-secondary, #5c5c5c); }
.dsh-memory-jrow.undone { opacity: .5; }
.dsh-memory-jrow.undone .dsh-memory-jreason { text-decoration: line-through; }

/* 收件箱 */
.dsh-memory-proposal { border: 1px solid var(--dsw-alias-border-l2, #e6e6e6); border-radius: var(--dsw-radius-lg, 10px);
  padding: 13px 15px; background: var(--dsw-alias-bg-base, #fff); }
.dsh-memory-proposal + .dsh-memory-proposal { margin-top: 12px; }
.dsh-memory-proposal-hd { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 3px; }
.dsh-memory-proposal-name { font-size: 13px; font-weight: 600; word-break: break-all; }
.dsh-memory-proposal-reason { font-size: 11.5px; line-height: 1.6; color: var(--dsw-alias-label-secondary, #5c5c5c);
  margin: 6px 0 9px; word-break: break-word; }
.dsh-memory-proposal-actions { display: flex; gap: 7px; flex-wrap: wrap; margin-top: 9px; }
.dsh-memory-diff { border: 1px solid var(--dsw-alias-border-l2, #e6e6e6); border-radius: var(--dsw-radius-md, 8px);
  overflow: auto; max-height: 340px; background: var(--dsw-alias-bg-base, #fff);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Noto Sans Mono CJK SC", monospace;
  font-size: 11px; line-height: 1.6; }
.dsh-memory-diff-line { display: flex; align-items: stretch; min-width: 100%; white-space: pre; }
.dsh-memory-diff-gutter { flex: 0 0 34px; text-align: right; padding: 0 6px; user-select: none;
  color: var(--dsw-alias-label-tertiary, #8a8a8a); background: var(--dsw-alias-bg-layer-1, #f7f8fa);
  border-right: 1px solid var(--dsw-alias-border-l1, #f2f2f2); font-size: 10px; }
.dsh-memory-diff-sign { flex: 0 0 16px; text-align: center; user-select: none; color: var(--dsw-alias-label-tertiary, #8a8a8a); }
.dsh-memory-diff-text { flex: 1 1 auto; padding-right: 10px; white-space: pre-wrap; word-break: break-word; }
.dsh-memory-diff-line.add { background: var(--dsw-alias-code-diff-added, #e6f4e7); }
.dsh-memory-diff-line.del { background: var(--dsw-alias-code-diff-deleted, #fce6e2); }
.dsh-memory-diff-line.add .dsh-memory-diff-sign { color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 60%, var(--dsw-alias-label-primary, #1a1a1a)); }
.dsh-memory-diff-line.del .dsh-memory-diff-sign { color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #c0392b) 65%, var(--dsw-alias-label-primary, #1a1a1a)); }

/* 图谱弹窗：固定铺满视口；设置页容器如果有 transform，fixed 会退化成相对容器，
   真机上请以设置页实际挂载点为准。 */
.dsh-memory-modal { position: fixed; inset: 0; z-index: 9000; display: flex; flex-direction: column;
  background: var(--dsw-alias-bg-base, #fff); color: var(--dsw-alias-label-primary, #1a1a1a); font-size: 13px; }
.dsh-memory-modal-hd { padding: 11px 18px 10px; border-bottom: 1px solid var(--dsw-alias-border-l2, #e6e6e6);
  background: var(--dsw-alias-bg-layer-1, #f7f8fa); display: flex; flex-direction: column; gap: 8px; flex: 0 0 auto; }
.dsh-memory-modal-row { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; min-width: 0; }
.dsh-memory-modal-title { font-size: 15px; font-weight: 600; line-height: 1.3; }
.dsh-memory-modal-sub { font-size: 11px; color: var(--dsw-alias-label-tertiary, #8a8a8a); }
.dsh-memory-modal-close { margin-left: auto; flex: 0 0 auto; }
.dsh-memory-modal-filters { display: flex; align-items: center; gap: 7px 12px; flex-wrap: wrap; }
.dsh-memory-modal-filters .dsh-memory-select { height: 27px; font-size: 11.5px; padding: 0 7px; }
.dsh-memory-modal-body { position: relative; flex: 1 1 auto; min-height: 0; overflow: hidden; }
.dsh-memory-graph-svg { display: block; width: 100%; height: 100%; touch-action: none; cursor: grab; user-select: none;
  background: var(--dsw-alias-bg-base, #fff); }
.dsh-memory-graph-svg.dragging { cursor: grabbing; }
.dsh-memory-graph-svg.node-dragging { cursor: grabbing; }
.dsh-memory-graph-edge { fill: none; stroke-linecap: round; transition: opacity .12s; }
.dsh-memory-graph-edge.tag { stroke: color-mix(in srgb, var(--dsw-alias-label-tertiary, #8a8a8a) 40%, transparent); stroke-width: 1; }
.dsh-memory-graph-edge.link { stroke: color-mix(in srgb, var(--dsw-alias-label-secondary, #5c5c5c) 62%, transparent); stroke-width: 1.2; }
.dsh-memory-graph-edge.coread { stroke: color-mix(in srgb, var(--dsw-alias-link, #2563eb) 18%, transparent);
  stroke-dasharray: 3 4; }
.dsh-memory-graph-edge.coread.active { stroke: color-mix(in srgb, var(--dsw-alias-link, #2563eb) 62%, transparent);
  stroke-width: 1.3; }
.dsh-memory-graph-edge.active { stroke-opacity: 1; }
.dsh-memory-graph-edge.dim { opacity: .13; }
.dsh-memory-graph-node { transition: opacity .12s; }
.dsh-memory-graph-node.dim { opacity: .22; }
.dsh-memory-graph-node.hovered circle:first-of-type { filter: drop-shadow(0 0 4px rgba(0,0,0,.18)); }
.dsh-memory-node-label { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans CJK SC", sans-serif;
  font-size: 9.5px; fill: var(--dsw-alias-label-primary, #1a1a1a); paint-order: stroke;
  stroke: var(--dsw-alias-bg-base, #fff); stroke-width: 3px; stroke-linejoin: round; pointer-events: none; }
.dsh-memory-tag-label { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans CJK SC", sans-serif;
  font-size: 9.5px; fill: var(--dsw-alias-label-secondary, #5c5c5c); pointer-events: none; }
.dsh-memory-tag-shape { fill: var(--dsw-alias-bg-layer-2, #eee); stroke: var(--dsw-alias-border-l3, #d9d9d9);
  stroke-width: 1; }
.dsh-memory-graph-pin { font-size: 9px; }
.dsh-memory-graph-tip { position: fixed; z-index: 10001; max-width: 290px; padding: 8px 10px; border-radius: 8px;
  background: var(--dsw-alias-tooltip-bg, #212123); color: var(--dsw-alias-tooltip-label, #f9fafb);
  font-size: 11.5px; line-height: 1.55; pointer-events: none; box-shadow: 0 6px 24px rgba(0,0,0,.22); }
.dsh-memory-graph-tip-title { font-weight: 600; margin-bottom: 2px; word-break: break-all; }
.dsh-memory-graph-tip-desc { opacity: .94; word-break: break-word; }
.dsh-memory-graph-tip-meta { opacity: .68; font-size: 10px; margin-top: 3px; }
.dsh-memory-graph-legend { display: flex; align-items: center; gap: 5px 11px; flex-wrap: wrap; font-size: 10.5px;
  color: var(--dsw-alias-label-tertiary, #8a8a8a); }
.dsh-memory-legend-item { display: inline-flex; align-items: center; gap: 4px; }
.dsh-memory-swatch { width: 8px; height: 8px; border-radius: 999px; display: inline-block; }
.dsh-memory-swatch.tag { border-radius: 3px; background: var(--dsw-alias-bg-layer-3, #e1e5ee);
  border: 1px solid var(--dsw-alias-border-l4, #cfd3d6); }
.dsh-memory-line-sample { width: 16px; height: 0; display: inline-block; border-top: 1.5px solid var(--dsw-alias-label-tertiary, #8a8a8a); }
.dsh-memory-line-sample.coread { border-top-style: dashed; border-color: color-mix(in srgb, var(--dsw-alias-link, #2563eb) 50%, transparent); }
.dsh-memory-zoom { position: absolute; right: 14px; bottom: 14px; display: flex; flex-direction: column; gap: 4px; z-index: 2; }
.dsh-memory-zoom .dsh-memory-icon-btn { width: 30px; height: 28px; background: var(--dsw-alias-bg-base, #fff);
  box-shadow: 0 2px 8px rgba(0,0,0,.1); }
.dsh-memory-graph-notice { position: absolute; left: 14px; bottom: 14px; z-index: 2; max-width: 380px;
  font-size: 11px; line-height: 1.55; padding: 7px 10px; border-radius: 8px;
  background: color-mix(in srgb, var(--dsw-alias-bg-base, #fff) 88%, var(--dsw-alias-state-warn-primary, #f59e0b));
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 30%, transparent);
  color: var(--dsw-alias-label-secondary, #5c5c5c); }
.dsh-memory-graph-overlay { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  flex-direction: column; gap: 10px; z-index: 3; background: color-mix(in srgb, var(--dsw-alias-bg-base, #fff) 78%, transparent);
  font-size: 12.5px; color: var(--dsw-alias-label-secondary, #5c5c5c); text-align: center; padding: 24px; }
.dsh-memory-graph-hint { font-size: 10.5px; color: var(--dsw-alias-label-tertiary, #8a8a8a); }

/* 崩溃卡片 */
.dsh-memory-crash { padding: 16px; border-radius: var(--dsw-radius-md, 8px); font-size: 13px; line-height: 1.7;
  color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #c0392b) 62%, var(--dsw-alias-label-primary, #1a1a1a));
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #c0392b) 8%, transparent); }

@media (max-width: 900px) {
  .dsh-memory-files { grid-template-columns: 1fr; }
  .dsh-memory-list-pane { max-height: 420px; }
}
@media (max-width: 620px) {
  .dsh-memory-hd { flex-direction: column; gap: 10px; }
  .dsh-memory-hd-actions { justify-content: flex-start; }
  .dsh-memory-stat-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .dsh-memory-modal-hd { padding: 10px 12px; }
  .dsh-memory-modal-title { font-size: 14px; }
  .dsh-memory-graph-legend { display: none; }
}
`

    /* ────────────────────────────── 工具函数 ────────────────────────────── */

    function asArray(value) {
      if (Array.isArray(value)) return value.filter((item) => item !== null && item !== undefined)
      if (typeof value === 'string') {
        if (!value.trim()) return []
        if (value.includes(',')) return value.split(',').map((part) => part.trim()).filter(Boolean)
        return [value.trim()]
      }
      return []
    }

    function num(value, fallback = 0) {
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : fallback
    }

    function byteLength(value) {
      const text = String(value ?? '')
      try {
        return new TextEncoder().encode(text).length
      } catch {
        return text.length
      }
    }

    function pad2(value) {
      return String(value).padStart(2, '0')
    }

    function formatDateTime(value, t) {
      if (!value) return t('never')
      const raw = String(value)
      if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw
      const ms = Date.parse(raw)
      if (!Number.isFinite(ms)) return raw
      const date = new Date(ms)
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
    }

    function formatDate(value, t) {
      if (!value) return t('never')
      const raw = String(value)
      const ms = Date.parse(raw)
      if (!Number.isFinite(ms)) return raw.slice(0, 10)
      const date = new Date(ms)
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
    }

    function truncate(value, max) {
      const text = String(value ?? '')
      return text.length > max ? text.slice(0, Math.max(0, max - 1)) + '…' : text
    }

    function typeLabel(t, type) {
      if (type === 'user') return t('typeUser')
      if (type === 'feedback') return t('typeFeedback')
      if (type === 'project') return t('typeProject')
      if (type === 'reference') return t('typeReference')
      return type || t('unknown')
    }

    function scopeLabel(t, scope) {
      if (!scope || scope === 'all') return t('scopeAll')
      if (scope === 'global') return t('scopeGlobal')
      if (scope === 'workspace' || String(scope).startsWith('workspaces/')) return t('scopeWorkspace')
      return t('scopeOther', { scope })
    }

    function scopeOptionLabel(t, scope) {
      if (!scope || scope === 'all') return t('scopeAll')
      if (scope === 'global') return t('scopeGlobal')
      if (String(scope).startsWith('workspaces/')) {
        return t('scopeWorkspace') + ' · ' + String(scope).slice('workspaces/'.length)
      }
      return String(scope)
    }

    function tierLabel(t, tier) {
      if (tier === 'hot') return t('tierHot')
      if (tier === 'cold') return t('tierCold')
      if (tier === 'archived') return t('tierArchived')
      return tier || t('unknown')
    }

    function opLabel(t, op) {
      const map = {
        create: 'opCreate',
        update: 'opUpdate',
        archive: 'opArchive',
        restore: 'opRestore',
        merge: 'opMerge',
        retag: 'opRetag',
        undo: 'opUndo',
      }
      return map[op] ? t(map[op]) : op || t('unknown')
    }

    function actorLabel(t, actor) {
      if (actor === 'model') return t('actorModel')
      if (actor === 'user') return t('actorUser')
      if (actor === 'consolidate') return t('actorConsolidate')
      return actor || t('unknown')
    }

    function parseFrontmatter(text) {
      const source = String(text ?? '')
      const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/)
      if (!match) return { fields: {}, body: source, found: false }
      const fields = {}
      for (const line of match[1].split(/\r?\n/)) {
        const at = line.indexOf(':')
        if (at <= 0) continue
        const key = line.slice(0, at).trim()
        let value = line.slice(at + 1).trim()
        if (value.startsWith('[') && value.endsWith(']')) {
          fields[key] = value
            .slice(1, -1)
            .split(',')
            .map((part) => part.trim().replace(/^["']|["']$/g, ''))
            .filter(Boolean)
        } else if (value === 'true' || value === 'false') {
          fields[key] = value === 'true'
        } else {
          fields[key] = value.replace(/^["']|["']$/g, '')
        }
      }
      return { fields, body: match[2], found: true }
    }

    function setFrontmatterField(text, key, value) {
      const source = String(text ?? '')
      const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/)
      if (!match) return `---\n${key}: ${value}\n---\n\n${source}`
      const block = match[1]
      const lineRe = new RegExp(`^${key}:.*$`, 'm')
      const nextBlock = lineRe.test(block) ? block.replace(lineRe, `${key}: ${value}`) : `${block}\n${key}: ${value}`
      return source.slice(0, match.index) + `---\n${nextBlock}\n---` + source.slice(match.index + match[0].length)
    }

    function normalizeItem(raw, fallbackScope) {
      const source = raw && typeof raw === 'object' ? raw : {}
      const meta = source.meta && typeof source.meta === 'object' ? source.meta : {}
      const id = String(source.id || '')
      const idParts = id.includes('/') ? id.split('/') : []
      const scope = source.scope
        || meta.scope
        || (idParts.length > 1 ? idParts.slice(0, -1).join('/') : '')
        || fallbackScope
        || 'global'
      const name = source.name || meta.name || (idParts.length ? idParts[idParts.length - 1] : '') || ''
      const archived = Boolean(source.archived) || source.tier === 'archived' || meta.archived === true
      const tier = archived
        ? 'archived'
        : source.tier === 'hot' || source.tier === 'cold'
          ? source.tier
          : source.hot
            ? 'hot'
            : 'cold'
      const stats = source.stats && typeof source.stats === 'object' ? source.stats : null
      const rawLinks = asArray(source.links)
      const resolvedLinks = rawLinks
        .filter((link) => link && typeof link === 'object')
        .map((link) => ({
          scope: link.scope || scope,
          name: link.name || '',
          description: link.description || '',
        }))
        .filter((link) => link.name)
      const stringLinks = rawLinks.filter((link) => typeof link === 'string')
      const metaLinks = asArray(meta.links)
      const sameTag = asArray(source.sameTag)
        .map((entry) => {
          if (!entry || typeof entry !== 'object') return null
          return {
            scope: entry.scope || scope,
            name: entry.name || '',
            description: entry.description || '',
            tag: entry.tag || '',
          }
        })
        .filter((entry) => entry && entry.name)
      const type = source.type || meta.type
      const text = typeof source.text === 'string'
        ? source.text
        : typeof source.raw === 'string'
          ? source.raw
          : ''
      return {
        scope,
        name,
        description: String(source.description ?? meta.description ?? ''),
        type: TYPES.includes(type) ? type : (type || 'reference'),
        tags: asArray(source.tags ?? meta.tags),
        links: metaLinks.length ? metaLinks : stringLinks,
        resolvedLinks,
        sameTag,
        tier,
        heat: num(source.heat ?? stats?.heat ?? source.hits ?? stats?.hits, 0),
        hits: num(source.hits ?? stats?.hits ?? source.heat ?? stats?.heat, 0),
        pinned: Boolean(source.pinned ?? meta.pinned),
        stale: Boolean(source.stale ?? meta.stale),
        archived,
        created: source.created || meta.created || '',
        updated: source.updated || meta.updated || '',
        verifiedAt: source.verifiedAt || source.verified_at || meta.verified_at || '',
        lastUsed: source.lastUsed || source.last_used || stats?.lastUsed || '',
        source: source.source || meta.source || '',
        chars: source.bytes ?? source.chars ?? null,
        text,
        stats,
        path: source.path || '',
      }
    }

    function normalizeScopes(payload) {
      const raw = payload?.scopes ?? payload?.overview?.scopes
      let list = []
      if (Array.isArray(raw)) list = raw
      else if (raw && typeof raw === 'object') {
        list = Object.entries(raw).map(([scope, value]) => ({ scope, ...(value || {}) }))
      }
      return list.map((entry) => {
        const counts = entry.items || entry.counts || entry.stats || entry
        const budgetRaw = entry.budget || {}
        const used = num(budgetRaw.usedChars ?? budgetRaw.used ?? entry.usedChars)
        const total = num(budgetRaw.budgetChars ?? budgetRaw.budget ?? budgetRaw.limit ?? entry.budgetChars, 0)
        return {
          scope: entry.scope || entry.id || 'global',
          label: entry.label || '',
          total: num(counts.total ?? counts.all ?? entry.total),
          hot: num(counts.hot),
          cold: num(counts.cold),
          archived: num(counts.archived),
          stale: num(counts.stale),
          budget: total > 0 ? {
            used,
            total,
            ratio: Math.max(0, Math.min(1, num(budgetRaw.ratio ?? entry.budgetRatio, total > 0 ? used / total : 0))),
            pinnedChars: num(budgetRaw.pinnedChars ?? budgetRaw.pinned),
            pinnedOverflow: Boolean(budgetRaw.pinnedOverflow ?? entry.pinnedOverflow ?? entry.pinnedOverBudget),
          } : null,
          lastRun: entry.lastRun || entry.last_run || '',
          nextRun: entry.nextRun || entry.next_run || '',
        }
      })
    }

    function normalizeRun(raw) {
      const run = raw && typeof raw === 'object' ? raw : {}
      const progress = run.progress && typeof run.progress === 'object' ? run.progress : {}
      const rawState = String(run.status || run.state || 'running').toLowerCase()
      let state = 'running'
      if (['done', 'finished', 'success', 'succeeded', 'completed', 'complete'].includes(rawState)) state = 'done'
      else if (['error', 'failed', 'failure'].includes(rawState)) state = 'error'
      else if (['paused', 'suspended', 'preempted'].includes(rawState)) state = 'paused'
      else if (['canceled', 'cancelled', 'aborted'].includes(rawState)) state = 'canceled'
      else if (['queued', 'pending', 'running', 'started', 'active'].includes(rawState)) state = 'running'
      const log = asArray(run.log)
      const lastLog = log.length ? log[log.length - 1] : null
      const error = run.error && typeof run.error === 'object'
        ? (run.error.message || String(run.error))
        : (run.error || '')
      return {
        id: run.id || run.runId || '',
        mode: run.mode || run.kind || '',
        state,
        step: run.step || run.message || lastLog?.message || run.phase || progress.step || progress.message || '',
        done: num(run.done ?? progress.done ?? progress.current, 0),
        total: num(run.total ?? progress.total, 0),
        llmCalls: num(run.llmCalls ?? progress.llmCalls, 0),
        merged: num(progress.merged, 0),
        retagged: num(progress.retagged, 0),
        stale: num(progress.stale, 0),
        promoted: num(progress.promoted, 0),
        proposals: num(progress.proposals, 0),
        inbox: {
          reviewed: num(progress.inbox?.reviewed, 0),
          approved: num(progress.inbox?.approved, 0),
          rejected: num(progress.inbox?.rejected, 0),
          deferred: num(progress.inbox?.deferred, 0),
        },
        startedAt: run.startedAt || run.started_at || '',
        finishedAt: run.finishedAt || run.finished_at || '',
        reason: run.reason || '',
        phase: run.phase || '',
        log,
        error,
      }
    }

    function diffLines(before, after) {
      const oldLines = before ? String(before).replace(/\n$/, '').split('\n') : []
      const newLines = after ? String(after).replace(/\n$/, '').split('\n') : []
      if (!oldLines.length && !newLines.length) return []
      if (oldLines.length * newLines.length > 400000) {
        return [
          ...oldLines.map((text) => ({ kind: 'del', text, line: '' })),
          ...newLines.map((text) => ({ kind: 'add', text, line: '' })),
        ]
      }
      const rows = oldLines.length + 1
      const cols = newLines.length + 1
      const table = new Uint32Array(rows * cols)
      for (let i = oldLines.length - 1; i >= 0; i -= 1) {
        for (let j = newLines.length - 1; j >= 0; j -= 1) {
          table[i * cols + j] = oldLines[i] === newLines[j]
            ? table[(i + 1) * cols + j + 1] + 1
            : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1])
        }
      }
      const out = []
      let i = 0
      let j = 0
      let oldNo = 1
      let newNo = 1
      while (i < oldLines.length || j < newLines.length) {
        if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
          out.push({ kind: 'ctx', text: oldLines[i], line: newNo })
          i += 1
          j += 1
          oldNo += 1
          newNo += 1
        } else if (j < newLines.length && (i >= oldLines.length || table[i * cols + j + 1] > table[(i + 1) * cols + j])) {
          out.push({ kind: 'add', text: newLines[j], line: newNo })
          j += 1
          newNo += 1
        } else {
          out.push({ kind: 'del', text: oldLines[i], line: oldNo })
          i += 1
          oldNo += 1
        }
      }
      return out
    }

    /* ────────────────────────────── 数据通道 ────────────────────────────── */

    function queryString(params) {
      const search = new URLSearchParams()
      if (!params) return ''
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null || value === '' || value === 'all') continue
        search.set(key, String(value))
      }
      const text = search.toString()
      return text ? `?${text}` : ''
    }

    function isNetworkError(error) {
      return error?.name === 'TypeError'
        || /Failed to fetch|NetworkError|Load failed|fetch failed/i.test(String(error?.message || ''))
    }

    async function api(path, init) {
      const urls = [RELATIVE_ROUTE + path, ABSOLUTE_PATH + path]
      let lastNetworkError = null
      for (let index = 0; index < urls.length; index += 1) {
        try {
          const headers = init?.body ? { 'content-type': 'application/json' } : undefined
          const response = await fetch(urls[index], {
            credentials: 'same-origin',
            cache: 'no-store',
            headers,
            ...init,
          })
          const raw = await response.text()
          let payload = null
          try {
            payload = raw ? JSON.parse(raw) : null
          } catch (error) {
            throw new Error(response.ok ? '返回的不是 JSON' : `HTTP ${response.status}`)
          }
          if (payload?.error) {
            throw new Error(payload.error.message || `HTTP ${response.status}`)
          }
          if (!response.ok) {
            throw new Error(payload?.message || `HTTP ${response.status}`)
          }
          if (payload?.ok === false) {
            throw new Error(payload?.message || '请求失败')
          }
          return payload
        } catch (error) {
          if (isNetworkError(error) && index === 0) {
            lastNetworkError = error
            continue
          }
          throw error
        }
      }
      throw lastNetworkError || new Error('网络请求失败')
    }

    const API = {
      overview: () => api('/overview'),
      items: (params) => api('/items' + queryString(params)),
      item: (scope, name) => api('/item' + queryString({ scope, name })),
      saveItem: (scope, name, text) => api('/item', {
        method: 'POST',
        body: JSON.stringify({ scope, name, text }),
      }),
      archive: (scope, name) => api('/archive', { method: 'POST', body: JSON.stringify({ scope, name }) }),
      restore: (scope, name) => api('/restore', { method: 'POST', body: JSON.stringify({ scope, name }) }),
      journal: (limit) => api('/journal' + queryString({ limit: limit || 120 })),
      undo: (payload) => api('/undo', { method: 'POST', body: JSON.stringify(payload) }),
      inbox: () => api('/inbox'),
      decideInbox: (id, decision) => api('/inbox/' + encodeURIComponent(id), {
        method: 'POST',
        body: JSON.stringify({ decision }),
      }),
      settings: () => api('/settings'),
      saveSettings: (settings) => api('/settings', {
        method: 'POST',
        body: JSON.stringify({ settings }),
      }),
      run: (mode) => api('/run', { method: 'POST', body: JSON.stringify({ mode }) }),
      runStatus: (id) => api('/run/' + encodeURIComponent(id)),
      runs: () => api('/runs'),
      graph: () => api('/graph'),
      sessions: () => api('/sessions'),
    }

    /* ────────────────────────────── 通用小组件 ────────────────────────────── */

    function Loading(props) {
      return h('div', { className: 'dsh-memory-loading', role: 'status' }, [
        h('span', { className: 'dsh-memory-spinner', key: 's', 'aria-hidden': 'true' }),
        h('span', { key: 't' }, props.label || props.t('loading')),
      ])
    }

    function ErrorState(props) {
      const { t, error, onRetry, label } = props
      return h('div', { className: 'dsh-memory-state err' }, [
        h('div', { className: 'dsh-memory-state-title', key: 't' }, label || t('loadFailed', {
          message: error?.message || String(error || ''),
        })),
        onRetry
          ? h('button', { key: 'r', className: 'dsh-memory-btn', onClick: onRetry }, t('retry'))
          : null,
      ])
    }

    function EmptyState(props) {
      const body = props.text ?? (props.title ? '' : props.t('empty'))
      return h('div', { className: 'dsh-memory-state' }, [
        props.title ? h('div', { className: 'dsh-memory-state-title', key: 't' }, props.title) : null,
        body ? h('div', { key: 'b' }, body) : null,
        props.action || null,
      ])
    }

    function Note(props) {
      if (!props.note) return null
      return h('div', { className: `dsh-memory-note ${props.note.kind || 'info'}` }, props.note.text)
    }

    function Chip(props) {
      const className = ['dsh-memory-chip', props.variant, props.className].filter(Boolean).join(' ')
      return h('span', { className, title: props.title || undefined }, props.children)
    }

    function PinIcon(props) {
      const size = props.size || 11
      return h('svg', {
        className: 'dsh-memory-pin-icon',
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        'aria-hidden': 'true',
        focusable: 'false',
      }, h('path', {
        key: 'pin',
        d: 'M8 1a4.9 4.9 0 0 0-4.9 4.9c0 3.5 4.9 8.7 4.9 8.7s4.9-5.2 4.9-8.7A4.9 4.9 0 0 0 8 1Zm0 6.9a2 2 0 1 1 0-4 2 2 0 0 1 0 4Z',
        fill: 'currentColor',
        fillRule: 'evenodd',
      }))
    }

    function TypeChip(props) {
      return h(Chip, { variant: 'type-' + (props.item.type || 'reference'), title: props.t('fieldType') + ' · ' + typeLabel(props.t, props.item.type) },
        typeLabel(props.t, props.item.type))
    }

    function TierChip(props) {
      const tier = props.item.archived ? 'archived' : props.item.tier
      return h(Chip, { variant: 'tier-' + tier }, tierLabel(props.t, tier))
    }

    function ConfirmButton(props) {
      const [armed, setArmed] = React.useState(false)
      React.useEffect(() => {
        if (!armed) return undefined
        const timer = setTimeout(() => setArmed(false), 3200)
        return () => clearTimeout(timer)
      }, [armed])
      return h('button', {
        type: 'button',
        className: props.className || 'dsh-memory-btn small',
        disabled: props.disabled,
        title: props.title || undefined,
        onClick: (event) => {
          event.preventDefault()
          event.stopPropagation()
          if (props.disabled) return
          if (!armed) {
            setArmed(true)
            return
          }
          setArmed(false)
          props.onConfirm?.()
        },
      }, armed ? props.t('undoArmed') : props.children)
    }

    function useAsync(loader, deps) {
      const [state, setState] = React.useState({ loading: true, data: null, error: null })
      const seq = React.useRef(0)
      const run = React.useCallback(async () => {
        const id = ++seq.current
        setState((prev) => ({ ...prev, loading: true, error: null }))
        try {
          const data = await loader()
          if (seq.current === id) setState({ loading: false, data, error: null })
        } catch (error) {
          if (seq.current === id) {
            setState((prev) => ({ loading: false, data: prev.data, error }))
          }
        }
      }, deps) // eslint-disable-line react-hooks/exhaustive-deps
      React.useEffect(() => {
        run()
        return () => { seq.current += 1 }
      }, [run])
      return { ...state, reload: run }
    }

    function DiffView(props) {
      const { t, before, after } = props
      const lines = React.useMemo(() => diffLines(before, after), [before, after])
      if (!lines.length) {
        return h('div', { className: 'dsh-memory-state' }, t('diffEmpty'))
      }
      return h('div', { className: 'dsh-memory-diff', role: 'table', 'aria-label': t('proposalDiffTitle') },
        lines.map((line, index) => h('div', {
          className: `dsh-memory-diff-line ${line.kind}`,
          key: `${index}-${line.kind}`,
          role: 'row',
        }, [
          h('span', { className: 'dsh-memory-diff-gutter', key: 'g', 'aria-hidden': 'true' }, line.line),
          h('span', { className: 'dsh-memory-diff-sign', key: 's', 'aria-hidden': 'true' },
            line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '),
          h('span', { className: 'dsh-memory-diff-text', key: 't' }, line.text || ' '),
        ])))
    }

    /* ────────────────────────────── 概览 ────────────────────────────── */

    function OverviewTab(props) {
      const { t, query, onOpenGraph, onGoInbox } = props
      const data = query.data
      const scopes = React.useMemo(() => normalizeScopes(data), [data])

      if (query.loading && !data) return h(Loading, { t })
      if (query.error && !data) {
        return h(ErrorState, { t, error: query.error, onRetry: query.reload })
      }

      const warnings = [
        ...asArray(data?.errors).map((error) => ({
          level: 'error',
          scope: error?.scope || '',
          message: String(error?.message || error?.text || error || ''),
        })),
        ...asArray(data?.warnings).map((warning) => {
          if (typeof warning === 'string') return { level: 'warn', message: warning, scope: '' }
          return {
            level: warning?.level || (warning?.code === 'last-error' ? 'error' : 'warn'),
            message: String(warning?.message || warning?.text || ''),
            scope: warning?.scope || '',
          }
        }),
      ].filter((warning) => warning.message)

      const inboxRaw = data?.inbox
      const inboxCount = typeof inboxRaw === 'number'
        ? inboxRaw
        : Array.isArray(inboxRaw)
          ? inboxRaw.length
          : num(inboxRaw?.count ?? inboxRaw?.total ?? data?.inboxCount, 0)
      const schedule = data?.schedule && typeof data.schedule === 'object' ? data.schedule : {}
      const globalLastRun = data?.lastRun
        || schedule.lastRun?.finishedAt
        || schedule.lastRun?.startedAt
        || schedule.lastLight
        || schedule.lastDeep
        || data?.last_run
        || ''
      const globalNextRun = data?.nextRun || schedule.nextRun || data?.next_run || ''

      if (!scopes.length) {
        return h(EmptyState, { t, title: t('overviewEmpty') })
      }
      const allEmpty = scopes.every((scope) => scope.total === 0 && scope.archived === 0)

      return h('div', null, [
        h('div', { className: 'dsh-memory-overview-actions', key: 'actions' }, [
          h('button', {
            key: 'graph',
            className: 'dsh-memory-btn primary',
            onClick: onOpenGraph,
          }, t('openGraph')),
        ]),
        query.error
          ? h('div', { key: 'e', className: 'dsh-memory-note err' }, t('loadFailed', {
              message: query.error.message || String(query.error),
            }))
          : null,
        query.loading
          ? h('div', { key: 'r', className: 'dsh-memory-meta', style: { marginBottom: 8 } }, [
              h('span', { className: 'dsh-memory-spinner', key: 's', 'aria-hidden': 'true' }),
              h('span', { key: 't' }, t('refreshing')),
            ])
          : null,
        allEmpty
          ? h(EmptyState, { key: 'empty', t, title: t('overviewEmpty') })
          : h('div', { className: 'dsh-memory-scopes', key: 'scopes' },
          scopes.map((scope) => {
            const budget = scope.budget
            const pct = budget ? Math.round(budget.ratio * 100) : 0
            const warn = budget && (budget.ratio >= 0.85 || budget.pinnedOverflow)
            return h('section', { className: 'dsh-memory-scope', key: scope.scope }, [
              h('div', { className: 'dsh-memory-scope-top', key: 'top' }, [
                h('div', { key: 'name' }, [
                  h('div', { className: 'dsh-memory-scope-name', key: 'n' },
                    scope.scope === 'global' ? (scope.label || t('scopeGlobal')) : t('scopeWorkspace')),
                  h('div', { className: 'dsh-memory-scope-code', key: 'c' },
                    scope.scope === 'global'
                      ? 'global'
                      : String(scope.scope).startsWith('workspaces/')
                        ? String(scope.scope).slice('workspaces/'.length)
                        : (scope.label || scope.scope)),
                ]),
                scope.stale
                  ? h(Chip, { key: 's', title: t('staleHint') }, t('statStale') + ' ' + scope.stale)
                  : null,
              ]),
              h('div', { className: 'dsh-memory-stat-grid', key: 'stats' }, [
                h(Stat, { key: 'total', n: scope.total, label: t('statTotal') }),
                h(Stat, { key: 'hot', n: scope.hot, label: t('statHot') }),
                h(Stat, { key: 'cold', n: scope.cold, label: t('statCold') }),
                h(Stat, { key: 'archived', n: scope.archived, label: t('statArchived') }),
                h(Stat, { key: 'stale', n: scope.stale, label: t('statStale') }),
              ]),
              budget
                ? h('div', { className: 'dsh-memory-budget', key: 'budget' }, [
                    h('div', { className: 'dsh-memory-budget-head', key: 'h' }, [
                      h('span', { key: 'l' }, t('budgetTitle')),
                      h('span', { key: 'p' }, `${pct}%`),
                    ]),
                    h('div', { className: 'dsh-memory-budget-track', key: 'track' },
                      h('div', {
                        className: 'dsh-memory-budget-fill' + (warn ? ' warn' : ''),
                        style: { width: pct > 0 ? Math.max(2, Math.min(100, pct)) + '%' : '0%' },
                      })),
                    h('div', { className: 'dsh-memory-meta', key: 'usage', style: { marginTop: 4 } },
                      t('budgetUsage', {
                        used: budget.used.toLocaleString(),
                        budget: budget.total.toLocaleString(),
                        pct,
                      })),
                    budget.pinnedChars
                      ? h('div', { className: 'dsh-memory-meta', key: 'pinned' }, t('budgetPinned', { n: budget.pinnedChars }))
                      : null,
                    budget.pinnedOverflow
                      ? h('div', { className: 'dsh-memory-note warn', key: 'overflow' }, t('budgetOverflow'))
                      : null,
                  ])
                : null,
              h('div', { className: 'dsh-memory-meta', key: 'times' }, [
                h('span', { key: 'last' }, `${t('lastRun')} · ${formatDateTime(scope.lastRun || globalLastRun, t)}`),
                h('span', { key: 'next' }, `${t('nextRun')} · ${formatDateTime(scope.nextRun || globalNextRun, t)}`),
              ]),
            ])
          }),
        ),
        h('section', { className: 'dsh-memory-card', key: 'inbox', style: { marginTop: 12 } }, [
          h('div', { className: 'dsh-memory-card-hd', key: 'hd' }, [
            h('h3', { className: 'dsh-memory-card-title', key: 't' }, t('inboxTitle')),
            inboxCount
              ? h('button', { key: 'b', className: 'dsh-memory-btn small', onClick: onGoInbox }, t('goInbox'))
              : null,
          ]),
          h('div', { className: 'dsh-memory-inbox-card', key: 'body' }, [
            h('div', { className: 'dsh-memory-inbox-num', key: 'n' }, String(inboxCount)),
            h('div', { className: 'dsh-memory-meta', key: 'l', style: { fontSize: 12 } },
              inboxCount ? t('inboxPending', { n: inboxCount }) : t('inboxNone')),
          ]),
        ]),
        h('section', { className: 'dsh-memory-card', key: 'warnings', style: { marginTop: 12 } }, [
          h('h3', { className: 'dsh-memory-card-title', key: 't', style: { marginBottom: 9 } }, t('warningsTitle')),
          warnings.length
            ? warnings.map((warning, index) => h('div', {
                className: `dsh-memory-warning ${warning.level}`,
                key: index,
              }, [
                h('span', { className: 'dsh-memory-warning-level', key: 'lv' }, warning.level === 'info' ? 'INFO' : warning.level === 'error' ? 'ERR' : 'WARN'),
                h('span', { key: 'msg' }, warning.message),
              ]))
            : h('div', { key: 'none', className: 'dsh-memory-meta' }, t('noWarnings')),
        ]),
      ])
    }

    function Stat(props) {
      return h('div', { className: 'dsh-memory-stat' }, [
        h('div', { className: 'dsh-memory-stat-num', key: 'n' }, String(props.n)),
        h('div', { className: 'dsh-memory-stat-label', key: 'l' }, props.label),
      ])
    }

    /* ────────────────────────────── 记忆文件 ────────────────────────────── */

    function Field(props) {
      return h('label', { className: 'dsh-memory-field' }, [
        h('span', { className: 'dsh-memory-field-label', key: 'l' }, props.label),
        props.children,
        props.hint ? h('span', { className: 'dsh-memory-field-hint', key: 'h' }, props.hint) : null,
      ])
    }

    function FilesTab(props) {
      const { t, refreshToken, target, onRefresh } = props
      const [filters, setFilters] = React.useState({ scope: 'all', tier: 'all', type: 'all', tag: 'all' })
      const [search, setSearch] = React.useState('')
      const [debounced, setDebounced] = React.useState('')

      React.useEffect(() => {
        const timer = setTimeout(() => setDebounced(search.trim()), 260)
        return () => clearTimeout(timer)
      }, [search])

      const listQuery = useAsync(
        () => API.items({ ...filters, q: debounced }),
        [filters.scope, filters.tier, filters.type, filters.tag, debounced, refreshToken],
      )
      const facetQuery = useAsync(() => API.items({}), [refreshToken])

      const items = React.useMemo(
        () => asArray(listQuery.data?.items ?? listQuery.data?.data).map((item) => normalizeItem(item)),
        [listQuery.data],
      )
      const facetItems = React.useMemo(
        () => asArray(facetQuery.data?.items ?? facetQuery.data?.data).map((item) => normalizeItem(item)),
        [facetQuery.data],
      )

      const tagOptions = React.useMemo(() => {
        const tags = new Set()
        for (const item of facetItems) for (const tag of item.tags) tags.add(tag)
        for (const item of items) for (const tag of item.tags) tags.add(tag)
        return [...tags].sort((a, b) => String(a).localeCompare(String(b), 'zh-CN'))
      }, [facetItems, items])

      const scopeOptions = React.useMemo(() => {
        const scopes = new Set()
        for (const item of facetItems) scopes.add(item.scope)
        for (const item of items) scopes.add(item.scope)
        if (!scopes.size) scopes.add('global')
        return [...scopes]
      }, [facetItems, items])

      const [selection, setSelection] = React.useState(null)
      const [detail, setDetail] = React.useState({ loading: false, data: null, error: null })
      const [text, setText] = React.useState('')
      const [baseText, setBaseText] = React.useState('')
      const [panelNote, setPanelNote] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [pending, setPending] = React.useState(null)
      const detailSeq = React.useRef(0)
      const dirty = Boolean(detail.data) && text !== baseText

      const loadDetail = React.useCallback(async (nextSelection) => {
        if (!nextSelection) return
        const seq = ++detailSeq.current
        setSelection(nextSelection)
        setPending(null)
        setDetail({ loading: true, data: null, error: null })
        setPanelNote(null)
        setText('')
        setBaseText('')
        // 归档条目不在活动目录里，GET /item 读不到正文；先用列表摘要展示，
        // 恢复后再重新请求完整条目。后端契约见 docs/API-CHANGES.md。
        if (nextSelection.archived && nextSelection.summary) {
          const summary = nextSelection.summary
          setDetail({
            loading: false,
            data: {
              item: { ...summary, archived: true, tier: 'archived' },
              raw: null,
              text: '',
              archivedOnly: true,
            },
            error: null,
          })
          return
        }
        try {
          const payload = await API.item(nextSelection.scope, nextSelection.name)
          if (detailSeq.current !== seq) return
          const rawItem = payload?.item ?? payload?.data ?? payload
          const item = normalizeItem(rawItem, nextSelection.scope)
          const rawText = String(payload?.text ?? rawItem?.text ?? rawItem?.raw ?? item.text ?? '')
          if (item.chars === null && rawText) item.chars = byteLength(rawText)
          setDetail({ loading: false, data: { item, raw: rawItem, text: rawText }, error: null })
          setText(rawText)
          setBaseText(rawText)
        } catch (error) {
          if (detailSeq.current === seq) setDetail({ loading: false, data: null, error })
        }
      }, [])

      const choose = React.useCallback((scope, name) => {
        if (!scope || !name) return
        if (selection && selection.scope === scope && selection.name === name) return
        const summary = items.find((item) => item.scope === scope && item.name === name)
          || facetItems.find((item) => item.scope === scope && item.name === name)
          || null
        const nextSelection = {
          scope,
          name,
          archived: Boolean(summary?.archived) || summary?.tier === 'archived',
          summary,
        }
        if (dirty) {
          setPending(nextSelection)
          return
        }
        loadDetail(nextSelection)
      }, [selection, dirty, loadDetail, items, facetItems])

      const chooseRef = React.useRef(choose)
      chooseRef.current = choose

      React.useEffect(() => () => { detailSeq.current += 1 }, [])

      React.useEffect(() => {
        if (target?.scope && target?.name) chooseRef.current(target.scope, target.name)
      }, [target?.seq, target?.scope, target?.name])

      React.useEffect(() => {
        if (selection || target || !items.length) return
        chooseRef.current(items[0].scope, items[0].name)
      }, [items, selection, target])

      const persist = React.useCallback(async (nextText) => {
        if (!selection) return false
        if (detail.data?.item?.archived) {
          setPanelNote({ kind: 'warn', text: t('archiveHint') })
          return false
        }
        const parsed = parseFrontmatter(nextText)
        const nextName = String(parsed.fields.name || '')
        if (!NAME_RE.test(nextName)) {
          setPanelNote({ kind: 'err', text: t('nameInvalid') })
          return false
        }
        if (nextName !== selection.name) {
          setPanelNote({ kind: 'err', text: t('nameMismatch') })
          return false
        }
        setBusy(true)
        setPanelNote(null)
        try {
          const payload = await API.saveItem(selection.scope, selection.name, nextText)
          const rawItem = payload?.item ?? payload?.data ?? payload
          const item = normalizeItem(rawItem, selection.scope)
          const rawText = String(payload?.text ?? rawItem?.text ?? rawItem?.raw ?? nextText)
          if (item.chars === null && rawText) item.chars = byteLength(rawText)
          setDetail({ loading: false, data: { item, raw: rawItem, text: rawText }, error: null })
          setText(rawText)
          setBaseText(rawText)
          setPanelNote({ kind: 'ok', text: t('saved') })
          listQuery.reload()
          facetQuery.reload()
          onRefresh?.()
          return true
        } catch (error) {
          setPanelNote({ kind: 'err', text: t('saveFailed', { message: error?.message || String(error) }) })
          return false
        } finally {
          setBusy(false)
        }
      }, [selection, detail.data?.item?.archived, t, listQuery.reload, facetQuery.reload, onRefresh])

      const save = () => persist(text)

      const saveAndSwitch = async () => {
        if (!pending) return
        const nextSelection = pending
        const ok = await persist(text)
        if (ok) loadDetail(nextSelection)
      }

      const togglePin = () => {
        if (!detail.data) return
        if (dirty) {
          setPanelNote({ kind: 'warn', text: t('dirtyBlockedAction') })
          return
        }
        const nextText = setFrontmatterField(text, 'pinned', detail.data.item.pinned ? 'false' : 'true')
        persist(nextText)
      }

      const setArchived = async (archived) => {
        if (!detail.data || !selection) return
        if (dirty) {
          setPanelNote({ kind: 'warn', text: t('dirtyBlockedAction') })
          return
        }
        setBusy(true)
        setPanelNote(null)
        try {
          const payload = await (archived
            ? API.archive(selection.scope, selection.name)
            : API.restore(selection.scope, selection.name))
          if (archived) {
            setDetail((prev) => (prev.data
              ? {
                  ...prev,
                  data: {
                    ...prev.data,
                    item: { ...prev.data.item, archived: true, tier: 'archived' },
                  },
                }
              : prev))
            setPanelNote({
              kind: 'ok',
              text: payload?.message || t('archiveDone'),
            })
          } else {
            // 归档条目没有正文；恢复后重新 GET 一次拿到完整条目。
            await loadDetail({ scope: selection.scope, name: selection.name })
            setPanelNote({ kind: 'ok', text: t('restoreDone') })
          }
          listQuery.reload()
          facetQuery.reload()
          onRefresh?.()
        } catch (error) {
          setPanelNote({ kind: 'err', text: t('actionFailed', { message: error?.message || String(error) }) })
        } finally {
          setBusy(false)
        }
      }

      const item = detail.data?.item || null
      const itemStats = detail.data?.raw?.stats || item?.stats || null
      const relatedLinks = item
        ? (item.resolvedLinks.length
            ? item.resolvedLinks.map((link) => ({
                scope: link.scope,
                name: link.name,
                cross: link.scope !== item.scope,
                description: link.description,
              }))
            : item.links.map((link) => {
                const raw = String(link)
                if (raw.includes(':')) {
                  const at = raw.indexOf(':')
                  return { scope: raw.slice(0, at), name: raw.slice(at + 1), cross: true, description: '' }
                }
                return { scope: item.scope, name: raw, cross: false, description: '' }
              }))
        : []
      const sameTagItems = item
        ? (item.sameTag.length
            ? item.sameTag.slice(0, 10)
            : (!item.archived
                ? facetItems
                    .filter((other) => !(other.scope === item.scope && other.name === item.name))
                    .filter((other) => other.tags.some((tag) => item.tags.includes(tag)))
                    .slice(0, 10)
                : []))
        : []

      const setFilter = (key, value) => setFilters((prev) => ({ ...prev, [key]: value }))

      /* 左栏 */
      const listPane = h('div', { className: 'dsh-memory-list-pane', key: 'list' }, [
        h('div', { className: 'dsh-memory-filters', key: 'filters' }, [
          h('input', {
            key: 'search',
            type: 'search',
            className: 'dsh-memory-input dsh-memory-search',
            placeholder: t('searchPlaceholder'),
            value: search,
            'aria-label': t('searchPlaceholder'),
            onChange: (event) => setSearch(event.target.value),
          }),
          h('div', { className: 'dsh-memory-filter-row', key: 'row1' }, [
            h('select', {
              key: 'scope',
              className: 'dsh-memory-select',
              value: filters.scope,
              'aria-label': t('filterScope'),
              onChange: (event) => setFilter('scope', event.target.value),
            }, [
              h('option', { key: 'all', value: 'all' }, t('scopeAll')),
              ...scopeOptions.map((scope) => h('option', { key: scope, value: scope }, scopeOptionLabel(t, scope))),
            ]),
            h('select', {
              key: 'tier',
              className: 'dsh-memory-select',
              value: filters.tier,
              'aria-label': t('tierAll'),
              onChange: (event) => setFilter('tier', event.target.value),
            }, [
              h('option', { key: 'all', value: 'all' }, t('tierAll')),
              h('option', { key: 'hot', value: 'hot' }, t('tierHot')),
              h('option', { key: 'cold', value: 'cold' }, t('tierCold')),
              h('option', { key: 'archived', value: 'archived' }, t('tierArchived')),
            ]),
          ]),
          h('div', { className: 'dsh-memory-filter-row', key: 'row2' }, [
            h('select', {
              key: 'type',
              className: 'dsh-memory-select',
              value: filters.type,
              'aria-label': t('typeAll'),
              onChange: (event) => setFilter('type', event.target.value),
            }, [
              h('option', { key: 'all', value: 'all' }, t('typeAll')),
              ...TYPES.map((type) => h('option', { key: type, value: type }, typeLabel(t, type))),
            ]),
            h('select', {
              key: 'tag',
              className: 'dsh-memory-select',
              value: filters.tag,
              'aria-label': t('tagAll'),
              onChange: (event) => setFilter('tag', event.target.value),
            }, [
              h('option', { key: 'all', value: 'all' }, t('tagAll')),
              ...tagOptions.map((tag) => h('option', { key: tag, value: tag }, tag)),
            ]),
          ]),
        ]),
        h('div', { className: 'dsh-memory-resultbar', key: 'count' }, [
          h('span', { key: 'n' }, t('resultCount', { n: items.length })),
          listQuery.loading ? h('span', { key: 'l', className: 'dsh-memory-meta' }, t('refreshing')) : null,
          listQuery.error && items.length
            ? h('span', { key: 'e', className: 'dsh-memory-meta', style: { color: 'var(--dsw-alias-state-error-primary, #c0392b)' } },
                t('loadFailed', { message: listQuery.error.message || String(listQuery.error) }))
            : null,
        ]),
        h('div', { className: 'dsh-memory-list', key: 'rows', role: 'listbox', 'aria-label': t('tabFiles') },
          listQuery.loading && !items.length
            ? h('div', { className: 'dsh-memory-list-state', key: 'loading' }, h(Loading, { t }))
            : listQuery.error && !items.length
              ? h('div', { className: 'dsh-memory-list-state', key: 'error' }, [
                  h('div', { key: 'm' }, t('loadFailed', { message: listQuery.error.message || String(listQuery.error) })),
                  h('button', {
                    key: 'r',
                    className: 'dsh-memory-btn small',
                    style: { marginTop: 7 },
                    onClick: listQuery.reload,
                  }, t('retry')),
                ])
              : items.length
                ? items.map((entry) => h('button', {
                    key: `${entry.scope}/${entry.name}`,
                    type: 'button',
                    role: 'option',
                    className: 'dsh-memory-row',
                    'aria-selected': selection && selection.scope === entry.scope && selection.name === entry.name
                      ? 'true'
                      : 'false',
                    onClick: () => choose(entry.scope, entry.name),
                  }, [
                    h('div', { className: 'dsh-memory-row-top', key: 'top' }, [
                      h('span', { className: 'dsh-memory-row-name', key: 'name', title: entry.name }, entry.name),
                      h('span', { className: 'dsh-memory-row-marks', key: 'marks' }, [
                        entry.pinned
                          ? h('span', { key: 'p', className: 'dsh-memory-mark', title: t('pinned') },
                              h(PinIcon, { key: 'i', size: 11 }))
                          : null,
                        entry.stale
                          ? h('span', { key: 's', className: 'dsh-memory-mark stale', title: t('staleHint') }, t('staleMark'))
                          : null,
                      ]),
                    ]),
                    h('div', { className: 'dsh-memory-row-desc', key: 'desc' }, entry.description || '—'),
                    h('div', { className: 'dsh-memory-row-meta', key: 'meta' }, [
                      h(TypeChip, { key: 'type', item: entry, t }),
                      h(TierChip, { key: 'tier', item: entry, t }),
                      ...entry.tags.slice(0, 2).map((tag) => h(Chip, { key: 'tag-' + tag, variant: 'tag' }, tag)),
                      h('span', { className: 'dsh-memory-meta', key: 'heat' }, `${t('fieldHeat')} ${entry.heat}`),
                      h('span', { className: 'dsh-memory-meta', key: 'date' },
                        formatDate(entry.lastUsed || entry.updated, t)),
                    ]),
                  ]))
                : h('div', { className: 'dsh-memory-list-state', key: 'empty' }, t('noResults')),
        ),
      ])

      /* 右栏 */
      let detailPane
      if (!selection) {
        detailPane = h('div', { className: 'dsh-memory-detail-empty', key: 'empty' }, t('selectHint'))
      } else if (detail.loading && !detail.data) {
        detailPane = h('div', { className: 'dsh-memory-detail-empty', key: 'loading' }, h(Loading, { t, label: t('detailLoading') }))
      } else if (detail.error && !detail.data) {
        detailPane = h('div', { className: 'dsh-memory-detail', key: 'error' },
          h(ErrorState, { t, error: detail.error, onRetry: () => loadDetail(selection) }))
      } else if (detail.data && item) {
        const fields = [
          [t('fieldType'), typeLabel(t, item.type)],
          [t('fieldScope'), scopeLabel(t, item.scope)],
          [t('fieldPinned'), item.pinned ? t('pinned') : '—'],
          [t('fieldCreated'), formatDate(item.created, t)],
          [t('fieldUpdated'), formatDate(item.updated, t)],
          [t('fieldVerified'), formatDate(item.verifiedAt, t)],
          [t('fieldSource'), item.source || '—'],
        ]
        const usage = [
          [t('fieldHeat'), String(item.heat)],
          [t('fieldHits'), String(itemStats?.hits ?? item.hits)],
          [t('fieldLastUsed'), formatDateTime(itemStats?.lastUsed || item.lastUsed, t)],
          [t('fieldChars'), item.chars !== null ? `${item.chars} B` : '—'],
        ]
        detailPane = h('div', { className: 'dsh-memory-detail', key: 'detail' }, [
          h('div', { className: 'dsh-memory-detail-hd', key: 'hd' }, [
            h('div', { className: 'dsh-memory-detail-title', key: 'name' }, item.name),
            h('div', { className: 'dsh-memory-detail-desc', key: 'desc' }, item.description || '—'),
            h('div', { className: 'dsh-memory-detail-badges', key: 'badges' }, [
              h(TypeChip, { key: 'type', item, t }),
              h(TierChip, { key: 'tier', item, t }),
              h(Chip, { key: 'scope', title: item.scope }, scopeLabel(t, item.scope)),
              item.pinned
                ? h(Chip, { key: 'pin' }, [h(PinIcon, { key: 'i', size: 10 }), h('span', { key: 't' }, t('pinned'))])
                : null,
              item.stale ? h(Chip, { key: 'stale' }, t('staleMark') + ' ' + t('statStale')) : null,
            ]),
            h('div', { className: 'dsh-memory-detail-actions', key: 'actions' }, [
              item.archived
                ? null
                : h('button', {
                    key: 'pin',
                    className: 'dsh-memory-btn small',
                    disabled: busy,
                    title: dirty ? t('dirtyBlockedAction') : undefined,
                    onClick: togglePin,
                  }, item.pinned ? t('unpin') : t('pin')),
              item.archived
                ? h('button', {
                    key: 'restore',
                    className: 'dsh-memory-btn small',
                    disabled: busy,
                    onClick: () => setArchived(false),
                  }, t('restoreAction'))
                : h('button', {
                    key: 'archive',
                    className: 'dsh-memory-btn small danger',
                    disabled: busy,
                    onClick: () => setArchived(true),
                  }, t('archiveAction')),
            ]),
          ]),
          h('div', { className: 'dsh-memory-detail-body', key: 'body' }, [
            pending
              ? h('div', { className: 'dsh-memory-guard', key: 'guard' }, [
                  h('div', { className: 'dsh-memory-guard-txt', key: 'txt' }, [
                    h('div', { className: 'dsh-memory-guard-title', key: 't' }, t('unsavedSwitchTitle')),
                    h('div', { key: 'b' }, t('unsavedSwitchBody')),
                  ]),
                  h('button', { key: 'discard', className: 'dsh-memory-btn small', onClick: () => loadDetail(pending) }, t('discardSwitch')),
                  h('button', { key: 'save', className: 'dsh-memory-btn small primary', disabled: busy, onClick: saveAndSwitch }, t('saveAndSwitch')),
                  h('button', { key: 'cancel', className: 'dsh-memory-btn small ghost', onClick: () => setPending(null) }, t('cancel')),
                ])
              : null,
            item.archived
              ? h('div', { className: 'dsh-memory-note info', key: 'archived' }, t('archiveHint'))
              : null,
            item.stale
              ? h('div', { className: 'dsh-memory-note warn', key: 'stale' }, t('staleHint'))
              : null,
            h('div', { className: 'dsh-memory-meta-grid', key: 'fields' },
              fields.map(([label, value]) => h('div', { className: 'dsh-memory-meta-item', key: label }, [
                h('div', { className: 'dsh-memory-meta-k', key: 'k' }, label),
                h('div', { className: 'dsh-memory-meta-v', key: 'v' }, value),
              ]))),
            h('div', { className: 'dsh-memory-subhead', key: 'tags-h' }, t('fieldTags')),
            h('div', { className: 'dsh-memory-related', key: 'tags' },
              item.tags.length
                ? item.tags.map((tag) => h(Chip, { key: tag, variant: 'tag' }, tag))
                : h('span', { className: 'dsh-memory-meta' }, '—')),
            relatedLinks.length
              ? h('div', { key: 'links-block' }, [
                  h('div', { className: 'dsh-memory-subhead', key: 'h' }, t('fieldLinks')),
                  h('div', { className: 'dsh-memory-related', key: 'l' },
                    relatedLinks.map((link) => h('button', {
                      key: link.scope + '/' + link.name,
                      type: 'button',
                      className: 'dsh-memory-related-btn',
                      title: link.description || (link.scope === item.scope ? link.name : `${link.scope}/${link.name}`),
                      onClick: () => choose(link.scope, link.name),
                    }, (link.cross ? link.scope + ':' : '') + link.name))),
                ])
              : null,
            h('div', { className: 'dsh-memory-subhead', key: 'stats-h' }, t('statsTitle')),
            h('div', { className: 'dsh-memory-meta-grid', key: 'stats' },
              usage.map(([label, value]) => h('div', { className: 'dsh-memory-meta-item', key: label }, [
                h('div', { className: 'dsh-memory-meta-k', key: 'k' }, label),
                h('div', { className: 'dsh-memory-meta-v', key: 'v' }, value),
              ]))),
            h('div', { className: 'dsh-memory-subhead', key: 'editor-h' }, t('editorLabel')),
            item.archived
              ? (text
                  ? h('pre', { key: 'readonly', className: 'dsh-memory-readonly' }, text)
                  : h('div', { key: 'nobody', className: 'dsh-memory-state' }, t('archivedNoBody')))
              : h(React.Fragment, { key: 'editable' }, [
                  h('textarea', {
                    key: 'editor',
                    className: 'dsh-memory-editor',
                    value: text,
                    spellCheck: false,
                    'aria-label': t('editorLabel'),
                    onChange: (event) => setText(event.target.value),
                  }),
                  h('div', { className: 'dsh-memory-savebar', key: 'savebar' }, [
                    h('button', {
                      key: 'save',
                      className: 'dsh-memory-btn primary',
                      disabled: busy || !dirty,
                      onClick: save,
                    }, busy ? t('saving') : t('save')),
                    dirty ? h('span', { key: 'dirty', className: 'dsh-memory-dirty' }, t('unsaved')) : null,
                    h('span', { key: 'grow', className: 'dsh-memory-grow' }),
                    h('span', { key: 'chars', className: 'dsh-memory-meta' }, t('chars', { n: text.length })),
                  ]),
                  h('div', { key: 'savehint', className: 'dsh-memory-meta', style: { marginTop: 6 } }, t('saveHint')),
                ]),
            h(Note, { key: 'note', note: panelNote, t }),
            relatedLinks.length || sameTagItems.length
              ? h('div', { key: 'related' }, [
                  h('div', { className: 'dsh-memory-subhead', key: 'h' }, t('relatedTitle')),
                  relatedLinks.length
                    ? h('div', { className: 'dsh-memory-related-group', key: 'links' }, [
                        h('div', { className: 'dsh-memory-related-label', key: 'l' }, t('relatedLinks')),
                        h('div', { className: 'dsh-memory-related', key: 'b' },
                          relatedLinks.map((link) => h('button', {
                            key: 'link-' + link.scope + '/' + link.name,
                            type: 'button',
                            className: 'dsh-memory-related-btn',
                            title: link.description || undefined,
                            onClick: () => choose(link.scope, link.name),
                          }, (link.cross ? link.scope + ':' : '') + link.name))),
                      ])
                    : null,
                  sameTagItems.length
                    ? h('div', { className: 'dsh-memory-related-group', key: 'tags' }, [
                        h('div', { className: 'dsh-memory-related-label', key: 'l' }, t('relatedTags')),
                        h('div', { className: 'dsh-memory-related', key: 'b' },
                          sameTagItems.map((other) => h('button', {
                            key: 'related-' + other.scope + '/' + other.name,
                            type: 'button',
                            className: 'dsh-memory-related-btn',
                            title: other.description,
                            onClick: () => choose(other.scope, other.name),
                          }, other.name))),
                      ])
                    : null,
                ])
              : null,
          ]),
        ])
      } else {
        detailPane = h('div', { className: 'dsh-memory-detail-empty', key: 'empty' }, t('selectHint'))
      }

      return h('div', null, [
        h('p', { className: 'dsh-memory-lead', key: 'lead', style: { marginBottom: 12 } }, t('filesLead')),
        h('div', { className: 'dsh-memory-files', key: 'files' }, [listPane, detailPane]),
      ])
    }

    /* ────────────────────────────── 会话记忆 ────────────────────────────── */

    function SessionsTab(props) {
      const { t, refreshToken } = props
      const query = useAsync(() => API.sessions(), [refreshToken])
      const sessions = React.useMemo(() => {
        const list = asArray(query.data?.sessions ?? query.data?.data).map((raw) => {
          const notes = asArray(raw.notes).map((note) => ({
            id: String(note.id || note.at || Math.random()),
            kind: note.kind || 'fact',
            text: String(note.text || note.content || ''),
            at: note.at || '',
          }))
          const promoted = asArray(raw.promoted)
          return {
            sessionId: String(raw.sessionId || raw.id || ''),
            workspace: String(raw.workspace || raw.workspaceKey || ''),
            updatedAt: raw.updatedAt
              || raw.updated_at
              || raw.at
              || (Number.isFinite(Number(raw.mtime)) ? new Date(Number(raw.mtime)).toISOString() : ''),
            notes,
            promoted,
          }
        })
        return list.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))
      }, [query.data])

      if (query.loading && !query.data) return h(Loading, { t })
      if (query.error && !query.data) return h(ErrorState, { t, error: query.error, onRetry: query.reload })

      return h('div', null, [
        h('p', { className: 'dsh-memory-lead', key: 'lead', style: { marginBottom: 12 } }, t('sessionsLead')),
        query.loading
          ? h('div', { key: 'loading', className: 'dsh-memory-meta', style: { marginBottom: 8 } }, t('refreshing'))
          : null,
        query.error
          ? h('div', { key: 'err', className: 'dsh-memory-note err' },
              t('loadFailed', { message: query.error.message || String(query.error) }))
          : null,
        sessions.length
          ? h('div', { key: 'list' }, sessions.map((session, index) => h('section', {
              className: 'dsh-memory-card',
              key: session.sessionId || index,
              style: { marginBottom: 12 },
            }, [
              h('div', { className: 'dsh-memory-session-hd', key: 'hd' }, [
                h('span', { className: 'dsh-memory-session-id', key: 'id', title: session.sessionId },
                  truncate(session.sessionId, 46)),
                h(Chip, { key: 'ro' }, t('sessionReadOnly')),
              ]),
              h('div', { className: 'dsh-memory-session-meta', key: 'meta' }, [
                session.workspace ? h('span', { key: 'ws' }, session.workspace) : null,
                h('span', { key: 'up' }, t('sessionUpdated', { time: formatDateTime(session.updatedAt, t) })),
                h('span', { key: 'notes' }, t('sessionNotes', { n: session.notes.length })),
                session.promoted.length
                  ? h('span', { key: 'pr' }, t('sessionPromoted', { n: session.promoted.length }))
                  : null,
              ]),
              h('div', { key: 'notes' }, session.notes.map((note) => h('div', {
                className: 'dsh-memory-note-row',
                key: note.id,
              }, [
                h('span', { className: 'dsh-memory-note-kind ' + note.kind, key: 'k' },
                  t(
                    note.kind === 'constraint'
                      ? 'noteConstraint'
                      : note.kind === 'decision'
                        ? 'noteDecision'
                        : note.kind === 'todo'
                          ? 'noteTodo'
                          : 'noteFact',
                  )),
                h('span', { className: 'dsh-memory-note-text', key: 't' }, note.text),
                note.at
                  ? h('span', { className: 'dsh-memory-note-at', key: 'a' }, formatDateTime(note.at, t).slice(5))
                  : null,
              ]))),
            ])))
          : h(EmptyState, { key: 'empty', t, title: t('noSessions') }),
      ])
    }

    /* ────────────────────────────── 整理 ────────────────────────────── */

    function normalizeModels(raw) {
      return asArray(raw).map((entry) => {
        if (typeof entry === 'string') {
          return { id: entry, label: entry, provider: '', model: entry }
        }
        const provider = String(entry?.provider ?? '')
        const model = String(entry?.model ?? entry?.value ?? '')
        const id = String(entry?.id ?? (provider && model ? `${provider}/${model}` : model || entry?.label || ''))
        return {
          id,
          label: String(entry?.label ?? entry?.name ?? id),
          provider,
          model,
        }
      }).filter((entry) => entry.id || entry.label)
    }

    function modelToString(value) {
      if (!value) return ''
      if (typeof value === 'string') return value
      if (typeof value === 'object') {
        if (value.provider && value.model) return `${value.provider}/${value.model}`
        if (value.model) return String(value.model)
        if (value.id) return String(value.id)
      }
      return ''
    }

    function parseModelInput(value) {
      const text = String(value || '').trim()
      if (!text) return null
      const slash = text.indexOf('/')
      if (slash <= 0 || slash === text.length - 1) return null
      const provider = text.slice(0, slash).trim()
      const model = text.slice(slash + 1).trim()
      if (!provider || !model) return null
      return { provider, model }
    }

    function runStatusLabel(t, state) {
      if (state === 'done') return t('runDone')
      if (state === 'paused') return t('runPaused')
      if (state === 'error') return t('runError')
      if (state === 'canceled') return t('runCanceled')
      return t('runRunning')
    }

    function shortId(id) {
      const text = String(id || '')
      if (text.length <= 22) return text
      return text.slice(0, 12) + '…' + text.slice(-6)
    }

    function ConsolidateTab(props) {
      const { t, refreshToken, onRefresh } = props
      const settingsQuery = useAsync(() => API.settings(), [refreshToken])
      const journalQuery = useAsync(() => API.journal(120), [refreshToken])
      const runsQuery = useAsync(() => API.runs(), [refreshToken])

      const [form, setForm] = React.useState(null)
      const [baseline, setBaseline] = React.useState(null)
      const [saveBusy, setSaveBusy] = React.useState(false)
      const [formNote, setFormNote] = React.useState(null)
      const [activeRun, setActiveRun] = React.useState(null)
      const [runNote, setRunNote] = React.useState(null)
      const [expanded, setExpanded] = React.useState({})
      const [undoBusy, setUndoBusy] = React.useState('')
      const pollRef = React.useRef(null)

      const rawSettings = settingsQuery.data?.settings ?? settingsQuery.data?.data ?? settingsQuery.data
      const models = React.useMemo(
        () => normalizeModels(settingsQuery.data?.models).filter((model) => model.provider && model.model),
        [settingsQuery.data],
      )

      React.useEffect(() => {
        if (!rawSettings || typeof rawSettings !== 'object') return
        const next = {
          scheduleEnabled: rawSettings.enabled !== false && rawSettings.scheduleEnabled !== false,
          deepFrequency: rawSettings.deepFrequency || rawSettings.frequency || 'daily',
          deepTime: rawSettings.deepTime || rawSettings.time || '03:30',
          idleMinutes: String(rawSettings.idleMinutes ?? rawSettings.idle ?? 30),
          model: modelToString(rawSettings.model),
          maxLlmCalls: String(rawSettings.maxLlmCalls ?? rawSettings.maxCalls ?? 30),
          inboxReview: rawSettings.inboxReview === 'user' ? 'user' : 'ai',
        }
        setForm(next)
        setBaseline(next)
      }, [rawSettings])

      React.useEffect(() => () => {
        if (pollRef.current) clearTimeout(pollRef.current)
      }, [])

      const formDirty = Boolean(form && baseline) && JSON.stringify(form) !== JSON.stringify(baseline)
      const updateForm = (key, value) => setForm((prev) => (prev ? { ...prev, [key]: value } : prev))

      const saveSettings = async () => {
        if (!form) return
        const idle = Number(form.idleMinutes)
        const calls = Number(form.maxLlmCalls)
        if (!Number.isFinite(idle) || idle < 0) {
          setFormNote({ kind: 'err', text: t('invalidNumber') })
          return
        }
        if (!Number.isFinite(calls) || calls < 1 || calls > 200) {
          setFormNote({ kind: 'err', text: t('invalidNumber') })
          return
        }
        if (!/^\d{2}:\d{2}$/.test(String(form.deepTime))) {
          setFormNote({ kind: 'err', text: t('invalidTime') })
          return
        }
        let model = null
        const modelText = String(form.model || '').trim()
        if (modelText) {
          const known = models.find((entry) => entry.id === modelText || entry.label === modelText)
          if (known && known.provider && known.model) {
            model = { provider: known.provider, model: known.model }
          } else {
            model = parseModelInput(modelText)
            if (!model) {
              setFormNote({ kind: 'err', text: t('invalidModel') })
              return
            }
          }
        }
        setSaveBusy(true)
        setFormNote(null)
        try {
          await API.saveSettings({
            enabled: Boolean(form.scheduleEnabled),
            deepFrequency: form.deepFrequency,
            deepTime: form.deepTime,
            idleMinutes: idle,
            model,
            maxLlmCalls: calls,
            inboxReview: form.inboxReview === 'user' ? 'user' : 'ai',
          })
          setFormNote({ kind: 'ok', text: t('settingsSaved') })
          setBaseline(form)
          settingsQuery.reload()
          onRefresh?.()
        } catch (error) {
          setFormNote({ kind: 'err', text: t('saveFailed', { message: error?.message || String(error) }) })
        } finally {
          setSaveBusy(false)
        }
      }

      const pollRun = React.useCallback(async (runId) => {
        try {
          const payload = await API.runStatus(runId)
          const run = normalizeRun(payload?.run ?? payload?.data ?? payload)
          setActiveRun((prev) => ({ ...(prev || {}), ...run, id: runId }))
          if (run.state === 'running') {
            pollRef.current = setTimeout(() => pollRun(runId), 900)
          } else {
            journalQuery.reload()
            runsQuery.reload()
            settingsQuery.reload()
            onRefresh?.()
            if (run.state === 'done') setRunNote({ kind: 'ok', text: t('runNoteDone') })
            if (run.state === 'error') {
              setRunNote({ kind: 'err', text: t('runNoteError', { message: run.error || '' }) })
            }
          }
        } catch (error) {
          setActiveRun((prev) => (prev ? { ...prev, state: 'error', error: error.message } : prev))
          setRunNote({ kind: 'err', text: t('actionFailed', { message: error?.message || String(error) }) })
        }
      }, [t, journalQuery.reload, runsQuery.reload, settingsQuery.reload, onRefresh])

      const startRun = async (mode) => {
        if (activeRun?.state === 'running' || activeRun?.state === 'starting') return
        setRunNote(null)
        setActiveRun({ state: 'starting', mode })
        try {
          const payload = await API.run(mode)
          const runId = payload?.runId || payload?.run?.id || payload?.id
          if (!runId) throw new Error('响应里没有 runId')
          setActiveRun({ state: 'running', mode, id: runId, step: t('runRunning'), done: 0, total: 0 })
          runsQuery.reload()
          pollRun(runId)
        } catch (error) {
          setActiveRun({ state: 'error', mode })
          setRunNote({ kind: 'err', text: t('actionFailed', { message: error?.message || String(error) }) })
        }
      }

      const undo = async (payload) => {
        const key = payload.runId ? 'run:' + payload.runId : 'entry:' + payload.journalId
        setUndoBusy(key)
        setRunNote(null)
        try {
          const response = await API.undo(payload)
          const undoneCount = Array.isArray(response?.undone)
            ? response.undone.length
            : num(response?.undone, 1)
          setRunNote({ kind: 'ok', text: t('undoDone', { n: undoneCount }) })
          journalQuery.reload()
          settingsQuery.reload()
          onRefresh?.()
        } catch (error) {
          setRunNote({ kind: 'err', text: t('actionFailed', { message: error?.message || String(error) }) })
        } finally {
          setUndoBusy('')
        }
      }

      const entries = React.useMemo(
        () => asArray(journalQuery.data?.entries ?? journalQuery.data?.data),
        [journalQuery.data],
      )
      const undoneIds = React.useMemo(() => {
        const set = new Set()
        for (const entry of entries) {
          if (entry.op !== 'undo') continue
          for (const id of asArray(entry.undone)) set.add(String(id))
          if (entry.journalId) set.add(String(entry.journalId))
          const match = String(entry.reason || '').match(/^(?:undo|撤销)\s+(\S+)/)
          if (match) set.add(match[1])
        }
        return set
      }, [entries])

      const journalRuns = React.useMemo(() => {
        const groups = new Map()
        for (const entry of entries) {
          if (!entry?.runId) continue
          const id = String(entry.runId)
          const at = Date.parse(entry.at || '') || 0
          const group = groups.get(id) || { id, entries: [], at: 0, mode: '' }
          group.entries.push(entry)
          group.at = Math.max(group.at, at)
          if (!group.mode && entry.mode) group.mode = entry.mode
          groups.set(id, group)
        }
        return [...groups.values()]
          .sort((a, b) => b.at - a.at)
          .map((group) => ({
            ...group,
            state: 'done',
            startedAt: new Date(group.at).toISOString(),
            entries: group.entries.slice().sort((a, b) => (Date.parse(b.at || '') || 0) - (Date.parse(a.at || '') || 0)),
          }))
      }, [entries])
      const runs = React.useMemo(() => {
        const backendRuns = asArray(runsQuery.data?.runs).map(normalizeRun)
        if (backendRuns.length) {
          // 深整理会派生 reason=deep:initial / deep:final 的内部轻整理；
          // 设置页的「最近运行」只列顶层运行，避免把一次深整理拆成三条。
          const topLevel = backendRuns.filter((run) => !String(run.reason || '').startsWith('deep:'))
          const visibleRuns = topLevel.length ? topLevel : backendRuns
          const journalById = new Map(journalRuns.map((group) => [group.id, group]))
          return visibleRuns
            .slice(0, 10)
            .map((run) => ({
              ...run,
              at: Date.parse(run.startedAt) || 0,
              entries: (journalById.get(run.id)?.entries || []).map((entry) => ({
                ...entry,
                undone: Boolean(entry.undone) || undoneIds.has(String(entry.id || '')),
              })),
            }))
            .sort((a, b) => (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0))
        }
        return journalRuns.slice(0, 10).map((run) => ({
          ...run,
          entries: run.entries.map((entry) => ({
            ...entry,
            undone: Boolean(entry.undone) || undoneIds.has(String(entry.id || '')),
          })),
        }))
      }, [journalRuns, runsQuery.data, undoneIds])

      if (settingsQuery.loading && !settingsQuery.data) return h(Loading, { t })
      if (settingsQuery.error && !settingsQuery.data) {
        return h(ErrorState, { t, error: settingsQuery.error, onRetry: settingsQuery.reload })
      }

      const runState = activeRun?.state || ''
      const running = runState === 'running' || runState === 'starting'
      const percent = runState === 'done'
        ? 100
        : activeRun?.total
          ? Math.round((num(activeRun.done) / num(activeRun.total)) * 100)
          : running
            ? 8
            : 0

      const settingsCard = form
        ? h('section', { className: 'dsh-memory-card', key: 'settings' }, [
            h('div', { className: 'dsh-memory-card-hd', key: 'hd' }, [
              h('div', { key: 'txt' }, [
                h('h3', { className: 'dsh-memory-card-title', key: 't' }, t('scheduleTitle')),
                h('div', { className: 'dsh-memory-meta', key: 'h', style: { marginTop: 2 } }, t('scheduleLead')),
              ]),
            ]),
            h('div', { className: 'dsh-memory-form-grid', key: 'form' }, [
              h('div', { className: 'dsh-memory-form-wide', key: 'enabled' },
                h('label', { className: 'dsh-memory-switch' }, [
                  h('input', {
                    key: 'i',
                    type: 'checkbox',
                    checked: Boolean(form.scheduleEnabled),
                    onChange: (event) => updateForm('scheduleEnabled', event.target.checked),
                  }),
                  h('span', { key: 'l' }, t('enableSchedule')),
                ])),
              h(Field, { key: 'freq', label: t('deepFrequency') },
                h('select', {
                  className: 'dsh-memory-select',
                  value: form.deepFrequency,
                  onChange: (event) => updateForm('deepFrequency', event.target.value),
                }, [
                  h('option', { key: 'daily', value: 'daily' }, t('freqDaily')),
                  h('option', { key: 'weekly', value: 'weekly' }, t('freqWeekly')),
                  h('option', { key: 'off', value: 'off' }, t('freqOff')),
                ])),
              h(Field, { key: 'time', label: t('deepTime') },
                h('input', {
                  type: 'text',
                  inputMode: 'numeric',
                  className: 'dsh-memory-input',
                  value: form.deepTime,
                  placeholder: '03:30',
                  maxLength: 5,
                  autoComplete: 'off',
                  spellCheck: false,
                  onChange: (event) => updateForm('deepTime', event.target.value),
                })),
              h(Field, { key: 'idle', label: t('idleMinutes'), hint: t('idleHint') },
                h('input', {
                  type: 'number',
                  min: 0,
                  max: 1440,
                  className: 'dsh-memory-input',
                  value: form.idleMinutes,
                  onChange: (event) => updateForm('idleMinutes', event.target.value),
                })),
              h(Field, {
                key: 'model',
                label: t('modelLabel'),
                hint: models.length ? undefined : t('modelHint'),
              },
              models.length
                ? h('select', {
                    className: 'dsh-memory-select',
                    value: form.model,
                    onChange: (event) => updateForm('model', event.target.value),
                  }, [
                    h('option', { key: 'default', value: '' }, t('modelDefault')),
                    ...models.map((model) => h('option', {
                      key: model.id,
                      value: model.id,
                    }, model.label || model.id)),
                    form.model && !models.some((model) => model.id === form.model)
                      ? h('option', { key: 'current', value: form.model }, form.model)
                      : null,
                  ])
                : h('input', {
                    type: 'text',
                    className: 'dsh-memory-input',
                    value: form.model,
                    placeholder: t('modelPlaceholder'),
                    autoComplete: 'off',
                    spellCheck: false,
                    onChange: (event) => updateForm('model', event.target.value),
                  })),
              h(Field, { key: 'calls', label: t('maxLlmCalls') },
                h('input', {
                  type: 'number',
                  min: 1,
                  max: 200,
                  className: 'dsh-memory-input',
                  value: form.maxLlmCalls,
                  onChange: (event) => updateForm('maxLlmCalls', event.target.value),
                })),
              h(Field, { key: 'inboxReview', label: t('inboxReview'), hint: t('inboxReviewHint') },
                h('select', {
                  className: 'dsh-memory-select',
                  value: form.inboxReview,
                  onChange: (event) => updateForm('inboxReview', event.target.value),
                }, [
                  h('option', { key: 'ai', value: 'ai' }, t('inboxReviewAi')),
                  h('option', { key: 'user', value: 'user' }, t('inboxReviewUser')),
                ])),
            ]),
            !form.scheduleEnabled
              ? h('div', { key: 'off', className: 'dsh-memory-note warn' }, t('scheduleOffHint'))
              : null,
            h('div', { className: 'dsh-memory-savebar', key: 'bar' }, [
              h('button', {
                key: 'save',
                className: 'dsh-memory-btn primary',
                disabled: saveBusy || !formDirty,
                onClick: saveSettings,
              }, saveBusy ? t('saving') : t('save')),
              formDirty ? h('span', { key: 'dirty', className: 'dsh-memory-dirty' }, t('unsaved')) : null,
              h('span', { key: 'grow', className: 'dsh-memory-grow' }),
            ]),
            h(Note, { key: 'note', note: formNote, t }),
          ])
        : null

      const runCard = h('section', { className: 'dsh-memory-card', key: 'run', style: { marginTop: 12 } }, [
        h('div', { className: 'dsh-memory-card-hd', key: 'hd' }, [
          h('h3', { className: 'dsh-memory-card-title', key: 't' }, t('runTitle')),
        ]),
        h('div', { className: 'dsh-memory-runbar', key: 'bar' }, [
          h('button', {
            key: 'light',
            className: 'dsh-memory-btn primary',
            disabled: running,
            onClick: () => startRun('light'),
          }, running && activeRun?.mode === 'light' ? t('runRunning') : t('runLight')),
          h('button', {
            key: 'deep',
            className: 'dsh-memory-btn',
            disabled: running,
            onClick: () => startRun('deep'),
          }, running && activeRun?.mode === 'deep' ? t('runRunning') : t('runDeep')),
        ]),
        h('div', { className: 'dsh-memory-meta', key: 'hints', style: { marginTop: 7 } }, [
          h('span', { key: 'l' }, t('runLightHint')),
          h('span', { key: 'd' }, t('runDeepHint')),
        ]),
        runState === 'starting'
          ? h(Loading, { key: 'starting', t, label: t('runRunning') })
          : activeRun
            ? h('div', { className: 'dsh-memory-progress', key: 'progress' }, [
                h('div', { className: 'dsh-memory-progress-head', key: 'head' }, [
                  h('span', { key: 'state', className: 'dsh-memory-run-status ' + runState }, runStatusLabel(t, runState)),
                  h('span', { key: 'mode' }, activeRun.mode === 'deep' ? t('runModeDeep') : t('runModeLight')),
                  h('span', { key: 'grow', className: 'dsh-memory-grow' }),
                  h('span', { key: 'count' }, t('runProgress', {
                    done: num(activeRun.done),
                    total: num(activeRun.total),
                  })),
                ]),
                h('div', { className: 'dsh-memory-progress-track', key: 'track' },
                  h('div', {
                    className: 'dsh-memory-progress-fill' + (runState === 'paused' ? ' paused' : runState === 'error' ? ' error' : ''),
                    style: { width: `${Math.max(2, Math.min(100, percent))}%` },
                  })),
                activeRun.step
                  ? h('div', { key: 'step', className: 'dsh-memory-meta', style: { marginTop: 6 } },
                      t('runStep', { step: activeRun.step }))
                  : null,
                num(activeRun.llmCalls)
                  ? h('div', { key: 'llm', className: 'dsh-memory-meta', style: { marginTop: 2 } },
                      t('runLlm', { n: activeRun.llmCalls }))
                  : null,
                activeRun.inbox && (activeRun.inbox.reviewed || activeRun.inbox.deferred)
                  ? h('div', { key: 'inbox', className: 'dsh-memory-meta', style: { marginTop: 2 } },
                      t('runInbox', {
                        approved: activeRun.inbox.approved,
                        rejected: activeRun.inbox.rejected,
                        deferred: activeRun.inbox.deferred,
                      }))
                  : null,
              ])
            : null,
        h(Note, { key: 'note', note: runNote, t }),
      ])

      const historyCard = h('section', { className: 'dsh-memory-card', key: 'history', style: { marginTop: 12 } }, [
        h('div', { className: 'dsh-memory-card-hd', key: 'hd' }, [
          h('div', { key: 'txt' }, [
            h('h3', { className: 'dsh-memory-card-title', key: 't' }, t('runsTitle')),
            h('div', { className: 'dsh-memory-meta', key: 'h', style: { marginTop: 2 } }, t('runsHint')),
          ]),
        ]),
        (runsQuery.loading && !runsQuery.data) || (journalQuery.loading && !entries.length)
          ? h(Loading, { key: 'loading', t })
          : runsQuery.error && journalQuery.error && !runs.length
            ? h(ErrorState, { key: 'error', t, error: runsQuery.error, onRetry: () => { runsQuery.reload(); journalQuery.reload() } })
            : runs.length
              ? h('div', { key: 'runs' }, runs.map((run, runIndex) => h('div', { className: 'dsh-memory-run-item', key: run.id || runIndex }, [
                  h('div', { className: 'dsh-memory-run-hd', key: 'hd' }, [
                    h(Chip, { key: 'mode' }, run.mode === 'deep' ? t('runModeDeep') : run.mode === 'light' ? t('runModeLight') : t('runModeGeneric')),
                    h('span', { key: 'state', className: 'dsh-memory-run-status ' + (run.state || 'done') },
                      runStatusLabel(t, run.state || 'done')),
                    h('span', { key: 'id', className: 'dsh-memory-run-id', title: run.id }, shortId(run.id)),
                    h('span', { key: 'meta', className: 'dsh-memory-meta' },
                      `${formatDateTime(run.startedAt || (run.at ? new Date(run.at).toISOString() : ''), t)} · ${t('runEntries', { n: run.entries.length || (run.log?.length ?? 0) })}`),
                    h('span', { key: 'grow', className: 'dsh-memory-grow' }),
                    h('button', {
                      key: 'toggle',
                      className: 'dsh-memory-btn ghost small',
                      onClick: () => setExpanded((prev) => ({ ...prev, [run.id]: !prev[run.id] })),
                    }, expanded[run.id] ? t('hideJournal') : t('showJournal')),
                    h(ConfirmButton, {
                      key: 'undo',
                      t,
                      className: 'dsh-memory-btn small danger',
                      disabled: undoBusy === 'run:' + run.id
                        || !run.entries.some((entry) => entry.op !== 'undo' && !entry.undone),
                      onConfirm: () => undo({ runId: run.id }),
                    }, t('undoRun')),
                  ]),
                  expanded[run.id]
                    ? h('div', { className: 'dsh-memory-run-body', key: 'body' },
                        run.entries.length
                          ? run.entries.map((entry, index) => h('div', {
                              className: 'dsh-memory-jrow' + (entry.undone ? ' undone' : ''),
                              key: entry.id || index,
                            }, [
                              h('span', { className: 'dsh-memory-jtime', key: 'time' }, formatDateTime(entry.at, t)),
                              h(Chip, { key: 'actor' }, actorLabel(t, entry.actor)),
                              h(Chip, { key: 'op' }, opLabel(t, entry.op)),
                              entry.name
                                ? h('span', { className: 'dsh-memory-jname', key: 'name', title: entry.name }, entry.name)
                                : null,
                              entry.undone ? h(Chip, { key: 'undone' }, t('entryUndone')) : null,
                              h('span', { key: 'grow', className: 'dsh-memory-grow' }),
                              entry.op !== 'undo' && !entry.undone && entry.id
                                ? h('button', {
                                    key: 'undo',
                                    className: 'dsh-memory-btn ghost small',
                                    disabled: undoBusy === 'entry:' + entry.id,
                                    onClick: () => undo({ journalId: entry.id }),
                                  }, t('undoEntry'))
                                : null,
                              h('div', { className: 'dsh-memory-jreason', key: 'reason' }, entry.reason || ''),
                            ]))
                          : run.log && run.log.length
                            ? run.log.map((line, index) => h('div', {
                                className: 'dsh-memory-jrow',
                                key: 'log-' + index,
                              }, [
                                h('span', { className: 'dsh-memory-jtime', key: 'time' }, formatDateTime(line.at, t)),
                                line.phase ? h(Chip, { key: 'phase' }, line.phase) : null,
                                h('div', { className: 'dsh-memory-jreason', key: 'message' }, line.message || ''),
                              ]))
                            : h('div', { key: 'empty', className: 'dsh-memory-meta' }, t('noJournalForRun')),
                      )
                    : null,
                ])))
              : h(EmptyState, { key: 'empty', t, title: t('noRuns') }),
      ])

      return h('div', null, [
        h('p', { className: 'dsh-memory-lead', key: 'lead', style: { marginBottom: 12 } }, t('scheduleHint')),
        settingsCard,
        runCard,
        historyCard,
      ])
    }

    /* ────────────────────────────── 收件箱 ────────────────────────────── */

    function asText(value) {
      if (value === null || value === undefined) return ''
      if (typeof value === 'string') return value
      if (typeof value === 'object' && typeof value.text === 'string') return value.text
      try {
        return JSON.stringify(value, null, 2)
      } catch (error) {
        return String(value)
      }
    }

    function proposalKindLabel(t, kind) {
      if (kind === 'merge') return t('proposalMerge')
      if (kind === 'create') return t('proposalCreate')
      if (kind === 'retag') return t('proposalRetag')
      if (kind === 'archive') return t('proposalArchive')
      return t('proposalUpdate')
    }

    function InboxTab(props) {
      const { t, refreshToken, onRefresh } = props
      const query = useAsync(() => API.inbox(), [refreshToken])
      const [pendingId, setPendingId] = React.useState('')
      const [note, setNote] = React.useState(null)

      const proposals = React.useMemo(() => {
        return asArray(query.data?.items ?? query.data?.inbox ?? query.data?.data).map((raw, index) => ({
          id: String(raw.id || raw.journalId || `proposal-${index}`),
          kind: raw.kind || raw.op || 'update',
          scope: raw.scope || 'global',
          name: String(raw.name || ''),
          actor: raw.actor || raw.proposedBy || 'model',
          at: raw.at || raw.createdAt || '',
          reason: String(raw.reason || raw.message || ''),
          before: asText(raw.before),
          after: asText(raw.after),
        }))
      }, [query.data])

      const decide = async (proposal, decision) => {
        setPendingId(proposal.id)
        setNote(null)
        try {
          await API.decideInbox(proposal.id, decision)
          setNote({
            kind: decision === 'approve' ? 'ok' : 'info',
            text: decision === 'approve' ? t('approved') : t('rejected'),
          })
          query.reload()
          onRefresh?.()
        } catch (error) {
          setNote({ kind: 'err', text: t('actionFailed', { message: error?.message || String(error) }) })
        } finally {
          setPendingId('')
        }
      }

      if (query.loading && !query.data) return h(Loading, { t })
      if (query.error && !query.data) return h(ErrorState, { t, error: query.error, onRetry: query.reload })

      return h('div', null, [
        h('p', { className: 'dsh-memory-lead', key: 'lead', style: { marginBottom: 12 } }, t('inboxLead')),
        query.loading
          ? h('div', { key: 'loading', className: 'dsh-memory-meta', style: { marginBottom: 8 } }, t('refreshing'))
          : null,
        query.error
          ? h('div', { key: 'err', className: 'dsh-memory-note err' },
              t('loadFailed', { message: query.error.message || String(query.error) }))
          : null,
        h(Note, { key: 'note', note, t }),
        proposals.length
          ? h('div', { key: 'list', style: { marginTop: 10 } }, proposals.map((proposal) => h('section', {
              className: 'dsh-memory-proposal',
              key: proposal.id,
            }, [
              h('div', { className: 'dsh-memory-proposal-hd', key: 'hd' }, [
                h(Chip, { key: 'kind' }, proposalKindLabel(t, proposal.kind)),
                h('span', { key: 'name', className: 'dsh-memory-proposal-name' }, proposal.name || proposal.id),
                h(Chip, { key: 'scope' }, scopeLabel(t, proposal.scope)),
              ]),
              h('div', { className: 'dsh-memory-meta', key: 'meta' }, [
                h('span', { key: 'actor' }, t('fromActor', { actor: actorLabel(t, proposal.actor) })),
                proposal.at ? h('span', { key: 'at' }, formatDateTime(proposal.at, t)) : null,
                h('span', { key: 'id' }, proposal.id),
              ]),
              proposal.reason
                ? h('div', { className: 'dsh-memory-proposal-reason', key: 'reason' }, [
                    h('strong', { key: 'l' }, t('reason') + ': '),
                    h('span', { key: 't' }, proposal.reason),
                  ])
                : null,
              h('div', { className: 'dsh-memory-meta', key: 'difflabel', style: { marginBottom: 5 } },
                `${t('diffBefore')} → ${t('diffAfter')}`),
              h(DiffView, { key: 'diff', t, before: proposal.before, after: proposal.after }),
              h('div', { className: 'dsh-memory-proposal-actions', key: 'actions' }, [
                h('button', {
                  key: 'approve',
                  className: 'dsh-memory-btn primary',
                  disabled: pendingId === proposal.id,
                  onClick: () => decide(proposal, 'approve'),
                }, pendingId === proposal.id ? t('approving') : t('approve')),
                h('button', {
                  key: 'reject',
                  className: 'dsh-memory-btn',
                  disabled: pendingId === proposal.id,
                  onClick: () => decide(proposal, 'reject'),
                }, t('reject')),
              ]),
            ])))
          : h(EmptyState, { key: 'empty', t, title: t('noInbox'), text: t('inboxEmptyHint') }),
      ])
    }

    /* ────────────────────────────── 记忆图谱 ────────────────────────────── */

    const GRAPH_WIDTH = 1400
    const GRAPH_HEIGHT = 880
    const TYPE_COLORS = {
      user: '#5b8def',
      feedback: '#a78bfa',
      project: '#e5a13a',
      reference: '#2fb3a3',
    }

    function clamp(value, min, max) {
      return Math.max(min, Math.min(max, value))
    }

    function mulberry32(seed) {
      let a = seed >>> 0
      return function random() {
        a += 0x6D2B79F5
        let t = a
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
    }

    function textWidth(value, fontSize) {
      let width = 0
      for (const char of String(value)) {
        const code = char.codePointAt(0)
        if (code > 0x2e80) width += fontSize
        else if (char === ' ') width += fontSize * 0.33
        else if (/[A-Z0-9]/.test(char)) width += fontSize * 0.66
        else width += fontSize * 0.56
      }
      return width
    }

    function tagWidth(label, count) {
      return Math.max(48, textWidth(`${label} · ${count}`, 9.5) + 20)
    }

    function graphNodeRadius(node) {
      if (node.kind === 'tag') return 13
      return 6 + Math.min(12, Math.sqrt(Math.max(0, node.heat)) * 2.6) + (node.pinned ? 1.5 : 0)
    }

    function normalizeGraphNode(raw) {
      const id = String(raw?.id || '')
      const kind = raw?.kind === 'tag' || id.startsWith('tag:') ? 'tag' : 'item'
      const scope = raw?.scope
        || (id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : (kind === 'item' ? 'global' : ''))
      return {
        id,
        kind,
        label: String(raw?.label ?? raw?.name ?? id),
        name: String(raw?.name || (id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id)),
        type: TYPES.includes(raw?.type) ? raw.type : 'reference',
        scope,
        tier: raw?.tier === 'hot' ? 'hot' : 'cold',
        heat: num(raw?.heat),
        pinned: Boolean(raw?.pinned),
        stale: Boolean(raw?.stale),
        count: num(raw?.count),
        tags: asArray(raw?.tags),
      }
    }

    function normalizeGraphEdge(raw) {
      const kind = raw?.kind === 'tag' || raw?.kind === 'coread' ? raw.kind : 'link'
      return {
        source: String(raw?.source || ''),
        target: String(raw?.target || ''),
        kind,
        weight: num(raw?.weight, 1),
      }
    }

    function buildGraphView(nodes, edges, options) {
      const itemNodes = nodes.filter((node) => node.kind === 'item')
      const scopeOk = (node) => options.scope === 'all' || node.scope === options.scope
      const hotOk = (node) => !options.hotOnly || node.tier === 'hot' || node.pinned
      const coldOk = (node) => options.showCold || node.tier === 'hot' || node.pinned
      const visibleItems = itemNodes.filter((node) => scopeOk(node) && hotOk(node) && coldOk(node))
      const visibleIds = new Set(visibleItems.map((node) => node.id))
      const hiddenCold = itemNodes.filter((node) => scopeOk(node) && hotOk(node) && !coldOk(node)).length

      const tagCounts = new Map()
      for (const edge of edges) {
        if (edge.kind !== 'tag') continue
        if (!visibleIds.has(edge.source)) continue
        tagCounts.set(edge.target, (tagCounts.get(edge.target) || 0) + 1)
      }
      const tagNodes = options.showTags
        ? nodes
            .filter((node) => node.kind === 'tag' && tagCounts.has(node.id))
            .map((node) => ({ ...node, count: tagCounts.get(node.id) }))
        : []
      const keep = new Set([...visibleIds, ...tagNodes.map((node) => node.id)])
      const visibleEdges = edges.filter((edge) => {
        if (!keep.has(edge.source) || !keep.has(edge.target)) return false
        if (edge.kind === 'tag' && !options.showTags) return false
        if (edge.kind === 'coread') return false // 单独处理：默认关闭、限权重、限每节点条数
        return true
      })
      if (options.showCoread) {
        const candidates = edges
          .filter((edge) => edge.kind === 'coread' && edge.weight >= 2)
          .filter((edge) => keep.has(edge.source) && keep.has(edge.target))
          .sort((a, b) => b.weight - a.weight)
        // 每个节点各自保留权重最高的 3 条，再取并集；
        // 不能按全局顺序贪心，否则某个节点的高权重边可能因为对端已满被跳过。
        const perNode = new Map()
        for (const edge of candidates) {
          for (const end of [edge.source, edge.target]) {
            const list = perNode.get(end) || []
            if (list.length < 3) list.push(edge)
            perNode.set(end, list)
          }
        }
        const kept = new Set()
        for (const list of perNode.values()) for (const edge of list) kept.add(edge)
        for (const edge of kept) visibleEdges.push(edge)
      }
      return {
        items: visibleItems,
        tags: tagNodes,
        nodes: [...visibleItems, ...tagNodes],
        edges: visibleEdges,
        hiddenCold,
        scopes: [...new Set(itemNodes.map((node) => node.scope))],
      }
    }

    function simulateGraph(nodes, edges) {
      const rand = mulberry32(20261020)
      const count = nodes.length
      const xs = new Float64Array(count)
      const ys = new Float64Array(count)
      const vxs = new Float64Array(count)
      const vys = new Float64Array(count)
      const cx = GRAPH_WIDTH / 2
      const cy = GRAPH_HEIGHT / 2
      const items = []
      const tags = []
      nodes.forEach((node, index) => (node.kind === 'tag' ? tags : items).push({ node, index }))

      items.forEach((entry, order) => {
        const angle = (order / Math.max(1, items.length)) * Math.PI * 2 + rand() * 0.6
        const radius = Math.min(GRAPH_WIDTH, GRAPH_HEIGHT) * (0.15 + rand() * 0.16)
        xs[entry.index] = cx + Math.cos(angle) * radius
        ys[entry.index] = cy + Math.sin(angle) * radius
      })
      tags.forEach((entry, order) => {
        const angle = (order / Math.max(1, tags.length)) * Math.PI * 2 + 0.25
        const radius = Math.min(GRAPH_WIDTH, GRAPH_HEIGHT) * (0.37 + rand() * 0.06)
        xs[entry.index] = cx + Math.cos(angle) * radius
        ys[entry.index] = cy + Math.sin(angle) * radius
      })

      const byId = new Map(nodes.map((node, index) => [node.id, index]))
      const tagEdges = []
      const otherEdges = []
      for (const edge of edges) {
        const a = byId.get(edge.source)
        const b = byId.get(edge.target)
        if (a === undefined || b === undefined) continue
        if (edge.kind === 'tag') tagEdges.push([a, b])
        else otherEdges.push([a, b, edge])
      }

      const spring = (a, b, rest, stiffness) => {
        const dx = xs[b] - xs[a]
        const dy = ys[b] - ys[a]
        const distance = Math.sqrt(dx * dx + dy * dy) || 1
        const force = (distance - rest) * stiffness
        const fx = (dx / distance) * force
        const fy = (dy / distance) * force
        vxs[a] += fx
        vys[a] += fy
        vxs[b] -= fx
        vys[b] -= fy
      }

      const iterations = count > 300 ? 200 : 400
      for (let step = 0; step < iterations; step += 1) {
        const alpha = 1 - step / iterations
        for (let i = 0; i < count; i += 1) {
          for (let j = i + 1; j < count; j += 1) {
            let dx = xs[j] - xs[i]
            let dy = ys[j] - ys[i]
            let squared = dx * dx + dy * dy
            if (squared < 0.01) {
              dx = rand() - 0.5
              dy = rand() - 0.5
              squared = 0.01
            }
            const distance = Math.sqrt(squared)
            const tagI = nodes[i].kind === 'tag'
            const tagJ = nodes[j].kind === 'tag'
            const minDistance = (tagI ? 25 : 22) + (tagJ ? 25 : 22)
            if (distance < minDistance) {
              const push = ((minDistance - distance) / Math.max(distance, 0.01)) * 0.32
              xs[i] -= dx * push
              ys[i] -= dy * push
              xs[j] += dx * push
              ys[j] += dy * push
            }
            const charge = (tagI ? 1.8 : 1) * (tagJ ? 1.8 : 1)
            const force = Math.min(6, (5000 * charge) / Math.max(squared, 25))
            const fx = (dx / Math.max(distance, 0.01)) * force
            const fy = (dy / Math.max(distance, 0.01)) * force
            vxs[i] -= fx
            vys[i] -= fy
            vxs[j] += fx
            vys[j] += fy
          }
        }
        for (const [a, b] of tagEdges) spring(a, b, 160, 0.025)
        for (const [a, b, edge] of otherEdges) {
          spring(a, b, edge.kind === 'coread' ? 216 : 170, edge.kind === 'coread' ? 0.008 * Math.min(3, edge.weight) : 0.02)
        }
        for (let i = 0; i < count; i += 1) {
          const pull = nodes[i].kind === 'tag' ? 0.016 : 0.008
          vxs[i] += (cx - xs[i]) * pull * alpha
          vys[i] += (cy - ys[i]) * pull * alpha
          vxs[i] *= 0.85
          vys[i] *= 0.85
          const speed = Math.sqrt(vxs[i] * vxs[i] + vys[i] * vys[i])
          if (speed > 14) {
            vxs[i] = (vxs[i] / speed) * 14
            vys[i] = (vys[i] / speed) * 14
          }
          xs[i] = clamp(xs[i] + vxs[i], -200, GRAPH_WIDTH + 200)
          ys[i] = clamp(ys[i] + vys[i], -200, GRAPH_HEIGHT + 200)
        }
      }

      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (let i = 0; i < count; i += 1) {
        minX = Math.min(minX, xs[i])
        minY = Math.min(minY, ys[i])
        maxX = Math.max(maxX, xs[i])
        maxY = Math.max(maxY, ys[i])
      }
      const pad = 95
      const spanX = Math.max(1, maxX - minX)
      const spanY = Math.max(1, maxY - minY)
      let scaleX = Math.min((GRAPH_WIDTH - pad * 2) / spanX, 1.35)
      let scaleY = Math.min((GRAPH_HEIGHT - pad * 2) / spanY, 1.35)
      // 允许轻微的横纵拉伸以利用画布，但不要把图压扁得认不出来。
      if (scaleX / scaleY > 2) scaleX = scaleY * 2
      if (scaleY / scaleX > 2) scaleY = scaleX * 2
      const offsetX = (GRAPH_WIDTH - spanX * scaleX) / 2 - minX * scaleX
      const offsetY = (GRAPH_HEIGHT - spanY * scaleY) / 2 - minY * scaleY
      const positions = {}
      nodes.forEach((node, index) => {
        positions[node.id] = {
          x: Math.round((xs[index] * scaleX + offsetX) * 10) / 10,
          y: Math.round((ys[index] * scaleY + offsetY) * 10) / 10,
        }
      })
      return positions
    }

    function GraphModal(props) {
      const { t, onClose, onOpenItem } = props
      const query = useAsync(() => API.graph(), [])
      const nodes = React.useMemo(
        () => asArray(query.data?.nodes).map(normalizeGraphNode).filter((node) => node.id),
        [query.data],
      )
      const edges = React.useMemo(
        () => asArray(query.data?.edges).map(normalizeGraphEdge).filter((edge) => edge.source && edge.target),
        [query.data],
      )

      const [scope, setScope] = React.useState('all')
      const [hotOnly, setHotOnly] = React.useState(false)
      const [showTags, setShowTags] = React.useState(true)
      const [showCoread, setShowCoread] = React.useState(false)
      const [showColdState, setShowColdState] = React.useState(null)
      const [positions, setPositions] = React.useState({})
      const [transform, setTransform] = React.useState({ k: 1, x: 0, y: 0 })
      const [dragging, setDragging] = React.useState(false)
      const [hover, setHover] = React.useState(null)

      const svgRef = React.useRef(null)
      const dialogRef = React.useRef(null)
      const dragRef = React.useRef(null)
      const transformRef = React.useRef(transform)
      transformRef.current = transform

      const itemNodes = React.useMemo(() => nodes.filter((node) => node.kind === 'item'), [nodes])
      const scopes = React.useMemo(() => [...new Set(itemNodes.map((node) => node.scope))], [itemNodes])
      const autoHideCold = nodes.length > 300
      const showCold = showColdState === null ? !autoHideCold : showColdState

      const view = React.useMemo(() => buildGraphView(nodes, edges, {
        scope,
        hotOnly,
        showTags,
        showCoread,
        showCold,
      }), [nodes, edges, scope, hotOnly, showTags, showCoread, showCold])

      const layoutKey = React.useMemo(
        () => view.nodes.map((node) => node.id).sort().join('|') + '#' + view.nodes.length,
        [view.nodes],
      )

      React.useEffect(() => {
        if (!view.nodes.length) {
          setPositions({})
          return
        }
        setPositions(simulateGraph(view.nodes, view.edges))
        setTransform({ k: 1, x: 0, y: 0 })
        // view.edges 变化不一定要重排，节点集合变化才重排。
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [layoutKey])

      const graphReady = !query.loading && !query.error && view.nodes.length > 0
      const positionsReady = view.nodes.length > 0 && view.nodes.every((node) => positions[node.id])

      const toView = React.useCallback((clientX, clientY) => {
        const svg = svgRef.current
        if (!svg) return { x: 0, y: 0 }
        const rect = svg.getBoundingClientRect()
        const scale = Math.min(rect.width / GRAPH_WIDTH, rect.height / GRAPH_HEIGHT) || 1
        const offsetX = (rect.width - GRAPH_WIDTH * scale) / 2
        const offsetY = (rect.height - GRAPH_HEIGHT * scale) / 2
        return {
          x: (clientX - rect.left - offsetX) / scale,
          y: (clientY - rect.top - offsetY) / scale,
        }
      }, [])

      React.useEffect(() => {
        const svg = svgRef.current
        if (!svg) return undefined
        const onWheel = (event) => {
          event.preventDefault()
          const point = toView(event.clientX, event.clientY)
          setTransform((prev) => {
            const factor = Math.exp(-event.deltaY * 0.0012)
            const nextK = clamp(prev.k * factor, 0.3, 3.4)
            if (Math.abs(nextK - prev.k) < 0.0001) return prev
            const worldX = (point.x - prev.x) / prev.k
            const worldY = (point.y - prev.y) / prev.k
            return { k: nextK, x: point.x - worldX * nextK, y: point.y - worldY * nextK }
          })
        }
        svg.addEventListener('wheel', onWheel, { passive: false })
        return () => svg.removeEventListener('wheel', onWheel)
      }, [toView, graphReady])

      React.useEffect(() => {
        const handler = (event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          onClose()
        }
        window.addEventListener('keydown', handler, true)
        return () => window.removeEventListener('keydown', handler, true)
      }, [onClose])

      React.useEffect(() => {
        dialogRef.current?.focus?.()
      }, [])

      const startCanvasDrag = (event) => {
        if (event.button !== 0) return
        const point = toView(event.clientX, event.clientY)
        dragRef.current = {
          mode: 'canvas',
          startX: point.x,
          startY: point.y,
          tx: transformRef.current.x,
          ty: transformRef.current.y,
          moved: false,
          pointerId: event.pointerId,
        }
        try {
          svgRef.current?.setPointerCapture?.(event.pointerId)
        } catch {
          /* 不支持 pointer capture 的浏览器忽略 */
        }
        setDragging(true)
      }

      const startNodeDrag = (event, node) => {
        if (event.button !== 0 || node.kind !== 'item') return
        event.preventDefault()
        event.stopPropagation()
        const point = toView(event.clientX, event.clientY)
        const current = positions[node.id]
        if (!current) return
        const worldX = (point.x - transformRef.current.x) / transformRef.current.k
        const worldY = (point.y - transformRef.current.y) / transformRef.current.k
        dragRef.current = {
          mode: 'node',
          id: node.id,
          node,
          startX: worldX,
          startY: worldY,
          offsetX: worldX - current.x,
          offsetY: worldY - current.y,
          moved: false,
          pointerId: event.pointerId,
        }
        try {
          svgRef.current?.setPointerCapture?.(event.pointerId)
        } catch {
          /* ignore */
        }
        setDragging(true)
        setHover(null)
      }

      const movePointer = (event) => {
        const drag = dragRef.current
        if (!drag) return
        const point = toView(event.clientX, event.clientY)
        if (drag.mode === 'canvas') {
          const dx = point.x - drag.startX
          const dy = point.y - drag.startY
          if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true
          setTransform({ k: transformRef.current.k, x: drag.tx + dx, y: drag.ty + dy })
          return
        }
        const worldX = (point.x - transformRef.current.x) / transformRef.current.k
        const worldY = (point.y - transformRef.current.y) / transformRef.current.k
        if (Math.hypot(worldX - drag.startX, worldY - drag.startY) > 3) drag.moved = true
        setPositions((prev) => ({
          ...prev,
          [drag.id]: { x: worldX - drag.offsetX, y: worldY - drag.offsetY },
        }))
      }

      const endPointer = (event) => {
        const drag = dragRef.current
        if (!drag) return
        dragRef.current = null
        setDragging(false)
        try {
          svgRef.current?.releasePointerCapture?.(event.pointerId)
        } catch {
          /* ignore */
        }
        if (drag.mode === 'node' && !drag.moved) {
          onOpenItem(drag.node.scope, drag.node.name)
        }
      }

      const zoomBy = (factor) => {
        setTransform((prev) => {
          const nextK = clamp(prev.k * factor, 0.3, 3.4)
          const centerX = GRAPH_WIDTH / 2
          const centerY = GRAPH_HEIGHT / 2
          const worldX = (centerX - prev.x) / prev.k
          const worldY = (centerY - prev.y) / prev.k
          return { k: nextK, x: centerX - worldX * nextK, y: centerY - worldY * nextK }
        })
      }

      const hoverNode = hover ? view.nodes.find((node) => node.id === hover.id) : null
      const highlight = React.useMemo(() => {
        if (!hoverNode) return null
        const edgeSet = new Set()
        const nodeSet = new Set([hoverNode.id])
        view.edges.forEach((edge, index) => {
          if (edge.source === hoverNode.id || edge.target === hoverNode.id) {
            edgeSet.add(index)
            nodeSet.add(edge.source)
            nodeSet.add(edge.target)
          }
        })
        return { edges: edgeSet, nodes: nodeSet }
      }, [hoverNode, view.edges])

      const importantLabels = React.useMemo(
        () => new Set(view.items.filter((node) => node.pinned).map((node) => node.id)),
        [view.items],
      )
      const showAllLabels = transform.k >= 1.15 && view.nodes.length <= 260
      const labelsVisible = transform.k >= 0.55 && view.nodes.length <= 260
      const tipVisible = hoverNode && !dragRef.current
      const tipStyle = hover ? {
        left: Math.max(8, Math.min(hover.x + 14, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 300)),
        top: Math.max(8, Math.min(hover.y + 14, (typeof window !== 'undefined' ? window.innerHeight : 800) - 120)),
      } : null

      const svg = graphReady || query.data
        ? h('svg', {
            key: 'svg',
            ref: svgRef,
            className: 'dsh-memory-graph-svg' + (dragging ? ' dragging' : ''),
            viewBox: `0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`,
            role: 'img',
            'aria-label': t('graphTitle'),
            onPointerDown: startCanvasDrag,
            onPointerMove: movePointer,
            onPointerUp: endPointer,
            onPointerCancel: endPointer,
          }, [
            h('g', {
              key: 'world',
              transform: `translate(${transform.x} ${transform.y}) scale(${transform.k})`,
            }, [
              ...view.edges.map((edge, index) => {
                const a = positions[edge.source]
                const b = positions[edge.target]
                if (!a || !b) return null
                const classes = ['dsh-memory-graph-edge', edge.kind]
                if (highlight) classes.push(highlight.edges.has(index) ? 'active' : 'dim')
                return h('line', {
                  key: `edge-${index}-${edge.kind}`,
                  x1: a.x,
                  y1: a.y,
                  x2: b.x,
                  y2: b.y,
                  className: classes.join(' '),
                  strokeWidth: edge.kind === 'coread'
                    ? 0.8 + Math.min(1.0, (edge.weight - 2) * 0.2)
                    : edge.kind === 'link'
                      ? 1.2
                      : 1,
                })
              }),
              ...view.tags.map((node) => {
                const point = positions[node.id]
                if (!point) return null
                const width = tagWidth(node.label, node.count)
                const dim = highlight && !highlight.nodes.has(node.id)
                return h('g', {
                  key: node.id,
                  className: 'dsh-memory-graph-node' + (dim ? ' dim' : ''),
                  transform: `translate(${point.x} ${point.y})`,
                  onPointerDown: (event) => event.stopPropagation(),
                  onPointerEnter: (event) => {
                    if (dragRef.current) return
                    setHover({ id: node.id, x: event.clientX, y: event.clientY })
                  },
                  onPointerMove: (event) => {
                    if (dragRef.current) return
                    setHover((prev) => (prev && prev.id === node.id
                      ? { id: node.id, x: event.clientX, y: event.clientY }
                      : prev))
                  },
                  onPointerLeave: () => setHover(null),
                }, [
                  h('rect', {
                    key: 'shape',
                    className: 'dsh-memory-tag-shape',
                    x: -width / 2,
                    y: -11,
                    width,
                    height: 22,
                    rx: 11,
                  }),
                  h('text', {
                    key: 'label',
                    className: 'dsh-memory-tag-label',
                    textAnchor: 'middle',
                    dy: '3.4',
                  }, `${node.label} · ${node.count}`),
                ])
              }),
              ...view.items.map((node) => {
                const point = positions[node.id]
                if (!point) return null
                const radius = graphNodeRadius(node)
                const color = TYPE_COLORS[node.type] || TYPE_COLORS.reference
                const dim = highlight && !highlight.nodes.has(node.id)
                return h('g', {
                  key: node.id,
                  className: 'dsh-memory-graph-node item'
                    + (dim ? ' dim' : '')
                    + (hoverNode?.id === node.id ? ' hovered' : ''),
                  transform: `translate(${point.x} ${point.y})`,
                  style: { cursor: 'grab' },
                  onPointerDown: (event) => startNodeDrag(event, node),
                  onPointerEnter: (event) => {
                    if (dragRef.current) return
                    setHover({ id: node.id, x: event.clientX, y: event.clientY })
                  },
                  onPointerMove: (event) => {
                    if (dragRef.current) return
                    setHover((prev) => (prev && prev.id === node.id
                      ? { id: node.id, x: event.clientX, y: event.clientY }
                      : prev))
                  },
                  onPointerLeave: () => setHover(null),
                }, [
                  node.tier === 'hot' || node.pinned
                    ? h('circle', {
                        key: 'ring',
                        r: radius + 3.4,
                        fill: 'none',
                        stroke: color,
                        strokeOpacity: 0.55,
                        strokeWidth: 1.4,
                      })
                    : null,
                  h('circle', {
                    key: 'dot',
                    r: radius,
                    fill: color,
                    fillOpacity: 0.34,
                    stroke: color,
                    strokeWidth: node.stale ? 1.7 : 2.1,
                    strokeDasharray: node.stale ? '3 2' : undefined,
                  }),
                  node.pinned
                    ? h('g', {
                        key: 'pin',
                        transform: `translate(${radius + 1} ${-radius - 8}) scale(0.7)`,
                        fill: 'var(--dsw-alias-label-primary, #1a1a1a)',
                        stroke: 'var(--dsw-alias-bg-base, #fff)',
                        strokeWidth: 1.2,
                        'aria-hidden': 'true',
                      }, h('path', {
                        key: 'pin',
                        d: 'M8 1a4.9 4.9 0 0 0-4.9 4.9c0 3.5 4.9 8.7 4.9 8.7s4.9-5.2 4.9-8.7A4.9 4.9 0 0 0 8 1Zm0 6.9a2 2 0 1 1 0-4 2 2 0 0 1 0 4Z',
                        fillRule: 'evenodd',
                      }))
                    : null,
                  labelsVisible && (showAllLabels || importantLabels.has(node.id))
                    ? h('text', {
                        key: 'label',
                        className: 'dsh-memory-node-label',
                        y: radius + 11,
                        textAnchor: 'middle',
                      }, truncate(node.name, 24))
                    : null,
                ])
              }),
            ]),
          ])
        : null

      const filterBar = h('div', { className: 'dsh-memory-modal-row dsh-memory-modal-filters', key: 'filters' }, [
        h('select', {
          key: 'scope',
          className: 'dsh-memory-select',
          value: scope,
          'aria-label': t('filterScope'),
          onChange: (event) => setScope(event.target.value),
        }, [
          h('option', { key: 'all', value: 'all' }, t('graphScopeAll')),
          ...scopes.map((entry) => h('option', { key: entry, value: entry }, scopeOptionLabel(t, entry))),
        ]),
        h('label', { key: 'hot', className: 'dsh-memory-check' }, [
          h('input', {
            key: 'i',
            type: 'checkbox',
            checked: hotOnly,
            onChange: (event) => setHotOnly(event.target.checked),
          }),
          h('span', { key: 'l' }, t('filterHotOnly')),
        ]),
        h('label', { key: 'cold', className: 'dsh-memory-check' }, [
          h('input', {
            key: 'i',
            type: 'checkbox',
            checked: showCold,
            onChange: (event) => setShowColdState(event.target.checked),
          }),
          h('span', { key: 'l' }, t('filterCold')),
        ]),
        h('label', { key: 'tags', className: 'dsh-memory-check' }, [
          h('input', {
            key: 'i',
            type: 'checkbox',
            checked: showTags,
            onChange: (event) => setShowTags(event.target.checked),
          }),
          h('span', { key: 'l' }, t('filterTags')),
        ]),
        h('label', { key: 'coread', className: 'dsh-memory-check' }, [
          h('input', {
            key: 'i',
            type: 'checkbox',
            checked: showCoread,
            onChange: (event) => setShowCoread(event.target.checked),
          }),
          h('span', { key: 'l' }, t('filterCoread')),
        ]),
        h('span', { key: 'grow', className: 'dsh-memory-grow' }),
        h('div', { className: 'dsh-memory-graph-legend', key: 'legend' }, [
          ...TYPES.map((type) => h('span', { key: 'type-' + type, className: 'dsh-memory-legend-item' }, [
            h('span', {
              key: 'sw',
              className: 'dsh-memory-swatch',
              style: { background: TYPE_COLORS[type] },
            }),
            h('span', { key: 'l' }, typeLabel(t, type)),
          ])),
          h('span', { key: 'tag', className: 'dsh-memory-legend-item' }, [
            h('span', { key: 'sw', className: 'dsh-memory-swatch tag' }),
            h('span', { key: 'l' }, t('tagNode')),
          ]),
          h('span', { key: 'link', className: 'dsh-memory-legend-item' }, [
            h('span', { key: 'line', className: 'dsh-memory-line-sample' }),
            h('span', { key: 'l' }, t('edgeLink')),
          ]),
          h('span', { key: 'coread', className: 'dsh-memory-legend-item' }, [
            h('span', { key: 'line', className: 'dsh-memory-line-sample coread' }),
            h('span', { key: 'l' }, t('edgeCoread')),
          ]),
        ]),
      ])

      const hiddenNotice = itemNodes.length > 300 && !showCold
        ? h('div', { className: 'dsh-memory-graph-notice', key: 'notice' },
            t('hideColdHint', { n: itemNodes.length, m: view.hiddenCold }))
        : null

      const overlay = query.loading && !query.data
        ? h('div', { className: 'dsh-memory-graph-overlay', key: 'loading' }, [
            h(Loading, { key: 'l', t, label: t('graphLoading') }),
          ])
        : query.error
          ? h('div', { className: 'dsh-memory-graph-overlay', key: 'error' }, [
              h(ErrorState, {
                key: 'e',
                t,
                error: query.error,
                onRetry: query.reload,
                label: t('graphFailed', { message: query.error.message || String(query.error) }),
              }),
            ])
          : !itemNodes.length
            ? h('div', { className: 'dsh-memory-graph-overlay', key: 'empty' },
                h(EmptyState, { t, title: t('graphEmpty') }))
            : !view.nodes.length
              ? h('div', { className: 'dsh-memory-graph-overlay', key: 'filter-empty' },
                  h(EmptyState, { t, title: t('graphFilterEmpty'), text: t('graphFilterEmptyHint') }))
              : !positionsReady
              ? h('div', { className: 'dsh-memory-graph-overlay', key: 'layout' }, [
                  h(Loading, { key: 'l', t, label: t('graphLoading') }),
                ])
              : null

      return h('div', {
        className: 'dsh-memory-modal',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': t('graphTitle'),
        ref: dialogRef,
        tabIndex: -1,
      }, [
        h('div', { className: 'dsh-memory-modal-hd', key: 'hd' }, [
          h('div', { className: 'dsh-memory-modal-row', key: 'title' }, [
            h('span', { className: 'dsh-memory-modal-title', key: 't' }, t('graphTitle')),
            query.data
              ? h('span', { className: 'dsh-memory-modal-sub', key: 'count' },
                  t('nodeCount', { n: view.nodes.length, m: view.edges.length }))
              : null,
            h('span', { className: 'dsh-memory-graph-hint', key: 'hint' }, t('graphHint')),
            h('button', {
              key: 'close',
              type: 'button',
              className: 'dsh-memory-btn small dsh-memory-modal-close',
              onClick: onClose,
              title: t('closeGraph'),
              'aria-label': t('closeGraph'),
            }, '× ' + t('close')),
          ]),
          filterBar,
        ]),
        h('div', { className: 'dsh-memory-modal-body', key: 'body' }, [
          svg,
          overlay,
          graphReady && !query.loading && !query.error
            ? h('div', { className: 'dsh-memory-zoom', key: 'zoom' }, [
                h('button', {
                  key: 'in',
                  type: 'button',
                  className: 'dsh-memory-icon-btn',
                  title: t('zoomIn'),
                  'aria-label': t('zoomIn'),
                  onClick: () => zoomBy(1.25),
                }, '+'),
                h('button', {
                  key: 'out',
                  type: 'button',
                  className: 'dsh-memory-icon-btn',
                  title: t('zoomOut'),
                  'aria-label': t('zoomOut'),
                  onClick: () => zoomBy(0.8),
                }, '−'),
                h('button', {
                  key: 'reset',
                  type: 'button',
                  className: 'dsh-memory-icon-btn',
                  title: t('resetView'),
                  'aria-label': t('resetView'),
                  onClick: () => setTransform({ k: 1, x: 0, y: 0 }),
                }, '⟲'),
              ])
            : null,
          hiddenNotice,
          tipVisible ? h('div', { className: 'dsh-memory-graph-tip', key: 'tip', style: tipStyle }, [
            h('div', { className: 'dsh-memory-graph-tip-title', key: 'title' },
              hoverNode.kind === 'tag' ? `${t('tagNode')} · ${hoverNode.label}` : hoverNode.name),
            hoverNode.kind === 'tag'
              ? h('div', { className: 'dsh-memory-graph-tip-meta', key: 'meta' },
                  t('graphTagCount', { n: hoverNode.count }))
              : h('div', { className: 'dsh-memory-graph-tip-desc', key: 'desc' }, hoverNode.label),
            hoverNode.kind === 'tag'
              ? null
              : h('div', { className: 'dsh-memory-graph-tip-meta', key: 'meta' }, [
                  typeLabel(t, hoverNode.type),
                  hoverNode.tier === 'hot' || hoverNode.pinned ? t('nodeHotTip') : t('nodeColdTip'),
                  t('fieldHeat') + ' ' + hoverNode.heat,
                  hoverNode.pinned ? t('nodePinnedTip') : '',
                  hoverNode.stale ? t('nodeStaleTip') : '',
                ].filter(Boolean).join(' · ')),
          ]) : null,
        ]),
      ])
    }

    /* ────────────────────────────── 主面板 ────────────────────────────── */

    function Panel(props) {
      const { t } = props
      const [tab, setTab] = React.useState('overview')
      const [target, setTarget] = React.useState(null)
      const [graphOpen, setGraphOpen] = React.useState(false)
      const [refreshToken, setRefreshToken] = React.useState(0)
      const overviewQuery = useAsync(() => API.overview(), [refreshToken])
      const overview = overviewQuery.data
      const inboxRaw = overview?.inbox
      const inboxCount = typeof inboxRaw === 'number'
        ? inboxRaw
        : Array.isArray(inboxRaw)
          ? inboxRaw.length
          : num(inboxRaw?.count ?? inboxRaw?.total ?? overview?.inboxCount, 0)
      const home = overview?.home || overview?.homeDir || ''

      const refresh = React.useCallback(() => {
        setRefreshToken((value) => value + 1)
      }, [])

      const openItem = React.useCallback((scope, name) => {
        setTarget({ scope, name, seq: Date.now() + Math.random() })
        setTab('files')
        setGraphOpen(false)
      }, [])

      const tabs = [
        { id: 'overview', label: t('tabOverview') },
        { id: 'files', label: t('tabFiles') },
        { id: 'sessions', label: t('tabSessions') },
        { id: 'consolidate', label: t('tabConsolidate') },
        { id: 'inbox', label: t('tabInbox'), count: inboxCount },
      ]

      let content = null
      if (tab === 'overview') {
        content = h(OverviewTab, {
          key: 'overview',
          t,
          query: overviewQuery,
          onOpenGraph: () => setGraphOpen(true),
          onGoInbox: () => setTab('inbox'),
        })
      } else if (tab === 'files') {
        content = h(FilesTab, {
          key: 'files',
          t,
          refreshToken,
          target,
          onRefresh: refresh,
        })
      } else if (tab === 'sessions') {
        content = h(SessionsTab, { key: 'sessions', t, refreshToken })
      } else if (tab === 'consolidate') {
        content = h(ConsolidateTab, { key: 'consolidate', t, refreshToken, onRefresh: refresh })
      } else {
        content = h(InboxTab, { key: 'inbox', t, refreshToken, onRefresh: refresh })
      }

      return h('div', { className: 'dsh-memory' + (tab === 'files' ? ' dsh-memory--wide' : '') }, [
        h('div', { className: 'dsh-memory-hd', key: 'hd' }, [
          h('div', { className: 'dsh-memory-hd-txt', key: 'txt' }, [
            h('h1', { className: 'dsh-memory-h1', key: 'h1' }, t('title')),
            h('p', { className: 'dsh-memory-lead', key: 'lead' }, t('lead')),
          ]),
          h('div', { className: 'dsh-memory-hd-actions', key: 'actions' }, [
            h('button', {
              key: 'refresh',
              className: 'dsh-memory-btn small',
              onClick: refresh,
              disabled: overviewQuery.loading,
            }, overviewQuery.loading ? t('refreshing') : t('reload')),
          ]),
        ]),
        h('hr', { className: 'dsh-memory-hr', key: 'hr' }),
        h('div', { className: 'dsh-memory-seg', key: 'seg', role: 'tablist' },
          tabs.map((item) => h('button', {
            key: item.id,
            type: 'button',
            role: 'tab',
            className: 'dsh-memory-tab',
            'aria-selected': tab === item.id ? 'true' : 'false',
            onClick: () => setTab(item.id),
          }, [
            h('span', { key: 'l' }, item.label),
            item.count ? h('span', { key: 'c', className: 'dsh-memory-tab-count' }, String(item.count)) : null,
          ]))),
        h('div', { key: 'content' }, content),
        h('div', { className: 'dsh-memory-savebar', key: 'foot', style: { marginTop: 20, paddingTop: 12, borderTop: '1px solid var(--dsw-alias-border-l1, #f2f2f2)' } }, [
          h('button', {
            key: 'refresh',
            className: 'dsh-memory-btn ghost small',
            onClick: refresh,
          }, t('reload')),
          h('span', { key: 'grow', className: 'dsh-memory-grow' }),
          home ? h('span', { key: 'home', className: 'dsh-memory-mono', title: home }, `${t('home')} · ${home}`) : null,
        ]),
        graphOpen
          ? h(GraphModal, {
              key: 'graph',
              t,
              onClose: () => setGraphOpen(false),
              onOpenItem: openItem,
            })
          : null,
      ])
    }

    /** 真出错时显示错误卡片，而不是把设置页渲染成空白。 */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      render() {
        const { t } = this.props
        // ⚠️ `<style>` 必须两个分支都渲染：只在错误分支渲染会让正常路径完全没有样式。
        const style = h('style', { key: 'memory-css' }, CSS)
        if (this.state.error) {
          return h('div', { className: 'dsh-memory' }, [
            style,
            h('div', { className: 'dsh-memory-crash', key: 'e' },
              t('crashed', { message: String(this.state.error?.message ?? this.state.error) })),
          ])
        }
        return h(React.Fragment, null, [style, this.props.children])
      }
    }


    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'memory: dictionaries')
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'memory',
              order: 34,
              label: () => t('title'),
            },
            () => h(PanelBoundary, { t }, h(Panel, { t })),
          ),
        )
      },
    }
  },
})
