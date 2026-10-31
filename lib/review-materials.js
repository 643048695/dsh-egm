// 评审材料控制模块：图纸范围裁剪、受控副本准备、行号映射与安全路径校验。
//
// 核心原则：
// 1. 材料控制（Context Control）≠ 权限隔离（Permission Isolation）：
//    本模块仅裁剪房间内投喂给子代理的上下文材料，不提供操作系统级或宿主沙箱级隔离；
//    所有返回和元数据均如实标注 accessIsolated: false。
// 2. 真实普通文件校验（realpath）：
//    严禁越出工作区、拒绝符号链接/junction逃逸，杜绝任意原路径盲目喂入。
// 3. 拒绝目录扫描：
//    sources 必须逐个指定具体文件，显式拒绝目录并提示用户。
// 4. 受控房间副本：
//    design.md（带 range 时仅含指定行并带行号前缀）、sources 与 materials 均生成房内副本，
//    避免提示子代理自由读取宿主绝对路径。

import { createHash } from 'node:crypto'
import { isAbsolute, join, relative, resolve } from 'node:path'

export const MAX_DOC_BYTES = 5 * 1024 * 1024 // 5MB
export const MAX_SOURCES = 50
export const MAX_MATERIALS = 10
export const MAX_MATERIAL_BYTES = 2 * 1024 * 1024 // 2MB
export const HASH_LIMIT_BYTES = 2 * 1024 * 1024 // 2MB

/**
 * 统计文本行数：空文件为 0 行，末尾单个换行不算增加一行。
 * 兼容 CRLF 与 LF。
 */
export function countLines(text) {
  if (text === '') return 0
  const lines = text.split(/\r?\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.length
}

/**
 * 将文本切分为行数组，末尾单个换行不产生多余的空行。
 * 兼容 CRLF 与 LF。
 */
export function splitLines(text) {
  if (text === '') return []
  const lines = text.split(/\r?\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * 提取 1-based 的行区间 [start, end]。
 */
export function sliceLines(lines, start, end) {
  if (!Array.isArray(lines)) return []
  return lines.slice(start - 1, end)
}

/**
 * 格式化裁剪后的 design.md：
 * 头部增加机器与人类可读的范围/行号映射说明，
 * 每行前缀带 "L<原行号> | "，使评审意见能精准对齐原文行号。
 */
export function formatSlicedDesignDoc(selectedLines, { start, end, total }) {
  const header = [
    `# 评审图纸片段（第 ${start}–${end} 行 / 共 ${total} 行）`,
    `> 提示：本文件仅包含原图纸第 ${start}–${end} 行内容，每行前缀带「L<原行号> | 」标明原文件真实行号；评审意见请直接使用对应原行号。`,
    '> 声明：此材料裁剪仅用于受控评审上下文控制，非权限隔离（accessIsolated: false）。',
    '',
  ].join('\n')

  const formattedLines = selectedLines.map((line, idx) => `L${start + idx} | ${line}`)
  return `${header}${formattedLines.join('\n')}\n`
}

/**
 * 获取工作区的真实路径。
 */
export async function getRealWorkspaceBase(baseCwd, io) {
  try {
    return await io.realpath(baseCwd)
  } catch {
    return resolve(baseCwd)
  }
}

/**
 * 安全解析并校验位于工作区内的单个文件真实路径。
 */
export async function resolveSafeWorkspaceFile(rawPath, { baseCwd, baseReal, io, kind, maxBytes = null }) {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    return { ok: false, code: `E_${kind}_INVALID`, error: `${kind.toLowerCase()} 路径必须是非空字符串` }
  }

  const abs = resolve(baseCwd, rawPath.trim())
  let real
  try {
    real = await io.realpath(abs)
  } catch {
    return { ok: false, code: `E_${kind}_MISSING`, error: `路径不存在：${rawPath}` }
  }

  const rel = relative(baseReal, real)
  if (rel === '') {
    return { ok: false, code: `E_${kind}_OUTSIDE`, error: `${kind.toLowerCase()} 不能把整个工作区当成范围：${rawPath}` }
  }
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, code: `E_${kind}_OUTSIDE`, error: `路径越出工作区：${rawPath}` }
  }

  let info
  try {
    info = await io.stat(real)
  } catch {
    return { ok: false, code: `E_${kind}_MISSING`, error: `读不到路径：${rawPath}` }
  }

  if (info.isDirectory()) {
    if (kind === 'DOC') {
      return { ok: false, code: 'E_DOC_MISSING', error: `不是文件：${rawPath}` }
    }
    return {
      ok: false,
      code: `E_${kind}_INVALID`,
      error: kind === 'SOURCE'
        ? `sources 不支持目录扫描，请指定具体文件：${rawPath}`
        : `${kind.toLowerCase()} 必须是文件：${rawPath}`,
    }
  }

  if (!info.isFile()) {
    return {
      ok: false,
      code: kind === 'DOC' ? 'E_DOC_MISSING' : `E_${kind}_INVALID`,
      error: `不是文件：${rawPath}`,
    }
  }

  if (maxBytes !== null && info.size > maxBytes) {
    return {
      ok: false,
      code: `E_${kind}_INVALID`,
      error: `${kind.toLowerCase()} 超过最大大小限制（${maxBytes} 字节）：${rawPath}`,
      size: info.size,
    }
  }

  let sha256
  if (info.size <= HASH_LIMIT_BYTES) {
    try {
      sha256 = createHash('sha256').update(await io.readFile(real)).digest('hex')
    } catch {
      sha256 = '(读取失败，未计算)'
    }
  } else {
    sha256 = '(超过 2MB，未计算)'
  }

  return {
    ok: true,
    realPath: real,
    relative: rel.split('\\').join('/'),
    size: info.size,
    sha256,
  }
}

