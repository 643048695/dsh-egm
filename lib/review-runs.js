// EGM 评审运行台账（Review Runs Registry）
//
// 目的：把"这张图纸真的被金鱼审过吗"变成可核对的事实，而不是聊天里的口头记忆。
//   - 每次派金鱼（dispatchGoldfish / batch）落盘一条运行记录，内含图纸 sha256；
//   - /egm-action proceed 时把当前图纸 sha256 与最新成功评审记录比对：
//     不一致或缺失 → E_REVIEW_STALE，要求用户显式 confirm 覆盖（覆盖本身也留痕）。
// 边界（诚实声明）：
//   - 这只证明"这份图纸被审过"，不证明"评审质量合格"，更不自动放行实现；
//   - 台账可被人为删除/伪造，它只是防"忘了审就开写"的提醒机制，不是安全边界。

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { join, resolve } from 'node:path'
import { safeSessionId } from './active-task.js'

/**
 * 计算某工作区评审台账目录：.egm/reviews/
 * @param {string} workspace
 * @returns {string}
 */
export function reviewsDirPath(workspace) {
  return join(resolve(workspace), '.egm', 'reviews')
}

/**
 * 计算图纸文件的 sha256。读不到文件时返回 null（由调用方决定如何提示）。
 * @param {string} docPath
 * @returns {string|null}
 */
export function docSha256Of(docPath) {
  const p = String(docPath ?? '').trim()
  if (!p) return null
  try {
    const buf = fs.readFileSync(p)
    return createHash('sha256').update(buf).digest('hex')
  } catch {
    return null
  }
}

/**
 * 落盘一条评审运行记录：.egm/reviews/<ts>-<role>-<rand>.json
 * @param {{ workspace: string, sessionId: string, taskId?: string|null, docPath: string, role: string, stage?: string|null, ok?: boolean, reportPath?: string|null, startedAt?: number, endedAt?: number }} params
 * @returns {object|null} 写入的记录（含 file 字段）；失败返回 null（台账故障不阻断派发本身）
 */
export function recordReviewRun({
  workspace,
  sessionId,
  taskId = null,
  docPath,
  role,
  stage = null,
  ok = null,
  reportPath = null,
  startedAt = null,
  endedAt = null,
}) {
  const sid = String(sessionId ?? '').trim()
  if (!sid || !docPath) return null
  const entry = {
    sessionId: sid,
    taskId: taskId || null,
    docPath: String(docPath),
    docSha256: docSha256Of(docPath),
    role: String(role ?? ''),
    stage: stage ?? null,
    ok: typeof ok === 'boolean' ? ok : null,
    reportPath: reportPath || null,
    startedAt: typeof startedAt === 'number' ? startedAt : null,
    endedAt: typeof endedAt === 'number' ? endedAt : null,
    recordedAt: Date.now(),
  }
  try {
    const dir = reviewsDirPath(workspace)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const safeRole = String(role ?? 'review').replace(/[^a-zA-Z0-9_-]/g, '_')
    const file = `${Date.now()}-${safeRole}-${Math.random().toString(36).slice(2, 8)}.json`
    fs.writeFileSync(join(dir, file), JSON.stringify(entry, null, 2), 'utf8')
    return { ...entry, file }
  } catch {
    // 台账写失败：派发照常，proceed 门会按"没有评审记录"处理并如实提示。
    return null
  }
}

/**
 * 读取某会话某图纸的最新成功评审记录（时间新的优先）。
 * 单条损坏/越界只跳过。
 *
 * @param {{ workspace: string, sessionId: string, docPath: string, role?: string|null }} params
 * @returns {{ run: object|null, checkedAt: number }}
 */
export function latestSuccessfulReviewRun({ workspace, sessionId, docPath, role = null }) {
  const sid = String(sessionId ?? '').trim()
  const doc = String(docPath ?? '').trim()
  const empty = { run: null, checkedAt: Date.now() }
  if (!sid || !doc) return empty

  let names = []
  try {
    names = fs.readdirSync(reviewsDirPath(workspace))
  } catch {
    return empty
  }

  const entries = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(fs.readFileSync(join(reviewsDirPath(workspace), name), 'utf8'))
      if (!parsed || typeof parsed !== 'object') continue
      if (parsed.sessionId !== sid) continue
      if (String(parsed.docPath ?? '').trim() !== doc) continue
      if (role && parsed.role !== role) continue
      if (parsed.ok !== true) continue
      entries.push(parsed)
    } catch {
      // 损坏记录跳过
    }
  }

  entries.sort((a, b) => (b.recordedAt || 0) - (a.recordedAt || 0))
  return { run: entries[0] || null, checkedAt: Date.now() }
}

/**
 * proceed 门检查：当前图纸是否已有与之匹配（sha256 一致）的成功评审。
 * 返回判定与给用户看的中文理由，不做任何副作用。
 *
 * @param {{ workspace: string, sessionId: string, docPath: string }} params
 * @returns {{ ok: boolean, code: string, reason: string }}
 */
export function checkReviewFreshness({ workspace, sessionId, docPath }) {
  const sha = docSha256Of(docPath)
  if (!sha) {
    return {
      ok: false,
      code: 'E_DOC_UNREADABLE',
      reason: '图纸文件当前读不到，无法核对是否评审过这份内容。',
    }
  }
  const { run } = latestSuccessfulReviewRun({ workspace, sessionId, docPath })
  if (!run) {
    return {
      ok: false,
      code: 'E_REVIEW_MISSING',
      reason: '没有查到对这份图纸的成功评审记录。',
    }
  }
  if (run.docSha256 !== sha) {
    return {
      ok: false,
      code: 'E_REVIEW_STALE',
      reason: '图纸在最近一次评审之后又改过了，旧评审结论不再覆盖当前内容。',
    }
  }
  return { ok: true, code: 'OK', reason: '图纸与最近一次成功评审一致。' }
}
