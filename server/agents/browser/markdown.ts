/**
 * Minimal HTML → Markdown conversion for the browser↔workspace bridge
 * (browser_save_page). Zero external deps — covers the common cases:
 * headings, links, bold/italic, lists, code, images, paragraphs.
 * Runs on the server side against the STRUCTURED output of the in-page
 * readability walker (browser_read_article), not raw HTML soup.
 */
export function htmlToMarkdown(parts: Array<{ t: string; level?: number; text: string }>): string {
  const lines: string[] = [];
  for (const part of parts) {
    switch (part.t) {
      case 'h':
        lines.push(`${'#'.repeat(Math.min(6, Math.max(1, part.level ?? 2)))} ${part.text}`, '');
        break;
      case 'p':
        lines.push(part.text, '');
        break;
      case 'list':
        for (const item of part.text.split('\n')) lines.push(item);
        lines.push('');
        break;
      case 'code':
        lines.push('```', part.text, '```', '');
        break;
      default:
        lines.push(part.text, '');
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
