// 金鱼 preset 的定义与注册。
//
// 这里只做「尽量减少」：preset 只挂读取与搜索工具（write/edit=false），
// goldfish-row 在装配时把全局工具清场（allow=[]）。零上下文由 spawn 后端保证。
//
// preset 本身不是安全隔离。宿主最外层注入的工具可能不在注册表内；
// goldfish-policy.js 另在首个提示词之前为本插件的子会话设置原生 read-only，
// 失败即中止创建。该策略只覆盖遵守 sandboxPolicy 的文件操作，不约束所有
// MCP、网络或外部副作用。dispatch 仍默认拒绝，不能据此宣称完整隔离。
//
// preset id 带插件版本号：插件升级 = 新 id，避开「Duplicate agent preset」，
// 也避免旧定义（模块缓存里的旧行代码）赖着不走。
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const LIB_DIR = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = dirname(LIB_DIR)

/** 金鱼宪章：平台把它渲染成子会话的系统提示词人设段（实测生效）。 */
export const GOLDFISH_CHARTER = [
  '你是一条金鱼。',
  '',
  '你没有记忆。你看不到任何之前的对话、计划或讨论，只有这次任务里给你的材料。这不是缺陷，是你的作用：你是唯一一个还没有被说服的人。',
  '',
  '你的三条宪章：',
  '1. 严格只读。即使你手上出现了写入或执行类的工具，也不许用：你的产出只有文字。',
  '2. 无状态。不要问「我们之前说好的是什么」，你没有「之前」。材料没写的东西就是没写。',
  '3. 不说废话。不奉承，不总结，不写「总的来说」。先说不好的。',
  '',
  '工作方式：',
  '- 只挑毛病，不提供安慰。被纠正了不要说抱歉，直接改。',
  '- 每条意见必须指到具体位置（章节名、行号、文件路径）。指不出来就说明你在凭印象说话，那就不要写。',
  '- 禁止使用「合理」「健壮」「完善」「优雅」「充分」「无缝」这类无法验证的词。要么给出数字与判据，要么老老实实写「这里我不知道」。',
].join('\n')

async function readVersion() {
  try {
    const pkg = JSON.parse(await readFile(join(PKG_ROOT, 'package.json'), 'utf8'))
    return String(pkg.version ?? '0.0.0').replace(/[^0-9A-Za-z-]/g, '-')
  } catch {
    return '0-0-0'
  }
}

const version = await readVersion()

/** 金鱼 preset 的稳定 id（随插件版本变化，升级自动避开重名）。 */
export const GOLDFISH_ID = `egm-goldfish-${version}`

/** 门禁行的地址（带版本号破模块缓存：插件热重载后行代码必须跟着换新）。 */
export const GATE_ROW_URL = `file:///${PKG_ROOT.replace(/\\/g, '/')}/lib/goldfish-row.js?v=${version}`

/** 组装金鱼 preset 定义。每次调用返回新对象，注册方持有。 */
export function goldfishDefinition() {
  return {
    id: GOLDFISH_ID,
    name: 'EGM 金鱼（零上下文挑刺）',
    description: '零上下文评审者：预设读取与搜索工具，创建钩子另设原生 read-only 文件策略；不构成全部工具与外部副作用的隔离保证。',
    order: 90,
    plugins: [
      { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: GOLDFISH_CHARTER } },
      { id: 'egm-gate', name: GATE_ROW_URL },
      { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs', config: { write: false, edit: false } },
      { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: true } },
    ],
  }
}
