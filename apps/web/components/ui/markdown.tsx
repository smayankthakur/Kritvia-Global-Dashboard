import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "./cn";

/** Markdown from agents/users. Raw HTML is never rendered (react-markdown escapes it). */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("prose-kv text-sm", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children: c }) => (
            <a href={href} target="_blank" rel="noopener noreferrer nofollow">
              {c}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

/** Email bodies are markdown-ish plain text: render markdown when it looks like it,
 * otherwise keep line breaks and ASCII tables aligned. */
export function looksLikeMarkdown(s: string): boolean {
  return /^\s*\|.*\|\s*$\n^\s*\|?\s*:?-{3,}/m.test(s) || /^#{1,4}\s/m.test(s) || /^\s*[-*]\s+\S/m.test(s) || /\*\*[^*]+\*\*/.test(s);
}

export function RichText({ text, className }: { text: string; className?: string }) {
  if (looksLikeMarkdown(text)) {
    // Keep single newlines as line breaks the way an email client would.
    return <Markdown className={className}>{text.replace(/([^\n|])\n(?![\n|\-*#\d])/g, "$1  \n")}</Markdown>;
  }
  const asciiTable = /^[^\n|]+(\s\|\s[^\n|]+){2,}$/m.test(text) && /^-{8,}\s*$/m.test(text);
  return (
    <div className={cn("text-sm leading-relaxed whitespace-pre-wrap", asciiTable && "overflow-x-auto font-mono text-[12.5px] leading-6", className)}>
      {text}
    </div>
  );
}
