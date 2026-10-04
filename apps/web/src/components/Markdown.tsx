import { type ReactNode } from 'react';

/**
 * A deliberately tiny markdown renderer for engine prose (project memory, model
 * rationale). Handles headings, bullets, bold, inline code and paragraphs — no
 * dependency, and never `dangerouslySetInnerHTML`.
 */

function inline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = re.exec(text))) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith('**')) {
      nodes.push(<strong key={`${keyBase}-b${i++}`}>{token.slice(2, -2)}</strong>);
    } else {
      nodes.push(
        <code className="md-code" key={`${keyBase}-c${i++}`}>
          {token.slice(1, -1)}
        </code>,
      );
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export default function Markdown({ text, className }: { text: string; className?: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  let para: string[] = [];
  let key = 0;

  const flushList = () => {
    if (!list.length) return;
    const items = list;
    blocks.push(
      <ul className="md-list" key={`ul-${key++}`}>
        {items.map((item, i) => (
          <li key={i}>{inline(item, `li-${key}-${i}`)}</li>
        ))}
      </ul>,
    );
    list = [];
  };
  const flushPara = () => {
    if (!para.length) return;
    const joined = para.join(' ');
    blocks.push(
      <p className="md-p" key={`p-${key++}`}>
        {inline(joined, `p-${key}`)}
      </p>,
    );
    para = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      flushList();
      const content = inline(heading[2], `h-${key}`);
      blocks.push(
        heading[1].length <= 2 ? (
          <h3 className="md-h" key={`h-${key++}`}>
            {content}
          </h3>
        ) : (
          <h4 className="md-h md-h--sub" key={`h-${key++}`}>
            {content}
          </h4>
        ),
      );
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flushPara();
      list.push(bullet[1]);
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  flushPara();
  flushList();

  return <div className={`md${className ? ` ${className}` : ''}`}>{blocks}</div>;
}
