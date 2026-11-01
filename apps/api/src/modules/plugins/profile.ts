import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { HubError } from '../../lib/errors.js'
import {
  backupFileName,
  backupStamp,
  parsePackageJson,
  selectBackupsToDelete,
  serializePackageJson,
  type JsonObject,
} from './package-json.js'

/**
 * profile 目录的文件读写（06 §2.3 §2.4）：`package.json` 的原子写、备份轮转（保留 3 份）、还原。
 * 与 package.json 的**内容**变换（纯函数）分开，这里只管文件。
 */
export interface ProfileFiles {
  dir: string
  packageJsonPath: string
  /** profile 是否已创建（`package.json` 存在） */
  exists(): boolean
  /** 读文本；不存在抛 PROFILE_MISSING（调用方先 ensureProfile） */
  readText(): string
  /** 读并解析 */
  read(): JsonObject
  /** 原子写（tmp + rename），保证 DSH 不会读到半个文件 */
  write(json: JsonObject): void
  /** 备份当前文件，返回备份路径；目录里没有文件时返回 null */
  backup(at: Date): string | null
  /** 列出备份文件名（字典序 = 时间序） */
  listBackups(): string[]
  /** 备份轮转：保留最近 keep 份，返回被删掉的文件名 */
  rotateBackups(keep: number): string[]
  /** 从备份还原（把备份内容写回 package.json；备份本身保留） */
  restore(backupPath: string): void
}

export class ProfileMissingError extends HubError {
  constructor(dir: string) {
    super('CONFLICT', `profile 尚未创建：${dir}`)
  }
}

export function createProfileFiles(profileDir: string): ProfileFiles {
  const packageJsonPath = join(profileDir, 'package.json')

  return {
    dir: profileDir,
    packageJsonPath,

    exists() {
      return existsSync(packageJsonPath)
    },

    readText() {
      if (!existsSync(packageJsonPath)) throw new ProfileMissingError(profileDir)
      return readFileSync(packageJsonPath, 'utf8')
    },

    read() {
      return parsePackageJson(this.readText())
    },

    write(json) {
      mkdirSync(profileDir, { recursive: true })
      const tmp = `${packageJsonPath}.hub-tmp`
      writeFileSync(tmp, serializePackageJson(json))
      renameSync(tmp, packageJsonPath)
    },

    backup(at) {
      if (!existsSync(packageJsonPath)) return null
      const target = join(profileDir, backupFileName(backupStamp(at)))
      copyFileSync(packageJsonPath, target)
      return target
    },

    listBackups() {
      if (!existsSync(profileDir)) return []
      return readdirSync(profileDir)
        .filter((name) => name.startsWith('package.json.hub-bak-'))
        .sort()
    },

    rotateBackups(keep) {
      const toDelete = selectBackupsToDelete(this.listBackups(), keep)
      for (const name of toDelete) rmSync(join(profileDir, name), { force: true })
      return toDelete
    },

    restore(backupPath) {
      if (!existsSync(backupPath)) throw new HubError('INTERNAL', `备份不存在：${backupPath}`)
      copyFileSync(backupPath, packageJsonPath)
    },
  }
}
