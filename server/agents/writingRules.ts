

export const SYSTEM_RULES_PRESETS: Record<string, string> = {
  writingRules: `SYSTEM REMINDER — Writing Rules (sent by the user).

The user is reminding you of the rules you must follow while working in this
workspace:

- Proper End-to-End (E2E) testing is done by using DEDICATED TOOLS, never by
  writing manual testing code based on your own implementation.
- Only perform verifications and additional testing if the user explicitly
  asked for them.
- Report all errors in a structured manner — never make excuses to avoid or run
  away from the problem.
- Do not ignore or underestimate warnings that appear in the runtime,
  terminal, or devtools.

Acknowledge briefly and adjust your current work accordingly.`,
};
