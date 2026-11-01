/**
 * 设备代际与连接配额（R2/R9）。
 *
 * 关键点：**upgrade 时**就占住设备名额，hello 只能确认当前代际；
 * 两个 socket 同时 upgrade 时第二个直接被拒，不存在“先都通过 existing 检查、再互相覆盖”。
 */

export class RelayAdmission {
  private readonly live = new Map<string, string>()
  private readonly pending = new Map<string, string>()
  private readonly timers = new Map<string, NodeJS.Timeout>()

  /** upgrade 时调用：已有 live 或 pending 则拒绝；成功返回 true 并登记 pending。 */
  begin(deviceId: string, generation: string, timeoutMs: number, onTimeout: () => void): boolean {
    if (this.live.has(deviceId) || this.pending.has(deviceId)) return false
    this.pending.set(deviceId, generation)
    const timer = setTimeout(() => {
      if (this.pending.get(deviceId) === generation) this.pending.delete(deviceId)
      this.timers.delete(deviceId)
      onTimeout()
    }, timeoutMs)
    timer.unref()
    this.timers.set(deviceId, timer)
    return true
  }

  /** hello 时调用：只有仍是该代际的 pending 才能转 live。 */
  confirm(deviceId: string, generation: string): boolean {
    if (this.pending.get(deviceId) !== generation) return false
    this.pending.delete(deviceId)
    const timer = this.timers.get(deviceId)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.timers.delete(deviceId)
    }
    this.live.set(deviceId, generation)
    return true
  }

  /** 连接关闭：只清理自己的代际（旧实例关不掉新连接）。 */
  release(deviceId: string, generation: string): void {
    if (this.live.get(deviceId) === generation) this.live.delete(deviceId)
    if (this.pending.get(deviceId) === generation) this.pending.delete(deviceId)
    const timer = this.timers.get(deviceId)
    if (timer !== undefined && !this.live.has(deviceId) && !this.pending.has(deviceId)) {
      clearTimeout(timer)
      this.timers.delete(deviceId)
    }
  }

  isLive(deviceId: string, generation: string): boolean {
    return this.live.get(deviceId) === generation
  }
}

/** `(user,node)` 与 `user` 两级预留：并行 probe 也不会把同一节点顶过配额。 */
export class ReservationBook {
  private readonly byUser = new Map<number, number>()
  private readonly byNode = new Map<string, number>()

  reserve(userId: number, nodeId: string, maxPerUser: number, maxPerNode: number): boolean {
    const userCount = this.byUser.get(userId) ?? 0
    const nodeKey = `${String(userId)}:${nodeId}`
    const nodeCount = this.byNode.get(nodeKey) ?? 0
    if (userCount >= maxPerUser || nodeCount >= maxPerNode) return false
    this.byUser.set(userId, userCount + 1)
    this.byNode.set(nodeKey, nodeCount + 1)
    return true
  }

  /** 激活或失败都要释放；激活后由 channels 接管计数。 */
  release(userId: number, nodeId: string): void {
    const userCount = this.byUser.get(userId) ?? 0
    if (userCount <= 1) this.byUser.delete(userId)
    else this.byUser.set(userId, userCount - 1)
    const nodeKey = `${String(userId)}:${nodeId}`
    const nodeCount = this.byNode.get(nodeKey) ?? 0
    if (nodeCount <= 1) this.byNode.delete(nodeKey)
    else this.byNode.set(nodeKey, nodeCount - 1)
  }

  counts(userId: number, nodeId: string): { user: number; node: number } {
    return { user: this.byUser.get(userId) ?? 0, node: this.byNode.get(`${String(userId)}:${nodeId}`) ?? 0 }
  }
}
