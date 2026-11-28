import { Fragment, type ReactNode } from "react";
import Link from "next/link";
import { isLegalToken, LEGAL_VALUES, TO_BE_COMPLETED } from "@/lib/legal/config";

// Renders the verbatim public legal copy (lib/legal/content.ts). It understands exactly what the
// copy uses — "## "/"### " headings, paragraphs, "- " bullets, **bold**, *italic*, `code`,
// [text](href) links and [[TOKENS]] — and nothing else, so no word is added or dropped. Internal
// links (href starting with "/") use next/link; http(s) and mailto links render as plain anchors.
// A known token takes its configured value or a visible "[to be completed]" marker; any other
// [[…]] shows as "[to be confirmed: …]". Nothing is ever invented in a token's place.

const LINK = "font-medium text-primary underline-offset-4 hover:underline";

function Marker({ children }: { children: string }) {
  return <mark className="rounded-sm bg-amber-100 px-1 font-medium text-amber-900 print:bg-transparent print:text-black">{children}</mark>;
}

function token(name: string, key: string): ReactNode {
  if (isLegalToken(name)) {
    const value = LEGAL_VALUES[name];
    return value === null ? <Marker key={key}>{TO_BE_COMPLETED}</Marker> : <Fragment key={key}>{value}</Fragment>;
  }
  return <Marker key={key}>{`[to be confirmed: ${name}]`}</Marker>;
}

function link(label: string, href: string, key: string): ReactNode {
  const text = inline(label, key);
  if (href.startsWith("/")) {
    return (
      <Link key={key} href={href} className={LINK}>
        {text}
      </Link>
    );
  }
  const external = href.startsWith("http://") || href.startsWith("https://");
  return (
    <a key={key} href={href} className={LINK} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
      {text}
    </a>
  );
}

/** Inline markup: `code` (a code span that is only a token renders as the token), **bold**, *italic*, [text](href), [[TOKEN]]. */
export function inline(text: string, keyPrefix = "i"): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|\[\[([^\]]+)\]\]|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  let index = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const key = `${keyPrefix}-${(index += 1).toString()}`;
    const [, code, bold, italic, name, linkText, linkHref] = match;
    if (code !== undefined) {
      const only = /^\[\[([^\]]+)\]\]$/.exec(code);
      nodes.push(only ? token(only[1] ?? "", key) : <code key={key}>{code}</code>);
    } else if (bold !== undefined) {
      nodes.push(<strong key={key}>{inline(bold, key)}</strong>);
    } else if (italic !== undefined) {
      nodes.push(<em key={key}>{inline(italic, key)}</em>);
    } else if (name !== undefined) {
      nodes.push(token(name, key));
    } else if (linkText !== undefined && linkHref !== undefined) {
      nodes.push(link(linkText, linkHref, key));
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** Block markup: "## "/"### " headings; paragraphs separated by blank lines; a run of "- " lines is a list. */
export function LegalBody({ body }: { body: string }) {
  const blocks: ReactNode[] = [];
  const lines = body.split("\n");
  let paragraph: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) {
      const key = `p-${blocks.length.toString()}`;
      blocks.push(<p key={key}>{inline(paragraph.join(" "), key)}</p>);
      paragraph = [];
    }
    if (list.length > 0) {
      const key = `l-${blocks.length.toString()}`;
      blocks.push(
        <ul key={key}>
          {list.map((item, i) => (
            <li key={`${key}-${i.toString()}`}>{inline(item, `${key}-${i.toString()}`)}</li>
          ))}
        </ul>,
      );
      list = [];
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim() === "") {
      flush();
    } else if (line.startsWith("### ")) {
      flush();
      const key = `h3-${blocks.length.toString()}`;
      blocks.push(<h3 key={key}>{inline(line.slice(4), key)}</h3>);
    } else if (line.startsWith("## ")) {
      flush();
      const key = `h2-${blocks.length.toString()}`;
      blocks.push(<h2 key={key}>{inline(line.slice(3), key)}</h2>);
    } else if (line.startsWith("- ")) {
      if (paragraph.length > 0) {
        const key = `p-${blocks.length.toString()}`;
        blocks.push(<p key={key}>{inline(paragraph.join(" "), key)}</p>);
        paragraph = [];
      }
      list.push(line.slice(2));
    } else {
      if (list.length > 0) flush();
      paragraph.push(line);
    }
  }
  flush();
  return <>{blocks}</>;
}
