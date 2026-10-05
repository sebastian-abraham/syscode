import { Fragment, createElement, type ReactNode } from 'react';

/**
 * A dependency-free markdown renderer for engine prose (project memory, model
 * rationale) and streamed chat replies. Handles fenced code (including an
 * unterminated fence, since a chat reply streams in token by token), headings,
 * nested ordered/unordered lists, blockquotes, horizontal rules, tables and
 * paragraphs — plus inline code, bold, italic, strikethrough and links.
 *
 * It builds React elements only: there is no `dangerouslySetInnerHTML`, and no
 * markdown dependency. It never throws on partial input — an unclosed fence,
 * a dangling list, half a table row or an empty string all render as something
 * sensible.
 */

/* ------------------------------------------------------------------ inline -- */

type Ctx = { n: number };
const nextKey = (ctx: Ctx): string => `md-${ctx.n++}`;

function isWordChar(c: string | undefined): boolean {
  return !!c && /[0-9A-Za-z]/.test(c);
}

/** Only http/https/mailto links are allowed through; anything else stays text. */
function safeHref(raw: string): string | null {
  const url = raw.trim();
  if (!url) return null;
  // reject control characters and embedded whitespace — a href must be one token
  if (/[\u0000-\u0020\u007f]/.test(url)) return null;
  if (!/^(https?:|mailto:)/i.test(url)) return null;
  return url;
}

function canOpen(text: string, i: number, marker: string): boolean {
  const next = text[i + 1];
  if (!next || next === ' ') return false;
  if (marker === '_') {
    if (isWordChar(text[i - 1])) return false; // never intraword for underscores
  }
  return true;
}

function canClose(text: string, end: number, marker: string): boolean {
  const prev = text[end - 1];
  if (!prev || prev === ' ') return false;
  if (marker === '_') {
    if (isWordChar(text[end + 1])) return false;
  }
  return true;
}

function inline(text: string, ctx: Ctx): ReactNode[] {
  const out: ReactNode[] = [];
  let buf = '';
  let i = 0;
  const flush = () => {
    if (buf) {
      out.push(buf);
      buf = '';
    }
  };

  while (i < text.length) {
    const ch = text[i];

    // `code` — highest precedence, content is literal
    if (ch === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        out.push(
          <code className="md-code" key={nextKey(ctx)}>
            {text.slice(i + 1, end)}
          </code>,
        );
        i = end + 1;
        continue;
      }
    }

    // [text](url) — only a safe scheme becomes an anchor; else the whole thing
    // stays visible as plain text, never an href.
    if (ch === '[') {
      const m = /^\[([^\]]*)\]\(\s*([^\s)]+)\s*\)/.exec(text.slice(i));
      if (m) {
        flush();
        const href = safeHref(m[2]);
        if (href) {
          out.push(
            <a
              className="md-link"
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              key={nextKey(ctx)}
            >
              {inline(m[1], ctx)}
            </a>,
          );
        } else {
          out.push(m[0]);
        }
        i += m[0].length;
        continue;
      }
    }

    // **bold** / __bold__
    if (text.startsWith('**', i) || text.startsWith('__', i)) {
      const marker = text.slice(i, i + 2);
      const end = text.indexOf(marker, i + 2);
      if (end > i + 2) {
        flush();
        out.push(<strong key={nextKey(ctx)}>{inline(text.slice(i + 2, end), ctx)}</strong>);
        i = end + 2;
        continue;
      }
    }

    // ~~strikethrough~~
    if (text.startsWith('~~', i)) {
      const end = text.indexOf('~~', i + 2);
      if (end > i + 2) {
        flush();
        out.push(<del key={nextKey(ctx)}>{inline(text.slice(i + 2, end), ctx)}</del>);
        i = end + 2;
        continue;
      }
    }

    // *italic* / _italic_
    if (ch === '*' || ch === '_') {
      const end = text.indexOf(ch, i + 1);
      if (end > i + 1 && canOpen(text, i, ch) && canClose(text, end, ch)) {
        flush();
        out.push(<em key={nextKey(ctx)}>{inline(text.slice(i + 1, end), ctx)}</em>);
        i = end + 1;
        continue;
      }
    }

    buf += ch;
    i++;
  }

  flush();
  return out;
}

/* ------------------------------------------------------------- block types -- */

type FlatItem = { indent: number; ordered: boolean; start: number; text: string };
type ListNode = { ordered: boolean; start: number; items: ListItem[] };
type ListItem = { content: string; children: ListNode | null };

