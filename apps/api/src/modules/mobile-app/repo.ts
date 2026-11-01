import type { HubDb } from '../../db/index.js'
import type { MobileAppReleaseRow } from './types.js'

/** 安卓 App 发布记录的表访问（只有本模块的 service 用；别的模块不读这张表） */

const COLUMNS =
  'id, version_name, version_code, file_name, bytes, sha256, status, uploaded_by, uploaded_at'

export function listReleases(db: HubDb): MobileAppReleaseRow[] {
  return db.all<MobileAppReleaseRow>(
    `SELECT ${COLUMNS} FROM mobile_app_releases ORDER BY version_code DESC, id DESC`,
  )
}

export function findRelease(db: HubDb, id: number): MobileAppReleaseRow | null {
  return db.get<MobileAppReleaseRow>(`SELECT ${COLUMNS} FROM mobile_app_releases WHERE id = ?`, id) ?? null
}

export function currentRelease(db: HubDb): MobileAppReleaseRow | null {
  return (
    db.get<MobileAppReleaseRow>(
      `SELECT ${COLUMNS} FROM mobile_app_releases WHERE status = 'published'`,
    ) ?? null
  )
}

export function findReleaseByFile(db: HubDb, fileName: string): MobileAppReleaseRow | null {
  return (
    db.get<MobileAppReleaseRow>(`SELECT ${COLUMNS} FROM mobile_app_releases WHERE file_name = ?`, fileName) ?? null
  )
}

/**
 * 回滚的目标：**比当前版本旧的**已发布记录里 versionCode 最高的那条。
 *
 * 只往旧的回滚（不包含更新的版本）：否则连点两次「回滚」会在两个版本之间来回跳，
 * 运维看到的状态就不是「一路往前回退」了。要指定任意记录（包括更新的）用 `releaseId`。
 */
export function previousRelease(db: HubDb, current: MobileAppReleaseRow): MobileAppReleaseRow | null {
  return (
    db.get<MobileAppReleaseRow>(
      `SELECT ${COLUMNS} FROM mobile_app_releases
        WHERE id <> ? AND version_code < ?
        ORDER BY version_code DESC, id DESC LIMIT 1`,
      current.id,
      current.version_code,
    ) ?? null
  )
}

/**
 * 插入一条发布记录并把它设为唯一的 published（旧的自动 yank）。
 *
 * 整个过程在调用方的 `db.tx` 里跑：部分唯一索引 `mobile_app_releases_published` 会兜住
 * 「同时出现两条 published」这种并发，事务失败就整体回滚（文件由 service 负责删）。
 */
export function insertPublished(
  db: HubDb,
  row: {
    versionName: string
    versionCode: number
    fileName: string
    bytes: number
    sha256: string
    actorId: number | null
    at: string
  },
): number {
  db.run("UPDATE mobile_app_releases SET status = 'yanked' WHERE status = 'published'")
  db.run(
    `INSERT INTO mobile_app_releases (version_name, version_code, file_name, bytes, sha256, status, uploaded_by, uploaded_at)
     VALUES (?, ?, ?, ?, ?, 'published', ?, ?)`,
    row.versionName,
    row.versionCode,
    row.fileName,
    row.bytes,
    row.sha256,
    row.actorId,
    row.at,
  )
  const created = db.get<{ id: number }>('SELECT last_insert_rowid() AS id')
  return created?.id ?? 0
}

/** 回滚：把目标行标回 published，其余 published 行 yank 掉 */
export function publishOnly(db: HubDb, id: number): void {
  db.run("UPDATE mobile_app_releases SET status = 'yanked' WHERE status = 'published' AND id <> ?", id)
  db.run("UPDATE mobile_app_releases SET status = 'published' WHERE id = ?", id)
}
