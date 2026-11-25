export interface ProtocolInput {
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

export interface SnapshotInput {
  as_of: string;
  source?: string;
  floor_usd: number;
  protocols: ProtocolInput[];
  watchlist: string[];
}

export interface BoardRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
  watchlist: boolean;
  tvl_usd: number;
  change_7d: number | null;
  age_days: number;
  peer_multiple: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  breadth_multiplier: number;
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  rank: number;
  tvl_usd: number;
  change_7d: number | null;
  age_days: number;
  market_cap_usd: number;
  model_estimate_usd: number;
  model_ratio: number;
  peer_multiple: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  breadth_multiplier: number;
}

export interface CategoryStat {
  category: string;
  live_peers: number;
  raw_median: number | null;
  multiple: number;
  board_rows: number;
}

export interface CategoryBias {
  category: string;
  peers: number;
  median_ratio: number;
}

export interface BacktestSummary {
  peer_count: number;
  median_ratio: number;
  median_abs_log_error: number;
  baseline_median_ratio: number;
  baseline_median_abs_log_error: number;
  category_bias: CategoryBias[];
}

export interface RadarData {
  meta: {
    as_of: string;
    source: string;
    floor_usd: number;
    protocol_count: number;
    watchlist_count: number;
    board_count: number;
    early_count: number;
    live_count: number;
    peer_count: number;
  };
  model: {
    shrinkage_k: number;
    growth_weight: number;
    maturity_floor: number;
    maturity_cap_days: number;
    multiple_min: number;
    multiple_max: number;
    peer_tvl_cap_usd: number;
    breadth_per_chain: number;
    breadth_cap: number;
    global_median: number;
  };
  rows: BoardRow[];
  live_rows: LiveRow[];
  category_stats: CategoryStat[];
  backtest: BacktestSummary;
}

interface ModelConstants {
  shrinkageK: number;
  growthWeight: number;
  maturityFloor: number;
}

const MATURITY_CAP_DAYS = 1095;
const MULTIPLE_MIN = 0.08;
const MULTIPLE_MAX = 0.8;
const PEER_TVL_CAP_USD = 2_000_000_000;
const BREADTH_PER_CHAIN = 0.02;
const BREADTH_CAP = 5;
const EARLY_ROW_TARGET = 186;
const LIVE_ROW_TARGET = 24;

const TUNED: ModelConstants = {
  shrinkageK: 6,
  growthWeight: 0.6,
  maturityFloor: 0.6,
};

const BASELINE: ModelConstants = {
  shrinkageK: 6,
  growthWeight: 0.4,
  maturityFloor: 0.7,
};

interface PeerStats {
  peers: ProtocolInput[];
  globalMedian: number;
  byCategory: Map<string, { ratios: number[]; rawMedian: number; multiple: number }>;
}

