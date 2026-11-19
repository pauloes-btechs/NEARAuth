import type { AliasRow, PolicyRow, SenderRow, UserRow } from './db/repo.js';
import type { ProviderAdapter } from './providers/types.js';
import { Detection } from './util.js';

/* Deterministic policy engine. It runs independently of any model, and it is the only thing that decides whether
 * a write may happen and whether it needs a human. Each rule has a stable id so the UI and receipts can cite it. */

export type ActionKind = 'block_sender' | 'unblock_sender' | 'pause_alias' | 'resume_alias' | 'unsubscribe' | 'credential_rotation';
export type RiskTier = 'low' | 'medium' | 'high';
export type PolicyOutcome = 'allow' | 'deny' | 'unsupported' | 'already_done';

export interface RuleResult { id: string; title: string; passed: boolean; detail: string }
export interface PolicyDecision {
  outcome: PolicyOutcome;
  riskTier: RiskTier;
  requiresApproval: boolean;
  requiresRecentAuth: boolean;
  autoApprovedBy: string | null;
  rules: RuleResult[];
  warnings: string[];
  alternative: ActionKind | null;
}

/* Organisations that routinely email on behalf of a merchant. Blocking one can break receipts, delivery updates or
 * security notices, so such blocks are high risk and always need explicit approval plus a recent sign-in. */
export const LEGITIMATE_THIRD_PARTIES: Record<string, string> = {
  'stripe.com': 'payment processor', 'paypal.com': 'payment processor', 'adyen.com': 'payment processor', 'squareup.com': 'payment processor',
  'braintreegateway.com': 'payment processor', 'klarna.com': 'payment provider', 'afterpay.com': 'payment provider', 'shopify.com': 'store platform',
  'ups.com': 'delivery company', 'fedex.com': 'delivery company', 'dhl.com': 'delivery company', 'usps.com': 'delivery company',
  'royalmail.com': 'delivery company', 'aftership.com': 'delivery tracking', 'narvar.com': 'delivery tracking', 'route.com': 'delivery tracking',
  'zendesk.com': 'customer support platform', 'freshdesk.com': 'customer support platform', 'intercom-mail.com': 'customer support platform',
  'okta.com': 'identity provider', 'auth0.com': 'identity provider',
};

export function thirdPartyCategory(senderDomain: string): string | null {
  const d = Detection.registrableDomain(senderDomain);
  if (LEGITIMATE_THIRD_PARTIES[d]) return LEGITIMATE_THIRD_PARTIES[d];
  if (Detection.PROCESSORS.includes(d)) return 'bulk email service';
  return null;
}

export const RULES: Record<string, string> = {
  'P1-agent-enabled': 'Agentic features are switched on for this user',
  'P2-ownership': 'The alias belongs to the signed-in user (exact database lookup)',
  'P3-sender-on-alias': 'The sender was observed on this same alias',
  'P4-provider-match': 'The alias is managed by the configured provider',
  'P5-capability': 'The provider supports this action',
  'P6-not-original-service': 'Never block the service the alias was created for',
  'P7-legitimate-third-party': 'Payment, delivery and support senders are high risk to block',
  'P8-already-done': 'Skip actions whose target is already in the requested state',
  'P9-verified-unsubscribe': 'Unsubscribe needs verified, DKIM-signed headers',
  'P10-no-remote-password-change': 'Third-party passwords cannot be changed by NEARAuth',
  'P11-rate-limit': 'At most 20 executed writes per user per hour',
  'P12-approval': 'Writes need approval unless a narrow, unexpired standing policy covers them',
};

export interface PolicyInput {
  action: ActionKind;
  user: UserRow;
  sessionUserId: string;
  alias: AliasRow | null;
  sender: SenderRow | null;
  provider: ProviderAdapter;
  remote: { aliasEnabled?: boolean; senderBlocked?: boolean } | null;  // authoritative provider state, if read
  standing: PolicyRow[];
  writesLastHour: number;
  now?: Date;
}

const CAP: Record<ActionKind, keyof ProviderAdapter['capabilities'] | null> = {
  block_sender: 'blockSender', unblock_sender: 'unblockSender', pause_alias: 'pauseAlias', resume_alias: 'resumeAlias', unsubscribe: 'unsubscribe', credential_rotation: null,
};
const REVERSIBLE: Record<ActionKind, boolean> = {
  block_sender: true, unblock_sender: true, pause_alias: true, resume_alias: true, unsubscribe: false, credential_rotation: false,
};
export const isReversible = (a: ActionKind) => REVERSIBLE[a];

