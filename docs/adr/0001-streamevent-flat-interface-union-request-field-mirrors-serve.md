# 0001. StreamEvent: flat interface + union request field mirrors server discriminated union

- **Status**: Accepted
- **Date**: 2026-11-05

## Context
The server emits stream events as a discriminated union (server/contracts.ts, server/mcp/loop.ts ToolLoopEvent): variant `ask_user_request` carries `request: AskUserRequest { questions }`, variant `operator_gate_request` carries `request: OperatorGateRequest { kind }`. Two previous sessions each appended their own `request?: …` to the client's FLAT `StreamEvent` interface (src/types.ts), producing TS2300 duplicate-identifier errors and, before that, a silent contract mismatch. The client interface is intentionally flat (≈30 optional fields, one switch consumer in useChatController.ts), so per-variant union duplication is impossible there.

## Decision
Keep the client StreamEvent flat, with a single `request?: AskUserRequest | OperatorGateRequest` field documented as the wire-union mirror. The two consumers in useChatController.ts narrow by the payload's own discriminant (`'questions' in request` → pushAskUserRequest; `'kind' in request` → pushOperatorGate), which validates the shape against the store contract before it enters state. The unused component-level subscription of setPendingOperatorGates in AgentOperatorGateDialog.tsx was removed; the store action itself stays — the dialog's reconcile effect uses it via useStore.getState() (C3 server-truth pattern).

## Consequences
Adding a third request-bearing event variant means widening the union AND its narrowing guard — one place each, both co-located. A full discriminated-union refactor of StreamEvent stays possible later but would touch every case arm of the stream switch; not justified while exactly one consumer reads `request`.

## Alternatives
Rejected: (a) splitting into `askRequest?`/`gateRequest?` client-only fields — drifts from the actual wire key the server sends; (b) converting StreamEvent to a full discriminated union mirroring contracts.ts — architecturally purest but a large multi-file refactor with real regression risk for a single-consumer field.
