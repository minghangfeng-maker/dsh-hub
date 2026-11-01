/** 客户端生成的短 id（clientMessageId / upload localId）。 */

export function randomId(): string {
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID().replace(/-/g, '').slice(0, 20)
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}
