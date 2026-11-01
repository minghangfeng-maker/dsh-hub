import type { AppDeps } from '../context.js'
import type { SessionUser } from '../lib/session.js'
import type { DesktopDeviceIdentity } from '../modules/desktop/types.js'
import type { MobileDeviceIdentity } from '../modules/mobile/types.js'

/**
 * Fastify 类型扩展：`app.deps` 是依赖容器，`req.user`/`req.session` 由会话解析钩子填充。
 * 声明放在这里，业务代码不用到处 as。
 */
declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps
  }

  interface FastifyRequest {
    user: SessionUser | null
    session: SessionUser | null
    /** 设备令牌的附加身份（WP25a）；cookie 会话 / 匿名请求为 null */
    desktop: DesktopDeviceIdentity | null
    /**
     * 手机设备令牌的附加身份（WP40a）：只有 `Authorization: Bearer dshm_at_…` 会填它；
     * cookie 会话（0.2.0 老 APK）与匿名请求为 null。
     */
    mobile: MobileDeviceIdentity | null
  }
}
