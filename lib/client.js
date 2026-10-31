/**
 * EGM 大象与金鱼的网页端界面（客户端一半）。
 *
 * 设计边界（与 README / 交付说明一致）：
 *   1. 只读真实数据：状态来自 `egm-pet/state`，评审正文来自 `egm-pet/report`。
 *      没有数据就写“状态未知/读取失败”，不画进度条、不编“正在评审”这类假状态。
 *   2. 严格按会话隔离：插槽拿不到 sessionId 就不请求、不渲染；回包 sessionId
 *      对不上直接丢弃，绝不回退到“最近一个会话”。
 *   3. 手动入口走真实命令：把用户写的需求拼成 `/egm <需求>`，用宿主自己的
 *      输入框 shell 提交，和手打斜杠命令是同一条路；不新增任何后端接口。
 *   4. 发送前保护已有草稿与附件：输入框非空、带附件、读不到附件列表就拒绝，
 *      不覆盖、不清卡片草稿、不重试。
 *   5. 底部入口保留在 conversation.input.left；面板与工作大象用 body Portal。
 *      面板用当前输入区的实测坐标定位，保护原生进度区与输入卡片。
 *   6. 收起不等于取消：点外部、Esc、再点一次都只收起卡片，不取消任务、
 *      不清草稿；任务结束后已打开的卡片保持到用户自己收起。
 *
 * 这里不是打包产物：DSH 网页端用 __ModuleLoader__ 装载，React 由宿主提供。
 */
