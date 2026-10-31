// EGM 材料收集器：把"文件 / 目录清单 / 网址"变成房间里的受控副本 + 清单
//
// 目的：金鱼只看文件，所以材料必须先落到受控目录，并留下"收了什么、漏了什么"的清单。
//
// 规则：
//   - 文件：必须是工作区内的普通文件，复制进材料目录，算哈希；
//   - 目录：按 .gitignore / .egmignore 展开，跳过依赖、构建、版本库与二进制；
//     有硬上限（文件数、单文件大小、总量），超了就明确记录"被排除/被截断"，不假装全覆盖；
//   - 网址：只抓用户明确给出的 http(s) 公开地址；先解析域名，拒私网/环回/链路本地；
//     跳转逐跳复核，最多 3 跳；限时、限大小、限内容类型；失败记"缺材料"，绝不用模型记忆补。
//
// 边界（诚实声明）：
//   - 无法保证目录里没有敏感信息（密钥、token 可能藏在普通文本里），清单只列路径与大小；
//   - 抓取用的是本进程的网络能力，没有核实宿主是否有自己的读取通道；
//   - 抓取失败就是缺材料，报告必须写"缺了什么"，不能凭印象补。

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import dns from 'node:dns/promises'
import net from 'node:net'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const DEFAULT_LIMITS = Object.freeze({
  maxFiles: 20,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  maxDepth: 6,
  maxUrlBytes: 1024 * 1024,
  urlTimeoutMs: 15_000,
  maxRedirects: 3,
})

const SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  '.egm',
  '.pnpm-store',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.idea',
  '.vscode',
  'coverage',
])

const SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff',
  '.mp3', '.mp4', '.mov', '.avi', '.wav', '.flac', '.webm',
  '.zip', '.gz', '.tar', '.7z', '.rar', '.xz', '.bz2',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.wasm', '.class', '.jar',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.lock', '.map',
])

const TEXT_TYPES = [
  'text/',
  'application/json',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
  'application/toml',
  'application/javascript',
  'application/typescript',
]

/** 材料目录：.egm/materials/<ts>-<rand>/ */
export function materialsRoot(workspace) {
  return join(resolve(String(workspace ?? '.')), '.egm', 'materials')
}

