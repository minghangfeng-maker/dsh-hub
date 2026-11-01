import type { Journey } from '../src/context.js'
import J1 from './J1-admin-init.js'
import J2 from './J2-invite-register.js'
import J3 from './J3-open-dsh.js'
import J4 from './J4-isolation.js'
import J5 from './J5-workspace-persist.js'
import J6 from './J6-export.js'
import J7 from './J7-stop-wake.js'
import J8 from './J8-admin.js'
import J9 from './J9-plugin-rollout.js'
import J10 from './J10-model-rollout.js'
import J11 from './J11-cockpit.js'

/**
 * 旅程清单（顺序即执行顺序；后面的旅程依赖前面产生的状态）：
 * J1 管理员账号 → J2 用户 A → J3 A 的容器 → J4 用户 B/越权 → J5 工作区文件 →
 * J6 导出 → J7 停止/唤醒 → J8 管理端 → J9/J10（依赖 WP3，未合并时 skipped）。
 */
export const JOURNEYS: Journey[] = [J1, J2, J3, J4, J5, J6, J7, J8, J9, J10, J11]