/**
 * 校验图纸文件与范围合法性（前置验证阶段，不写入房间）。
 */
export async function validateDesignDoc({ docPath, range, baseCwd, io }) {
  if (docPath === undefined || docPath === null || String(docPath).trim() === '') {
    return { ok: false, code: 'E_DOC_EMPTY', error: 'docPath 不能为空：金鱼只看文件，不收口头描述' }
  }

  const baseReal = await getRealWorkspaceBase(baseCwd, io)
  const safeDoc = await resolveSafeWorkspaceFile(docPath, {
    baseCwd,
    baseReal,
    io,
    kind: 'DOC',
  })

  if (!safeDoc.ok) {
    return safeDoc
  }

  // 大小限制：5MB
  if (safeDoc.size > MAX_DOC_BYTES) {
    if (range) {
      return { ok: false, code: 'E_RANGE_INVALID', error: `文件超过 5MB，无法可靠核对行号：${docPath}` }
    }
    return { ok: false, code: 'E_DOC_INVALID', error: `文件超过 5MB，无法作为评审图纸：${docPath}` }
  }

  // 无 range
  if (range === undefined || range === null) {
    return {
      ok: true,
      realPath: safeDoc.realPath,
      relative: safeDoc.relative,
      size: safeDoc.size,
      range: null,
      rangeMapping: null,
      lines: null,
      accessIsolated: false,
    }
  }

  // 有 range：校验区间合法性
  if (typeof range !== 'object' || Array.isArray(range)) {
    return { ok: false, code: 'E_RANGE_INVALID', error: 'range 必须是 { start, end }（1 起的整数行号）' }
  }
  const { start, end } = range
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    return { ok: false, code: 'E_RANGE_INVALID', error: `range.start / range.end 必须是整数；收到 ${String(start)} / ${String(end)}` }
  }
  if (start < 1 || end < start) {
    return { ok: false, code: 'E_RANGE_INVALID', error: `非法区间：start=${start}, end=${end}（要求 1 ≤ start ≤ end）` }
  }

  let text
  try {
    text = await io.readFile(safeDoc.realPath, 'utf8')
  } catch (error) {
    return { ok: false, code: 'E_DOC_MISSING', error: `读不到文档内容：${docPath}（${error?.message ?? String(error)}）` }
  }

  const lines = splitLines(String(text))
  const total = lines.length
  if (end > total) {
    return { ok: false, code: 'E_RANGE_INVALID', error: `区间越界：${docPath} 共 ${total} 行，收到 ${start}–${end}` }
  }

  const rangeMeta = {
    start,
    end,
    total,
    lineCount: end - start + 1,
    accessIsolated: false,
  }

  const rangeMapping = {
    start,
    end,
    total,
    lineCount: end - start + 1,
    accessIsolated: false,
    format: 'line-prefixed',
    prefixPattern: '^L(\\d+) \\| ',
  }

  return {
    ok: true,
    realPath: safeDoc.realPath,
    relative: safeDoc.relative,
    size: safeDoc.size,
    range: rangeMeta,
    rangeMapping,
    lines,
    accessIsolated: false,
  }
}

