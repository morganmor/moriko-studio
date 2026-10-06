import { memo, useEffect, useState } from 'react';
import { Check, Copy } from './icons';

/**
 * P4: THE WHOLE MARKDOWN STACK is lazy now. The audit measured the
 * react-markdown + remark-gfm + remark-math + unified chain at ~770 KB on the
 * boot waterfall — parsed on the main thread during TBT even though most
 * threads only render it after the first model reply arrives. This module now
 * ships a CHEAP PLAIN-TEXT fallback (whitespace-pre-wrap paragraph) and swaps
 * to the real renderer when the chunk lands. KaTeX rides its own chunk on top
 * (only for messages that contain math — see the probe below).
 */
type MarkdownModule = {
  default: typeof import('react-markdown').default;
  remarkGfm: typeof import('remark-gfm').default;
  remarkMath: typeof import('remark-math').default;
};

type KatexPlugin = typeof import('rehype-katex').default;

/** Module-level cache: the chain loads ONCE for the whole app, not per row. */
let markdownModule: MarkdownModule | null = null;
let markdownLoading: Promise<MarkdownModule> | null = null;

function loadMarkdown(): Promise<MarkdownModule> {
  if (markdownModule) return Promise.resolve(markdownModule);
  if (!markdownLoading) {
    markdownLoading = Promise.all([
      import('react-markdown'),
      import('remark-gfm'),
      import('remark-math'),
    ]).then(([reactMarkdown, gfm, math]) => {
      markdownModule = { default: reactMarkdown.default, remarkGfm: gfm.default, remarkMath: math.default };
      return markdownModule;
    });
    markdownLoading.catch(() => {
      markdownLoading = null;
    });
  }
  return markdownLoading;
}

/** Cheap "this message probably contains math" probe: $..$, $$..$$, \(..\) or \[..\]. */
const MATH_HINT = /\$\$[\s\S]+?\$\$|\$[^$\n]+\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]/;

/**
 * Markdown renderer for model output.
 *
 * GFM for tables/strikethrough, KaTeX for math. Raw HTML is intentionally not
 * enabled: model output is untrusted input, and `rehype-raw` would make it
 * scriptable.
 */
/**
 * SOFT-BREAK PRESERVATION for user-authored text: Shift+Enter in the composer
 * writes single newlines, which CommonMark folds into a space — a multi-line
 * user message rendered as one run-on paragraph (the reported "baris hilang"
 * bug). Converting each single newline into a hard break (two trailing
 * spaces) keeps the writer's exact line structure. Used ONLY on user/steer
 * bubbles; model output keeps standard CommonMark. Fenced code is untouched
 * so copied code stays verbatim.
 */
function softBreaksToHard(text: string): string {
  if (!text.includes('\n')) return text;
  return text
    .split(/(```[\s\S]*?(?:```|$))/g)
    .map((segment, index) =>
      index % 2 === 1 ? segment : segment.replace(/(^|[^\n])\n(?!\n)/g, '$1  \n'),
    )
    .join('');
}

export const Markdown = memo(function Markdown({ content, breakLines, className }: { content: string; breakLines?: boolean; className?: string }) {
  const [chain, setChain] = useState<MarkdownModule | null>(markdownModule);
  const [katex, setKatex] = useState<KatexPlugin | null>(null);
  const rendered = breakLines ? softBreaksToHard(content) : content;
  const needsMath = MATH_HINT.test(content);
  useEffect(() => {
    let cancelled = false;
    void loadMarkdown().then((module) => {
      if (!cancelled) setChain(module);
    });
    if (needsMath && chain !== null && katex === null) {
      void Promise.all([import('rehype-katex'), import('katex/dist/katex.min.css')])
        .then(([module]) => {
          if (!cancelled) setKatex(() => module.default);
        })
        .catch(() => {
        });
    }
    return () => {
      cancelled = true;
    };
  }, [needsMath, chain, katex]);
  if (chain === null) {
    return (
      <div className={`md-body${className ? ` ${className}` : ''} whitespace-pre-wrap break-words`}>{rendered}</div>
    );
  }
  const { default: ReactMarkdown, remarkGfm, remarkMath } = chain;
  return (
    <div className={`md-body${className ? ` ${className}` : ''}`}>
      <ReactMarkdown
        remarkPlugins={katex ? [remarkGfm, remarkMath] : [remarkGfm]}
        rehypePlugins={katex ? [katex] : []}
        components={{
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
        }}
      >
        {rendered}
      </ReactMarkdown>
    </div>
  );
});

/** Wraps fenced code with a copy affordance. */
function CodeBlock({ children }: { children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    const text = extractText(children);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
    }
  };

  return (
    <div className="group relative">
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? 'Code copied' : 'Copy code'}
        className="icon-button absolute right-2 top-2 h-7 w-7 bg-elevated opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" />
        ) : (
          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
        )}
      </button>
      <pre>{children}</pre>
    </div>
  );
}

/** Recursively flattens a React node tree into its plain text. */
function extractText(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (typeof node === 'object' && 'props' in node) {
    return extractText((node as { props: { children?: React.ReactNode } }).props.children);
  }
  return '';
}
