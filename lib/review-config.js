// 项目级评审配置：`.egm/config.json` 的读取、校验与解析。
//
// 设计约束（对应补充方案 §7 C1）：
// - 纯数据，不执行任何 JS、不读 shell、不从配置里改工具权限或模型路由；
// - 字段不认识就报具体字段错误，绝不静默回落默认值；
// - 自定义角色的标准指向工作区内文件，只做校验与声明：真正派发仍限内置角色白名单
//   （工具 schema 的 enum 不因配置而放宽），所以 custom 角色带 `dispatchable:false`；
// - 角色/标准/配置哈希在“本次运行”内冻结：调用方先 load 再 resolve，运行中改文件只影响下一次。
//
// 角色白名单由调用方注入（dispatch.js 是唯一事实来源），这里不 import dispatch，
// 避免 import 环。

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

export const CONFIG_SCHEMA_VERSION = 1
export const MIN_CONCURRENCY = 1
export const MAX_CONCURRENCY = 3
export const MIN_BUDGET = 1
export const MAX_BUDGET = 50
export const MAX_PROFILES = 12
export const MAX_PROFILE_ROLES = 12
export const MAX_PROFILE_MATERIALS = 20
export const MAX_CONFIG_BYTES = 256 * 1024

const TOP_KEYS = ['schemaVersion', 'review']
const REVIEW_KEYS = ['defaultProfile', 'profiles']
const PROFILE_KEYS = ['label', 'roles', 'materials', 'stages', 'concurrency', 'budget', 'coverage', 'materialsPolicy']
const ROLE_OBJECT_KEYS = ['id', 'label', 'standard']
const STAGE_VALUES = [5, 6, 7, 8, 9]

export function reviewConfigPath(workspace) {
  return join(String(workspace), '.egm', 'config.json')
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function describeValue(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return '数组'
  return typeof value
}

function fail(code, error, extra) {
  return Object.assign({ ok: false, code, error }, extra && typeof extra === 'object' ? extra : {})
}

/** 未知字段一律报错：配置写错时宁可拒绝，也不按半懂的理解跑。 */
function findUnknownKey(object, allowed, where) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) return where + '.' + key
  }
  return null
}

