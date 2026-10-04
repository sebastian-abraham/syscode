/**
 * The shared model lives in the core engine. This barrel re-exports it so the
 * interface imports the contract types from one place — they are never
 * redefined here (see docs/CONTRACT.md).
 */
export type {
  NodeKind,
  Provenance,
  Anchor,
  Note,
  MapNode,
  EdgeKind,
  MapEdge,
  MapView,
  ProjectInfo,
  ContextItem,
  ScopedContext,
  MapOp,
  Proposal,
  DetectedChange,
  RefreshReport,
  FileFacts,
  ImportFact,
  SymbolFact,
  RepoFacts,
  ChatEvent,
  ChatMessage,
  JournalEntry,
  SyscodeConfig,
} from '../../../packages/core/src/types.ts';