/**
 * 将校验通过的图纸材料写入房间内（后置准备阶段）。
 */
export async function prepareDesignDoc({ verifiedDoc, scratch, io }) {
  const docCopy = join(scratch, 'design.md')
  if (!verifiedDoc.range) {
    try {
      await io.copyFile(verifiedDoc.realPath, docCopy)
    } catch (error) {
      return { ok: false, code: 'E_ROOM_PREPARE', error: `图纸复制失败：${error?.message ?? String(error)}` }
    }
    return { ok: true, docCopy }
  }

  const selected = sliceLines(verifiedDoc.lines, verifiedDoc.range.start, verifiedDoc.range.end)
  const slicedText = formatSlicedDesignDoc(selected, verifiedDoc.range)
  try {
    await io.writeFile(docCopy, slicedText, 'utf8')
  } catch (error) {
    return { ok: false, code: 'E_ROOM_PREPARE', error: `裁剪图纸写入失败：${error?.message ?? String(error)}` }
  }
  return { ok: true, docCopy }
}

/**
 * 校验图纸并准备房间内 design.md 的一站式接口（便捷方法）。
 */
export async function validateAndPrepareDesignDoc({ docPath, range, scratch, baseCwd, io }) {
  const verified = await validateDesignDoc({ docPath, range, baseCwd, io })
  if (!verified.ok) return verified

  const prepared = await prepareDesignDoc({ verifiedDoc: verified, scratch, io })
  if (!prepared.ok) return prepared

  return {
    ok: true,
    docCopy: prepared.docCopy,
    realPath: verified.realPath,
    relative: verified.relative,
    range: verified.range,
    rangeMapping: verified.rangeMapping,
    accessIsolated: false,
  }
}

/**
 * 校验 sources 路径列表（前置验证阶段）。
 */
export async function validateSources({ rawSources, baseCwd, io, limit = MAX_SOURCES }) {
  if (rawSources === undefined || rawSources === null) {
    return { ok: true, entries: [] }
  }
  if (!Array.isArray(rawSources)) {
    return { ok: false, code: 'E_SOURCE_INVALID', error: 'sources 必须是路径字符串数组' }
  }
  if (rawSources.length > limit) {
    return { ok: false, code: 'E_SOURCE_INVALID', error: `sources 最多 ${limit} 条` }
  }

  const baseReal = await getRealWorkspaceBase(baseCwd, io)
  const verifiedList = []

  for (const raw of rawSources) {
    const verified = await resolveSafeWorkspaceFile(raw, {
      baseCwd,
      baseReal,
      io,
      kind: 'SOURCE',
    })
    if (!verified.ok) return verified
    verifiedList.push(verified)
  }

  return { ok: true, entries: verifiedList }
}

/**
 * 将校验通过的 sources 拷贝进房间受控副本并写入清单（后置准备阶段）。
 */
export async function prepareSources({ verifiedSources, scratch, io }) {
  if (!verifiedSources || verifiedSources.length === 0) {
    return { ok: true, entries: [], manifestPath: null }
  }

  const sourcesDir = join(scratch, 'sources')
  try {
    await io.mkdir(sourcesDir, { recursive: true })
  } catch (error) {
    return { ok: false, code: 'E_ROOM_PREPARE', error: `创建 sources 目录失败：${error?.message ?? String(error)}` }
  }

  const entries = []
  for (let index = 0; index < verifiedSources.length; index += 1) {
    const item = verifiedSources[index]
    const baseName = item.relative.split('/').pop() || 'source.txt'
    const copyPath = join(sourcesDir, `${String(index + 1).padStart(2, '0')}-${baseName}`)

    try {
      await io.copyFile(item.realPath, copyPath)
    } catch (error) {
      return { ok: false, code: 'E_ROOM_PREPARE', error: `复制源码文件失败：${error?.message ?? String(error)}（${item.relative}）` }
    }

    entries.push({
      path: item.realPath,
      origin: item.realPath,
      relative: item.relative,
      copyPath,
      kind: 'file',
      bytes: item.size,
      sha256: item.sha256,
      accessIsolated: false,
    })
  }

  const manifestPath = join(scratch, 'sources.json')
  try {
    await io.writeFile(
      manifestPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          accessIsolated: false,
          statement: '受控副本仅为材料准备，非权限沙箱隔离；提示子代理仅读取本房间副本',
          sources: entries,
        },
        null,
        2,
      ),
      'utf8',
    )
  } catch (error) {
    return { ok: false, code: 'E_ROOM_PREPARE', error: `写入源码清单失败：${error?.message ?? String(error)}` }
  }

  return { ok: true, entries, manifestPath }
}

