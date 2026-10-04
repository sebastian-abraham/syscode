import { useStore } from '../store.tsx';
import { IconCode, IconX } from './icons.tsx';

export default function CodePeek() {
  const { codePeek, closeCodePeek } = useStore();
  if (!codePeek) return null;

  const { slice, nodeLabel } = codePeek;
  const lines = slice.text.length ? slice.text.split('\n') : [];
  const [hStart, hEnd] = slice.highlight ?? [0, 0];

  return (
    <section className="code-peek" aria-label="Code peek">
      <header className="code-peek__head">
        <IconCode size={14} />
        <span className="code-peek__path" title={slice.path}>
          {slice.path}
        </span>
        <span className="code-peek__range">
          {slice.start}–{slice.end}
        </span>
        <button type="button" className="close-x" onClick={closeCodePeek} title="Close code peek">
          <IconX size={14} />
        </button>
      </header>
      <div className="code-peek__body">
        {lines.length === 0 ? (
          <div className="empty-note" style={{ padding: '12px 14px' }}>
            No code text returned for {nodeLabel}. The anchor may point at a directory or a symbol
            the engine could not slice.
          </div>
        ) : (
          lines.map((text, i) => {
            const no = slice.start + i;
            const highlighted = slice.highlight ? no >= hStart && no <= hEnd : false;
            return (
              <div key={no} className={`code-line${highlighted ? ' code-line--hl' : ''}`}>
                <span className="code-line__no">{no}</span>
                <span className="code-line__text">{text === '' ? ' ' : text}</span>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
