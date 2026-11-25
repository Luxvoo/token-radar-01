export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

interface PeerStats {
  category: string;
  peer_n: number;
  median_ratio: number;
  q25_ratio: number;
  q75_ratio: number;
  multiple: number;
  low_multiple: number;
  high_multiple: number;
  confidence: string;
}

const PEER_TVL_CAP = 2_000_000_000;
const SHRINKAGE_K = 6;
const RATIO_CAP = 1.0;
const GROWTH_WEIGHT = 0.6;
const MATURITY_FLOOR = 0.6;
const MATURITY_DAYS = 1095;
const UNKNOWN_AGE_DAYS = 365;

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const at = (s.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return lo === hi ? s[lo]! : s[lo]! * (hi - at) + s[hi]! * (at - lo);
}

function categoryOf(p: Protocol): string {
  return p.category && p.category.trim() !== '' ? p.category : 'Uncategorized';
}

function ageDays(p: Protocol, asOf: string): number {
  if (!p.listed_at) return UNKNOWN_AGE_DAYS;
  const start = Date.parse(`${p.listed_at}T00:00:00Z`);
  const end = Date.parse(`${asOf}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return UNKNOWN_AGE_DAYS;
  return Math.max(0, Math.floor((end - start) / 86_400_000));
}

function confidenceFor(peerN: number): string {
  if (peerN >= 8) return 'strong';
  if (peerN >= 4) return 'moderate';
  if (peerN >= 1) return 'thin';
  return 'global-only';
}

function peerRatio(p: Protocol, winsorize: boolean): number {
  const ratio = (p.mcap_usd ?? 0) / p.tvl_usd;
  return winsorize ? Math.min(ratio, RATIO_CAP) : ratio;
}

function factors(p: Protocol, asOf: string): { growth: number; maturity: number; breadth: number; age: number } {
  const age = ageDays(p, asOf);
  const growth = 1 + (clamp(p.change_7d ?? 0, -50, 80) / 100) * GROWTH_WEIGHT;
  const maturity = MATURITY_FLOOR + (Math.min(age, MATURITY_DAYS) / MATURITY_DAYS) * (1 - MATURITY_FLOOR);
  const breadth = 1 + 0.02 * Math.min(Math.max(p.chains.length - 1, 0), 5);
  return { growth, maturity, breadth, age };
}

function buildPeerStats(protocols: Protocol[]): {
  peers: Protocol[];
  globalMedian: number;
  globalQ25: number;
  globalQ75: number;
  byCategory: Map<string, PeerStats>;
} {
  const peers = protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd <= PEER_TVL_CAP);
  const globalRatios = peers.map((p) => peerRatio(p, true));
  const globalMedian = median(globalRatios);
  const globalQ25 = percentile(globalRatios, 0.25);
  const globalQ75 = percentile(globalRatios, 0.75);
  const grouped = new Map<string, number[]>();
  for (const p of peers) {
    const c = categoryOf(p);
    const arr = grouped.get(c) ?? [];
    arr.push(peerRatio(p, true));
    grouped.set(c, arr);
  }
  const byCategory = new Map<string, PeerStats>();
  for (const [category, ratios] of grouped) {
    const n = ratios.length;
    const med = median(ratios);
    const q25 = percentile(ratios, 0.25);
    const q75 = percentile(ratios, 0.75);
    const multiple = clamp((n * med + SHRINKAGE_K * globalMedian) / (n + SHRINKAGE_K), 0.08, 0.8);
    const low = n >= 3 ? clamp((n * q25 + SHRINKAGE_K * globalQ25) / (n + SHRINKAGE_K), 0.08, 0.8) : clamp(globalQ25, 0.08, 0.8);
    const high = n >= 3 ? clamp((n * q75 + SHRINKAGE_K * globalQ75) / (n + SHRINKAGE_K), 0.08, 0.8) : clamp(globalQ75, 0.08, 0.8);
    byCategory.set(category, {
      category,
      peer_n: n,
      median_ratio: med,
      q25_ratio: q25,
      q75_ratio: q75,
      multiple,
      low_multiple: Math.min(low, multiple),
      high_multiple: Math.max(high, multiple),
      confidence: confidenceFor(n),
    });
  }
  return { peers, globalMedian, globalQ25, globalQ75, byCategory };
}

function statsFor(category: string, built: ReturnType<typeof buildPeerStats>): PeerStats {
  const found = built.byCategory.get(category);
  if (found) return found;
  const multiple = clamp(built.globalMedian, 0.08, 0.8);
  return {
    category,
    peer_n: 0,
    median_ratio: built.globalMedian,
    q25_ratio: built.globalQ25,
    q75_ratio: built.globalQ75,
    multiple,
    low_multiple: Math.min(clamp(built.globalQ25, 0.08, 0.8), multiple),
    high_multiple: Math.max(clamp(built.globalQ75, 0.08, 0.8), multiple),
    confidence: 'global-only',
  };
}

function looStats(protocols: Protocol[], asOf: string, winsorize: boolean): { median_abs_log_err: number; median_ratio: number; peers: number } {
  const peers = protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd <= PEER_TVL_CAP);
  const ratios: number[] = [];
  for (const p of peers) {
    const others = peers.filter((x) => x !== p);
    const globalMedian = median(others.map((x) => peerRatio(x, winsorize)));
    const catRatios = others.filter((x) => categoryOf(x) === categoryOf(p)).map((x) => peerRatio(x, winsorize));
    const multiple = catRatios.length > 0
      ? clamp((catRatios.length * median(catRatios) + SHRINKAGE_K * globalMedian) / (catRatios.length + SHRINKAGE_K), 0.08, 0.8)
      : clamp(globalMedian, 0.08, 0.8);
    const f = factors(p, asOf);
    const implied = p.tvl_usd * multiple * f.growth * f.maturity * f.breadth;
    ratios.push(implied / (p.mcap_usd ?? 1));
  }
  return {
    median_abs_log_err: median(ratios.map((r) => Math.abs(Math.log(r)))),
    median_ratio: median(ratios),
    peers: peers.length,
  };
}

function gasForChain(chain: string): string {
  const gas: Record<string, string> = {
    Ethereum: '$5.00',
    Base: '$0.10',
    Arbitrum: '$0.10',
    Optimism: '$0.10',
    Solana: '$0.01',
    BSC: '$0.05',
    Tron: '$0.05',
    Bitcoin: '$2.00',
    Polygon: '$0.05',
    Avalanche: '$0.10',
  };
  return gas[chain] ?? '$0.25';
}

function capitalTier(tvl: number): number {
  if (tvl >= 500_000_000) return 150;
  if (tvl >= 100_000_000) return 100;
  return 50;
}

function categoryPlan(category: string, name: string): { core: string; second: string; maintain: string } {
  const c = category.toLowerCase();
  if (c.includes('risk curator')) return { core: `deposit into a ${name} vault or curator strategy and keep the vault shares`, second: 'choose a second vault with a different collateral mix', maintain: 'vault deposit or withdrawal' };
  if (c.includes('capital allocator')) return { core: `allocate to a ${name} strategy vault and keep the position receipt`, second: 'split the allocation across a second strategy', maintain: 'strategy rebalance' };
  if (c.includes('lending')) return { core: 'supply a major asset and borrow a small stablecoin amount against it', second: 'repay part of the loan and supply again', maintain: 'supply or repay action' };
  if (c === 'cdp') return { core: 'lock collateral and mint a small stablecoin amount while keeping a healthy collateral ratio', second: 'add collateral or repay to test both sides of the position', maintain: 'collateral top-up or repayment' };
  if (c.includes('dex')) return { core: 'add liquidity to an active pool and keep the LP position in range', second: 'swap a small amount and add liquidity to a second pool', maintain: 'liquidity adjustment' };
  if (c.includes('rwa')) return { core: 'buy or hold a small tokenized real-world asset position', second: 'use the asset as collateral only if the app supports it', maintain: 'asset purchase or redemption check' };
  if (c.includes('bridge')) return { core: 'bridge a small amount across the route and back', second: 'repeat with a different asset or route', maintain: 'bridge transfer' };
  if (c.includes('staking') || c.includes('restaking')) return { core: 'stake the base asset and hold the receipt token', second: 'use the receipt token in one supported app', maintain: 'stake or unstake check' };
  if (c.includes('basis')) return { core: 'open a delta-neutral basis position with matched long and short legs', second: 'rebalance the hedge when funding changes', maintain: 'hedge rebalance' };
  if (c.includes('derivative') || c.includes('option') || c.includes('perpetual')) return { core: 'open a small hedged position with strict size limits', second: 'close and reopen a smaller position to record activity', maintain: 'position adjustment' };
  if (c.includes('yield') || c.includes('farming')) return { core: 'deposit into a yield strategy and monitor the vault share price', second: 'move part to a second strategy with different risk', maintain: 'deposit or harvest action' };
  if (c.includes('locker')) return { core: 'lock a small amount for the shortest sensible period', second: 'extend or add a second lock only if the terms are clear', maintain: 'lock review' };
  if (c === 'chain') return { core: 'bridge a small amount and use a native app on the chain', second: 'stake or provide liquidity inside the ecosystem', maintain: 'native app transaction' };
  if (c === 'cex') return { core: 'use the spot or earn product with a small balance', second: 'move a small amount on-chain and back', maintain: 'trade or earn check' };
  return { core: 'use the core product with a small deposit', second: 'repeat the core action from a second feature or chain if available', maintain: 'core product transaction' };
}

function farmSteps(p: Protocol): string[] {
  const chain = p.chains[0] ?? 'Ethereum';
  const gas = gasForChain(chain);
  const capital = capitalTier(p.tvl_usd);
  const coreAmt = Math.round(capital * 0.6);
  const secondAmt = Math.round(capital * 0.25);
  const plan = categoryPlan(categoryOf(p), p.name);
  return [
    `Open ${p.name} from its official app, connect a fresh wallet on ${chain}, and fund it with $${capital} plus about ${gas} for gas. Keep the seed phrase offline and never share it. Cost: ${gas} gas. Time: 10 min.`,
    `Use about $${coreAmt} for the core action: ${plan.core}. Start small, confirm the transaction, and keep the position receipt or LP token in the same wallet. Cost: ${gas}. Time: 15 min.`,
    `Repeat a small ${plan.maintain} once a week for four weeks, varying the day and amount slightly. Claim or reinvest any rewards the app already shows, but treat future distributions as uncertain. Cost: ${gas} each time. Time: 5 min weekly.`,
    `Add the second leg with about $${secondAmt}: ${plan.second}. If ${p.name} supports another chain, bridge only a small test amount first and verify the destination address. Cost: ${gas} plus any bridge fee shown. Time: 20 min.`,
    `Check TVL, the 7-day change and your position every week. If TVL falls sharply or the app warns about a pause, reduce the position and keep at least 15% of the farm budget liquid. Cost: $0. Time: 10 min weekly.`,
    `Save transaction hashes, dates, amounts and screenshots in one note. Review monthly, withdraw idle funds, and stop adding if the position no longer fits your risk budget. Cost: $0. Time: 15 min monthly.`,
  ];
}

function riskFlags(p: Protocol, age: number, peerN: number, low: number, high: number): string[] {
  const flags: string[] = [];
  if (p.change_7d !== null && p.change_7d < 0) {
    flags.push(p.change_7d < -15 ? `Sharp 7d TVL drop ${Math.abs(p.change_7d).toFixed(1)}%` : `7d TVL down ${Math.abs(p.change_7d).toFixed(1)}%`);
  }
  if (age < 180) flags.push(`Young protocol: ${age}d tracked`);
  if (p.chains.length === 1) flags.push('Single-chain exposure');
  if (peerN < 3) flags.push(`Thin peer evidence (n=${peerN})`);
  if (low > 0 && high / low > 3) flags.push('Wide sensitivity range');
  return flags;
}

export function buildRadar(snapshot: Snapshot): { board: { rows: unknown[] }; data: unknown } {
  const built = buildPeerStats(snapshot.protocols);
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const watch = new Set(snapshot.watchlist);
  const early = snapshot.protocols
    .filter((p) => !watch.has(p.slug) && (p.mcap_usd === null || p.mcap_usd <= 0) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || a.slug.localeCompare(b.slug))
    .slice(0, 186);
  const selected = [...snapshot.watchlist.map((s) => bySlug.get(s)!), ...early];
  const rows = selected.map((p) => {
    const category = categoryOf(p);
    const stats = statsFor(category, built);
    const f = factors(p, snapshot.as_of);
    const factor = f.growth * f.maturity * f.breadth;
    const implied = Math.round(p.tvl_usd * stats.multiple * factor);
    const valueLow = Math.round(p.tvl_usd * stats.low_multiple * factor);
    const valueHigh = Math.round(p.tvl_usd * stats.high_multiple * factor);
    return {
      slug: p.slug,
      name: p.name,
      rank: 0,
      category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      age_days: f.age,
      watchlist: watch.has(p.slug),
      peer_n: stats.peer_n,
      peer_median: stats.median_ratio,
      peer_multiple: stats.multiple,
      low_multiple: stats.low_multiple,
      high_multiple: stats.high_multiple,
      growth_mult: f.growth,
      maturity_mult: f.maturity,
      breadth_mult: f.breadth,
      implied_value_usd: implied,
      value_low: Math.min(valueLow, implied),
      value_high: Math.max(valueHigh, implied),
      confidence: stats.confidence,
      risk_flags: riskFlags(p, f.age, stats.peer_n, valueLow, valueHigh),
      farm_steps: farmSteps(p),
    };
  });
  rows.sort((a, b) => b.implied_value_usd - a.implied_value_usd || b.tvl_usd - a.tvl_usd || a.slug.localeCompare(b.slug));
  rows.forEach((r, i) => { r.rank = i + 1; });

  const live = snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0)
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || a.slug.localeCompare(b.slug))
    .slice(0, 24)
    .map((p, i) => {
      const stats = statsFor(categoryOf(p), built);
      return {
        rank: i + 1,
        slug: p.slug,
        name: p.name,
        category: categoryOf(p),
        chains: p.chains,
        tvl_usd: p.tvl_usd,
        mcap_usd: p.mcap_usd,
        change_7d: p.change_7d,
        age_days: ageDays(p, snapshot.as_of),
        ratio: (p.mcap_usd ?? 0) / p.tvl_usd,
        peer_n: stats.peer_n,
        confidence: stats.confidence,
      };
    });

  const peerCategories = new Set<string>([...built.byCategory.keys(), ...rows.map((r) => r.category)]);
  const peers = [...peerCategories]
    .map((c) => {
      const s = statsFor(c, built);
      return { category: c, peer_n: s.peer_n, median_ratio: s.median_ratio, multiple: s.multiple, confidence: s.confidence };
    })
    .sort((a, b) => b.multiple - a.multiple || b.peer_n - a.peer_n || a.category.localeCompare(b.category));

  const data = {
    meta: {
      as_of: snapshot.as_of,
      floor_usd: snapshot.floor_usd,
      protocol_count: snapshot.protocols.length,
      watchlist_count: snapshot.watchlist.length,
      board_rows: rows.length,
      early_rows: rows.length - snapshot.watchlist.length,
      live_rows: live.length,
      peer_count: built.peers.length,
      global_median: built.globalMedian,
      global_q25: built.globalQ25,
      global_q75: built.globalQ75,
      constants: { shrinkage_k: SHRINKAGE_K, ratio_cap: RATIO_CAP, growth_weight: GROWTH_WEIGHT, maturity_floor: MATURITY_FLOOR },
      loo: { baseline: looStats(snapshot.protocols, snapshot.as_of, false), robust: looStats(snapshot.protocols, snapshot.as_of, true) },
    },
    rows,
    live,
    peers,
    categories: [...new Set(rows.map((r) => r.category))].sort((a, b) => a.localeCompare(b)),
  };
  return { board: { rows }, data };
}
