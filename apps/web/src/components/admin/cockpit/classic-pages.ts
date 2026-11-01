import { ADMIN_NAV_GROUPS } from '@/layouts/admin-nav'

/**
 * 「经典页面」菜单的数据（docs/24 §1）：按 `admin-nav.ts` 的分组生成。
 *
 * 单独抽出来有两个原因：座舱顶栏与经典页面侧边栏共用同一份导航数据（不会一边加了一边漏），
 * 而且「概览到底指向 `/admin` 还是 `/admin/overview`」这类事可以直接单测。
 */
export interface ClassicPage {
  /** 分组标题（概览那一组的标题是空串） */
  group: string
  /** 路由地址，也是下拉项的 key */
  key: string
  label: string
  icon: string
}

export function classicPageList(): ClassicPage[] {
  return ADMIN_NAV_GROUPS.flatMap((group) =>
    group.items.map((item) => ({
      group: group.title,
      key: item.to,
      label: item.label,
      icon: item.icon,
    })),
  )
}

/** 按分组聚合（Naive 的 `DropdownOption` 分组形态：`{ type:'group', children }`）。 */
export function classicPageGroups(): { title: string; items: ClassicPage[] }[] {
  const groups: { title: string; items: ClassicPage[] }[] = []
  for (const page of classicPageList()) {
    const last = groups.at(-1)
    if (last && last.title === page.group) last.items.push(page)
    else groups.push({ title: page.group, items: [page] })
  }
  return groups
}