interface ScoreParts {
  peerMultiple: number;
  growthMultiplier: number;
  maturityMultiplier: number;
  breadthMultiplier: number;
  implied: number;
  ageDays: number;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function parseDay(value: string | null | undefined): number | null {
  if (!value) return null;
  const text = value.includes('T') ? value : `${value}T00:00:00Z`;
  const time = Date.parse(text);
  return Number.isFinite(time) ? time : null;
}

function ageDays(protocol: ProtocolInput, asOf: number): number {
  const listed = parseDay(protocol.listed_at);
  if (listed === null) return 365;
  return Math.max(0, Math.floor((asOf - listed) / 86_400_000));
}

function categoryKey(protocol: ProtocolInput): string {
  return protocol.category ?? 'Uncategorised';
}

function hasLiveToken(protocol: ProtocolInput): boolean {
  return typeof protocol.mcap_usd === 'number' && protocol.mcap_usd > 0;
}

function isPeer(protocol: ProtocolInput): boolean {
  return hasLiveToken(protocol) && protocol.tvl_usd > 0 && protocol.tvl_usd <= PEER_TVL_CAP_USD;
}

function shrunkMultiple(rawMedian: number, peerCount: number, globalMedian: number, constants: ModelConstants): number {
  const multiple = peerCount === 0
    ? globalMedian
    : (peerCount * rawMedian + constants.shrinkageK * globalMedian) / (peerCount + constants.shrinkageK);
  return clamp(multiple, MULTIPLE_MIN, MULTIPLE_MAX);
}

function buildPeerStats(protocols: ProtocolInput[]): PeerStats {
  const peers = protocols.filter(isPeer);
  const globalMedian = median(peers.map((p) => p.mcap_usd! / p.tvl_usd));
  const grouped = new Map<string, number[]>();
  for (const peer of peers) {
    const key = categoryKey(peer);
    const list = grouped.get(key) ?? [];
    list.push(peer.mcap_usd! / peer.tvl_usd);
    grouped.set(key, list);
  }
  const byCategory = new Map<string, { ratios: number[]; rawMedian: number; multiple: number }>();
  for (const [category, ratios] of grouped) {
    const rawMedian = median(ratios);
    byCategory.set(category, {
      ratios,
      rawMedian,
      multiple: shrunkMultiple(rawMedian, ratios.length, globalMedian, TUNED),
    });
  }
  return { peers, globalMedian, byCategory };
}

function scoreWithMultiple(protocol: ProtocolInput, asOf: number, peerMultiple: number, constants: ModelConstants): ScoreParts {
  const days = ageDays(protocol, asOf);
  const growth = clamp(protocol.change_7d ?? 0, -50, 80);
  const growthMultiplier = 1 + (growth / 100) * constants.growthWeight;
  const maturityMultiplier = constants.maturityFloor
    + (Math.min(days, MATURITY_CAP_DAYS) / MATURITY_CAP_DAYS) * (1 - constants.maturityFloor);
  const chainCount = protocol.chains?.length ?? 0;
  const breadthMultiplier = 1 + BREADTH_PER_CHAIN * Math.min(Math.max(chainCount - 1, 0), BREADTH_CAP);
  const implied = Math.round(protocol.tvl_usd * peerMultiple * growthMultiplier * maturityMultiplier * breadthMultiplier);
  return { peerMultiple, growthMultiplier, maturityMultiplier, breadthMultiplier, implied, ageDays: days };
}

function scoreProtocol(protocol: ProtocolInput, asOf: number, stats: PeerStats): ScoreParts {
  const category = stats.byCategory.get(categoryKey(protocol));
  const multiple = category?.multiple ?? clamp(stats.globalMedian, MULTIPLE_MIN, MULTIPLE_MAX);
  return scoreWithMultiple(protocol, asOf, multiple, TUNED);
}

function gasCost(chain: string): string {
  switch (chain) {
    case 'Solana':
    case 'Ripple':
    case 'Stellar':
      return 'about $0.01 of gas';
    case 'Base':
    case 'Arbitrum':
    case 'Optimism':
    case 'Linea':
    case 'Scroll':
    case 'Mantle':
    case 'Blast':
    case 'Unichain':
    case 'zkSync Era':
    case 'Hyperliquid L1':
    case 'Monad':
    case 'Sui':
    case 'Aptos':
    case 'Near':
    case 'TON':
    case 'Polygon':
      return 'about $0.10 of gas';
    case 'Binance':
    case 'Avalanche':
    case 'Fantom':
    case 'Celo':
    case 'Flare':
    case 'Sonic':
    case 'Sei':
    case 'Berachain':
    case 'Plasma':
    case 'Arc':
    case 'Robinhood Chain':
    case 'X Layer':
    case 'Kava':
    case 'Cronos':
      return 'about $0.20 of gas';
    case 'Tron':
      return 'about $0.50 of gas';
    case 'Cardano':
      return 'about $0.30 of gas';
    case 'Bitcoin':
      return 'about $2 of network fees';
    case 'Ethereum':
      return 'about $5 of gas';
    default:
      return 'about $0.50 of gas';
  }
}

function capitalTier(tvlUsd: number): string {
  if (tvlUsd >= 500_000_000) return '$150';
  if (tvlUsd >= 100_000_000) return '$100';
  return '$50';
}

function enterAction(protocol: ProtocolInput, capital: string, chain: string): string {
  const name = protocol.name;
  switch (protocol.category) {
    case 'Lending':
      return `Supply ${capital} to ${name} on ${chain}, borrow a small amount against it, and keep both sides open`;
    case 'Uncollateralized Lending':
      return `Lend ${capital} through ${name} on ${chain} and keep the loan open`;
    case 'Dexs':
      return `Add ${capital} of liquidity to a ${name} pool on ${chain} in a range you can leave alone`;
    case 'Risk Curators':
    case 'Onchain Capital Allocator':
    case 'Yield Aggregator':
    case 'Liquidity Manager':
    case 'Options Vault':
      return `Deposit ${capital} into a ${name} vault on ${chain} and hold the vault shares`;
    case 'Yield':
    case 'Farm':
      return `Deposit ${capital} into a ${name} strategy on ${chain} and leave it earning`;
    case 'Leveraged Farming':
      return `Open a low-leverage ${capital} farming position on ${name} on ${chain} and keep margin aside`;
    case 'Liquid Staking':
      return `Stake ${capital} with ${name} on ${chain} and hold the receipt token`;
    case 'Liquid Restaking':
    case 'Restaking':
    case 'Restaked BTC':
    case 'Staking Pool':
      return `Stake ${capital} through ${name} on ${chain} and hold the receipt position`;
    case 'CDP':
    case 'CDP Manager':
      return `Lock ${capital} of collateral in ${name} on ${chain}, mint a small amount, and keep the position healthy`;
    case 'Bridge':
    case 'Canonical Bridge':
    case 'Cross Chain Bridge':
      return `Bridge ${capital} through ${name} on ${chain} and leave it on the destination side`;
    case 'Derivatives':
    case 'Options':
    case 'Interest Rate Derivatives':
    case 'Synthetics':
      return `Open a small, hedged ${capital} position on ${name} on ${chain} and keep margin aside`;
    case 'Basis Trading':
      return `Open a delta-neutral ${capital} basis position on ${name} on ${chain} and keep it balanced`;
    case 'RWA':
      return `Deposit ${capital} into a ${name} real-world-asset pool on ${chain} and hold the position`;
    case 'Prediction Market':
      return `Place ${capital} across small ${name} markets on ${chain} and let them settle`;
    case 'Privacy':
      return `Move ${capital} through ${name} on ${chain} for your own funds and keep your records`;
    case 'CEX':
      return `Deposit ${capital} to ${name}, make a few small spot trades, and leave a balance in place`;
    case 'Chain':
      return `Bridge ${capital} to ${name} and use it in one application there`;
    case 'Launchpad':
      return `Commit ${capital} to one ${name} launch on ${chain} and keep the allocation`;
    case 'Payments':
      return `Send ${capital} in small ${name} payments on ${chain} and keep the account active`;
    case 'Insurance':
      return `Put ${capital} into ${name} cover or underwriting on ${chain} and keep it in place`;
    case 'Indexes':
      return `Buy ${capital} of a ${name} index position on ${chain} and hold it`;
    case 'NFT Marketplace':
      return `List or buy one low-cost item on ${name} on ${chain} within a ${capital} budget`;
    case 'OTC Marketplace':
      return `Complete one small ${capital} trade through ${name} on ${chain}`;
    case 'Token Locker':
      return `Lock ${capital} through ${name} on ${chain} for a fixed term`;
    case 'Governance Incentives':
      return `Take one open governance action on ${name} on ${chain} with a ${capital} position`;
    case 'AI Agents':
    case 'Decentralized AI':
      return `Run one paid ${name} agent task on ${chain} within a ${capital} budget`;
    case 'Crypto Card Issuer':
      return `Load ${capital} onto a ${name} card and make small everyday purchases`;
    case 'Algo-Stables':
    case 'Dual-Token Stablecoin':
    case 'Stablecoin Issuer':
      return `Mint ${capital} of stablecoin through ${name} on ${chain} and hold it`;
    case 'Stablecoin Wrapper':
    case 'Anchor BTC':
    case 'Decentralized BTC':
      return `Wrap ${capital} through ${name} on ${chain} and hold the wrapped position`;
    case 'Collateral Management':
    case 'Collateral Markets':
      return `Place ${capital} of collateral with ${name} on ${chain} and keep it managed`;
    case 'Reserve Currency':
      return `Bond or stake ${capital} with ${name} on ${chain} and hold the position`;
    default:
      return `Use the main ${name} product on ${chain} with ${capital} and keep the position open`;
  }
}

function repeatAction(protocol: ProtocolInput): string {
  const name = protocol.name;
  switch (protocol.category) {
    case 'Lending':
    case 'Uncollateralized Lending':
      return `Supply a little more or repay part of the borrow on ${name}`;
    case 'Dexs':
      return `Swap once and check that your ${name} liquidity is still in range`;
    case 'Bridge':
    case 'Canonical Bridge':
    case 'Cross Chain Bridge':
      return `Bridge a small amount back or across again through ${name}`;
    case 'Liquid Staking':
    case 'Liquid Restaking':
    case 'Restaking':
    case 'Restaked BTC':
    case 'Staking Pool':
      return `Add a small top-up or claim and restake any rewards on ${name}`;
    case 'CDP':
    case 'CDP Manager':
      return `Top up collateral or repay a little of the minted amount on ${name}`;
    case 'Derivatives':
    case 'Options':
    case 'Interest Rate Derivatives':
    case 'Synthetics':
    case 'Basis Trading':
      return `Close and reopen a small hedged position on ${name}`;
    case 'CEX':
      return `Make one small spot trade on ${name} and leave the balance in place`;
    case 'Prediction Market':
      return `Settle one market and place one new small prediction on ${name}`;
    case 'Yield':
    case 'Yield Aggregator':
    case 'Farm':
    case 'Leveraged Farming':
    case 'Risk Curators':
    case 'Onchain Capital Allocator':
      return `Harvest and reinvest, or add a small top-up to the ${name} position`;
    default:
      return `Make one qualifying move on ${name} — a deposit, a swap, a vote or a claim`;
  }
}

function farmSteps(protocol: ProtocolInput, days: number): string[] {
  const chain = protocol.chains?.[0] ?? "the protocol's main chain";
  const gas = gasCost(chain);
  const capital = capitalTier(protocol.tvl_usd);
  const holdDays = days < 180 ? 45 : 30;
  return [
    `Start with a fresh wallet that holds only the funds you plan to farm on ${chain}, and store its recovery phrase offline, never in a screenshot or a message. Cost: ${gas} for the first transfer. Time: 5 minutes.`,
    `${enterAction(protocol, capital, chain)}. Cost: ${capital} of capital and ${gas}. Time: 15 minutes to set up.`,
    `${repeatAction(protocol)} on ${chain}. Cost: ${gas} a week. Time: 10 minutes a week.`,
    `Hold the position for at least ${holdDays} days so the activity is counted in more than one snapshot. Cost: the ${capital} stays in the position. Time: ${holdDays} days.`,
    `After two weeks, add a small top-up or rebalance the ${protocol.name} position once, without changing the plan. Cost: ${gas}. Time: 10 minutes.`,
    `Review the ${protocol.name} position once a month and withdraw or rotate only if the risk changes; keep a simple record of dates and amounts. Cost: ${gas} to exit. Time: 10 minutes a month.`,
  ];
}

function backtest(peers: ProtocolInput[], asOf: number, constants: ModelConstants): { medianRatio: number; medianAbsLogError: number; ratios: { protocol: ProtocolInput; ratio: number }[] } {
  const allRatios = peers.map((p) => p.mcap_usd! / p.tvl_usd);
  const ratios: { protocol: ProtocolInput; ratio: number }[] = [];
  for (const peer of peers) {
    const others = peers.filter((p) => p.slug !== peer.slug);
    const globalMedian = median(others.map((p) => p.mcap_usd! / p.tvl_usd));
    const sameCategory = others.filter((p) => categoryKey(p) === categoryKey(peer));
    const rawMedian = sameCategory.length > 0
      ? median(sameCategory.map((p) => p.mcap_usd! / p.tvl_usd))
      : globalMedian;
    const multiple = shrunkMultiple(rawMedian, sameCategory.length, globalMedian, constants);
    const score = scoreWithMultiple(peer, asOf, multiple, constants);
    ratios.push({ protocol: peer, ratio: score.implied / peer.mcap_usd! });
  }
  return {
    medianRatio: median(ratios.map((r) => r.ratio)),
    medianAbsLogError: median(ratios.map((r) => Math.abs(Math.log(r.ratio)))),
    ratios,
  };
}

function buildBacktestSummary(peers: ProtocolInput[], asOf: number): BacktestSummary {
  const tuned = backtest(peers, asOf, TUNED);
  const baseline = backtest(peers, asOf, BASELINE);
  const grouped = new Map<string, number[]>();
  for (const item of tuned.ratios) {
    const key = categoryKey(item.protocol);
    const list = grouped.get(key) ?? [];
    list.push(item.ratio);
    grouped.set(key, list);
  }
  const categoryBias = [...grouped.entries()]
    .filter(([, values]) => values.length >= 3)
    .map(([category, values]) => ({ category, peers: values.length, median_ratio: median(values) }))
    .sort((a, b) => Math.abs(Math.log(b.median_ratio)) - Math.abs(Math.log(a.median_ratio)))
    .slice(0, 6);
  return {
    peer_count: peers.length,
    median_ratio: tuned.medianRatio,
    median_abs_log_error: tuned.medianAbsLogError,
    baseline_median_ratio: baseline.medianRatio,
    baseline_median_abs_log_error: baseline.medianAbsLogError,
    category_bias: categoryBias,
  };
}

export function buildRadar(snapshot: SnapshotInput): RadarData {
  const asOf = parseDay(snapshot.as_of);
  if (asOf === null) throw new Error(`snapshot as_of is not a date: ${snapshot.as_of}`);
  if (!Array.isArray(snapshot.protocols) || !Array.isArray(snapshot.watchlist)) {
    throw new Error('snapshot must carry protocols and watchlist arrays');
  }
  const stats = buildPeerStats(snapshot.protocols);
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const watchlistSet = new Set(snapshot.watchlist);
  const watchlist = snapshot.watchlist.map((slug) => {
    const protocol = bySlug.get(slug);
    if (!protocol) throw new Error(`watchlist slug is not in protocols: ${slug}`);
    return protocol;
  });
  const early = snapshot.protocols
    .filter((p) => !watchlistSet.has(p.slug) && !hasLiveToken(p) && p.tvl_usd > 0 && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, EARLY_ROW_TARGET);
  if (early.length < EARLY_ROW_TARGET) {
    throw new Error(`only ${early.length} early pre-token protocols below the floor, need ${EARLY_ROW_TARGET}`);
  }

  const scored = [...watchlist, ...early]
    .map((protocol) => ({ protocol, score: scoreProtocol(protocol, asOf, stats) }))
    .sort((a, b) => b.score.implied - a.score.implied
      || b.protocol.tvl_usd - a.protocol.tvl_usd
      || (a.protocol.slug < b.protocol.slug ? -1 : 1));

  const rows: BoardRow[] = scored.map(({ protocol, score }, index) => ({
    slug: protocol.slug,
    name: protocol.name,
    category: protocol.category,
    chains: protocol.chains ?? [],
    rank: index + 1,
    implied_value_usd: score.implied,
    farm_steps: farmSteps(protocol, score.ageDays),
    watchlist: watchlistSet.has(protocol.slug),
    tvl_usd: protocol.tvl_usd,
    change_7d: protocol.change_7d,
    age_days: score.ageDays,
    peer_multiple: score.peerMultiple,
    growth_multiplier: score.growthMultiplier,
    maturity_multiplier: score.maturityMultiplier,
    breadth_multiplier: score.breadthMultiplier,
  }));

  const liveRows: LiveRow[] = snapshot.protocols
    .filter(hasLiveToken)
    .sort((a, b) => b.mcap_usd! - a.mcap_usd! || (a.slug < b.slug ? -1 : 1))
    .slice(0, LIVE_ROW_TARGET)
    .map((protocol, index) => {
      const score = scoreProtocol(protocol, asOf, stats);
      return {
        slug: protocol.slug,
        name: protocol.name,
        category: protocol.category,
        chains: protocol.chains ?? [],
        rank: index + 1,
        tvl_usd: protocol.tvl_usd,
        change_7d: protocol.change_7d,
        age_days: score.ageDays,
        market_cap_usd: protocol.mcap_usd!,
        model_estimate_usd: score.implied,
        model_ratio: score.implied / protocol.mcap_usd!,
        peer_multiple: score.peerMultiple,
        growth_multiplier: score.growthMultiplier,
        maturity_multiplier: score.maturityMultiplier,
        breadth_multiplier: score.breadthMultiplier,
      };
    });

  const boardCounts = new Map<string, number>();
  for (const row of rows) {
    const key = row.category ?? 'Uncategorised';
    boardCounts.set(key, (boardCounts.get(key) ?? 0) + 1);
  }
  const categories = new Set<string>([...boardCounts.keys(), ...stats.byCategory.keys()]);
  const categoryStats: CategoryStat[] = [...categories]
    .map((category) => {
      const peer = stats.byCategory.get(category);
      return {
        category,
        live_peers: peer?.ratios.length ?? 0,
        raw_median: peer?.rawMedian ?? null,
        multiple: peer?.multiple ?? clamp(stats.globalMedian, MULTIPLE_MIN, MULTIPLE_MAX),
        board_rows: boardCounts.get(category) ?? 0,
      };
    })
    .sort((a, b) => b.board_rows - a.board_rows || b.live_peers - a.live_peers || (a.category < b.category ? -1 : 1));

  return {
    meta: {
      as_of: snapshot.as_of,
      source: snapshot.source ?? 'DefiLlama protocol index',
      floor_usd: snapshot.floor_usd,
      protocol_count: snapshot.protocols.length,
      watchlist_count: watchlist.length,
      board_count: rows.length,
      early_count: rows.filter((r) => !r.watchlist).length,
      live_count: liveRows.length,
      peer_count: stats.peers.length,
    },
    model: {
      shrinkage_k: TUNED.shrinkageK,
      growth_weight: TUNED.growthWeight,
      maturity_floor: TUNED.maturityFloor,
      maturity_cap_days: MATURITY_CAP_DAYS,
      multiple_min: MULTIPLE_MIN,
      multiple_max: MULTIPLE_MAX,
      peer_tvl_cap_usd: PEER_TVL_CAP_USD,
      breadth_per_chain: BREADTH_PER_CHAIN,
      breadth_cap: BREADTH_CAP,
      global_median: stats.globalMedian,
    },
    rows,
    live_rows: liveRows,
    category_stats: categoryStats,
    backtest: buildBacktestSummary(stats.peers, asOf),
  };
}
