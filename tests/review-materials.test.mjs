import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import * as nodeFs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  countLines,
  formatSlicedDesignDoc,
  sliceLines,
  splitLines,
  validateAndPrepareDesignDoc,
  validateAndPrepareMaterials,
  validateAndPrepareSources,
} from '../lib/review-materials.js'

const io = (overrides = {}) => ({
  copyFile: nodeFs.copyFile,
  mkdir: nodeFs.mkdir,
  mkdtemp: nodeFs.mkdtemp,
  readFile: nodeFs.readFile,
  realpath: nodeFs.realpath,
  stat: nodeFs.stat,
  writeFile: nodeFs.writeFile,
  ...overrides,
})

async function makeTestEnv(t) {
  const work = await mkdtemp(join(tmpdir(), 'egm-mat-test-'))
  t.after(() => rm(work, { recursive: true, force: true }))
  const scratch = join(work, 'scratch')
  await mkdir(scratch, { recursive: true })
  return { work, scratch }
}

test('行数与行切分：CRLF、LF、末尾换行与空内容兼容', () => {
  assert.equal(countLines(''), 0)
  assert.deepEqual(splitLines(''), [])

  assert.equal(countLines('one line'), 1)
  assert.deepEqual(splitLines('one line'), ['one line'])

  assert.equal(countLines('one line\n'), 1)
  assert.deepEqual(splitLines('one line\n'), ['one line'])

  assert.equal(countLines('one line\r\n'), 1)
  assert.deepEqual(splitLines('one line\r\n'), ['one line'])

  assert.equal(countLines('line1\nline2\n'), 2)
  assert.deepEqual(splitLines('line1\nline2\n'), ['line1', 'line2'])

  assert.equal(countLines('line1\r\nline2\r\n'), 2)
  assert.deepEqual(splitLines('line1\r\nline2\r\n'), ['line1', 'line2'])

  assert.equal(countLines('line1\r\nline2'), 2)
  assert.deepEqual(splitLines('line1\r\nline2'), ['line1', 'line2'])

  // 结尾多个换行：只有最后一个末尾空行被 pop
  assert.equal(countLines('line1\n\n'), 2)
  assert.deepEqual(splitLines('line1\n\n'), ['line1', ''])

  assert.equal(countLines('line1\r\n\r\n'), 2)
  assert.deepEqual(splitLines('line1\r\n\r\n'), ['line1', ''])
})

test('行提取与格式化：片段外独有文本不进入副本，且每行标注原文行号', () => {
  const lines = ['SECRET_PRE_1', 'TARGET_ROW_2', 'TARGET_ROW_3', 'SECRET_POST_4']
  const selected = sliceLines(lines, 2, 3)
  assert.deepEqual(selected, ['TARGET_ROW_2', 'TARGET_ROW_3'])

  const formatted = formatSlicedDesignDoc(selected, { start: 2, end: 3, total: 4 })
  assert.ok(formatted.includes('L2 | TARGET_ROW_2'))
  assert.ok(formatted.includes('L3 | TARGET_ROW_3'))
  assert.ok(!formatted.includes('SECRET_PRE_1'), '片段前独有文本不得进入')
  assert.ok(!formatted.includes('SECRET_POST_4'), '片段后独有文本不得进入')
  assert.ok(formatted.includes('accessIsolated: false'), '必须如实保留非隔离声明')
})

