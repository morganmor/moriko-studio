/**
 * Client mirror of the agent workflow catalog (server: server/agents/workflows.ts).
 * Only id/label/hint live here — the doctrine content is injected server-side.
 */
export interface AgentWorkflowOption {
  id: string;
  label: string;
  hint: string;
  isDefault: boolean;
}

export const AGENT_WORKFLOW_OPTIONS: AgentWorkflowOption[] = [
  { id: 'frontend-first', label: 'Frontend-First', hint: 'Outside-in stage-gating (default)', isDefault: true },
];

/** The workflow used when the user has not picked one (or the id is stale). */
export const DEFAULT_AGENT_WORKFLOW_ID = 'frontend-first';

export function resolveAgentWorkflowOption(id: string | undefined | null): AgentWorkflowOption {
  return (
    AGENT_WORKFLOW_OPTIONS.find((workflow) => workflow.id === id) ??
    AGENT_WORKFLOW_OPTIONS.find((workflow) => workflow.id === DEFAULT_AGENT_WORKFLOW_ID) ??
    AGENT_WORKFLOW_OPTIONS[0]
  );
}