function safeName(name, fallback = 'material') {
  const base = basename(String(name ?? '').trim()) || fallback
  return base.replace(/[^A-Za-z0-9._\u4e00-\u9fff-]/g, '_').slice(0, 80) || fallback
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/** 解析简单 ignore 规则（支持注释、目录后缀 /、! 取反、* 通配）。 */
export function parseIgnoreRules(text) {
  const rules = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const raw = line.trim()
    if (!raw || raw.startsWith('#')) continue
    const negate = raw.startsWith('!')
    const body = (negate ? raw.slice(1) : raw).trim()
    if (!body) continue
    const dirOnly = body.endsWith('/')
    const cleaned = body.replace(/^\/+/, '').replace(/\/+$/, '')
    if (!cleaned) continue
    const pattern = cleaned
      .split('*')
      .map(part => part.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
      .join('[^/]*')
    rules.push({ negate, dirOnly, regex: new RegExp(`(^|/)${pattern}($|/)`) })
  }
  return rules
}

function isIgnored(relPath, rules) {
  const posix = relPath.split(sep).join('/')
  let ignored = false
  for (const rule of rules) {
    if (rule.regex.test(posix)) ignored = !rule.negate
  }
  return ignored
}

function readIgnoreRules(workspace) {
  const rules = []
  for (const name of ['.gitignore', '.egmignore']) {
    try {
      rules.push(...parseIgnoreRules(fs.readFileSync(join(workspace, name), 'utf8')))
    } catch {
      // 没有就跳过
    }
  }
  return rules
}

/**
 * 展开目录：返回可复制的文件列表与被排除清单。
 * @param {{ workspace: string, dir: string, limits?: object }} params
 */
export function expandDirectory({ workspace, dir, limits = {} }) {
  const config = { ...DEFAULT_LIMITS, ...limits }
  const ws = resolve(String(workspace ?? '.'))
  const absolute = resolve(ws, String(dir ?? ''))
  const rel = relative(ws, absolute)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, code: 'E_MATERIAL_ESCAPE', error: `目录必须位于工作区内：${dir}` }
  }
  let stat
  try {
    stat = fs.statSync(absolute)
  } catch {
    return { ok: false, code: 'E_MATERIAL_MISSING', error: `目录不存在：${dir}` }
  }
  if (!stat.isDirectory()) {
    return { ok: false, code: 'E_MATERIAL_NOT_DIR', error: `不是目录：${dir}` }
  }

  const rules = readIgnoreRules(ws)
  const included = []
  const excluded = []
  let totalBytes = 0
  let truncated = false

  const walk = (current, depth) => {
    if (truncated) return
    if (depth > config.maxDepth) {
      excluded.push({ path: relative(ws, current).split(sep).join('/'), reason: `超过最大目录深度 ${config.maxDepth}` })
      return
    }
    let entries = []
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch (error) {
      excluded.push({ path: relative(ws, current).split(sep).join('/'), reason: `读不出来：${error?.message ?? String(error)}` })
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (truncated) return
      const abs = join(current, entry.name)
      const relPath = relative(ws, abs).split(sep).join('/')
      if (SKIP_DIRS.has(entry.name)) {
        excluded.push({ path: relPath, reason: '依赖/构建/版本库目录' })
        continue
      }
      if (isIgnored(relPath, rules)) {
        excluded.push({ path: relPath, reason: '被 .gitignore / .egmignore 排除' })
        continue
      }
      if (entry.isSymbolicLink()) {
        excluded.push({ path: relPath, reason: '符号链接（不跟随，避免跑出工作区）' })
        continue
      }
      if (entry.isDirectory()) {
        walk(abs, depth + 1)
        continue
      }
      if (!entry.isFile()) {
        excluded.push({ path: relPath, reason: '不是普通文件' })
        continue
      }
      if (SKIP_EXT.has(extname(entry.name).toLowerCase())) {
        excluded.push({ path: relPath, reason: '二进制/媒体/压缩包等非文本材料' })
        continue
      }
      let info
      try {
        info = fs.statSync(abs)
      } catch {
        excluded.push({ path: relPath, reason: '取不到文件信息' })
        continue
      }
      if (info.size > config.maxFileBytes) {
        excluded.push({ path: relPath, reason: `单个文件超过 ${Math.round(config.maxFileBytes / 1024)}KB` })
        continue
      }
      if (included.length >= config.maxFiles) {
        truncated = true
        excluded.push({ path: relPath, reason: `超过材料文件数上限 ${config.maxFiles}，后面的没有收` })
        return
      }
      if (totalBytes + info.size > config.maxTotalBytes) {
        truncated = true
        excluded.push({ path: relPath, reason: `超过材料总量上限 ${Math.round(config.maxTotalBytes / 1024 / 1024)}MB，后面的没有收` })
        return
      }
      totalBytes += info.size
      included.push({ absolutePath: abs, relativePath: relPath, bytes: info.size })
    }
  }

  walk(absolute, 0)
  return { ok: true, files: included, excluded, truncated, totalBytes }
}

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const parts = address.split('.').map(Number)
    if (parts[0] === 10) return true
    if (parts[0] === 127) return true
    if (parts[0] === 0) return true
    if (parts[0] === 169 && parts[1] === 254) return true
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
    if (parts[0] === 192 && parts[1] === 168) return true
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true
    if (parts[0] >= 224) return true
    return false
  }
  if (net.isIPv6(address)) {
    const lower = address.toLowerCase()
    if (lower === '::1' || lower === '::') return true
    if (lower.startsWith('fe80')) return true
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true
    if (lower.startsWith('ff')) return true
    return false
  }
  return true
}

async function assertPublicHost(hostname) {
  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      return { ok: false, code: 'E_URL_PRIVATE', error: `拒绝抓取内网/环回地址：${hostname}` }
    }
    return { ok: true }
  }
  let records = []
  try {
    records = await dns.lookup(hostname, { all: true })
  } catch (error) {
    return { ok: false, code: 'E_URL_DNS', error: `域名解析失败：${hostname}（${error?.message ?? String(error)}）` }
  }
  for (const record of records) {
    if (isPrivateAddress(record.address)) {
      return { ok: false, code: 'E_URL_PRIVATE', error: `域名指向内网地址，拒绝抓取：${hostname} → ${record.address}` }
    }
  }
  return { ok: true }
}

