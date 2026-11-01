import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import YamlEditor from '@/components/admin/YamlEditor.vue'
import { checkPatchYaml, firstErrorIssue, renderPatchPreview } from '@/composables/yaml-patch'

/**
 * 插件配置 YAML（07 §7.5 / 04 §4.5）：结构校验 + 错误定位 + 渲染预览。
 */

const VALID = [
  '- id: dsh-email',
  '  config:',
  '    pollSeconds: 60',
  '',
  '# 注释也算通过',
  '- id: workspace-files',
  '  config: { maxBytes: 2097152 }',
].join('\n')

describe('yaml-patch：结构校验', () => {
  it('合法片段：没有错误，条目与 id 被解析出来', () => {
    const result = checkPatchYaml(VALID)
    expect(result.ok).toBe(true)
    expect(result.issues.filter((issue) => issue.severity === 'error')).toEqual([])
    expect(result.entries.map((entry) => entry.id)).toEqual(['dsh-email', 'workspace-files'])
    expect(result.entries[0]?.line).toBe(1)
    expect(result.entries[1]?.line).toBe(6)
  })

  it('空内容是合法的（插件可以不输出配置）', () => {
    expect(checkPatchYaml('')).toEqual({ ok: true, issues: [], entries: [] })
    expect(checkPatchYaml('   \n\n')).toEqual({ ok: true, issues: [], entries: [] })
  })

  it('顶层不是数组 → 错误定位到行号', () => {
    const result = checkPatchYaml(['id: dsh-email', 'config: {}'].join('\n'))
    expect(result.ok).toBe(false)
    expect(result.issues[0]).toMatchObject({
      line: 1,
      severity: 'error',
      message: '顶层必须是 patch 条目数组：每一项以 “- ” 开头',
    })
    expect(firstErrorIssue(result)?.line).toBe(1)
  })

  it('条目缺 id / id 为空 → 错误；重复 id → 警告（06 §4.3 后者覆盖前者）', () => {
    const missing = checkPatchYaml(['- config:', '    a: 1'].join('\n'))
    expect(missing.ok).toBe(false)
    expect(missing.issues.some((issue) => issue.message === '这个条目缺少 id')).toBe(true)

    const empty = checkPatchYaml(['- id:', '  config: {}'].join('\n'))
    expect(empty.issues.some((issue) => issue.message === 'id 不能为空')).toBe(true)

    const dup = checkPatchYaml(
      [
        '- id: workspace-controller',
        '  config: { a: 1 }',
        '- id: workspace-controller',
        '  config: { a: 2 }',
      ].join('\n'),
    )
    expect(dup.ok).toBe(true)
    const warning = dup.issues.find((issue) => issue.severity === 'warning')
    expect(warning?.line).toBe(3)
    expect(warning?.message).toContain('后者会覆盖前者')
  })

  it('Tab 缩进与奇数缩进、未闭合引号都能定位', () => {
    const tabbed = checkPatchYaml(['- id: a', '\tconfig: {}'].join('\n'))
    expect(tabbed.issues.some((issue) => issue.line === 2 && issue.message.includes('Tab'))).toBe(true)

    const odd = checkPatchYaml(['- id: a', '   config: {}'].join('\n'))
    expect(odd.issues.some((issue) => issue.line === 2 && issue.severity === 'warning')).toBe(true)

    const quote = checkPatchYaml(['- id: a', '  config: { name: "x }'].join('\n'))
    expect(quote.issues.some((issue) => issue.message.includes('引号'))).toBe(true)
  })

  it('缩进内容必须属于某个条目', () => {
    const result = checkPatchYaml(['  config: {}'].join('\n'))
    expect(result.issues.some((issue) => issue.message === '缩进的内容必须属于某个 “- ” 条目')).toBe(true)
  })
})

describe('yaml-patch：渲染预览', () => {
  it('输出头部注释 + 条目原文（保持作者写法）', () => {
    const preview = renderPatchPreview(VALID, { packageName: 'dsh-email' })
    expect(preview).toContain('# 由 DSH Hub 生成，请勿手改')
    expect(preview).toContain('# 插件：dsh-email')
    expect(preview).toContain('- id: dsh-email')
    expect(preview).toContain('  config: { maxBytes: 2097152 }')
  })

  it('没有条目时给出说明行', () => {
    expect(renderPatchPreview('')).toContain('（暂无配置：该插件不输出任何配置条目）')
  })
})

describe('YamlEditor：错误定位与预览', () => {
  it('展示条目数与通过提示', () => {
    const wrapper = mount(YamlEditor, { props: { modelValue: VALID } })
    expect(wrapper.find('.yaml-editor__ok').text()).toContain('结构检查通过（2 个条目）')
    expect(wrapper.find('.yaml-editor__preview').text()).toContain('- id: dsh-email')
  })

  it('错误列表按行号展示，点击后把光标定位到该行', async () => {
    const text = ['- id: a', '  config: {}', 'oops: 1'].join('\n')
    const wrapper = mount(YamlEditor, { props: { modelValue: text, packageName: 'demo' } })

    const issues = wrapper.findAll('.yaml-editor__issue')
    expect(issues.length).toBeGreaterThan(0)
    expect(issues[0]?.text()).toContain('第 3 行')

    await issues[0]?.trigger('click')
    const area = wrapper.find('textarea').element

    // 第 3 行从第 22 个字符开始（"- id: a\n" = 8， "  config: {}\n" = 13）
    const lines = text.split('\n')
    const expectedOffset = (lines[0]?.length ?? 0) + 1 + (lines[1]?.length ?? 0) + 1
    expect(area.selectionStart).toBe(expectedOffset)
    expect(area.selectionEnd).toBe(expectedOffset + (lines[2]?.length ?? 0))
  })

  it('内容变化时向外抛 validity，供父组件禁用保存', async () => {
    const wrapper = mount(YamlEditor, { props: { modelValue: VALID } })
    expect(wrapper.emitted('validity')?.[0]?.[0]).toMatchObject({ ok: true })

    // 受控组件：父组件（或 v-model）负责把新内容回灌
    await wrapper.setProps({ modelValue: 'id: bad' })
    expect((wrapper.emitted('validity') ?? []).at(-1)?.[0]).toMatchObject({ ok: false })

    await wrapper.setProps({ modelValue: VALID })
    expect((wrapper.emitted('validity') ?? []).at(-1)?.[0]).toMatchObject({ ok: true })

    await wrapper.find('textarea').setValue('id: bad')
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['id: bad'])
  })

  it('预览随内容更新（右侧渲染预览）', async () => {
    const wrapper = mount(YamlEditor, { props: { modelValue: '- id: one\n  config: {}' } })
    expect(wrapper.find('.yaml-editor__preview').text()).toContain('- id: one')

    await wrapper.setProps({ modelValue: '- id: two\n  config: { a: 1 }' })
    expect(wrapper.find('.yaml-editor__preview').text()).toContain('- id: two')
    expect(wrapper.find('.yaml-editor__preview').text()).not.toContain('- id: one')
  })

  it('行号栏行数与内容一致', () => {
    const wrapper = mount(YamlEditor, { props: { modelValue: 'a\nb\nc' } })
    expect(wrapper.find('.yaml-editor__gutter').text().split('\n')).toEqual(['1', '2', '3'])
  })
})
