import { z } from 'zod';

export const INTENTS = ['investigate_sender', 'block_sender', 'unblock_sender', 'unsubscribe', 'pause_alias', 'resume_alias',
  'review_accounts', 'cleanup_dormant', 'summarize_history', 'explain_audit', 'unknown'] as const;
export type Intent = (typeof INTENTS)[number];
export const IntentSchema = z.enum(INTENTS);

export const READ_INTENTS: Intent[] = ['investigate_sender', 'review_accounts', 'cleanup_dormant', 'summarize_history', 'explain_audit'];

export const INTENT_LABELS: Record<Intent, string> = {
  investigate_sender: 'Investigate who has my alias', block_sender: 'Block a sender on an alias', unblock_sender: 'Unblock a sender',
  unsubscribe: 'Unsubscribe from a sender', pause_alias: 'Pause an alias', resume_alias: 'Resume an alias',
  review_accounts: 'Review accounts that may need password rotation', cleanup_dormant: 'Find unused accounts and aliases',
  summarize_history: 'Summarize what NEARAuth has done', explain_audit: 'Explore the audit history', unknown: 'Not understood',
};

export interface ParsedRequest {
  intent: Intent;
  source: 'rules' | 'llm' | 'structured';
  mentionedEmails: string[];
  mentionedDomains: string[];
  normalizedText: string;
}

/* Ordered: the first matching rule wins, so more specific phrasings come first. */
const RULES: [Intent, RegExp][] = [
  ['unblock_sender', /\b(unblock|un-block|allow .{0,40}\bagain|let .{0,40}\bthrough)\b/],
  ['unsubscribe', /\b(unsubscribe|opt[- ]?out|remove me from (the |their )?(mailing )?list)\b/],
  ['resume_alias', /\b(resume|re-?enable|reactivate|turn (it |the alias )?back on|unpause|un-pause)\b/],
  ['pause_alias', /\b(pause|disable|deactivate|freeze|turn off|switch off)\b.{0,60}\balias\b|\balias\b.{0,60}\b(pause|disable|compromised)\b/],
  ['block_sender', /\b(block|stop|prevent|ban|no more|keep)\b.{0,80}\b(email|emails|emailing|emailaddress|mail|mailing|sender|contact|contacting|spam|spamming|message|messaging|writing)\b|\bblock\b.{0,30}\bsender\b/],
  ['review_accounts', /\b(password|passwords|credential|credentials)\b.{0,40}\b(rotat|chang|weak|reuse|update|strong)|\brotat\w*\b.{0,30}\b(password|credential)/],
  ['cleanup_dormant', /\b(clean ?up|unused|old accounts|dormant|inactive|stale)\b/],
  ['summarize_history', /\b(summar\w*|what has nearauth done|privacy report|footprint|this month|this week)\b/],
  ['explain_audit', /\b(audit|receipts?|action history|what did (you|nearauth) do|show .{0,20}(log|actions))\b/],
  ['investigate_sender', /\b(investigat\w*|which compan\w*|who (has|got|received|is using)|may have received|look into|why am i getting|where did .{0,30} come from|unexpected sender)\b/],
];

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+/g;
const DOMAIN = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b/g;

export function normalize(text: string): string {
  return String(text).toLowerCase().normalize('NFKC').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim().slice(0, 1000);
}

export function parseByRules(text: string): ParsedRequest {
  const t = normalize(text);
  const emails = [...new Set(t.match(EMAIL) ?? [])];
  const withoutEmails = emails.reduce((s, e) => s.replace(e, ' '), t);
  const domains = [...new Set(withoutEmails.match(DOMAIN) ?? [])];
  // Addresses are matched as entities, not as words: "block receipts@stripe.com" is about a sender, not about receipts.
  const forRules = emails.reduce((x, e) => x.split(e).join(' emailaddress '), t);
  const hit = RULES.find(([, re]) => re.test(forRules));
  return { intent: hit ? hit[0] : 'unknown', source: 'rules', mentionedEmails: emails, mentionedDomains: domains, normalizedText: t };
}

/* Exact service matching used by resolve_target: the full service name or domain appears in the request, or else the
 * service whose distinctive name words appear most. Returns every tie, so callers can ask instead of guessing. */
const GENERIC = new Set(['market', 'shop', 'store', 'forum', 'online', 'club', 'group', 'service', 'services', 'company', 'account', 'alias',
  'bank', 'airlines', 'airline', 'library', 'photo', 'outfitters', 'lab', 'news', 'mail']);
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
export function matchServicesExact<T extends { name: string; domain: string }>(text: string, items: T[], mentionedDomains: string[] = []): T[] {
  const t = text.toLowerCase();
  let hits = items.filter((a) => squash(t).includes(squash(a.name)) || t.includes(a.domain) || mentionedDomains.includes(a.domain));
  if (!hits.length) {
    const words = new Set(t.split(/[^a-z0-9]+/));
    const score = (a: T) => a.name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !GENERIC.has(w) && words.has(w)).length;
    const best = Math.max(0, ...items.map(score));
    if (best > 0) hits = items.filter((a) => score(a) === best);
  }
  return hits;
}