test('validateAndPrepareDesignDoc：传 range 时真裁剪，首尾边界与映射元数据', async (t) => {
  const { work, scratch } = await makeTestEnv(t)
  const docFile = join(work, 'spec.md')
  const content = [
    '# Line 1 Title',
    'Line 2 Description',
    'Line 3 Feature A',
    'Line 4 Feature B',
    'Line 5 Secret Outside',
  ].join('\n') + '\n'
  await writeFile(docFile, content, 'utf8')

  // 测试中间区间 2-4
  const resMid = await validateAndPrepareDesignDoc({
    docPath: 'spec.md',
    range: { start: 2, end: 4 },
    scratch,
    baseCwd: work,
    io: io(),
  })
  assert.equal(resMid.ok, true)
  assert.equal(resMid.accessIsolated, false)
  assert.deepEqual(resMid.range, {
    start: 2,
    end: 4,
    total: 5,
    lineCount: 3,
    accessIsolated: false,
  })
  assert.equal(resMid.rangeMapping.format, 'line-prefixed')

  const copyContent = await readFile(resMid.docCopy, 'utf8')
  assert.ok(copyContent.includes('L2 | Line 2 Description'))
  assert.ok(copyContent.includes('L3 | Line 3 Feature A'))
  assert.ok(copyContent.includes('L4 | Line 4 Feature B'))
  assert.ok(!copyContent.includes('# Line 1 Title'), '第 1 行不应在 2-4 区间内')
  assert.ok(!copyContent.includes('Line 5 Secret Outside'), '第 5 行不应在 2-4 区间内')

  // 测试首行边界 start: 1, end: 1
  const scratch1 = join(work, 'scratch1')
  await mkdir(scratch1, { recursive: true })
  const resFirst = await validateAndPrepareDesignDoc({
    docPath: 'spec.md',
    range: { start: 1, end: 1 },
    scratch: scratch1,
    baseCwd: work,
    io: io(),
  })
  assert.equal(resFirst.ok, true)
  const firstContent = await readFile(resFirst.docCopy, 'utf8')
  assert.ok(firstContent.includes('L1 | # Line 1 Title'))
  assert.ok(!firstContent.includes('Line 2 Description'))

  // 测试尾行边界 start: 5, end: 5
  const scratchEnd = join(work, 'scratchEnd')
  await mkdir(scratchEnd, { recursive: true })
  const resEnd = await validateAndPrepareDesignDoc({
    docPath: 'spec.md',
    range: { start: 5, end: 5 },
    scratch: scratchEnd,
    baseCwd: work,
    io: io(),
  })
  assert.equal(resEnd.ok, true)
  const endContent = await readFile(resEnd.docCopy, 'utf8')
  assert.ok(endContent.includes('L5 | Line 5 Secret Outside'))
  assert.ok(!endContent.includes('Line 4 Feature B'))
})

test('validateAndPrepareDesignDoc：无 range 时保持全文字节及语义完全一致', async (t) => {
  const { work, scratch } = await makeTestEnv(t)
  const docFile = join(work, 'full.md')
  const content = 'Exact bytes\r\nLine 2\r\n\r\nSpecial UTF8: 象鱼评审\n'
  await writeFile(docFile, content, 'utf8')

  const res = await validateAndPrepareDesignDoc({
    docPath: 'full.md',
    range: null,
    scratch,
    baseCwd: work,
    io: io(),
  })
  assert.equal(res.ok, true)
  assert.equal(res.range, null)
  assert.equal(res.rangeMapping, null)
  assert.equal(res.accessIsolated, false)

  const copyBytes = await readFile(res.docCopy)
  const originBytes = await readFile(docFile)
  assert.deepEqual(copyBytes, originBytes, '无 range 时字节流完全一致')
})

test('validateAndPrepareDesignDoc：非法 range 与文件大小超限 fail-closed', async (t) => {
  const { work, scratch } = await makeTestEnv(t)
  const docFile = join(work, 'small.md')
  await writeFile(docFile, 'a\nb\nc\n', 'utf8')

  // 非法 range 组合
  const badRanges = [
    { start: 0, end: 2 },
    { start: 3, end: 2 },
    { start: 1, end: 99 },
    { start: 1.5, end: 2 },
    { start: '1', end: 2 },
    '1-2',
    [1, 2],
  ]
  for (const r of badRanges) {
    const res = await validateAndPrepareDesignDoc({
      docPath: 'small.md',
      range: r,
      scratch,
      baseCwd: work,
      io: io(),
    })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'E_RANGE_INVALID')
  }

  // 文件大小超 5MB
  const bigDoc = join(work, 'big.md')
  const bigBuffer = Buffer.alloc(5 * 1024 * 1024 + 10)
  await writeFile(bigDoc, bigBuffer)

  const resBigRange = await validateAndPrepareDesignDoc({
    docPath: 'big.md',
    range: { start: 1, end: 1 },
    scratch,
    baseCwd: work,
    io: io(),
  })
  assert.equal(resBigRange.ok, false)
  assert.equal(resBigRange.code, 'E_RANGE_INVALID')

  const resBigNoRange = await validateAndPrepareDesignDoc({
    docPath: 'big.md',
    range: null,
    scratch,
    baseCwd: work,
    io: io(),
  })
  assert.equal(resBigNoRange.ok, false)
  assert.equal(resBigNoRange.code, 'E_DOC_INVALID')
})

