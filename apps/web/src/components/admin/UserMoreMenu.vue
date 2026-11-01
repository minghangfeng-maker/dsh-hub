<script setup lang="ts">
import type { InstanceAction, UserAdminView } from '@dsh-hub/shared'
import { NButton, NDropdown, type DropdownOption } from 'naive-ui'
import { computed, h } from 'vue'

/**
 * 用户行内「更多」菜单（07 §7.2）：实例启停、重置密码、停用/启用、删除。
 * 敏感项（重置密码、删除）由父页走二次密码确认，这里只负责触发。
 */
const props = withDefaults(
  defineProps<{
    user: UserAdminView
    loading?: boolean
  }>(),
  { loading: false },
)

const emit = defineEmits<{
  instance: [action: InstanceAction]
  approve: []
  'reset-password': []
  'toggle-status': []
  delete: []
}>()

const icon = (className: string) => () => h('span', { class: className })

const options = computed<DropdownOption[]>(() => {
  const status = props.user.instance.status
  const running = status === 'running'
  const busy = status === 'starting' || status === 'stopping'

  const items: DropdownOption[] = []

  if (props.user.status === 'pending') {
    items.push({ key: 'approve', label: '通过审批', icon: icon('i-ph-check-circle') })
    items.push({ type: 'divider', key: 'd1' })
  }

  items.push(
    { key: 'start', label: '启动实例', icon: icon('i-ph-play'), disabled: running || busy },
    { key: 'stop', label: '停止实例', icon: icon('i-ph-stop'), disabled: !running || busy },
    { key: 'restart', label: '重启实例', icon: icon('i-ph-arrows-clockwise'), disabled: busy },
    { key: 'recreate', label: '重建实例', icon: icon('i-ph-arrow-clockwise') },
    { type: 'divider', key: 'd2' },
    { key: 'detail', label: '用户详情', icon: icon('i-ph-identification-card') },
    { key: 'reset-password', label: '重置密码', icon: icon('i-ph-key') },
    {
      key: 'toggle-status',
      label: props.user.status === 'disabled' ? '启用账号' : '停用账号',
      icon: icon(props.user.status === 'disabled' ? 'i-ph-lock-open' : 'i-ph-lock'),
    },
    { type: 'divider', key: 'd3' },
    { key: 'delete', label: '删除用户', icon: icon('i-ph-trash'), props: { class: 'dropdown-danger' } },
  )

  return items
})

const INSTANCE_ACTIONS: InstanceAction[] = ['start', 'stop', 'restart', 'recreate']

function onSelect(key: string): void {
  if (key === 'detail') {
    window.location.assign(`/admin/users/${props.user.id}`)
    return
  }
  if (INSTANCE_ACTIONS.includes(key as InstanceAction)) emit('instance', key as InstanceAction)
  else if (key === 'approve') emit('approve')
  else if (key === 'reset-password') emit('reset-password')
  else if (key === 'toggle-status') emit('toggle-status')
  else if (key === 'delete') emit('delete')
}
</script>

<template>
  <NDropdown :options="options" trigger="click" placement="bottom-end" @select="onSelect">
    <NButton size="tiny" quaternary :loading="loading" :aria-label="`${user.username} 的更多操作`">
      <template #icon>
        <span class="i-ph-dots-three-vertical" aria-hidden="true" />
      </template>
    </NButton>
  </NDropdown>
</template>
