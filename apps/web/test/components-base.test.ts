import { mount } from '@vue/test-utils'
import { NPopover } from 'naive-ui'
import { describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import AvatarImg from '@/components/base/AvatarImg.vue'
import CheckDraw from '@/components/base/CheckDraw.vue'
import CopyText from '@/components/base/CopyText.vue'
import CountUp from '@/components/base/CountUp.vue'
import EmptyState from '@/components/base/EmptyState.vue'
import InfoTip from '@/components/base/InfoTip.vue'
import PageHeader from '@/components/base/PageHeader.vue'
import SectionTitle from '@/components/base/SectionTitle.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import WaterBackdrop from '@/components/base/WaterBackdrop.vue'
import BrandMark from '@/components/base/BrandMark.vue'

describe('AvatarImg（无头像时昵称首字 + slug 派生底色）', () => {
  it('有头像用 <img>，并带 alt', () => {
    const wrapper = mount(AvatarImg, { props: { src: '/api/avatars/1-ab.webp', name: '薄荷茶' } })
    expect(wrapper.find('img').attributes('src')).toBe('/api/avatars/1-ab.webp')
    expect(wrapper.find('img').attributes('alt')).toContain('薄荷茶')
  })

  it('无头像用昵称首字（中文取第一个字，emoji 也完整）', () => {
    expect(mount(AvatarImg, { props: { name: '薄荷茶' } }).text()).toContain('薄')
    expect(mount(AvatarImg, { props: { name: 'sky-walker' } }).text()).toContain('S')
    expect(mount(AvatarImg, { props: { name: '🌱叶子' } }).text()).toContain('🌱')
    expect(mount(AvatarImg, { props: {} }).text()).toContain('？')
  })

  it('底色由 seed 派生且稳定；不同 seed 可以不同', () => {
    const styleOf = (seed: string) =>
      mount(AvatarImg, { props: { name: '薄荷茶', seed } }).attributes('style') ?? ''

    expect(styleOf('u7k2m9xa')).toBe(styleOf('u7k2m9xa'))
    expect(styleOf('u7k2m9xa')).toMatch(/var\(--c-(primary|sky|sakura|butter|danger)-soft\)/)
  })

  it('size 控制直径，bordered 加粉色描边', () => {
    const wrapper = mount(AvatarImg, { props: { name: '薄荷茶', size: 96, bordered: true } })
    expect(wrapper.attributes('style')).toContain('width: 96px')
    expect(wrapper.classes()).toContain('avatar-img--bordered')
  })
})

describe('CopyText（一键复制）', () => {
  it('展示文本与复制按钮，复制成功后提示「已复制」', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })

    const wrapper = mount(CopyText, { props: { text: 'https://hub/register?code=ABCD', label: '注册链接' } })
    expect(wrapper.text()).toContain('注册链接')
    expect(wrapper.find('code').text()).toBe('https://hub/register?code=ABCD')

    await wrapper.find('button').trigger('click')
    await vi.waitFor(() => expect(wrapper.text()).toContain('已复制'))
    expect(wrapper.emitted('copied')?.[0]).toEqual(['https://hub/register?code=ABCD'])

    vi.unstubAllGlobals()
  })

  it('truncate：单行省略 + title 放完整文本，复制拿到的仍是全文（07 §2.8）', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })

    const long = 'deepseek-v4.1-flash-preview-2026q4'
    const wrapper = mount(CopyText, { props: { text: long, truncate: true, size: 'sm' } })
    const code = wrapper.get('code')
    expect(code.classes()).toContain('copy-text__value--truncate')
    expect(code.attributes('title')).toBe(long)

    await wrapper.find('button').trigger('click')
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(long))

    vi.unstubAllGlobals()
  })

  it('不截断时不写 title（短文本悬停不用再弹一遍）', () => {
    const wrapper = mount(CopyText, { props: { text: 'sk-dsh-7f3ac2…c91d', size: 'sm' } })
    expect(wrapper.get('code').attributes('title')).toBeUndefined()
  })
})

