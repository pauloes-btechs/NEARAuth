/* Single source of truth for the graph's shape. graph.ts wires LangGraph from these lists, and the API serves them
 * to the dashboard, so the picture the user sees is the graph that actually runs. */

export interface NodeSpec { id: string; n: number | null; label: string; kind: 'core' | 'route' | 'interrupt' | 'terminal'; does: string }
export interface EdgeSpec { from: string; to: string; when: string | null }

export const NODES: NodeSpec[] = [
  { id: 'parse_intent', n: 1, label: 'Parse intent', kind: 'core', does: 'Maps the request onto a fixed list of intents using deterministic rules; an optional local model is consulted only if the rules find nothing. The model can only pick an intent — never a tool.' },
  { id: 'authorize', n: 2, label: 'Authenticate & authorize', kind: 'core', does: 'Checks the signed-in user exists and has agentic features on. The session itself was verified by the API before the graph started or resumed.' },
  { id: 'resolve_target', n: 3, label: 'Resolve target', kind: 'core', does: 'Finds the exact alias and sender by database lookup (ids, exact email or service-name match). Uses vector similarity only to suggest a service when nothing matches exactly. Never guesses ownership.' },
  { id: 'select_target', n: null, label: 'Ask which one', kind: 'interrupt', does: 'Pauses the graph and asks you to pick when more than one alias or sender fits.' },
  { id: 'retrieve_context', n: 4, label: 'Retrieve context', kind: 'core', does: 'Re-reads provider state, classifies the sender, and pulls relevant non-secret playbooks.' },
  { id: 'propose_actions', n: 5, label: 'Propose actions', kind: 'core', does: 'Builds structured proposals (effect, reversibility, undo) and picks the least disruptive one. Proposals change nothing.' },
  { id: 'evaluate_policy', n: 6, label: 'Evaluate policy', kind: 'core', does: 'Runs the deterministic rules P1–P12: ownership, provider capability, original-service and legitimate-third-party checks, already-done, rate limit, approval requirement.' },
  { id: 'request_approval', n: 7, label: 'Request approval', kind: 'interrupt', does: 'Creates a single-use, expiring approval bound to the exact action hash and pauses until you approve or decline.' },
  { id: 'revalidate_execute', n: 8, label: 'Revalidate & execute', kind: 'core', does: 'Consumes the approval, re-reads the target and re-runs policy; aborts if anything changed. Then calls exactly one scoped tool with an idempotency key, retrying only transient errors.' },
  { id: 'verify_outcome', n: 9, label: 'Verify outcome', kind: 'core', does: 'Re-reads the provider to confirm the change. Distinguishes requested, verified and failed.' },
  { id: 'finalize', n: 10, label: 'Record & explain', kind: 'core', does: 'Stores a sanitized receipt and a local audit commitment (not on-chain), updates the workflow, and explains what happened.' },
  { id: 'explain_limitation', n: null, label: 'Explain limitation', kind: 'terminal', does: 'Explains why a request cannot be done and offers what can.' },
  { id: 'deny', n: null, label: 'Deny', kind: 'terminal', does: 'Stops because a rule failed.' },
  { id: 'return_findings', n: null, label: 'Return findings', kind: 'terminal', does: 'Read-only requests end here with their findings.' },
  { id: 'record_decline', n: null, label: 'Record decline', kind: 'terminal', does: 'You declined (or the approval expired); nothing was executed.' },
  { id: 'already_done', n: null, label: 'Already done', kind: 'terminal', does: 'The provider already reports the requested state; nothing to do.' },
];

export const EDGES: EdgeSpec[] = [
  { from: '__start__', to: 'parse_intent', when: null },
  { from: 'parse_intent', to: 'authorize', when: 'intent understood' },
  { from: 'parse_intent', to: 'explain_limitation', when: 'unsupported request' },
  { from: 'authorize', to: 'resolve_target', when: 'authorized' },
  { from: 'authorize', to: 'deny', when: 'authorization failed' },
  { from: 'resolve_target', to: 'retrieve_context', when: 'target resolved' },
  { from: 'resolve_target', to: 'select_target', when: 'ambiguous target' },
  { from: 'resolve_target', to: 'explain_limitation', when: 'no matching target' },
  { from: 'select_target', to: 'resolve_target', when: 'you picked one' },
  { from: 'select_target', to: 'deny', when: 'invalid choice' },
  { from: 'resolve_target', to: 'deny', when: 'target not owned' },
  { from: 'retrieve_context', to: 'return_findings', when: 'read-only request' },
  { from: 'retrieve_context', to: 'propose_actions', when: 'write request' },
  { from: 'propose_actions', to: 'evaluate_policy', when: null },
  { from: 'evaluate_policy', to: 'request_approval', when: 'allowed, needs approval' },
  { from: 'evaluate_policy', to: 'revalidate_execute', when: 'covered by a standing policy' },
  { from: 'evaluate_policy', to: 'deny', when: 'rule failed' },
  { from: 'evaluate_policy', to: 'explain_limitation', when: 'unsupported action' },
  { from: 'evaluate_policy', to: 'already_done', when: 'already in that state' },
  { from: 'request_approval', to: 'revalidate_execute', when: 'approved' },
  { from: 'request_approval', to: 'record_decline', when: 'declined or expired' },
  { from: 'revalidate_execute', to: 'verify_outcome', when: 'executed' },
  { from: 'revalidate_execute', to: 'already_done', when: 'already completed' },
  { from: 'revalidate_execute', to: 'deny', when: 'revalidation failed' },
  { from: 'revalidate_execute', to: 'finalize', when: 'execution failed after bounded retries' },
  { from: 'verify_outcome', to: 'finalize', when: null },
  { from: 'explain_limitation', to: 'finalize', when: null },
  { from: 'deny', to: 'finalize', when: null },
  { from: 'return_findings', to: 'finalize', when: null },
  { from: 'record_decline', to: 'finalize', when: null },
  { from: 'already_done', to: 'finalize', when: null },
  { from: 'finalize', to: '__end__', when: null },
];

export function toMermaid(executed: string[] = []): string {
  const done = new Set(executed);
  const lines = ['flowchart TD', '  __start__([start]) --> parse_intent'];
  for (const n of NODES) {
    const label = (n.n ? `${n.n}. ` : '') + n.label;
    lines.push(n.kind === 'interrupt' ? `  ${n.id}{{"${label}"}}` : n.kind === 'terminal' ? `  ${n.id}(["${label}"])` : `  ${n.id}["${label}"]`);
  }
  lines.push('  __end__([end])');
  for (const e of EDGES.filter((e) => e.from !== '__start__')) lines.push(`  ${e.from} -->${e.when ? `|${e.when}|` : ''} ${e.to}`);
  for (const id of done) lines.push(`  style ${id} fill:#1f6f55,stroke:#6ce7be,color:#fff`);
  return lines.join('\n');
}
