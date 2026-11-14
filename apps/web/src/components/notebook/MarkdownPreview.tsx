import ReactMarkdown, { type Components } from "react-markdown";

/**
 * Markdown written by another collaborator (Phase 2) must be safe to view:
 * - react-markdown builds React elements and never injects raw HTML (no
 *   rehype-raw), and its default URL transform drops `javascript:` links.
 * - Images are not loaded: an image URL would let one collaborator log every
 *   viewer's IP address. The alt text is shown instead.
 * - Links open in a new tab, so following one never leaves the notebook,
 *   and with noopener/noreferrer the target page can't reach back into it.
 */
const components: Components = {
  img: ({ alt }) => <span className="text-zinc-500 italic">[image{alt ? `: ${alt}` : ""}]</span>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  ),
};

export function MarkdownPreview({ source }: { source: string }) {
  if (!source.trim()) {
    return <p className="text-sm text-zinc-500 italic">Empty text cell</p>;
  }
  return (
    <div className="prose-sm max-w-none space-y-2 text-sm [&_a]:underline [&_code]:font-mono [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:text-lg [&_h2]:font-semibold [&_li]:ml-5 [&_ol]:list-decimal [&_ul]:list-disc">
      <ReactMarkdown components={components}>{source}</ReactMarkdown>
    </div>
  );
}
