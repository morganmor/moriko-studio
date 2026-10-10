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
      <div className={`md-body${className ? ` ${className}` : ''} whitespace-pre-wrap break-words`} style={{ whiteSpace: 'pre-wrap' }}>{rendered}</div>
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

/** DESIGN-1 canvas render: tokenizer ringan — komentar/string/tag/angka/keyword
 *  → span .tk-c/.tk-s/.tk-t/.tk-n/.tk-k (palet sudah ada di index.css). */
const HL_KEYWORDS = 'const|let|var|function|return|if|else|for|while|class|new|import|from|export|async|await|true|false|null|undefined|def|this';
const HL_RE = new RegExp(
  '(\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*)' +
    '|("(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\\n]|\\\\.)*\'|`[^`]*`)' +
    '|(<\\/?[a-zA-Z][\\w-]*)' +
    '|(\\b\\d+(?:\\.\\d+)?(?:px|ms|s|%|deg|em|rem)?\\b)' +
    '|(\\b(?:' + HL_KEYWORDS + ')\\b)',
  'g',
);

function highlightCode(code: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  HL_RE.lastIndex = 0;
  while ((m = HL_RE.exec(code)) !== null) {
    if (m.index > last) nodes.push(code.slice(last, m.index));
    const cls = m[1] ? 'tk-c' : m[2] ? 'tk-s' : m[3] ? 'tk-t' : m[4] ? 'tk-n' : 'tk-k';
    nodes.push(<span key={key++} className={cls}>{m[0]}</span>);
    last = m.index + m[0].length;
  }
  if (last < code.length) nodes.push(code.slice(last));
  return nodes;
}

/** Kartu blok kode ala design: header bahasa + Copy + highlighted body. */
function CodeBlock({ children }: { children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);

  const codeEl = (Array.isArray(children) ? children[0] : children) as
    | { props?: { className?: string } }
    | undefined;
  const codeClass = codeEl?.props?.className ?? '';
  const lang = /^language-([\w+-]+)/.exec(codeClass)?.[1] ?? '';
  const text = extractText(children).replace(/\n$/, '');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
    }
  };

  return (
    <div className="md-cb cb">
      <div className="cb-h">
        <span>{lang || 'text'}</span>
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? 'Code copied' : 'Copy code'}
          className="btn xs ghost"
        >
          {copied ? (
            <Check className="ic" style={{ color: 'rgb(var(--c-ok))' }} aria-hidden="true" />
          ) : (
            <Copy className="ic" aria-hidden="true" />
          )}
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <pre>
        <code className={codeClass}>{highlightCode(text)}</code>
      </pre>
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
