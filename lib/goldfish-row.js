// 金鱼装配清单里的「门禁」行：金鱼上岗那一刻，把它的工具收窄到只读。
//
// 实测结论（2026-10-28，桌面环境真机验证）：
//   1) restrict({ allow: [] }) 合法且生效——全局注册的 70+ 工具全部不可见；
//   2) allow/deny 名单只认「全局工具」，且名单因作用域而异，硬编码必翻车；
//   3) 预设自己挂的工具（read/glob/grep）不归 restrict 管，天然保留；
//   4) 最外层运行时注入的 ops_bash / ops_discover_tools 不在工具注册表里，
//      任何插件机制都摘不掉。
//
// 因此这一行只是「尽量收窄」，不是隔离，也不保证只读。房间 cwd（一次性目录）
// 只是工作目录，不是权限边界。真正的安全阀在 dispatch.js：默认 fail-closed，
// 只有用户亲自输入 /egm-unsafe 才允许派发，且结果标注为非严格评审。
//
// 防御性设计：allow=[] 后用金丝雀检查读取工具是否还可见；
// 若预设工具也被误伤，立即吊销本次限制，退回「现场点名 + 黑名单」。
export const name = 'egm-goldfish-gate'
export const inject = ['tools']

const DENY_RE = /ops_bash|ops_discover_tools|download_file|create_worktree|ralph|workflow|browser_read|^conversation_|^agent_teams_|^social_|^session_|^jev_|^mcp__|^mnemon_(document_manage|document_create|memory_body|remember|forget|link|runtime_memory|subagent_result|view_action)|^open_|^propose_|^summon_|unlag_refresh|write|edit|bash|pwsh|str-replace|^todo|^job_|^schedule_|^present$|^skill$|subagent/

export function apply(ctx) {
  const namesOf = (schemas) => {
    if (Array.isArray(schemas)) return schemas.map((s) => (typeof s === 'string' ? s : s?.name ?? s?.tool ?? '')).filter(Boolean)
    if (schemas && typeof schemas === 'object') return Object.keys(schemas)
    return []
  }

  // 第一道：空白名单，全局工具全部清场。
  try {
    const disposer = ctx.tools.restrict({ allow: [] })
    // 金丝雀：确认预设发的读取工具还活着；被误伤就退回黑名单方案。
    let readVisible = false
    try {
      const names = namesOf(ctx.tools.schemas?.())
      readVisible = names.includes('read')
    } catch {}
    if (readVisible) return
    try { disposer?.() } catch {}
  } catch {}

  // 第二道：现场点名，把有副作用的工具全部 deny。
  try {
    const names = namesOf(ctx.tools.schemas?.())
    const deny = names.filter((n) => DENY_RE.test(n))
    if (deny.length > 0) ctx.tools.restrict({ deny })
  } catch {}
}