test('validateAndPrepareDesignDoc：输入图纸安全验证（realpath、拒越界、拒目录、链接逃逸）', async (t) => {
  const { work, scratch } = await makeTestEnv(t)

  // 1. 空 docPath
  const resEmpty = await validateAndPrepareDesignDoc({ docPath: '   ', scratch, baseCwd: work, io: io() })
  assert.equal(resEmpty.code, 'E_DOC_EMPTY')

  // 2. 不存在
  const resMissing = await validateAndPrepareDesignDoc({ docPath: 'not-found.md', scratch, baseCwd: work, io: io() })
  assert.equal(resMissing.code, 'E_DOC_MISSING')

  // 3. 目录被拒
  const dirPath = join(work, 'subfolder')
  await mkdir(dirPath)
  const resDir = await validateAndPrepareDesignDoc({ docPath: 'subfolder', scratch, baseCwd: work, io: io() })
  assert.equal(resDir.code, 'E_DOC_MISSING')

  // 4. Path traversal 越出工作区
  const outsideDir = await mkdtemp(join(tmpdir(), 'outside-'))
  t.after(() => rm(outsideDir, { recursive: true, force: true }))
  await writeFile(join(outsideDir, 'secret.md'), 'secret', 'utf8')

  const resOutside = await validateAndPrepareDesignDoc({
    docPath: join(outsideDir, 'secret.md'),
    scratch,
    baseCwd: work,
    io: io(),
  })
  assert.equal(resOutside.code, 'E_DOC_OUTSIDE')

  // 5. 符号链接指向工作区外（逃逸拦截）
  const linkEscape = join(work, 'link-outside.md')
  let symlinkSupported = true
  try {
    await symlink(join(outsideDir, 'secret.md'), linkEscape)
  } catch {
    symlinkSupported = false
  }

  if (symlinkSupported) {
    const resSymlink = await validateAndPrepareDesignDoc({
      docPath: 'link-outside.md',
      scratch,
      baseCwd: work,
      io: io(),
    })
    assert.equal(resSymlink.code, 'E_DOC_OUTSIDE', '指向外部的符号链接必须被 realpath 拦截')
  }
})

test('validateAndPrepareSources：显式拒绝目录，准备受控副本与清单，不承诺隔离', async (t) => {
  const { work, scratch } = await makeTestEnv(t)
  await mkdir(join(work, 'src'), { recursive: true })
  await writeFile(join(work, 'src', 'main.js'), 'console.log("hello")\n', 'utf8')
  await writeFile(join(work, 'src', 'utils.js'), 'export const u = 1\n', 'utf8')

  // 1. 传目录必须显式拒绝并提示指定具体文件
  const resDir = await validateAndPrepareSources({
    rawSources: ['src'],
    scratch,
    baseCwd: work,
    io: io(),
  })
  assert.equal(resDir.ok, false)
  assert.equal(resDir.code, 'E_SOURCE_INVALID')
  assert.match(resDir.error, /不支持目录扫描，请指定具体文件/)

  // 2. 越界拒绝
  const resOutside = await validateAndPrepareSources({
    rawSources: ['../../etc/passwd'],
    scratch,
    baseCwd: work,
    io: io(),
  })
  assert.equal(resOutside.ok, false)

  // 3. 合法文件拷贝受控副本并写 manifest
  const resOk = await validateAndPrepareSources({
    rawSources: ['src/main.js', 'src/utils.js'],
    scratch,
    baseCwd: work,
    io: io(),
  })
  assert.equal(resOk.ok, true)
  assert.equal(resOk.entries.length, 2)
  assert.equal(resOk.entries[0].accessIsolated, false)
  assert.ok(resOk.entries[0].copyPath.includes('scratch'))

  // 确认房间内受控副本真实存在
  const copy1 = await readFile(resOk.entries[0].copyPath, 'utf8')
  assert.equal(copy1, 'console.log("hello")\n')

  // 确认 sources.json
  const manifest = JSON.parse(await readFile(resOk.manifestPath, 'utf8'))
  assert.equal(manifest.accessIsolated, false)
  assert.equal(manifest.sources.length, 2)
  assert.equal(manifest.sources[0].relative, 'src/main.js')
  assert.equal(manifest.sources[0].sha256, createHash('sha256').update('console.log("hello")\n').digest('hex'))
})

test('validateAndPrepareMaterials：受控副本准备与大小限制', async (t) => {
  const { work, scratch } = await makeTestEnv(t)
  await writeFile(join(work, 'stage.md'), 'stage material content\n', 'utf8')

  const resOk = await validateAndPrepareMaterials({
    rawMaterials: ['stage.md'],
    scratch,
    baseCwd: work,
    io: io(),
  })
  assert.equal(resOk.ok, true)
  assert.equal(resOk.entries.length, 1)
  assert.equal(resOk.entries[0].accessIsolated, false)
  const matContent = await readFile(resOk.entries[0].copyPath, 'utf8')
  assert.equal(matContent, 'stage material content\n')

  // 超限 2MB 拒绝
  const bigMat = join(work, 'big-mat.md')
  await writeFile(bigMat, Buffer.alloc(2 * 1024 * 1024 + 1))
  const resBig = await validateAndPrepareMaterials({
    rawMaterials: ['big-mat.md'],
    scratch,
    baseCwd: work,
    io: io(),
  })
  assert.equal(resBig.ok, false)
  assert.equal(resBig.code, 'E_MATERIAL_INVALID')
})
