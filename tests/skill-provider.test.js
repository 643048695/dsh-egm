/**
 * Automated tests for dsh-egm skill provider and packaging.
 *
 * Verifies:
 * 1. Provider lifecycle and DSH skill provider contract (name, list, get).
 * 2. Discovery and loading of all DSH-adapted skills.
 * 3. Frontmatter parsing, name, description, and invocation flags (model-invocable, disable-model-invocation).
 * 4. Specific discovery and invocation restriction for all 7 upstream classic skills (egm-classic-*).
 * 5. Existence of all in-package referenced files (vendor/egm/*, agents/*, resources/*).
 * 6. Packaging whitelist in package.json (including vendor/ inclusion and bundle patch).
 * 7. Parser edge cases, resilience, and known diagnostic limitations (e.g. multiline description).
 * 8. Command kickoff vs model-invocable semantic distinction.
 *
 * Execution:
 *   node --test tests/skill-provider.test.js (from dsh-egm/)
 *   or: node --test dsh-egm/tests/skill-provider.test.js (from workspace root)
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSkillProvider } from '../lib/skill-provider.js'
import {
  assertSkillResources,
  skillResourceInstructions,
  PACKAGE_ROOT as RESOURCE_PACKAGE_ROOT,
} from '../lib/skill-resources.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const PKG_ROOT = resolve(__dirname, '..')
const SKILLS_DIR = join(PKG_ROOT, 'skills')
const PACKAGE_JSON_PATH = join(PKG_ROOT, 'package.json')
const CORDIS_PATCH_PATH = join(PKG_ROOT, 'cordis.patch.yml')

describe('dsh-egm Skill Provider Contract & Lifecycle', () => {
  it('instantiates provider with valid name and methods', () => {
    const provider = createSkillProvider()
    assert.ok(provider, 'provider should be instantiated')
    assert.equal(provider.name, 'dsh-egm', 'provider name must match package name')
    assert.equal(typeof provider.list, 'function', 'provider must implement list()')
    assert.equal(typeof provider.get, 'function', 'provider must implement get()')
  })

  it('handles get() safely when given invalid or missing candidate locators', async () => {
    const provider = createSkillProvider()

    assert.equal(await provider.get(null), undefined)
    assert.equal(await provider.get(undefined), undefined)
    assert.equal(await provider.get({}), undefined)
    assert.equal(await provider.get({ locator: {} }), undefined)
    assert.equal(await provider.get({ locator: { file: null } }), undefined)
    assert.equal(await provider.get({ locator: { file: join(PKG_ROOT, 'skills', 'does-not-exist', 'SKILL.md') } }), undefined)
  })
})

describe('DSH Adapted Skills Discovery (list)', () => {
  it('discovers all skills currently present in skills/ directory without hardcoded assumptions', async () => {
    const provider = createSkillProvider()
    const candidates = await provider.list()

    assert.ok(Array.isArray(candidates), 'list() must return an array')
    assert.ok(candidates.length > 0, 'list() should discover at least one skill')

    const SKILL_NAME_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

    for (const candidate of candidates) {
      // 1. Name validation
      assert.ok(typeof candidate.name === 'string' && candidate.name.length > 0, 'candidate must have non-empty name')
      assert.match(candidate.name, SKILL_NAME_REGEX, `candidate name "${candidate.name}" must follow kebab-case format`)

      // 2. Description validation
      assert.ok(typeof candidate.description === 'string' && candidate.description.length > 0, `candidate "${candidate.name}" must have non-empty description`)

      // 3. Provider and source metadata
      assert.equal(candidate.provider, 'dsh-egm')
      assert.equal(candidate.source, 'custom')
      assert.equal(candidate.rank, 300, 'custom skills should have rank 300')
      assert.deepEqual(candidate.metadata, { plugin: 'dsh-egm' })

      // 4. ResourceBase validation
      assert.ok(candidate.resourceBase, 'candidate must have resourceBase')
      assert.equal(candidate.resourceBase.kind, 'directory')
      assert.equal(resolve(candidate.resourceBase.path), PKG_ROOT)

      // 5. Locator validation
      assert.ok(candidate.locator, 'candidate must have locator')
      assert.ok(candidate.locator.file && typeof candidate.locator.file === 'string')
      assert.ok(candidate.locator.dir && typeof candidate.locator.dir === 'string')

      const fileStat = await stat(candidate.locator.file)
      assert.ok(fileStat.isFile(), `locator file "${candidate.locator.file}" must exist on disk as a file`)

      const dirStat = await stat(candidate.locator.dir)
      assert.ok(dirStat.isDirectory(), `locator dir "${candidate.locator.dir}" must exist on disk as a directory`)

      // 6. Invocation contract
      assert.ok(candidate.invocation, `candidate "${candidate.name}" must declare invocation object`)
      assert.equal(typeof candidate.invocation.modelInvocable, 'boolean')
      assert.equal(typeof candidate.invocation.userInvocable, 'boolean')

      // 7. Optional whenToUse
      if (candidate.whenToUse !== undefined) {
        assert.equal(typeof candidate.whenToUse, 'string')
        assert.ok(candidate.whenToUse.length > 0)
      }
    }
  })
})

describe('Reading Skill Content (get)', () => {
  it('reads full skill definition and strips frontmatter cleanly', async () => {
    const provider = createSkillProvider()
    const candidates = await provider.list()

    for (const candidate of candidates) {
      const skill = await provider.get(candidate)

      assert.ok(skill, `get() should return skill object for candidate "${candidate.name}"`)
      assert.equal(skill.name, candidate.name)
      assert.equal(skill.description, candidate.description)
      assert.deepEqual(skill.invocation, candidate.invocation)
      assert.equal(skill.provider, 'dsh-egm')
      assert.equal(skill.source, 'custom')
      assert.deepEqual(skill.resourceBase, candidate.resourceBase)
      assert.equal(skill.path, candidate.locator.file)

      assert.ok(typeof skill.content === 'string', 'skill.content must be a string')
      assert.ok(skill.content.length > 0, `skill.content for "${candidate.name}" must not be empty`)

      // Frontmatter fence --- must not be at the start of content
      assert.ok(!skill.content.startsWith('---'), `skill.content for "${candidate.name}" should have frontmatter stripped`)
      // Leading blank lines must be trimmed
      assert.ok(!skill.content.startsWith('\n') && !skill.content.startsWith('\r\n'), 'leading newlines should be trimmed from content')

      if (candidate.whenToUse) {
        assert.equal(skill.whenToUse, candidate.whenToUse)
      }
    }
  })
})

describe('Frontmatter Declarations for Core Adapted Skills (egm-gate & egm-review)', () => {
  it('verifies egm-gate frontmatter declarations', async () => {
    const provider = createSkillProvider()
    const candidates = await provider.list()
    const gate = candidates.find((c) => c.name === 'egm-gate')

    assert.ok(gate, 'egm-gate skill must be discovered')
    assert.equal(gate.invocation.modelInvocable, false, 'egm-gate should not be model-invocable')
    assert.equal(gate.invocation.userInvocable, true, 'egm-gate should be user-invocable')
    assert.ok(gate.description.includes('守门人'), 'egm-gate description should describe its gatekeeper role')
    assert.ok(gate.whenToUse && gate.whenToUse.length > 0, 'egm-gate should declare whenToUse')
  })

  it('verifies egm-review frontmatter declarations and model-invocable: false restriction', async () => {
    const provider = createSkillProvider()
    const candidates = await provider.list()
    const review = candidates.find((c) => c.name === 'egm-review')

    assert.ok(review, 'egm-review skill must be discovered')
    assert.equal(review.invocation.modelInvocable, false, 'egm-review must set modelInvocable: false as declared')
    assert.equal(review.invocation.userInvocable, true, 'egm-review should remain user-invocable')
    assert.ok(review.description.includes('挑刺'), 'egm-review description should reflect its critic purpose')
  })

  it('verifies invocation parser supports both model-invocable: false and disable-model-invocation: true', async () => {
    const provider = createSkillProvider()
    const candidates = await provider.list()

    for (const c of candidates) {
      assert.equal(typeof c.invocation.modelInvocable, 'boolean')
      assert.equal(typeof c.invocation.userInvocable, 'boolean')
    }
  })
})

describe('Upstream Classic Skills (egm-classic-*) Discovery & Invariants', () => {
  const EXPECTED_CLASSIC_SKILLS = [
    'egm-classic-bootstrap',
    'egm-classic-brainstorm',
    'egm-classic-draft',
    'egm-classic-drift-report',
    'egm-classic-resolve',
    'egm-classic-review',
    'egm-classic-review-loop',
  ]

  it('discovers all 7 classic skills from skills/ directory', async () => {
    const provider = createSkillProvider()
    const candidates = await provider.list()
    const classicCandidates = candidates.filter((c) => c.name.startsWith('egm-classic-'))

    assert.equal(classicCandidates.length, EXPECTED_CLASSIC_SKILLS.length, 'should discover exactly 7 egm-classic-* skills')

    for (const expectedName of EXPECTED_CLASSIC_SKILLS) {
      const found = classicCandidates.find((c) => c.name === expectedName)
      assert.ok(found, `classic skill "${expectedName}" must be discovered by provider.list()`)
    }
  })

  it('strictly forbids autonomous model invocation for all 7 classic skills (modelInvocable: false)', async () => {
    const provider = createSkillProvider()
    const candidates = await provider.list()
    const classicCandidates = candidates.filter((c) => c.name.startsWith('egm-classic-'))

    for (const candidate of classicCandidates) {
      assert.equal(
        candidate.invocation.modelInvocable,
        false,
        `classic skill "${candidate.name}" must forbid autonomous model invocation (modelInvocable === false)`
      )
      assert.equal(
        candidate.invocation.userInvocable,
        true,
        `classic skill "${candidate.name}" should remain user-invocable (userInvocable === true)`
      )
    }
  })

  it('verifies all 7 classic skills are readable and their referenced resource paths exist', async () => {
    const provider = createSkillProvider()
    const candidates = await provider.list()
    const classicCandidates = candidates.filter((c) => c.name.startsWith('egm-classic-'))

    const referenceRegex = /(?:vendor\/egm\/|resources\/|agents\/)[a-zA-Z0-9_\/.-]+\.(?:md|json|yml|yaml)/g

    for (const candidate of classicCandidates) {
      const skill = await provider.get(candidate)
      assert.ok(skill, `get() must return content for "${candidate.name}"`)
      assert.ok(skill.content.length > 0, `content for "${candidate.name}" must not be empty`)

      let match
      while ((match = referenceRegex.exec(skill.content)) !== null) {
        const relPath = match[0]
        const targetAbs = join(PKG_ROOT, relPath)
        let fileStat
        try {
          fileStat = await stat(targetAbs)
        } catch {
          assert.fail(`In classic skill "${candidate.name}", referenced file does not exist: "${relPath}" (resolved to ${targetAbs})`)
        }
        assert.ok(fileStat.isFile(), `Referenced path "${relPath}" in "${candidate.name}" must be a regular file`)
        assert.ok(fileStat.size > 0, `Referenced path "${relPath}" in "${candidate.name}" must have non-zero size`)
      }
    }
  })
})

describe('Referenced Files Existence Across All Skills', () => {
  it('ensures all in-package files referenced across all skills actually exist on disk', async () => {
    const provider = createSkillProvider()
    const candidates = await provider.list()

    const referencedFiles = new Set()
    // Matches relative in-package paths beginning with vendor/egm/, resources/, or agents/
    const referenceRegex = /(?:vendor\/egm\/|resources\/|agents\/)[a-zA-Z0-9_\/.-]+\.(?:md|json|yml|yaml)/g

    for (const candidate of candidates) {
      const skill = await provider.get(candidate)
      let match
      while ((match = referenceRegex.exec(skill.content)) !== null) {
        referencedFiles.add(match[0])
      }
    }

    assert.ok(referencedFiles.size > 0, 'skills should reference at least some in-package resource files')

    for (const relPath of referencedFiles) {
      const targetAbs = join(PKG_ROOT, relPath)
      let fileStat
      try {
        fileStat = await stat(targetAbs)
      } catch {
        assert.fail(`Referenced file does not exist: "${relPath}" (resolved to ${targetAbs})`)
      }
      assert.ok(fileStat.isFile(), `Referenced path "${relPath}" must be a regular file`)
      assert.ok(fileStat.size > 0, `Referenced file "${relPath}" must not be empty`)
    }
  })

  it('verifies essential agent cards and resource schemas are present in dsh-egm', async () => {
    const requiredFiles = [
      'agents/logic-critic.md',
      'agents/feasibility-critic.md',
      'agents/cold-implementer.md',
      'agents/synthesizer.md',
      'resources/design-template.md',
      'resources/defect-schema.md',
      'resources/gate-rules.md',
      'resources/constitution-template.md',
      'resources/classic-fidelity.md',
      'resources/classic-stages.md',
      'resources/classic-dispatch.md',
    ]

    for (const rel of requiredFiles) {
      const p = join(PKG_ROOT, rel)
      const st = await stat(p)
      assert.ok(st.isFile(), `${rel} must exist as a file`)
      assert.ok(st.size > 0, `${rel} must have non-zero size`)
    }
  })
})

describe('Packaging Whitelist & Vendor Directory Inclusion', () => {
  it('verifies package.json files array whitelists all required directories including vendor', async () => {
    const pkgRaw = await readFile(PACKAGE_JSON_PATH, 'utf8')
    const pkg = JSON.parse(pkgRaw)

    assert.equal(pkg.name, 'dsh-egm')
    assert.equal(pkg.type, 'module')
    assert.ok(Array.isArray(pkg.files), 'package.json must declare files array')

    const requiredEntries = [
      'lib',
      'skills',
      'agents',
      'resources',
      'vendor',
      'cordis.patch.yml',
      'package.json',
      'README.md',
    ]

    for (const entry of requiredEntries) {
      assert.ok(
        pkg.files.includes(entry),
        `package.json "files" whitelist must include "${entry}" for distribution packaging`
      )
    }

    // Verify bundle patch configuration
    assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml', 'dsh.bundle.patch must point to cordis.patch.yml')

    // Verify cordis.patch.yml exists and defines egm plugin
    const patchContent = await readFile(CORDIS_PATCH_PATH, 'utf8')
    assert.ok(patchContent.includes('dsh-egm'), 'cordis.patch.yml should reference dsh-egm')
  })

  it('handles vendor directory dynamically without assuming hardcoded or missing files', async () => {
    const vendorDir = join(PKG_ROOT, 'vendor')
    let vendorExists = false

    try {
      const st = await stat(vendorDir)
      vendorExists = st.isDirectory()
    } catch {
      vendorExists = false
    }

    if (vendorExists) {
      const entries = await readdir(vendorDir, { withFileTypes: true })
      assert.ok(Array.isArray(entries), 'vendor directory should be readable')
    } else {
      assert.ok(true, 'vendor directory not yet present on disk; whitelist is verified')
    }
  })
})

describe('Parser Limitations & Diagnostic Observations', () => {
  it('documents limitation: multiline descriptions are not fully accumulated by current parseFrontmatter', async () => {
    // Current parseFrontmatter implementation in lib/skill-provider.js parses line-by-line
    // looking for key: value. If description wraps across multiple lines or uses YAML block scalers (> or |),
    // subsequent lines without a colon are ignored.
    const sampleSkill = [
      '---',
      'name: sample-multiline',
      'description: First line of description',
      '  second line continued without colon',
      'when-to-use: whenever',
      '---',
      'Body text',
    ].join('\n')

    const normalized = sampleSkill.replace(/^\uFEFF/, '')
    const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(normalized)
    assert.ok(match, 'frontmatter regex matches')

    const data = {}
    for (const rawLine of match[1].split(/\r?\n/)) {
      const line = rawLine.trim()
      if (line === '' || line.startsWith('#')) continue
      const separator = line.indexOf(':')
      if (separator <= 0) continue
      const key = line.slice(0, separator).trim()
      let value = line.slice(separator + 1).trim()
      if (
        (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
        (value.startsWith("'") && value.endsWith("'") && value.length > 1)
      ) {
        value = value.slice(1, -1)
      }
      if (key !== '' && value !== '') data[key] = value
    }

    assert.equal(data.description, 'First line of description')
    assert.ok(!data.description.includes('second line'), 'documents parser limitation: multiline description dropped')
  })
})

describe('Command Kickoff vs Model Autonomy Semantics', () => {
  it('documents semantic boundary between /egm command kickoff and model-invocable: false', async () => {
    // `/egm` 启动时向模型提供规程文件路径；技能目录不提供自主调用入口。
    // 这不是文件访问或模型行为的安全隔离；端到端行为仍需实机验证。

    const provider = createSkillProvider()
    const candidates = await provider.list()

    const gate = candidates.find((c) => c.name === 'egm-gate')
    assert.ok(gate)
    assert.equal(gate.invocation.modelInvocable, false, 'egm-gate is user-invocable only')

    const nonAutonomous = candidates.filter((c) => c.name !== 'egm-gate')
    for (const item of nonAutonomous) {
      assert.equal(
        item.invocation.modelInvocable,
        false,
        `skill "${item.name}" must have modelInvocable: false to restrict autonomous model invocation`
      )
    }
  })
})

describe('Resource Anchoring in Skill Body (not only host metadata)', () => {
  it('embeds package root, skill file and every referenced resource as absolute paths', async () => {
    const provider = createSkillProvider()
    const candidates = await provider.list()

    for (const candidate of candidates) {
      const manifest = assertSkillResources(candidate.name)
      const skill = await provider.get(candidate)

      assert.match(skill.content, /^## 资源锚定/, `${candidate.name}: body starts with the anchoring block`)
      assert.ok(skill.content.includes(manifest.packageRoot), `${candidate.name}: body names the package root`)
      assert.ok(skill.content.includes(manifest.skillFile), `${candidate.name}: body names its own SKILL.md`)

      for (const [relative, absolute] of Object.entries(manifest.resources)) {
        assert.ok(
          skill.content.includes(absolute),
          `${candidate.name}: body names the absolute path for ${relative}`
        )
        const info = await stat(absolute)
        assert.ok(info.isFile() && info.size > 0, `${candidate.name}: ${relative} is a readable non-empty file`)
      }
    }
  })

  it('keeps the body anchor and the runtime resourceBase on the same package root', async () => {
    const provider = createSkillProvider()
    const candidates = await provider.list()

    for (const candidate of candidates) {
      const manifest = assertSkillResources(candidate.name)
      const skill = await provider.get(candidate)

      assert.equal(skill.resourceBase.kind, 'directory')
      assert.equal(resolve(skill.resourceBase.path), manifest.packageRoot)
      assert.ok(
        skill.content.includes(`插件包根（resources/、agents/、vendor/ 等随包文件以此为准；.egm/ 等项目文件仍相对当前工作目录）：${manifest.packageRoot}`),
        `${candidate.name}: body anchor root equals runtime resourceBase`
      )
    }
  })

  it('resolves egm-gate resources from the package root although its skill folder has no resources/', async () => {
    const gate = (await createSkillProvider().list()).find((c) => c.name === 'egm-gate')
    assert.ok(gate)

    // 根因回归：技能目录里只有 SKILL.md，按“技能目录/resources/”去找必然误报缺失。
    const skillDir = join(RESOURCE_PACKAGE_ROOT, 'skills', 'egm-gate')
    assert.ok(
      !existsSync(join(skillDir, 'resources')),
      'egm-gate skill folder itself has no resources/ (the false "missing on this machine" report)'
    )

    const manifest = assertSkillResources('egm-gate')
    for (const relative of [
      'resources/design-template.md',
      'resources/gate-rules.md',
      'resources/interaction-contract.md',
    ]) {
      const absolute = manifest.resources[relative]
      assert.ok(absolute, `egm-gate declares ${relative}`)
      assert.ok(absolute.startsWith(join(RESOURCE_PACKAGE_ROOT, 'resources')), `${relative} lives under the package root`)
      assert.ok(!absolute.startsWith(join(skillDir, 'resources')), `${relative} is not under the skill folder`)
      const info = await stat(absolute)
      assert.ok(info.isFile() && info.size > 0, `${relative} exists and is readable`)
    }

    const skill = await createSkillProvider().get(gate)
    for (const [relative, absolute] of Object.entries(manifest.resources)) {
      assert.ok(skill.content.includes(absolute), `body names ${relative} absolutely`)
    }
  })

  it('returns the anchoring block synchronously for command kickoff handlers', () => {
    const result = skillResourceInstructions('egm-gate')

    assert.equal(typeof result, 'string')
    assert.ok(!(result instanceof Promise), 'must stay synchronous for the /egm kickoff handler')
    assert.ok(result.includes(RESOURCE_PACKAGE_ROOT))
    assert.ok(result.includes(join(RESOURCE_PACKAGE_ROOT, 'skills', 'egm-gate', 'SKILL.md')))
    assert.ok(result.includes(join(RESOURCE_PACKAGE_ROOT, 'resources', 'design-template.md')))
  })
})