/** 稳定序列化（键排序），用于配置哈希；改动字段只影响哈希，不改变语义。 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  const keys = Object.keys(value).sort()
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}'
}

export function configHashOf(config) {
  return createHash('sha256').update(canonicalJson(config), 'utf8').digest('hex')
}

function validateRoleEntry(entry, where, roleIds) {
  if (typeof entry === 'string') {
    const role = entry.trim()
    if (!roleIds.includes(role)) {
      return fail('E_CONFIG_ROLE_UNKNOWN', `${where} 里的角色「${role}」不在内置角色白名单（${roleIds.join(' / ')}）里；自定义角色请写成 {id,label,standard} 对象。`, { field: where })
    }
    return { ok: true, value: { id: role, custom: false } }
  }
  if (!isPlainObject(entry)) {
    return fail('E_CONFIG_FIELD_INVALID', `${where} 的每一项必须是内置角色名或 {id,label,standard} 对象，收到 ${describeValue(entry)}。`, { field: where })
  }
  const unknown = findUnknownKey(entry, ROLE_OBJECT_KEYS, where)
  if (unknown) {
    return fail('E_CONFIG_FIELD_UNKNOWN', `${unknown} 不是自定义角色支持的字段（只支持 ${ROLE_OBJECT_KEYS.join(' / ')}）。`, { field: unknown })
  }
  const id = typeof entry.id === 'string' ? entry.id.trim() : ''
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) {
    return fail('E_CONFIG_FIELD_INVALID', `${where}.id 必须是字母/数字/下划线/连字符组成的非空字符串。`, { field: where + '.id' })
  }
  const label = typeof entry.label === 'string' ? entry.label.trim() : ''
  if (!label) {
    return fail('E_CONFIG_FIELD_INVALID', `${where}.label 必须是非空字符串（面板和报告里要用它显示角色名）。`, { field: where + '.label' })
  }
  if (typeof entry.standard !== 'string' || !entry.standard.trim()) {
    return fail('E_CONFIG_FIELD_INVALID', `${where}.standard 必须是工作区内的相对路径（自定义角色必须声明标准文件）。`, { field: where + '.standard' })
  }
  return {
    ok: true,
    value: { id, custom: true, label, standard: entry.standard.trim() },
  }
}

function validateProfile(profile, where, roleIds) {
  if (!isPlainObject(profile)) {
    return fail('E_CONFIG_FIELD_INVALID', `${where} 必须是对象。`, { field: where })
  }
  const unknown = findUnknownKey(profile, PROFILE_KEYS, where)
  if (unknown) {
    return fail('E_CONFIG_FIELD_UNKNOWN', `${unknown} 不是评审配置支持的字段（支持 ${PROFILE_KEYS.join(' / ')}）。`, { field: unknown })
  }
  const out = { label: '', roles: [], materials: [], stages: [], concurrency: MAX_CONCURRENCY, budget: MAX_BUDGET, coverage: null, materialsPolicy: null }
  if (profile.label !== undefined) {
    if (typeof profile.label !== 'string' || !profile.label.trim()) {
      return fail('E_CONFIG_FIELD_INVALID', `${where}.label 必须是非空字符串。`, { field: where + '.label' })
    }
    out.label = profile.label.trim()
  }
  if (profile.roles !== undefined) {
    if (!Array.isArray(profile.roles)) {
      return fail('E_CONFIG_FIELD_INVALID', `${where}.roles 必须是数组。`, { field: where + '.roles' })
    }
    if (profile.roles.length === 0) {
      return fail('E_CONFIG_FIELD_INVALID', `${where}.roles 不能为空数组；不需要这个配置就别写它。`, { field: where + '.roles' })
    }
    if (profile.roles.length > MAX_PROFILE_ROLES) {
      return fail('E_CONFIG_FIELD_INVALID', `${where}.roles 最多 ${MAX_PROFILE_ROLES} 项，收到 ${profile.roles.length}。`, { field: where + '.roles' })
    }
    for (let index = 0; index < profile.roles.length; index++) {
      const checked = validateRoleEntry(profile.roles[index], `${where}.roles[${index}]`, roleIds)
      if (!checked.ok) return checked
      out.roles.push(checked.value)
    }
  }
  if (profile.materials !== undefined) {
    if (!Array.isArray(profile.materials)) {
      return fail('E_CONFIG_FIELD_INVALID', `${where}.materials 必须是数组。`, { field: where + '.materials' })
    }
    if (profile.materials.length > MAX_PROFILE_MATERIALS) {
      return fail('E_CONFIG_FIELD_INVALID', `${where}.materials 最多 ${MAX_PROFILE_MATERIALS} 项，收到 ${profile.materials.length}。`, { field: where + '.materials' })
    }
    for (let index = 0; index < profile.materials.length; index++) {
      const item = profile.materials[index]
      const field = `${where}.materials[${index}]`
      if (typeof item !== 'string' || !item.trim()) {
        return fail('E_CONFIG_FIELD_INVALID', `${field} 必须是非空字符串（工作区相对路径）。`, { field })
      }
      out.materials.push(item.trim())
    }
  }
  if (profile.stages !== undefined) {
    if (!Array.isArray(profile.stages) || profile.stages.length === 0) {
      return fail('E_CONFIG_FIELD_INVALID', `${where}.stages 必须是非空数组（取值 ${STAGE_VALUES.join('/')}）。`, { field: where + '.stages' })
    }
    for (let index = 0; index < profile.stages.length; index++) {
      const stage = profile.stages[index]
      const field = `${where}.stages[${index}]`
      if (!STAGE_VALUES.includes(stage)) {
        return fail('E_CONFIG_FIELD_INVALID', `${field} 只能是 ${STAGE_VALUES.join(' / ')}，收到 ${describeValue(stage)} ${String(stage)}。`, { field })
      }
      if (!out.stages.includes(stage)) out.stages.push(stage)
    }
  }
  if (profile.concurrency !== undefined) {
    if (!Number.isInteger(profile.concurrency) || profile.concurrency < MIN_CONCURRENCY || profile.concurrency > MAX_CONCURRENCY) {
      return fail('E_CONFIG_FIELD_INVALID', `${where}.concurrency 必须是 ${MIN_CONCURRENCY}–${MAX_CONCURRENCY} 的整数（宿主并发上限保守取 3）。`, { field: where + '.concurrency' })
    }
    out.concurrency = profile.concurrency
  }
  if (profile.budget !== undefined) {
    if (!Number.isInteger(profile.budget) || profile.budget < MIN_BUDGET || profile.budget > MAX_BUDGET) {
      return fail('E_CONFIG_FIELD_INVALID', `${where}.budget 必须是 ${MIN_BUDGET}–${MAX_BUDGET} 的整数派发次数上限。`, { field: where + '.budget' })
    }
    out.budget = profile.budget
  }
  if (profile.coverage !== undefined) {
    if (typeof profile.coverage !== 'string' || !profile.coverage.trim()) {
      return fail('E_CONFIG_FIELD_INVALID', `${where}.coverage 必须是非空字符串（写清这份配置覆盖什么范围）。`, { field: where + '.coverage' })
    }
    out.coverage = profile.coverage.trim()
  }
  if (profile.materialsPolicy !== undefined) {
    if (typeof profile.materialsPolicy !== 'string' || !profile.materialsPolicy.trim()) {
      return fail('E_CONFIG_FIELD_INVALID', `${where}.materialsPolicy 必须是非空字符串（说明材料来源与排除规则）。`, { field: where + '.materialsPolicy' })
    }
    out.materialsPolicy = profile.materialsPolicy.trim()
  }
  return { ok: true, value: out }
}

/**
 * 校验整份配置（纯函数，不碰文件系统）。
 * @returns {ok:true, config} | {ok:false, code, error, field}
 */