/**
 * 抓一个网址材料。跳转逐跳复核，限时限大小，只收文本类内容。
 * @param {{ url: string, targetDir: string, limits?: object }} params
 */
export async function fetchUrlMaterial({ url, targetDir, limits = {} }) {
  const config = { ...DEFAULT_LIMITS, ...limits }
  let parsed
  try {
    parsed = new URL(String(url ?? '').trim())
  } catch {
    return { ok: false, code: 'E_URL_INVALID', error: `不是合法网址：${url}` }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, code: 'E_URL_SCHEME', error: `只支持 http/https：${parsed.protocol}` }
  }

  let current = parsed
  let response = null
  const chain = []
  for (let hop = 0; hop <= config.maxRedirects; hop += 1) {
    const hostCheck = await assertPublicHost(current.hostname)
    if (!hostCheck.ok) return { ...hostCheck, originalUrl: parsed.toString(), finalUrl: current.toString() }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.urlTimeoutMs)
    try {
      response = await fetch(current.toString(), {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'user-agent': 'dsh-egm-material/1.0 (+local plugin)' },
      })
    } catch (error) {
      clearTimeout(timer)
      const aborted = error?.name === 'AbortError'
      return {
        ok: false,
        code: aborted ? 'E_URL_TIMEOUT' : 'E_URL_FETCH',
        error: aborted ? `抓取超时（${config.urlTimeoutMs}ms）：${current.toString()}` : `抓取失败：${current.toString()}（${error?.message ?? String(error)}）`,
        originalUrl: parsed.toString(),
        finalUrl: current.toString(),
      }
    }
    clearTimeout(timer)
    chain.push(current.toString())
    const status = response.status
    if (status >= 300 && status < 400) {
      const location = response.headers.get('location')
      if (!location) {
        return { ok: false, code: 'E_URL_REDIRECT', error: `跳转没有目标地址（HTTP ${status}）`, originalUrl: parsed.toString(), finalUrl: current.toString() }
      }
      let next
      try {
        next = new URL(location, current)
      } catch {
        return { ok: false, code: 'E_URL_REDIRECT', error: `跳转地址不合法：${location}`, originalUrl: parsed.toString(), finalUrl: current.toString() }
      }
      current = next
      continue
    }
    if (status < 200 || status >= 300) {
      return {
        ok: false,
        code: 'E_URL_STATUS',
        error: `网址返回 HTTP ${status}，按缺材料处理：${current.toString()}`,
        originalUrl: parsed.toString(),
        finalUrl: current.toString(),
      }
    }
    break
  }

  if (!response) {
    return { ok: false, code: 'E_URL_REDIRECT', error: `跳转超过 ${config.maxRedirects} 次，放弃抓取。`, originalUrl: parsed.toString(), finalUrl: current.toString() }
  }

  const contentType = String(response.headers.get('content-type') ?? '').toLowerCase()
  if (contentType && !TEXT_TYPES.some(prefix => contentType.startsWith(prefix))) {
    return {
      ok: false,
      code: 'E_URL_CONTENT_TYPE',
      error: `内容类型不是文本（${contentType}），不抓二进制材料：${current.toString()}`,
      originalUrl: parsed.toString(),
      finalUrl: current.toString(),
    }
  }
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > config.maxUrlBytes) {
    return {
      ok: false,
      code: 'E_URL_TOO_LARGE',
      error: `内容声明大小 ${declared} 字节，超过上限 ${config.maxUrlBytes}：${current.toString()}`,
      originalUrl: parsed.toString(),
      finalUrl: current.toString(),
    }
  }
  let buffer
  try {
    buffer = Buffer.from(await response.arrayBuffer())
  } catch (error) {
    return {
      ok: false,
      code: 'E_URL_READ',
      error: `读取响应失败：${error?.message ?? String(error)}`,
      originalUrl: parsed.toString(),
      finalUrl: current.toString(),
    }
  }
  if (buffer.length > config.maxUrlBytes) {
    return {
      ok: false,
      code: 'E_URL_TOO_LARGE',
      error: `内容 ${buffer.length} 字节，超过上限 ${config.maxUrlBytes}：${current.toString()}`,
      originalUrl: parsed.toString(),
      finalUrl: current.toString(),
    }
  }

  const urlPath = current.pathname === '/' ? '/index' : current.pathname
  const name = safeName(`${current.hostname}${urlPath}`, 'url-material') + (extname(urlPath) ? '' : '.txt')
  const filePath = join(targetDir, name)
  try {
    await fsp.mkdir(targetDir, { recursive: true })
    await fsp.writeFile(filePath, buffer)
  } catch (error) {
    return {
      ok: false,
      code: 'E_URL_SAVE',
      error: `保存抓取内容失败：${error?.message ?? String(error)}`,
      originalUrl: parsed.toString(),
      finalUrl: current.toString(),
    }
  }
  return {
    ok: true,
    filePath,
    originalUrl: parsed.toString(),
    finalUrl: current.toString(),
    redirectChain: chain,
    fetchedAt: Date.now(),
    contentType: contentType || null,
    bytes: buffer.length,
    sha256: sha256(buffer),
  }
}

