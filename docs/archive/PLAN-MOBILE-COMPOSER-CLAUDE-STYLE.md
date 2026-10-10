# PLAN-MOBILE-COMPOSER-CLAUDE-STYLE.md

Rebuild the **phone input panel** (≤560px) following the Claude mobile composer
pattern — one compact bar, tools in bottom sheets — **adapted to Moriko**, not
copied blindly. Desktop layout stays exactly as it is (see guardrails).

## Design source

- Reference: Claude mobile app composer (compact single row; model & tools in
  bottom sheets with a drag handle).
- Target mockups (user-provided, Moriko-branded):
  1. **Composer bar** — textarea, then ONE row: `[+]` · `model · effort ˅` pill · send `[↑]`; "Pick workspace" chip moved to the top bar.
  2. **MODEL / EFFORT sheet** — drag handle; "MODEL" list with checkmark (`deepseek-v4-pro-max ✓`); "EFFORT" segmented control (`Low | Medium | High`).
  3. **ALAT sheet** — rows with icons + toggles: `Lampirkan file`, `Mode lihat`, `Mode target`, `Izinkan alat`.
- User rule: **improvise and adapt to Moriko** — do not copy blind.

## Audit — current phone composer (state today)

| Fact | Detail |
| --- | --- |
| Layout | ≤560px: two rows — row 1 icons (cat-eye, attach, goals, tools) + actions (ctx, send); row 2 chips (workspace, model·effort). |
| Popovers | `[data-tools-popover]`, `[data-model-popover]`, `[data-context-popover]` become `position: static` full-width inline panels on phones — they *push content* and feel heavy. |
| Tools inventory | `ToolRow` items: Web Access, Structured outputs, Use MCP, Fetch Web, Terminal mode (off/ask/auto), Confirm deletes. |
| Effort | `thinkingLadderFor(modelMeta, providerId, model)` ladder + `THINKING_COPY[level].label` (can exceed 3 levels). |
| Model pill | name truncated at 76px on phones. |
| Workspace chip | lives in the composer row 2 (`Pick workspace` / label). |
| Targets | `.icon-button` 44px on coarse pointers (already enforced). |

## What we take from Claude / what we deliberately change

| Take | Adapted / rejected for Moriko |
| --- | --- |
| Single compact bar: `+` · model pill · send | Claude's voice input → **skip v2** (not core). |
| Bottom sheets with drag handle + backdrop | Claude's "+" is file-only → Moriko's ALAT sheet keeps **mode toggles & agent tools** (agent feature set). |
| Model list with checkmark | Moriko groups by **provider** + keeps the thinking **effort ladder** (not two hardcoded rows). |
| Effort segmented control | Ladder may exceed 3 levels → segmented control scrolls horizontally. |
| Model name prominent, not truncated | Pill uses **smart abbreviation** (strip provider prefix: `deepseek-ai/deepseek-v4-pro-max` → `deepseek-v4-pro-max`); sheet shows **full names**. |
| Minimal chrome | Moriko **keeps** ContextChip (context % is a real feature), streaming Stop/Steer/Reminder buttons, jump nav. |

## Target anatomy (phone ≤560px)

**A. Composer card** (one bar, all targets ≥44px, safe-area aware):

```
┌────────────────────────────────────┐
│ Ask Moriko anything…   (auto-grow) │
│ [+][deepseek-v4-pro · High ˅][ ↑ ] │
└────────────────────────────────────┘
```

- `+` → ALAT sheet. Model pill → MODEL/EFFORT sheet. `↑` = send (becomes Stop while streaming; Steer/Reminder stay inline during streaming, same bar).
- Textarea auto-grows 1→4 rows, keyboard-safe (`visualViewport`).

**B. MODEL / EFFORT sheet** — drag handle, "MODEL" (provider-grouped rows, checkmark, full names), "EFFORT" (segmented control from the thinking ladder).