/**
 * 校验并准备引用的源码文件受控副本与清单的一站式接口（便捷方法）。
 */
export async function validateAndPrepareSources({ rawSources, scratch, baseCwd, io, limit = MAX_SOURCES }) {
  const verified = await validateSources({ rawSources, baseCwd, io, limit })
  if (!verified.ok) return verified

  const prepared = await prepareSources({ verifiedSources: verified.entries, scratch, io })
  if (!prepared.ok) return prepared

  return { ok: true, entries: prepared.entries, manifestPath: prepared.manifestPath }
}

/**
 * 校验 materials 路径列表（前置验证阶段）。
 */
export async function validateMaterials({ rawMaterials, baseCwd, io, limit = MAX_MATERIALS }) {
  if (rawMaterials === undefined || rawMaterials === null) {
    return { ok: true, entries: [] }
  }
  if (!Array.isArray(rawMaterials)) {
    return { ok: false, code: 'E_MATERIAL_INVALID', error: 'materials 必须是路径字符串数组' }
  }
  if (rawMaterials.length > limit) {
    return { ok: false, code: 'E_MATERIAL_INVALID', error: `materials 最多 ${limit} 条` }
  }

  const baseReal = await getRealWorkspaceBase(baseCwd, io)
  const verifiedList = []

  for (const raw of rawMaterials) {
    const verified = await resolveSafeWorkspaceFile(raw, {
      baseCwd,
      baseReal,
      io,
      kind: 'MATERIAL',
      maxBytes: MAX_MATERIAL_BYTES,
    })
    if (!verified.ok) return verified
    verifiedList.push(verified)
  }

  return { ok: true, entries: verifiedList }
}

/**
 * 将校验通过的 materials 拷贝进房间受控副本（后置准备阶段）。
 */
export async function prepareMaterials({ verifiedMaterials, scratch, io }) {
  if (!verifiedMaterials || verifiedMaterials.length === 0) {
    return { ok: true, entries: [] }
  }

  const materialsDir = join(scratch, 'materials')
  try {
    await io.mkdir(materialsDir, { recursive: true })
  } catch (error) {
    return { ok: false, code: 'E_ROOM_PREPARE', error: `创建 materials 目录失败：${error?.message ?? String(error)}` }
  }

  const entries = []
  for (let index = 0; index < verifiedMaterials.length; index += 1) {
    const item = verifiedMaterials[index]
    const baseName = item.relative.split('/').pop() || 'material.md'
    const copyPath = join(materialsDir, `${String(index + 1).padStart(2, '0')}-${baseName}`)

    try {
      await io.copyFile(item.realPath, copyPath)
    } catch (error) {
      return { ok: false, code: 'E_ROOM_PREPARE', error: `复制阶段材料失败：${error?.message ?? String(error)}（${item.relative}）` }
    }

    entries.push({
      path: item.realPath,
      origin: item.realPath,
      relative: item.relative,
      copyPath,
      kind: 'file',
      bytes: item.size,
      sha256: item.sha256,
      accessIsolated: false,
    })
  }

  return { ok: true, entries }
}

/**
 * 校验并准备阶段材料受控副本的一站式接口（便捷方法）。
 */
export async function validateAndPrepareMaterials({ rawMaterials, scratch, baseCwd, io, limit = MAX_MATERIALS }) {
  const verified = await validateMaterials({ rawMaterials, baseCwd, io, limit })
  if (!verified.ok) return verified

  const prepared = await prepareMaterials({ verifiedMaterials: verified.entries, scratch, io })
  if (!prepared.ok) return prepared

  return { ok: true, entries: prepared.entries }
}