export function evaluatePolicy(i: PolicyInput): PolicyDecision {
  const rules: RuleResult[] = [];
  const warnings: string[] = [];
  const now = i.now ?? new Date();
  const rule = (id: string, passed: boolean, detail: string) => { rules.push({ id, title: RULES[id], passed, detail }); return passed; };
  const end = (outcome: PolicyOutcome, extra: Partial<PolicyDecision> = {}): PolicyDecision => ({
    outcome, riskTier: 'medium', requiresApproval: true, requiresRecentAuth: false, autoApprovedBy: null, rules, warnings, alternative: null, ...extra,
  });

  if (!rule('P1-agent-enabled', i.user.agent_enabled, i.user.agent_enabled ? 'enabled' : 'The user switched agentic features off')) return end('deny');

  if (i.action === 'credential_rotation') {
    rule('P10-no-remote-password-change', true, 'NEARAuth can produce a checklist; the change itself happens on the service\'s own site.');
    return end('unsupported', { requiresApproval: false, riskTier: 'low' });
  }

  const owned = !!i.alias && i.alias.user_id === i.sessionUserId;
  if (!rule('P2-ownership', owned, owned ? 'alias row found for this user' : 'no alias with that id for this user')) return end('deny');
  const alias = i.alias!;

  const needsSender = i.action === 'block_sender' || i.action === 'unblock_sender' || i.action === 'unsubscribe';
  if (needsSender) {
    const onAlias = !!i.sender && i.sender.alias_id === alias.id && i.sender.user_id === i.sessionUserId;
    if (!rule('P3-sender-on-alias', onAlias, onAlias ? 'sender observation belongs to this alias' : 'sender was not observed on this alias')) return end('deny');
  }

  const matches = alias.provider_id === i.provider.id;
  if (!rule('P4-provider-match', matches, matches ? `managed by ${i.provider.id}` : `alias is managed by ${alias.provider_id}, agent is configured for ${i.provider.id}`)) {
    return end('unsupported', { requiresApproval: false });
  }

  if (i.action === 'unsubscribe') {
    rule('P9-verified-unsubscribe', false, 'The provider reports sender addresses only. Without verified, DKIM-signed List-Unsubscribe headers a real unsubscribe cannot be done safely.');
    return end('unsupported', { requiresApproval: false, alternative: 'block_sender' });
  }

  const cap = CAP[i.action];
  const supported = !!cap && i.provider.capabilities[cap];
  if (!rule('P5-capability', supported, supported ? `${i.provider.id} supports ${i.action}` : `${i.provider.id} cannot ${i.action}`)) return end('unsupported', { requiresApproval: false });

  let risk: RiskTier = i.action === 'pause_alias' ? 'medium' : 'medium';
  if (i.action === 'resume_alias' || i.action === 'unblock_sender') risk = 'low';

  if (i.action === 'block_sender') {
    const senderDomain = Detection.registrableDomain(i.sender!.sender_domain);
    const serviceDomain = Detection.registrableDomain(alias.service_domain);
    if (!rule('P6-not-original-service', senderDomain !== serviceDomain, senderDomain !== serviceDomain
      ? `${senderDomain} is not ${serviceDomain}` : `${senderDomain} is the service this alias was made for; pausing or keeping the alias is safer than blocking it`)) {
      return end('deny', { alternative: 'pause_alias' });
    }
    const category = thirdPartyCategory(senderDomain);
    rule('P7-legitimate-third-party', true, category ? `${senderDomain} looks like a ${category}` : 'no known legitimate-third-party pattern');
    if (category) {
      risk = 'high';
      warnings.push(`${senderDomain} looks like a ${category}. It may be sending receipts, delivery or security messages on ${alias.service_name}'s behalf; blocking it can hide those.`);
    }
  }
  if (i.action === 'pause_alias') warnings.push(`Pausing stops all mail to this alias, including from ${alias.service_name} itself.`);

  if (i.remote) {
    const done = (i.action === 'block_sender' && i.remote.senderBlocked === true) || (i.action === 'unblock_sender' && i.remote.senderBlocked === false)
      || (i.action === 'pause_alias' && i.remote.aliasEnabled === false) || (i.action === 'resume_alias' && i.remote.aliasEnabled === true);
    if (done) { rule('P8-already-done', false, 'the provider already reports the requested state'); return end('already_done', { requiresApproval: false, riskTier: risk }); }
    rule('P8-already-done', true, 'provider state differs from the requested state');
  }

  if (!rule('P11-rate-limit', i.writesLastHour < 20, `${i.writesLastHour} executed writes in the last hour`)) return end('deny', { riskTier: risk });

  // Standing policies: "always ask" wins; "auto approve" must name action + alias + sender domain, be unexpired, and is never used for high risk.
  const always = i.standing.find((p) => p.kind === 'always_require_approval' && p.action === i.action && (!p.alias_id || p.alias_id === alias.id));
  const senderDomain = i.sender ? Detection.registrableDomain(i.sender.sender_domain) : null;
  const auto = !always && risk !== 'high' ? i.standing.find((p) => p.kind === 'auto_approve' && p.action === i.action && p.alias_id === alias.id
    && !!senderDomain && p.sender_domain === senderDomain && !!p.expires_at && new Date(p.expires_at) > now) : undefined;
  rule('P12-approval', true, auto ? `standing policy ${auto.id} pre-approves exactly this` : always ? `policy ${always.id}: always ask` : 'approval required');

  return end('allow', { riskTier: risk, requiresApproval: !auto, requiresRecentAuth: risk === 'high', autoApprovedBy: auto?.id ?? null });
}
