# dsh-egm · the gate before you build

> An elephant writes the spec, a goldfish tears it apart, you decide — then code gets written.
> Adapted from [google/elephant-goldfish-model](https://github.com/google/elephant-goldfish-model) (Apache-2.0).
> A verbatim mirror of the upstream material lives under `vendor/egm/`; the DSH adaptation is
> `skills/egm-gate` / `egm-review`, the `skills/egm-classic-*` skeletons, and the dispatch mapping in `lib/`.

**Where things stand (read this first)**: the upstream material is saved and byte-verified against the pinned upstream commit (in the **source tree**; npm package contents differ slightly, see below), but **the full upstream workflow, read-only isolation, and end-to-end runs have not been verified**. Dispatch is refused by default; it can only run as an explicitly **non-isolated review** after you authorize it via the reply prompt "Yes/Allow" click, the GUI "允许本轮评审" button, or type `/egm-review-access 确认无隔离` (or `/egm-unsafe 确认无隔离` with the full confirmation phrase). **Real read-only has never been proven, and the 0.1/0.2 releases marketed the gating as a "hard lock" — those claims have been retracted, so any trust placed in the old docs is a bypass risk.** Commands, roles, and capabilities described here follow `lib/dispatch.js` and `resources/classic-*.md` — the code changes.

## 0.8.6 Continue the Same Elephant and Use Direct Actions

The launch choice is remembered automatically. After the initial request is submitted, EGM removes its owned `/egm` prefix; ordinary follow-up messages continue the same elephant and design. Task identity, phase and command revisions are saved per session and workspace. The current-task panel can explicitly archive the old task and wait for a new request. Revision numbers identify stale actions; they are not an editing quota.

Present review results, source evidence and a concrete repair proposal before EGM-owned action buttons. No next-step questionnaire or second submit is required. Goldfish review independently; the elephant verifies findings and revises design documents. Revising a design does not authorize source-code edits. The implementation action explicitly requests implementation within the approved scope. Disproven findings do not block progress, and unverified findings remain uncertain.

The adapted rules no longer impose two design revisions or one follow-up review per stage. Repeated lack of progress calls for a concrete explanation and a revised approach. Actual review access expiry and call counts remain separate. Task actions do not grant review permissions.

No tests are run for this update, as requested. Installation and hot-load receipts establish code delivery; actual clicks and model behavior remain separate observations.

## 0.8.5 Confirmation Notices, Work Status, and Decision Order

Reply approvals use EGM-owned `egm-review` blocks, while older EGM confirmation blocks remain supported. A click changes the bound session's actual access first, then notifies the AI through a default-collapsed context notice instead of an ordinary user action message. Notification failures remain separate from access results; grants are not repeated, and composer drafts and attachments are preserved.

The working elephant supports both whale and crab mascots in Claude themes, with a fallback anchored to the current composer card. The bottom bar shows “金鱼在忙” only for actually running reviews. Ordinary chat, finished jobs, and stale state do not imply EGM activity.

Adapted workflows now require visible review findings, evidence, and a recommended repair plan before a user decision. Missing evidence, failed reviews, unresolved findings, and passed checks are distinguished. Unsupported risk-acceptance shortcuts and compulsory third choices must not replace a review explanation. Existing valid authorization is reused while its scope remains unchanged; follow-up reviews focus on changes and affected concerns. Live page behavior and complete review runs retain separate verification status.

## 0.8.4 Built-in Reply Approval Buttons

EGM renders its own dedicated Yes/Allow and No/Not now buttons without requiring GenUI. It recognizes EGM approval specs in host code blocks and literal `<dsh-ui>…</dsh-ui>` text. A click first runs the real command for the bound session, then notifies the AI to continue the existing task, preserving composer drafts and attachments. Command failures and continuation failures are shown separately; ordinary chat affirmations do not authorize reviews. Collapsed kickoff procedures and panel/terminal fallbacks remain. Implementation, installation, and actual browser clicks have separate verification status.

## 0.8.3 Dedicated Reply Button Approval, Elephant Mode Command Filtering, and Concise Kickoff

- **Dedicated Reply Button Approval**: When the elephant asks for goldfish review approval, the user clicks the dedicated "Yes / Allow" button directly on the AI reply card (or "No" to deny) to grant genuine non-isolated review permission, eliminating the need to copy commands or locate the EGM panel. Plain text messages such as "yes", "ok", or "cancel" will not alter review permits; explicit commands and panel controls remain fully supported.
- **Elephant Mode Command Filtering**: EGM authorization, revocation, and related control commands are recognized and filtered, preventing internal control directives from being mistaken for user requirement text in specs or kicking off flows (exact supported command scope subject to final implementation report).
- **Concise Kickoff Messages**: `/egm` requirements and concise hints display normally in the conversation stream, while detailed procedures are supplied via default-collapsed context injection notices that the AI still reads, preventing complete rule texts from cluttering chat history.
- **Honest Boundaries**: Subagent read-only remains unprovable; all reviews remain explicitly marked `strictGoldfishReview:false`. Dedicated reply button clicks, command filtering, and rendering on live DSH browser pages remain unverified; plain typing does not grant permissions.

## 0.8.2 Reuse Claude Mascot and Popover Placement

The bottom EGM entry is retained. The working elephant adapts [dsh-claude-style](https://github.com/Nwflower/dsh-claude-style)'s mascot mounting and CSS placement, sharing the current whale's parent container and appearing immediately to its left. It only appears for genuine EGM work in the current session; cleanup removes only EGM-owned nodes.

Panels anchor to the clicked entry and adapt the theme's popover flipping and viewport clamping. Failing to measure an input card no longer prevents opening. Launch modes, drafts, attachments, review access and IME protections remain. Error tooltips identify the actual reason and client version.

Adapted sources are pinned to `a0059bde45f968b246bf05c9bb6b87a4a592189b`; attribution and the MIT license are in `lib/claude-mascot-license.txt`. Local tests, installed files, served bundles and interaction on the user's page are verified separately.

## 0.8.1 Layout Fixes

The bottom entry is retained. Panels measure visible progress-dock content instead of treating the welcome area or the working elephant's transparent box as a full-width obstacle. The working-elephant portal is included in the rendered tree, and whale anchors are scoped to the current composer. Small panels keep their full content scrollable, including launch and review-access controls. Rendering and mouse interaction on the actual DSH page remain unverified.

## 0.8.0 Newcomer Interaction: 4-Step Flow & Dual Launch Modes

In version 0.8.0, the bottom EGM entry is retained and upgraded to introduce the core 4-step EGM flow to first-time users:
**Describe requirements → Elephant prepares spec → User authorizes goldfish review → Inspect reports / User adjudication**
(`描述需求 → 大象整理方案 → 用户允许金鱼评审 → 看报告/用户裁决`).

### Dual Launch Modes & Entry Retention
- **Dual launch modes retained**: Clicking the EGM launch entry opens a modal chooser:
  1. **Dialog Mode**: Writes directly into the native DSH composer with a submit guard and image attachment support, automatically prefixed with `/egm`. A working elephant shares the current whale's parent container and sits to its left; the bottom entry is retained, and the working elephant state and animation only appear when truly meeting live && working && workingOnEgm.
  2. **Card Mode**: A standalone compact card above the composer for pure text input, leaving the composer untouched.
- **Choice Memory**: Ticking "Don't ask again" stores the selection in browser `localStorage` under `egm.launchMode`.
- **Switching & Reset**: Users can switch launch modes at any time via the elephant icon beside the composer, the "Switch mode" button on the card, or by right-clicking the bottom EGM entry. Switching cleans up previous composer prefixes.
- **Entry Retention**: The bottom EGM entry is permanently retained. On first click, it explains the 4-step flow; in subsequent launches, it triggers the remembered launch mode directly.
- **Submit Guard Caveat**: Dialog mode's composer submit-guard relies on internal host APIs. Replacing those APIs or a host upgrade can bypass it until the plugin detects the change; there is no zero-window guarantee. Text-plus-image handling has unit tests, but live DSH-page image delivery remains unverified.

---

## The problem

You ask an agent for a small tool. It says "sure", then writes 400 lines.
Only after running it do you learn nobody thought about disconnects, name collisions, or what "done" means.
Fixing that costs more than rewriting.

This plugin puts a gate between *thinking it through* and *typing code*:

```
spec (elephant) → zero-context critique (goldfish) → you decide → build
```

## Install

Either entry works:

- **GUI**: Settings → Plugins → Add plugin → paste the **absolute path** of this directory
- **CLI**: `dsh plugin add <absolute path of this directory>`

Open a new session afterwards; `egm-gate` / `egm-review` / `egm-classic-*` should appear in the skill list. Which commands and skills are actually registered is decided by the current `lib/index.js` and `lib/skill-provider.js` code.

> **Path reference standard**: Skill documents specify that `resources/`, `agents/`, and `vendor/` are relative to the **plugin package root**, not the SKILL.md directory. If missing, inspect the provided absolute inventory list; hallucinating template replacements is strictly prohibited.

## Use (Dedicated Reply Button Priority with Panel and Command Fallbacks)

Dispatching goldfish requires user authorization (Fail-Closed default rejection). Version 0.8.3 prioritizes one-click approval directly via dedicated "Yes / No" buttons on AI reply cards; plain typing of "yes/ok/cancel" will not alter permits. Panel buttons and terminal command channels remain available as fallbacks:

1. **Dedicated Reply Button Authorization (Primary Recommended)**: When the elephant requests goldfish review, click the dedicated "Yes / Allow" button on the AI reply card (or "No" to reject) to grant the 2-hour / 20-dispatch window and 10-minute / 6-use non-isolated permit in a single action, without copying commands or searching for the panel. Plain text chat messages do not trigger authorization.
2. **GUI Panel Authorization (Alternative)**: In the "Review Access" ("评审许可") section of the EGM panel, check the risk acknowledgement checkbox, and click "允许本轮评审" ("Allow this review round"). Displays remaining permits and a countdown timer in real time.
3. **One-Key Authorization Command**:
   - `/egm-review-access 确认无隔离` (or `grant 确认无隔离`): Opens the dispatch window (2 hours / max 20 dispatches) and grants the non-isolated permit (10 minutes / max 6 uses) in one command.
   - `/egm-review-access revoke`: Revokes the permit and closes the dispatch window without terminating currently executing review tasks.
4. **Step-by-Step Fallback Commands (No-UI / Terminal)**:
   - `/egm <one sentence of what you want>` — the manual entry point; opens the dispatch window (2 hours, ≤20 dispatches) **and** kicks off the fast-gate flow.
   - `/egm-open` — **opens the window only, starts nothing**: opens the dispatch window (2 hours, ≤20 dispatches) without kickoff or permits, for `egm-classic-*` scenarios. Returns `E_GATE_NOT_OPEN` if not opened.
   - `/egm-unsafe 确认无隔离` — grants a short-lived non-isolated permit (10 minutes, ≤6 uses) upon exact confirmation. Returns `E_READONLY_UNVERIFIED` if unauthorized.
   - `/egm-safe` — revokes the permit and closes the dispatch window.
5. `egm_dispatch` and `egm_dispatch_batch` **refuse by default** (fail-closed): subagent read-only-ness cannot be proven — outer host tools may be irremovable and subagents inherit the parent permission root — so with no permit it returns `E_READONLY_UNVERIFIED` and creates no room, dispatches nothing. (Missing permit is an own-permission rejection, not a router conflict with `dsh-subagent-router`).
6. **A permit is not isolation**: every result is labeled `strictGoldfishReview:false` (non-isolated review) and reports must state that read-only was unverified.
7. **Quota Pre-check & 9-Fish Mid-Flow Renewal**: `egm_dispatch_batch` pre-checks remaining permits before dispatch; if quota < `tasks.length`, the batch is rejected fail-closed. An independent spawned fresh synthesis subagent aggregates reports without consuming goldfish quota. **The classic 5-phase 9-fish workflow (9 dispatches total) consumes 5 permits across Stages 5–7; with only 1 permit remaining from a 6-use grant, Stages 8–9 (requiring 4 permits) will be rejected unless the user explicitly renews authorization mid-flow (the system never auto-replenishes quotas)**. `manifest.allPassed: true` only means all task reports completed; `manifest.partial: true` explicitly represents gaps. Mock review in main session is strictly forbidden.

Honest boundaries:

- Command and panel gating are **in-plugin state, not a platform permission boundary**. `egm-gate` is `model-invocable: false`: the skill file is only read when the user names it (`/egm-gate`) or when `/egm` starts the flow. But **this is not a hard limit on model behavior or file access** — the file lives inside the package, so the model can still read it directly, write the spec itself, or skip review and code straight away; the only thing actually refused by default is dispatch.
- Cards and checkpoints are **conventions the model executes, not platform-enforced mechanisms**; review records live under `.egm/` with no promised file count and no unbacked wall-clock timing promises.

## The original EGM (`vendor/egm/`)

`vendor/egm/` is a **verbatim mirror** of the upstream EGM: 121 files matching upstream commit `a8380ab5f0aba392c97e31c79f9a6666b3f09f14` byte for byte (verify with `cd vendor/egm && sha256sum -c SHA256SUMS`). The byte-for-byte verification holds for the **source tree only**: `npm pack` auto-excludes `vendor/egm/.gitignore`, so npm package contents are not identical to the source directory — verify against the source tree, not the npm package. It contains 7 skill packages, 9 reviewer persona cards, 5 document standards, plus the upstream docs and pytest suite. Two upstream pytest files, `test_frontmatter.py` and `test_scenario_coverage.py`, have actually been run and passed (2 passed), **validating only the upstream skill declarations and scenario coverage**; the other upstream tests were not run.

| Upstream skill | Stage | What it does |
| --- | --- | --- |
| egm-bootstrap | standalone | generate/verify EGM-compliant READMEs across a tree |
| egm-brainstorm | ideation | clarifying questions + goldfish review → `concepts_brief` |
| egm-draft | drafting | draft the design document section-by-section against the standards |
| egm-review | review | the five-phase review protocol (phases 5–9) |
| egm-review-loop | loop | orchestration driver for the antagonistic review loop |
| egm-resolve | resolve | the elephant adjudicates findings and fixes the doc |
| egm-drift-report | hindsight | check design docs against code, report drift |

The full upstream flow: brainstorm → draft → review (or review-loop) → resolve → drift-report; bootstrap is independent. **These texts are reference material, not a runtime that works in DSH as-is**: their host assumptions do not hold here. What runs in DSH is the adapted skeleton below — **it is not a lossless replica of upstream**; the equivalence statement is explicit.

## The DSH adaptation (what runs, what does not)

`resources/classic-fidelity.md` is the authoritative list; summarized here:

**Adapted skills** (all `model-invocable: false`; they run only when you name them):

- `egm-classic-review` — the upstream five-phase review (phases 5–9). Stages 7 & 9 prioritize `egm_dispatch_batch` (concurrency: 3) with independent fresh synthesis; single roles use `egm_dispatch`. One full five-phase pass = 9 dispatches, requiring mid-flow renewal after Stage 7. Intra-phase concurrency does not equal end-to-end equivalence.
- `egm-classic-review-loop` — the adversarial loop (multi-role batches prioritize `egm_dispatch_batch`, single roles use `egm_dispatch`).
- `egm-classic-brainstorm` — concept brainstorming: clarifying questions and anchored assumptions first, then dispatched via `egm_dispatch_batch` across 6 lenses (concurrency: 3) and aggregated into `concepts_brief.md` by independent fresh synthesis.
- `egm-classic-draft` — draft the design doc section-by-section, pausing for your approval after each section; no goldfish, no permit needed.
- `egm-classic-resolve` — the elephant adjudication (CONTEST / ESCALATE / PROPOSE FIX / DECLINE); no goldfish, no permit needed.
- `egm-classic-drift-report` — drift check; pure reads + a report, no goldfish.
- `egm-classic-bootstrap` — repo documentation bootstrap: BFS directory scan, downgraded to serial batches.

**Dispatch channel & material control**:
- `egm_dispatch` for single role; `egm_dispatch_batch` for 1..6 tasks batch concurrent dispatch (default concurrency 3, max 3, shared snapshot, fresh synthesis agent aggregation).
- `range={start,end}`: trims a genuine slice copy and maps original line numbers. Clarification: upstream review-loop used prompt-only instructions without strong trimming guarantee; local trimming is physical text slicing, but physical slicing is not system permission isolation (`strictGoldfishReview:false`).
- `sources`: restricted strictly to regular files copied to room (directories prohibited), minimal materials per role.
- `materials`: stage deliverables copied into review room (≤10 files).

**Not supported — do not claim**:

- "strict goldfish review" / "isolated" — read-only cannot be proven.
- "equivalent to the upstream egm_review five phases" — the tool itself returns `flowEquivalent:false`.
- "physical trimming equals sandbox isolation" — physical slice copy is not permission isolation.
- "partial counts as passed" or "allPassed means design passed" — `allPassed` only means reports completed; `partial` retains gaps and errors; main session mock review is prohibited.
- "all upstream tests pass" — only two upstream pytest files were run.

## Original vs. the DSH port (summary)

| | Upstream EGM | dsh-egm |
| --- | --- | --- |
| Runtime | upstream hosts (Claude/Codex etc.) | DSH; upstream texts are reference only, the adapted skeleton is separate |
| Dispatch | each host's own subagent tools | `egm_dispatch` / `egm_dispatch_batch`: refused by default, needs user authorization via panel button, `/egm-review-access`, or `/egm-unsafe` |
| Read-only | claims read-only subagents | **cannot be proven**; results labeled `strictGoldfishReview:false` |
| Scope | line ranges instruction (upstream lacks strong trimming guarantee) | Real slice copy trimmed with line mapping; not permission isolation (`strictGoldfishReview:false`) |
| Orchestration & Concurrency | parallel review / review-loop / brainstorm + synthesizer | Stage 7/9, review-loop, brainstorm prioritize `egm_dispatch_batch` concurrency + fresh synthesis subagent; cross-stage orchestrated by skill, no whole-flow equivalence claim |
| Equivalence | — | **explicitly not equivalent** (`flowEquivalent:false`) |
| Maturity | upstream real project | DSH side is **not end-to-end tested** |

## What it is not

- **Not a smarter reviewer.** By default it is the same model with a fresh context.
- **Not exhaustive**, and **no promises about review speed or file counts**.
- **Not a code writer.** Spec and critique only.
- **Commands and `model-invocable` flags are not hard limits.**
- **Not a lossless replica of upstream**: the tool explicitly denies equivalence.

## Layout

```
skills/egm-gate/       the gate before building (multi-role tiers prioritize batch dispatch + fresh synthesis)
skills/egm-review/     critique an existing doc (multi-role tiers prioritize batch dispatch + fresh synthesis)
skills/egm-classic-*/  DSH-adapted skeletons of the upstream flow (Stage 7/9, loop, brainstorm prioritize batch)
agents/                4 compatibility zero-context roles: logic, feasibility, implementer restatement, synthesis
resources/             spec template, defect schema, gate rules + classic-dispatch / classic-stages /
                       classic-fidelity / classic-report-format (adaptation contracts and boundaries)
lib/                   skill registration, goldfish preset, /egm commands and review access management, egm_dispatch & batch mapping
vendor/egm/            verbatim upstream EGM (pin a8380ab, 121 files, SHA256SUMS)
tests/                 local dispatch / skill-provider / plugin-entry tests (maintainer-run)
```

## Untested limitations — honest list

- **No real end-to-end run of the full workflow.**
- **Read-only is unverified, with a legacy-claims bypass risk.**
- **Path reference standard**: `resources/`, `agents/`, `vendor/` are relative to plugin package root, not SKILL.md directory. Missing files must be reviewed via absolute inventory list, never hallucinated.
- **Working elephant animation**: real working-state animation in conversation, but live-machine acceptance must not be claimed.
- **0.8.3 Interactive & filtering live acceptance**: Dedicated reply button clicks, elephant mode control command filtering, and streamlined kickoff messages have aligned specifications, but plain typing does not authorize; live clicks, command interception, and rendering on actual DSH browser pages remain unverified.

## License

Apache-2.0. `vendor/egm/` is a verbatim mirror of Google's [elephant-goldfish-model](https://github.com/google/elephant-goldfish-model) at commit `a8380ab5f0aba392c97e31c79f9a6666b3f09f14`, copyright the upstream authors. The DSH adaptation is an independent implementation, not affiliated with Google.
