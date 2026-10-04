import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api, ApiError, streamChat, subscribeEvents, type CodeSlice } from './api.ts';
import type {
  ChatMessage,
  EdgeKind,
  JournalEntry,
  MapNode,
  MapOp,
  MapView,
  Note,
  ProjectInfo,
  Proposal,
  RefreshReport,
  ScopedContext,
  SyscodeConfig,
} from './types.ts';

export type InspectorTab = 'overview' | 'notes' | 'context' | 'journal';
export type Status = 'loading' | 'waiting' | 'ready';

export interface Toast {
  id: string;
  level: 'info' | 'warn' | 'error' | 'success';
  text: string;
}

export interface CodePeekState {
  nodeId: string;
  nodeLabel: string;
  slice: CodeSlice;
}

interface BusyFlags {
  view: boolean;
  chat: boolean;
  refresh: boolean;
  node: boolean;
}

export interface StoreValue {
  status: Status;
  error: string | null;
  project: ProjectInfo | null;
  view: MapView | null;
  viewParentId: string | null;
  selected: MapNode | null;
  selectedContext: ScopedContext | null;
  journal: JournalEntry[];
  proposals: Proposal[];
  pendingProposals: Proposal[];
  chat: ChatMessage[];
  streaming: { id: string; text: string } | null;
  busy: BusyFlags;
  codePeek: CodePeekState | null;
  inspectorTab: InspectorTab;
  refreshReport: RefreshReport | null;
  addNodeOpen: boolean;
  toasts: Toast[];
  config: SyscodeConfig | null;
  justAddedId: string | null;
  chatScopeId: string | null;

  // lifecycle
  init: () => void;
  refreshProject: () => Promise<void>;

  // navigation
  loadView: (parentId: string | null, opts?: { silent?: boolean }) => Promise<void>;
  drillInto: (nodeId: string) => Promise<void>;
  climbTo: (parentId: string | null) => Promise<void>;
  climbOut: () => Promise<void>;

  // selection + inspector
  selectNode: (node: MapNode) => void;
  clearSelection: () => void;
  setInspectorTab: (tab: InspectorTab) => void;
  openContext: (context: ScopedContext) => Promise<void>;
  loadContext: (nodeId: string) => Promise<void>;

  // node editing
  moveNode: (id: string, position: { x: number; y: number }) => Promise<void>;
  renameNode: (id: string, label: string) => Promise<void>;
  createNode: (body: { label: string; summary: string; parentId?: string | null; kind?: MapNode['kind'] }) => Promise<MapNode | null>;
  createEdge: (body: { source: string; target: string; label: string; kind?: EdgeKind }) => Promise<void>;
  addNote: (nodeId: string, body: string, kind: Note['kind']) => Promise<void>;
  deleteNote: (nodeId: string, noteId: string) => Promise<void>;

  // code peek
  openCodePeek: (node: MapNode, anchorIndex: number) => Promise<void>;
  closeCodePeek: () => void;

  // approvals + refresh
  refresh: () => Promise<void>;
  closeRefreshReport: () => void;
  approveProposal: (id: string) => Promise<void>;
  rejectProposal: (id: string) => Promise<void>;
  applyOps: (ops: MapOp[]) => Promise<{ applied: number; skipped: number }>;

  // chat
  sendChat: (text: string, scopeNodeId: string | null) => Promise<void>;
  setChatScope: (nodeId: string | null) => void;

  // dialogs
  setAddNodeOpen: (open: boolean) => void;

  // config
  saveConfig: (patch: Partial<SyscodeConfig>) => Promise<void>;

  // toasts
  toast: (level: Toast['level'], text: string) => void;
  dismissToast: (id: string) => void;
}

const StoreContext = createContext<StoreValue | null>(null);

export function useStore(): StoreValue {
  const value = useContext(StoreContext);
  if (!value) throw new Error('useStore must be used inside <StoreProvider>');
  return value;
}

