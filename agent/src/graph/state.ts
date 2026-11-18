import { Annotation } from '@langchain/langgraph';
import type { Intent } from '../intents.js';
import type { PolicyDecision, RiskTier } from '../policy.js';
import type { ToolCall } from '../tools/registry.js';

/* PrivacyAgentState holds references and decisions only — ids, masked aliases, hashes, statuses.
 * No passwords, vault material, provider keys, session tokens or message bodies are ever placed here,
 * because this object is checkpointed to Postgres after every node. tests/security.test.ts scans checkpoints. */

export interface AliasRef { id: string; masked: string; service: string; serviceDomain: string; providerId: string }
export interface SenderRef { id: string; address: string; domain: string; blocked: boolean; classification: string | null }
export interface Candidate { aliasId: string; senderId?: string; label: string }
export interface ProposalView {
  id: string; action: string; aliasId: string; senderId: string | null; providerId: string; actionHash: string; reversible: boolean;
  supported: boolean; title: string; effect: string; undo: string | null; target: Record<string, unknown>; checklist?: string[]; alternative: string | null;
}
export type ApprovalStatus = 'not_required' | 'pending' | 'approved' | 'declined' | 'expired' | 'auto_approved';
export type WorkflowStatus = 'planned' | 'awaiting_approval' | 'running' | 'requested' | 'verified' | 'failed' | 'unsupported'
  | 'denied' | 'declined' | 'expired' | 'completed' | 'needs_target' | 'cancelled';

const last = <T>(d: T) => Annotation<T>({ reducer: (_a: T, b: T) => b, default: () => d });
const append = <T>() => Annotation<T[]>({ reducer: (a: T[], b: T[]) => a.concat(b ?? []), default: () => [] });

export const PrivacyAgentState = Annotation.Root({
  threadId: last<string>(''),
  userId: last<string>(''),
  deviceId: last<string>(''),
  requestText: last<string>(''),
  structured: last<{ intent?: Intent; aliasId?: string; senderId?: string } | null>(null),
  intent: last<Intent | null>(null),
  intentSource: last<'rules' | 'llm' | 'structured' | null>(null),
  mentions: last<{ emails: string[]; domains: string[] }>({ emails: [], domains: [] }),
  aliasRef: last<AliasRef | null>(null),
  senderRef: last<SenderRef | null>(null),
  resolution: last<{ method: string; detail: string } | null>(null),
  candidates: last<Candidate[]>([]),
  evidenceRefs: last<string[]>([]),
  findings: last<Record<string, unknown> | null>(null),
  remoteState: last<{ aliasEnabled?: boolean; senderBlocked?: boolean; providerReachable: boolean } | null>(null),
  candidateActions: last<ProposalView[]>([]),
  selectedAction: last<ProposalView | null>(null),
  policyResult: last<PolicyDecision | null>(null),
  riskTier: last<RiskTier | null>(null),
  approvalStatus: last<ApprovalStatus>('not_required'),
  approvalId: last<string | null>(null),
  executionReceipt: last<{ receiptId: string; status: string; attempts: number; duplicate?: boolean; errorCode?: string } | null>(null),
  verificationResult: last<{ status: string; observed?: Record<string, unknown>; detail?: string } | null>(null),
  errorCode: last<string | null>(null),
  status: last<WorkflowStatus>('planned'),
  explanation: last<string>(''),
  path: append<string>(),
  toolCalls: append<ToolCall>(),
  timestamps: Annotation<Record<string, string>>({ reducer: (a, b) => ({ ...a, ...b }), default: () => ({}) }),
});

export type State = typeof PrivacyAgentState.State;
export type Update = Partial<typeof PrivacyAgentState.Update>;