export function validateReviewConfig(raw, options) {
  const roleIds = Array.isArray(options?.roleIds) ? options.roleIds : []
  if (!isPlainObject(raw)) {
    return fail('E_CONFIG_SHAPE_INVALID', '配置文件顶层必须是对象。', { field: '' })
  }
  const unknownTop = findUnknownKey(raw, TOP_KEYS, 'config')
  if (unknownTop) {
    return fail('E_CONFIG_FIELD_UNKNOWN', `${unknownTop} 不是支持的顶层字段（只支持 ${TOP_KEYS.join(' / ')}）。`, { field: unknownTop })
  }
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    return fail('E_CONFIG_VERSION_UNSUPPORTED', `schemaVersion 只支持 ${CONFIG_SCHEMA_VERSION}，收到 ${describeValue(raw.schemaVersion)} ${String(raw.schemaVersion)}。`, { field: 'config.schemaVersion' })
  }
  const config = { schemaVersion: CONFIG_SCHEMA_VERSION, review: { defaultProfile: null, profiles: {} } }
  if (raw.review === undefined) return { ok: true, config }
  if (!isPlainObject(raw.review)) {
    return fail('E_CONFIG_FIELD_INVALID', 'config.review 必须是对象。', { field: 'config.review' })
  }
  const unknownReview = findUnknownKey(raw.review, REVIEW_KEYS, 'config.review')
  if (unknownReview) {
    return fail('E_CONFIG_FIELD_UNKNOWN', `${unknownReview} 不是 config.review 支持的字段（只支持 ${REVIEW_KEYS.join(' / ')}）。`, { field: unknownReview })
  }
  if (raw.review.defaultProfile !== undefined) {
    if (typeof raw.review.defaultProfile !== 'string' || !raw.review.defaultProfile.trim()) {
      return fail('E_CONFIG_FIELD_INVALID', 'config.review.defaultProfile 必须是非空字符串。', { field: 'config.review.defaultProfile' })
    }
    config.review.defaultProfile = raw.review.defaultProfile.trim()
  }
  if (raw.review.profiles !== undefined) {
    if (!isPlainObject(raw.review.profiles)) {
      return fail('E_CONFIG_FIELD_INVALID', 'config.review.profiles 必须是对象（配置名 → 配置内容）。', { field: 'config.review.profiles' })
    }
    const ids = Object.keys(raw.review.profiles)
    if (ids.length > MAX_PROFILES) {
      return fail('E_CONFIG_FIELD_INVALID', `config.review.profiles 最多 ${MAX_PROFILES} 份配置，收到 ${ids.length}。`, { field: 'config.review.profiles' })
    }
    for (const id of ids) {
      if (!/^[A-Za-z0-9_-]+$/.test(id)) {
        return fail('E_CONFIG_FIELD_INVALID', `config.review.profiles 的配置名「${id}」只能用字母/数字/下划线/连字符。`, { field: 'config.review.profiles' })
      }
      const checked = validateProfile(raw.review.profiles[id], `config.review.profiles.${id}`, roleIds)
      if (!checked.ok) return checked
      config.review.profiles[id] = checked.value
    }
  }
  if (config.review.defaultProfile && !Object.prototype.hasOwnProperty.call(config.review.profiles, config.review.defaultProfile)) {
    return fail('E_CONFIG_DEFAULT_MISSING', `defaultProfile 指向「${config.review.defaultProfile}」，但 profiles 里没有这份配置。`, { field: 'config.review.defaultProfile' })
  }
  return { ok: true, config }
}

