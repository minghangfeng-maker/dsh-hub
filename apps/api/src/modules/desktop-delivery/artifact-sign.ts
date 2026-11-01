import {
  DESKTOP_ARTIFACT_SIGN_DEVICE_PARAM,
  DESKTOP_ARTIFACT_SIGN_SIGNATURE_PARAM,
} from '@dsh-hub/shared'
import { hmacSha256, hmacSha256Base64url, timingSafeEqualStr } from '../../lib/crypto.js'

/**
 * 插件整包的**每设备稳定签名**（WP31）。
 *
 * 为什么需要它：桌面端取整包是「不带任何头」的 `fetch(artifact.url)`（`hub-connector` 的
 * `manifest.ts` 只 `redirect: 'error'`），而下载接口只认 Bearer 设备令牌 → 401，任何插件下发都会失败。
 * 已发出的安装包不能假设能重打，所以服务端让「不带令牌的下载」也能成功，但**不能**把私有插件包
 * 变成匿名公开：清单里给每台设备渲染一个签名地址，下载接口接受「Bearer 设备令牌」**或**「有效签名」。
 *
 * 设计取舍：
 * - 签名 = HMAC-SHA256(主密钥派生的签名密钥, `deviceId|packageName|version|artifactSha256`)，
 *   base64url 共 43 字符（整个 SHA-256 摘要就是 32 字节）；**不含过期时间**，所以清单 ETag 稳定，
 *   同一份内容每次渲染出的 URL 一样（不会因为每次拉清单都「变了」而永远 304 不了）。
 * - 签名密钥由**现有主密钥**派生（HMAC 带用途前缀，不新增明文存储）；
 *   轮换主密钥会让旧签名失效，设备下次拉清单即得到新签名，无需特殊处理。
 * - 验签之外还要查「设备存在且未吊销 / 用户仍有效 / 这个 (package, version) 正在这台设备的当前清单里」，
 *   因此吊销设备、停用用户、撤回下发都会让签名**立即**失效（见 `service.ts` 的 `signedArtifactDownload`）。
 */

/** 从主密钥派生签名密钥时用的上下文前缀（不同用途的派生结果互不相通） */
const SIGN_CONTEXT = 'desktop-artifact-sign:v1'

/** 安全参数的签名原文分界符：四个字段里只有包名可能带 `/`，都不含 `|` */
const SIGN_FIELD_SEPARATOR = '|'

/** 清单里的签名查询串参数名（客户端只读 URL，不需要认识它们；这里给测试与文档用） */
export {
  DESKTOP_ARTIFACT_SIGN_DEVICE_PARAM as ARTIFACT_SIGN_DEVICE_PARAM,
  DESKTOP_ARTIFACT_SIGN_SIGNATURE_PARAM as ARTIFACT_SIGN_SIGNATURE_PARAM,
}

/** 签名的 base64url 长度（HMAC-SHA256 的 32 字节 → 43 字符，无 padding） */
export const ARTIFACT_SIGNATURE_LENGTH = 43

/** 设备 id 的形状（服务端签发：`dv_` + 32 位小写十六进制，裁决 #1） */
export const DEVICE_ID_PATTERN = /^dv_[0-9a-f]{32}$/u
const SIGNATURE_PATTERN = /^[0-9A-Za-z_-]{43}$/u

export interface ArtifactSignatureInput {
  deviceId: string
  packageName: string
  version: string
  /** 整包的 sha256（小写十六进制）：包内容一变签名就变，不能拿签名去下另一个包 */
  sha256: string
}

/** 主密钥（32 字节）→ 取件签名密钥（32 字节）。**只**在服务端内存里派生，不落盘。 */
export function desktopArtifactSigningKey(masterKey: Uint8Array): Buffer {
  return hmacSha256(masterKey, SIGN_CONTEXT)
}

/** 签名原文（稳定、无时钟、无随机数）：`deviceId|packageName|version|sha256` */
export function artifactSignaturePayload(input: ArtifactSignatureInput): string {
  return [
    input.deviceId,
    input.packageName,
    input.version,
    input.sha256,
  ].join(SIGN_FIELD_SEPARATOR)
}

/** 计算签名（base64url，43 字符） */
export function signArtifact(key: Uint8Array, input: ArtifactSignatureInput): string {
  return hmacSha256Base64url(key, artifactSignaturePayload(input))
}

/** 这是不是一个形状合法的签名（不验真伪；真伪要 `verifyArtifactSignature`） */
export function isArtifactSignatureShape(value: string): boolean {
  return SIGNATURE_PATTERN.test(value)
}

/** 恒定时间验签（长度不同直接 false，长度本身不算秘密） */
export function verifyArtifactSignature(
  key: Uint8Array,
  input: ArtifactSignatureInput,
  signature: string,
): boolean {
  if (!isArtifactSignatureShape(signature)) return false
  return timingSafeEqualStr(signArtifact(key, input), signature)
}
