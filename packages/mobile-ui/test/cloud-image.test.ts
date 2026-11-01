/**
 * 正文里的云端路径图片（真机反馈 ①：AI 在云容器里生成图片后，正文写的是
 * `/workspace/.../pelican.png`，以前直接渲染成 `<img src="/workspace/...">` → 破图）。
 *
 * 现在 markdown 渲染时识别「本地/云端路径」，换成 `<dsh-cloud-image>` 自定义元素，
 * 由对话页注册的 resolver 走通道 `file-read({path})` 取字节；失败显示下载卡片。
 * 这里只测纯渲染/识别逻辑（DOM 行为由 e2e 覆盖）。
 */

import { describe, expect, it } from 'vitest'
import {
  cloudImagePathOf,
  getCloudImageResolver,
  renderMarkdown,
  setCloudImageResolver,
} from '../src/lib/markdown'

describe('cloudImagePathOf：识别哪些图片地址是云端本地路径', () => {
  it('posix 绝对路径（真机反馈的那种）', () => {
    expect(cloudImagePathOf('/workspace/out/pelican-ride-hd.png')).toBe('/workspace/out/pelican-ride-hd.png')
  })

  it('file:// 取路径；file://host 不碰', () => {
    expect(cloudImagePathOf('file:///workspace/a.png')).toBe('/workspace/a.png')
    expect(cloudImagePathOf('file://server/share/a.png')).toBeNull()
  })

  it('Windows 盘符路径', () => {
    expect(cloudImagePathOf('D:\\work\\a.png')).toBe('D:\\work\\a.png')
  })

  it('相对路径（./ ../ 以及裸相对）', () => {
    expect(cloudImagePathOf('./outputs/a.png')).toBe('./outputs/a.png')
    expect(cloudImagePathOf('../a.png')).toBe('../a.png')
    expect(cloudImagePathOf('outputs/a.png')).toBe('outputs/a.png')
  })

  it('http(s)/data/blob/协议相对等远程或内联地址原样交给浏览器', () => {
    expect(cloudImagePathOf('https://example.com/a.png')).toBeNull()
    expect(cloudImagePathOf('http://example.com/a.png')).toBeNull()
    expect(cloudImagePathOf('data:image/png;base64,AAAA')).toBeNull()
    expect(cloudImagePathOf('blob:https://x/y')).toBeNull()
    expect(cloudImagePathOf('//cdn.example.com/a.png')).toBeNull()
    expect(cloudImagePathOf('#anchor')).toBeNull()
    expect(cloudImagePathOf('')).toBeNull()
    expect(cloudImagePathOf(null)).toBeNull()
  })

  it('%20 会被还原成空格（markdown-it 会编码链接）', () => {
    expect(cloudImagePathOf('/workspace/my%20pic.png')).toBe('/workspace/my pic.png')
  })
})

describe('renderMarkdown：云端路径图片 → <dsh-cloud-image>', () => {
  it('绝对路径不再生成 <img>（不再破图）', () => {
    const html = renderMarkdown('![骑自行车的鹈鹕](/workspace/out/pelican-ride-hd.png)')
    expect(html).toContain('<dsh-cloud-image')
    expect(html).toContain('data-path="/workspace/out/pelican-ride-hd.png"')
    expect(html).toContain('data-alt="骑自行车的鹈鹕"')
    expect(html).not.toContain('<img')
  })

  it('远程图片仍然渲染成普通 <img>', () => {
    const html = renderMarkdown('![远程图](https://example.com/a.png)')
    expect(html).toContain('<img')
    expect(html).toContain('src="https://example.com/a.png"')
    expect(html).not.toContain('<dsh-cloud-image')
  })

  it('data URL 图片仍然是 <img>（内联表情/小图标）', () => {
    const html = renderMarkdown('![dot](data:image/png;base64,AAAA)')
    expect(html).toContain('<img')
    expect(html).not.toContain('<dsh-cloud-image')
  })

  it('标题写进 data-title，alt/路径里的引号被转义（不产生坏 HTML）', () => {
    const html = renderMarkdown('![a"b](/workspace/x.png "标题")')
    expect(html).toContain('data-title="标题"')
    expect(html).toContain('data-alt="a&quot;b"')
    expect(html).toContain('<dsh-cloud-image')
  })

  it('普通链接不受影响', () => {
    const html = renderMarkdown('[工作区文件](/workspace/out/a.png)')
    expect(html).toContain('<a href="/workspace/out/a.png"')
    expect(html).not.toContain('<dsh-cloud-image')
  })
})

describe('CloudImageResolver 注册表', () => {
  it('注册/注销（ConversationView 挂载时注册，卸载时置 null）', () => {
    const resolver = {
      load: async () => ({ url: 'blob:x', name: 'a.png', mimeType: 'image/png', bytes: 1 }),
      save: async () => undefined,
    }
    expect(getCloudImageResolver()).toBeNull()
    setCloudImageResolver(resolver)
    expect(getCloudImageResolver()).toBe(resolver)
    setCloudImageResolver(null)
    expect(getCloudImageResolver()).toBeNull()
  })
})