describe('InfoTip（07 §2.7 的「ⓘ」说明）', () => {
  it('渲染成按钮 + aria-label，说明文字默认不常驻在页面上；桌面用悬停触发', () => {
    const wrapper = mount(InfoTip, { props: { text: '1 积分 = 1 元。', label: '积分说明' } })
    const button = wrapper.get('button.info-tip')
    expect(button.attributes('aria-label')).toBe('积分说明')
    expect(button.attributes('type')).toBe('button')
    expect(wrapper.find('.i-ph-info').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('1 积分 = 1 元。')
    // jsdom 的 matchMedia 返回 matches:false（当作有 hover 的桌面）
    expect(wrapper.findComponent(NPopover).props('trigger')).toBe('hover')
    expect(wrapper.findComponent(NPopover).props('width')).toBe(260)
  })

  it('浮层里渲染说明文字（把 NPopover 换成渲染插槽的桩来量结构）', () => {
    const wrapper = mount(InfoTip, {
      props: { text: '改完密码后，其他设备上的登录会立即失效。', label: '密码说明' },
      global: {
        stubs: {
          Popover: {
            props: ['trigger', 'width'],
            template: '<div class="popover-stub"><slot name="trigger" /><slot /></div>',
          },
        },
      },
    })

    expect(wrapper.get('.info-tip__body').text()).toContain('改完密码后，其他设备上的登录会立即失效。')
  })
})

describe('CountUp（600ms 计数，减少动态效果时直接落值）', () => {
  it('默认从 0 动画到目标值（rAF，用假时钟驱动，不依赖真实时间）', async () => {
    // 关键：把 rAF 与 performance 一起假掉，否则并行跑测试时真实时间抖动会让帧进度不可控
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'Date',
        'performance',
        'requestAnimationFrame',
        'cancelAnimationFrame',
      ],
    })

    try {
      const wrapper = mount(CountUp, { props: { value: 1234 } })

      // 起点是 0
      expect(wrapper.text()).toBe('0')

      // 走到一半：应停在 0 与目标值之间（easeOutCubic 单调递增）
      vi.advanceTimersByTime(300)
      await nextTick()
      const middle = Number(wrapper.text().replace(/,/g, ''))
      expect(middle).toBeGreaterThan(0)
      expect(middle).toBeLessThan(1234)

      // 600ms 结束：落在目标值，并带上千分位与无障碍标签
      vi.advanceTimersByTime(400)
      await nextTick()
      expect(wrapper.text()).toBe('1,234')
      expect(wrapper.attributes('aria-label')).toBe('1,234')

      wrapper.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('prefers-reduced-motion: reduce → 立即显示目标值（不计数）', () => {
    const original = window.matchMedia
    window.matchMedia = ((query: string) =>
      ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList) as typeof window.matchMedia

    const wrapper = mount(CountUp, { props: { value: 42, suffix: ' 人' } })
    expect(wrapper.text()).toBe('42 人')

    window.matchMedia = original
  })
})

describe('CheckDraw（勾号描边动画）', () => {
  it('两个描边元素带 .check-circle / .check-path，且有可访问标签', () => {
    const wrapper = mount(CheckDraw, { props: { size: 64, label: '注册成功' } })

    expect(wrapper.attributes('width')).toBe('64')
    expect(wrapper.attributes('aria-label')).toBe('注册成功')
    expect(wrapper.find('.check-circle').exists()).toBe(true)
    expect(wrapper.find('.check-path').exists()).toBe(true)
  })
})

describe('其它基础组件', () => {
  it('SoftCard：标题 / 插槽 / 悬浮上浮 class', () => {
    const wrapper = mount(SoftCard, {
      props: { title: '我的 DSH', hoverable: true },
      slots: { default: '<p>内容</p>', extra: '<button>更多</button>' },
    })

    expect(wrapper.text()).toContain('我的 DSH')
    expect(wrapper.text()).toContain('内容')
    expect(wrapper.classes()).toContain('lift')
    expect(wrapper.find('.soft-card__extra').exists()).toBe(true)
  })

  it('SectionTitle：图标 + 标题 + 说明 + 右侧操作', () => {
    const wrapper = mount(SectionTitle, {
      props: { title: '我的插件', description: '共 3 个', icon: 'i-ph-puzzle-piece' },
      slots: { extra: '<a>全部</a>' },
    })

    expect(wrapper.find('h2').text()).toBe('我的插件')
    expect(wrapper.find('.i-ph-puzzle-piece').exists()).toBe(true)
    expect(wrapper.text()).toContain('共 3 个')
    expect(wrapper.find('.section-title__extra').exists()).toBe(true)
  })

  it('PageHeader：标题 + 副标题 + 操作插槽；backTo 时出现返回按钮', () => {
    const wrapper = mount(PageHeader, {
      props: { title: '用户', subtitle: '共 12 人', backTo: '/admin' },
      slots: { actions: '<button>新建用户</button>' },
      global: { stubs: { RouterLink: true } },
    })

    expect(wrapper.find('h1').text()).toBe('用户')
    expect(wrapper.text()).toContain('共 12 人')
    expect(wrapper.find('.page-header__back').exists()).toBe(true)
    expect(wrapper.text()).toContain('返回')
  })

  it('EmptyState：插画 + 文案 + 操作（插画按名字选择）', () => {
    const wrapper = mount(EmptyState, {
      props: {
        title: '还没有实例',
        description: '点下面创建',
        illustration: 'cloud',
        actionText: '创建实例',
      },
      global: { stubs: { RouterLink: true } },
    })

    expect(wrapper.find('svg').attributes('aria-label')).toContain('云朵')
    expect(wrapper.text()).toContain('还没有实例')
    expect(wrapper.text()).toContain('创建实例')
    wrapper.unmount()
  })

  it('WaterBackdrop full：三层波浪 + 两处各三圈涟漪 + 柔光 + 画布，对读屏隐藏', () => {
    const wrapper = mount(WaterBackdrop)

    expect(wrapper.attributes('aria-hidden')).toBe('true')
    expect(wrapper.classes()).toContain('water-backdrop--full')
    expect(wrapper.findAll('.water-wave')).toHaveLength(3)
    expect(wrapper.findAll('.ripple-source')).toHaveLength(2)
    expect(wrapper.findAll('.ripple-ring')).toHaveLength(6)
    expect(wrapper.findAll('.water-glow')).toHaveLength(2)
    expect(wrapper.find('canvas').exists()).toBe(true)
    wrapper.unmount()
  })

  it('WaterBackdrop calm：只留前后两层淡波浪，没有涟漪环与画布', () => {
    const wrapper = mount(WaterBackdrop, { props: { variant: 'calm' } })

    expect(wrapper.classes()).toContain('water-backdrop--calm')
    expect(wrapper.findAll('.water-wave')).toHaveLength(2)
    expect(wrapper.find('.water-wave--mid').exists()).toBe(false)
    expect(wrapper.find('.ripple-ring').exists()).toBe(false)
    expect(wrapper.find('canvas').exists()).toBe(false)
    wrapper.unmount()
  })

  it('BrandMark：星座鲸轮廓、尺寸可调、对读屏隐藏', () => {
    const first = mount(BrandMark, { props: { size: 40 } })
    const second = mount(BrandMark)

    expect(first.attributes('width')).toBe('40')
    expect(second.attributes('width')).toBe('28')
    expect(first.attributes('viewBox')).toBe('0 0 100 100')
    expect(first.attributes('aria-hidden')).toBe('true')

    // 一条描边路径勾轮廓、16 颗星点当骨节、眼睛处一颗闪星（不是任何官方鲸鱼图形）
    const outline = first.find('path.brand-mark__outline')

    expect(outline.attributes('d')).toMatch(/^M10\.10 47\.49/)
    expect(outline.attributes('stroke')).toBe('currentColor')
    // 轮廓只描边：整个 svg 不填色，颜色全靠 currentColor 继承
    expect(first.attributes('fill')).toBe('none')
    expect(first.findAll('circle')).toHaveLength(16)
    expect(first.find('path.brand-mark__star').attributes('fill')).toBe('currentColor')
  })
})
