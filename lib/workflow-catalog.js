// EGM 工作流目录（Workflow Catalog）
//
// 只描述数据：workflowId、对应技能、输入要求、产物类型与恢复点。
// 不复制技能正文到另一个规则引擎，也不执行用户配置里的任何 JS。
// 技能负责"怎么想、怎么写、怎么审"，插件负责记录、校验、调度与显示。
//
// 与 interaction-contract 的关系：所有工作流共用同一套任务/版本/动作卡规则；
// 工作流只决定"按哪套工序做"。

import { PACKAGE_ROOT, skillResourceInstructions } from './skill-resources.js'

/** 默认工作流：完整设计评审与实现（保留原有 /egm 行为）。 */
export const DEFAULT_WORKFLOW_ID = 'gate'

/**
 * 工作流目录。requiresReviewConfig 为真时，需要 .egm/config.json 里的命名评审配置；
 * 未配置时菜单里显示为不可用并给出原因，不偷偷套默认标准。
 */
export const WORKFLOWS = Object.freeze([
  Object.freeze({
    id: 'gate',
    label: '完整设计评审与实现',
    skill: 'egm-gate',
    summary: '需求 → 图纸 → 金鱼独立评审 → 大象核实并改图纸 → 用户批准 → 实现。',
    artifacts: Object.freeze(['design', 'review']),
    requiresReviewConfig: false,
  }),
  Object.freeze({
    id: 'brainstorm',
    label: '脑暴',
    skill: 'egm-classic-brainstorm',
    summary: '先发散概念、方案与取舍，不写实现、不派金鱼。',
    artifacts: Object.freeze(['notes']),
    requiresReviewConfig: false,
  }),
  Object.freeze({
    id: 'draft',
    label: '逐节起草',
    skill: 'egm-classic-draft',
    summary: '按章节逐步起草正式设计文档，写一节核一节。',
    artifacts: Object.freeze(['design']),
    requiresReviewConfig: false,
  }),
  Object.freeze({
    id: 'custom',
    label: '自定义评审',
    skill: 'egm-classic-review',
    summary: '按 .egm/config.json 里的命名评审配置选择角色与标准组合。',
    artifacts: Object.freeze(['review']),
    requiresReviewConfig: true,
  }),
  Object.freeze({
    id: 'resolve',
    label: '处理现有意见',
    skill: 'egm-classic-resolve',
    summary: '把已有评审意见逐条核实、处置，并记录修法与证据。',
    artifacts: Object.freeze(['design', 'review']),
    requiresReviewConfig: false,
  }),
  Object.freeze({
    id: 'bootstrap',
    label: '仓库文档整理',
    skill: 'egm-classic-bootstrap',
    summary: '自底向上为仓库生成或整理文档，子目录完成后再汇总根文档。',
    artifacts: Object.freeze(['docs']),
    requiresReviewConfig: false,
  }),
  Object.freeze({
    id: 'drift',
    label: '文档与代码差异检查',
    skill: 'egm-classic-drift-report',
    summary: '对照正式图纸与实际代码输出偏离项；这是交付复核，不等于验证实现正确。',
    artifacts: Object.freeze(['report']),
    requiresReviewConfig: false,
  }),
])

/** 给前端/面板用的轻量列表（不含技能正文）。 */
export function listWorkflows() {
  return WORKFLOWS.map((item) => ({
    id: item.id,
    label: item.label,
    summary: item.summary,
    requiresReviewConfig: item.requiresReviewConfig,
  }))
}

/**
 * 按 id 解析工作流；未知 id 返回默认工作流。
 * @param {string} id
 * @returns {object}
 */
export function resolveWorkflow(id) {
  const key = String(id ?? '').trim()
  return WORKFLOWS.find((item) => item.id === key) || WORKFLOWS[0]
}

/**
 * 从 /egm 输入里解析工作流前缀：`--workflow brainstorm 需求…` 或 `-w brainstorm 需求…`。
 * 没有前缀时返回默认工作流，explicit=false。
 *
 * @param {string} text
 * @returns {{ workflowId: string, explicit: boolean, found: boolean, rawId: string, rest: string }}
 */
export function parseWorkflowPrefix(text) {
  const raw = String(text ?? '')
  const match = raw.match(/^\s*(?:--workflow|-w)\s+([A-Za-z0-9_-]+)\s*([\s\S]*)$/)
  if (!match) {
    return { workflowId: DEFAULT_WORKFLOW_ID, explicit: false, found: false, rawId: '', rest: raw.trim() }
  }
  const rawId = match[1]
  const found = WORKFLOWS.some((item) => item.id === rawId)
  return {
    workflowId: found ? rawId : DEFAULT_WORKFLOW_ID,
    explicit: true,
    found,
    rawId,
    rest: match[2].trim(),
  }
}

/**
 * 非 gate 工作流的开场简报：说明做什么、不做什么、产物放哪。
 * @param {object} workflow
 * @param {string} idea
 * @returns {string}
 */
export function workflowKickoffBrief(workflow, idea) {
  return [
    '【EGM 工作流：' + workflow.label + '（' + workflow.id + '）】',
    '需求：' + idea,
    '本工作流只做：' + workflow.summary,
    '不要扩大到其他工序；不要把"改文档"当成"开始实现"，也不要在没有真实许可时派金鱼。',
    '产物写在任务记录给出的 .egm/ 路径下；正式图纸只保留一个当前引用，不搬动用户已有文件。',
    '需要用户拍板时，先展示发现与可选做法，再按 interaction-contract 输出 egm-actions 按钮。',
  ].join('\n')
}

/**
 * 非 gate 工作流的规程：技能资源锚定 + 共用规则。
 * 技能正文缺失时抛 E_SKILL_RESOURCES_MISSING，不返回半截规程。
 *
 * @param {object} workflow
 * @returns {string}
 */
export function workflowProcedureText(workflow) {
  const anchor = skillResourceInstructions(workflow.skill, PACKAGE_ROOT)
  return [
    anchor,
    '',
    '## 共用规则（所有工作流一致）',
    '1. 任务记录、版本号与动作卡以后端为准：动作卡只引用后端给出的 taskId 和 specRevision。',
    '2. 普通用户提问、补充说明不改变方案版本，也不解除暂缓；只有明确改需求才接续并升版。',
    '3. 暂缓只阻止后续调度，不假装已停掉正在跑的模型或工具；插件没有"停止当前运行"按钮。',
    '4. 金鱼只做独立挑刺，不能替你批准；开始实现必须由用户明确批准，且与当前图纸摘要一致。',
    '5. 不运行测试、语法检查、浏览器自动化或模拟派发；没有真实运行证据就写"已实现，运行未验"。',
    '6. 进度用 egm-progress 块上报（绑定 opId），只报进度，不代替用户批准或独立验收。',
  ].join('\n')
}
