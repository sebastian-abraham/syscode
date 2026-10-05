import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store.tsx';
import type { ChatSession } from '../types.ts';
import Markdown from './Markdown.tsx';
import ProposalCard from './ProposalCard.tsx';
import { IconChat, IconChevron, IconPencil, IconPlus, IconSend, IconTrash, IconX } from './icons.tsx';

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
    sessions,
    activeSessionId,
    newChat,
    openSession,
    renameSession,
    deleteSession,
  } = useStore();

  const [draft, setDraft] = useState('');
  const [listOpen, setListOpen] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);

  const scopeId = chatScopeId ?? selected?.id ?? null;
  const scopeNode =
    view?.nodes.find((n) => n.id === scopeId) ??
    (selected && selected.id === scopeId ? selected : null);

  const messages = useMemo(() => chat.slice(-60), [chat]);
  const active = sessions.find((s) => s.id === activeSessionId) ?? null;

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  // The conversation list is a popover: close it on a click outside, or on Escape.
  useEffect(() => {
    if (!listOpen) return undefined;
    const onDown = (event: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(event.target as Node)) setListOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setListOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [listOpen]);

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
        <span className="chip chip--quiet">{busy.chat ? 'thinking…' : 'ready'}</span>
      </header>

      <div className="chat__bar" ref={barRef}>
        <button
          type="button"
          className="chat__picker"
          onClick={() => setListOpen((open) => !open)}
          title="Switch, rename or delete a conversation"
          aria-expanded={listOpen}
        >
          <IconChat size={13} />
          <span className="chat__picker-title">{active?.title ?? 'New chat'}</span>
          <IconChevron size={12} />
        </button>
        <button
          type="button"
          className="chat__new"
          onClick={() => {
            newChat();
            setListOpen(false);
          }}
          title="New chat"
        >
          <IconPlus size={14} />
        </button>

        {listOpen && (
          <div className="sessions">
            <div className="sessions__head">
              <span className="sessions__label">Conversations</span>
              <span className="sessions__count">
                {sessions.length === 0 ? '' : `${sessions.length}`}
              </span>
            </div>
            <div className="sessions__list">
              {sessions.length === 0 ? (
                <p className="sessions__empty">
                  Nothing saved yet — your first message starts a conversation and titles it.
                </p>
              ) : (
                sessions.map((session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    active={session.id === activeSessionId}
                    onOpen={() => {
                      void openSession(session.id);
                      setListOpen(false);
                    }}
                    onRename={(title) => void renameSession(session.id, title)}
                    onDelete={() => void deleteSession(session.id)}
                  />
                ))
              )}
            </div>
          </div>
        )}
      </div>

      <div className="chat__scope">
        {scopeNode ? (
          <span className="chat__scope-chip">
            <span className="chat__scope-label">working on: {scopeNode.label}</span>
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
            {/* The agent answers in markdown; what you typed stays exactly as you typed it. */}
            {msg.role === 'agent' ? (
              <Markdown text={msg.text} className="msg__body msg__body--md" />
            ) : (
              <div className="msg__body">{msg.text}</div>
            )}
            {msg.proposalId && <InlineProposal id={msg.proposalId} />}
          </div>
        ))}

        {streaming && (
          <div className="msg msg--agent">
            <div className="msg__role">agent</div>
            <Markdown text={streaming.text} className="msg__body msg__body--md" />
            <span className="msg__cursor" />
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

/**
 * One conversation in the list. Renaming happens in place, and deleting asks first —
 * losing a conversation should take two deliberate clicks.
 */
function SessionRow({
  session,
  active,
  onOpen,
  onRename,
  onDelete,
}: {
  session: ChatSession;
  active: boolean;
  onOpen: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [title, setTitle] = useState(session.title);

  useEffect(() => setTitle(session.title), [session.title]);

  if (confirming) {
    return (
      <div className="session session--confirm">
        <span className="session__ask">Delete this conversation?</span>
        <button
          type="button"
          className="btn btn--danger btn--sm"
          onClick={() => {
            setConfirming(false);
            onDelete();
          }}
        >
          Delete
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => setConfirming(false)}
        >
          Keep
        </button>
      </div>
    );
  }

  if (editing) {
    return (
      <div className="session session--editing">
        <input
          className="session__input"
          value={title}
          autoFocus
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              setEditing(false);
              if (title.trim() && title !== session.title) onRename(title);
            }
            if (e.key === 'Escape') {
              setEditing(false);
              setTitle(session.title);
            }
          }}
          onBlur={() => {
            setEditing(false);
            if (title.trim() && title !== session.title) onRename(title);
          }}
        />
      </div>
    );
  }

  return (
    <div className={`session${active ? ' session--active' : ''}`}>
      <button type="button" className="session__open" onClick={onOpen} title={session.title}>
        <span className="session__title">{session.title}</span>
        <span className="session__meta">
          {session.messageCount ? `${session.messageCount} messages` : 'empty'} ·{' '}
          {timeAgo(session.updatedAt)}
        </span>
      </button>
      <button
        type="button"
        className="session__act"
        title="Rename"
        onClick={() => setEditing(true)}
      >
        <IconPencil size={12} />
      </button>
      <button
        type="button"
        className="session__act session__act--danger"
        title="Delete"
        onClick={() => setConfirming(true)}
      >
        <IconTrash size={12} />
      </button>
    </div>
  );
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function InlineProposal({ id }: { id: string }) {
  const { proposals } = useStore();
  const proposal = proposals.find((p) => p.id === id);
  if (!proposal) return null;
  return <ProposalCard proposal={proposal} inline />;
}