let seq = 0;
function uid(prefix = 'u'): string {
  seq += 1;
  const rand = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${seq}`;
  return `${prefix}-${rand}`;
}

function messageFromError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [view, setView] = useState<MapView | null>(null);
  const [selected, setSelected] = useState<MapNode | null>(null);
  const [selectedContext, setSelectedContext] = useState<ScopedContext | null>(null);
  const [journal, setJournal] = useState<JournalEntry[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState<BusyFlags>({ view: false, chat: false, refresh: false, node: false });
  const [codePeek, setCodePeek] = useState<CodePeekState | null>(null);
  const [inspectorTab, setInspectorTabState] = useState<InspectorTab>('overview');
  const [refreshReport, setRefreshReport] = useState<RefreshReport | null>(null);
  const [addNodeOpen, setAddNodeOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [config, setConfig] = useState<SyscodeConfig | null>(null);
  const [justAddedId, setJustAddedId] = useState<string | null>(null);
  const [chatScopeId, setChatScopeId] = useState<string | null>(null);

  const viewParentRef = useRef<string | null>(null);
  const projectRef = useRef<ProjectInfo | null>(null);
  projectRef.current = project;
  const selectedRef = useRef<MapNode | null>(null);
  selectedRef.current = selected;

  const toast = useCallback((level: Toast['level'], text: string) => {
    const id = uid('toast');
    setToasts((list) => [...list, { id, level, text }]);
    if (level !== 'error') {
      window.setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 5200);
    } else {
      window.setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 9000);
    }
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const setInspectorTab = useCallback((tab: InspectorTab) => setInspectorTabState(tab), []);

  // -------------------------------------------------------------------------
  // Loaders
  // -------------------------------------------------------------------------

  const refreshProject = useCallback(async () => {
    try {
      const p = await api.project();
      setProject(p);
    } catch {
      /* non-fatal */
    }
  }, []);

  const refreshProposals = useCallback(async () => {
    try {
      const list = await api.proposals();
      setProposals(list);
    } catch {
      /* non-fatal */
    }
  }, []);

  const loadView = useCallback(
    async (parentId: string | null, opts?: { silent?: boolean }) => {
      if (!opts?.silent) setBusy((b) => ({ ...b, view: true }));
      try {
        const v = await api.map(parentId);
        viewParentRef.current = parentId;
        setView(v);
        setCodePeek(null);
        setProject((prev) =>
          prev ? { ...prev, stats: { ...prev.stats, staleCount: v.staleCount, nodeCount: v.totalNodes } } : prev,
        );
        setStatus('ready');
        setError(null);
      } catch (err) {
        if (!opts?.silent) {
          setError(messageFromError(err));
          toast('error', `Could not load the map: ${messageFromError(err)}`);
        }
      } finally {
        if (!opts?.silent) setBusy((b) => ({ ...b, view: false }));
      }
    },
    [toast],
  );

  const init = useCallback(async () => {
    setStatus('loading');
    setError(null);
    try {
      const health = await api.health();
      if (!health?.ok) throw new Error('engine reported an unhealthy state');
    } catch (err) {
      setStatus('waiting');
      setError(messageFromError(err));
      return;
    }
    const [p, v, props, hist, jr, cfg] = await Promise.all([
      api.project().catch(() => null),
      api.map(null).catch(() => null),
      api.proposals().catch(() => [] as Proposal[]),
      api.chatHistory().catch(() => [] as ChatMessage[]),
      api.journal(60).catch(() => [] as JournalEntry[]),
      api.config().catch(() => null),
    ]);
    if (p) setProject(p);
    if (v) {
      setView(v);
      viewParentRef.current = null;
    }
    setProposals(props);
    setChat(hist);
    setJournal(jr);
    setConfig(cfg);
    if (!v) {
      setStatus('waiting');
      setError('The engine is reachable but returned no map.');
      return;
    }
    setStatus('ready');
  }, []);

  useEffect(() => {
    void init();
  }, [init]);

  // Live map/proposal events from the engine.
  useEffect(() => {
    if (status !== 'ready') return;
    const off = subscribeEvents(
      (event) => {
        if (event.type === 'proposal-created') {
          void refreshProposals();
        } else if (event.type === 'map-changed') {
          void loadView(viewParentRef.current, { silent: true });
        } else if (event.type === 'refreshed') {
          void refreshProposals();
          void refreshProject();
        }
      },
      () => {
        /* stream will retry through user actions; stay silent */
      },
    );
    return off;
  }, [status, loadView, refreshProposals, refreshProject]);

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  const drillInto = useCallback(
    async (nodeId: string) => {
      setSelected(null);
      setSelectedContext(null);
      setChatScopeId(null);
      await loadView(nodeId);
    },
    [loadView],
  );

  const climbTo = useCallback(async (parentId: string | null) => {
    if (parentId === viewParentRef.current) return;
    setSelected(null);
    setSelectedContext(null);
    await loadView(parentId);
  }, [loadView]);

  const climbOut = useCallback(async () => {
    const current = view;
    const parent = current?.parent ?? null;
    await climbTo(parent ? parent.parentId : null);
  }, [view, climbTo]);

  // -------------------------------------------------------------------------
  // Selection + inspector
  // -------------------------------------------------------------------------

  const selectNode = useCallback((node: MapNode) => {
    setSelected(node);
    setInspectorTabState('overview');
    setSelectedContext(null);
    void api
      .node(node.id)
      .then((fresh) => {
        setSelected((cur) => (cur && cur.id === fresh.id ? { ...cur, ...fresh } : cur));
      })
      .catch(() => {
        /* keep the node we already have */
      });
  }, []);

  const clearSelection = useCallback(() => {
    setSelected(null);
    setSelectedContext(null);
  }, []);

  const openContext = useCallback(
    async (context: ScopedContext) => {
      setSelectedContext(context);
      setInspectorTabState('context');
      const targetId = context.nodeId;
      if (!targetId) return;
      if (selectedRef.current?.id === targetId) return;
      const inView = view?.nodes.find((n) => n.id === targetId);
      if (inView) {
        setSelected(inView);
        return;
      }
      try {
        const node = await api.node(targetId);
        setSelected(node);
      } catch {
        /* context still renders even if the node cannot be fetched */
      }
    },
    [view],
  );

  const loadContext = useCallback(
    async (nodeId: string) => {
      try {
        const ctx = await api.nodeContext(nodeId);
        setSelectedContext(ctx);
      } catch (err) {
        toast('error', `Could not load the node context: ${messageFromError(err)}`);
      }
    },
    [toast],
  );

  // -------------------------------------------------------------------------
  // Node + edge editing
  // -------------------------------------------------------------------------

  const applyNodeUpdate = useCallback((updated: MapNode) => {
    setView((v) => (v ? { ...v, nodes: v.nodes.map((n) => (n.id === updated.id ? { ...n, ...updated } : n)) } : v));
    setSelected((s) => (s && s.id === updated.id ? { ...s, ...updated } : s));
  }, []);

  const moveNode = useCallback(
    async (id: string, position: { x: number; y: number }) => {
      // Optimistic: the node must not jump back while the patch is in flight.
      setView((v) =>
        v ? { ...v, nodes: v.nodes.map((n) => (n.id === id ? { ...n, position, positionLocked: true } : n)) } : v,
      );
      setSelected((s) => (s && s.id === id ? { ...s, position, positionLocked: true } : s));
      try {
        const updated = await api.patchNode(id, { position, positionLocked: true });
        applyNodeUpdate(updated);
      } catch (err) {
        toast('error', `Could not save the position: ${messageFromError(err)}`);
        void loadView(viewParentRef.current, { silent: true });
      }
    },
    [applyNodeUpdate, loadView, toast],
  );

  const renameNode = useCallback(
    async (id: string, label: string) => {
      const trimmed = label.trim();
      if (!trimmed) return;
      try {
        const updated = await api.patchNode(id, { label: trimmed, labelLocked: true });
        applyNodeUpdate(updated);
        toast('success', 'Renamed — this label is now protected.');
      } catch (err) {
        toast('error', `Could not rename: ${messageFromError(err)}`);
      }
    },
    [applyNodeUpdate, toast],
  );

  const createNode = useCallback(
    async (body: { label: string; summary: string; parentId?: string | null; kind?: MapNode['kind'] }) => {
      setBusy((b) => ({ ...b, node: true }));
      try {
        const parentId = body.parentId !== undefined ? body.parentId : viewParentRef.current;
        const node = await api.createNode({ ...body, parentId });
        setJustAddedId(node.id);
        window.setTimeout(() => setJustAddedId((cur) => (cur === node.id ? null : cur)), 2400);
        if (parentId === viewParentRef.current) {
          await loadView(viewParentRef.current, { silent: true });
          setSelected(node);
          setInspectorTabState('overview');
        }
        await refreshProject();
        toast('success', `Added “${node.label}” — marked as yours.`);
        return node;
      } catch (err) {
        toast('error', `Could not add the node: ${messageFromError(err)}`);
        return null;
      } finally {
        setBusy((b) => ({ ...b, node: false }));
      }
    },
    [loadView, refreshProject, toast],
  );

  const createEdge = useCallback(
    async (body: { source: string; target: string; label: string; kind?: EdgeKind }) => {
      try {
        const edge = await api.createEdge(body);
        await loadView(viewParentRef.current, { silent: true });
        toast('success', `Connected — “${edge.label}”.`);
      } catch (err) {
        toast('error', `Could not create the connection: ${messageFromError(err)}`);
      }
    },
    [loadView, toast],
  );

  const addNote = useCallback(
    async (nodeId: string, body: string, kind: Note['kind']) => {
      try {
        const note = await api.addNote(nodeId, { body, kind });
        setSelected((s) => (s && s.id === nodeId ? { ...s, notes: [...s.notes, note] } : s));
        setView((v) =>
          v ? { ...v, nodes: v.nodes.map((n) => (n.id === nodeId ? { ...n, notes: [...n.notes, note] } : n)) } : v,
        );
        toast('success', kind === 'constraint' ? 'Constraint pinned to this node.' : 'Note added.');
      } catch (err) {
        toast('error', `Could not add the note: ${messageFromError(err)}`);
      }
    },
    [toast],
  );

  const deleteNote = useCallback(
    async (nodeId: string, noteId: string) => {
      try {
        await api.deleteNote(nodeId, noteId);
        setSelected((s) => (s && s.id === nodeId ? { ...s, notes: s.notes.filter((n) => n.id !== noteId) } : s));
        setView((v) =>
          v
            ? { ...v, nodes: v.nodes.map((n) => (n.id === nodeId ? { ...n, notes: n.notes.filter((x) => x.id !== noteId) } : n)) }
            : v,
        );
      } catch (err) {
        toast('error', `Could not remove the note: ${messageFromError(err)}`);
      }
    },
    [toast],
  );

  // -------------------------------------------------------------------------
  // Code peek
  // -------------------------------------------------------------------------

  const openCodePeek = useCallback(
    async (node: MapNode, anchorIndex: number) => {
      try {
        const slice = await api.nodeCode(node.id, anchorIndex);
        setCodePeek({ nodeId: node.id, nodeLabel: node.label, slice });
      } catch (err) {
        toast('error', `Could not read the code: ${messageFromError(err)}`);
      }
    },
    [toast],
  );

  const closeCodePeek = useCallback(() => setCodePeek(null), []);

  // -------------------------------------------------------------------------
  // Refresh + approvals
  // -------------------------------------------------------------------------

  const refresh = useCallback(async () => {
    setBusy((b) => ({ ...b, refresh: true }));
    try {
      const report = await api.refresh();
      setRefreshReport(report);
      await Promise.all([refreshProposals(), refreshProject()]);
      await loadView(viewParentRef.current, { silent: true });
    } catch (err) {
      toast('error', `Refresh failed: ${messageFromError(err)}`);
    } finally {
      setBusy((b) => ({ ...b, refresh: false }));
    }
  }, [loadView, refreshProposals, refreshProject, toast]);

  const closeRefreshReport = useCallback(() => setRefreshReport(null), []);

  const approveProposal = useCallback(
    async (id: string) => {
      try {
        const res = await api.approveProposal(id);
        setView(res.view);
        setProposals((list) => list.map((p) => (p.id === id ? res.proposal : p)));
        await refreshProject();
        toast('success', `Approved: ${res.proposal.title}`);
      } catch (err) {
        toast('error', `Could not approve: ${messageFromError(err)}`);
      }
    },
    [refreshProject, toast],
  );

  const rejectProposal = useCallback(
    async (id: string) => {
      try {
        const p = await api.rejectProposal(id);
        setProposals((list) => list.map((x) => (x.id === id ? p : x)));
        toast('info', 'Proposal rejected.');
      } catch (err) {
        toast('error', `Could not reject: ${messageFromError(err)}`);
      }
    },
    [toast],
  );

  const applyOps = useCallback(
    async (ops: MapOp[]) => {
      let applied = 0;
      let skipped = 0;
      for (const op of ops) {
        try {
          switch (op.op) {
            case 'add-node':
              await api.createNode({
                label: op.node.label,
                summary: op.node.summary,
                parentId: op.node.parentId ?? null,
                kind: op.node.kind,
                position: op.node.position,
              });
              applied += 1;
              break;
            case 'add-edge':
              await api.createEdge({ source: op.edge.source, target: op.edge.target, label: op.edge.label, kind: op.edge.kind });
              applied += 1;
              break;
            case 'rename-node':
              await api.patchNode(op.nodeId, { label: op.label });
              applied += 1;
              break;
            case 'update-summary':
              await api.patchNode(op.nodeId, { summary: op.summary });
              applied += 1;
              break;
            case 'remove-node':
              await api.deleteNode(op.nodeId);
              applied += 1;
              break;
            case 'remove-edge':
              await api.deleteEdge(op.edgeId);
              applied += 1;
              break;
            case 'reanchor-node':
            case 'move-node':
              // No direct contract endpoint owns these; the engine applies them
              // through a proposal, not a raw client patch.
              skipped += 1;
              break;
          }
        } catch {
          skipped += 1;
        }
      }
      await loadView(viewParentRef.current, { silent: true });
      await refreshProject();
      return { applied, skipped };
    },
    [loadView, refreshProject],
  );

  // -------------------------------------------------------------------------
  // Chat
  // -------------------------------------------------------------------------

  const sendChat = useCallback(
    async (text: string, scopeNodeId: string | null) => {
      const trimmed = text.trim();
      if (!trimmed || busy.chat) return;
      const brain = projectRef.current?.brain.mode ?? 'heuristic';
      const userMessage: ChatMessage = {
        id: uid('msg'),
        role: 'user',
        text: trimmed,
        nodeId: scopeNodeId,
        createdAt: new Date().toISOString(),
        brain,
      };
      setChat((list) => [...list, userMessage]);
      const agentId = uid('msg');
      setStreaming({ id: agentId, text: '' });
      setBusy((b) => ({ ...b, chat: true }));

      let acc = '';
      let proposalId: string | undefined;
      await streamChat(
        { message: trimmed, nodeId: scopeNodeId ?? undefined },
        {
          onEvent: (event) => {
            if (event.type === 'token') {
              acc += event.text;
              setStreaming({ id: agentId, text: acc });
            } else if (event.type === 'context') {
              void openContext(event.context);
            } else if (event.type === 'proposal') {
              proposalId = event.proposal.id;
              setProposals((list) => {
                const rest = list.filter((p) => p.id !== event.proposal.id);
                return [...rest, event.proposal];
              });
            } else if (event.type === 'notice') {
              toast(event.level === 'warn' ? 'warn' : 'info', event.text);
            }
          },
          onError: (err) => {
            toast('error', `Chat stream failed: ${messageFromError(err)}`);
          },
        },
      );

      setStreaming(null);
      setChat((list) => [
        ...list,
        {
          id: agentId,
          role: 'agent',
          text: acc || 'No response.',
          nodeId: scopeNodeId,
          createdAt: new Date().toISOString(),
          brain,
          proposalId,
        },
      ]);
      setBusy((b) => ({ ...b, chat: false }));
    },
    [busy.chat, openContext, toast],
  );

  const setChatScope = useCallback((nodeId: string | null) => setChatScopeId(nodeId), []);

  const saveConfig = useCallback(
    async (patch: Partial<SyscodeConfig>) => {
      try {
        const next = await api.patchConfig(patch);
        setConfig(next);
        await refreshProject();
        toast('success', next.provider === 'none' ? 'Model disconnected.' : `Connected ${next.provider}${next.model ? ` · ${next.model}` : ''}.`);
      } catch (err) {
        toast('error', `Could not update the model settings: ${messageFromError(err)}`);
      }
    },
    [refreshProject, toast],
  );

  const pendingProposals = useMemo(() => proposals.filter((p) => p.status === 'pending'), [proposals]);

  const value = useMemo<StoreValue>(
    () => ({
      status,
      error,
      project,
      view,
      viewParentId: view?.parent?.id ?? null,
      selected,
      selectedContext,
      journal,
      proposals,
      pendingProposals,
      chat,
      streaming,
      busy,
      codePeek,
      inspectorTab,
      refreshReport,
      addNodeOpen,
      toasts,
      config,
      justAddedId,
      chatScopeId,
      init,
      refreshProject,
      loadView,
      drillInto,
      climbTo,
      climbOut,
      selectNode,
      clearSelection,
      setInspectorTab,
      openContext,
      loadContext,
      moveNode,
      renameNode,
      createNode,
      createEdge,
      addNote,
      deleteNote,
      openCodePeek,
      closeCodePeek,
      refresh,
      closeRefreshReport,
      approveProposal,
      rejectProposal,
      applyOps,
      sendChat,
      setChatScope,
      setAddNodeOpen,
      saveConfig,
      toast,
      dismissToast,
    }),
    [
      status,
      error,
      project,
      view,
      selected,
      selectedContext,
      journal,
      proposals,
      pendingProposals,
      chat,
      streaming,
      busy,
      codePeek,
      inspectorTab,
      refreshReport,
      addNodeOpen,
      toasts,
      config,
      justAddedId,
      chatScopeId,
      init,
      refreshProject,
      loadView,
      drillInto,
      climbTo,
      climbOut,
      selectNode,
      clearSelection,
      setInspectorTab,
      openContext,
      loadContext,
      moveNode,
      renameNode,
      createNode,
      createEdge,
      addNote,
      deleteNote,
      openCodePeek,
      closeCodePeek,
      refresh,
      closeRefreshReport,
      approveProposal,
      rejectProposal,
      applyOps,
      sendChat,
      setChatScope,
      saveConfig,
      toast,
      dismissToast,
    ],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}