/**
 * 读并校验 `.egm/config.json`。文件不存在是正常情况（present:false），不是错误。
 */
export function loadReviewConfig(options) {
  const workspace = String(options?.workspace || '')
  const roleIds = Array.isArray(options?.roleIds) ? options.roleIds : []
  if (!workspace) return fail('E_CONFIG_NO_WORKSPACE', '没有工作区路径，读不到评审配置。')
  const path = reviewConfigPath(workspace)
  let stat
  try {
    stat = fs.statSync(path)
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { ok: true, present: false, path, hash: null, config: { schemaVersion: CONFIG_SCHEMA_VERSION, review: { defaultProfile: null, profiles: {} } } }
    }
    return fail('E_CONFIG_UNREADABLE', `读不到 ${path}：${error && error.message ? error.message : String(error)}`, { path })
  }
  if (!stat.isFile()) return fail('E_CONFIG_NOT_FILE', `${path} 不是普通文件。`, { path })
  if (stat.size > MAX_CONFIG_BYTES) {
    return fail('E_CONFIG_TOO_LARGE', `${path} 有 ${stat.size} 字节，超过上限 ${MAX_CONFIG_BYTES}。`, { path })
  }
  let text
  try {
    text = fs.readFileSync(path, 'utf8')
  } catch (error) {
    return fail('E_CONFIG_UNREADABLE', `读不到 ${path}：${error && error.message ? error.message : String(error)}`, { path })
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return fail('E_CONFIG_INVALID_JSON', `${path} 不是合法 JSON：${error && error.message ? error.message : String(error)}`, { path })
  }
  const checked = validateReviewConfig(raw, { roleIds })
  if (!checked.ok) {
    return Object.assign({}, checked, { path })
  }
  return { ok: true, present: true, path, hash: configHashOf(checked.config), config: checked.config }
}

/** 工作区内相对路径 → 绝对路径；越界（..\\ 或绝对路径）一律拒绝。 */
export function resolveWorkspaceFile(workspace, relativePath) {
  const raw = String(relativePath || '')
  if (!raw) return fail('E_CONFIG_FIELD_INVALID', '路径为空。')
  if (isAbsolute(raw)) return fail('E_CONFIG_PATH_ESCAPE', `只接受工作区内的相对路径，收到绝对路径 ${raw}。`)
  const base = resolve(String(workspace))
  const target = resolve(base, raw)
  const rel = relative(base, target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    return fail('E_CONFIG_PATH_ESCAPE', `${raw} 落在工作区之外，拒绝读取。`)
  }
  return { ok: true, path: target, relative: rel.split('\\').join('/') }
}

/**
 * 解析一份配置：校验材料与自定义标准文件是否真的存在，并标注能否派发。
 * @returns {ok:true, profile, hash} | {ok:false, code, error, field}
 */
