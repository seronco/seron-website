# SERON.CO read-only Mainnet reader

Architecture:
- `public/index.html`: approved SERON website + a very small same-origin reader.
- `src/worker.js`: Cloudflare Worker read-only API at `/api/seron-state`.
- No wallet connection, no signing, no transaction, no contract write.
- TONCenter API key stays server-side as a Cloudflare Worker Secret.

Canonical Mainnet inputs:
- Master: EQAlozhNpK1FGhZJQo8cN86WIQ1K_5nzUTIqn3HNTiP4MOI2
- Distributor: EQAJOJWmLdrRBrFL-zARX6AwJZlTqExazjFD4zHhs6iz_ZtH
- Locked allocation: 31,812,000 SERON
- Total periods: 69

Displayed fields:
- Total Supply: Master.get_jetton_data().total_supply
- Released: Distributor.get_released_amount()
- Locked: 31,812,000 - Released
- Current Epoch: Distributor.get_period_at(chain head time)
- Epochs Remaining: 69 - Current Epoch

Fail-safe:
If Mainnet identity, chain head freshness, getter exit code, stack shape, or ranges are wrong,
the API returns 503 and the browser displays `Unavailable`.

Deployment (not executed):
1. Create a TONCenter Mainnet API key.
2. Store it as Cloudflare Worker secret `TONCENTER_API_KEY`.
3. Deploy with current Wrangler.
4. Test `/api/seron-state`.
5. Only after audit, connect `seron.co`.

No API key should ever be placed in public HTML/JavaScript.


Documentation v3:
- Added `/docs` living English documentation page.
- Home WHITEPAPER/PDF links replaced by DOCUMENTATION -> `/docs`.
- No PDF/PDF viewer/download dependency.
- Mainnet reader logic remains unchanged.
- Presale remains unconnected/pending separate integration.

v4 link corrections:
- SERON.WIN card now opens https://seron.win/
- Home Documentation links use relative docs/ so they work in both local preview and deployed /docs/.
- Documentation home links use ../ for the same local/deployed compatibility.
- No visual redesign.
- No Mainnet reader logic change.
- Presale remains pending separate integration.
