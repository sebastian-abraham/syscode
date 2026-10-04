import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store.tsx';
import ProposalCard from './ProposalCard.tsx';
import { IconSend, IconX } from './icons.tsx';

export default function ChatPanel() {
  const {
    chat,
    streaming,
    busy,
    selected,
    view,
    chatScopeId,
    setChatScope,
    clearSelection,
    sendChat,
  } = useStore();

  const [draft, setDraft] = useState('');
  const logRef = useRef<HTMLDivElement>(null);

  const scopeId = chatScopeId ?? selected?.id ?? null;
  const scopeNode =
    view?.nodes.find((n) => n.id === scopeId) ??
    (selected && selected.id === scopeId ? selected : null);

  const messages = useMemo(() => chat.slice(-60), [chat]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  const submit = () => {
    const text = draft.trim();
    if (!text || busy.chat) return;
    setDraft('');
    void sendChat(text, scopeId);
  };

  return (
    <aside className="panel chat">
      <header className="panel__head">
        <span className="panel__title">Agent</span>
        <span className="chip chip--quiet">
          {busy.chat ? 'thinking…' : 'ready'}
        </span>
      </header>

      <div className="chat__scope">
        {scopeNode ? (
          <span className="chat__scope-chip">
            <span className="chat__scope-label">
              working on: {scopeNode.label}
            </span>
            <button
              type="button"
              className="chat__scope-x"
              title="Clear scope — work on the whole project"
              onClick={() => {
                setChatScope(null);
                clearSelection();
              }}
            >
              <IconX size={11} />
            </button>
          </span>
        ) : (
          <span className="chat__scope-chip chat__scope-chip--global">
            <span className="chat__scope-label">whole project</span>
          </span>
        )}
      </div>

      <div className="chat__log" ref={logRef}>
        {messages.length === 0 && !streaming && (
          <div className="empty-note">
            Ask about the system, or tell the agent what to build. Select a node first to scope the
            conversation to it — the agent then works with just that context.
          </div>
        )}

        {messages.map((msg) => (
          <div className={`msg msg--${msg.role}`} key={msg.id}>
            <div className="msg__role">
              {msg.role === 'user' ? 'you' : 'agent'}
              {msg.brain && msg.role === 'agent' && (
                <span className="msg__scope-tag">{msg.brain}</span>
              )}
            </div>
            <div className="msg__body">{msg.text}</div>
            {msg.proposalId && <InlineProposal id={msg.proposalId} />}
          </div>
        ))}

        {streaming && (
          <div className="msg msg--agent">
            <div className="msg__role">agent</div>
            <div className="msg__body">
              {streaming.text}
              <span className="msg__cursor" />
            </div>
          </div>
        )}
      </div>

      <div className="chat__composer">
        <textarea
          className="chat__input"
          placeholder={
            scopeNode ? `Ask about ${scopeNode.label}…` : 'Ask about the system, or describe a change…'
          }
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="chat__actions">
          <span className="chat__hint">
            <span className="kbd">Enter</span> to send · <span className="kbd">Shift</span>+
            <span className="kbd">Enter</span> for a new line
          </span>
          <button
            type="button"
            className="btn btn--primary"
            onClick={submit}
            disabled={!draft.trim() || busy.chat}
          >
            <IconSend size={14} />
            Send
          </button>
        </div>
      </div>
    </aside>
  );
}

function InlineProposal({ id }: { id: string }) {
  const { proposals } = useStore();
  const proposal = proposals.find((p) => p.id === id);
  if (!proposal) return null;
  return <ProposalCard proposal={proposal} inline />;
}