export function resolveReviewProfile(options) {
  const workspace = String(options?.workspace || '')
  const roleIds = Array.isArray(options?.roleIds) ? options.roleIds : []
  const loaded = options?.config
    ? { ok: true, config: options.config, hash: options.hash || configHashOf(options.config), present: true }
    : loadReviewConfig({ workspace, roleIds })
  if (!loaded.ok) return loaded
  const profiles = loaded.config.review.profiles || {}
  const profileId = String(options?.profileId || loaded.config.review.defaultProfile || 'builtin')
  if (profileId === 'builtin') {
    return {
      ok: true,
      hash: loaded.hash,
      profile: {
        id: 'builtin',
        label: '内置默认（不读配置）',
        roles: roleIds.map((role) => ({ id: role, custom: false, dispatchable: true })),
        materials: [],
        stages: [],
        concurrency: MAX_CONCURRENCY,
        budget: MAX_BUDGET,
        coverage: null,
        materialsPolicy: null,
      },
    }
  }
  const profile = profiles[profileId]
  if (!profile) {
    const available = Object.keys(profiles)
    return fail(
      'E_PROFILE_NOT_FOUND',
      `.egm/config.json 里没有名为「${profileId}」的评审配置。${available.length ? '已有：' + available.join(' / ') : '（文件里还没写任何配置）'}`,
      { field: 'config.review.profiles' },
    )
  }
  const roles = []
  for (const entry of profile.roles) {
    if (!entry.custom) {
      roles.push({ id: entry.id, custom: false, dispatchable: true })
      continue
    }
    const resolved = resolveWorkspaceFile(workspace, entry.standard)
    if (!resolved.ok) {
      return fail('E_PROFILE_STANDARD_INVALID', `自定义角色「${entry.id}」的标准路径不合法：${resolved.error}`, { field: 'standard' })
    }
    let stat
    try {
      stat = fs.statSync(resolved.path)
    } catch (error) {
      return fail(
        'E_PROFILE_STANDARD_MISSING',
        `自定义角色「${entry.id}」的标准文件不存在：${resolved.relative}（不会用默认标准顶替）。`,
        { field: 'standard', path: resolved.path },
      )
    }
    if (!stat.isFile()) {
      return fail('E_PROFILE_STANDARD_MISSING', `自定义角色「${entry.id}」的标准路径不是普通文件：${resolved.relative}。`, { field: 'standard', path: resolved.path })
    }
    roles.push({ id: entry.id, custom: true, label: entry.label, standardPath: resolved.path, standardRelative: resolved.relative, dispatchable: true })
  }
  const materials = []
  const missing = []
  for (const item of profile.materials) {
    const resolved = resolveWorkspaceFile(workspace, item)
    if (!resolved.ok) {
      missing.push({ path: item, reason: resolved.error })
      continue
    }
    let stat = null
    try {
      stat = fs.statSync(resolved.path)
    } catch {
      missing.push({ path: resolved.relative, reason: '文件不存在' })
      continue
    }
    if (!stat.isFile()) {
      missing.push({ path: resolved.relative, reason: '不是普通文件（目录请显式展开，不静默递归）' })
      continue
    }
    materials.push({ path: resolved.relative, absolute: resolved.path, bytes: stat.size })
  }
  if (missing.length > 0) {
    return fail(
      'E_PROFILE_MATERIAL_MISSING',
      `评审配置「${profileId}」声明的材料缺失：${missing.map((m) => m.path + '（' + m.reason + '）').join('；')}。缺失材料不会被默认内容顶替。`,
      { field: 'materials', missing },
    )
  }
  return {
    ok: true,
    hash: loaded.hash,
    profile: {
      id: profileId,
      label: profile.label || profileId,
      roles,
      materials,
      stages: profile.stages.slice(),
      concurrency: profile.concurrency,
      budget: profile.budget,
      coverage: profile.coverage,
      materialsPolicy: profile.materialsPolicy,
    },
  }
}

/**
 * 给面板/命令用的摘要（有界，不返回全文）。
 */
export function describeReviewConfig(options) {
  const workspace = String(options?.workspace || '')
  const roleIds = Array.isArray(options?.roleIds) ? options.roleIds : []
  const loaded = loadReviewConfig({ workspace, roleIds })
  if (!loaded.ok) {
    return {
      ok: false,
      present: true,
      path: loaded.path || reviewConfigPath(workspace),
      hash: null,
      defaultProfile: null,
      profiles: [],
      error: loaded.error,
      field: loaded.field || null,
      code: loaded.code || null,
    }
  }
  const profiles = []
  const rawProfiles = loaded.config.review.profiles || {}
  for (const id of Object.keys(rawProfiles)) {
    const profile = rawProfiles[id]
    profiles.push({
      id,
      label: profile.label || id,
      roles: profile.roles.map((role) => (role.custom ? { id: role.id, label: role.label, custom: true } : { id: role.id, custom: false })),
      materialCount: profile.materials.length,
      stages: profile.stages.slice(),
      concurrency: profile.concurrency,
      budget: profile.budget,
      coverage: profile.coverage,
    })
  }
  return {
    ok: true,
    present: loaded.present === true,
    path: loaded.path,
    hash: loaded.hash,
    defaultProfile: loaded.config.review.defaultProfile,
    profiles,
    error: null,
    field: null,
    code: null,
  }
}
