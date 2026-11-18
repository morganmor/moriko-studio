

import { randomUUID } from 'node:crypto';

import type { AgentToolContext, HarnessToolResult } from './shared.js';
import { num } from './shared.js';


const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_QUESTIONS = 8;

export interface AskQuestion {
  id: string;
  question: string;
  type: 'text' | 'choice';
  
  choices: string[];
  
  allowCustom: boolean;
}

export interface AskAnswer {
  id: string;
  
  answer?: string;
  
  skipped?: boolean;
}


export interface AskUserRequest {
  id: string;
  sessionId?: string;
  createdAt: number;
  questions: AskQuestion[];
}

interface PendingAsk {
  request: AskUserRequest;
  
  resolve: (reason: 'timeout' | 'aborted' | 'answered') => void;
  
  finalAnswers?: AskAnswer[];
  timer: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
}

const pending = new Map<string, PendingAsk>();


function normalizeQuestions(raw: unknown): { questions?: AskQuestion[]; error?: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'ask_user needs a "questions" array with at least one question.' };
  }
  if (raw.length > MAX_QUESTIONS) {
    return { error: `ask_user accepts at most ${MAX_QUESTIONS} questions per call — got ${raw.length}. Split across calls.` };
  }
  const questions: AskQuestion[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i] as Record<string, unknown>;
    const question = typeof entry?.question === 'string' ? entry.question.trim() : '';
    if (!question) {
      return { error: `questions[${i}].question is missing (a non-empty string is required).` };
    }
    const type = entry?.type === 'choice' ? 'choice' : 'text';
    let choices: string[] = [];
    if (type === 'choice') {
      const rawChoices: unknown = Array.isArray(entry?.choices) ? entry.choices : Array.isArray(entry?.options) ? entry.options : null;
      if (!Array.isArray(rawChoices) || rawChoices.length < 2) {
        return {
          error:
            `questions[${i}] is a "choice" question — supply at least two options in the "choices" array ` +
            '(a "options" array is accepted as an alias; it must hold 2-8 non-empty strings).',
        };
      }
      if (rawChoices.length > 8) {
        return { error: `questions[${i}] accepts at most 8 options.` };
      }
      choices = rawChoices
        .filter((choice): choice is string => typeof choice === 'string' && choice.trim().length > 0)
        .map((choice) => choice.trim());
      if (choices.length < 2) {
        return { error: `questions[${i}] needs at least two non-empty options.` };
      }
    }
    questions.push({
      id: typeof entry?.id === 'string' && entry.id.trim() ? entry.id.trim() : `q${i + 1}`,
      question,
      type,
      choices,
      allowCustom: entry?.allowCustom === true,
    });
  }
  return { questions };
}


function isValidAnswer(question: AskQuestion, value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (question.type === 'choice' && !question.allowCustom) {
    return question.choices.some((choice) => choice === trimmed);
  }
  return true;
}


export async function askUserTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const { questions, error } = normalizeQuestions(args.questions);
  if (error || !questions) {
    return { ok: false, isError: true, text: error!, errorCode: 'schema_error' };
  }

  const requested = num(args, 'timeoutSec');
  const timeoutMs =
    requested && requested > 0 ? Math.min(Math.round(requested * 1000), MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;

  const id = randomUUID();
  const request: AskUserRequest = {
    id,
    sessionId: ctx.sessionId,
    createdAt: Date.now(),
    questions,
  };

  const answers = await new Promise<AskAnswer[]>((resolve) => {
    let settled = false;
    const entry: PendingAsk = {
      request,
      timer: setTimeout(() => settle('timeout'), timeoutMs),
      resolve: () => undefined,
    };

    const settle = (reason: 'timeout' | 'aborted' | 'answered'): void => {
      if (settled) return;
      settled = true;
      clearTimeout(entry.timer);
      if (entry.onAbort && ctx.signal) {
        ctx.signal.removeEventListener('abort', entry.onAbort);
      }
      pending.delete(id);
      ctx.onQuestionResolved?.({
        id,
        answers: reason === 'answered' ? entry.finalAnswers ?? [] : questions.map((q) => ({ id: q.id, skipped: true })),
        timedOut: reason === 'timeout',
      });
      resolve(
        reason === 'answered' && entry.finalAnswers
          ? entry.finalAnswers
          : questions.map((q) => ({ id: q.id, skipped: true })),
      );
    };

    entry.resolve = settle;
    entry.finalAnswers = undefined;
    if (ctx.signal) {
      if (ctx.signal.aborted) {
        settle('aborted');
        return;
      }
      entry.onAbort = () => settle('aborted');
      ctx.signal.addEventListener('abort', entry.onAbort, { once: true });
    }

    pending.set(id, entry);
    ctx.onAskUser?.(request);
  });

  if (answers.every((answer) => answer.skipped)) {
    return {
      ok: true,
      isError: false,
      text:
        'The user did not respond — every question was skipped (dismissed or timed out).\n' +
        'Proceed with a sensible default, state the assumption explicitly in your reply, ' +
        'and offer to revisit it. Do NOT block waiting for these answers again.',
    };
  }

  const lines = answers.map((answer) => {
    const question = questions.find((q) => q.id === answer.id);
    if (answer.skipped || answer.answer === undefined) {
      return `- ${answer.id}: (skipped) — proceed with a sensible default and state the assumption.`;
    }
    const viaChoice = question?.type === 'choice' ? ' [choice]' : '';
    return `- ${answer.id}: ${answer.answer}${viaChoice}`;
  });

  return {
    ok: true,
    isError: false,
    text: `The user answered:\n${lines.join('\n')}\n\nUse these answers directly — they are the user's explicit decisions.`,
  };
}


export function answerQuestions(id: string, rawAnswers: unknown): boolean {
  const entry = pending.get(id);
  if (!entry) return false;

  const byId = new Map<string, string>();
  const skipped = new Set<string>();
  if (Array.isArray(rawAnswers)) {
    for (const raw of rawAnswers) {
      const item = raw as Record<string, unknown>;
      if (typeof item?.id !== 'string') continue;
      if (item?.skipped === true) {
        skipped.add(item.id);
      } else if (typeof item?.answer === 'string') {
        byId.set(item.id, item.answer.trim());
      }
    }
  }

  const finalAnswers: AskAnswer[] = entry.request.questions.map((question) => {
    if (skipped.has(question.id)) return { id: question.id, skipped: true };
    const answer = byId.get(question.id);
    if (answer !== undefined && isValidAnswer(question, answer)) {
      return { id: question.id, answer };
    }
    return { id: question.id, skipped: true };
  });

  entry.finalAnswers = finalAnswers;
  entry.resolve('answered');
  return true;
}


export function listPendingQuestions(): AskUserRequest[] {
  return [...pending.values()].map((entry) => entry.request);
}


export function extendQuestionTimeout(id: string, ms: number): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  clearTimeout(entry.timer);
  entry.timer = setTimeout(
    () => entry.resolve('timeout'),
    Math.min(Math.max(ms, 30_000), 60 * 60 * 1000),
  );
  return true;
}

