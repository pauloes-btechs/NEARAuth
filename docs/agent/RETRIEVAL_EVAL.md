# Retrieval evaluation: exact matching vs pgvector similarity

Question evaluated: *which of my services does this request refer to?* (10 services, 20 requests that name one, 4 that name none).
Reproduce with `npm run eval:retrieval` (embedded PGlite + pgvector; add `NEARAUTH_EVAL_OLLAMA=1` with a local Ollama to include a real embedding model).

Run on 2026-11-18. Only the dependency-free hash embedder was measured; **no Ollama model was available in the build environment, so semantic results for a real embedding model are not reported.**

How the agent uses this: **exact matching decides**; similarity can only *suggest* candidates, and the graph then pauses for the user to pick (`select_target`). Ownership, authorization and tool execution never use vectors.

## hash-trigram-256 (suggestion threshold: cosine distance < 0.55)

| Method | Correct | Wrong match | Abstained | Matched an unnamed service |
|---|---|---|---|---|
| exact | 11/20 | 0 | 9 | 0/4 |
| semantic | 8/20 | 0 | 12 | 0/4 |
| combined | 13/20 | 0 | 7 | 0/4 |

| Request | Expected | Exact | Semantic (distance) |
|---|---|---|---|
| block the spam on my Nova Market alias | Nova Market | Nova Market | — (0.56) |
| pause novamarket | Nova Market | Nova Market | Nova Market (0.37) |
| stop mail to my nova mkt address | Nova Market | Nova Market | — (0.75) |
| trailhead keeps getting junk | Trailhead Outfitters | Trailhead Outfitters | — (0.58) |
| the outdoor gear shop alias | Trailhead Outfitters | — | — (0.86) |
| trail head outfitters spam | Trailhead Outfitters | Trailhead Outfitters | Trailhead Outfitters (0.28) |
| chess site is leaking my email | Chess Forum | Chess Forum | — (0.85) |
| chessforum.org alias | Chess Forum | Chess Forum | Chess Forum (0.29) |
| my bank alias gets offers | PayFlow Bank | — | — (0.72) |
| payflow sent me weird mail | PayFlow Bank | PayFlow Bank | — (0.62) |
| airline alias is compromised | Northwind Airlines | — | — (0.73) |
| northwind air spam | Northwind Airlines | Northwind Airlines | Northwind Airlines (0.24) |
| photo lab alias | Pixel Photo Lab | — | Pixel Photo Lab (0.52) |
| pixelphoto spam | Pixel Photo Lab | — | Pixel Photo Lab (0.47) |
| the grocery delivery one | Green Grocer | — | — (0.74) |
| green grocer | Green Grocer | Green Grocer | Green Grocer (0.12) |
| gym membership alias | City Gym | — | — (0.80) |
| library account spam | Bookworm Library | — | — (0.73) |
| streaming service alias | Streamly | — | — (0.62) |
| streamly.tv | Streamly | Streamly | Streamly (0.04) |
| my dentist keeps emailing me | — | — | — (0.84) |
| block the crypto newsletter | — | — | — (0.89) |
| pause the alias for my old job | — | — | — (0.93) |
| the pizza place spam | — | — | — (0.90) |

## Reading the numbers

- **No method produced a wrong match** on this set, and none matched a service for the four requests that name no service. That is the property that matters for safety; it is what the conservative threshold buys.
- The hash embedder only captures **spelling-level** similarity: it adds "pixelphoto" and "photo lab" but cannot connect "outdoor gear shop", "my bank" or "airline" to a service. Those need a real embedding model; with exact matching alone they fall back to asking the user.
- Because similarity only ever produces a *suggestion that the user must confirm*, a false positive would cost one extra click, not a wrong action.
- The set is small and synthetic. Before relying on a real embedding model, re-run with it and with the user's own service names, and lower the threshold only if wrong matches stay at zero.
