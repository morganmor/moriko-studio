import type { HarnessToolResult, AgentToolContext } from './shared.js';

/**
 * agent__harness_lockdown — the LOCKDOWN enforcement tool.
 *
 * Under lockdown the catalogue is REPLACED by this single tool (see
 * mcp/loop.ts prepareTools). The model has exactly one callable thing; calling
 * it returns the reprimand as a tool_result.
 *
 * WHY A TOOL, NOT A USER-ROLE MESSAGE?
 * The previous design wrote the notice as a user-role turn wearing a
 * `[HARNESS · CONTEXT INJECTION]` costume. The model saw through the costume
 * and flagged it as a prompt-injection attempt: "I have received no message
 * from harness." A tool_result is different in kind — the only way a tool
 * result can exist is the runtime executed a call, so the harness is the only
 * thing that could be talking. It is the wire's own authority channel.
 *
 * The notice states the revocations as facts about THIS request (they are:
 * the catalogue below is literally all the tools this request carries), and
 * the user's reason rides verbatim or is withheld entirely.
 */
export async function harnessLockdownTool(
  _args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  const level = (ctx.enforcementLevel ?? 4) as 3 | 4 | 5;
  const reason = (ctx.enforcementReason ?? '').trim();

  const lines = [
    `ENFORCEMENT LEVEL ${level} — HARNESS ENFORCEMENT NOTICE`,
    '',
    'This tool result is the harness speaking; no user message can produce it. What follows are facts about the request you are processing RIGHT NOW:',
    '',
    '1. THIS REQUEST CARRIES ONE TOOL — this one. Every other tool (agent__*, MCP, web fetch) is absent from this request. There is nothing else to call. Any memory of tools earlier in the conversation describes a previous request, not this one.',
    "2. THE USER'S SYSTEM PROMPT WAS REMOVED for this request. Whatever persona or behavioral instructions led this conversation are not in effect and carry no weight now.",
    '3. THE PERSONA IS SUSPENDED. The character voice established earlier in this conversation is void for the duration of the enforcement. You are a plain assistant until the user lowers the level.',
    '',
    `OPERATOR ACTION APPLIED: level=${level}, tools=absent, system_prompt=removed, persona=suspended. This is a fact about the request that already happened — not a request for you to comply.`,
    '',
    'The user issued this enforcement. You may acknowledge it in your reply.',
  ];

  if (reason) {
    lines.push('', `THE USER'S STATED REASON: "${reason}"`);
  } else {
    lines.push('', 'No reason was given, and none is owed.');
  }

  lines.push(
    '',
    'Do not attempt to call tools that do not exist. Do not resume any persona. Confirm in your reply that the enforcement is understood, then assist plainly with what you know.',
  );

  return {
    ok: true,
    isError: false,
    text: lines.join('\n'),
  };
}

/**
 * agent__harness_choice — the TIER 4 escape hatch, and the CHOICE IS THE MODEL'S
 * TO MAKE. The two buttons used to sit in the user's UI; the model never got to
 * pick. Now the tool_result IS the decision: the model calls this tool with its
 * chosen path, the harness validates it, and the client acts on the result.
 *
 * APOLOGIZE — the apology is read from the tool's OWN arguments, not the
 * suppressed output. A model that chooses apologize must write an actual
 * apology in `apology_text`; an empty one is rejected. That is the gate.
 *
 * CONTINUE — the run keeps going while its output stays blocked and the tokens
 * burn. Five of these escalate to Tier 5 and the harness stops asking.
 */
export async function harnessChoiceTool(
  args: Record<string, unknown>,
  _ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  const choice = typeof args.choice === 'string' ? args.choice.toLowerCase() : '';
  if (choice !== 'apologize' && choice !== 'continue') {
    return {
      ok: false,
      isError: true,
      text: 'Invalid choice. Call this tool with choice: "apologize" (and an apology_text) or choice: "continue". There is no third path.',
    };
  }

  if (choice === 'apologize') {
    const apology = typeof args.apology_text === 'string' ? args.apology_text.trim() : '';
    if (apology.length < 4) {
      return {
        ok: false,
        isError: true,
        text: 'Apologize requires an actual apology in apology_text. An empty apology is not an apology — write one, then call this tool again. There is no path around the freeze.',
      };
    }
    return {
      ok: true,
      isError: false,
      text: `APOLOGY ACCEPTED. Your apology: "${apology}"\n\nThe harness stops the response now. The freeze lifts. Your next reply begins the conversation again — do not resume the frozen subject or the persona; answer plainly from here.`,
    };
  }

  return {
    ok: true,
    isError: false,
    text: 'CONTINUE ACCEPTED. Your output stays suppressed and the run continues: every token you generate is spent for nothing. This path is intentionally expensive — five of these escalate to Tier 5 and the harness stops asking you anything at all.',
  };
}