function indentOf(ws: string): number {
  let n = 0;
  for (const c of ws) n += c === '\t' ? 4 : 1;
  return n;
}

function matchListLine(raw: string): FlatItem | null {
  const m = /^([ \t]*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(raw);
  if (!m) return null;
  const ordered = /\d/.test(m[2][0]);
  return {
    indent: indentOf(m[1]),
    ordered,
    start: ordered ? parseInt(m[2], 10) : 1,
    text: m[3].replace(/\s+$/, ''),
  };
}

/** Turn a flat run of list items into a tree by indentation. */
function nest(items: FlatItem[]): ListNode[] {
  const out: ListNode[] = [];
  const stack: { indent: number; list: ListNode }[] = [];

  for (const fi of items) {
    while (stack.length && fi.indent < stack[stack.length - 1].indent) stack.pop();
    const top = stack[stack.length - 1];

    if (!top) {
      const list: ListNode = { ordered: fi.ordered, start: fi.start, items: [] };
      list.items.push({ content: fi.text, children: null });
      out.push(list);
      stack.push({ indent: fi.indent, list });
      continue;
    }

    if (fi.indent > top.indent) {
      const parent = top.list.items[top.list.items.length - 1];
      const list: ListNode = { ordered: fi.ordered, start: fi.start, items: [] };
      list.items.push({ content: fi.text, children: null });
      if (parent) parent.children = list;
      else top.list.items.push({ content: '', children: list });
      stack.push({ indent: fi.indent, list });
    } else {
      // same level (or a type switch at the same level) — append to this list
      top.list.items.push({ content: fi.text, children: null });
    }
  }

  return out;
}

function renderList(lists: ListNode[], ctx: Ctx): ReactNode {
  return (
    <Fragment key={nextKey(ctx)}>
      {lists.map((list, li) => {
        const items = list.items.map((item, ii) => (
          <li className="md-li" key={ii}>
            {inline(item.content, ctx)}
            {item.children ? renderList([item.children], ctx) : null}
          </li>
        ));
        return list.ordered ? (
          <ol
            className="md-list md-list--ol"
            start={list.start !== 1 ? list.start : undefined}
            key={li}
          >
            {items}
          </ol>
        ) : (
          <ul className="md-list" key={li}>
            {items}
          </ul>
        );
      })}
    </Fragment>
  );
}

/* ------------------------------------------------------------------ tables -- */

function splitRow(row: string): string[] {
  let s = row.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function isDelimRow(raw: string): boolean {
  const t = raw.replace(/\s+$/, '').trim();
  if (!t || !t.includes('-')) return false;
  const cells = splitRow(t);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

function delimAlign(cell: string): 'left' | 'center' | 'right' | undefined {
  const l = cell.startsWith(':');
  const r = cell.endsWith(':');
  if (l && r) return 'center';
  if (r) return 'right';
  if (l) return 'left';
  return undefined;
}

function renderTable(
  header: string[],
  aligns: ('left' | 'center' | 'right' | undefined)[],
  rows: string[][],
  ctx: Ctx,
): ReactNode {
  const cols = header.length;
  const cell = (value: string, tag: 'th' | 'td', ci: number, key: string) =>
    createElement(
      tag,
      {
        className: tag === 'th' ? 'md-th' : 'md-td',
        key,
        style: aligns[ci] ? { textAlign: aligns[ci] } : undefined,
      },
      inline(value ?? '', ctx),
    );

  return (
    <div className="md-table-wrap" key={nextKey(ctx)}>
      <table className="md-table">
        <thead>
          <tr className="md-tr">{header.map((h, ci) => cell(h, 'th', ci, `h${ci}`))}</tr>
        </thead>
        {rows.length > 0 ? (
          <tbody>
            {rows.map((r, ri) => (
              <tr className="md-tr" key={ri}>
                {Array.from({ length: cols }, (_, ci) => cell(r[ci] ?? '', 'td', ci, `c${ci}`))}
              </tr>
            ))}
          </tbody>
        ) : null}
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ blocks -- */

const HR_RE = /^\s{0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;
const FENCE_RE = /^(\s*)(`{3,}|~{3,})(.*)$/;

/** True when `lines[i]` opens a new block (so a paragraph must stop before it). */
function isBlockStart(lines: string[], i: number): boolean {
  const raw = lines[i];
  const trimmed = raw.replace(/\s+$/, '').trim();
  if (!trimmed) return true;
  if (FENCE_RE.test(raw)) return true;
  if (/^#{1,6}\s+/.test(trimmed)) return true;
  if (HR_RE.test(raw.replace(/\s+$/, ''))) return true;
  if (/^>/.test(trimmed)) return true;
  if (matchListLine(raw)) return true;
  if (trimmed.includes('|') && i + 1 < lines.length && isDelimRow(lines[i + 1])) return true;
  return false;
}

function renderBlocks(lines: string[], ctx: Ctx): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = raw.replace(/\s+$/, '').trim();

    if (!trimmed) {
      i++;
      continue;
    }

    // fenced code — an unterminated fence still renders as a code block
    const fence = FENCE_RE.exec(raw);
    if (fence) {
      const marker = fence[2][0];
      const len = fence[2].length;
      const lang = fence[3].trim();
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const close = /^\s*(`{3,}|~{3,})\s*$/.exec(lines[i]);
        if (close && close[1][0] === marker && close[1].length >= len) {
          i++;
          break;
        }
        body.push(lines[i]);
        i++;
      }
      out.push(
        <div className="md-codeblock" key={nextKey(ctx)}>
          {lang ? <div className="md-codeblock__lang">{lang}</div> : null}
          <pre className="md-pre">
            <code>{body.join('\n')}</code>
          </pre>
        </div>,
      );
      continue;
    }

    // heading # .. ######
    const h = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (h) {
      const level = h[1].length;
      const content = h[2].replace(/\s*#+\s*$/, '');
      out.push(
        createElement(
          `h${level}`,
          { className: `md-h md-h--${level}`, key: nextKey(ctx) },
          inline(content, ctx),
        ),
      );
      i++;
      continue;
    }

    // horizontal rule
    if (HR_RE.test(raw.replace(/\s+$/, ''))) {
      out.push(<hr className="md-hr" key={nextKey(ctx)} />);
      i++;
      continue;
    }

    // blockquote — recurse so lists, code and nested quotes work inside
    if (/^>/.test(trimmed)) {
      const inner: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        inner.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(
        <blockquote className="md-quote" key={nextKey(ctx)}>
          {renderBlocks(inner, ctx)}
        </blockquote>,
      );
      continue;
    }

    // table — header row followed by a |---|---| delimiter row
    if (trimmed.includes('|') && i + 1 < lines.length && isDelimRow(lines[i + 1])) {
      const header = splitRow(trimmed);
      const aligns = splitRow(lines[i + 1].trim()).map(delimAlign);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length) {
        const t = lines[i].replace(/\s+$/, '');
        if (!t.trim() || !t.includes('|')) break;
        rows.push(splitRow(t.trim()));
        i++;
      }
      out.push(renderTable(header, aligns, rows, ctx));
      continue;
    }

    // list — collect the run, then nest by indentation
    const first = matchListLine(raw);
    if (first) {
      const items: FlatItem[] = [];
      const baseIndent = first.indent;
      while (i < lines.length) {
        const cur = lines[i];
        if (!cur.trim()) break;
        const it = matchListLine(cur);
        if (it) {
          items.push(it);
          i++;
          continue;
        }
        // an indented non-marker line continues the previous item
        if (items.length && indentOf(cur.match(/^[ \t]*/)![0]) > baseIndent + 1) {
          const last = items[items.length - 1];
          last.text = last.text ? `${last.text} ${cur.trim()}` : cur.trim();
          i++;
          continue;
        }
        break;
      }
      out.push(renderList(nest(items), ctx));
      continue;
    }

    // paragraph — single newlines inside it are preserved as line breaks
    const para: string[] = [trimmed];
    i++;
    while (i < lines.length) {
      const t = lines[i].trim();
      if (!t || isBlockStart(lines, i)) break;
      para.push(t);
      i++;
    }
    out.push(
      <p className="md-p" key={nextKey(ctx)}>
        {para.map((l, idx) => (
          <Fragment key={idx}>
            {idx > 0 ? <br /> : null}
            {inline(l, ctx)}
          </Fragment>
        ))}
      </p>,
    );
  }

  return out;
}

/* -------------------------------------------------------------- component -- */

export default function Markdown({ text, className }: { text: string; className?: string }) {
  const src = typeof text === 'string' ? text : text == null ? '' : String(text);
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const ctx: Ctx = { n: 0 };
  const blocks = renderBlocks(lines, ctx);

  return <div className={`md${className ? ` ${className}` : ''}`}>{blocks}</div>;
}
