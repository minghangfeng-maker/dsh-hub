<script setup lang="ts">
/**
 * 居中对话框底座（0.4.0 §1.2）：半透明遮罩 + 白色圆角卡片 + 弹出动画。
 *
 * 重命名、归档二次确认与 0.4.1 的语音提示共用这一层：遮罩色、圆角、阴影、动画节奏只维护一份。
 * 点遮罩关闭（`@click.self`：点卡片内部不关）；`dismissible=false` 时只能点里面的按钮关。
 */
const props = defineProps<{
  open: boolean
  /** 读屏用的对话框名称（role=dialog 的 aria-label）。 */
  label: string
  /**
   * 点遮罩是否关闭，默认 true。
   *
   * 按住说话的说明弹窗必须传 false：它在手指按下的一瞬间弹出，抬手时浏览器补发的
   * click 正好落在刚出现的遮罩上，否则弹窗会「一闪而过」。
   */
  dismissible?: boolean
}>()

const emit = defineEmits<{ close: [] }>()

function onMaskClick(): void {
  if (props.dismissible === false) return
  emit('close')
}
</script>

<template>
  <Transition name="app-dialog">
    <div v-if="open" class="dialog-mask" @click.self="onMaskClick">
      <div class="dialog" role="dialog" aria-modal="true" :aria-label="label">
        <slot />
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.dialog-mask {
  position: fixed;
  inset: 0;
  z-index: 62;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--overlay);
}
.dialog {
  width: min(100%, 340px);
  max-height: 76vh;
  overflow-y: auto;
  padding: 20px 18px 16px;
  border-radius: 18px;
  background: var(--bg-elev);
  box-shadow: var(--shadow-float);
}
.app-dialog-enter-active,
.app-dialog-leave-active {
  transition: opacity 0.16s ease;
}
.app-dialog-enter-active .dialog,
.app-dialog-leave-active .dialog {
  transition: transform 0.16s cubic-bezier(0.32, 0.72, 0, 1);
}
.app-dialog-enter-from,
.app-dialog-leave-to {
  opacity: 0;
}
.app-dialog-enter-from .dialog,
.app-dialog-leave-to .dialog {
  transform: scale(0.94);
}
</style>
