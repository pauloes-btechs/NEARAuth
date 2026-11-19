import { z } from 'zod';
import { AgentError, sanitize } from '../util.js';

/* Typed, schema-validated tool registry with authorization enforced here — outside any model.
 *   read        callable by graph nodes, the API, and (in principle) a model
 *   propose     graph nodes only; writes a proposal row, changes nothing at the provider
 *   privileged  approve/deny/cancel: authenticated API calls only
 *               execute/verify: graph nodes only, and only with an ExecutionGrant minted after approval
 * There is deliberately no generic HTTP, shell, browser or credential tool. */

export type ToolKind = 'read' | 'propose' | 'privileged';
export type Caller = { type: 'node'; node: string } | { type: 'api'; sessionId: string } | { type: 'llm'; model: string };

export interface ExecutionGrant { readonly threadId: string; readonly proposalId: string; readonly actionHash: string; readonly approvalId: string | null; readonly policyId: string | null }
const GRANTS = new WeakSet<object>();
/** Only the revalidate node calls this, after consuming an approval (or confirming a standing policy). */
export function mintGrant(g: ExecutionGrant): ExecutionGrant { const f = Object.freeze({ ...g }); GRANTS.add(f); return f; }
export const isGrant = (g: unknown): g is ExecutionGrant => !!g && typeof g === 'object' && GRANTS.has(g as object);

export interface ToolContext { userId: string; caller: Caller; threadId?: string; grant?: ExecutionGrant }
export interface ToolCall { tool: string; kind: ToolKind; caller: string; input: unknown; output: unknown; status: 'ok' | 'error'; error?: string; ms: number; at: string }

export interface ToolDef<I extends z.ZodType, O> {
  name: string;
  kind: ToolKind;
  description: string;
  callers: Caller['type'][];
  input: I;
  run(ctx: ToolContext, input: z.infer<I>): Promise<O>;
  /** Short, non-secret summary for the timeline (defaults to the sanitized output). */
  summarize?(out: O): unknown;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDef<z.ZodType, unknown>>();
  register<I extends z.ZodType, O>(def: ToolDef<I, O>) { this.tools.set(def.name, def as unknown as ToolDef<z.ZodType, unknown>); return this; }
  list() { return [...this.tools.values()].map((t) => ({ name: t.name, kind: t.kind, description: t.description, callers: t.callers })); }

  async invoke<O = unknown>(name: string, rawInput: unknown, ctx: ToolContext, timeline?: ToolCall[]): Promise<O> {
    const started = Date.now();
    const def = this.tools.get(name);
    const callerLabel = ctx.caller.type === 'node' ? `node:${ctx.caller.node}` : ctx.caller.type === 'api' ? 'api' : `model:${ctx.caller.model}`;
    const log = (status: 'ok' | 'error', output: unknown, error?: string) => timeline?.push({
      tool: name, kind: def?.kind ?? 'read', caller: callerLabel, input: sanitize(rawInput), output: sanitize(output), status, error, ms: Date.now() - started, at: new Date().toISOString(),
    });
    try {
      if (!def) throw new AgentError('unknown_tool', `No tool named ${name}`, 404);
      if (!def.callers.includes(ctx.caller.type)) throw new AgentError('tool_forbidden', `${callerLabel} may not call ${name}`, 403);
      if (def.kind === 'privileged' && ctx.caller.type === 'node' && !isGrant(ctx.grant)) throw new AgentError('grant_required', `${name} needs an approval grant`, 403);
      const parsed = def.input.safeParse(rawInput);
      if (!parsed.success) throw new AgentError('invalid_tool_input', `Invalid input for ${name}: ${parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}`, 400);
      const out = await def.run(ctx, parsed.data) as O;
      log('ok', def.summarize ? def.summarize(out) : out);
      return out;
    } catch (e) {
      log('error', null, (e as AgentError).code || (e as Error).message);
      throw e;
    }
  }
}

export const Id = z.string().regex(/^[a-zA-Z0-9_-]{3,80}$/);