**C. ALAT sheet** — sections:
- `Masukan`: **Lampirkan file** (action row).
- `Mode`: **Mode lihat** (cat-eye / `agentMode` toggle), **Mode target** (Goals panel toggle).
- `Alat`: **Izinkan alat** (see open decision #1), Web Access, Structured outputs, Use MCP, Fetch Web, Terminal mode, Confirm deletes.

**D. Top bar** — `Pick workspace` chip (workspace label + icon) moves here on phones, freeing composer space (mockup 1).

## Architecture

| Piece | Where | Notes |
| --- | --- | --- |
| `Sheet` component | new `src/components/Sheet.tsx` | bottom sheet: backdrop tap / swipe-down / Escape close, drag handle, `role="dialog"`, safe-area bottom, z above drawers (z-[60]). |
| `useIsPhone()` | `src/hooks/useIsPhone.ts` (new) | `matchMedia('(max-width: 560px)')` — single source of truth; sheets vs popovers switch on it. |
| Phone bar | `src/components/Composer.tsx` | new `composer-bar` JSX branch on `useIsPhone()`; **desktop branch untouched**. |
| Model/Effort sheet | `ModelEffortPicker` gains sheet mode | same store fields (`setProvider`, `updateSettings({ thinkingLevel })`) — NOT a second source of truth (rule preserved). |
| ALAT sheet | new `ToolsSheet` in Composer | reuses `ToolRow` + toggles already wired. |
| TopBar chip | `src/components/TopBar.tsx` | optional props `agentWorkspace`, `onPickWorkspace`; rendered `md:hidden`. |
| CSS | `src/styles/index.css` | `.sheet-*`, segmented control, 44px rows; base sheet styles un-scoped, composer variants inside `≤560px` media. |

**Guardrails (non-negotiable)**
1. **Desktop unchanged** — all new JSX lives behind `useIsPhone()` / `≤560px` CSS; the `order 0/1/2` desktop row rules stay untouched (regression lesson from this session).
2. Model picker sheet and popover **share the same store derivation** (`thinkingLadderFor`, `nearestThinkingLevel`, `THINKING_COPY`).
3. Every interactive row in sheets ≥44px; no hover-only affordances.
4. Streaming actions (Stop / Steer / Reminder) remain reachable in the bar — never buried in a sheet.

## Phases

| Phase | Work | Acceptance |
| --- | --- | --- |
| **0 — Infra** | `Sheet.tsx` + `useIsPhone()` + `.sheet-*` CSS + drag handle + safe-area. | Sheet opens/closes (tap backdrop, swipe down, Escape); safe-area respected; reduced-motion honored. |
| **1 — Composer bar** | `composer-bar` (textarea, `+`, model pill, send) replaces two rows on phone; smart model abbreviation; streaming button states. | 360px: exactly one control row, 44px targets, textarea auto-grow 1–4 rows. |
| **2 — MODEL/EFFORT sheet** | Sheet mode for `ModelEffortPicker`; provider-grouped list + segmented effort. | Full model names; checkmark syncs with store; ladder >3 scrolls. |
| **3 — ALAT sheet** | `ToolsSheet`: Lampirkan file · Mode lihat · Mode target · Izinkan alat + advanced tool rows. | Every current tool reachable; toggles mirror store; attach still works (file input + drag-drop on card). |
| **4 — TopBar workspace chip** | Chip in top bar on phone; old composer chip hidden ≤560px. | Chip visible ≤560px only; picker opens correctly from the bar. |
| **5 — Verify** | typecheck, spatial check, spatial runtime 360×800 / 412×915 / 768×1024, manual device pass. | 0 collisions; screenshots reviewed on real device. |

## Risks

| Risk | Mitigation |
| --- | --- |
| Desktop regression (already happened once) | Everything behind breakpoint; desktop JSX byte-identical; verify order visually at 1440px. |
| Sheet stacking vs drawers/popovers | Sheet z-[60] above drawer z-40; one sheet open at a time. |
| Keyboard on-screen covering the bar | `visualViewport` height sync (phase 1); `100dvh` fallback. |
| Attach from sheet UX | Keep file input under the hood; drag-drop still on the card. |
| Effort ladder > 3 levels | Horizontal-scroll segmented control; active segment auto-scrolls into view. |

## Open decisions (recommendations in bold)

1. **"Izinkan alat" mapping** — Moriko has no single "allow tools" switch today. **Recommend: a master `settings.allowTools` toggle that gates agent tool use** (real feature, matches the mockup's intent); fallback: quick Terminal-mode switch labelled "Izinkan perintah".
2. **ContextChip on phone** — **Recommend: keep it inline in the bar** (tiny icon + %, tap → context sheet section); alternative: move into the MODEL sheet header.
3. **Cat-eye placement** — mockup puts "Mode lihat" in the ALAT sheet; **Recommend: follow the mockup**, but optionally keep a tiny cat-eye glyph inline as the Moriko brand element.
4. **Effort labels** — mockup shows Low/Medium/High; the real ladder comes from `THINKING_COPY`. **Recommend: render whatever the ladder provides** (scrollable), never hardcode 3.
