import { openDatabase } from '../db/pool.js';
import { migrate } from '../db/migrate.js';
import { HashEmbedder, OllamaEmbedder, type Embedder } from '../llm.js';
import { Memory } from '../memory.js';
import { matchServicesExact } from '../intents.js';

/* Compares exact matching with pgvector similarity for "which of my services does this request mean?".
 * Exact matching is what the graph uses to act; similarity is only allowed to SUGGEST candidates for the user to pick.
 * Run: npm run eval:retrieval   (add NEARAUTH_EVAL_OLLAMA=1 to include a local Ollama embedding model) */

const SERVICES = [
  ['Nova Market', 'novamarket.com'], ['Trailhead Outfitters', 'trailhead-outfitters.com'], ['Chess Forum', 'chessforum.org'],
  ['PayFlow Bank', 'payflowbank.com'], ['Northwind Airlines', 'northwind-air.com'], ['Pixel Photo Lab', 'pixelphotolab.com'],
  ['Green Grocer', 'greengrocer.co.uk'], ['City Gym', 'citygym.com'], ['Bookworm Library', 'bookwormlib.org'], ['Streamly', 'streamly.tv'],
] as const;

// [request, expected service or null when the request names none of them]
const CASES: [string, string | null][] = [
  ['block the spam on my Nova Market alias', 'Nova Market'], ['pause novamarket', 'Nova Market'], ['stop mail to my nova mkt address', 'Nova Market'],
  ['trailhead keeps getting junk', 'Trailhead Outfitters'], ['the outdoor gear shop alias', 'Trailhead Outfitters'], ['trail head outfitters spam', 'Trailhead Outfitters'],
  ['chess site is leaking my email', 'Chess Forum'], ['chessforum.org alias', 'Chess Forum'], ['my bank alias gets offers', 'PayFlow Bank'],
  ['payflow sent me weird mail', 'PayFlow Bank'], ['airline alias is compromised', 'Northwind Airlines'], ['northwind air spam', 'Northwind Airlines'],
  ['photo lab alias', 'Pixel Photo Lab'], ['pixelphoto spam', 'Pixel Photo Lab'], ['the grocery delivery one', 'Green Grocer'],
  ['green grocer', 'Green Grocer'], ['gym membership alias', 'City Gym'], ['library account spam', 'Bookworm Library'],
  ['streaming service alias', 'Streamly'], ['streamly.tv', 'Streamly'],
  ['my dentist keeps emailing me', null], ['block the crypto newsletter', null], ['pause the alias for my old job', null], ['the pizza place spam', null],
];

function exact(q: string): string | null {
  const hits = matchServicesExact(q, SERVICES.map(([name, domain]) => ({ name, domain })));
  return hits.length === 1 ? hits[0].name : null;
}

async function evaluate(embedder: Embedder, threshold: number) {
  const db = await openDatabase({ databaseUrl: process.env.DATABASE_URL ?? null, dataDir: '/tmp', memory: true });
  await migrate(db);
  await db.withSystem((c) => c.query("INSERT INTO agent_users(id, display_name) VALUES ('evaluser', 'Eval') ON CONFLICT DO NOTHING"));
  const memory = new Memory(db, embedder);
  await memory.indexServiceNames('evaluser', SERVICES.map(([n, d], i) => ({ aliasId: `als_${i}`, serviceName: n, serviceDomain: d })));
  const rows: { q: string; expected: string | null; exact: string | null; semantic: string | null; distance: number }[] = [];
  for (const [q, expected] of CASES) {
    const [top] = await memory.search('evaluser', q, ['service_name'], 1);
    const name = top && top.distance < threshold ? SERVICES[Number(top.refId!.split('_')[1])][0] : null;
    rows.push({ q, expected, exact: exact(q), semantic: name, distance: top?.distance ?? 1 });
  }
  await db.close();
  const score = (pick: (r: typeof rows[number]) => string | null) => {
    const named = rows.filter((r) => r.expected), none = rows.filter((r) => !r.expected);
    const correct = named.filter((r) => pick(r) === r.expected).length;
    const wrong = rows.filter((r) => pick(r) && pick(r) !== r.expected).length;
    const abstain = named.filter((r) => !pick(r)).length;
    return { correct, of: named.length, wrongMatches: wrong, abstained: abstain, falseOnUnnamed: none.filter((r) => pick(r)).length };
  };
  return { model: embedder.model, threshold, exact: score((r) => r.exact), semantic: score((r) => r.semantic),
    combined: score((r) => r.exact ?? r.semantic), rows };
}

const results = [await evaluate(new HashEmbedder(), 0.55)];
if (process.env.NEARAUTH_EVAL_OLLAMA === '1') results.push(await evaluate(new OllamaEmbedder(process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434', process.env.OLLAMA_EMBED_MODEL ?? 'nomic-embed-text'), 0.5));
for (const r of results) {
  console.log(`\n## ${r.model} (suggestion threshold: cosine distance < ${r.threshold})\n`);
  console.log('| Method | Correct | Wrong match | Abstained | Matched an unnamed service |\n|---|---|---|---|---|');
  for (const k of ['exact', 'semantic', 'combined'] as const) console.log(`| ${k} | ${r[k].correct}/${r[k].of} | ${r[k].wrongMatches} | ${r[k].abstained} | ${r[k].falseOnUnnamed}/${CASES.filter((c) => !c[1]).length} |`);
  console.log('\n| Request | Expected | Exact | Semantic (distance) |\n|---|---|---|---|');
  for (const x of r.rows) console.log(`| ${x.q} | ${x.expected ?? '—'} | ${x.exact ?? '—'} | ${x.semantic ?? '—'} (${x.distance.toFixed(2)}) |`);
}
process.exit(0);
