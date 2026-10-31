import { createSkillProvider } from './skill-provider.js'
import { goldfishDefinition } from './goldfish.js'
import { registerGoldfishPolicy } from './goldfish-policy.js'
import {
  registerDispatchTool,
  registerEgmArtifactCommand,
  registerEgmBootstrapCommand,
  registerEgmCommand,
  registerEgmConfigCommand,
  registerEgmFindingsCommand,
  registerEgmHandoffCommand,
  registerEgmNewCommand,
  registerEgmRestoreCommand,
  registerEgmRunCommand,
  registerEgmTaskActionCommand,
  registerEgmOpenCommand,
  registerEgmReviewAccessCommand,
  registerEgmSafeCommand,
  registerEgmUnsafeCommand,
} from './dispatch.js'
import { createPetStore, registerPetRoutes } from './pet-state.js'
import { attachElephantTracker } from './elephant-state.js'
import { summaryPresetDefinition, markSummaryPresetRegistrationError } from './review-summarizer.js'
import { registerBatchDispatchTool } from './batch-dispatch.js'

/** Cordis 插件名。 */
export const name = 'egm'

/** 技能注册表是主依赖；缺了就别加载，避免半残。 */
export const inject = ['skills']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  // 顶栏宠物与大象金鱼卡片的状态源：内存状态表，进程内单例；严格隔离 sessionId。
  const petStore = createPetStore()
  const onPetEvent = (event) => {
    if (!event || typeof event.type !== 'string') return
    petStore.apply(event.sessionId, event.type, event)
  }

  // Register before presets/tools: a failed policy hook must fail plugin loading.
  registerGoldfishPolicy(ctx)

  // 真实大象状态：只订宿主可观测的 agent/* 与 session/event。
  // 拿不到事件就把 bridge 标成 unavailable，不拿 idle 冒充；不新增任何 RPC。
  attachElephantTracker(ctx, petStore)

  // 1) 技能：大象侧的规程（egm-gate / egm-review）。
  ctx.skills.registerProvider(() => createSkillProvider())

  // 2) 金鱼 preset 与 汇总 preset：装配锁 + 门禁锁。注册失败不拖垮插件——
  //    dispatch 工具会在派活时给出诚实的错误。
  ctx.inject(['agentPresets'], (child) => {
    const presets = child.get('agentPresets')
    if (!presets?.register) return
    try { Promise.resolve(presets.register(goldfishDefinition())).catch((error) => console.error('[dsh-egm] preset registration failed:', error)) } catch (error) { console.error('[dsh-egm] preset registration failed:', error) }
    try {
      Promise.resolve(presets.register(summaryPresetDefinition())).catch((error) => {
        markSummaryPresetRegistrationError(error)
        console.error('[dsh-egm] summary preset registration failed:', error)
      })
    } catch (error) {
      markSummaryPresetRegistrationError(error)
      console.error('[dsh-egm] summary preset registration failed:', error)
    }
  })

  // 3) 命令：开启派发窗口（/egm 注入快速流程，/egm-open 只开窗）、明确授权非隔离模式、关闭窗口、一键权限控制（/egm-review-access）。
  ctx.inject(['commands'], (child) => {
    const commands = child.get('commands')
    if (!commands?.register) return
    try {
      registerEgmCommand(child, { onEvent: onPetEvent })
      registerEgmNewCommand(child, { onEvent: onPetEvent })
      registerEgmTaskActionCommand(child, { onEvent: onPetEvent })
      registerEgmRestoreCommand(child, { onEvent: onPetEvent })
      registerEgmConfigCommand(child, { onEvent: onPetEvent })
      registerEgmRunCommand(child, { onEvent: onPetEvent })
      registerEgmFindingsCommand(child, { onEvent: onPetEvent })
      registerEgmArtifactCommand(child, { onEvent: onPetEvent })
      registerEgmHandoffCommand(child, { onEvent: onPetEvent })
      registerEgmBootstrapCommand(child, { onEvent: onPetEvent })
      registerEgmOpenCommand(child, { onEvent: onPetEvent })
      registerEgmUnsafeCommand(child)
      registerEgmSafeCommand(child, { onEvent: onPetEvent })
      registerEgmReviewAccessCommand(child, { onEvent: onPetEvent })
    } catch (error) { console.error('[dsh-egm] registration failed:', error) }
  })

  // 4) egm_dispatch 与 egm_dispatch_batch 工具：派发前检查授权；临时目录不是安全隔离。
  ctx.inject(['tools', 'subagents'], (child) => {
    try {
      registerDispatchTool(child, { onEvent: onPetEvent })
      registerBatchDispatchTool(child, { onEvent: onPetEvent })
    } catch (error) { console.error('[dsh-egm] registration failed:', error) }
  })

  // 5) 输入框浮层：把「此刻在做什么」挂成 /api 路由，网页端每 1.2 秒读一次。
  //    没有 connection 服务（比如纯终端宿主）就跳过，插件其余部分照常工作。
  ctx.inject(['connection'], (child) => {
    try {
      registerPetRoutes(child, petStore)
    } catch (error) { console.error('[dsh-egm] pet route registration failed:', error) }
  })
}