window.__ModuleLoader__.load({
  id: 'dsh-egm',
  factory(require) {
    const React = require('react')
    let ReactDOM = null
    try {
      ReactDOM = require('react-dom')
    } catch {}
    const createPortal =
      ReactDOM && typeof ReactDOM.createPortal === 'function'
        ? ReactDOM.createPortal
        : (node, container) => node
    const h = React.createElement

    const CHANNEL = '/api'
    const STATE_METHOD = 'egm-pet/state'
    const REPORT_METHOD = 'egm-pet/report'
    const POLL_MS = 1200
    const RETRY_MS = 3000
    const STYLE_ID = 'dsh-egm-pet-style'
    const MAX_COUNT = 99
    const KNOWN_STATES = new Set(['idle', 'prep', 'writing', 'dispatch', 'crit'])
    const CARD_GAP = 8
    const EDGE = 8
    const PANEL_MAX = 460
    const PANEL_MIN_ABOVE = 240
    const PANEL_SIDE_MIN = 260
    const PANEL_COMPACT = 200
    const PANEL_MINIMAL = 48
    const PANEL_WIDTH = 320

    const COPY = {
      title: 'EGM 守门',
      launch: 'EGM',
      modeEnter: '输入首条需求',
      modeExit: '取消本次启动',
      modeEnterHint: '点一下开启大象模式：这条输入框里的消息会走 /egm，文字和图片都照原样发',
      modeOn: '大象模式已开启：这条输入框里的消息会走 /egm',
      modeStaleHint: '大象模式已开启，但输入框里暂时没有 /egm 标记，当前不会走 EGM；清空输入框后会自动补上',
      modeChipLabel: '输入需求',
      modeTitle: '当前方案',
      statusSummary: '查看当前状态',
      modePanelOn: '首条需求准备好了，直接用输入框发送；发送后自动退出启动状态，后续消息接续同一方案。',
      modePanelOff: '后续直接在输入框补充或修改方向，继续当前大象和方案。只有点击「另起方案」才重新开始。',
      modeKeptOwn: '大象模式已关闭。草稿开头的 /egm 是你自己写的，没有动它；直接发出去仍然会走 EGM。',
      modeCloseFailed: '没能摘掉输入框里的 /egm 标记，模式仍然开着；请手动删掉开头的 /egm 再试一次。',
      modeBlockedShort: '模式未接上',
      modeUnprotected:
        '大象模式没有开启：宿主没有给出可拦截的发送入口（或它拒绝被接管），开着也保证不了这条不会变成普通消息。草稿原样保留，没有动。',
      modeGateLost:
        '大象模式已自动关闭：宿主的发送入口被换掉/盖住了，我们这层拦不住了（被换掉到被发现之间发出去的消息可能没走 /egm）。草稿原样保留，没有动。',
      modeKeptOnDisable:
        '大象模式已关闭：宿主的发送入口没保住。输入框开头的 /egm 我分不清是不是自己加的，就没有动它；要普通发送请手动删掉开头的 /egm。',
      modeGateError:
        '已拦下这条消息：检查“会不会走 /egm”时出错了，宁可先不发。再按一次发送键会重新判断。',
      modeBlocked:
        '已拦下这条消息：大象模式开着，但输入框里没有 /egm 标记，发出去会变成普通消息。已尝试补回标记；补不上就关掉大象模式再发。',
      chooseTitle: '选择 EGM 启动方式',
      chooseSub: '选择一次会自动记住；以后在 EGM 入口上右键可换方式。',
      chooseDialog: '对话框方式',
      chooseDialogDesc: '用输入框写首条需求，可带图片；启动后继续在这里调整同一方案。',
      chooseCard: '卡片方式',
      chooseCardDesc: '弹出固定小卡片写需求，只支持文字，不动输入框。',
      chooseRemember: '不再提示（记住我的选择）',
      chooseCurrent: '当前使用：',
      markOpen: '选择 EGM 启动方式',
      modeChoose: '换启动方式',
      elephant: '大象',
      goldfish: '金鱼',
      launchTitle: '先想清楚，再动手',
      workflowTitle: '这次的工作内容',
      workflowHint: '选择一次会记住，下次启动沿用；要换流程就另起方案。',
      workflowLocked: '当前方案已经建立，工作内容按创建时确定；要换流程请另起方案。',
      workflowComposerNote: '这个选择只在卡片方式启动时写进命令。用对话框方式启动会走默认流程；想换流程，用卡片方式，或自己在 /egm 后面写上 --workflow <流程名>。',
      elephantTitle: '大象 · 图纸与闸门',
      goldfishTitle: '金鱼 · 评审记录',
      expandLaunch: '展开 EGM 手动启动卡片',
      collapseLaunch: '收起 EGM 手动启动卡片',
      expandElephant: '展开大象卡片',
      collapseElephant: '收起大象卡片',
      expandGoldfish: '展开金鱼卡片',
      collapseGoldfish: '收起金鱼卡片',
      close: '收起卡片',
      closeShort: '收起',
      loading: '读取中',
      noSession: '等待会话',
      unknown: '状态未知',
      interrupted: '暂时读不到',
      stale: '最近一次',
      idle: '空闲',
      prep: '准备',
      writing: '写图纸',
      dispatch: '派鱼',
      crit: '挑刺',
      gateOpen: '派发窗口已打开',
      gateClosed: '派发窗口未打开',
      gateUnknown: '派发窗口状态暂不可用',
      noFish: '这个会话还没有金鱼记录。',
      fishRecords: '评审记录',
      noReport: '后端没有提供可读的报告正文。',
      readReport: '读取报告',
      reloadReport: '重新读取',
      readingReport: '读取报告…',
      reportEmpty: '报告文件是空的（真实读取结果）。',
      reportTruncated: (bytes) => `报告共 ${formatBytes(bytes)}，界面只显示前面一部分。`,
      launchLabel: '你想做什么？',
      launchPlaceholder: '例如：做一个待办工具，先帮我想清楚需求',
      launchHint: '大象先整理方案，金鱼再找问题，你决定是否采纳。派金鱼前需要你的确认。',
      launchSend: '启动 EGM',
      launching: '提交中…',
      guideTitle: 'EGM 快速上手',
      guideSubtitle: '四步完成方案设计与严谨评审',
      guideDesc: '四步完成方案设计与严谨评审',
      guideStep1: '写一句需求',
      guideStep2: '大象整理方案',
      guideStep3: '授权金鱼评审',
      guideStep4: '查看评审报告',
      reviewAuthTitle: '评审授权',
      reviewRiskStatement: '评审助手的只读保护尚未验证，可能访问或修改工作区文件',
      reviewConfirmCheckbox: '我已知晓只读未验证风险，允许本轮评审',
      reviewAuthAllowed: '已授权',
      reviewRevoking: '正在撤销授权…',
      reviewRevokeBtn: '撤销授权',
      reviewRevokeNotice: '撤销将停止后续金鱼派发，正在运行的任务不受影响',
      reviewExpiredNotice: '评审授权已到期，请重新授权',
      reviewExhaustedNotice: '评审次数配额已用尽，请重新授权',
      reviewAuthorizing: '正在请求授权…',
      reviewAuthBtn: '允许本轮评审',
      reviewUnauthNotice: '暂未授权金鱼评审。评审前需手动点击授权。',
      commandCopied: '已复制',
      commandCopy: '复制备用命令',
      workingElephantAria: '大象工作中',
      step1Title: '写一句需求',
      step1Desc: '输入框写下目标',
      step2Title: '大象整理',
      step2Desc: '梳理图纸与设计',
      step3Title: '允许金鱼评审',
      step3Desc: '一键授权审查门禁',
      step4Title: '读报告',
      step4Desc: '查看结论与建议',
      chooseDialogRec: '对话框方式（推荐）',
      recBadge: '新手推荐',
      authTitle: '评审授权与门禁',
      authSubtitle: '管理金鱼评审派发与文件访问权限',
      authRisk: '评审助手的只读保护尚未验证，可能访问或修改工作区文件',
      authConfirmCheck: '我已了解风险，确认无隔离评审',
      authAllowBtn: '允许本轮评审',
      authReconfirmBtn: '重新允许本轮评审',
      authCancelBtn: '暂不授权',
      authRevokeBtn: '撤销授权',
      authRevokeHint: '撤销将停止后续金鱼派发，正在运行的任务不受影响',
      authAllowed: '已授权',
      authDenied: '未授权',
      authExpired: '已过期',
      authExhausted: '配额已用尽',
      authLoading: '正在执行…',
      authBackupNotice: '命令执行失败。请在会话输入框手动输入以下命令并发送：',
      authCopyBtn: '复制命令',
      authCopied: '已复制',
      gateRowRemaining: (n) => '剩余 ' + n + ' 次',
      gateRowExpires: (t) => '到期 ' + t,
      launchEmpty: '先写一句想让 EGM 先出图纸的事。',
      launchOk: '已触发提交，输入框已清空。这不代表后端已建立方案——底栏显示"当前方案"才算成立；以会话里出现的消息为准。',
      launchUncertain: '已触发提交，但输入框没有清空，无法确认是否发出。没有重复发送，请检查输入框。',
      launchCommandEcho: (text) => '将发送：' + text,
      draftOccupied: '输入框里已有未发送的文字。为避免覆盖你的草稿，这次没有发送；请先清空或发出输入框内容。',
      attachmentPresent: '输入框里已有附件。为避免把附件随这条命令一起发出，这次没有发送；你的附件和卡片草稿都保留着。',
      attachmentAppeared: '等待提交期间输入框新增了附件，已停止发送；你的附件和卡片草稿都保留着。',
      attachmentUnknown: '读不到输入框的附件列表，无法确认不会误发附件，未发送；卡片草稿还在。',
      noComposer: '当前版本拿不到当前会话的输入框控件，无法真实发送；没有做假按钮。',
      noShell: '拿不到当前会话的输入框；没有发送，也没有清空卡片草稿。',
      pending: '上一条还在提交，请稍候。',
      draftUnreadable: '读不到输入框当前内容，无法确认是否安全，未发送；卡片草稿还在。',
      submitUnreadable: '已触发提交，但读不到输入框后续状态，无法确认是否发出；没有重复发送，请检查输入框。',
      submitRejected: '当前会话没有接受这次提交，消息没有发出；卡片草稿还在，输入框里的文字也没有被清掉。',
      reportMemory: '后端返回的是内存回退摘要，不是磁盘上的完整报告；请以报告文件为准。',
      reportDisk: '来源：报告文件',
      reportFallback: '来源：内存摘要',
      reportSourceUnknown: '来源：未知',
      stateUnknownHint: '系统还没给出状态，这里不猜。',
      elephantUnknownHint: '系统没说大象在不在工作，所以先不显示。',
      notWorking: '未工作',
      working: '工作中',
      // prep 阶段的大象确实在跑（真在干活），但干的是“处理方案”，还没到写图纸。
      busy: '大象在忙',
      fishBusy: '金鱼在忙',
      busyTitle: '大象在忙（正在处理方案）',
      readOnly: '这里只显示实际状态；卡片不会自己派金鱼。派发窗口打开不代表已获非隔离许可；只读隔离仍未验证。',
      taskVersion: (spec) => '方案版本 ' + spec,
      taskStatusLine: (statusLabel, phaseLabel) => statusLabel + ' · ' + phaseLabel,
      taskActionsTitle: '可执行动作',
      taskNoActions: '后端暂时没有给出可执行动作；可以直接在输入框写指令，或稍后重试。',
      taskBroken: '任务记录读不出来，已停止自动处理。请先备份该文件，再重试。',
      taskDocMissing: '图纸文件当前不存在（可能还没写，或已被移走）。',
      copyDoc: '复制图纸路径',
      copyDocOk: '图纸路径已复制',
      copyDocFail: '复制失败，请手动选择路径文本',
      opsTitle: '最近操作',
      opDelivery: {
        'pending-send': '待发送',
        delivered: '已提交',
        unknown: '送达待确认',
        failed: '未发出',
      },
      opExecution: {
        'not-started': '未开始',
        running: '执行中',
        'reported-done': '模型自称完成（未独立验收）',
        failed: '执行失败',
        unknown: '执行情况未知',
      },
      archivesTitle: '历史方案',
      archiveRestore: '恢复',
      archiveRestoring: '正在恢复…',
      archiveRestoreOk: '已恢复历史方案；临时评审许可不会一并恢复，需要重新授权。',
      archiveEmpty: '还没有历史方案。',
      configTitle: '评审配置',
      configNone: '没有项目级评审配置（.egm/config.json），当前用内置角色。',
      configBroken: '评审配置有问题，已停止使用：',
      configFixHint: '修好之前不会回落到默认配置。',
      configHashLine: function (hash) { return '配置哈希 ' + String(hash || '').slice(0, 12) + '（改文件只影响下一次评审）' },
      launchSubmittedPending: '已提交，等待方案建立。后台建立成功后会显示当前方案；以会话里出现的消息为准。',
      recent: '最近更新',
      statusLabel: '会话状态',
      goldfishLabel: '金鱼记录',
      gateLabel: '派发窗口',
      elephantLabel: '大象',
      modeLabel: '模式',
      roleLabel: '角色',
      docLabel: '图纸',
      startedLabel: '开始',
      finishedLabel: '结束',
      errorLabel: '失败原因',
      viewRecords: (n) => `查看评审记录（${n} 条）`,
      noRecords: '还没有记录',
      noRoomShort: '放不下',
      nowTitle: '现在的情况',
      elephantSection: '大象在做什么',
      progressRow: '进度',
      recordsRow: '评审记录',
      gateRow: '派发窗口',
      elephantRow: '大象',
      signalRow: 'EGM 信号',
      turnRow: '这次是 EGM 的活吗',
      reasonRow: '状态说明',
      signalYes: '有',
      signalNo: '没有',
      turnYes: '是',
      turnNo: '不是',
      noRoom: '这里放不下卡片：进度卡和输入框之间没有空位。把窗口拉大或收起进度卡再试。',
      noAnchor: '量不到输入框的位置，EGM 入口先不显示；不会猜一个位置去挡按钮。',
      panelHidden: '暂时收起：量不到输入卡片和上方进度区的位置，不猜位置去盖东西。',
      badgeTitle: (n) => `${n} 条金鱼记录`,
      staleHint: (reason) => '状态断了：' + reason + '。下面是上一次读到的。',
    }

    const CSS = `
.egm-root, .egm-panel, .egm-inline-review-card{
  --egm-primary:var(--dsw-alias-brand-primary,var(--dsw-alias-accent,#d98b6a));
  --egm-on-primary:var(--dsw-alias-label-primary-foreground,#1a0f0a);
  --egm-text:var(--dsw-alias-label-primary,#e9edf2);
  --egm-dim:var(--dsw-alias-label-secondary,#98a2b1);
  --egm-dim2:var(--dsw-alias-label-tertiary,#7f8996);
  --egm-card:var(--dsw-alias-bg-elevated,#20242b);
  --egm-block:var(--dsw-alias-bg-raised,var(--dsw-alias-bg-layer-2,#262b33));
  --egm-inset:var(--dsw-alias-bg-layer-3,#2d333c);
  --egm-float:var(--dsw-specific-menu,var(--egm-card));
  --egm-line:var(--dsw-alias-separator-primary,rgba(127,127,127,.14));
  --egm-hover:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));
  --egm-success:var(--dsw-alias-state-success-primary,#6fbf8f);
  --egm-warn:var(--dsw-alias-state-warn-primary,#d9b36a);
  --egm-biz:var(--dsw-alias-state-business-primary,#8fb3d9);
  --egm-error:var(--dsw-alias-state-error-primary,#e0705a);
  --egm-error-bg:var(--dsw-alias-state-error-tertiary,rgba(224,112,90,.14));
  --egm-success-bg:var(--dsw-alias-state-success-tertiary,rgba(111,191,143,.12));
  --egm-shadow:var(--dsw-elevation-panel,0 12px 32px rgba(0,0,0,.28));
  --egm-spring:cubic-bezier(.34,1.56,.64,1);
  box-sizing:border-box;color:var(--egm-text);font-family:inherit;font-variant-numeric:tabular-nums;
  letter-spacing:0;-webkit-tap-highlight-color:transparent}
.egm-root{position:relative;display:inline-flex;align-items:center;gap:4px;flex:0 0 auto;padding:0;margin:0;order:2}
/* 大象模式标记：贴在输入卡左缘的小圆徽标（跨边线），可点击换启动方式。
   非编辑性 DOM（不可编辑、不可删），固定定位 + body portal，
   避开 .row 的 container-type 造成的 fixed 包含块陷阱。 */
.egm-mode-mark{position:fixed;z-index:9998;box-sizing:border-box;display:grid;place-items:center;
  width:18px;height:18px;margin:0;padding:0;border:1px solid var(--egm-line);
  border-radius:1000px;background:var(--egm-card);pointer-events:auto;cursor:pointer;
  line-height:0;color:var(--dsw-alias-state-business-primary,#4d6bfe);
  box-shadow:0 1px 4px rgba(0,0,0,.22);
  transition:background .2s ease,transform .26s var(--egm-spring)}
.egm-mode-mark:hover{background:var(--egm-inset)}
.egm-mode-mark:active{transform:scale(.92)}
.egm-mode-mark:focus-visible{outline:2px solid var(--egm-primary);outline-offset:2px}
.egm-mode-mark>svg{display:block;width:13px;height:13px}
.egm-mode-mark[data-state="stale"]{opacity:.4}
.egm-mode-mark[data-state="blocked"]{opacity:.55}
/* 新手向导与四步流程 */
.egm-guide-steps{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin:2px 0 6px}
.egm-guide-step{display:flex;flex-direction:column;align-items:center;text-align:center;gap:2px;padding:6px 2px;border-radius:6px;background:var(--egm-inset)}
.egm-guide-step-num{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:1000px;background:var(--egm-primary);color:var(--egm-on-primary);font-size:10px;font-weight:700}
.egm-guide-step-title{font-size:11px;font-weight:600;line-height:14px;color:var(--egm-text)}
.egm-guide-step-desc{font-size:10px;line-height:12px;color:var(--egm-dim)}
.egm-option--recommended{border-color:var(--egm-primary);background:var(--egm-hover);position:relative}
.egm-badge-rec{display:inline-block;padding:1px 5px;border-radius:4px;background:var(--egm-primary);color:var(--egm-on-primary);font-size:9px;font-weight:700;margin-left:6px;vertical-align:middle}

/* 评审授权卡片与控件 */
.egm-auth-box{display:flex;flex-direction:column;gap:8px;padding:10px;border-radius:8px;background:var(--egm-block);border:1px solid var(--egm-line)}
.egm-auth-risk{font-size:11px;line-height:15px;color:var(--egm-warn);padding:6px 8px;border-radius:6px;background:var(--egm-error-bg);border:1px solid var(--egm-line)}
.egm-auth-status-row{display:flex;align-items:center;justify-content:space-between;font-size:12px}
.egm-auth-badge{display:inline-flex;align-items:center;gap:4px;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:600}
.egm-auth-badge[data-status="allowed"]{background:var(--egm-success-bg);color:var(--egm-success)}
.egm-auth-badge[data-status="denied"]{background:var(--egm-error-bg);color:var(--egm-error)}
.egm-auth-badge[data-status="expired"]{background:rgba(217,179,106,.15);color:var(--egm-warn)}
.egm-auth-badge[data-status="exhausted"]{background:rgba(217,179,106,.15);color:var(--egm-warn)}
.egm-auth-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.egm-backup-cmd{display:flex;flex-direction:column;gap:4px;padding:6px 8px;background:var(--egm-inset);border-radius:6px;font-size:11px}
.egm-backup-code{font-family:monospace;background:var(--egm-card);padding:4px 6px;border-radius:4px;user-select:all;word-break:break-all}
/* 中文说明按可读字号显示；窄窗口使用面板原有滚动区域。 */
.egm-panel{font-size:14px;line-height:1.65;text-autospace:normal;line-break:strict}
.egm-panel .egm-muted,.egm-panel .egm-warn,.egm-panel .egm-bad,
.egm-panel .egm-error,.egm-panel .egm-notice,.egm-panel .egm-empty,
.egm-panel .egm-report,.egm-panel .egm-textarea,
.egm-panel .egm-option span{font-size:14px;line-height:1.65}
.egm-panel .egm-panel-sub,.egm-panel .egm-section-title,.egm-panel .egm-section-note,
.egm-panel .egm-fish-meta,.egm-panel .egm-fish-status,.egm-panel .egm-report-meta,
.egm-panel .egm-label,.egm-panel .egm-check{font-size:12px;line-height:1.6}
.egm-panel .egm-check{align-items:flex-start}
.egm-panel .egm-auth-risk{font-size:14px;line-height:1.65}
.egm-panel .egm-badge-rec{font-size:12px;line-height:1.6}
.egm-panel .egm-btn--primary{background:var(--egm-primary);color:var(--egm-on-primary)}
.egm-panel .egm-auth-error{color:var(--egm-error);overflow-wrap:anywhere}
.egm-panel .egm-auth-backup-cmd{display:block;max-width:100%;white-space:pre-wrap;overflow-wrap:anywhere}

/* Adapted from dsh-claude-style whale.css (Nwflower, MIT).
   See lib/claude-mascot-license.txt. Same stand as the active whale or crab; theme-free composer fallback. */
.egm-working-elephant-container{position:absolute;right:104px;bottom:calc(100% - 4px);z-index:1;width:104px;height:104px;pointer-events:none}
:is([data-dsh-claude-deepy-anchor="stack"],[data-dsh-claude-crab-anchor="stack"])>.egm-working-elephant-container{right:calc(max(var(--dsh-composer-side-clearance,16px),(100% - var(--dsh-composer-card-max-width,100%))/2) + 104px)}
:is([data-dsh-claude-deepy-anchor="panel"],[data-dsh-claude-crab-anchor="panel"])>.egm-working-elephant-container{right:calc(max(var(--dsh-composer-side-clearance,16px) + 16px,(100% - var(--dsh-chat-content-width,100%))/2) + 104px);bottom:calc(100% - 11px)}
.egm-working-elephant-btn,
.egm-working-elephant-hit{position:absolute;left:20px;top:52px;width:64px;height:48px;padding:0;border:0;background:transparent;cursor:pointer;pointer-events:auto;transition:transform .2s ease}
.egm-working-elephant-btn:hover,
.egm-working-elephant-hit:hover{transform:scale(1.05)}
.egm-working-elephant-btn:active,
.egm-working-elephant-hit:active{transform:scale(.95)}
.egm-working-elephant-btn:focus-visible,
.egm-working-elephant-hit:focus-visible{outline:2px solid var(--egm-primary);outline-offset:2px}
.egm-working-elephant-btn svg,
.egm-working-elephant-hit svg{display:block;width:100%;height:100%;overflow:visible}
/* 启动方式选择：两张整行选项 + 记住选择的勾选框。 */
.egm-choose{display:flex;flex-direction:column;gap:6px}
.egm-option{display:flex;flex-direction:column;gap:2px;align-items:flex-start;text-align:left;width:100%;
  min-height:44px;padding:8px 10px;border:1px solid var(--egm-line);border-radius:10px;
  background:var(--egm-inset);color:inherit;font:inherit;cursor:pointer;
  transition:background .2s ease,border-color .2s ease,transform .26s var(--egm-spring)}
.egm-option:hover{background:var(--egm-hover)}
.egm-option:active{transform:scale(.98)}
.egm-option[aria-pressed="true"]{border-color:var(--egm-primary);background:var(--egm-hover)}
.egm-option strong{font-size:12px;line-height:16px;font-weight:600}
.egm-option span{font-size:11px;line-height:15px;color:var(--egm-dim)}
.egm-check{display:flex;align-items:center;gap:6px;font-size:11px;line-height:15px;
  color:var(--egm-dim);cursor:pointer;user-select:none}
.egm-check input{accent-color:var(--egm-primary);margin:0}
.egm-chip[data-mode="armed"]{box-shadow:inset 0 0 0 1px var(--dsw-alias-state-business-primary,#4d6bfe)}
.egm-root *,.egm-panel *{box-sizing:border-box;letter-spacing:0}
.egm-float{position:relative;display:inline-flex;align-items:center;gap:4px;padding:0;border:0;
  border-radius:1000px;background:transparent;color:var(--egm-text);z-index:1}
.egm-float[data-placed="true"]{animation:egm-chip-in .2s var(--egm-spring)}
.egm-chip{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:24px;
  padding:0 8px;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary,var(--egm-dim));font:inherit;
  font-size:12px;line-height:16px;font-weight:500;cursor:pointer;white-space:nowrap;
  transition:background .2s ease,color .2s ease,transform .26s var(--egm-spring)}
.egm-chip:hover{background:var(--dsw-alias-interactive-bg-hover,var(--egm-hover));color:var(--dsw-alias-label-primary,var(--egm-text))}
.egm-chip:active{transform:scale(.94)}
/* 悬停 = 按压的 40%：按压 .94（缩 6%）→ 悬停 .976（缩 2.4%）。 */
@media (hover:hover){.egm-chip:hover{transform:scale(.976)}}
@media (hover:hover){.egm-icon-btn:hover,.egm-btn:hover{background:var(--egm-block)}}
.egm-chip[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-active,var(--egm-inset));color:var(--dsw-alias-label-primary,var(--egm-text))}
.egm-chip:focus-visible,.egm-panel button:focus-visible,.egm-panel textarea:focus-visible{
  outline:2px solid var(--egm-primary);outline-offset:2px}
.egm-chip-icon{display:inline-flex;align-items:center;justify-content:center;width:16px;height:14px;flex:0 0 16px}
.egm-chip-dot{width:6px;height:6px;border-radius:1000px;flex:0 0 6px;background:var(--egm-dim2)}
.egm-chip-dot[data-tone="working"]{background:var(--egm-success)}
.egm-chip-dot[data-tone="error"]{background:var(--egm-error)}
.egm-chip-dot[data-tone="stale"]{background:var(--egm-warn)}
.egm-chip-dot[data-tone="ok"]{background:var(--egm-success)}
.egm-float[data-density="compact"] .egm-chip-label{display:none}
.egm-float[data-density="compact"] .egm-chip{padding:0 6px}
.egm-chip-badge{min-width:14px;height:14px;padding:0 4px;border-radius:1000px;background:var(--egm-primary);
  color:var(--egm-on-primary);font-size:10px;line-height:14px;font-weight:700;text-align:center}
.egm-pet-chip{width:24px;padding:0}
.egm-pet-chip:focus-visible{outline-offset:1px}
.egm-pet-chip svg{display:block;width:18px;height:16px;overflow:visible}
.egm-panel{position:fixed;display:flex;flex-direction:column;min-width:0;overflow:hidden;
  border:1px solid var(--egm-line);border-radius:16px;background:#fff !important;color:var(--egm-text);
  box-shadow:var(--egm-shadow);z-index:10000;
  animation:egm-panel-in .24s var(--egm-spring)}
body[data-ds-dark-theme] .egm-panel{background:#202124 !important}
.egm-panel-head{display:flex;align-items:center;gap:9px;flex:0 0 auto;padding:10px 10px 9px;
  border-bottom:1px solid var(--egm-line)}
.egm-panel-head .egm-chip-icon{width:20px;height:18px;flex-basis:20px}
.egm-panel-title{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}
.egm-panel-title strong{font-size:13px;line-height:18px;font-weight:600}
.egm-panel-sub{font-size:11px;line-height:14px;color:var(--egm-dim);white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis}
.egm-panel-sub[data-tone="error"]{color:var(--egm-error)}
.egm-panel-sub[data-tone="stale"]{color:var(--egm-warn)}
.egm-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;flex:0 0 28px;
  padding:0;border:0;border-radius:1000px;background:transparent;color:var(--egm-dim);cursor:pointer;
  transition:background .2s ease,transform .26s var(--egm-spring)}
.egm-icon-btn:hover{background:var(--egm-hover);color:var(--egm-text)}
.egm-icon-btn:active{transform:scale(.94)}
.egm-panel-body{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;
  display:flex;flex-direction:column;gap:8px;padding:10px}
.egm-panel-body>*{flex-shrink:0}
.egm-panel[data-mode="minimal"]{overflow-y:auto;overscroll-behavior:contain}
.egm-panel[data-mode="minimal"] .egm-panel-body{flex:0 0 auto;overflow-y:visible}
.egm-panel-body::-webkit-scrollbar{width:8px}
.egm-panel-body::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2,rgba(127,127,127,.28));
  border-radius:1000px}
.egm-section{display:flex;flex-direction:column;gap:6px;min-width:0;padding:9px;border:0;
  border-radius:8px;background:var(--egm-block)}
.egm-section-head{display:flex;align-items:center;gap:6px;min-width:0}
.egm-section-title{font-size:11px;line-height:14px;font-weight:600;color:var(--egm-dim)}
.egm-section-note{margin-left:auto;font-size:11px;line-height:14px;color:var(--egm-dim2)}
.egm-kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:5px 10px;
  font-size:12px;line-height:16px;align-items:start}
.egm-k{color:var(--egm-dim);white-space:nowrap}
.egm-v{min-width:0;overflow-wrap:anywhere}
.egm-muted{color:var(--egm-dim);font-size:12px;line-height:16px}
.egm-ok{color:var(--egm-success)}
.egm-warn{color:var(--egm-warn);font-size:12px;line-height:16px}
.egm-bad{color:var(--egm-error);font-size:12px;line-height:16px}
.egm-fish-list{display:flex;flex-direction:column;gap:2px;max-height:150px;overflow-y:auto}
.egm-fish{display:flex;align-items:center;gap:8px;width:100%;min-height:34px;text-align:left;border:0;
  border-radius:8px;background:transparent;color:inherit;padding:4px 6px;font:inherit;cursor:pointer;
  transition:background .2s ease}
.egm-fish:hover{background:var(--egm-hover)}
.egm-fish[aria-pressed="true"]{background:var(--egm-inset)}
.egm-fish-dot{width:6px;height:6px;border-radius:1000px;flex:0 0 6px;background:var(--egm-dim2)}
.egm-fish-dot[data-status="running"]{background:var(--egm-biz)}
.egm-fish-dot[data-status="done"]{background:var(--egm-success)}
.egm-fish-dot[data-status="failed"]{background:var(--egm-error)}
.egm-fish-role{font-size:12px;line-height:16px;font-weight:600;white-space:nowrap}
.egm-fish-meta{flex:1;min-width:0;font-size:11px;line-height:14px;color:var(--egm-dim);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.egm-fish-status{font-size:11px;line-height:14px;white-space:nowrap}
.egm-report{max-height:220px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;margin:0;
  font:12px/18px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  background:var(--egm-inset);border-radius:8px;padding:8px 9px;border:0}
.egm-report-meta{font-size:11px;line-height:14px;color:var(--egm-dim);overflow-wrap:anywhere}
.egm-label{font-size:11px;line-height:14px;font-weight:600;color:var(--egm-dim)}
.egm-textarea{display:block;width:100%;min-height:62px;max-height:148px;resize:vertical;border:0;
  border-radius:8px;background:var(--egm-inset);color:inherit;font:inherit;font-size:12px;
  line-height:18px;padding:8px 9px}
.egm-textarea::placeholder{color:var(--egm-dim2)}
.egm-select{display:block;width:100%;min-height:30px;border:0;border-radius:8px;
  background:var(--egm-inset);color:inherit;font:inherit;font-size:12px;line-height:18px;
  padding:6px 8px;cursor:pointer}
.egm-select:disabled{color:var(--egm-dim);cursor:default}
.egm-workflow-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:6px}
.egm-workflow-card{position:relative;padding:10px 10px 8px;border:1.5px solid var(--egm-border);
  border-radius:10px;background:var(--egm-inset);cursor:pointer;transition:border-color .2s,background .2s;
  display:flex;flex-direction:column;gap:3px}
.egm-workflow-card:hover:not(:disabled){border-color:var(--egm-primary);background:var(--egm-hover)}
.egm-workflow-card.selected{border-color:var(--egm-primary);background:var(--egm-primary-bg,rgba(0,120,255,.1))}
.egm-workflow-card.recommended{border-color:var(--egm-primary)}
.egm-workflow-card-label{font-size:12px;font-weight:700;line-height:16px;color:var(--egm-text)}
.egm-workflow-card-hint{font-size:11px;line-height:15px;color:var(--egm-dim)}
.egm-workflow-badge{position:absolute;top:6px;right:6px;padding:1px 6px;border-radius:1000px;
  background:var(--egm-primary);color:var(--egm-on-primary);font-size:10px;font-weight:700;line-height:14px}
.egm-workflow-nudge{margin-top:4px;text-align:center}
.egm-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.egm-btn{min-height:30px;padding:0 14px;border:0;border-radius:1000px;background:var(--egm-inset);
  color:var(--egm-text);font:inherit;font-size:12px;line-height:16px;font-weight:600;cursor:pointer;
  transition:background .2s ease,transform .26s var(--egm-spring)}
.egm-btn:hover:not(:disabled){background:var(--egm-hover)}
.egm-btn:active:not(:disabled){transform:scale(.96)}
.egm-btn:disabled{opacity:.45;cursor:not-allowed}
.egm-btn-primary{background:var(--egm-primary);color:var(--egm-on-primary)}
.egm-btn-primary:hover:not(:disabled){opacity:.9}
.egm-error{margin:0;padding:7px 9px;border-radius:8px;background:var(--egm-error-bg);
  color:var(--egm-error);font-size:12px;line-height:16px}
.egm-notice{margin:0;padding:7px 9px;border-radius:8px;background:var(--egm-success-bg);
  color:var(--egm-success);font-size:12px;line-height:16px}
.egm-empty{padding:2px 0;color:var(--egm-dim);font-size:12px;line-height:16px}
.egm-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
  clip:rect(0,0,0,0);white-space:nowrap;border:0}
.egm-anchor{position:absolute;inset:0 0 auto 0;width:auto;height:0;pointer-events:none}
.egm-anchor>.egm-float,.egm-anchor>.egm-panel{pointer-events:auto}
.egm-el-body,.egm-el-trunk,.egm-el-ear,.egm-gf-body,.egm-gf-tail,.egm-gf-mouth,.egm-gf-bubble{
  transform-box:fill-box;transform-origin:50% 100%}
.egm-el-ear{transform-origin:0% 55%}
.egm-gf-tail{transform-origin:100% 50%}
.egm-gf-mouth{transform-origin:0% 50%}
.egm-gf-bubble{transform-origin:center}
/* 工作场景：每个会动的部件都绕自己的关节转，只改 transform / opacity，不碰布局。 */
.egm-el-w-head,.egm-el-w-ear,.egm-el-w-trunk,.egm-el-w-pen,.egm-el-w-eye,
.egm-el-w-line,.egm-el-w-effort{transform-box:fill-box}
.egm-el-w-head{transform-origin:50% 100%}
.egm-el-w-ear{transform-origin:100% 30%}
.egm-el-w-trunk{transform-origin:0% 8%}
.egm-el-w-pen{transform-origin:20% 80%}
.egm-el-w-eye{transform-origin:50% 50%}
.egm-el-w-line{transform-origin:0% 50%}
.egm-el-w-effort{transform-origin:50% 100%}
/* 动画只挂在 data-work="true" 上，状态名（prep / writing …）不参与判定：
   后端诚实状态里 prep 才是“真的在跑”，writing 永远不会出现，
   所以按状态名挂动画等于永远不播。 */
.egm-pet-chip[data-work="true"]{width:auto;padding:0 6px 0 4px;gap:5px}
.egm-pet-chip[data-work="true"] svg{width:32px;height:24px}
.egm-pet-work-label{font-size:11px;line-height:14px;font-weight:600;
  color:var(--dsw-alias-label-secondary,var(--egm-dim));white-space:nowrap}
.egm-pet-chip[data-work="true"] .egm-el-w-trunk{animation:egm-el-w-write 1.15s ease-in-out infinite}
.egm-working-elephant-btn[data-work="true"] .egm-el-w-trunk,.egm-working-elephant-hit[data-work="true"] .egm-el-w-trunk{animation:egm-el-w-write 1.15s ease-in-out infinite}
.egm-pet-chip[data-work="true"] .egm-el-w-ear{animation:egm-el-w-ear 2.4s ease-in-out infinite}
.egm-working-elephant-btn[data-work="true"] .egm-el-w-ear,.egm-working-elephant-hit[data-work="true"] .egm-el-w-ear{animation:egm-el-w-ear 2.4s ease-in-out infinite}
.egm-pet-chip[data-work="true"] .egm-el-w-head{animation:egm-el-w-bob 2.2s ease-in-out infinite}
.egm-working-elephant-btn[data-work="true"] .egm-el-w-head,.egm-working-elephant-hit[data-work="true"] .egm-el-w-head{animation:egm-el-w-bob 2.2s ease-in-out infinite}
.egm-pet-chip[data-work="true"] .egm-el-w-eye{animation:egm-el-w-blink 4.6s steps(1,end) infinite}
.egm-working-elephant-btn[data-work="true"] .egm-el-w-eye,.egm-working-elephant-hit[data-work="true"] .egm-el-w-eye{animation:egm-el-w-blink 4.6s steps(1,end) infinite}
.egm-pet-chip[data-work="true"] .egm-el-w-effort{animation:egm-el-w-effort 1.8s ease-in-out infinite}
.egm-working-elephant-btn[data-work="true"] .egm-el-w-effort,.egm-working-elephant-hit[data-work="true"] .egm-el-w-effort{animation:egm-el-w-effort 1.8s ease-in-out infinite}
.egm-pet-chip[data-work="true"] .egm-el-w-line{animation:egm-el-w-line 3.6s ease-out both}
.egm-working-elephant-btn[data-work="true"] .egm-el-w-line,.egm-working-elephant-hit[data-work="true"] .egm-el-w-line{animation:egm-el-w-line 3.6s ease-out both}
.egm-pet-chip[data-work="true"] .egm-el-w-line2{animation-delay:.5s}
.egm-pet-chip[data-work="true"] .egm-el-w-line3{animation-delay:1s}
.egm-pet-chip[data-work="true"] .egm-gf-tail{animation:egm-gf-tail 1.2s ease-in-out infinite}
@keyframes egm-el-w-write{0%,100%{transform:rotate(-5deg)}38%{transform:rotate(7deg)}66%{transform:rotate(1deg)}}
@keyframes egm-el-w-ear{0%,100%{transform:rotate(-6deg)}50%{transform:rotate(5deg)}}
@keyframes egm-el-w-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-.8px)}}
@keyframes egm-el-w-blink{0%,93%{transform:scaleY(1)}96%{transform:scaleY(.15)}100%{transform:scaleY(1)}}
@keyframes egm-el-w-effort{0%,100%{opacity:.28;transform:translateY(.6px)}50%{opacity:.85;transform:translateY(-.6px)}}
@keyframes egm-el-w-line{0%{transform:scaleX(.12);opacity:.4}70%,100%{transform:scaleX(1);opacity:.7}}
@keyframes egm-gf-tail{0%,100%{transform:rotate(-8deg)}50%{transform:rotate(10deg)}}
/* 金鱼审图场景：叼着放大镜啄图纸上的红叉绿勾，尾巴摆、气泡冒。
   和大象那套一样，每个会动的部件都绕自己的关节转，只改 transform / opacity。 */
.egm-gf-w-tail,.egm-gf-w-body,.egm-gf-w-fin,.egm-gf-w-eye,.egm-gf-w-mouth,
.egm-gf-w-bubble,.egm-gf-w-bubble2,.egm-gf-w-mark,.egm-gf-w-mark2,.egm-gf-w-effort{transform-box:fill-box}
.egm-gf-w-tail{transform-origin:100% 50%}
.egm-gf-w-body{transform-origin:50% 100%}
.egm-gf-w-fin{transform-origin:50% 100%}
.egm-gf-w-eye{transform-origin:50% 50%}
.egm-gf-w-mouth{transform-origin:0% 50%}
.egm-gf-w-bubble,.egm-gf-w-bubble2{transform-origin:50% 100%}
.egm-gf-w-mark,.egm-gf-w-mark2{transform-origin:50% 50%}
.egm-gf-w-effort{transform-origin:50% 100%}
.egm-pet-chip[data-work="true"] .egm-gf-w-tail{animation:egm-gf-w-wag 1s ease-in-out infinite}
.egm-pet-chip[data-work="true"] .egm-gf-w-body{animation:egm-gf-w-bob 2.2s ease-in-out infinite}
.egm-pet-chip[data-work="true"] .egm-gf-w-fin{animation:egm-gf-w-flutter 1.8s ease-in-out infinite}
.egm-pet-chip[data-work="true"] .egm-gf-w-eye{animation:egm-gf-w-blink 4s steps(1,end) infinite}
.egm-pet-chip[data-work="true"] .egm-gf-w-mouth{animation:egm-gf-w-peck 1.4s ease-in-out infinite}
.egm-pet-chip[data-work="true"] .egm-gf-w-bubble{animation:egm-gf-w-rise 2.8s ease-in infinite}
.egm-pet-chip[data-work="true"] .egm-gf-w-bubble2{animation:egm-gf-w-rise 2.8s ease-in infinite;animation-delay:1.2s}
.egm-pet-chip[data-work="true"] .egm-gf-w-mark{animation:egm-gf-w-appear 3.2s ease-out both}
.egm-pet-chip[data-work="true"] .egm-gf-w-mark2{animation:egm-gf-w-appear 3.2s ease-out both;animation-delay:1.4s}
.egm-pet-chip[data-work="true"] .egm-gf-w-effort{animation:egm-gf-w-effort 1.8s ease-in-out infinite}
@keyframes egm-gf-w-wag{0%,100%{transform:rotate(-9deg)}50%{transform:rotate(9deg)}}
@keyframes egm-gf-w-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-.9px)}}
@keyframes egm-gf-w-flutter{0%,100%{transform:rotate(-4deg)}50%{transform:rotate(7deg)}}
@keyframes egm-gf-w-blink{0%,93%{transform:scaleY(1)}96%{transform:scaleY(.15)}100%{transform:scaleY(1)}}
@keyframes egm-gf-w-peck{0%,100%{transform:translateX(0) rotate(0)}45%,60%{transform:translateX(1.3px) rotate(4deg)}}
@keyframes egm-gf-w-rise{0%{transform:translateY(0);opacity:0}18%{opacity:.85}100%{transform:translateY(-4.6px);opacity:0}}
@keyframes egm-gf-w-appear{0%{opacity:0;transform:scale(.35)}55%,100%{opacity:1;transform:scale(1)}}
@keyframes egm-gf-w-effort{0%,100%{opacity:.28;transform:translateY(.6px)}50%{opacity:.85;transform:translateY(-.6px)}}
@media (prefers-reduced-motion:reduce){
  .egm-gf-w-tail,.egm-gf-w-body,.egm-gf-w-fin,.egm-gf-w-eye,.egm-gf-w-mouth,
  .egm-gf-w-bubble,.egm-gf-w-bubble2,.egm-gf-w-mark,.egm-gf-w-mark2,.egm-gf-w-effort{animation:none!important}
}
/* 地方窄的时候只留图形：动作本身已经说明在干活，文字先让位给输入框。 */
.egm-float[data-density="compact"] .egm-pet-chip[data-work="true"]{padding:0 4px;gap:0}
.egm-float[data-density="compact"] .egm-pet-work-label{display:none}
@keyframes egm-chip-in{from{opacity:0;transform:translateY(2px)}to{opacity:1;transform:none}}
@keyframes egm-panel-in{from{opacity:0;transform:translateY(4px) scale(.985)}to{opacity:1;transform:none}}
@media (max-width:560px){
  .egm-panel{max-width:calc(100vw - 16px)}
  .egm-panel-body{padding:8px}
  .egm-report{max-height:180px}
  .egm-pet-work-label{display:none}
  .egm-pet-chip[data-work="true"]{padding:0 4px;gap:0}
}
@media (prefers-reduced-motion:reduce){
  .egm-root *,.egm-root *::before,.egm-root *::after,
  .egm-working-elephant-container *{
    animation:none!important;transition:none!important;scroll-behavior:auto!important}
  .egm-float[data-placed="true"]{animation:none}
  .egm-panel{animation:none}
}
.egm-inline-review-card{border:0;border-radius:16px;padding:14px;background:var(--egm-block);margin:8px 0;color:var(--egm-text);font:13px/1.5 system-ui,"Segoe UI","Microsoft YaHei",sans-serif}
`

    function ensureStyle() {
      if (typeof document === 'undefined' || !document || !document.head) return
      const existing = document.getElementById(STYLE_ID)
      if (existing) {
        if (existing.textContent !== CSS) existing.textContent = CSS
        return
      }
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    function delay(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms))
    }

    function finite(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value : null
    }

    function formatBytes(value) {
      if (!finite(value) || value < 0) return '未知大小'
      if (value < 1024) return value + ' B'
      if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
      return (value / 1024 / 1024).toFixed(1) + ' MB'
    }

    function formatTime(value) {
      if (!finite(value) || value <= 0) return '未知时间'
      try {
        return new Date(value).toLocaleString()
      } catch {
        return '未知时间'
      }
    }

    function errorText(error) {
      if (!error) return '未知错误'
      if (typeof error === 'string') return error
      if (typeof error.message === 'string' && error.message) return error.message
      return String(error)
    }

    function rpcError(reply) {
      if (reply && typeof reply.error === 'string' && reply.error) return reply.error
      if (reply && reply.error && typeof reply.error.message === 'string' && reply.error.message) {
        return reply.error.message
      }
      if (reply && typeof reply.message === 'string' && reply.message) return reply.message
      return '服务端没有返回错误说明'
    }

    function stateLabel(state) {
      return COPY[state] || COPY.unknown
    }

    function gateLabel(gate) {
      if (!gate || gate.known !== true) return COPY.gateUnknown
      return gate.open ? COPY.gateOpen : COPY.gateClosed
    }

    /** 会话状态 + 是否可核实。未知就是未知，不拿 idle 冒充。 */
    function stateText(snapshot) {
      if (!snapshot || snapshot.status === 'waiting') return COPY.loading
      if (snapshot.status === 'error' || snapshot.status === 'mismatch') return COPY.interrupted
      if (snapshot.status === 'stale') return COPY.stale + '：' + stateLabel(snapshot.state)
      return stateLabel(snapshot.state)
    }

    /**
     * 有没有“正在干活”的真实证据：宿主说大象在跑、有金鱼在跑，或这一轮宿主明确 running。
     * state 只是阶段名（prep/review 之类），不能单独当作“在动”，否则会亮一个假的工作灯。
     */
    function hasActivity(snapshot) {
      if (!snapshot || !snapshot.elephant) {
        return Boolean(snapshot && snapshot.state === 'running')
      }
      if (snapshot.elephant.working === true) return true
      if (Array.isArray(snapshot.goldfish) && snapshot.goldfish.some((item) => item && item.status === 'running')) return true
      return snapshot.state === 'running'
    }

    function chipTone(snapshot) {
      if (!snapshot || snapshot.status === 'waiting') return 'idle'
      if (snapshot.status === 'error' || snapshot.status === 'mismatch') return 'error'
      // 断了就是断了：状态灯转黄，不跟着旧数据继续闪“工作中”。
      if (snapshot.status === 'stale') return 'stale'
      if (snapshot.state === 'idle') return 'ok'
      // 已连上但没观测到活动（例如 prep 阶段）：中性灰，不冒充工作。
      return hasActivity(snapshot) ? 'working' : 'idle'
    }

    /**
     * 谁在工作：只有真在跑的角色才出图标。空闲、未知、结束都不常驻宠物，
     * 结果从 EGM 入口卡里看，不靠一个永远挂着的小图标撑门面。
     *
     * 大象只认“宿主说在跑 + 宿主说这次是 EGM 的活”这两个真实信号；
     * 历史 state、历史 gate.open、历史金鱼条数都不拿来判定“正在工作”。
     * EGM 跑完后的普通聊天因此不会把大象重新点亮。
     */
    function elephantBusy(snapshot) {
      // 三个条件同时成立才算“大象真的在干活”：这一秒读到了(live)、主 Agent 在跑、
      // 且这一跑确实是 EGM 的活（egm.active && egm.turn === currentTurn）。
      // 少任何一条都不放动画：普通聊天、断线、EGM 回合已结束都立刻停。
      if (!snapshot || snapshot.status !== 'live') return false
      const view = snapshot.elephant || {}
      return view.working === true && view.workingOnEgm === true
    }

    /** 顶部那句状态：真在干活时说“大象在忙（正在处理方案）”，其余仍按真实状态说。 */
    function busyText(snapshot) {
      return elephantBusy(snapshot) ? COPY.busyTitle : stateText(snapshot)
    }

    /**
     * 金鱼是不是真的在干活：这一秒读到了（live），且 snapshot.goldfish 里有 running 的鱼。
     * 有鱼在跑本身就是“派过鱼”的证据，不需要再额外看 dispatch 信号；
     * 跑完、失败、断线都立刻收动画，普通聊天也不会点亮金鱼。
     */
    function goldfishBusy(snapshot) {
      if (!snapshot || snapshot.status !== 'live') return false
      return Array.isArray(snapshot.goldfish)
        && snapshot.goldfish.some((item) => item && item.status === 'running')
    }

    function visiblePets(snapshot) {
      // 只有“这一秒真的读到了”才让宠物出现；stale 只保留历史数据，不放动画。
      if (!snapshot || snapshot.status !== 'live') {
        return { elephant: false, goldfish: false }
      }
      const elephant = elephantBusy(snapshot)
      const goldfish = goldfishBusy(snapshot)
      return { elephant: Boolean(elephant), goldfish }
    }

    /**
     * `/egm` 的用法就是把需求写在命令后面；换行会破坏命令解析，压成单行。
     * 工作内容不是 gate 时加 `--workflow <id>` 前缀（后端 parseWorkflowPrefix 解析，未知 id 会报错并列出可用项）。
     */
    function launchCommand(text, workflowId) {
      const normalized = String(text === undefined || text === null ? '' : text)
        .replace(/\s+/g, ' ')
        .trim()
      if (!normalized) return ''
      const picked = isWorkflowId(workflowId) ? workflowId : 'gate'
      return picked === 'gate' ? '/egm ' + normalized : '/egm --workflow ' + picked + ' ' + normalized
    }

    function normalizeGoldfish(list) {
      if (!Array.isArray(list)) return []
      return list
        .filter((item) => item && typeof item === 'object')
        .map((item, index) => {
          const status =
            item.status === 'running' || item.status === 'done' || item.status === 'failed'
              ? item.status
              : 'unknown'
          return {
            id: typeof item.id === 'string' && item.id ? item.id : 'fish-' + index,
            role: typeof item.role === 'string' && item.role ? item.role : 'unknown',
            mode: typeof item.mode === 'string' && item.mode ? item.mode : null,
            stage:
              typeof item.stage === 'string'
                ? item.stage
                : Number.isFinite(item.stage)
                  ? String(item.stage)
                  : null,
            docPath: typeof item.docPath === 'string' && item.docPath ? item.docPath : null,
            status,
            startedAt: finite(item.startedAt),
            finishedAt: finite(item.finishedAt),
            reportPath: typeof item.reportPath === 'string' && item.reportPath ? item.reportPath : null,
            hasReport: item.hasReport === true,
            reportBytes: finite(item.reportBytes),
            truncated: item.truncated === true,
            error: typeof item.error === 'string' && item.error ? item.error : null,
          }
        })
    }

    function normalizeElephant(value) {
      const view = value && typeof value === 'object' ? value : null
      if (!view) {
        return {
          known: false,
          status: 'unknown',
          working: null,
          workingOnEgm: null,
          reason: 'no-status-field',
          source: null,
          since: null,
          lastActivityAt: null,
          egm: { active: false, signal: null, skill: null },
          bridge: { attached: false, agentLifecycle: false, agentStatus: false },
        }
      }
      const status =
        view.status === 'running' || view.status === 'idle' ? view.status : 'unknown'
      const known = view.known === true && status !== 'unknown'
      const egm = view.egm && typeof view.egm === 'object' ? view.egm : {}
      const bridge = view.bridge && typeof view.bridge === 'object' ? view.bridge : {}
      return {
        known,
        status,
        working: known ? status === 'running' : null,
        workingOnEgm: typeof view.workingOnEgm === 'boolean' ? view.workingOnEgm : null,
        reason: typeof view.reason === 'string' && view.reason ? view.reason : null,
        source: typeof view.source === 'string' && view.source ? view.source : null,
        since: finite(view.since),
        lastActivityAt: finite(view.lastActivityAt),
        egm: {
          active: egm.active === true,
          signal: typeof egm.signal === 'string' && egm.signal ? egm.signal : null,
          skill: typeof egm.skill === 'string' && egm.skill ? egm.skill : null,
        },
        bridge: {
          attached: bridge.attached === true,
          agentLifecycle: bridge.agentLifecycle === true,
          agentStatus: bridge.agentStatus === true,
        },
      }
    }

    function normalizeState(value, sessionId) {
      if (!value || typeof value !== 'object') throw new Error('状态回包为空')
      if (typeof value.sessionId !== 'string' || !value.sessionId) {
        throw new Error('状态回包缺少 sessionId，无法确认属于当前会话')
      }
      if (value.sessionId !== sessionId) {
        throw new Error('状态不属于当前会话（收到 ' + value.sessionId + '），已丢弃')
      }
      const legacy = value.state && typeof value.state === 'object' ? value.state : null
      const stateValue = typeof value.state === 'string' ? value.state : legacy && legacy.state
      const state = KNOWN_STATES.has(stateValue) ? stateValue : 'unknown'
      const goldfish = normalizeGoldfish(value.goldfish)
      const count =
        finite(value.count) !== null && value.count >= 0
          ? Math.min(MAX_COUNT, Math.floor(value.count))
          : Math.min(MAX_COUNT, goldfish.length)
      const gateValue = value.gate && typeof value.gate === 'object' ? value.gate : {}
      const gateKnown = typeof gateValue.open === 'boolean'
      const expiresAt = gateKnown ? finite(gateValue.expiresAt) : null
      const gate = {
        known: gateKnown,
        open: gateKnown && gateValue.open === true,
        remaining: gateKnown ? finite(gateValue.remaining) : null,
        // 后端关闭闸门时 expiresAt 常为 0；0 不是真实到期时间，不展示。
        expiresAt: expiresAt !== null && expiresAt > 0 ? expiresAt : null,
      }
      const unsafeValue = value.unsafePermit && typeof value.unsafePermit === "object" ? value.unsafePermit : {}
      const unsafeKnown = typeof unsafeValue.granted === "boolean"
      const unsafeExpiresAt = unsafeKnown ? finite(unsafeValue.expiresAt) : null
      const unsafePermit = {
        known: unsafeKnown,
        granted: unsafeKnown && unsafeValue.granted === true,
        remaining: unsafeKnown ? finite(unsafeValue.remaining) : null,
        expiresAt: unsafeExpiresAt !== null && unsafeExpiresAt > 0 ? unsafeExpiresAt : null,
        reason: typeof unsafeValue.reason === "string" && unsafeValue.reason ? unsafeValue.reason : null,
      }
      const reviewAccessValue = value.reviewAccess && typeof value.reviewAccess === "object" ? value.reviewAccess : null
      const reviewAccess = {
        known: (reviewAccessValue && typeof reviewAccessValue.allowed === "boolean") || gateKnown || unsafeKnown,
        allowed: reviewAccessValue && typeof reviewAccessValue.allowed === "boolean"
          ? reviewAccessValue.allowed === true
          : Boolean(gate.open && unsafePermit.granted),
        gate: (reviewAccessValue && reviewAccessValue.gate && typeof reviewAccessValue.gate === "object") ? reviewAccessValue.gate : gate,
        unsafePermit: (reviewAccessValue && reviewAccessValue.unsafePermit && typeof reviewAccessValue.unsafePermit === "object") ? reviewAccessValue.unsafePermit : unsafePermit,
      }
      return {
        sessionId,
        generation: finite(value.generation),
        state,
        count,
        role: typeof value.role === 'string' && value.role ? value.role : legacy && typeof legacy.role === 'string' && legacy.role ? legacy.role : null,
        mode:
          typeof value.mode === 'string' && value.mode
            ? value.mode
            : legacy && typeof legacy.mode === 'string' && legacy.mode
              ? legacy.mode
              : null,
        updatedAt: finite(value.updatedAt),
        gate,
        unsafePermit,
        reviewAccess,
        task: value.task && typeof value.task === 'object' && value.task.sessionId === sessionId ? value.task : null,
        taskError: value.taskError && typeof value.taskError === 'object' ? value.taskError : null,
        allowedActions: Array.isArray(value.allowedActions) ? value.allowedActions : [],
        proceedGate: value.proceedGate && typeof value.proceedGate === 'object' ? value.proceedGate : null,
        inFlightOpId: typeof value.inFlightOpId === 'string' && value.inFlightOpId !== '' ? value.inFlightOpId : null,
        ops: Array.isArray(value.ops) ? value.ops : [],
        archives: Array.isArray(value.archives) ? value.archives : [],
        config: value.config && typeof value.config === 'object' ? value.config : null,
        reviewRuns: Array.isArray(value.reviewRuns) ? value.reviewRuns : [],
        findings: Array.isArray(value.findings) ? value.findings : [],
        ledgerSummary: value.ledgerSummary && typeof value.ledgerSummary === 'object' ? value.ledgerSummary : null,
        impact: value.impact && typeof value.impact === 'object' ? value.impact : null,
        goldfish,
        elephant: normalizeElephant(value.elephant),
        receivedAt: Date.now(),
        status: 'live',
        error: null,
        signature: '',
      }
    }

    function signatureOf(snapshot) {
      return JSON.stringify({
        generation: snapshot.generation,
        state: snapshot.state,
        count: snapshot.count,
        role: snapshot.role,
        mode: snapshot.mode,
        updatedAt: snapshot.updatedAt,
        gate: snapshot.gate,
        unsafePermit: snapshot.unsafePermit,
        reviewAccess: snapshot.reviewAccess,
        task: snapshot.task,
        taskError: snapshot.taskError,
        allowedActions: snapshot.allowedActions,
        proceedGate: snapshot.proceedGate,
        inFlightOpId: snapshot.inFlightOpId,
        ops: snapshot.ops,
        archives: snapshot.archives,
        config: snapshot.config,
        reviewRuns: snapshot.reviewRuns,
        findings: snapshot.findings,
        ledgerSummary: snapshot.ledgerSummary,
        impact: snapshot.impact,
        elephant: snapshot.elephant,
        goldfish: snapshot.goldfish,
      })
    }

    function emptySnapshot(sessionId, status, error) {
      return {
        sessionId,
        generation: null,
        state: 'unknown',
        count: 0,
        role: null,
        mode: null,
        updatedAt: null,
        gate: { known: false, open: false, remaining: null, expiresAt: null },
        unsafePermit: { known: false, granted: false, remaining: null, expiresAt: null, reason: null },
        reviewAccess: { known: false, allowed: false, gate: null, unsafePermit: null },
        task: null,
        taskError: null,
        allowedActions: [],
        proceedGate: null,
        inFlightOpId: null,
        ops: [],
        archives: [],
        config: null,
        reviewRuns: [],
        findings: [],
        ledgerSummary: null,
        impact: null,
        goldfish: [],
        elephant: normalizeElephant(null),
        receivedAt: 0,
        status: status || 'waiting',
        error: error || null,
        signature: '',
      }
    }

    /**
     * 每个会话独立一个池：同一窗口并排渲染两个会话也不会串状态。
     * 状态请求只读当前 sessionId，绝不回退到“最近一个会话”。
     */
    async function executeHostCommand(ctx, sessionId, commandString) {
      let remoteCommands = null
      try {
        if (ctx && ctx.remote && ctx.remote.commands && typeof ctx.remote.commands.execute === "function") {
          remoteCommands = ctx.remote.commands
        } else if (ctx && typeof ctx.get === "function") {
          const got = ctx.get("remote.commands")
          if (got && typeof got.execute === "function") {
            remoteCommands = got
          }
        }
      } catch {
        remoteCommands = null
      }

      if (!remoteCommands) {
        return {
          ok: false,
          error: "宿主环境未提供 remote.commands.execute 接口",
          backupCommand: commandString,
        }
      }

      try {
        const res = await remoteCommands.execute(sessionId, commandString, [])
        if (!res || res.ok !== true) {
          const errText = (res && res.error && res.error.message) || "命令执行请求被拒绝"
          return {
            ok: false,
            error: errText,
            backupCommand: commandString,
          }
        }
        const resultObj = res.value && res.value.result
        if (!resultObj) {
          return {
            ok: false,
            error: "未知的命令返回格式",
            backupCommand: commandString,
          }
        }
        if (resultObj.kind !== "success") {
          return {
            ok: false,
            error: resultObj.text || "命令执行未成功",
            backupCommand: commandString,
          }
        }
        return {
          ok: true,
          text: resultObj.text || "",
          data: resultObj.data || null,
        }
      } catch (err) {
        return {
          ok: false,
          error: (err && err.message) || String(err),
          backupCommand: commandString,
        }
      }
    }

    function triggerImmediatePoll(sessionId, ctx) {
      if (!sessionId) return
      const pool = pools.get(sessionId)
      if (pool && pool.running) {
        if (pool.timer) clearTimeout(pool.timer)
        tick(pool, ctx)
      }
    }

    function getReviewAccessStatus(snapshot) {
      const gate = (snapshot && snapshot.gate) || {}
      const unsafe = (snapshot && snapshot.unsafePermit) || {}
      const reviewAccess = (snapshot && snapshot.reviewAccess) || {}

      const now = Date.now()
      const gateOpen = Boolean(gate.open)
      const unsafeGranted = Boolean(unsafe.granted)

      const allowed = typeof reviewAccess.allowed === "boolean"
        ? reviewAccess.allowed
        : Boolean(gateOpen && unsafeGranted)

      // 实际有效可用次数：双门均须开启，取 min(gate, permit)
      let effectiveRemaining = null
      const gateRem = typeof gate.remaining === "number" ? gate.remaining : null
      const unsafeRem = typeof unsafe.remaining === "number" ? unsafe.remaining : null
      if (gateRem !== null && unsafeRem !== null) {
        effectiveRemaining = Math.min(gateRem, unsafeRem)
      } else if (unsafeRem !== null) {
        effectiveRemaining = unsafeRem
      } else if (gateRem !== null) {
        effectiveRemaining = gateRem
      }

      // 最近到期时间与剩余分钟
      let nearestExpiresAt = null
      const gateExp = typeof gate.expiresAt === "number" && gate.expiresAt > 0 ? gate.expiresAt : null
      const unsafeExp = typeof unsafe.expiresAt === "number" && unsafe.expiresAt > 0 ? unsafe.expiresAt : null
      if (gateExp !== null && unsafeExp !== null) {
        nearestExpiresAt = Math.min(gateExp, unsafeExp)
      } else if (unsafeExp !== null) {
        nearestExpiresAt = unsafeExp
      } else if (gateExp !== null) {
        nearestExpiresAt = gateExp
      }
      let remainingMinutes = null
      if (nearestExpiresAt && nearestExpiresAt > now) {
        remainingMinutes = Math.max(1, Math.round((nearestExpiresAt - now) / 60000))
      }

      // 仅在明确曾经有过有效期且已过时才算 expired；明确有过配额且用尽时才算 exhausted
      const hasEverOpened = Boolean((gate.expiresAt && gate.expiresAt > 0) || (unsafe.expiresAt && unsafe.expiresAt > 0))
      const isGateExpired = typeof gate.expiresAt === "number" && gate.expiresAt > 0 && gate.expiresAt <= now
      const isUnsafeExpired = typeof unsafe.expiresAt === "number" && unsafe.expiresAt > 0 && unsafe.expiresAt <= now
      const isExpired = Boolean(!allowed && (isGateExpired || isUnsafeExpired))

      const isGateExhausted = Boolean(hasEverOpened && typeof gate.remaining === "number" && gate.remaining <= 0)
      const isUnsafeExhausted = Boolean(hasEverOpened && typeof unsafe.remaining === "number" && unsafe.remaining <= 0)
      const isExhausted = Boolean(!allowed && (isGateExhausted || isUnsafeExhausted))

      let state = "unauthorized"
      if (allowed) {
        state = "allowed"
      } else if (isExpired) {
        state = "expired"
      } else if (isExhausted) {
        state = "exhausted"
      }

      return {
        state,
        allowed,
        isExpired,
        isExhausted,
        effectiveRemaining,
        nearestExpiresAt,
        remainingMinutes,
        gate,
        unsafe,
        reviewAccess,
      }
    }

    const pools = new Map()
    const draftsBySession = new Map()
    const reportCache = new Map()
    const pendingSends = new Set()

    function poolFor(sessionId) {
      let pool = pools.get(sessionId)
      if (!pool) {
        pool = {
          sessionId,
          snapshot: emptySnapshot(sessionId, 'waiting'),
          listeners: new Set(),
          timer: null,
          running: false,
          seq: 0,
        }
        pools.set(sessionId, pool)
      }
      return pool
    }

    /**
     * 大象模式的“传输标记”。
     * 宿主只认草稿里的命令 token 才会把一次提交当成命令（plain 阶段的 `/egm xxx`
     * 只会被当成普通消息），所以模式要生效，草稿里必须有这个 chip。
     * 但 chip 是 contenteditable 里的节点，用户能删掉；因此它只负责“路由”，
     * 不负责“证明模式开着”——模式本身是按 sessionId 隔离的 React 状态，
     * 输入区最左那个不可编辑的大象由它渲染，只有关模式才消失。
     */
    const MODE_TOKEN = '/egm '
    const MODE_TOKEN_LEN = MODE_TOKEN.length

    /** 读宿主草稿快照（shell.draftSnapshot 是宿主给插件读草稿的正式出口）。 */
    function readDraftSnapshot(shell) {
      if (!shell) return null
      let value
      try {
        value = shell.draftSnapshot
      } catch {
        return null
      }
      if (!value || typeof value !== 'object' || typeof value.text !== 'string') return null
      // 附件也读出来：只有图片、没有文字时同样是“会被当普通消息发出去”的情况。
      // phase 是宿主提交机器的真实阶段（host-conv-client.js:5083-5092），
      // 只有它说 claimed 才证明这条真的会走命令，光有 chip 不够。
      let attachmentIds = []
      let phase
      try {
        const state =
          shell.state && typeof shell.state.getSnapshot === 'function' ? shell.state.getSnapshot() : null
        if (state && Array.isArray(state.attachmentIds)) attachmentIds = state.attachmentIds
        if (state && typeof state.phase === 'string') phase = state.phase
      } catch {
        attachmentIds = []
        phase = undefined
      }
      return {
        text: value.text,
        references: Array.isArray(value.references) ? value.references : [],
        command: value.command && typeof value.command.token === 'string' ? value.command : null,
        attachmentIds,
        phase,
      }
    }

    /** 读宿主提交阶段；读不到就返回 null（不猜）。 */
    function readPhase(shell) {
      if (!shell || !shell.state || typeof shell.state.getSnapshot !== 'function') return null
      try {
        const snapshot = shell.state.getSnapshot()
        return snapshot && typeof snapshot.phase === 'string' ? snapshot.phase : null
      } catch {
        return null
      }
    }

    /** 宿主 actions 面上的 setDraft；字符串与结构化草稿都走它。 */
    function draftSetter(shell) {
      if (shell && shell.actions && typeof shell.actions.setDraft === 'function') {
        return (value) => shell.actions.setDraft(value)
      }
      if (shell && typeof shell.setDraft === 'function') return (value) => shell.setDraft(value)
      return null
    }

    /**
     * 给草稿装上 /egm chip：文字与引用原样保留（引用整体后移 5），
     * 已有别的命令或用户正在打斜杠命令时一律不动，返回原因。
     */
    function modeDraft(snapshot) {
      if (!snapshot) return { reason: 'noDraft' }
      if (snapshot.command) return { reason: 'command' }
      const text = snapshot.text
      // 用户自己打了 /egm（或宿主刚写进 chip、命令还没恢复）：只在**原文本来就是
      // claim 形状**时接管，且一个字符都不改。
      // - "/egm 需求"：原样接管（引用偏移不动）。
      // - 只有 "/egm"：补一个尾空格（token 是 "/egm "），没有内容可丢。
      // - "/egm\n需求"、"/egm\t需求"：token 不是原文前缀，接管必然要改字，宁可不接管，
      //   交给宿主自己的斜杠命令裁决（argsAfter 认 base token + 空白），绝不丢原文。
      if (text === MODE_TOKEN.trimEnd()) {
        return {
          adopted: true,
          draft: {
            text: MODE_TOKEN,
            references: snapshot.references.map((ref) => Object.assign({}, ref)),
            command: { token: MODE_TOKEN },
          },
        }
      }
      if (text.startsWith(MODE_TOKEN)) {
        const afterToken = text.slice(MODE_TOKEN_LEN).trimStart()
        if (afterToken.startsWith('/')) {
          // 用户在 /egm 模式下输入了斜杠命令（如 /egm-unsafe 或 /egm-review-access），
          // 应该解开 /egm 包装，让原生斜杠命令生效，而不是被作为需求参数发送
          return {
            adopted: false,
            reason: 'slash',
            draft: {
              text: afterToken,
              references: snapshot.references.map((ref) =>
                Object.assign({}, ref, { offset: Math.max(0, ref.offset - MODE_TOKEN_LEN) }),
              ),
              command: null,
            },
          }
        }
        return {
          adopted: true,
          draft: {
            text,
            references: snapshot.references.map((ref) => Object.assign({}, ref)),
            command: { token: MODE_TOKEN },
          },
        }
      }
      if (text.trimStart().startsWith('/')) return { reason: 'slash' }
      const references = snapshot.references.map((ref) =>
        Object.assign({}, ref, { offset: ref.offset + MODE_TOKEN_LEN }),
      )
      return {
        draft: {
          text: MODE_TOKEN + snapshot.text,
          references,
          command: { token: MODE_TOKEN },
        },
      }
    }

    /**
     * 关闭模式时交回宿主的草稿：默认连 /egm 前缀一起摘掉，引用整体前移 5。
     * keepToken 为真时只摘 chip、保留原文——用户自己写的 /egm 不能替人删掉。
     */
    function plainDraft(snapshot, options) {
      const text = snapshot && typeof snapshot.text === 'string' ? snapshot.text : ''
      const references = snapshot && Array.isArray(snapshot.references) ? snapshot.references : []
      const keepToken = Boolean(options && options.keepToken)
      if (keepToken || !text.startsWith(MODE_TOKEN)) {
        return { text, references: references.map((ref) => Object.assign({}, ref)) }
      }
      return {
        text: text.slice(MODE_TOKEN_LEN),
        references: references.map((ref) =>
          Object.assign({}, ref, { offset: Math.max(0, ref.offset - MODE_TOKEN_LEN) }),
        ),
      }
    }

    /**
     * 模式开着、但这一拍发出去不会走 /egm 时，宿主的原生发送（Enter 或发送键）会把
     * 草稿当成普通消息，用户在“EGM 模式”里会以为走了 EGM，必须拦下。
     * 放行的情况：已有命令（/egm 或用户自己的命令）走宿主命令路径；斜杠草稿由宿主
     * 自己裁决；空草稿本来也发不出去。
     */
    /** 宿主提交机器的真实状态（host-conv-client.js:5083-5092 的 state getter）。 */
    function readComposerState(shell) {
      if (!shell || !shell.state || typeof shell.state.getSnapshot !== 'function') return null
      let state
      try {
        state = shell.state.getSnapshot()
      } catch {
        return null
      }
      if (!state || typeof state !== 'object') return null
      return state
    }

    /**
     * 这一条发出去会不会绕过 /egm？只有**能证明**会走 /egm 才放行，其余一律拦。
     * 依据是宿主提交机器（host-conv-client.js:5168-5210）：只有 `phase==="claimed"`
     * 且带 claim 才走 begin-submit；没 claim 的斜杠走 adjudicate，裁决不上就
     * `phase="plain"` + detached 当普通消息发出去。所以判定必须读 state 里的
     * phase 与 claim（name + token），而不是只看编辑器里那个 chip 投影。
     * 读不到状态就保守拦下：拦下来只是不发，不会发错。
     */
    function modeBlocksSend(mode, shell) {
      if (!mode) return false
      const state = readComposerState(shell)
      if (!state) return true
      // 形状不符也按“证明不了”处理：缺 draft / attachmentIds 时若默认成空，
      // 纯图片草稿会被当成“没东西可发”而放行。
      if (typeof state.draft !== 'string') return true
      if (!Array.isArray(state.attachmentIds)) return true
      const draft = state.draft
      const attachments = state.attachmentIds
      // 没东西可发就不用管（空输入框按 Enter 宿主自己也不会发）。
      if (draft.trim() === '' && attachments.length === 0) return false
      const phase = state.phase
      const claim = state.claim && typeof state.claim === 'object' ? state.claim : null
      if (!claim) return true
      if (phase !== 'claimed' && phase !== 'submitting') return true
      const EGM_ALLOWED_COMMAND_NAMES = new Set([
        'egm',
        'egm-unsafe',
        'egm-review-access',
        'egm-safe',
        'egm-open',
        'egm-gate',
      ])
      const name = typeof claim.name === 'string' ? claim.name : ''
      const token = typeof claim.token === 'string' ? claim.token : ''
      if (!EGM_ALLOWED_COMMAND_NAMES.has(name)) return true
      return !draft.startsWith(token)
    }

    /**
     * 会话级提交闸门。宿主把 `inputHub.shell(sessionId)` 直接当成键盘面
     * （host-conv-client.js:20137-20141 `keyboard: shell`），而 Enter、原生发送键
     * 的点击、以及公开的 `actions.submit` 最后都落到同一个对象的
     * `submit(mode, source)`（定义在 :15202，:14964-14966 的 actions.submit 只是
     * 转调 `this.submit("queue")`）。所以在**这一个对象**上包一层，就同时盖住了
     * 三条发送路径；停止键（`stop` prop）根本不走 submit，绝不会被误伤。
     *
     * 代价：这是宿主内部对象，不是对外契约（源码注释原话是 package-internal）。
     * 因此这层闸门只做保守的事——只挡“证明不了会走 /egm”的那一条，任何异常都
     * 原样放行；卸载时只有顶层仍是我们这层才还原，被别的插件盖在上面时只把自己
     * 这层置为直通，不拆别人的链。
     */
    const submitGates = new Map()

    function installSubmitGate(sessionId, shell, decide) {
      if (!shell || typeof shell.submit !== 'function') return null
      const existing = submitGates.get(sessionId)
      if (existing && existing.shell === shell) return existing
      if (existing) releaseSubmitGate(sessionId)
      const previous = shell.submit
      const record = { sessionId, shell, previous, decide, live: true, gate: null }
      record.gate = function gateSubmit(mode, source) {
        const self = this === undefined ? shell : this
        if (!record.live) return previous.apply(self, arguments)
        // fail closed：判定逻辑自己出错时按“拦下”处理，绝不因为我们的 bug 把消息放出去。
        let block = true
        try {
          block = record.decide(mode, source) === true
        } catch {
          block = true
          try {
            if (typeof shell.notify === 'function') shell.notify('error', COPY.modeGateError)
          } catch {
            /* 提示失败也要拦 */
          }
        }
        if (block) return undefined
        return previous.apply(self, arguments)
      }
      try {
        shell.submit = record.gate
      } catch {
        return null
      }
      // 读回来确认真的写进去了（只读属性/被代理拦截时赋值会静默失败）。
      if (shell.submit !== record.gate) return null
      submitGates.set(sessionId, record)
      return record
    }

    function releaseSubmitGate(sessionId) {
      const record = submitGates.get(sessionId)
      if (!record) return
      submitGates.delete(sessionId)
      record.live = false
      try {
        if (record.shell.submit === record.gate) record.shell.submit = record.previous
      } catch {
        /* 还原不了也不影响：这一层已经直通 */
      }
    }

    // 只解析入口所属的输入区，绝不借用页面上另一个会话的卡片。
    function composerSeatOf(node) {
      if (!node || typeof node.closest !== 'function') return null
      return node.closest('[data-composer-seat]') || node.closest('[data-conversation-region="composer"]') || null
    }

    function resolveComposerCard(root) {
      if (!root || root.isConnected === false || typeof root.closest !== 'function') return null
      const seat = composerSeatOf(root)
      const direct = root.closest('[data-composer-card]')
      if (direct && direct.isConnected !== false) {
        const owner = composerSeatOf(direct)
        if (!seat || owner === seat) return direct
      }
      if (!seat || typeof seat.querySelectorAll !== 'function') return null
      const cards = Array.from(seat.querySelectorAll('[data-composer-card]')).filter(
        (card) => card && card.isConnected !== false && composerSeatOf(card) === seat,
      )
      return cards.length === 1 ? cards[0] : null
    }

    function entryNoticeLabel(notice) {
      if (!notice) return null
      if (notice === COPY.noRoom) return COPY.noRoomShort
      if (notice === COPY.panelHidden || notice === COPY.noAnchor) return '定位失败'
      if (notice === COPY.noShell || notice === COPY.noComposer) return '输入未就绪'
      return '查看提示'
    }

    /** 输入法选词中：宿主会给编辑器打这个标记，这时改写草稿会吞掉未上屏的候选。 */
    function isComposingComposer(root) {
      const card = resolveComposerCard(root)
      if (!card || typeof card.querySelector !== 'function') return false
      try {
        return Boolean(card.querySelector('[data-composer-composing]'))
      } catch {
        return false
      }
    }

    function draftsFor(sessionId) {
      let drafts = draftsBySession.get(sessionId)
      if (!drafts) {
        drafts = { launch: '' }
        draftsBySession.set(sessionId, drafts)
      }
      return drafts
    }

    // ---- 启动方式记忆：localStorage 里记住「不再提示」的选择 -----------------
    // 存取都吞异常：隐私模式/被禁用时拿不到存储，就每次都询问，绝不为此报错。

    const LAUNCH_STORE_KEY = 'egm.launchMode'
    const LAUNCH_KINDS = new Set(['composer', 'card'])
    let launchPreferenceInMemory = null

    function launchStorage(storage) {
      if (storage !== undefined) return storage
      if (typeof window === 'undefined' || !window) return null
      try {
        return window.localStorage || null
      } catch {
        return null
      }
    }

    function readLaunchPreference(storage) {
      const store = launchStorage(storage)
      if (!store || typeof store.getItem !== 'function') return launchPreferenceInMemory
      try {
        const value = store.getItem(LAUNCH_STORE_KEY)
        return LAUNCH_KINDS.has(value) ? value : launchPreferenceInMemory
      } catch {
        return launchPreferenceInMemory
      }
    }

    function writeLaunchPreference(value, storage) {
      if (!LAUNCH_KINDS.has(value)) return false
      launchPreferenceInMemory = value
      const store = launchStorage(storage)
      if (!store || typeof store.setItem !== 'function') return false
      try {
        store.setItem(LAUNCH_STORE_KEY, value)
        return true
      } catch {
        return false
      }
    }

    // ---- 工作内容记忆：这次跑哪种 EGM 流程（`--workflow`），存取同样吞异常 ----
    // 子命令与后端 lib/workflow-catalog.js 的 WORKFLOWS 一一对应；前端不能跨模块 import，
    // 所以这里是一份只读镜像，遇到未知 id 一律回落到 gate，绝不因为存储里是脏值就发不出命令。

    const WORKFLOW_STORE_KEY = 'egm.workflow'
    const WORKFLOW_OPTIONS = Object.freeze([
      { id: 'gate', label: '完整设计评审与实现', hint: '默认：写图纸 → 金鱼评审 → 大象核实 → 改图纸 → 补审 → 实现' },
      { id: 'brainstorm', label: '脑暴', hint: '只出概念与方案备选，不进入实现' },
      { id: 'draft', label: '逐节起草', hint: '按章节逐段把图纸写出来' },
      { id: 'custom', label: '自定义评审', hint: '用项目里注册的自定义角色与标准评审' },
      { id: 'resolve', label: '处理现有意见', hint: '把已有评审意见逐条落改并复核' },
      { id: 'bootstrap', label: '仓库文档整理', hint: '为已有代码补出仓库级文档，和评审金鱼分开跑' },
      { id: 'drift', label: '文档与代码差异检查', hint: '对照图纸与现有代码，输出偏向说明，不等于实现验收' },
    ])
    /** 根据草稿文字推荐工作流：只做推荐，不自动选中。 */
    function recommendWorkflow(text) {
      const t = String(text || '')
      if (/脑暴|发散|想法|概念|方案|头脑风暴/.test(t)) return 'brainstorm'
      if (/起草|写文档|逐节|逐段|章节/.test(t)) return 'draft'
      if (/意见|处理|核实|落改|整改|复核/.test(t)) return 'resolve'
      if (/文档整理|仓库文档|补文档|代码文档/.test(t)) return 'bootstrap'
      if (/差异|漂移|偏离|对照.*代码/.test(t)) return 'drift'
      if (/自定义|角色|标准|配置.*评审/.test(t)) return 'custom'
      return 'gate'
    }
    let workflowPreferenceInMemory = null

    function isWorkflowId(value) {
      return WORKFLOW_OPTIONS.some((item) => item.id === value)
    }

    function readWorkflowPreference(storage) {
      const store = launchStorage(storage)
      if (!store || typeof store.getItem !== 'function') return workflowPreferenceInMemory
      try {
        const value = store.getItem(WORKFLOW_STORE_KEY)
        return isWorkflowId(value) ? value : workflowPreferenceInMemory
      } catch {
        return workflowPreferenceInMemory
      }
    }

    function writeWorkflowPreference(value, storage) {
      if (!isWorkflowId(value)) return false
      workflowPreferenceInMemory = value
      const store = launchStorage(storage)
      if (!store || typeof store.setItem !== 'function') return false
      try {
        store.setItem(WORKFLOW_STORE_KEY, value)
        return true
      } catch {
        return false
      }
    }

    // 大象标记的落点：贴输入卡左缘、垂直对齐编辑器中线；空间不够就收进卡内并夹紧。
    function chooseMarkPlacement(cardRect, inputRect, viewport) {
      if (!cardRect || !(cardRect.width > 0) || !(cardRect.height > 0)) return null
      const markSize = 18
      const viewWidth = viewport && finite(viewport.width) ? viewport.width : Infinity
      const viewHeight = viewport && finite(viewport.height) ? viewport.height : Infinity
      let left = cardRect.left - markSize / 2
      if (left < 4) left = 4
      let top
      if (inputRect && inputRect.height > 0) {
        top = inputRect.top + inputRect.height / 2 - markSize / 2
      } else {
        top = cardRect.top + 6
      }
      const minTop = cardRect.top + 4
      const maxTop = Math.max(minTop, cardRect.top + cardRect.height - markSize - 4)
      top = Math.min(Math.max(top, minTop), maxTop)
      top = Math.min(Math.max(top, 4), Math.max(4, viewHeight - markSize - 4))
      if (left > viewWidth - markSize - 4) left = Math.max(4, viewWidth - markSize - 4)
      return { left: Math.round(left), top: Math.round(top) }
    }

    function publish(pool, next) {
      pool.snapshot = next
      for (const listener of pool.listeners) {
        try {
          listener(next)
        } catch {
          // 某个组件渲染失败不应该拖垮轮询。
        }
      }
    }

    async function tick(pool, ctx) {
      const seq = ++pool.seq
      try {
        const reply = await ctx.connection.rpc.call(CHANNEL, STATE_METHOD, {
          sessionId: pool.sessionId,
          wantEvidence: true,
        })
        if (!pool.running || seq !== pool.seq) return
        if (!reply || reply.ok !== true) throw new Error(rpcError(reply))
        const next = normalizeState(reply.value, pool.sessionId)
        next.signature = signatureOf(next)
        const prev = pool.snapshot
        if (prev.status !== 'live' || prev.signature !== next.signature) {
          publish(pool, next)
        } else {
          // 只刷新接收时间，不触发无意义的重渲染。
          pool.snapshot = Object.assign({}, prev, { receivedAt: next.receivedAt })
        }
      } catch (error) {
        if (!pool.running || seq !== pool.seq) return
        const prev = pool.snapshot
        const status = prev.status === 'live' || prev.status === 'stale' ? 'stale' : 'error'
        const message = errorText(error)
        if (prev.status !== status || prev.error !== message) {
          publish(pool, Object.assign({}, prev, { status, error: message }))
        }
      }
      if (pool.running) {
        const wait = pool.snapshot.status === 'live' ? POLL_MS : RETRY_MS
        pool.timer = setTimeout(() => tick(pool, ctx), wait)
      }
    }

    function startPolling(ctx, pool) {
      if (pool.running) return
      pool.running = true
      tick(pool, ctx)
    }

    function stopPolling(pool) {
      pool.running = false
      pool.seq += 1
      if (pool.timer) {
        clearTimeout(pool.timer)
        pool.timer = null
      }
    }

    function usePet(ctx, sessionId) {
      const [snapshot, setSnapshot] = React.useState(() =>
        sessionId ? poolFor(sessionId).snapshot : emptySnapshot(null, 'waiting'),
      )
      React.useEffect(() => {
        ensureStyle()
        if (!sessionId) {
          setSnapshot(emptySnapshot(null, 'waiting'))
          return undefined
        }
        const pool = poolFor(sessionId)
        setSnapshot(pool.snapshot)
        const listener = (next) => setSnapshot(next)
        pool.listeners.add(listener)
        startPolling(ctx, pool)
        return () => {
          pool.listeners.delete(listener)
          if (pool.listeners.size === 0) stopPolling(pool)
        }
      }, [sessionId])
      return snapshot
    }

    /**
     * 快捷发送的安全壳。顺序与 @changfenhuang/dsh-genui 的 action-transport 一致：
     * 已有草稿就拒绝；setDraft 后确认输入框真的接收；submit 后再确认输入框被清空。
     * 任何一步失败都不重试、不清卡片草稿、不覆盖原聊天草稿。
     */
    function resolveConversation(ctx, sessionId) {
      if (!ctx) return null
      if (typeof ctx.get === 'function') {
        try {
          const root = ctx.get('conversation')
          if (root && root.input && typeof root.input.shell === 'function') return root
        } catch {
          // 继续尝试 scoped 路径。
        }
      }
      if (typeof ctx.get === 'function') {
        try {
          const sessions = ctx.get('sessions')
          if (sessions && typeof sessions.scope === 'function') {
            const scoped = sessions.scope(sessionId)
            if (scoped && typeof scoped.get === 'function') {
              const conversation = scoped.get('conversation')
              if (conversation && conversation.input && typeof conversation.input.shell === 'function') {
                return conversation
              }
            }
          }
        } catch {
          // 两条路径都拿不到就明确报错。
        }
      }
      return null
    }

    /** 取这个会话的输入框壳；拿不到返回 null（调用方自己决定降级）。 */
    function composerShell(ctx, sessionId) {
      const conversation = resolveConversation(ctx, sessionId)
      if (!conversation) return null
      try {
        const shell = conversation.input.shell(sessionId)
        return shell && shell.state && typeof shell.state.getSnapshot === 'function' ? shell : null
      } catch {
        return null
      }
    }

    async function sendText(ctx, sessionId, text) {
      if (pendingSends.has(sessionId)) {
        const error = new Error(COPY.pending)
        error.code = 'EGM_SEND_PENDING'
        throw error
      }
      const conversation = resolveConversation(ctx, sessionId)
      if (!conversation) {
        const error = new Error(COPY.noComposer)
        error.code = 'EGM_NO_COMPOSER'
        throw error
      }
      let shell
      try {
        shell = conversation.input.shell(sessionId)
      } catch (error) {
        const wrapped = new Error(COPY.noShell + '（' + errorText(error) + '）')
        wrapped.code = 'EGM_NO_SHELL'
        throw wrapped
      }
      if (!shell || !shell.state || typeof shell.state.getSnapshot !== 'function') {
        const error = new Error(COPY.noComposer)
        error.code = 'EGM_NO_COMPOSER'
        throw error
      }
      const setDraft =
        shell.actions && typeof shell.actions.setDraft === 'function'
          ? (value) => shell.actions.setDraft(value)
          : typeof shell.setDraft === 'function'
            ? (value) => shell.setDraft(value)
            : null
      const submit =
        shell.actions && typeof shell.actions.submit === 'function'
          ? () => shell.actions.submit()
          : null
      if (!setDraft || !submit) {
        const error = new Error(COPY.noComposer)
        error.code = 'EGM_NO_COMPOSER'
        throw error
      }

      const readComposer = (afterSubmit) => {
        let snapshot
        try {
          snapshot = shell.state.getSnapshot()
        } catch (error) {
          const wrapped = new Error(
            (afterSubmit ? COPY.submitUnreadable : COPY.draftUnreadable) +
              '（' + errorText(error) + '）',
          )
          wrapped.code = 'EGM_DRAFT_UNREADABLE'
          throw wrapped
        }
        if (!snapshot || typeof snapshot !== 'object' || typeof snapshot.draft !== 'string') {
          const error = new Error(afterSubmit ? COPY.submitUnreadable : COPY.draftUnreadable)
          error.code = 'EGM_DRAFT_UNREADABLE'
          throw error
        }
        return {
          draft: snapshot.draft,
          // 宿主一定有 attachmentIds；缺失或类型不对时视为“未知”，不能假装为空。
          attachmentIds: Array.isArray(snapshot.attachmentIds) ? snapshot.attachmentIds : null,
        }
      }

      const assertNoAttachments = (composer, appeared) => {
        if (composer.attachmentIds === null) {
          const error = new Error(COPY.attachmentUnknown)
          error.code = 'EGM_ATTACHMENT_UNKNOWN'
          throw error
        }
        if (composer.attachmentIds.length > 0) {
          const error = new Error(appeared ? COPY.attachmentAppeared : COPY.attachmentPresent)
          error.code = appeared ? 'EGM_ATTACHMENT_APPEARED' : 'EGM_ATTACHMENT_PRESENT'
          throw error
        }
      }

      const initial = readComposer(false)
      // 空白字符也是用户输入，不能 trim 后当作空草稿覆盖。
      if (initial.draft !== '') {
        const error = new Error(COPY.draftOccupied)
        error.code = 'EGM_DRAFT_OCCUPIED'
        throw error
      }
      assertNoAttachments(initial, false)

      pendingSends.add(sessionId)
      try {
        await setDraft(text)
        let acceptedByComposer = false
        for (let attempt = 0; attempt < 40; attempt += 1) {
          await delay(25)
          const current = readComposer(false)
          assertNoAttachments(current, true)
          if (current.draft === text) {
            acceptedByComposer = true
            break
          }
        }
        if (!acceptedByComposer) {
          const error = new Error('输入框没有接收这段文字（可能正被其他操作占用），未发送；卡片草稿还在。')
          error.code = 'EGM_DRAFT_NOT_ACCEPTED'
          throw error
        }
        const beforeSubmit = readComposer(false)
        assertNoAttachments(beforeSubmit, true)
        if (beforeSubmit.draft !== text) {
          const error = new Error('输入框内容在提交前被改动，已停止发送；卡片草稿还在。')
          error.code = 'EGM_DRAFT_CHANGED'
          throw error
        }
        const result = await submit()
        if (result === false) {
          const error = new Error(COPY.submitRejected)
          error.code = 'EGM_SUBMIT_REJECTED'
          throw error
        }
        // 只有输入框被清空才算“交给输入框”；用户改成别的文字不等于发出。
        let consumed = false
        for (let attempt = 0; attempt < 40; attempt += 1) {
          await delay(25)
          const after = readComposer(true).draft
          if (after === '') {
            consumed = true
            break
          }
          if (after !== text) break
        }
        if (!consumed) {
          const error = new Error(COPY.launchUncertain)
          error.code = 'EGM_SEND_UNCERTAIN'
          throw error
        }
        return { ok: true }
      } finally {
        pendingSends.delete(sessionId)
      }
    }

    // ---- 几何：浮动元素不参与宿主排版，位置全部按实测矩形算 -----------------

    function normalizeRect(rect) {
      if (!rect || typeof rect !== 'object') return null
      const left = finite(rect.left)
      const top = finite(rect.top)
      const width = finite(rect.width)
      const height = finite(rect.height)
      const right = finite(rect.right) !== null ? rect.right : left !== null && width !== null ? left + width : null
      const bottom = finite(rect.bottom) !== null ? rect.bottom : top !== null && height !== null ? top + height : null
      if (left === null || top === null || right === null || bottom === null) return null
      return { left, top, right, bottom, width: right - left, height: bottom - top }
    }

    function viewportSize() {
      if (typeof window === 'undefined' || !window) return { width: 1024, height: 768 }
      const width = finite(window.innerWidth) || 1024
      const height = finite(window.innerHeight) || 768
      return { width, height }
    }

    function clamp(value, min, max) {
      if (max < min) return min
      return Math.min(Math.max(value, min), max)
    }

    /** 把障碍矩形拆成一条水平带上的空闲区间，用来把入口塞进不挡按钮的空处。 */
    function freeIntervals(obstacles, bandTop, bandBottom, from, to) {
      const blocked = []
      for (const rect of Array.isArray(obstacles) ? obstacles : []) {
        if (!rect) continue
        if (!(rect.bottom > bandTop && rect.top < bandBottom)) continue
        const start = Math.max(from, rect.left)
        const end = Math.min(to, rect.right)
        if (end > start) blocked.push([start, end])
      }
      blocked.sort((a, b) => a[0] - b[0])
      const merged = []
      for (const span of blocked) {
        const last = merged[merged.length - 1]
        if (last && span[0] <= last[1] + 1) last[1] = Math.max(last[1], span[1])
        else merged.push([span[0], span[1]])
      }
      const free = []
      let cursor = from
      for (const span of merged) {
        if (span[0] > cursor) free.push([cursor, span[0]])
        cursor = Math.max(cursor, span[1])
      }
      if (cursor < to) free.push([cursor, to])
      return free
    }

    /**
     * 把可点元素按纵向中心聚成“行”。输入卡片会换行，窄屏下按钮可能分成两排，
     * 入口必须落在真正空着的那一排，而不是拍脑袋取卡片底边。
     */
    function groupObstacleLines(obstacles) {
      const rects = (Array.isArray(obstacles) ? obstacles : []).filter(Boolean)
      const sorted = rects.slice().sort((a, b) => a.top + a.bottom - (b.top + b.bottom))
      const lines = []
      for (const rect of sorted) {
        const center = (rect.top + rect.bottom) / 2
        const last = lines[lines.length - 1]
        if (last && Math.abs(center - last.center) <= 10) {
          last.rects.push(rect)
          last.top = Math.min(last.top, rect.top)
          last.bottom = Math.max(last.bottom, rect.bottom)
          last.center = (last.top + last.bottom) / 2
        } else {
          lines.push({ center, top: rect.top, bottom: rect.bottom, rects: [rect] })
        }
      }
      return lines
    }

    /**
     * 入口放哪：优先塞进输入框控制行里最宽的空档（不挡任何按钮），
     * 挤不下就退到卡片上方右侧。任何情况都夹在视口内。
     */
    /**
     * subtree 观察器必须过滤掉自己：不然一次重渲染也会被当成“外部变化”，
     * 重测 → 再渲染 → 再触发，直接高频自激。只认 root 之外的节点增删。
     */
    function mutationTouchesComposer(record, root) {
      if (!record) return false
      const insideRoot = (node) =>
        Boolean(node && root && typeof root.contains === 'function' && root.contains(node))
      if (insideRoot(record.target)) return false
      const nodes = []
      if (record.addedNodes && typeof record.addedNodes.length === 'number') {
        for (let i = 0; i < record.addedNodes.length; i += 1) nodes.push(record.addedNodes[i])
      }
      if (record.removedNodes && typeof record.removedNodes.length === 'number') {
        for (let i = 0; i < record.removedNodes.length; i += 1) nodes.push(record.removedNodes[i])
      }
      // 纯文字/属性类的记录（没有节点增删）在别人的区域里也要重测；
      // 自己区域里的同类变化直接忽略。
      if (nodes.length === 0) return true
      return nodes.some((node) => node && node.nodeType === 1 && !insideRoot(node))
    }

    function choosePillPlacement(input) {
      const card = normalizeRect(input && input.card)
      const size = input && input.size && finite(input.size.width) && finite(input.size.height)
        ? input.size
        : null
      const viewport = (input && input.viewport) || viewportSize()
      const obstacles = (input && input.obstacles) || []
      const margin = 6
      if (!card || !size || size.width <= 0 || size.height <= 0) return null
      const from = card.left + margin
      const to = card.right - margin
      const clampPoint = (left, top, placement) => ({
        placement,
        left: clamp(left, margin, viewport.width - size.width - margin),
        top: clamp(top, margin, viewport.height - size.height - margin),
      })

      const lines = groupObstacleLines(obstacles)
      const candidates = []
      for (const line of lines) {
        // 按入口自己的实际高度取整段足迹，不能只看这一行：跨行高 textarea 会
        // 盖住“按钮行居中后”上下溢出的部分，必须拿全部障碍物一起算空档。
        const top = clamp(
          line.top + (line.bottom - line.top - size.height) / 2,
          card.top + 2,
          Math.max(card.top + 2, card.bottom - size.height - 2),
        )
        if (top + size.height > card.bottom - 1) continue
        const free = freeIntervals(obstacles, top - 1, top + size.height + 1, from, to)
        const widest = free.sort((a, b) => b[1] - b[0] - (a[1] - a[0]))[0]
        if (widest && widest[1] - widest[0] >= size.width + 8) {
          candidates.push({ line, span: widest, top })
        }
      }
      if (candidates.length > 0) {
        candidates.sort(
          (a, b) =>
            b.span[1] - b.span[0] - (a.span[1] - a.span[0]) || b.line.bottom - a.line.bottom,
        )
        const { span, top } = candidates[0]
        const center = (span[0] + span[1]) / 2
        return clampPoint(center - size.width / 2, top, 'row')
      }
      // 控制行塞不下就返回 null：调用方先缩小入口，最后才退到卡片内部的底部条，
      // 绝不跑到卡片上方去压进度/提示卡。
      return null
    }

    /**
     * 最后一级退让：放进卡片自己的底部条（上下文占用那一条，非交互），
     * 仍在卡片内部，不会压到卡片上方的进度卡或输入文字。
     */
    function chooseDockPlacement(input) {
      const card = normalizeRect(input && input.card)
      const size = input && input.size && finite(input.size.width) && finite(input.size.height)
        ? input.size
        : null
      const viewport = (input && input.viewport) || viewportSize()
      const obstacles = (input && input.obstacles) || []
      const margin = 6
      if (!card || !size || size.width <= 0 || size.height <= 0) return null
      const from = card.left + margin
      const to = card.right - margin
      const top = card.bottom - size.height - 6
      const free = freeIntervals(obstacles, top - 2, card.bottom - 2, from, to)
      const widest = free.sort((a, b) => b[1] - b[0] - (a[1] - a[0]))[0]
      // 没有真正空出来的地方就返回 null：宁可暂时不显示，也不压在控件上。
      if (!widest || widest[1] - widest[0] < size.width + 4) return null
      const center = (widest[0] + widest[1]) / 2
      return {
        placement: 'dock',
        left: clamp(center - size.width / 2, margin, viewport.width - size.width - margin),
        top: clamp(top, margin, viewport.height - size.height - margin),
      }
    }

    // The theme's anchored popover placement, with an optional progress-dock boundary.
    // Adapted from Nwflower's mascot-player.ts, MIT; see claude-mascot-license.txt.
    // Follow the current whale's stand instead of measuring another set of coordinates.
    function findMascotStand(root) {
      if (!root || root.isConnected === false) return null
      const seat = composerSeatOf(root)
      const scope = seat || (typeof document !== 'undefined' ? document : null)
      if (!scope || typeof scope.querySelectorAll !== 'function') return null
      let whales
      try {
        whales = Array.from(scope.querySelectorAll('.dsh-claude-deepy, .dsh-claude-crab')).filter((node) => {
          const rect = readRect(node)
          return node.isConnected !== false && node.hidden !== true && rect && rect.width > 0 && rect.height > 0 &&
            (!seat || composerSeatOf(node) === seat)
        })
      } catch {
        return null
      }
      const stands = Array.from(new Set(whales.map(node => node.parentElement).filter(Boolean)))
      if (stands.length === 1) return stands[0]
      // Without a theme mascot, use this composer's measured card as a fixed fallback.
      return null
    }

    // Adapted from dsh-claude-style/shared/popover.ts at a0059bde45f968b246bf05c9bb6b87a4a592189b.
    // Nwflower, MIT; full attribution in claude-mascot-license.txt.
    function topOverTrigger(rect, height, gap, margin, viewportHeight) {
      const above = rect.top - gap - height
      if (above >= margin) return above
      const below = rect.bottom + gap
      if (below + height <= viewportHeight - margin) return below
      const roomAbove = rect.top - gap - margin
      const roomBelow = viewportHeight - margin - below
      return roomAbove >= roomBelow ? margin : Math.max(margin, viewportHeight - height - margin)
    }

    function resolveAnchoredPosition(rect, width, height, opts) {
      const margin = opts.margin || 8
      const viewport = opts.viewport
      const y = topOverTrigger(rect, height, opts.gap || 0, margin, viewport.height)
      return { x: Math.max(margin, Math.min(rect.left, viewport.width - width - margin)), y }
    }

    function clampToViewport(position, width, height, viewport, margin) {
      return {
        x: Math.max(margin, Math.min(position.x, viewport.width - width - margin)),
        y: Math.max(margin, Math.min(position.y, viewport.height - height - margin)),
      }
    }

    function composerStackOf(node) {
      if (!node || typeof node.closest !== 'function') return null
      const seat = (
        node.closest('[data-composer-seat]') ||
        node.closest('[data-conversation-region="composer"]') ||
        null
      )
      if (!seat) return null
      let curr = node
      while (curr && curr.parentElement && curr.parentElement !== seat && curr.parentElement !== document.body) {
        curr = curr.parentElement
      }
      if (curr && curr.parentElement === seat) {
        return curr
      }
      return seat
    }

    function findDockCeiling(card, stackNode, seatNode) {
      const container =
        stackNode ||
        seatNode ||
        (card && typeof card.closest === 'function'
          ? card.closest('[data-composer-seat]') || card.closest('[data-conversation-region="composer"]')
          : null) ||
        (card && card.parentElement)
      if (!container || typeof container.querySelector !== 'function') return null
      const outlet =
        container.querySelector('[data-slot="conversation.input.dock"]') ||
        container.querySelector('[data-composer-dock]') ||
        container.querySelector('.conversation\\.input\\.dock') ||
        null
      if (!outlet) {
        const cardRect = readRect(card)
        return cardRect && cardRect.width > 0 && cardRect.height > 0 ? cardRect.top : null
      }
      let minTop = Infinity
      function inspect(el) {
        if (!el || el.hidden) return
        const rect = readRect(el)
        if (rect && rect.height > 0 && rect.width > 0) {
          minTop = Math.min(minTop, rect.top)
          return
        }
        if (el.children) {
          for (let i = 0; i < el.children.length; i++) {
            inspect(el.children[i])
          }
        }
      }
      if (outlet.children && outlet.children.length > 0) {
        for (let i = 0; i < outlet.children.length; i++) {
          inspect(outlet.children[i])
        }
      } else {
        inspect(outlet)
      }
      if (Number.isFinite(minTop)) return minTop
      const cardRect = readRect(card)
      return cardRect && cardRect.width > 0 && cardRect.height > 0 ? cardRect.top : null
    }

    function choosePanelGeometry(input) {
      const card = normalizeRect(input && input.card)
      const trigger = normalizeRect(input && input.trigger)
      const viewport = (input && input.viewport) || viewportSize()
      const width = Math.max(1, Math.min(PANEL_WIDTH, viewport.width - EDGE * 2))
      // Like the theme's popovers, the button is the anchor. The card is optional.
      const anchor = trigger && trigger.width > 0 && trigger.height > 0 ? trigger
        : card && card.width > 0 && card.height > 0 ? card : null
      if (!anchor) return { mode: 'hidden', width, maxHeight: 0, fixedLeft: EDGE, fixedTop: EDGE, note: COPY.panelHidden }
      const gap = EDGE
      // 主题的弹层只认按钮本身。宿主卡片/进度条在有的布局里会量成整列高度，
      // 一并并进锚点就会把弹层甩到屏幕顶端（看起来像“漂移”），所以锚点只用按钮。
      const rect = Object.assign({}, anchor)
      const roomAbove = Math.max(0, rect.top - gap - EDGE)
      const roomBelow = Math.max(0, viewport.height - rect.bottom - gap - EDGE)
      const height = Math.max(1, Math.min(PANEL_MAX, Math.max(roomAbove, roomBelow)))
      const position = clampToViewport(
        resolveAnchoredPosition(rect, width, height, { viewport, margin: EDGE, gap }),
        width, height, viewport, EDGE,
      )
      const above = position.y + height <= rect.top - gap + 1
      const mode = height < 140 ? 'minimal' : height < PANEL_MIN_ABOVE ? 'compact' : above ? 'above' : 'below'
      return {
        mode, width, maxHeight: height,
        fixedLeft: position.x, fixedTop: position.y,
        fixedBottom: viewport.height - position.y - height,
        offsetLeft: position.x - (card ? card.left : anchor.left),
        offsetTop: position.y - (card ? card.top : anchor.top),
        offsetBottom: (card ? card.top : anchor.top) - position.y - height,
        above,
        note: height < PANEL_MIN_ABOVE ? '空间较小，整张卡片可滚动' : null,
      }
    }

    function readRect(node) {
      if (!node || typeof node.getBoundingClientRect !== 'function') return null
      try {
        return normalizeRect(node.getBoundingClientRect())
      } catch {
        return null
      }
    }

    /** 卡片里所有可点的东西，用来给入口让位。自己的节点排除掉。 */
    function obstacleRects(card, self) {
      if (!card || typeof card.querySelectorAll !== 'function') return []
      let nodes
      try {
        nodes = card.querySelectorAll(
          'button, [role="button"], a[href], input, textarea, select, [contenteditable="true"]',
        )
      } catch {
        return []
      }
      const out = []
      for (const node of nodes) {
        if (self && self !== node && typeof self.contains === 'function' && self.contains(node)) continue
        const rect = readRect(node)
        if (rect) out.push(rect)
      }
      return out
    }

    // ---- 像素图标：沿用项目里已有的 32x28 像素资源 --------------------------

    function ElephantSvg(props) {
      return h(
        'svg',
        {
          viewBox: '0 0 32 28',
          'aria-hidden': 'true',
          focusable: 'false',
          shapeRendering: 'crispEdges',
        },
        h('rect', { x: 5, y: 13, width: 3, height: 2, fill: '#697584' }),
        h(
          'g',
          { className: 'egm-el-body' },
          h('rect', { x: 8, y: 10, width: 14, height: 10, fill: '#8d99a8' }),
          h('rect', { x: 9, y: 11, width: 3, height: 2, fill: '#aab5c2' }),
          h('rect', { x: 10, y: 19, width: 3, height: 5, fill: '#6f7b8a' }),
          h('rect', { x: 16, y: 19, width: 3, height: 5, fill: '#6f7b8a' }),
          h('rect', { x: 19, y: 8, width: 9, height: 11, fill: '#9aa7b6' }),
          h('rect', { x: 20, y: 9, width: 3, height: 3, fill: '#b7c2cf' }),
          h(
            'g',
            { className: 'egm-el-ear' },
            h('rect', { x: 21, y: 9, width: 5, height: 6, fill: '#7b8797' }),
            h('rect', { x: 22, y: 10, width: 3, height: 4, fill: '#b7c2cf' }),
          ),
          h('rect', { x: 24, y: 11, width: 2, height: 2, fill: '#151a20' }),
          h('rect', { x: 24, y: 11, width: 1, height: 1, fill: '#ffffff' }),
          h(
            'g',
            { className: 'egm-el-trunk' },
            h('rect', { x: 27, y: 15, width: 3, height: 3, fill: '#9aa7b6' }),
            h('rect', { x: 27, y: 18, width: 2, height: 4, fill: '#8d99a8' }),
            h('rect', { x: 25, y: 21, width: 4, height: 2, fill: '#9aa7b6' }),
          ),
          h('rect', { x: 26, y: 17, width: 2, height: 2, fill: '#f2e9d8' }),
          h('rect', { x: 14, y: 13, width: 4, height: 2, fill: '#aab5c2', opacity: '.65' }),
        ),
      )
    }

    // 大象真正在干活时用的场景图：桌面 + 图纸 + 埋头写字。
    // 和上面那张 32x28 像素图标是两套资源——像素图继续当模式标记/面板头像，
    // 这里这张只在 live + working + workingOnEgm 三个条件都成立时出现在工具栏上。
    // 颜色：大象身体用固定的五层灰（深色主题下仍是灰阶，保持“像素资源”的家族感）；
    // 桌面/图纸/墨线/钢笔/汗珠用 currentColor，跟着主题走，深浅都看得见。
    function ElephantWorkSvg() {
      return h(
        'svg',
        { viewBox: '0 0 32 24', 'aria-hidden': 'true', focusable: 'false' },
        // 桌面
        h('rect', { x: 1.5, y: 20, width: 29.5, height: 2.6, rx: 1.1, fill: 'currentColor', opacity: '.16' }),
        // 图纸
        h('rect', {
          x: 15.5, y: 10.5, width: 14.5, height: 10, rx: 1.2,
          fill: 'currentColor', fillOpacity: '.12',
          stroke: 'currentColor', strokeOpacity: '.22', strokeWidth: '.7',
        }),
        // 正在写上去的三行墨线
        h('rect', { className: 'egm-el-w-line', x: 18.2, y: 13.3, width: 9.6, height: 1.1, rx: '.55', fill: 'currentColor', opacity: '.7' }),
        h('rect', { className: 'egm-el-w-line egm-el-w-line2', x: 18.2, y: 15.9, width: 9.6, height: 1.1, rx: '.55', fill: 'currentColor', opacity: '.7' }),
        h('rect', { className: 'egm-el-w-line egm-el-w-line3', x: 18.2, y: 18.5, width: 9.6, height: 1.1, rx: '.55', fill: 'currentColor', opacity: '.7' }),
        // 身体、肚子高光、两条腿
        h('rect', { x: 1.5, y: 10.8, width: 11, height: 9.2, rx: 2.2, fill: '#8d99a8' }),
        h('rect', { x: 3, y: 12, width: 3.6, height: 2, rx: 1, fill: '#b7c2cf', opacity: '.85' }),
        h('rect', { x: 3.6, y: 18.8, width: 2.6, height: 2.6, rx: '.9', fill: '#6f7b8a' }),
        h('rect', { x: 8.6, y: 18.8, width: 2.6, height: 2.6, rx: '.9', fill: '#6f7b8a' }),
        h(
          'g',
          { className: 'egm-el-w-head' },
          h('rect', { x: 8.6, y: 6.2, width: 8.8, height: 8.8, rx: 2.4, fill: '#9aa7b6' }),
          h(
            'g',
            { className: 'egm-el-w-ear' },
            h('rect', { x: 10.6, y: 7.4, width: 4.8, height: 5.6, rx: 1.9, fill: '#7b8797' }),
            h('rect', { x: 11.6, y: 8.4, width: 2.8, height: 3.6, rx: 1.1, fill: '#b7c2cf' }),
          ),
          h('rect', { className: 'egm-el-w-eye', x: 14.8, y: 8.8, width: 1.7, height: 1.7, rx: '.5', fill: '#151a20' }),
          h(
            'g',
            { className: 'egm-el-w-trunk' },
            h('path', {
              d: 'M17.1 10.4 q2.7 .5 3 3.3 q.2 2.4 -1.3 3.5',
              fill: 'none', stroke: '#9aa7b6', strokeWidth: 2.2, strokeLinecap: 'round',
            }),
            // 鼻尖夹着的笔，笔尖落在图纸上
            h(
              'g',
              { className: 'egm-el-w-pen' },
              h('path', {
                d: 'M17.7 15.2 L20.5 18.3',
                fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round',
              }),
              h('circle', { cx: 20.8, cy: 18.7, r: '.85', fill: 'currentColor' }),
            ),
          ),
        ),
        // 头上的汗珠和两条“使劲”的短线
        h(
          'g',
          { className: 'egm-el-w-effort' },
          h('path', { d: 'M9.6 3.9 q1.1 -.9 2.2 -.3', fill: 'none', stroke: 'currentColor', strokeWidth: '.9', strokeLinecap: 'round', opacity: '.75' }),
          h('path', { d: 'M13.4 2.8 q1.2 .1 1.7 1.1', fill: 'none', stroke: 'currentColor', strokeWidth: '.9', strokeLinecap: 'round', opacity: '.75' }),
          h('circle', { cx: 16.9, cy: 5.2, r: '.95', fill: 'currentColor', opacity: '.5' }),
        ),
      )
    }

    function GoldfishSvg() {
      return h(
        'svg',
        {
          viewBox: '0 0 32 28',
          'aria-hidden': 'true',
          focusable: 'false',
          shapeRendering: 'crispEdges',
        },
        h(
          'g',
          { className: 'egm-gf-tail' },
          h('polygon', { points: '8,10 2,6 3,13 2,20 8,17', fill: '#cf7a44' }),
          h('rect', { x: 6, y: 11, width: 3, height: 4, fill: '#e8894a' }),
        ),
        h(
          'g',
          { className: 'egm-gf-body' },
          h('rect', { x: 8, y: 9, width: 12, height: 10, fill: '#e8894a' }),
          h('rect', { x: 9, y: 10, width: 10, height: 3, fill: '#f2a76e' }),
          h('rect', { x: 10, y: 19, width: 8, height: 2, fill: '#d4743c' }),
          h('polygon', { points: '13,9 16,4 19,9', fill: '#e8894a' }),
          h('polygon', { points: '13,19 16,24 19,19', fill: '#d4743c' }),
          h('rect', { x: 12, y: 14, width: 4, height: 2, fill: '#f6bf8f', opacity: '.72' }),
          h('rect', { x: 18, y: 11, width: 2, height: 2, fill: '#24140d' }),
          h('rect', { x: 19, y: 10, width: 1, height: 1, fill: '#ffffff' }),
          h('rect', { x: 22, y: 15, width: 2, height: 2, fill: '#8d3f22' }),
          h(
            'g',
            { className: 'egm-gf-mouth' },
            h('rect', { x: 21, y: 14, width: 2, height: 2, fill: '#d4743c' }),
          ),
        ),
        h(
          'g',
          { className: 'egm-gf-bubble' },
          h('rect', { x: 27, y: 8, width: 2, height: 2, fill: '#9ec7e8' }),
          h('rect', { x: 29, y: 5, width: 2, height: 2, fill: '#b9d8ef' }),
        ),
      )
    }

    // 金鱼真正在干活时用的场景图：桌子 + 一张待审的图纸 + 叼着放大镜啄问题标记。
    // 和上面那张 32x28 像素图标是两套资源——像素图继续当模式标记/面板头像，
    // 这里这张只在 live + 有鱼在跑（或派鱼信号刚发下去）时出现在工具栏上。
    // 颜色：鱼身沿用 GoldfishSvg 的橙色三层；桌面/图纸/放大镜/气泡/使劲线跟 currentColor 走。
    function GoldfishWorkSvg() {
      return h(
        'svg',
        { viewBox: '0 0 32 28', 'aria-hidden': 'true', focusable: 'false' },
        // 桌面
        h('rect', { x: 1.5, y: 23.2, width: 29.5, height: 2.6, rx: 1.1, fill: 'currentColor', opacity: '.16' }),
        // 被审的图纸
        h('rect', {
          x: 20.6, y: 10.4, width: 10.2, height: 12.6, rx: 1.2,
          fill: 'currentColor', fillOpacity: '.12',
          stroke: 'currentColor', strokeOpacity: '.22', strokeWidth: '.7',
        }),
        // 图纸上被啄出来的问题标记：红叉 + 绿勾，各自浮现
        h(
          'g',
          { className: 'egm-gf-w-mark' },
          h('path', { d: 'M23.8 12 L25.4 13.6', fill: 'none', stroke: '#d9534f', strokeWidth: 1, strokeLinecap: 'round' }),
          h('path', { d: 'M25.4 12 L23.8 13.6', fill: 'none', stroke: '#d9534f', strokeWidth: 1, strokeLinecap: 'round' }),
        ),
        h('path', {
          className: 'egm-gf-w-mark2',
          d: 'M26 19.2 L27 20.3 L28.6 17.7',
          fill: 'none', stroke: '#4ca978', strokeWidth: 1, strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
        // 尾巴：一块三角 + 一段连接块，绕尾柄摆
        h(
          'g',
          { className: 'egm-gf-w-tail' },
          h('polygon', { points: '8.2,13.8 2.2,9.6 3.4,16.4 2.2,23 8.2,19.2', fill: '#cf7a44' }),
          h('rect', { x: 6.4, y: 14.2, width: 2.8, height: 4.4, fill: '#e8894a' }),
        ),
        // 身体：鱼身 + 高光 + 下鳍，整体上下浮；鳍/眼睛/嘴挂在身上一起浮
        h(
          'g',
          { className: 'egm-gf-w-body' },
          h('rect', { x: 8.2, y: 11.6, width: 11.4, height: 9.6, rx: 2.2, fill: '#e8894a' }),
          h('rect', { x: 9.6, y: 12.8, width: 9.2, height: 2.4, rx: 1.2, fill: '#f2a76e', opacity: '.9' }),
          h('rect', { x: 10, y: 19, width: 8, height: 1.8, rx: '.9', fill: '#d4743c', opacity: '.85' }),
          h('polygon', { points: '12,20.8 14.6,24.4 17.2,20.8', fill: '#d4743c' }),
          // 上鳍：可动的三角形
          h('polygon', { className: 'egm-gf-w-fin', points: '11.4,11.8 14,7.4 16.6,11.8', fill: '#e8894a' }),
          // 眼睛
          h(
            'g',
            { className: 'egm-gf-w-eye' },
            h('rect', { x: 16.6, y: 14.4, width: 1.9, height: 1.9, rx: '.5', fill: '#24140d' }),
            h('rect', { x: 17.5, y: 14.4, width: '.8', height: '.8', fill: '#ffffff' }),
          ),
          // 嘴 + 叼着的放大镜，啄向图纸
          h(
            'g',
            { className: 'egm-gf-w-mouth' },
            h('path', { d: 'M19.6 17.4 L20.9 16.9', fill: 'none', stroke: 'currentColor', strokeWidth: 1.1, strokeLinecap: 'round' }),
            h('circle', { cx: 21.9, cy: 16.2, r: 1.9, fill: 'currentColor', fillOpacity: '.08', stroke: 'currentColor', strokeWidth: '.8' }),
            h('rect', { x: 19.1, y: 16.4, width: 1.7, height: 2, rx: '.5', fill: '#8d3f22' }),
          ),
        ),
        // 嘴里冒的两串气泡，一前一后往上飘
        h('circle', { className: 'egm-gf-w-bubble', cx: 20.4, cy: 12.6, r: '.85', fill: '#9ec7e8' }),
        h('circle', { className: 'egm-gf-w-bubble2', cx: 21.5, cy: 9.4, r: '.65', fill: '#b9d8ef' }),
        // 头上两条“使劲”的短线
        h(
          'g',
          { className: 'egm-gf-w-effort' },
          h('path', { d: 'M14.2 5.4 q1.2 -.9 2.3 -.3', fill: 'none', stroke: 'currentColor', strokeWidth: '.9', strokeLinecap: 'round', opacity: '.75' }),
          h('path', { d: 'M17.9 4.4 q1.2 .1 1.6 1.1', fill: 'none', stroke: 'currentColor', strokeWidth: '.9', strokeLinecap: 'round', opacity: '.75' }),
        ),
      )
    }

    /** 入口的像素闸门：两道门柱 + 门楣 + 中间一道缝，用 currentColor 跟主题走。 */
    function GateSvg() {
      return h(
        'svg',
        { viewBox: '0 0 16 14', 'aria-hidden': 'true', focusable: 'false', shapeRendering: 'crispEdges' },
        h('rect', { x: 1, y: 3, width: 3, height: 10, fill: 'currentColor', opacity: '.55' }),
        h('rect', { x: 12, y: 3, width: 3, height: 10, fill: 'currentColor', opacity: '.55' }),
        h('rect', { x: 2, y: 1, width: 12, height: 2, fill: 'currentColor' }),
        h('rect', { x: 6, y: 5, width: 1, height: 8, fill: 'currentColor', opacity: '.3' }),
        h('rect', { x: 9, y: 5, width: 1, height: 8, fill: 'currentColor', opacity: '.3' }),
        h('rect', { x: 6, y: 7, width: 4, height: 2, fill: 'currentColor' }),
      )
    }

    function CloseIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: '14', height: '14', 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          d: 'M3.5 3.5 L12.5 12.5 M12.5 3.5 L3.5 12.5',
          stroke: 'currentColor',
          strokeWidth: '1.6',
          strokeLinecap: 'round',
          fill: 'none',
        }),
      )
    }

    function PetVisual(props) {
      if (props.kind === 'elephant') return h(ElephantSvg)
      if (props.kind === 'goldfish') {
        return props.work ? h(GoldfishWorkSvg) : h(GoldfishSvg)
      }
      return h(GateSvg)
    }

    /** 后端 reason 是给机器看的，翻成一句人话；认不出来的原样显示，不编。 */
    function reasonText(reason) {
      if (!reason) return null
      if (reason === 'no-status-event') return '系统还没报告状态'
      if (reason === 'status-bridge-unavailable') return '这个版本读不到状态'
      if (reason === 'no-status-field') return '后端没给状态字段'
      return reason
    }

    function goldfishStatusLabel(status) {
      if (status === 'running') return '运行中'
      if (status === 'done') return '已完成'
      if (status === 'failed') return '失败'
      return '未知'
    }

    function goldfishStatusClass(status) {
      if (status === 'done') return 'egm-ok'
      if (status === 'failed') return 'egm-bad'
      if (status === 'running') return 'egm-warn'
      return 'egm-muted'
    }

    function ReportView(props) {
      const report = props.report
      const fish = props.fish
      if (!fish) return h('div', { className: 'egm-empty' }, '先选一条金鱼。')
      if (fish.status === 'running') {
        return h('div', { className: 'egm-muted' }, '这条金鱼还在跑；报告要等它结束。')
      }
      if (!fish.hasReport) {
        return h(
          'div',
          { className: 'egm-muted' },
          fish.status === 'failed' ? '这条金鱼失败了，也没有报告正文。' : COPY.noReport,
        )
      }
      if (!report || report.status === 'idle') {
        return h(
          'div',
          { className: 'egm-actions' },
          h(
            'button',
            { className: 'egm-btn', type: 'button', onClick: props.onLoad },
            COPY.readReport,
          ),
        )
      }
      if (report.status === 'loading') return h('div', { className: 'egm-muted' }, COPY.readingReport)
      if (report.status === 'error') {
        return h(
          'div',
          { className: 'egm-actions' },
          h('div', { className: 'egm-error', role: 'alert' }, report.error || '报告读取失败。'),
          h('button', { className: 'egm-btn', type: 'button', onClick: props.onLoad }, COPY.reloadReport),
        )
      }
      return h(
        'div',
        { className: 'egm-section' },
        h(
          'div',
          { className: 'egm-report-meta' },
          (report.data.reportPath || fish.reportPath || '报告') +
            ' · ' +
            formatBytes(report.data.totalBytes) +
            ' · ' +
            (report.data.source === 'disk'
              ? COPY.reportDisk
              : report.data.source === 'memory-fallback'
                ? COPY.reportFallback
                : COPY.reportSourceUnknown) +
            (report.data.truncated ? ' · 已截断' : ''),
        ),
        report.data.source === 'memory-fallback'
          ? h('div', { className: 'egm-warn' }, COPY.reportMemory)
          : null,
        report.data.truncated
          ? h('div', { className: 'egm-warn' }, COPY.reportTruncated(report.data.totalBytes))
          : null,
        report.data.content
          ? h('pre', { className: 'egm-report' }, report.data.content)
          : h('div', { className: 'egm-empty' }, COPY.reportEmpty),
        h(
          'div',
          { className: 'egm-actions' },
          h('button', { className: 'egm-btn', type: 'button', onClick: props.onLoad }, COPY.reloadReport),
        ),
      )
    }

    function freshReport(report, sessionId, fish) {
      if (!report || report.status !== 'ready') return report || { status: 'idle' }
      const data = report.data || {}
      if (data.sessionId !== sessionId) return { status: 'idle' }
      if (data.finishedAt !== fish.finishedAt) return { status: 'idle' }
      return report
    }

    function StateSection(props) {
      const snapshot = props.snapshot
      const elephant = snapshot.elephant || {}
      if (!snapshot || snapshot.status === 'waiting') {
        return h('div', { className: 'egm-muted' }, '正在读取当前会话的真实 EGM 状态…')
      }
      if (snapshot.status === 'error' || snapshot.status === 'mismatch') {
        return h('div', { className: 'egm-error', role: 'status' }, snapshot.error || '状态读取失败。')
      }
      return h(
        'div',
        { className: 'egm-section' },
        h(
          'div',
          { className: 'egm-section-head' },
          h('span', { className: 'egm-section-title' }, COPY.nowTitle),
          h('span', { className: 'egm-section-note' }, formatTime(snapshot.updatedAt)),
        ),
        snapshot.status === 'stale'
          ? h('div', { className: 'egm-warn' }, COPY.staleHint(snapshot.error || '未知错误'))
          : null,
        h(
          'div',
          { className: 'egm-kv' },
          h('span', { className: 'egm-k' }, COPY.progressRow),
          h('span', { className: 'egm-v' }, stateText(snapshot) + (snapshot.state === 'unknown' ? '（' + COPY.stateUnknownHint + '）' : '')),
          h('span', { className: 'egm-k' }, COPY.recordsRow),
          h('span', { className: 'egm-v' }, snapshot.count + ' 条'),
          h('span', { className: 'egm-k' }, COPY.elephantRow),
          h(
            'span',
            { className: 'egm-v' },
            elephant.known
              ? elephant.status === 'running'
                // 真在跑就说清在干什么：prep 阶段是“处理方案”，不是“在写图纸”。
                ? elephantBusy(snapshot)
                  ? COPY.busyTitle
                  : COPY.working
                : COPY.notWorking
              : '状态未知（' + COPY.elephantUnknownHint + '）',
          ),
          h('span', { className: 'egm-k' }, COPY.gateRow),
          h(
            'span',
            { className: 'egm-v ' + (snapshot.gate && snapshot.gate.known && snapshot.gate.open ? 'egm-ok' : 'egm-muted') },
            gateLabel(snapshot.gate),
          ),
          snapshot.gate && snapshot.gate.remaining !== null
            ? h('span', { className: 'egm-k' }, '剩余次数')
            : null,
          snapshot.gate && snapshot.gate.remaining !== null
            ? h('span', { className: 'egm-v' }, String(snapshot.gate.remaining))
            : null,
          snapshot.gate && snapshot.gate.expiresAt !== null
            ? h('span', { className: 'egm-k' }, '到期时间')
            : null,
          snapshot.gate && snapshot.gate.expiresAt !== null
            ? h('span', { className: 'egm-v' }, formatTime(snapshot.gate.expiresAt))
            : null,
        ),
      )
    }

    function PanelShell(props) {
      const geometry = props.geometry
      // The button anchors the popover; a measured composer dock refines its safe bounds.
      const anchored = geometry.above === true
      const left = geometry.fixedLeft !== undefined ? geometry.fixedLeft : geometry.offsetLeft
      const style = {
        position: 'fixed',
        left: left + 'px',
        width: geometry.width + 'px',
        maxHeight: geometry.maxHeight + 'px',
        zIndex: 10000,
      }
      if (anchored) {
        const bottom = geometry.fixedBottom !== undefined ? geometry.fixedBottom : geometry.offsetBottom
        style.bottom = bottom + 'px'
      } else {
        const top = geometry.fixedTop !== undefined ? geometry.fixedTop : geometry.offsetTop
        style.top = top + 'px'
      }
      return h(
        'div',
        {
          className: 'egm-panel',
          lang: 'zh-CN',
          style,
          role: 'dialog',
          'aria-modal': 'false',
          'aria-label': props.title,
          id: props.id,
          ref: props.panelRef,
          tabIndex: -1,
          'data-mode': geometry.mode,
          onKeyDown: props.onKeyDown,
        },
        h(
          'div',
          { className: 'egm-panel-head' },
          h('span', { className: 'egm-chip-icon' }, h(PetVisual, { kind: props.glyph })),
          h(
            'span',
            { className: 'egm-panel-title' },
            h('strong', null, props.title),
            h(
              'span',
              { className: 'egm-panel-sub', 'data-tone': props.tone || 'normal' },
              props.note || props.subtitle,
            ),
          ),
          h(
            'button',
            {
              className: 'egm-icon-btn',
              type: 'button',
              onClick: props.onClose,
              'aria-label': COPY.close,
              title: COPY.close,
            },
            h(CloseIcon),
            h('span', { className: 'egm-sr' }, COPY.closeShort),
          ),
        ),
        h('div', { className: 'egm-panel-body' }, props.children),
      )
    }

    function GuideSection() {
      return h(
        "div",
        { className: "egm-section" },
        h("div", { className: "egm-section-title" }, COPY.guideTitle),
        h("div", { className: "egm-muted" }, COPY.guideDesc),
        h(
          "div",
          { className: "egm-guide-steps" },
          h("div", { className: "egm-guide-step" }, h("span", { className: "egm-guide-step-num" }, "1"), h("span", null, COPY.guideStep1)),
          h("div", { className: "egm-guide-step" }, h("span", { className: "egm-guide-step-num" }, "2"), h("span", null, COPY.guideStep2)),
          h("div", { className: "egm-guide-step" }, h("span", { className: "egm-guide-step-num" }, "3"), h("span", null, COPY.guideStep3)),
          h("div", { className: "egm-guide-step" }, h("span", { className: "egm-guide-step-num" }, "4"), h("span", null, COPY.guideStep4)),
        ),
      )
    }

    function ReviewAuthSection(props) {
      const snapshot = props.snapshot
      const sessionId = props.sessionId
      const ctx = props.ctx
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [backupCmd, setBackupCmd] = React.useState(null)
      const [checked, setChecked] = React.useState(false)
      const [copied, setCopied] = React.useState(false)

      const mountedRef = React.useRef(true)
      const opTokenRef = React.useRef(0)
      const copyTimerRef = React.useRef(null)
      const activeSessionRef = React.useRef(sessionId)
      activeSessionRef.current = sessionId

      React.useEffect(() => {
        mountedRef.current = true
        setChecked(false)
        setBusy(false)
        setError(null)
        setBackupCmd(null)
        setCopied(false)
        return () => {
          mountedRef.current = false
          activeSessionRef.current = null
          opTokenRef.current += 1
          if (copyTimerRef.current) {
            clearTimeout(copyTimerRef.current)
            copyTimerRef.current = null
          }
        }
      }, [sessionId])

      const status = getReviewAccessStatus(snapshot)
      const isAllowed = status.allowed

      // 当状态从已授权变为未授权/过期/用尽时，强制清空勾选（每轮续签必须重新勾选风险确认）
      const prevAllowedRef = React.useRef(isAllowed)
      React.useEffect(() => {
        if (prevAllowedRef.current && !isAllowed) {
          setChecked(false)
        }
        prevAllowedRef.current = isAllowed
      }, [isAllowed])

      const handleAuthorize = async () => {
        if (busy || !checked) return
        const targetSessionId = sessionId
        const opToken = ++opTokenRef.current
        setBusy(true)
        setError(null)
        setBackupCmd(null)
        const isCurrent = () => mountedRef.current && activeSessionRef.current === targetSessionId && opTokenRef.current === opToken
        try {
          const res = await executeHostCommand(ctx, targetSessionId, "/egm-review-access 确认无隔离")
          if (!isCurrent()) return
          if (res.ok) {
            triggerImmediatePoll(targetSessionId, ctx)
            setChecked(false)
          } else {
            setError(res.error || "授权执行失败")
            setBackupCmd(res.backupCommand || "/egm-review-access 确认无隔离")
          }
        } catch (err) {
          if (!isCurrent()) return
          setError((err && err.message) || String(err))
          setBackupCmd("/egm-review-access 确认无隔离")
        } finally {
          if (isCurrent()) {
            setBusy(false)
          }
        }
      }

      const handleRevoke = async () => {
        if (busy) return
        const targetSessionId = sessionId
        const opToken = ++opTokenRef.current
        setBusy(true)
        setError(null)
        setBackupCmd(null)
        const isCurrent = () => mountedRef.current && activeSessionRef.current === targetSessionId && opTokenRef.current === opToken
        try {
          const res = await executeHostCommand(ctx, targetSessionId, "/egm-review-access revoke")
          if (!isCurrent()) return
          if (res.ok) {
            triggerImmediatePoll(targetSessionId, ctx)
            setChecked(false)
          } else {
            setError(res.error || "撤销授权失败")
            setBackupCmd(res.backupCommand || "/egm-review-access revoke")
          }
        } catch (err) {
          if (!isCurrent()) return
          setError((err && err.message) || String(err))
          setBackupCmd("/egm-review-access revoke")
        } finally {
          if (isCurrent()) {
            setBusy(false)
          }
        }
      }

      const handleCopyBackup = () => {
        if (!backupCmd) return
        if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          navigator.clipboard.writeText(backupCmd).catch(() => {})
        }
        setCopied(true)
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
        copyTimerRef.current = setTimeout(() => {
          if (mountedRef.current) {
            setCopied(false)
          }
        }, 2000)
      }

      const statusBadgeText = status.effectiveRemaining !== null
        ? "（可用 " + status.effectiveRemaining + " 次" +
          (status.remainingMinutes ? " · 剩 " + status.remainingMinutes + " 分钟" : "") +
          "）"
        : null

      return h(
        "div",
        { className: "egm-section" },
        h("div", { className: "egm-section-title" }, COPY.reviewAuthTitle),
        h(
          "div",
          { className: "egm-auth-box", "data-state": status.state },
          h("div", { className: "egm-auth-risk" }, COPY.reviewRiskStatement),
          isAllowed
            ? h(
                "div",
                { className: "egm-auth-active" },
                h(
                  "div",
                  { className: "egm-auth-status egm-ok" },
                  h("strong", null, COPY.reviewAuthAllowed),
                  statusBadgeText ? h("span", { className: "egm-muted" }, statusBadgeText) : null,
                ),
                h(
                  "button",
                  {
                    className: "egm-btn egm-btn--revoke",
                    type: "button",
                    disabled: busy,
                    onClick: handleRevoke,
                  },
                  busy ? COPY.reviewRevoking : COPY.reviewRevokeBtn,
                ),
                h("div", { className: "egm-muted" }, COPY.reviewRevokeNotice),
              )
            : h(
                "div",
                { className: "egm-auth-inactive" },
                status.isExpired
                  ? h("div", { className: "egm-warn" }, COPY.reviewExpiredNotice)
                  : status.isExhausted
                    ? h("div", { className: "egm-warn" }, COPY.reviewExhaustedNotice)
                    : h("div", { className: "egm-muted" }, COPY.reviewUnauthNotice),
                h(
                  "label",
                  { className: "egm-check" },
                  h("input", {
                    type: "checkbox",
                    checked: checked,
                    onChange: (e) => setChecked(Boolean(e && e.target && e.target.checked)),
                  }),
                  COPY.reviewConfirmCheckbox,
                ),
                h(
                  "button",
                  {
                    className: "egm-btn egm-btn--primary",
                    type: "button",
                    disabled: !checked || busy,
                    onClick: handleAuthorize,
                  },
                  busy ? COPY.reviewAuthorizing : COPY.reviewAuthBtn,
                ),
              ),
          error
            ? h(
                "div",
                { className: "egm-auth-error" },
                h("span", null, error),
                backupCmd
                  ? h(
                      "div",
                      { className: "egm-auth-backup" },
                      h("code", { className: "egm-auth-backup-cmd" }, backupCmd),
                      h(
                        "button",
                        {
                          type: "button",
                          className: "egm-btn egm-btn--sm",
                          onClick: handleCopyBackup,
                        },
                        copied ? COPY.commandCopied : COPY.commandCopy,
                      ),
                    )
                  : null,
              )
            : null,
        ),
      )
    }

    function ElephantPanel(props) {
      const snapshot = props.snapshot
      const elephant = snapshot.elephant || {}
      return h(
        PanelShell,
        {
          id: 'egm-elephant-panel',
          title: COPY.elephantTitle,
          subtitle: busyText(snapshot),
          glyph: 'elephant',
          tone: snapshot.status === 'error' ? 'error' : snapshot.status === 'stale' ? 'stale' : 'normal',
          geometry: props.geometry,
          note: props.geometry.note,
          panelRef: props.panelRef,
          onClose: props.onClose,
          onKeyDown: props.onKeyDown,
        },
        h(GuideSection),
        h(ReviewAuthSection, { key: props.sessionId, snapshot, sessionId: props.sessionId, ctx: props.ctx }),
        h(StateSection, { snapshot }),
        h(
          'div',
          { className: 'egm-section' },
          h('div', { className: 'egm-section-title' }, COPY.elephantSection),
          h(
            'div',
            { className: 'egm-kv' },
            h('span', { className: 'egm-k' }, COPY.elephantRow),
            h(
              'span',
              { className: 'egm-v' },
              elephant.known
                ? elephant.working
                  ? elephantBusy(snapshot)
                    ? COPY.busyTitle
                    : COPY.working
                  : COPY.notWorking
                : '状态暂不可用',
            ),
            h('span', { className: 'egm-k' }, COPY.signalRow),
            h(
              'span',
              { className: 'egm-v' },
              elephant.egm && elephant.egm.active
                ? COPY.signalYes + (elephant.egm.skill ? '（' + elephant.egm.skill + '）' : '')
                : COPY.signalNo,
            ),
            elephant.workingOnEgm !== null ? h('span', { className: 'egm-k' }, COPY.turnRow) : null,
            elephant.workingOnEgm !== null
              ? h(
                  'span',
                  { className: 'egm-v' },
                  elephant.workingOnEgm ? COPY.turnYes : COPY.turnNo + '（普通对话）',
                )
              : null,
            elephant.reason ? h('span', { className: 'egm-k' }, COPY.reasonRow) : null,
            elephant.reason
              ? h('span', { className: 'egm-v egm-muted' }, reasonText(elephant.reason))
              : null,
          ),
          h('div', { className: 'egm-muted' }, COPY.readOnly),
        ),
      )
    }

    function GoldfishPanel(props) {
      const snapshot = props.snapshot
      const fish = Array.isArray(snapshot.goldfish) ? snapshot.goldfish : []
      const selected = fish.find((item) => item.id === props.selectedId) || fish[0] || null
      return h(
        PanelShell,
        {
          id: 'egm-goldfish-panel',
          title: COPY.goldfishTitle,
          subtitle: fish.length + ' 条记录 · ' + stateText(snapshot),
          glyph: 'goldfish',
          geometry: props.geometry,
          note: props.geometry.note,
          panelRef: props.panelRef,
          onClose: props.onClose,
          onKeyDown: props.onKeyDown,
        },
        h(
          'div',
          { className: 'egm-section' },
          h(
            'div',
            { className: 'egm-section-head' },
            h('span', { className: 'egm-section-title' }, COPY.fishRecords),
            
          ),
          fish.length === 0
            ? h('div', { className: 'egm-empty' }, COPY.noFish)
            : h(
                'div',
                { className: 'egm-fish-list' },
                fish.map((item) =>
                  h(
                    'button',
                    {
                      key: item.id,
                      className: 'egm-fish',
                      type: 'button',
                      'aria-pressed': selected && selected.id === item.id ? 'true' : 'false',
                      onClick: () => props.onSelect(item.id),
                    },
                    h('span', { className: 'egm-fish-dot', 'data-status': item.status }),
                    h('span', { className: 'egm-fish-role' }, item.role),
                    h(
                      'span',
                      { className: 'egm-fish-meta' },
                      [item.mode, item.stage].filter(Boolean).join(' · ') || '模式/阶段未知',
                    ),
                    h(
                      'span',
                      { className: 'egm-fish-status ' + goldfishStatusClass(item.status) },
                      goldfishStatusLabel(item.status),
                    ),
                  ),
                ),
              ),
        ),
        selected
          ? h(
              'div',
              { className: 'egm-section' },
              h('div', { className: 'egm-section-title' }, '这条金鱼 · ' + selected.role),
              h(
                'div',
                { className: 'egm-kv' },
                h('span', { className: 'egm-k' }, COPY.progressRow),
                h(
                  'span',
                  { className: 'egm-v ' + goldfishStatusClass(selected.status) },
                  goldfishStatusLabel(selected.status),
                ),
                h('span', { className: 'egm-k' }, COPY.startedLabel),
                h('span', { className: 'egm-v' }, formatTime(selected.startedAt)),
                h('span', { className: 'egm-k' }, COPY.finishedLabel),
                h('span', { className: 'egm-v' }, formatTime(selected.finishedAt)),
                selected.docPath ? h('span', { className: 'egm-k' }, COPY.docLabel) : null,
                selected.docPath ? h('span', { className: 'egm-v' }, selected.docPath) : null,
              ),
              selected.status === 'failed'
                ? h(
                    'div',
                    { className: 'egm-error', role: 'status' },
                    COPY.errorLabel + '：' + (selected.error || '后端没有给原因'),
                  )
                : null,
              h(ReportView, {
                fish: selected,
                report: freshReport(props.reports[selected.id], props.sessionId, selected),
                onLoad: () => props.onLoadReport(selected),
              }),
            )
          : null,
      )
    }


    // 模式面板：入口 chip 的右键入口。这里只解释模式、给开关，不再有独立输入框和
    // “启动 EGM” 按钮 —— 打字和发附件都回到宿主自己的输入框。
    /** 启动方式选择：对话框 / 卡片，可勾选「不再提示」。 */
    function ModeChooser(props) {
      const remembered = props.remembered
      const subtitle = remembered
        ? COPY.chooseCurrent + (remembered === 'composer' ? COPY.chooseDialog : COPY.chooseCard)
        : COPY.chooseSub
      return h(
        PanelShell,
        {
          id: 'egm-choose-panel',
          title: COPY.chooseTitle,
          subtitle,
          glyph: 'gate',
          geometry: props.geometry,
          note: props.geometry.note,
          panelRef: props.panelRef,
          onClose: props.onClose,
          onKeyDown: props.onKeyDown,
        },
        h(GuideSection),
        h(
          'div',
          { className: 'egm-choose' },
          h(
            'button',
            {
              className: 'egm-option',
              type: 'button',
              'aria-pressed': remembered === 'composer' ? 'true' : 'false',
              onClick: () => props.onPick('composer', props.rememberChecked === true),
            },
            h('strong', null, COPY.chooseDialog),
            h('span', null, COPY.chooseDialogDesc),
          ),
          h(
            'button',
            {
              className: 'egm-option',
              type: 'button',
              'aria-pressed': remembered === 'card' ? 'true' : 'false',
              onClick: () => props.onPick('card', props.rememberChecked === true),
            },
            h('strong', null, COPY.chooseCard),
            h('span', null, COPY.chooseCardDesc),
          ),
          h('div', { className: 'egm-muted' }, '选择后自动记住，下次直接进入。'),
          h('div', { className: 'egm-muted' }, COPY.chooseSub),
        ),
        h(ReviewAuthSection, { key: props.sessionId, snapshot: props.snapshot, sessionId: props.sessionId, ctx: props.ctx }),
      )
    }

    /** 卡片方式：固定小卡片写需求，只支持文字，走原来的 sendText 保护链。 */
    function CardPanel(props) {
      const snapshot = props.snapshot
      const send = props.send || {}
      const command = launchCommand(props.draft, props.workflow)
      return h(
        PanelShell,
        {
          id: 'egm-launch-panel',
          title: COPY.launchTitle,
          subtitle: stateText(snapshot) + (snapshot && snapshot.count ? ' · ' + snapshot.count + ' 条金鱼记录' : ''),
          glyph: 'gate',
          geometry: props.geometry,
          note: props.geometry.note,
          panelRef: props.panelRef,
          onClose: props.onClose,
          onKeyDown: props.onKeyDown,
        },
        h('details', null, h('summary', null, COPY.statusSummary), h(StateSection, { snapshot })),
        h(WorkflowCards, {
          value: props.workflow,
          onChange: props.onWorkflow,
          disabled: Boolean(snapshot && snapshot.task && snapshot.task.status !== 'archived'),
          draftText: props.draft,
        }),
        h(
          'div',
          { className: 'egm-section' },
          h('label', { className: 'egm-label', htmlFor: 'egm-launch-draft' }, COPY.launchLabel),
          h('textarea', {
            id: 'egm-launch-draft',
            className: 'egm-textarea',
            value: props.draft,
            placeholder: COPY.launchPlaceholder,
            rows: 2,
            onChange: (event) => props.onDraft(event.target.value),
            onKeyDown: (event) => {
              if (event && event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                props.onSend()
              }
            },
          }),
          h('div', { className: 'egm-muted' }, COPY.launchHint),
          send.error ? h('div', { className: 'egm-error', role: 'alert' }, send.error) : null,
          send.notice ? h('div', { className: 'egm-notice', role: 'status' }, send.notice) : null,
          h(
            'div',
            { className: 'egm-actions' },
            h(
              'button',
              {
                className: 'egm-btn egm-btn-primary',
                type: 'button',
                disabled: send.busy || !command,
                onClick: props.onSend,
              },
              send.busy ? COPY.launching : COPY.launchSend,
            ),
            h('button', { className: 'egm-btn', type: 'button', onClick: props.onChoose }, COPY.modeChoose),
            snapshot && snapshot.count > 0
              ? h(
                  'button',
                  {
                    className: 'egm-btn',
                    type: 'button',
                    onClick: props.onRecords,
                  },
                  COPY.viewRecords(snapshot.count),
                )
              : null,
          ),
          send.busy ? h('span', { className: 'egm-sr', role: 'status' }, COPY.launching) : null,
        ),
        h(ReviewAuthSection, {
          key: props.sessionId,
          snapshot: props.snapshot,
          sessionId: props.sessionId,
          ctx: props.ctx,
        }),
      )
    }

    function CurrentTaskSection(props) {
      const snapshot = props.snapshot
      const task = snapshot.task
      const [operation, setOperation] = React.useState({ busy: false, error: null, notice: null })
      const [docCopied, setDocCopied] = React.useState(false)
      const taskError = snapshot.taskError

      const runCommand = async (command, successNotice) => {
        if (operation.busy || getViewedSessionId(props.ctx) !== props.sessionId) return
        setOperation({ busy: true, error: null, notice: null })
        const result = await executeHostCommand(props.ctx, props.sessionId, command)
        if (!result.ok) {
          setOperation({ busy: false, error: result.error || '命令执行失败。', notice: null })
          return
        }
        triggerImmediatePoll(props.sessionId, props.ctx)
        setOperation({ busy: false, error: null, notice: successNotice || null })
      }

      const copyDocPath = async () => {
        if (!task || !task.docPath) return
        try {
          await navigator.clipboard.writeText(task.docPath)
          setDocCopied(true)
        } catch {
          setDocCopied(false)
        }
      }

      // 旧版/降级兜底：后端没给 allowedActions 时仍可"另起方案"（与旧版本行为一致）。
      const newCommand = task && task.id ? '/egm-action new ' + task.id + ' ' + (Number.isInteger(task.specRevision) ? task.specRevision : task.revision) : null

      if (taskError) {
        return h('div', { className: 'egm-section' },
          h('div', { className: 'egm-section-title' }, '当前方案'),
          h('div', { className: 'egm-error', role: 'status' }, COPY.taskBroken),
          taskError.path ? h('div', { className: 'egm-muted' }, '记录文件：' + taskError.path) : null)
      }

      if (!task) return null

      const actions = Array.isArray(snapshot.allowedActions) ? snapshot.allowedActions : []
      const hasActions = actions.length > 0
      const ops = Array.isArray(snapshot.ops) ? snapshot.ops : []

      return h('div', { className: 'egm-section' },
        h('div', { className: 'egm-section-title' }, task.title || '当前方案'),
        h('div', { className: 'egm-muted' },
          COPY.taskVersion(Number.isInteger(task.specRevision) ? task.specRevision : 1) +
          ' · ' + COPY.taskStatusLine(task.statusLabel || task.status || '', task.phaseLabel || task.phase || '') +
          (task.docExists === false ? ' · ' + COPY.taskDocMissing : '')),
        h('div', { className: 'egm-muted' }, '继续在输入框补充或改方向，沿用当前大象和图纸。方案版本不限制修改次数；普通聊天不改版本、不解除暂缓。'),
        task.docPath ? h('button', { className: 'egm-btn', type: 'button', onClick: copyDocPath, disabled: operation.busy },
          docCopied ? COPY.copyDocOk : COPY.copyDoc) : null,
        hasActions ? h('div', { className: 'egm-section-title' }, COPY.taskActionsTitle) : null,
        hasActions ? h('div', { className: 'egm-actions' },
          actions.map((action, index) => h('button', {
            key: action.action + '-' + index,
            className: 'egm-btn' + (action.confirm ? ' egm-btn-warn' : ''),
            type: 'button',
            title: action.reason || '',
            disabled: operation.busy || action.enabled !== true || !action.command,
            onClick: () => runCommand(action.command, action.confirm ? '已确认覆盖核对并提交。' : null),
          }, action.label + (action.enabled !== true && action.reason ? '（不可用）' : ''))),
        ) : h('div', { className: 'egm-muted' }, COPY.taskNoActions),
        !hasActions && newCommand ? h('button', { className: 'egm-btn', type: 'button',
          disabled: operation.busy || elephantBusy(snapshot), onClick: () => runCommand(newCommand) },
          operation.busy ? '正在执行…' : '另起方案') : null,
        operation.error ? h('div', { className: 'egm-error', role: 'status' }, operation.error) : null,
        operation.notice ? h('div', { className: 'egm-muted', role: 'status' }, operation.notice) : null,
        hasActions && actions.some((a) => a.enabled === false && a.reason)
          ? h('details', null, h('summary', null, '为什么有些动作不可用'),
            h('ul', null, actions.filter((a) => a.enabled === false && a.reason).map((a, i) =>
              h('li', { key: i }, a.label + '：' + a.reason))))
          : null,
        h('div', { className: 'egm-section-title' }, COPY.opsTitle),
        ops.length === 0
          ? h('div', { className: 'egm-muted' }, '最近还没有操作记录。')
          : h('ul', null, ops.map((op, i) => h('li', { key: op.opId || i },
            (op.label || op.action) + '：' +
            (COPY.opDelivery[op.deliveryState] || op.deliveryState || '未知') +
            (op.executionState && op.executionState !== 'not-started'
              ? ' / ' + (COPY.opExecution[op.executionState] || op.executionState)
              : '')))),
        props.snapshot.archives && props.snapshot.archives.length > 0
          ? h('details', null, h('summary', null, COPY.archivesTitle),
            h('ul', null, props.snapshot.archives.map((archive, i) =>
              h('li', { key: archive.file || i },
                (archive.title || archive.taskId || archive.file) +
                (archive.archivedAt ? '（' + new Date(archive.archivedAt).toLocaleString() + '）' : '') + ' ',
                h('button', {
                  className: 'egm-btn', type: 'button',
                  disabled: operation.busy,
                  onClick: () => runCommand('/egm-restore ' + archive.file, COPY.archiveRestoreOk),
                }, operation.busy ? COPY.archiveRestoring : COPY.archiveRestore)))))
          : null,
      )
    }

    /**
     * 评审配置只读摘要：内置预设 + 项目配置里的命名配置。
     * 这里不提供角色编辑器，也不改任何授权；配置写错就如实显示字段错误。
     */
    function ConfigSummary(props) {
      const config = props.config
      if (!config) return h('div', { className: 'egm-muted' }, COPY.configNone)
      if (config.ok !== true) {
        const lines = [COPY.configBroken + String(config.error || '未知错误')]
        if (config.field) lines.push('出错字段：' + config.field)
        if (config.path) lines.push('文件：' + config.path)
        lines.push(COPY.configFixHint)
        return h(
          'div',
          { className: 'egm-section' },
          lines.map((line, index) =>
            h('div', { key: 'cfg-err-' + index, className: index === 0 ? 'egm-warn' : 'egm-muted' }, line)),
        )
      }
      if (config.present !== true) return h('div', { className: 'egm-muted' }, COPY.configNone)
      const rows = []
      if (config.defaultProfile) rows.push(h('div', { key: 'cfg-def', className: 'egm-muted' }, '默认配置：' + config.defaultProfile))
      rows.push(h('div', { key: 'cfg-hash', className: 'egm-muted' }, COPY.configHashLine(config.hash)))
      const profiles = Array.isArray(config.profiles) ? config.profiles : []
      if (profiles.length === 0) rows.push(h('div', { key: 'cfg-empty', className: 'egm-muted' }, '文件里还没有命名配置。'))
      for (const profile of profiles) {
        const roleText = (Array.isArray(profile.roles) ? profile.roles : [])
          .map((role) => role.id + (role.custom ? '（自定义，仅声明）' : ''))
          .join(' / ')
        rows.push(
          h('div', { key: 'cfg-' + profile.id, className: 'egm-muted' },
            profile.id + '（' + (profile.label || profile.id) + '）：' + roleText +
            ' · 并发 ' + profile.concurrency + ' · 预算 ' + profile.budget + ' · 材料 ' + profile.materialCount + ' 份'),
        )
      }
      return h('div', { className: 'egm-section' }, rows)
    }

    // 评审与证据：运行记录 + 问题台账 + 影响面。只读展示；按钮类操作走 /egm-run、/egm-findings。
    const RUN_STATUS_TEXT = { running: '进行中', completed: '已完成', partial: '部分完成', failed: '失败', unknown: '未知' }
    const SEVERITY_TEXT = { blocker: '阻断', high: '高', medium: '中', low: '低' }
    const VERIFY_TEXT = { unverified: '未核实', confirmed: '已核实', disproven: '已证伪' }
    const DISPOSE_TEXT = { open: '未处理', fixed: '已处理', 'accepted-risk': '接受风险', deferred: '缓办' }
    const IMPACT_TEXT = { full: '整份重审', expand: '扩大范围复审', local: '局部复审', unknown: '判断不了' }

    function ReviewEvidenceSection(props) {
      const snapshot = props.snapshot
      if (!snapshot) return null
      const runs = Array.isArray(snapshot.reviewRuns) ? snapshot.reviewRuns : []
      const findings = Array.isArray(snapshot.findings) ? snapshot.findings : []
      const ledger = snapshot.ledgerSummary && typeof snapshot.ledgerSummary === 'object' ? snapshot.ledgerSummary : null
      const impact = snapshot.impact && typeof snapshot.impact === 'object' ? snapshot.impact : null
      if (runs.length === 0 && findings.length === 0 && !ledger && !impact) return null
      const rows = []
      if (runs.length > 0) {
        rows.push(h('div', { key: 'runs-head', className: 'egm-section-title' }, '评审记录'))
        for (const run of runs) {
          const jobs = (Array.isArray(run.jobs) ? run.jobs : [])
            .map((job) => job.role + '：' + (RUN_STATUS_TEXT[job.status] || job.status))
            .join('，')
          rows.push(h('div', { key: 'run-' + run.runId, className: 'egm-muted' },
            run.runId + '｜' + (RUN_STATUS_TEXT[run.status] || run.status) + '｜阶段 ' + (run.stage ?? '未标') +
            (jobs ? '｜' + jobs : '')))
        }
      }
      if (findings.length > 0 || ledger) {
        rows.push(h('div', { key: 'findings-head', className: 'egm-section-title' }, '问题台账'))
        for (const item of findings) {
          rows.push(h('div', { key: 'fnd-' + item.id, className: 'egm-muted' },
            item.id + '｜' + (SEVERITY_TEXT[item.severity] || item.severity) +
            '｜核实：' + (VERIFY_TEXT[item.verification] || item.verification) +
            '｜处置：' + (DISPOSE_TEXT[item.disposition] || item.disposition) +
            '｜' + (item.summary || '')))
        }
        if (ledger) {
          rows.push(h('div', {
            key: 'ledger-note',
            className: ledger.unreadable || ledger.incomplete ? 'egm-warn' : 'egm-muted',
          }, ledger.note || (ledger.unreadable ? '台账读不出来。' : '')))
        }
      }
      if (impact) {
        rows.push(h('div', { key: 'impact-head', className: 'egm-section-title' }, '图纸影响面'))
        rows.push(h('div', { key: 'impact-line', className: 'egm-muted' },
          (IMPACT_TEXT[impact.mode] || impact.mode) + '（' + (impact.reason || '依据未给出') + '）'))
        if (Array.isArray(impact.changed) && impact.changed.length > 0) {
          rows.push(h('div', { key: 'impact-changed', className: 'egm-muted' }, '变过的段落：' + impact.changed.join(' / ')))
        }
        if (Array.isArray(impact.affectedRoles) && impact.affectedRoles.length > 0) {
          rows.push(h('div', { key: 'impact-roles', className: 'egm-muted' }, '建议重审角色：' + impact.affectedRoles.join(' / ')))
        }
      }
      return h('div', { className: 'egm-section' }, rows)
    }

    function ModePanel(props) {
      const snapshot = props.snapshot
      const mode = props.mode
      return h(
        PanelShell,
        {
          id: 'egm-mode-panel',
          title: COPY.modeTitle,
          subtitle: stateText(snapshot),
          glyph: 'elephant',
          tone: snapshot.status === 'error' ? 'error' : snapshot.status === 'stale' ? 'stale' : 'normal',
          geometry: props.geometry,
          note: props.geometry.note,
          panelRef: props.panelRef,
          onClose: props.onClose,
          onKeyDown: props.onKeyDown,
        },
        h(CurrentTaskSection, { snapshot, sessionId: props.sessionId, ctx: props.ctx }),
        h('details', null, h('summary', null, COPY.workflowTitle),
          h(WorkflowCards, {
            value: props.workflow,
            onChange: props.onWorkflow,
            disabled: Boolean(snapshot && snapshot.task && snapshot.task.status !== 'archived'),
            draftText: props.draft,
          }),
          h('div', { className: 'egm-muted' }, COPY.workflowComposerNote)),
        h('details', null, h('summary', null, COPY.configTitle), h(ConfigSummary, { config: props.snapshot && props.snapshot.config })),
        h('details', null, h('summary', null, '评审与证据'), h(ReviewEvidenceSection, { snapshot: props.snapshot })),
        h('details', null, h('summary', null, COPY.statusSummary), h(StateSection, { snapshot })),
        h(GuideSection),
        h(ReviewAuthSection, {
          key: props.sessionId,
          snapshot: props.snapshot,
          sessionId: props.sessionId,
          ctx: props.ctx,
        }),
        h(
          'div',
          { className: 'egm-section' },
          h('div', { className: 'egm-section-title' }, COPY.modeTitle),
          h('div', { className: 'egm-muted' }, mode ? COPY.modePanelOn : COPY.modePanelOff),
          h(
            'div',
            { className: 'egm-actions' },
            h(
              'button',
              { className: 'egm-btn egm-btn-primary', type: 'button', onClick: props.onToggleMode, disabled: Boolean(snapshot.task && snapshot.task.status !== 'archived') },
              mode ? COPY.modeExit : COPY.modeEnter,
            ),
            h('button', { className: 'egm-btn', type: 'button', onClick: props.onChoose }, COPY.modeChoose),
            snapshot && snapshot.count > 0
              ? h('button', { className: 'egm-btn', type: 'button', onClick: props.onRecords }, COPY.viewRecords(snapshot.count))
              : null,
          ),
        ),
      )
    }

    /**
     * 工作内容（`--workflow`）：和「启动方式」正交——启动方式决定在哪儿写需求，
     * 工作内容决定这次跑哪种流程。已建方案时后端不认新流程，这里也置灰。
     */
    function WorkflowCards(props) {
      const recommended = recommendWorkflow(props.draftText)
      if (props.disabled === true) {
        return h('div', { className: 'egm-section' },
          h('div', { className: 'egm-label' }, COPY.workflowTitle),
          h('div', { className: 'egm-muted' }, COPY.workflowLocked))
      }
      return h('div', { className: 'egm-section' },
        h('div', { className: 'egm-label' }, COPY.workflowTitle),
        h('div', { className: 'egm-workflow-grid' },
          WORKFLOW_OPTIONS.map((item) => {
            const selected = props.value === item.id
            const isRec = recommended === item.id && !selected
            return h('button', {
              key: item.id,
              type: 'button',
              className: 'egm-workflow-card' + (selected ? ' selected' : '') + (isRec ? ' recommended' : ''),
              onClick: () => props.onChange(item.id),
            },
              h('div', { className: 'egm-workflow-card-label' }, item.label),
              h('div', { className: 'egm-workflow-card-hint' }, item.hint),
              isRec ? h('span', { className: 'egm-workflow-badge' }, '推荐') : null)
          })
        ),
        props.value ? null : h('div', { className: 'egm-muted egm-workflow-nudge' }, '↑ 请点选一个工作流类型'),
        h('div', { className: 'egm-muted' }, COPY.workflowHint))
    }

    function EgmDock(props) {
      const ctx = EgmDock.ctx
      const sessionId = props && props.sessionId
      const snapshot = usePet(ctx, sessionId)
      const [open, setOpen] = React.useState(null)
      // 大象模式：按会话存在组件里。null=关闭；{state:'armed'} 草稿里有 /egm chip；
      // {state:'stale'} 模式仍开着但当前不会走 EGM（另有 note 说明原因）。
      const [mode, setMode] = React.useState(null)
      const modeRef = React.useRef(null)
      const launchSubmittedRef = React.useRef(false)
      // 稳定布尔：effect 依赖它而不是 mode 对象，避免每次状态流转都重建 effect。
      const modeOn = Boolean(mode)
      // 跨 effect 实例保留的防重入状态：{key, tries}，同一份目标草稿最多补 3 次。
      const attemptedRef = React.useRef(null)
      // 最近一次同步函数，供“Enter 被拦下时立刻重试补标记”用。
      const syncRef = React.useRef(null)
      // /egm 前缀是不是我们替用户加上的：只有自己写的前缀才允许在关模式时摘掉，
      // 用户自己敲的 /egm 一律原样留着（宿主仍会把它当命令，关模式时如实提示）。
      const ownedRef = React.useRef(false)
      // 卡片方式：按会话记住草稿；提交状态与「不再提示」勾选只在当前面板有效。
      const [cardDraft, setCardDraft] = React.useState(() =>
        sessionId ? draftsFor(sessionId).launch : '',
      )
      const [send, setSend] = React.useState({ busy: false, error: null, notice: null })
      // 工作内容（--workflow）记住上次的选择；存储不可用时退化成内存值，不影响启动。
      const [workflowId, setWorkflowId] = React.useState(() => readWorkflowPreference())
      const chooseWorkflow = React.useCallback((next) => {
        if (!isWorkflowId(next)) return
        setWorkflowId(next)
        writeWorkflowPreference(next)
      }, [])
      const [rememberChoice, setRememberChoice] = React.useState(false)
      const [selectedFishId, setSelectedFishId] = React.useState(null)
      const [reports, setReports] = React.useState({})
      const [frame, setFrame] = React.useState(0)
      const [mascotMount, setMascotMount] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const rootRef = React.useRef(null)
      const floatRef = React.useRef(null)
      const panelRef = React.useRef(null)
      const launchRef = React.useRef(null)
      const elephantRef = React.useRef(null)
      const goldfishRef = React.useRef(null)
      const markRef = React.useRef(null)
      const activeTriggerRef = React.useRef(null)
      const workingElephantRef = React.useRef(null)
      const sessionRef = React.useRef(sessionId)
      sessionRef.current = sessionId
      modeRef.current = mode

      const pets = visiblePets(snapshot)
      // 大象这一秒是不是真的在干 EGM 的活。工作动画、工作标签、“大象在忙”的文案
      // 全部由它决定，绝不用 modeOn / gateOpen / 历史 state 来点亮。
      const busy = elephantBusy(snapshot)
      // 金鱼这一秒是不是真的有鱼在跑：和 pets.goldfish 同源，驱动 data-work 与工作场景图。
      const fishBusy = goldfishBusy(snapshot)
      const hasCurrentTask = snapshot.task ? snapshot.task.status !== 'archived' : Boolean(snapshot.elephant && snapshot.elephant.egm && snapshot.elephant.egm.active)
      const currentTaskRef = React.useRef(hasCurrentTask)
      currentTaskRef.current = hasCurrentTask

      React.useEffect(() => {
        setOpen(null)
        activeTriggerRef.current = null
        setSelectedFishId(null)
        setReports({})
        setMode(null)
        modeRef.current = null
        launchSubmittedRef.current = false
        attemptedRef.current = null
        ownedRef.current = false
        setNotice(null)
        setCardDraft(sessionId ? draftsFor(sessionId).launch : '')
        setSend({ busy: false, error: null, notice: null })
      }, [sessionId])

      // 实测坐标：天花板保护进度卡/输入框，观察尺寸与 DOM 变动触发合帧重绘
      React.useEffect(() => {
        ensureStyle()
        if (!sessionId) return undefined
        // 所有来源（窗口 resize / ResizeObserver / MutationObserver）共用一个
        // rAF 合帧：同一帧里来多少次变化，只重测一次；卸载时取消，不留悬挂回调。
        let raf = null
        let live = true
        let resizeObserver = null
        let mutationObserver = null
        let observedCard = null
        let observedStack = null
        const root = rootRef.current
        const refreshTargets = () => {
          const card = resolveComposerCard(root)
          const stack = composerStackOf(card || root)
          if (card === observedCard && stack === observedStack) return
          observedCard = card
          observedStack = stack
          if (!resizeObserver) return
          resizeObserver.disconnect()
          if (card) resizeObserver.observe(card)
          if (stack && stack !== card) resizeObserver.observe(stack)
        }
        const flush = () => {
          raf = null
          if (!live) return
          refreshTargets()
          setFrame((value) => value + 1)
        }
        const schedule = () => {
          if (!live || raf !== null) return
          if (typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(flush)
          else flush()
        }
        const cancel = () => {
          if (raf !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf)
          raf = null
        }
        const onResize = () => {
          schedule()
        }
        // 观察稳定的当前 seat；卡片尚未插入或被替换时，也能重新绑定尺寸观察。
        const scope = composerSeatOf(root) || composerStackOf(resolveComposerCard(root)) || (root && root.parentElement)
        if (typeof ResizeObserver === 'function') {
          try {
            resizeObserver = new ResizeObserver(schedule)
            refreshTargets()
          } catch {
            if (resizeObserver) resizeObserver.disconnect()
            resizeObserver = null
          }
        }
        if (typeof MutationObserver === 'function' && scope) {
          try {
            mutationObserver = new MutationObserver((records) => {
              if (!Array.isArray(records) || records.length === 0 || records.some((record) => mutationTouchesComposer(record, root))) schedule()
            })
            mutationObserver.observe(scope, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] })
          } catch {
            if (mutationObserver) mutationObserver.disconnect()
            mutationObserver = null
          }
        }
        if (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function') {
          window.addEventListener('resize', onResize)
        }
        // 首次 render 时 ref 仍为空。挂载完成后主动重测，不等待轮询或 resize。
        schedule()
        return () => {
          live = false
          if (resizeObserver) resizeObserver.disconnect()
          if (mutationObserver) mutationObserver.disconnect()
          cancel()
          if (typeof window !== 'undefined' && window && typeof window.removeEventListener === 'function') {
            window.removeEventListener('resize', onResize)
          }
        }
      }, [sessionId])

      // Adapted from the theme's mascot-player sync/release: append our own root
      // to the whale's stand and remove only that root. CSS follows its layout.
      React.useEffect(() => {
        if (!busy || !sessionId || typeof document === 'undefined' || !document.body || typeof document.createElement !== 'function') {
          setMascotMount(null)
          return undefined
        }
        const mount = document.createElement('div')
        mount.className = 'egm-working-elephant-container'
        if (typeof mount.setAttribute === 'function') mount.setAttribute('data-work', 'true')
        workingElephantRef.current = mount
        let live = true
        let raf = null
        const release = () => {
          if (mount.parentNode && typeof mount.parentNode.removeChild === 'function') mount.parentNode.removeChild(mount)
        }
        const sync = () => {
          raf = null
          if (!live) return
          const stand = findMascotStand(rootRef.current)
          if (stand && typeof stand.appendChild === 'function') {
            if (mount.parentNode !== stand) stand.appendChild(mount)
          } else {
            const card = resolveComposerCard(rootRef.current)
            const rect = readRect(card)
            if (!rect || rect.width <= 0 || rect.height <= 0) { release(); return }
            if (mount.parentNode !== document.body) document.body.appendChild(mount)
            mount.style.position = 'fixed'
            mount.style.right = 'auto'
            mount.style.bottom = 'auto'
            mount.style.left = Math.max(8, rect.right - 112) + 'px'
            mount.style.top = Math.max(8, rect.top - 100) + 'px'
            mount.style.zIndex = '40'
          }
          if (stand) {
            mount.style.position = ''
            mount.style.right = ''
            mount.style.bottom = ''
            mount.style.left = ''
            mount.style.top = ''
            mount.style.zIndex = ''
          }
        }
        const schedule = () => {
          if (!live || raf !== null) return
          if (typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(sync)
          else sync()
        }
        let observer = null
        if (typeof MutationObserver === 'function') {
          observer = new MutationObserver((records) => {
            const external = !records || records.length === 0 || Array.from(records).some((record) => {
              if (record.target === mount || (typeof mount.contains === 'function' && mount.contains(record.target))) return false
              const changed = Array.from(record.addedNodes || []).concat(Array.from(record.removedNodes || []))
              return changed.length === 0 || changed.some((node) => node !== mount)
            })
            if (external) schedule()
          })
          observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] })
        }
        window.addEventListener('resize', schedule)
        window.addEventListener('scroll', schedule, true)
        sync()
        setMascotMount(mount)
        return () => {
          live = false
          if (observer) observer.disconnect()
          if (raf !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf)
          window.removeEventListener('resize', schedule)
          window.removeEventListener('scroll', schedule, true)
          if (workingElephantRef.current === mount) workingElephantRef.current = null
          release()
        }
      }, [sessionId, busy])

      const close = React.useCallback(() => {
        setOpen(null)
        const ref =
          open === 'elephant' ? elephantRef : open === 'goldfish' ? goldfishRef : launchRef
        const active = activeTriggerRef.current
        const node = active && active.isConnected !== false ? active : ref && ref.current
        if (node && typeof node.focus === 'function') {
          try {
            node.focus()
          } catch {
            // 焦点恢复失败不影响收起。
          }
        }
      }, [open, setOpen])

      // 点外部 / Esc 只收起卡片：不取消任务，也不清草稿。
      // 输入法正在选词（中文 IME）时，Esc 是“取消选词”，不是“关面板”：
      // 不关、也不拦截，交给输入法自己处理。keyCode 229 覆盖部分旧浏览器。
      function isComposingEvent(event) {
        if (!event) return false
        const native = event.nativeEvent
        return Boolean(
          event.isComposing ||
            event.keyCode === 229 ||
            (native && (native.isComposing || native.keyCode === 229)),
        )
      }

      const card = resolveComposerCard(rootRef.current)
      const cardRect = readRect(card)
      // 编辑器自身的矩形：附件托盘在编辑框上方，只按卡片顶端定位会被图片顶到，
      // 所以标记贴着编辑器左上角的 14px 左内边距放（12px 宽，不压第一个字）。
      const inputRect = readRect(
        card && typeof card.querySelector === 'function' ? card.querySelector('[data-composer-input]') : null,
      )
      const viewport = viewportSize()
      const density =
        (cardRect && cardRect.width > 0 && cardRect.width < 460) || viewport.width < 520
          ? 'compact'
          : 'full'

      const stackNode = composerStackOf(card || rootRef.current)
      const seatNode = (
        (card && typeof card.closest === 'function'
          ? card.closest('[data-composer-seat]') || card.closest('[data-conversation-region="composer"]')
          : null) ||
        (rootRef.current && typeof rootRef.current.closest === 'function'
          ? rootRef.current.closest('[data-composer-seat]') || rootRef.current.closest('[data-conversation-region="composer"]')
          : null)
      )
      const dockCeiling = findDockCeiling(card, stackNode, seatNode)
      const stackRect = readRect(stackNode)
      const geometry = choosePanelGeometry({
        card: cardRect,
        dockCeiling,
        trigger: (() => {
          const ref = open === 'elephant' ? elephantRef : open === 'goldfish' ? goldfishRef : launchRef
          const active = activeTriggerRef.current
          return readRect(active && active.isConnected !== false ? active : null) || readRect((ref && ref.current) || launchRef.current || rootRef.current)
        })(),
        viewport,
      })

      // 已打开时宿主卡片/座位变得不可测（收起侧栏、切会话、卸载）：
      // 安全收起面板，不留一个靠旧坐标硬撑的浮层。
      React.useEffect(() => {
        if (open && geometry.mode === 'hidden') {
          setOpen(null)
          setNotice(COPY.panelHidden)
        }
      }, [open, geometry.mode])

      // Esc 在 window 捕获阶段拦下并 preventDefault，宿主“连按两次 Esc 停止任务”
      // 看到的是已处理事件，因此不会顺手把正在跑的任务停掉。
      React.useEffect(() => {
        if (!open) return undefined
        const onKeyDown = (event) => {
          if (!event || event.key !== 'Escape') return
          if (isComposingEvent(event)) return
          if (event.defaultPrevented) return
          if (event.preventDefault) event.preventDefault()
          if (event.stopPropagation) event.stopPropagation()
          close()
        }
        const onPointerDown = (event) => {
          const root = rootRef.current
          const panel = panelRef.current
          const mark = markRef.current
          const working = workingElephantRef.current
          const target = event && event.target
          // 检查点击是否落在入口节点、Portal 弹出的面板或大象标记内；在内部则不关闭。
          if (root && target && typeof root.contains === 'function' && root.contains(target)) return
          if (panel && target && typeof panel.contains === 'function' && panel.contains(target)) return
          if (mark && target && typeof mark.contains === 'function' && mark.contains(target)) return
          if (working && target && typeof working.contains === 'function' && working.contains(target)) return
          setOpen(null)
        }
        if (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function') {
          window.addEventListener('keydown', onKeyDown, true)
        }
        if (typeof document !== 'undefined' && document && typeof document.addEventListener === 'function') {
          document.addEventListener('pointerdown', onPointerDown, true)
        }
        return () => {
          if (typeof window !== 'undefined' && window && typeof window.removeEventListener === 'function') {
            window.removeEventListener('keydown', onKeyDown, true)
          }
          if (typeof document !== 'undefined' && document && typeof document.removeEventListener === 'function') {
            document.removeEventListener('pointerdown', onPointerDown, true)
          }
        }
      }, [open, close])

      // “放不下”的说明只停几秒，不长期占着入口。
      React.useEffect(() => {
        if (!notice) return undefined
        const id = setTimeout(() => setNotice(null), 4000)
        return () => clearTimeout(id)
      }, [notice])

      // 打开时把焦点交给卡片，键盘用户能直接 Tab 到里面。
      React.useEffect(() => {
        if (!open) return
        const node = panelRef.current
        if (node && typeof node.focus === 'function') {
          try {
            node.focus()
          } catch {
            // 焦点进不去也不影响内容展示。
          }
        }
      }, [open])

      function toggle(kind, trigger) {
        if (trigger) activeTriggerRef.current = trigger
        else activeTriggerRef.current = (kind === 'elephant' ? elephantRef : kind === 'goldfish' ? goldfishRef : launchRef).current
        // React has assigned the button ref by the next render. Opening does not
        // depend on a card/stack measurement from the earlier render.
        setNotice(null)
        setOpen((previous) => (previous === kind ? null : kind))
      }

      // 大象模式与草稿的同步：宿主草稿是唯一真相，模式状态跟着它走。
      // 只做三件事：装上 /egm chip、确认 chip 还在、被删掉就在安全时机补回来。
      // 不自动发送、不动附件、不覆盖别的命令、输入法选词中绝不改写草稿。
      // 依赖只用稳定的 modeOn：mode 对象每流转一次就换新，放进依赖会反复重建 effect、
      // 清掉防重入状态，在宿主异步恢复 claim 的间隙里反复 setDraft 打转。
      React.useEffect(() => {
        if (!sessionId || !modeOn) return undefined
        const shell = composerShell(ctx, sessionId)
        if (!shell || !shell.state || typeof shell.state.subscribe !== 'function') {
          applyMode({ state: 'stale', note: 'noShell' })
          return undefined
        }
        let cancelled = false
        const sync = () => {
          if (cancelled || !modeRef.current) return
          // 闸门必须还装在本会话这个 shell 的顶层：宿主换了 shell、或有人把我们
          // 盖住（我们无法证明还会被调用）时，立刻关模式，绝不让“开着”变成假象。
          const live = submitGates.get(sessionId)
          if (
            !live ||
            live.shell !== shell ||
            shell.submit !== live.gate ||
            composerShell(ctx, sessionId) !== shell
          ) {
            disableUnprotected(COPY.modeGateLost, { shell })
            return
          }
          const snapshot = readDraftSnapshot(shell)
          const phaseNow = readPhase(shell)
          if (phaseNow === 'submitting') { launchSubmittedRef.current = true; return }
          // 退出启动模式必须以后端确认的任务为准：snapshot.task 存在（含 archived，
          // 用于「另起方案后重新进入」）才算业务成立。launchSubmittedRef 只表示本地
          // 提交过，不能单独作为退出依据——那样会在后端还没建任务时就清掉 /egm 前缀。
          if (currentTaskRef.current) {
            modeRef.current = null
            attemptedRef.current = null
            releaseSubmitGate(sessionId)
            if (ownedRef.current && !isComposingComposer(rootRef.current)) stripModeDraft(shell, false)
            ownedRef.current = false
            setMode(null)
            return
          }
          if (launchSubmittedRef.current && phaseNow !== 'submitting') {
            // 已提交但后端还没有任务：保持模式与 /egm 前缀，等下一次轮询；草稿与 IME 不动。
            applyMode({ state: 'stale', note: 'awaiting-task' })
            return
          }
          if (!snapshot) {
            applyMode({ state: 'stale', note: 'noDraft' })
            return
          }
          if (snapshot.command && snapshot.command.token === MODE_TOKEN) {
            attemptedRef.current = null
            applyMode({ state: 'armed' })
            return
          }
          const phase = readPhase(shell)
          if (phase !== null && phase !== 'plain' && phase !== 'claimed') return
          const wanted = modeDraft(snapshot)
          if (!wanted.draft) {
            applyMode({ state: 'stale', note: wanted.reason })
            return
          }
          const key = snapshot.text.length + '\u0000' + snapshot.text.slice(0, 24)
          // 同一份草稿最多补 3 次：宿主 restoreCommand 是异步的，第一次写完回读可能
          // 还没落地，要允许后续 publish 再试；但绝不无限 setDraft 打转。防重入状态
          // 放在 ref 里，跨 effect 实例保留（mode 状态流转不会把它清掉）。
          const attempt = attemptedRef.current
          if (attempt && attempt.key === key) {
            if (attempt.tries >= 3) {
              applyMode({ state: 'stale', note: 'refused' })
              return
            }
            attempt.tries += 1
          } else {
            attemptedRef.current = { key, tries: 1 }
          }
          if (isComposingComposer(rootRef.current)) {
            applyMode({ state: 'stale', note: 'composing' })
            return
          }
          const setDraft = draftSetter(shell)
          if (!setDraft) {
            applyMode({ state: 'stale', note: 'noShell' })
            return
          }
          try {
            setDraft(wanted.draft)
            // 所有权只升不降：只有“这一拍由我们加上前缀”才记成我们的，已经记上就
            // 保持。宿主的 restoreCommand 是异步的，中间几拍会看到“文本已经带 /egm、
            // chip 还没恢复”，那不是用户写的；若在这里把它当成用户写的，关模式时
            // 就摘不掉自己刚加的前缀。
            if (!snapshot.text.startsWith(MODE_TOKEN)) ownedRef.current = true
          } catch {
            applyMode({ state: 'stale', note: 'refused' })
            return
          }
          // 写完立刻回读一次：宿主的 restoreCommand 是异步的，这一步可能还没落地，
          // 那就先算 pending，等它 publish 出来再由订阅确认成 armed。
          const after = readDraftSnapshot(shell)
          applyMode(
            after && after.command && after.command.token === MODE_TOKEN
              ? { state: 'armed' }
              : { state: 'stale', note: 'pending' },
          )
        }
        syncRef.current = sync
        sync()
        const unsubscribe = shell.state.subscribe(sync)
        // 宿主原生 Enter / 发送键 / actions.submit 都汇到 shell.submit，在这里挡。
        const gate = installSubmitGate(sessionId, shell, () => {
          if (!modeRef.current) return false
          if (!modeBlocksSend(modeRef.current, shell)) return false
          // 先试一次补标记，再把“拦下”写进状态；拦下的这一条不发，用户再按一次就走 /egm。
          if (typeof syncRef.current === 'function') syncRef.current()
          applyMode({ state: 'stale', note: 'blocked' })
          try {
            if (typeof shell.notify === 'function') shell.notify('error', COPY.modeBlocked)
          } catch {
            /* 提示失败不影响拦截 */
          }
          return true
        })
        if (!gate) {
          // 装不上闸门就不留在模式里：先关掉（草稿原样保留），并说明为什么。
          disableUnprotected(COPY.modeUnprotected, { shell })
          return undefined
        }
        // 输入法选词结束后补一次：选词期间我们绝不改写草稿，宿主也只在这之后才认
        // Enter；所以 compositionend 之后要重新走一遍，让 stale 尽快回到 armed。
        let timer = null
        const onCompositionEnd = () => {
          attemptedRef.current = null
          if (timer !== null) clearTimeout(timer)
          timer = setTimeout(sync, 0)
        }
        if (typeof document !== 'undefined' && document && typeof document.addEventListener === 'function') {
          document.addEventListener('compositionend', onCompositionEnd, true)
        }
        return () => {
          cancelled = true
          if (timer !== null) clearTimeout(timer)
          if (gate) releaseSubmitGate(sessionId)
          if (syncRef.current === sync) syncRef.current = null
          if (typeof document !== 'undefined' && document && typeof document.removeEventListener === 'function') {
            document.removeEventListener('compositionend', onCompositionEnd, true)
          }
          if (typeof unsubscribe === 'function') unsubscribe()
        }
      }, [sessionId, modeOn])

      React.useEffect(() => {
        if (hasCurrentTask && modeRef.current && typeof syncRef.current === 'function') syncRef.current()
      }, [sessionId, hasCurrentTask])

      // 闸门被别的插件盖住时，我们这层函数从此不会被调用——没有任何回调会通知我们。
      // 所以除了状态变更时（sync）检查，每次渲染也核对一次，尽量缩短“以为开着、
      // 其实拦不住”的窗口。
      // 边界（如实说明，不夸大）：从被盖住到下一次检测之间发出去的消息会绕过闸门，
      // 因为那时我们根本不在调用链上，插件侧无法即时感知。能保证的只是“一旦发现就
      // 立刻关模式并说明”，不保证“替换后零窗口”。
      React.useEffect(() => {
        if (!modeRef.current) return
        const live = submitGates.get(sessionId)
        const shell = (live && live.shell) || composerShell(ctx, sessionId)
        if (!live || !shell || shell.submit !== live.gate || composerShell(ctx, sessionId) !== shell) {
          disableUnprotected(COPY.modeGateLost, { shell })
        }
      })

      function applyMode(next) {
        const previous = modeRef.current
        if (previous && previous.state === next.state && previous.note === next.note) return
        modeRef.current = next
        setMode(next)
      }

      /** 把插件自己加的 /egm 前缀与 chip 摘掉（用户自己敲的不动）。 */
      function stripModeDraft(shell, keepToken) {
        const snapshot = readDraftSnapshot(shell)
        if (!snapshot) return false
        const hasChip = Boolean(snapshot.command && snapshot.command.token === MODE_TOKEN)
        const hasText = snapshot.text.startsWith(MODE_TOKEN)
        if (!hasChip && !hasText) return true
        const setDraft = draftSetter(shell)
        if (!setDraft) return false
        try {
          setDraft(plainDraft(snapshot, { keepToken: keepToken && hasText && !ownedRef.current }))
        } catch {
          return false
        }
        // 宿主 setDraft 是同步写编辑器，但“没抛错”不等于“已摘掉”：读回确认。
        const after = readDraftSnapshot(shell)
        if (!after) return false
        if (after.command && after.command.token === MODE_TOKEN) return false
        return keepToken || !after.text.startsWith(MODE_TOKEN)
      }

      /**
       * 无法防护时强制关模式：绝不停留在“看起来开着、实际拦不住”的状态。
       *
       * 草稿保护（宁可不删，也不删错）：
       * - 只动**我们装过闸门的那个 shell**（submitGates 里记的那个），不用现在
       *   `composerShell()` 解析出来的——宿主换 shell 后那可能已经是别的输入框，
       *   动它就是动别人的草稿。
       * - 只有 `ownedRef` 明确为真（前缀是我们加的）才摘；归属不明就一个字都不动，
       *   并如实告诉用户“开头那个 /egm 我没动”。
       */
      function disableUnprotected(notice, options) {
        if (!modeRef.current) return
        const record = submitGates.get(sessionId)
        const shell = (record && record.shell) || (options && options.shell) || null
        const owned = ownedRef.current === true
        modeRef.current = null
        attemptedRef.current = null
        let keptToken = false
        if (shell) {
          if (owned) {
            keptToken = !stripModeDraft(shell, false)
          } else {
            // 归属不明：只看有没有 /egm，有就保留并提示，绝不删。
            const snapshot = readDraftSnapshot(shell)
            keptToken = Boolean(
              snapshot &&
                (snapshot.text.startsWith(MODE_TOKEN) ||
                  (snapshot.command && snapshot.command.token === MODE_TOKEN)),
            )
          }
        }
        ownedRef.current = false
        setMode(null)
        setNotice(keptToken ? COPY.modeKeptOnDisable : notice)
      }

      function toggleMode() {
        if (modeRef.current) {
          // 关闭模式：不发送、不动附件。只摘掉“我们自己加上”的 /egm 前缀和 chip；
          // 用户自己敲的 /egm 一个字都不删，但要如实说明它仍会走 EGM。
          // 先清 modeRef：同步 effect 看到模式已关就直接退出，不会在摘 chip 的同一拍
          // 又把 /egm 补回去；摘不掉再恢复，绝不谎称已关闭。
          const previous = modeRef.current
          const owned = ownedRef.current === true
          modeRef.current = null
          attemptedRef.current = null
          const shell = composerShell(ctx, sessionId)
          const snapshot = readDraftSnapshot(shell)
          if (!snapshot) {
            // 读不到草稿就无法确认摘干净，宁可留在模式里，也不谎称已关闭。
            modeRef.current = previous
            setNotice(COPY.modeCloseFailed)
            return
          }
          const hasChip = Boolean(snapshot.command && snapshot.command.token === MODE_TOKEN)
          const hasText = snapshot.text.startsWith(MODE_TOKEN)
          // pending（草稿里有 /egm 文字、chip 还没恢复）同样是残留，必须一起清掉。
          if (hasChip || (hasText && owned)) {
            const setDraft = draftSetter(shell)
            if (!setDraft) {
              modeRef.current = previous
              setNotice(COPY.modeCloseFailed)
              return
            }
            const keepToken = hasText && !owned
            try {
              setDraft(plainDraft(snapshot, { keepToken }))
            } catch {
              modeRef.current = previous
              setNotice(COPY.modeCloseFailed)
              return
            }
            // 宿主 setDraft 是同步写编辑器，但“没抛错”不等于“已摘掉”：读回草稿，
            // 确认 chip 与（我们自己的）/egm 前缀都不在了，才算真的关掉模式。
            const after = readDraftSnapshot(shell)
            const chipGone = Boolean(after) && !(after.command && after.command.token === MODE_TOKEN)
            const tokenGone = keepToken ? Boolean(after) : Boolean(after) && !after.text.startsWith(MODE_TOKEN)
            if (!chipGone || !tokenGone) {
              modeRef.current = previous
              setNotice(COPY.modeCloseFailed)
              return
            }
            ownedRef.current = false
          }
          if (hasText && !owned) setNotice(COPY.modeKeptOwn)
          setMode(null)
          return
        }
        setNotice(null)
        // 先确认能在本会话的 shell 上装好闸门，再开模式：装不上就不开，
        // 免得用户以为“开着 EGM”，实际发出去是普通消息。草稿一个字都不动。
        const shell = composerShell(ctx, sessionId)
        const gate = installSubmitGate(sessionId, shell, () => {
          if (!modeRef.current) return false
          if (!modeBlocksSend(modeRef.current, shell)) return false
          if (typeof syncRef.current === 'function') syncRef.current()
          applyMode({ state: 'stale', note: 'blocked' })
          try {
            if (typeof shell.notify === 'function') shell.notify('error', COPY.modeBlocked)
          } catch {
            /* 提示失败不影响拦截 */
          }
          return true
        })
        if (!gate) {
          setNotice(COPY.modeUnprotected)
          return
        }
        const next = { state: 'stale', note: 'pending' }
        launchSubmittedRef.current = false
        attemptedRef.current = null
        modeRef.current = next
        setMode(next)
      }

      // 入口左键：开着模式=关模式；记住了方式=直接进；否则先问一次。
      function handleLaunchClick() {
        activeTriggerRef.current = launchRef.current
        if (hasCurrentTask || busy || modeRef.current) {
          setOpen(open === 'mode' ? null : 'mode')
          return
        }
        if (open === 'choose') {
          setOpen(null)
          return
        }
        const pref = readLaunchPreference()
        if (pref === 'composer') {
          toggleMode()
          return
        }
        if (pref === 'card') {
          setOpen('card')
          return
        }
        setOpen('choose')
      }

      function pickLaunch(kind, remember) {
        writeLaunchPreference(kind)
        setOpen(null)
        if (hasCurrentTask || busy) { setOpen('mode'); return }
        if (kind === 'composer') {
          if (!modeRef.current) toggleMode()
          return
        }
        // 从对话框模式换到卡片：先退模式（摘掉我们自己加的 /egm），再开卡片。
        if (modeRef.current) toggleMode()
        setOpen('card')
      }

      function changeCardDraft(value) {
        setCardDraft(value)
        const current = draftsFor(sessionId)
        draftsBySession.set(sessionId, Object.assign({}, current, { launch: value }))
        // 上一次的“已发出/失败”只对上一次提交有意义，改字就作废，避免误导。
        if (!send.busy && (send.notice || send.error)) {
          setSend({ busy: false, error: null, notice: null })
        }
      }

      async function doCardLaunch() {
        if (!workflowId) {
          setSend({ busy: false, error: '请先点选一个工作流类型再启动。', notice: null })
          return
        }
        const command = launchCommand(cardDraft, workflowId)
        if (!command) {
          setSend({ busy: false, error: COPY.launchEmpty, notice: null })
          return
        }
        if (send.busy) return
        setSend({ busy: true, error: null, notice: null })
        try {
          await sendText(ctx, sessionId, command)
          if (sessionRef.current !== sessionId) return
          setCardDraft((previous) => {
            if (launchCommand(previous, workflowId) !== command) return previous
            draftsBySession.set(sessionId, Object.assign({}, draftsFor(sessionId), { launch: '' }))
            return ''
          })
          setSend({ busy: false, error: null, notice: COPY.launchSubmittedPending })
          setOpen('mode')
          triggerImmediatePoll(sessionId, ctx)
        } catch (error) {
          if (sessionRef.current !== sessionId) return
          setSend({ busy: false, error: errorText(error), notice: null })
        }
      }

      function loadReport(fish) {
        if (!fish || !fish.id) return
        const cacheKey = sessionId + ':' + fish.id + ':' + (fish.reportPath || '') + ':' + (fish.finishedAt || 0)
        const cached = reportCache.get(cacheKey)
        if (cached) {
          setReports((previous) => Object.assign({}, previous, { [fish.id]: { status: 'ready', data: cached } }))
          return
        }
        setReports((previous) => Object.assign({}, previous, { [fish.id]: { status: 'loading' } }))
        ctx.connection.rpc
          .call(CHANNEL, REPORT_METHOD, { sessionId, goldfishId: fish.id })
          .then((reply) => {
            if (sessionRef.current !== sessionId) return
            if (!reply || reply.ok !== true) throw new Error(rpcError(reply))
            const value = reply.value
            if (!value || typeof value !== 'object') throw new Error('报告回包为空')
            if (typeof value.id === 'string' && value.id !== fish.id) {
              throw new Error('报告不属于这条金鱼（收到 ' + value.id + '），已丢弃')
            }
            if (typeof value.content !== 'string') throw new Error('报告回包缺少正文')
            const source =
              value.source === 'disk' || value.source === 'memory-fallback' ? value.source : null
            const data = {
              id: value.id,
              role: typeof value.role === 'string' ? value.role : fish.role,
              reportPath:
                typeof value.reportPath === 'string' && value.reportPath
                  ? value.reportPath
                  : fish.reportPath,
              content: value.content,
              totalBytes: finite(value.totalBytes),
              truncated: value.truncated === true,
              source,
              sessionId,
              finishedAt: finite(fish.finishedAt),
            }
            reportCache.set(cacheKey, data)
            setReports((previous) =>
              Object.assign({}, previous, { [fish.id]: { status: 'ready', data } }),
            )
          })
          .catch((error) => {
            if (sessionRef.current !== sessionId) return
            setReports((previous) =>
              Object.assign({}, previous, {
                [fish.id]: { status: 'error', error: errorText(error) },
              }),
            )
          })
      }

      let activePanel = null
      if (open === 'elephant' && geometry.mode !== 'blocked' && geometry.mode !== 'hidden') {
        activePanel = h(ElephantPanel, {
          snapshot,
          sessionId,
          ctx,
          geometry,
          panelRef,
          onClose: close,
          onKeyDown: (event) => {
            if (event && event.key === 'Escape' && !isComposingEvent(event)) {
              if (event.preventDefault) event.preventDefault()
              if (event.stopPropagation) event.stopPropagation()
              close()
            }
          },
        })
      } else if (open === 'goldfish' && geometry.mode !== 'blocked' && geometry.mode !== 'hidden') {
        activePanel = h(GoldfishPanel, {
          snapshot,
          geometry,
          panelRef,
          sessionId,
          selectedId: selectedFishId,
          reports,
          onSelect: (id) => setSelectedFishId(id),
          onLoadReport: loadReport,
          onClose: close,
          onKeyDown: (event) => {
            if (event && event.key === 'Escape' && !isComposingEvent(event)) {
              if (event.preventDefault) event.preventDefault()
              if (event.stopPropagation) event.stopPropagation()
              close()
            }
          },
        })
      } else if (open === 'choose' && geometry.mode !== 'blocked' && geometry.mode !== 'hidden') {
        activePanel = h(ModeChooser, {
          geometry,
          snapshot,
          sessionId,
          ctx,
          panelRef,
          remembered: readLaunchPreference(),
          rememberChecked: rememberChoice,
          onRemember: setRememberChoice,
          onPick: pickLaunch,
          onClose: close,
          onKeyDown: (event) => {
            if (event && event.key === 'Escape' && !isComposingEvent(event)) {
              if (event.preventDefault) event.preventDefault()
              if (event.stopPropagation) event.stopPropagation()
              close()
            }
          },
        })
      } else if (open === 'card' && geometry.mode !== 'blocked' && geometry.mode !== 'hidden') {
        activePanel = h(CardPanel, {
          snapshot,
          sessionId,
          ctx,
          geometry,
          panelRef,
          draft: cardDraft,
          send,
          workflow: workflowId,
          onWorkflow: chooseWorkflow,
          onDraft: changeCardDraft,
          onSend: doCardLaunch,
          onChoose: () => setOpen('choose'),
          onRecords: () => setOpen('goldfish'),
          onClose: close,
          onKeyDown: (event) => {
            if (event && event.key === 'Escape' && !isComposingEvent(event)) {
              if (event.preventDefault) event.preventDefault()
              if (event.stopPropagation) event.stopPropagation()
              close()
            }
          },
        })
      } else if (open === 'mode' && geometry.mode !== 'blocked' && geometry.mode !== 'hidden') {
        activePanel = h(ModePanel, {
          snapshot,
          sessionId,
          ctx,
          mode,
          geometry,
          panelRef,
          workflow: workflowId,
          onWorkflow: chooseWorkflow,
          onToggleMode: toggleMode,
          onChoose: () => setOpen('choose'),
          onRecords: () => setOpen('goldfish'),
          onClose: close,
          onKeyDown: (event) => {
            if (event && event.key === 'Escape' && !isComposingEvent(event)) {
              if (event.preventDefault) event.preventDefault()
              if (event.stopPropagation) event.stopPropagation()
              close()
            }
          },
        })
      }

      // 所有 hook 都走完了才允许按 sessionId 提前返回：条件 return 放在 hook 前面会
      // 让不同会话下 hook 数量不一致，React 直接报错。
      if (!sessionId) return null

      const portalPanel =
        activePanel && typeof document !== 'undefined' && document && document.body
          ? createPortal(activePanel, document.body)
          : activePanel

      // 输入区旁的大象标记：非编辑性 DOM（不可编辑、不可删），贴着输入卡左缘、
      // 垂直对齐编辑器中线，挂在 body 上，只随模式存在；点击换启动方式。
      const markPlace = mode ? chooseMarkPlacement(cardRect, inputRect, viewport) : null
      const modeMark =
        markPlace && typeof document !== 'undefined' && document && document.body
          ? createPortal(
              h(
                'button',
                {
                  className: 'egm-mode-mark',
                  'data-state': mode.state,
                  'data-session': sessionId,
                  type: 'button',
                  ref: markRef,
                  'aria-label': COPY.markOpen,
                  title: COPY.markOpen,
                  style: {
                    left: markPlace.left + 'px',
                    top: markPlace.top + 'px',
                  },
                  onClick: () => setOpen(open === 'choose' ? null : 'choose'),
                },
                h(ElephantSvg),
              ),
              document.body,
            )
          : null

      // The working elephant is a CSS-positioned sibling of the theme's whale.
      const workingElephantPortal = busy && mascotMount
        ? createPortal(
            h('button', {
              type: 'button',
              className: 'egm-working-elephant-btn egm-working-elephant-hit',
              'data-work': 'true',
              'data-kind': 'elephant-working',
              'aria-label': COPY.workingElephantAria,
              title: COPY.workingElephantAria + ' · ' + busyText(snapshot),
              onClick: (event) => toggle('elephant', event && event.currentTarget),
            }, h(ElephantWorkSvg)),
            mascotMount,
          )
        : null

      return h(
        'div',
        {
          className: 'egm-root',
          ref: rootRef,
          'data-session': sessionId,
          'data-egm-version': '0.8.6',
          'data-egm-anchor': !card ? 'missing-card' : !cardRect || cardRect.width <= 0 || cardRect.height <= 0 ? 'zero-card' : !stackRect || stackRect.width <= 0 ? 'missing-stack' : 'ready',
          'data-panel-mode': geometry.mode,
        },
        h(
          'div',
          {
            className: 'egm-float',
            ref: floatRef,
            'data-density': density,
            'data-panel-mode': geometry.mode,
          },
          h(
            'button',
            {
              ref: launchRef,
              className: 'egm-chip',
              type: 'button',
              'data-mode': mode ? mode.state : 'off',
              'aria-pressed': mode ? 'true' : 'false',
              'aria-label': hasCurrentTask ? '查看当前方案' : mode ? '查看启动状态' : COPY.chooseTitle,
              title:
                'EGM 0.8.6 · ' + (notice ||
                (geometry.mode === 'hidden' ? COPY.panelHidden : geometry.mode === 'blocked'
                  ? COPY.noRoom
                  : COPY.title +
                    '：' +
                    stateText(snapshot) +
                    (snapshot && snapshot.error ? '（' + snapshot.error + '）' : '') +
                    (mode ? ' · ' + (mode.state === 'armed' ? COPY.modeOn : mode.note === 'blocked' ? COPY.modeBlocked : COPY.modeStaleHint) : ''))),
              onClick: handleLaunchClick,
              // 右键/长按开状态面板：左键留给“一键切模式”，不再弹独立启动卡。
              onContextMenu: (event) => {
                if (event && event.preventDefault) event.preventDefault()
                activeTriggerRef.current = event && event.currentTarget || launchRef.current
                setOpen(open === 'choose' ? null : 'choose')
              },
            },
            h('span', { className: 'egm-chip-icon' }, h(GateSvg)),
            h(
              'span',
              { className: 'egm-chip-label' },
              notice
                ? entryNoticeLabel(notice)
                : geometry.mode === 'blocked'
                  ? COPY.noRoomShort
                  : mode
                    ? mode.note === 'blocked'
                      ? COPY.modeBlockedShort
                      : COPY.modeChipLabel
                    : hasCurrentTask ? (busy ? '方案处理中' : '当前方案') : COPY.launch,
            ),
            (pets.elephant || pets.goldfish) ? h('span', { className: 'egm-chip-dot', 'data-tone': 'working', title: '正在工作' }) : null,
            snapshot && snapshot.count > 0
              ? h(
                  'span',
                  { className: 'egm-chip-badge', title: COPY.badgeTitle(snapshot.count) },
                  String(snapshot.count),
                )
              : null,
          ),
          pets.elephant
            ? h(
                'button',
                {
                  ref: elephantRef,
                  // data-work 是动画的唯一开关：live + 在跑 + 这次是 EGM 的活。
                  // 之前这里按 snapshot.state 拼 egm-pet--prep，而 CSS 只认 --writing，
                  // 结果真在干活时也一动不动。
                  className: 'egm-chip egm-pet-chip egm-pet--busy',
                  type: 'button',
                  'data-kind': 'elephant',
                  'data-work': busy ? 'true' : 'false',
                  'aria-expanded': open === 'elephant' ? 'true' : 'false',
                  'aria-controls': 'egm-elephant-panel',
                  'aria-label': open === 'elephant' ? COPY.collapseElephant : COPY.expandElephant,
                  title: COPY.elephant + ' · ' + busyText(snapshot),
                  onClick: () => toggle('elephant'),
                },
                h(ElephantWorkSvg),
                h('span', { className: 'egm-pet-work-label' }, COPY.busy),
              )
            : null,
          pets.goldfish
            ? h(
                'button',
                {
                  ref: goldfishRef,
                  className: 'egm-chip egm-pet-chip',
                  type: 'button',
                  'data-kind': 'goldfish',
                  // data-work 是金鱼工作动画的唯一开关：live + 有鱼在跑才放动画，
                  // 和大象的 data-work 判定同构；跑完/断线/普通聊天都立刻停。
                  'data-work': fishBusy ? 'true' : 'false',
                  'aria-expanded': open === 'goldfish' ? 'true' : 'false',
                  'aria-controls': 'egm-goldfish-panel',
                  'aria-label': open === 'goldfish' ? COPY.collapseGoldfish : COPY.expandGoldfish,
                  title: COPY.fishBusy + ' · ' + stateText(snapshot),
                  onClick: () => toggle('goldfish'),
                },
                h(PetVisual, { kind: 'goldfish', work: fishBusy }),
                h('span', { className: 'egm-pet-work-label' }, COPY.fishBusy),
              )
            : null,
        ),
        portalPanel,
        modeMark,
        workingElephantPortal,
        h(
          'span',
          { className: 'egm-sr', role: 'status', 'aria-live': 'polite' },
          notice || (mode && mode.note === 'blocked' ? COPY.modeBlocked : geometry.mode === 'blocked' ? COPY.noRoom : stateText(snapshot)),
        ),
      )
    }

    const INLINE_REVIEW_CODE_BLOCK_SELECTORS = '.md-code-block, .code-block, .code-block-small'
    const INLINE_REVIEW_PROCESSED_ATTR = 'data-genui-rendered'
    const INLINE_REVIEW_EGM_ATTR = 'data-egm-inline-review'
    const INLINE_REVIEW_CARD_CLASS = 'egm-inline-review-card'

    const INLINE_REVIEW_EXCLUDES = [
      '.' + INLINE_REVIEW_CARD_CLASS,
      '[data-egm-inline-mount]',
      '[' + INLINE_REVIEW_EGM_ATTR + ']',
      '[data-chat-group-part="reasoning"]',
      '[data-tool]',
      '[data-sidebar-chat]',
      '[data-sidebar-right-session]',
      '[data-sidebar-right-panel]',
      '[data-panel-conversation]',
      '[data-plugin-panel]',
      '[data-composer-seat]',
      '[data-composer-input]',
      '[data-genui-sidechat-root]',
    ].join(', ')

    // Adapted from @changfenhuang/dsh-genui (MIT); see genui-inline-license.txt.
    function hasEgmActionInObj(spec) {
      const actions = new Set()
      function visit(node, depth) {
        if (!node || typeof node !== 'object' || depth > 12) return
        if (node.type === 'button' && (node.action === 'egm-review-grant' || node.action === 'egm-review-deny')) {
          actions.add(node.action)
        }
        if (Array.isArray(node.items)) {
          for (const item of node.items) visit(item, depth + 1)
        }
      }
      visit(spec, 0)
      return actions.has('egm-review-grant') && actions.has('egm-review-deny')
    }

    function extractEgmReviewSpec(raw) {
      if (!raw || typeof raw !== 'string') return null
      const text = raw.trim()
      if (!text.includes('egm-review-grant') && !text.includes('egm-review-deny')) {
        return null
      }
      let json = null
      try {
        json = JSON.parse(text)
      } catch {
        const start = text.indexOf('{')
        const end = text.lastIndexOf('}')
        if (start >= 0 && end > start) {
          try {
            json = JSON.parse(text.slice(start, end + 1))
          } catch {
            return null
          }
        } else {
          return null
        }
      }
      if (!json || typeof json !== 'object' || Array.isArray(json)) return null
      return hasEgmActionInObj(json) || taskButtons(json).length ? json : null
    }

    function tagTextBodyOf(block) {
      if (!block || block.tagName !== 'SPAN' || block.childElementCount !== 0) return null
      const text = (block.textContent || '').trim()
      const opening = text.startsWith('<egm-actions>') ? '<egm-actions>' : text.startsWith('<egm-review>') ? '<egm-review>' : '<dsh-ui>'
      const closing = opening === '<egm-actions>' ? '</egm-actions>' : opening === '<egm-review>' ? '</egm-review>' : '</dsh-ui>'
      if (!text.startsWith(opening) || !text.endsWith(closing)) return null
      const flowKind = block.closest && block.closest('[data-chat-flow-kind]') ? block.closest('[data-chat-flow-kind]').getAttribute('data-chat-flow-kind') : null
      if (flowKind !== 'assistant-step') return null
      return text.slice(opening.length, -closing.length).trim()
    }

    function rawOf(block) {
      const tagText = tagTextBodyOf(block)
      if (tagText !== null) return tagText
      const pre = block.querySelector ? block.querySelector('pre') : null
      if (!pre) return ''
      return pre.textContent || ''
    }

    function isPlausibleFenceSurface(candidate) {
      if (!candidate || !candidate.querySelectorAll) return false
      const pres = candidate.querySelectorAll('pre')
      if (pres.length > 1) return false
      const pre = pres[0] || null
      const blockTags = candidate.querySelectorAll('p, ul, ol, dl, table, h1, h2, h3, h4, h5, h6, blockquote, hr, img, figure')
      for (const el of blockTags) {
        if (pre !== null && pre.contains(el)) continue
        return false
      }
      return true
    }

    function findReviewCandidates(scope) {
      const targetScope = scope || (typeof document !== 'undefined' ? document : null)
      if (!targetScope || !targetScope.querySelectorAll) return []
      const out = []
      const seen = new Set()

      const surfaces = targetScope.querySelectorAll(INLINE_REVIEW_CODE_BLOCK_SELECTORS)
      for (const el of surfaces) {
        if (seen.has(el)) continue
        if (el.closest && el.closest(INLINE_REVIEW_EXCLUDES) !== null) continue
        const flowKind = el.closest && el.closest('[data-chat-flow-kind]') ? el.closest('[data-chat-flow-kind]').getAttribute('data-chat-flow-kind') : null
        if (flowKind !== 'assistant-step') continue
        if (!isPlausibleFenceSurface(el) || !el.querySelector('pre')) continue

        const raw = rawOf(el)
        if (extractEgmReviewSpec(raw) !== null) {
          out.push({ el, raw })
          seen.add(el)
        }
      }

      const pres = targetScope.querySelectorAll('pre')
      for (const pre of pres) {
        const parent = pre.parentElement
        if (!parent || seen.has(parent)) continue
        if (parent.closest && parent.closest(INLINE_REVIEW_EXCLUDES) !== null) continue
        const flowKind = parent.closest && parent.closest('[data-chat-flow-kind]') ? parent.closest('[data-chat-flow-kind]').getAttribute('data-chat-flow-kind') : null
        if (flowKind !== 'assistant-step') continue
        if (!isPlausibleFenceSurface(parent)) continue

        const raw = rawOf(parent)
        if (extractEgmReviewSpec(raw) !== null) {
          out.push({ el: parent, raw })
          seen.add(parent)
        }
      }

      const spans = targetScope.querySelectorAll('span')
      for (const span of spans) {
        if (seen.has(span)) continue
        if (span.closest && span.closest(INLINE_REVIEW_EXCLUDES) !== null) continue
        // 廉价预筛：绝大多数 span 是普通正文，连 "egm-" 都不含，直接跳过，
        // 避免对每个 span 都做 childElementCount/textContent 读取。
        const hint = (span.textContent || '')
        if (hint.length < 26 || hint.indexOf('egm-') === -1) continue
        const raw = tagTextBodyOf(span)
        if (raw !== null && extractEgmReviewSpec(raw) !== null) {
          out.push({ el: span, raw })
          seen.add(span)
        }
      }

      return out
    }

    function getViewedSessionId(ctx) {
      try {
        const sessions = (ctx && ctx.sessions) || (typeof ctx.get === 'function' && ctx.get('sessions'))
        if (!sessions) return null
        if (sessions.list && typeof sessions.list.getSnapshot === 'function') {
          const snap = sessions.list.getSnapshot()
          if (snap && Array.isArray(snap.ids)) {
            const viewed = snap.ids.filter((id) => {
              if (typeof sessions.retainInfo !== 'function') return false
              const r = sessions.retainInfo(id)
              const s = r && typeof r.getSnapshot === 'function' ? r.getSnapshot() : null
              return s && s.retainedBy && (s.retainedBy.mainView || 0) > 0
            })
            if (viewed.length === 1) return viewed[0]
          }
        }
      } catch {}
      return null
    }

    function checkNodeSessionAffinity(ctx, sessionId, nodeKey, raw) {
      if (!sessionId || getViewedSessionId(ctx) !== sessionId) {
        return { ok: false, reason: '无法确认当前会话，或窗口已切换至其他会话' }
      }
      if (!nodeKey) return { ok: false, reason: '无法确认此按钮所属的消息' }
      try {
        const uiConv = typeof ctx.get === 'function' ? ctx.get('uiConversation', false) : null
        const source = uiConv && uiConv.binding(sessionId).target('chat')
        const snapshot = source && source.getSnapshot()
        const node = snapshot && snapshot.nodes && snapshot.nodes.get(nodeKey)
        if (!node || node.kind !== 'assistant-step') {
          return { ok: false, reason: '此助手消息不属于当前会话' }
        }
        const text = Array.isArray(node.data && node.data.blocks)
          ? node.data.blocks.filter(block => block.kind === 'text').map(block => block.text || '').join('\n')
          : ''
        if (!raw || !text.replace(/\r\n/g, '\n').includes(raw.replace(/\r\n/g, '\n').trim())) {
          return { ok: false, reason: '尚未核实此确认内容，请等待消息显示完整' }
        }
        return { ok: true }
      } catch {
        return { ok: false, reason: '暂时无法核实消息所属的会话' }
      }
    }

    const TASK_ACTIONS = Object.freeze({
      'egm-task-revise': { command: 'revise', label: '按推荐方案修图纸' },
      'egm-task-review': { command: 'review', label: '复核修改部分' },
      'egm-task-proceed': { command: 'proceed', label: '按方案开始实现' },
      'egm-task-hold': { command: 'hold', label: '先暂停' },
      'egm-task-resume': { command: 'resume', label: '继续' },
      'egm-task-complete': { command: 'complete', label: '结项' },
      'egm-task-reopen': { command: 'reopen', label: '重新打开' },
    })
    function taskButtons(spec) {
      const out = []
      const used = new Set()
      function visit(node, depth) {
        if (!node || typeof node !== 'object' || depth > 12) return
        if (node.type === 'button' && TASK_ACTIONS[node.action] && !used.has(node.action)) {
          used.add(node.action)
          out.push({ action: node.action, label: TASK_ACTIONS[node.action].label })
        }
        if (Array.isArray(node.items)) node.items.forEach(item => visit(item, depth + 1))
      }
      visit(spec, 0)
      return out
    }
    function latestAssistantRow(row) {
      const rows = Array.from(document.querySelectorAll('[data-chat-flow-kind="assistant-step"][data-chat-node-key]'))
        .filter(node => !node.closest('[data-sidebar-chat], [data-panel-conversation], [data-plugin-panel], [data-sidebar-right-session]'))
      return rows.length > 0 && rows[rows.length - 1] === row
    }
    function createInlineTaskCard(params) {
      const card = document.createElement('div')
      card.className = INLINE_REVIEW_CARD_CLASS
      card.setAttribute('data-egm-inline-mount', 'true')
      const title = document.createElement('strong')
      title.textContent = params.spec.title || '下一步'
      const actions = document.createElement('div')
      actions.className = 'egm-actions'
      const status = document.createElement('div')
      status.className = 'egm-muted'
      status.setAttribute('role', 'status')
      card.append(title, actions, status)
      for (const item of taskButtons(params.spec)) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'egm-btn' + (item.action === 'egm-task-revise' ? ' egm-btn-primary' : '')
        button.textContent = item.label
        button.addEventListener('click', async event => {
          event.preventDefault()
          if (card.dataset.egmWorking === 'true' || card.dataset.egmDone === 'true') return
          const affinity = params.validateAffinity()
          if (!affinity.ok) { status.textContent = affinity.reason; return }
          card.dataset.egmWorking = 'true'
          for (const b of actions.querySelectorAll('button')) b.disabled = true
          status.textContent = '正在提交所选操作…'
          try {
            const result = await params.onTaskAction(item.action)
            if (!result || !result.ok) throw new Error((result && result.error) || '操作尚未成功')
            card.dataset.egmDone = 'true'
            status.textContent = result.text || '已收到，继续当前方案。'
          } catch (error) {
            status.textContent = (error && error.message) || String(error)
          } finally {
            card.dataset.egmWorking = 'false'
            if (card.dataset.egmDone !== 'true') for (const b of actions.querySelectorAll('button')) b.disabled = false
          }
        })
        actions.appendChild(button)
      }
      return card
    }

    function createInlineReviewCard(params) {
      const spec = params.spec
      const onGrant = params.onGrant
      const onDeny = params.onDeny
      const validateAffinity = params.validateAffinity

      const card = document.createElement('div')
      card.className = INLINE_REVIEW_CARD_CLASS
      card.setAttribute('data-egm-inline-mount', 'true')

      const header = document.createElement('div')
      header.style.display = 'flex'
      header.style.alignItems = 'center'
      header.style.justifyContent = 'space-between'
      header.style.marginBottom = '6px'

      const titleWrap = document.createElement('div')
      titleWrap.style.display = 'flex'
      titleWrap.style.alignItems = 'center'
      titleWrap.style.gap = '6px'

      const badge = document.createElement('span')
      badge.textContent = 'EGM'
      badge.style.fontSize = '10px'
      badge.style.fontWeight = '700'
      badge.style.padding = '1px 5px'
      badge.style.borderRadius = '4px'
      badge.style.background = 'var(--egm-primary, #2563eb)'
      badge.style.color = 'var(--egm-on-primary, #ffffff)'

      const titleText = document.createElement('strong')
      titleText.textContent = (spec && spec.title) || '金鱼评审授权确认'
      titleText.style.fontSize = '13px'

      titleWrap.appendChild(badge)
      titleWrap.appendChild(titleText)
      header.appendChild(titleWrap)
      card.appendChild(header)

      let descString = ''
      if (spec && typeof spec.description === 'string') {
        descString = spec.description
      } else if (spec && typeof spec.content === 'string') {
        descString = spec.content
      } else if (spec && Array.isArray(spec.items)) {
        const textItem = spec.items.find((i) => i && typeof i.content === 'string')
        if (textItem) descString = textItem.content
      }
      if (descString) {
        const descEl = document.createElement('div')
        descEl.textContent = descString
        descEl.style.marginBottom = '8px'
        descEl.style.color = 'var(--egm-text, inherit)'
        card.appendChild(descEl)
      }

      const riskBox = document.createElement('div')
      riskBox.style.fontSize = '12px'
      riskBox.style.color = 'var(--egm-dim, #888888)'
      riskBox.style.marginBottom = '10px'
      riskBox.textContent = '评审助手的只读保护尚未验证，可能访问或修改工作区文件。点击下方按钮即可直接确认，无需复制命令。'
      card.appendChild(riskBox)

      const noticeBox = document.createElement('div')
      noticeBox.style.display = 'none'
      noticeBox.style.fontSize = '12px'
      noticeBox.style.padding = '6px 10px'
      noticeBox.style.borderRadius = '6px'
      noticeBox.style.marginBottom = '8px'
      card.appendChild(noticeBox)

      const showStatus = (text, isError) => {
        noticeBox.style.display = 'block'
        noticeBox.textContent = text
        if (isError) {
          noticeBox.style.background = 'var(--egm-error-bg, rgba(239, 68, 68, 0.15))'
          noticeBox.style.color = 'var(--egm-error, #ef4444)'
        } else {
          noticeBox.style.background = 'var(--egm-success-bg, rgba(34, 197, 94, 0.15))'
          noticeBox.style.color = 'var(--egm-success, #22c55e)'
        }
      }

      const actions = document.createElement('div')
      actions.className = 'egm-actions'
      actions.style.display = 'flex'
      actions.style.gap = '8px'
      actions.style.alignItems = 'center'
      actions.style.flexWrap = 'wrap'

      const grantBtn = document.createElement('button')
      grantBtn.type = 'button'
      grantBtn.className = 'egm-btn egm-btn-primary'
      grantBtn.textContent = '是，允许评审'
      grantBtn.style.cursor = 'pointer'

      const denyBtn = document.createElement('button')
      denyBtn.type = 'button'
      denyBtn.className = 'egm-btn'
      denyBtn.textContent = '否，先不审'
      denyBtn.style.cursor = 'pointer'

      let working = false
      const setWorking = (val) => {
        working = val
        card.dataset.egmWorking = val ? 'true' : 'false'
        grantBtn.disabled = val
        denyBtn.disabled = val
      }

      grantBtn.addEventListener('click', async (e) => {
        if (e && e.preventDefault) e.preventDefault()
        if (working) return

        const affinity = validateAffinity()
        if (!affinity.ok) {
          setWorking(true)
          showStatus(affinity.reason || '会话归属验证未通过，操作已禁用', true)
          return
        }

        setWorking(true)
        grantBtn.textContent = '正在授权…'
        try {
          const result = await onGrant()
          if (result && result.ok) {
            grantBtn.textContent = '已确认授权'
            denyBtn.style.display = 'none'
            if (result.sendOk) {
              showStatus('已确认授权，并已通知 AI 助手继续当前评审任务。', false)
            } else {
              showStatus(
                '已成功授予权限，但向会话发送继续通知失败（' +
                  (result.sendError || '未知错误') +
                  '）；请在输入框提醒助手继续。不得重复点击授权。',
                true,
              )
            }
          } else {
            grantBtn.textContent = '是，允许评审'
            setWorking(false)
            showStatus('授权失败：' + ((result && result.error) || '未知错误'), true)
          }
        } catch (err) {
          grantBtn.textContent = '是，允许评审'
          setWorking(false)
          showStatus('授权出现异常：' + ((err && err.message) || String(err)), true)
        }
      })

      denyBtn.addEventListener('click', async (e) => {
        if (e && e.preventDefault) e.preventDefault()
        if (working) return

        const affinity = validateAffinity()
        if (!affinity.ok) {
          setWorking(true)
          showStatus(affinity.reason || '会话归属验证未通过，操作已禁用', true)
          return
        }

        setWorking(true)
        denyBtn.textContent = '正在取消…'
        try {
          const result = await onDeny()
          if (!result || !result.ok) throw new Error((result && result.error) || '尚未确认撤销成功')
          denyBtn.textContent = '许可已关闭'
          grantBtn.style.display = 'none'
          showStatus(result.sendOk
            ? '本轮评审许可已关闭，并已通知助手。'
            : '本轮评审许可已关闭，但未确认通知送达：' + (result.sendError || '未知原因'), !result.sendOk)
        } catch (err) {
          denyBtn.textContent = '否，先不审'
          setWorking(false)
          showStatus('取消操作失败：' + ((err && err.message) || String(err)), true)
        }
      })

      actions.appendChild(grantBtn)
      actions.appendChild(denyBtn)
      card.appendChild(actions)

      return card
    }

    function installInlineReviewRenderer(ctx, opts) {
      const options = opts || {}
      const hostCmd = options.executeHostCommand || executeHostCommand
      const pollFn = options.triggerImmediatePoll || triggerImmediatePoll
      const activeMounts = new Map()
      let sourceSession = null
      let sourceDispose = null
      function followSource() {
        const sessionId = getViewedSessionId(ctx)
        if (sessionId === sourceSession && sourceDispose) return
        if (typeof sourceDispose === 'function') sourceDispose()
        sourceDispose = null
        sourceSession = sessionId
        if (!sessionId) return
        try {
          const ui = typeof ctx.get === 'function' ? ctx.get('uiConversation', false) : null
          const source = ui && ui.binding(sessionId).target('chat')
          if (source && typeof source.subscribe === 'function') sourceDispose = source.subscribe(scheduleSweep)
        } catch {}
      }

      function processCandidate(el, raw) {
        if (activeMounts.has(el) || el.closest(INLINE_REVIEW_EXCLUDES)) return
        const spec = extractEgmReviewSpec(raw)
        if (!spec) return
        const isTaskCard = !hasEgmActionInObj(spec) && taskButtons(spec).length > 0

        const row = el.closest ? el.closest('[data-chat-node-key]') : null
        const nodeKey = row ? row.getAttribute('data-chat-node-key') : null
        const sessionId = getViewedSessionId(ctx)
        const initialPool = pools.get(sessionId)
        const initialTask = initialPool && initialPool.snapshot && initialPool.snapshot.task
        const expectedTaskId = spec.taskId || (initialTask && initialTask.id)
        // 卡片绑定"方案版本"（specRevision），而不是记录版本（revision）：普通聊天与
        // rev review/hold 等动作只动 revision，不再让老卡片报废；只有实质改需求才换版本。
        // 旧格式卡片没有 specRevision 时退回 revision，继续按老规则校验（保守但兼容）。
        const hasSpecVersion = spec.taskRevision != null
        const expectedTaskRevision = hasSpecVersion
          ? spec.taskRevision
          : (spec.revision != null ? spec.revision : initialTask && initialTask.revision)

        const validateAffinity = () => {
          if (!el.isConnected || !row || row.getAttribute('data-chat-node-key') !== nodeKey || rawOf(el).trim() !== raw.trim()) {
            return { ok: false, reason: '原消息已经变更，请使用当前消息中的按钮' }
          }
          const result = checkNodeSessionAffinity(ctx, sessionId, nodeKey, raw)
          if (!result.ok || !isTaskCard) return result
          if (!spec.taskId && !latestAssistantRow(row)) return { ok: false, reason: '这是较早的操作卡，请使用最新回复中的按钮' }
          const pool = pools.get(sessionId)
          const current = pool && pool.snapshot && pool.snapshot.task
          const bindKey = hasSpecVersion ? 'specRevision' : 'revision'
          if (!expectedTaskId || expectedTaskRevision == null || !current || expectedTaskId !== current.id || String(expectedTaskRevision) !== String(current[bindKey])) {
            return { ok: false, reason: bindKey === 'specRevision' ? '方案已更新，请使用当前修订的操作按钮' : '方案已更新，请使用当前修订的操作按钮' }
          }
          return result
        }

        if (!validateAffinity().ok) return

        const changeAccess = async (allow) => {
          const affinity = validateAffinity()
          if (!affinity.ok) return { ok: false, error: affinity.reason }
          const command = allow ? '/egm-review-access 确认无隔离' : '/egm-review-access revoke'
          const res = await hostCmd(ctx, sessionId, command)
          if (!res || !res.ok) {
            return { ok: false, error: (res && res.error) || '尚未确认命令执行成功' }
          }
          // The permission is already changed. A poll/send error must not ask for another grant.
          try { if (typeof pollFn === 'function') pollFn(sessionId, ctx) } catch {}
          const stillCurrent = validateAffinity()
          if (!stillCurrent.ok) return { ok: true, sendOk: false, sendError: stillCurrent.reason }
          try {
            const notified = await hostCmd(ctx, sessionId, '/egm-review-access notify ' + (allow ? 'grant' : 'deny'))
            return notified && notified.ok
              ? { ok: true, sendOk: true }
              : { ok: true, sendOk: false, sendError: (notified && notified.error) || '内部继续通知未送达' }
          } catch (err) {
            return { ok: true, sendOk: false, sendError: (err && err.message) || String(err) }
          }
        }
        const onGrant = () => changeAccess(true)
        const onDeny = () => changeAccess(false)

        const onTaskAction = async (action) => {
          const affinity = validateAffinity()
          if (!affinity.ok) return { ok: false, error: affinity.reason }
          const reply = await ctx.connection.rpc.call(CHANNEL, STATE_METHOD, { sessionId })
          if (!reply || reply.ok !== true) return { ok: false, error: '读取当前方案失败，请稍后再点' }
          const state = normalizeState(reply.value, sessionId)
          const task = state.task
          if (!task || task.status === 'archived') return { ok: false, error: '当前没有可接续的方案，请先启动 EGM' }
          const bindKey = hasSpecVersion ? 'specRevision' : 'revision'
          if (expectedTaskId !== task.id || String(expectedTaskRevision) !== String(task[bindKey])) {
            return { ok: false, error: bindKey === 'specRevision' ? '方案已更新，请使用当前修订的操作按钮' : '方案已更新，请使用当前修订的操作按钮' }
          }
          const stillCurrent = validateAffinity()
          if (!stillCurrent.ok) return { ok: false, error: stillCurrent.reason }
          // 命令里用方案版本（specRevision）：后端 applyTaskAction 按 specRevision 校验；
          // 旧格式卡片（无 spec.taskRevision）继续传 revision，后端同样接受该字段名。
          const versionArg = hasSpecVersion
            ? String(task.specRevision != null ? task.specRevision : task.revision)
            : String(task.revision)
          const result = await hostCmd(ctx, sessionId, '/egm-action ' + TASK_ACTIONS[action].command + ' ' + task.id + ' ' + versionArg)
          try { pollFn(sessionId, ctx) } catch {}
          return result
        }
        const card = isTaskCard
          ? createInlineTaskCard({ spec, validateAffinity, onTaskAction })
          : createInlineReviewCard({ spec, sessionId, nodeKey, onGrant, onDeny, validateAffinity })

        const originalDisplay = el.style.display
        const hadProcessed = el.hasAttribute(INLINE_REVIEW_PROCESSED_ATTR)
        const sibling = el.nextElementSibling
        // Legacy EGM-only confirmation already drawn by GenUI: hide that view,
        // retain its root, and handle the exact two actions here without a chat send.
        const legacyContainer = sibling && sibling.classList && sibling.classList.contains('genui-dom-fence') ? sibling : null
        const legacyDisplay = legacyContainer ? legacyContainer.style.display : null
        if (legacyContainer) legacyContainer.style.display = 'none'
        el.style.display = 'none'
        el.setAttribute(INLINE_REVIEW_PROCESSED_ATTR, 'true')
        el.setAttribute(INLINE_REVIEW_EGM_ATTR, 'true')

        if (el.parentElement) {
          el.parentElement.insertBefore(card, el.nextSibling)
        }

        activeMounts.set(el, { card, originalDisplay, raw, validateAffinity, hadProcessed, legacyContainer, legacyDisplay })
      }

      function sweep() {
        if (typeof document === 'undefined' || !document.body) return
        followSource()
        for (const [el, mount] of activeMounts) {
          if (!el.isConnected || !mount.card.isConnected || rawOf(el).trim() !== mount.raw.trim()) {
            mount.card.remove()
            el.style.display = mount.originalDisplay || ''
            if (!mount.hadProcessed) el.removeAttribute(INLINE_REVIEW_PROCESSED_ATTR)
            el.removeAttribute(INLINE_REVIEW_EGM_ATTR)
            if (mount.legacyContainer) mount.legacyContainer.style.display = mount.legacyDisplay || ''
            activeMounts.delete(el)
          } else if (!mount.validateAffinity().ok) {
            for (const button of mount.card.querySelectorAll('button')) button.disabled = true
            mount.card.title = '原消息所属会话已不可核实，请使用当前会话中的确认按钮'
          } else if (mount.card.dataset.egmWorking !== 'true' && mount.card.dataset.egmDone !== 'true') {
            for (const button of mount.card.querySelectorAll('button')) button.disabled = false
            mount.card.title = ''
          }
        }
        const candidates = findReviewCandidates(document.body)
        for (const item of candidates) {
          processCandidate(item.el, item.raw)
        }
      }

      let sweepTimer = null
      function scheduleSweep() {
        if (sweepTimer) return
        sweepTimer = setTimeout(() => {
          sweepTimer = null
          sweep()
        }, 60)
      }

      let observer = null
      if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined' && document.body) {
        observer = new MutationObserver((mutations) => {
          let shouldScan = false
          for (const m of mutations) {
            const target = m.target instanceof Element ? m.target : m.target && m.target.parentElement
            if (!target) continue
            if (target.closest && target.closest('.' + INLINE_REVIEW_CARD_CLASS + ', [data-egm-inline-mount]')) continue
            if (target.closest && target.closest('[data-composer-seat], [data-composer-input], [data-chat-group-part="reasoning"]')) continue
            shouldScan = true
            break
          }
          if (shouldScan) {
            scheduleSweep()
          }
        })

        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true,
          attributeFilter: ['class', 'data-chat-node-key', 'data-chat-flow-kind', 'data-streaming'],
        })
      }

      sweep()

      return function dispose() {
        if (typeof sourceDispose === 'function') sourceDispose()
        sourceDispose = null
        sourceSession = null
        if (observer) {
          observer.disconnect()
          observer = null
        }
        if (sweepTimer) {
          clearTimeout(sweepTimer)
          sweepTimer = null
        }
        for (const [el, mount] of activeMounts.entries()) {
          try {
            if (mount.card && mount.card.parentElement) {
              mount.card.parentElement.removeChild(mount.card)
            }
            el.style.display = mount.originalDisplay || ''
            if (!mount.hadProcessed) el.removeAttribute(INLINE_REVIEW_PROCESSED_ATTR)
            el.removeAttribute(INLINE_REVIEW_EGM_ATTR)
            if (mount.legacyContainer) mount.legacyContainer.style.display = mount.legacyDisplay || ''
          } catch {}
        }
        activeMounts.clear()
      }
    }

    return {
      inject: ['slots', 'connection', 'sessions', 'remote', 'remote.commands'],
      apply(ctx) {
        ensureStyle()
        EgmDock.ctx = ctx
        // 宿主输入栏左侧工具栏插槽，与专家插件 @michengai/dsh-agency-agents 同行布局。
        // 面板通过 ReactDOM.createPortal 挂载到 document.body 并采用 fixed 坐标，
        // 彻底摆脱 Claude 插件及宿主输入框祖先容器的 transform / overflow 裁剪。
        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.left',
              id: 'dsh-egm-pet',
              order: 10,
              label: () => COPY.title,
              inject: (sessionId) => ({ sessionId }),
            },
            EgmDock,
          ),
        )

        const inlineReviewDispose = installInlineReviewRenderer(ctx, {
          executeHostCommand,
          triggerImmediatePoll,
        })
        if (typeof ctx.on === 'function') {
          ctx.on('dispose', () => {
            if (typeof inlineReviewDispose === 'function') inlineReviewDispose()
          })
        }
        return () => {
          if (typeof inlineReviewDispose === 'function') inlineReviewDispose()
        }
      },
      // 给单测用的纯函数入口（不参与宿主行为）。
      __test: {
        visiblePets,
        elephantBusy,
        busyText,
        groupObstacleLines,
        chooseDockPlacement,
        launchCommand,
        choosePillPlacement,
        choosePanelGeometry,
        composerStackOf,
        composerSeatOf,
        resolveComposerCard,
        entryNoticeLabel,
        findDockCeiling,
        mutationTouchesComposer,
        freeIntervals,
        stateText,
        chipTone,
        normalizeElephant,
        readDraftSnapshot,
        modeDraft,
        modeBlocksSend,
        installSubmitGate,
        releaseSubmitGate,
        readComposerState,
        plainDraft,
        readPhase,
        draftSetter,
        isComposingComposer,
        readLaunchPreference,
        writeLaunchPreference,
        chooseMarkPlacement,
        findMascotStand,
        resolveAnchoredPosition,
        clampToViewport,
        getReviewAccessStatus,
        executeHostCommand,
        triggerImmediatePoll,
        COPY,
        normalizeState,
        ReviewAuthSection,
        extractEgmReviewSpec,
        tagTextBodyOf,
        rawOf,
        isPlausibleFenceSurface,
        findReviewCandidates,
        getViewedSessionId,
        checkNodeSessionAffinity,
        createInlineReviewCard,
        installInlineReviewRenderer,
      },
    }
  },
})