/**
 * 收集材料：文件 + 目录 + 网址 → 受控副本目录 + manifest.json
 *
 * @param {{ workspace: string, entries: string[], limits?: object }} params
 * @returns {Promise<object>} { ok, files: string[], manifestPath, manifestSha256, items, excluded, missing, coverage, notes }
 */
export async function collectMaterials({ workspace, entries, limits = {} }) {
  const config = { ...DEFAULT_LIMITS, ...limits }
  const ws = resolve(String(workspace ?? '.'))
  const list = Array.isArray(entries) ? entries.map(item => String(item ?? '').trim()).filter(Boolean) : []
  if (list.length === 0) {
    return { ok: true, files: [], manifestPath: null, manifestSha256: null, items: [], excluded: [], missing: [], coverage: null, notes: [] }
  }

  const dir = join(materialsRoot(ws), `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`)
  try {
    await fsp.mkdir(dir, { recursive: true })
  } catch (error) {
    return { ok: false, code: 'E_MATERIAL_DIR', error: `创建材料目录失败：${error?.message ?? String(error)}` }
  }

  const items = []
  const excluded = []
  const missing = []
  const notes = []
  const usedNames = new Set()
  let totalBytes = 0

  const copyFile = async (absolutePath, sourceLabel, extra = {}) => {
    if (items.length >= config.maxFiles) {
      excluded.push({ path: sourceLabel, reason: `超过材料文件数上限 ${config.maxFiles}` })
      return null
    }
    let info
    try {
      info = await fsp.stat(absolutePath)
    } catch {
      missing.push({ source: sourceLabel, reason: '文件不存在' })
      return null
    }
    if (info.size > config.maxFileBytes) {
      excluded.push({ path: sourceLabel, reason: `单个文件超过 ${Math.round(config.maxFileBytes / 1024)}KB` })
      return null
    }
    if (totalBytes + info.size > config.maxTotalBytes) {
      excluded.push({ path: sourceLabel, reason: `超过材料总量上限 ${Math.round(config.maxTotalBytes / 1024 / 1024)}MB` })
      return null
    }
    let name = safeName(basename(absolutePath), 'material')
    let counter = 1
    while (usedNames.has(name)) {
      const ext = extname(name)
      name = `${basename(name, ext)}-${counter}${ext}`
      counter += 1
    }
    usedNames.add(name)
    const target = join(dir, name)
    try {
      await fsp.copyFile(absolutePath, target)
    } catch (error) {
      missing.push({ source: sourceLabel, reason: `复制失败：${error?.message ?? String(error)}` })
      return null
    }
    const buffer = await fsp.readFile(target)
    totalBytes += buffer.length
    const item = {
      source: sourceLabel,
      kind: extra.kind ?? 'file',
      copy: name,
      bytes: buffer.length,
      sha256: sha256(buffer),
      ...extra,
    }
    items.push(item)
    return target
  }

  for (const entry of list) {
    if (/^https?:\/\//i.test(entry)) {
      const fetched = await fetchUrlMaterial({ url: entry, targetDir: dir, limits: config })
      if (!fetched.ok) {
        missing.push({ source: entry, reason: fetched.error, code: fetched.code })
        continue
      }
      usedNames.add(basename(fetched.filePath))
      const buffer = await fsp.readFile(fetched.filePath)
      totalBytes += buffer.length
      items.push({
        source: entry,
        kind: 'url',
        copy: basename(fetched.filePath),
        bytes: buffer.length,
        sha256: fetched.sha256,
        originalUrl: fetched.originalUrl,
        finalUrl: fetched.finalUrl,
        redirectChain: fetched.redirectChain,
        fetchedAt: fetched.fetchedAt,
        contentType: fetched.contentType,
      })
      continue
    }

    const normalized = entry.replace(/^dir:/, '').replace(/^file:/, '')
    const absolute = resolve(ws, normalized)
    const rel = relative(ws, absolute)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      missing.push({ source: entry, reason: '不在工作区内，拒绝收集' })
      continue
    }
    let info
    try {
      info = await fsp.stat(absolute)
    } catch {
      missing.push({ source: entry, reason: '文件或目录不存在' })
      continue
    }
    if (info.isDirectory()) {
      const expanded = expandDirectory({ workspace: ws, dir: normalized, limits: config })
      if (!expanded.ok) {
        missing.push({ source: entry, reason: expanded.error, code: expanded.code })
        continue
      }
      excluded.push(...expanded.excluded)
      for (const file of expanded.files) {
        await copyFile(file.absolutePath, file.relativePath, { kind: 'dir-file', fromDir: normalized })
      }
      if (expanded.truncated) notes.push(`目录 ${normalized} 因为上限被截断，清单里列出了被排除的文件。`)
      continue
    }
    if (!info.isFile()) {
      missing.push({ source: entry, reason: '不是普通文件' })
      continue
    }
    await copyFile(absolute, rel.split(sep).join('/'), { kind: 'file' })
  }

  const coverage = {
    requested: list.length,
    included: items.length,
    excluded: excluded.length,
    missing: missing.length,
    totalBytes,
    limits: {
      maxFiles: config.maxFiles,
      maxFileBytes: config.maxFileBytes,
      maxTotalBytes: config.maxTotalBytes,
      maxUrlBytes: config.maxUrlBytes,
    },
    complete: excluded.length === 0 && missing.length === 0,
  }
  if (!coverage.complete) {
    notes.push('材料没有全部收进来：被排除或抓取失败的项都在清单里，报告需要按"缺材料"处理，不能用印象补。')
  }
  notes.push('材料是受控副本，不是安全隔离；目录里可能仍有敏感信息，发出前请自己确认。')

  const manifest = {
    schemaVersion: 1,
    createdAt: Date.now(),
    workspace: ws,
    items,
    excluded,
    missing,
    coverage,
    notes,
  }
  const manifestPath = join(dir, 'manifest.json')
  let manifestSha256 = null
  try {
    const text = JSON.stringify(manifest, null, 2)
    await fsp.writeFile(manifestPath, text, 'utf8')
    manifestSha256 = sha256(Buffer.from(text, 'utf8'))
  } catch (error) {
    return { ok: false, code: 'E_MATERIAL_MANIFEST', error: `材料清单写入失败：${error?.message ?? String(error)}` }
  }

  return {
    ok: true,
    dir,
    files: items.map(item => join(dir, item.copy)),
    manifestPath,
    manifestSha256,
    items,
    excluded,
    missing,
    coverage,
    notes,
  }
}

/**
 * 给派发前用：只判断"这批材料里有没有需要展开的目录或网址"。
 * @param {string[]} entries
 */
export function needsCollection(entries) {
  if (!Array.isArray(entries)) return false
  return entries.some(entry => {
    const text = String(entry ?? '').trim()
    if (/^https?:\/\//i.test(text)) return true
    if (/^dir:/i.test(text)) return true
    return false
  })
}
