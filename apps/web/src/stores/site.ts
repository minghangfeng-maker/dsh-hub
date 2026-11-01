import { DEFAULT_SETTINGS, type PublicSiteResponse } from '@dsh-hub/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { fetchPublicSite, type SiteInfo } from '@/api/site'

const ANNOUNCEMENT_KEY = 'hub.announcement.dismissed'

/** 接口不可用时的兜底站点信息：与 03 §1.6 的默认 settings 一致，界面不会空着。 */
export const FALLBACK_SITE: SiteInfo = {
  name: DEFAULT_SETTINGS.site.name,
  tagline: DEFAULT_SETTINGS.site.tagline,
  announcement: DEFAULT_SETTINGS.site.announcement,
  announcementLevel: DEFAULT_SETTINGS.site.announcementLevel as PublicSiteResponse['announcementLevel'],
  registrationMode: DEFAULT_SETTINGS.registration.mode as PublicSiteResponse['registrationMode'],
  requireApproval: DEFAULT_SETTINGS.registration.requireApproval,
  // 拿不到站点信息时**不**提示安装证书：07 §5.1 只在服务端明确给了非空地址时才显示
  caCertUrl: '',
}

function readDismissed(): string {
  try {
    return window.localStorage.getItem(ANNOUNCEMENT_KEY) ?? ''
  } catch {
    return ''
  }
}

function writeDismissed(value: string): void {
  try {
    window.localStorage.setItem(ANNOUNCEMENT_KEY, value)
  } catch {
    // 隐私模式下 localStorage 可能不可写：忽略，公告下次仍会显示
  }
}

/**
 * 站点信息与公告（04 §1 `GET /api/public/site`）。
 * 登录页/注册页/顶栏/公告条共用；拉取失败不报错，用 {@link FALLBACK_SITE}。
 */
export const useSiteStore = defineStore('site', () => {
  const site = ref<SiteInfo>({ ...FALLBACK_SITE })
  const loaded = ref(false)
  const loading = ref(false)
  const loadFailed = ref(false)
  const dismissedAnnouncement = ref(readDismissed())

  const registrationMode = computed(() => site.value.registrationMode)
  const registrationOpen = computed(() => site.value.registrationMode !== 'closed')
  const requireApproval = computed(() => site.value.requireApproval)
  const announcementVisible = computed(
    () => site.value.announcement.trim().length > 0 && dismissedAnnouncement.value !== site.value.announcement,
  )

  async function load(force = false): Promise<void> {
    if ((loaded.value || loading.value) && !force) return

    loading.value = true
    try {
      site.value = await fetchPublicSite()
      loadFailed.value = false
      loaded.value = true
    } catch {
      // 站点信息是「锦上添花」：失败就退回默认值，绝不阻断页面
      site.value = { ...FALLBACK_SITE }
      loadFailed.value = true
      loaded.value = true
    } finally {
      loading.value = false
    }
  }

  function dismissAnnouncement(): void {
    dismissedAnnouncement.value = site.value.announcement
    writeDismissed(site.value.announcement)
  }

  return {
    site,
    loaded,
    loading,
    loadFailed,
    dismissedAnnouncement,
    registrationMode,
    registrationOpen,
    requireApproval,
    announcementVisible,
    load,
    dismissAnnouncement,
  }
})
