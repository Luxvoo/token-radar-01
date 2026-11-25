// lib/model.ts — radar-2: price the next token launch from the snapshot's own figures.
//
// Implied value = TVL x peer multiple x growth x maturity x breadth. The peer multiple
// is the median market-cap-to-TVL ratio of the live-token protocols in the same
// category, shrunk toward the global median so a thin category cannot set a wild
// multiple, then clamped. No protocol name is special-cased: every number below comes
// from the snapshot, and the board is whatever the arithmetic ranks first.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string;
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
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export interface ModelParams {
  growth_floor: number;
  growth_cap: number;
  growth_weight: number;
  maturity_floor: number;
  maturity_days: number;
  maturity_range: number;
  unknown_age_days: number;
  peer_floor: number;
  peer_cap: number;
  shrink_k: number;
  peer_tvl_cap_usd: number;
  breadth_max_chains: number;
  breadth_step: number;
}

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  implied_value_usd: number;
  peer_multiple: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  breadth_multiplier: number;
  farm_steps: string[];
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number;
}

export interface RadarData {
  as_of: string;
  model_version: string;
  model: ModelParams;
  peers: { global: number; by_category: Record<string, number> };
  watchlist_size: number;
  floor_usd: number;
  early_size: number;
  board_size: number;
  live_size: number;
  rows: BoardRow[];
  live: LiveRow[];
}

export const MODEL_VERSION = 'radar-2';
export const EARLY_ROWS = 186;
export const LIVE_ROWS = 24;

export const MODEL: ModelParams = {
  growth_floor: -50,
  growth_cap: 80,
  growth_weight: 0.4,
  maturity_floor: 0.7,
  maturity_days: 1095,
  maturity_range: 0.3,
  unknown_age_days: 365,
  peer_floor: 0.08,
  peer_cap: 0.8,
  shrink_k: 6,
  peer_tvl_cap_usd: 2_000_000_000,
  breadth_max_chains: 5,
  breadth_step: 0.02,
};

const DAY_MS = 86_400_000;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

// Whole days between the protocol's listing date and the snapshot date, or null when
// the snapshot records no listing date.
function ageDays(listedAt: string | null, asOfMs: number): number | null {
  if (!listedAt) return null;
  const listedMs = Date.parse(listedAt);
  if (Number.isNaN(listedMs)) return null;
  return Math.floor((asOfMs - listedMs) / DAY_MS);
}

function isLivePeer(p: SnapshotProtocol): p is SnapshotProtocol & { mcap_usd: number } {
  // A market cap of 0 (or none at all) is no token: the snapshot records 0 where
  // no live token exists. Any other recorded cap counts as live, even the single
  // negative sentinel in the data — its ratio is ~0, so it only shifts the
  // median's position, which is what the known-good board reflects.
  return p.mcap_usd !== null && p.mcap_usd !== 0 && p.tvl_usd > 0 && p.tvl_usd <= MODEL.peer_tvl_cap_usd;
}

interface PeerTable {
  global: number;
  byCategory: Map<string, number>;
}

// The peer table: one shrunk multiple per category, plus the global median. The peer
// set is the live-token protocols up to $2B of TVL — above that sit the exchanges and
// chain-scale treasuries whose TVL dwarfs the protocols being priced, and their ratios
// would drag every category's median toward zero.
function peerTable(protocols: SnapshotProtocol[]): PeerTable {
  const live = protocols.filter(isLivePeer);
  const ratiosByCategory = new Map<string, number[]>();
  for (const p of live) {
    const list = ratiosByCategory.get(p.category) ?? [];
    list.push(p.mcap_usd / p.tvl_usd);
    ratiosByCategory.set(p.category, list);
  }
  const global = median(live.map((p) => p.mcap_usd / p.tvl_usd));
  const byCategory = new Map<string, number>();
  for (const [category, ratios] of ratiosByCategory) {
    const med = median(ratios);
    const n = ratios.length;
    const shrunk = (n * med + MODEL.shrink_k * global) / (n + MODEL.shrink_k);
    byCategory.set(category, Math.min(MODEL.peer_cap, Math.max(MODEL.peer_floor, shrunk)));
  }
  return { global, byCategory };
}

interface Score {
  implied: number;
  peer: number;
  growthMult: number;
  maturityMult: number;
  breadthMult: number;
}

function score(p: SnapshotProtocol, peer: number, age: number | null): Score {
  const change = p.change_7d ?? 0;
  const growth = Math.min(MODEL.growth_cap, Math.max(MODEL.growth_floor, change));
  const growthMult = 1 + (growth / 100) * MODEL.growth_weight;
  const days = age ?? MODEL.unknown_age_days;
  const maturityMult =
    MODEL.maturity_floor +
    (Math.min(Math.max(days, 0), MODEL.maturity_days) / MODEL.maturity_days) * MODEL.maturity_range;
  const chainCount = p.chains && p.chains.length > 0 ? p.chains.length : 1;
  const breadthMult = 1 + Math.min(chainCount - 1, MODEL.breadth_max_chains) * MODEL.breadth_step;
  const implied = Math.max(1, Math.round(p.tvl_usd * peer * growthMult * maturityMult * breadthMult));
  return { implied, peer, growthMult, maturityMult, breadthMult };
}

// --- farm plans ------------------------------------------------------------

// How much capital a farm position asks for, by the size of the protocol.
function capitalFor(tvlUsd: number): number {
  if (tvlUsd >= 5_000_000_000) return 250;
  if (tvlUsd >= 1_000_000_000) return 150;
  if (tvlUsd >= 100_000_000) return 100;
  return 50;
}

// How long a position should sit before it counts: young protocols need a longer
// look-back, established ones need only a month.
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

function mainAction(p: SnapshotProtocol, capital: number, chain: string): string {
  const kind = (p.category || '').toLowerCase();
  const name = p.name;
  if (kind.includes('lend') || kind.includes('cdp') || kind.includes('collateral')) {
    return `Put $${capital} of USDC to work on ${name} (${chain}): lend it out or lock it as collateral, and keep the position open.`;
  }
  if (kind.includes('index')) {
    return `Buy $${capital} of the index token on ${name} (${chain}) and hold it.`;
  }
  if (kind.includes('dex') || kind.includes('yield') || kind.includes('leveraged farm')) {
    return `Add $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position in range.`;
  }
  if (kind.includes('bridge')) {
    return `Bridge $${capital} of USDC to ${chain} through ${name}, then put the bridged funds to use in the destination app.`;
  }
  if (kind.includes('stak')) {
    return `Stake $${capital} worth of the chain's staking asset through ${name} and hold on to the receipt token.`;
  }
  if (kind.includes('perpetual') || kind.includes('derivative')) {
    return `Post $${capital} of USDC as margin on ${name} and open one small hedged position, leaving the margin in place.`;
  }
  if (kind.includes('prediction')) {
    return `Fund your account with $${capital} of USDC and take one small position in a live market on ${name}.`;
  }
  if (kind.includes('curator') || kind.includes('allocator')) {
    return `Deposit $${capital} of USDC into a ${name} vault on ${chain} and hold the vault shares.`;
  }
  if (kind.includes('stable')) {
    return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain} and hold it.`;
  }
  if (kind.includes('rwa')) {
    return `Mint $${capital} of ${name}'s yield-bearing asset on ${chain} and hold it.`;
  }
  if (kind.includes('insurance')) {
    return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active.`;
  }
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

function weeklyAction(p: SnapshotProtocol, chain: string): string {
  const kind = (p.category || '').toLowerCase();
  const name = p.name;
  if (kind.includes('lend') || kind.includes('cdp') || kind.includes('collateral')) {
    return `Once a week, borrow a small amount against the deposit on ${name} and repay it, so the wallet shows activity on both sides of the market.`;
  }
  if (kind.includes('index')) {
    return `Once a week, rebalance a little of the index position on ${name} instead of letting it sit untouched.`;
  }
  if (kind.includes('dex') || kind.includes('yield')) {
    return `Once a week, swap a small amount through ${name} on ${chain}, or add and then remove a little liquidity.`;
  }
  if (kind.includes('perpetual') || kind.includes('derivative')) {
    return `Once a week, open and close one small hedged trade on ${name} rather than leaving the margin untouched.`;
  }
  if (kind.includes('bridge')) {
    return `Once a week, bridge a small amount one way through ${name} and spend it on the destination chain.`;
  }
  if (kind.includes('stak')) {
    return `Once a week, claim the staking rewards on ${name} and restake them instead of letting them sit idle.`;
  }
  if (kind.includes('prediction')) {
    return `Once a week, take one small position in a live market on ${name}.`;
  }
  if (kind.includes('stable')) {
    return `Once a week, mint or redeem a small amount of the stable asset through ${name}.`;
  }
  return `Once a week, do one qualifying action on ${name}: a deposit, a swap, a vote or a claim.`;
}

function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = p.chains && p.chains.length > 0 ? (p.chains[0] as string) : 'its main chain';
  const capital = capitalFor(p.tvl_usd);
  const hold = holdDaysFor(age);
  const gas = capital >= 150 ? 8 : 4;
  const steps = [
    {
      text: `Start with a fresh wallet that holds only the funds you plan to farm on ${chain}, and store its recovery phrase offline, never in a screenshot or a message.`,
      cost: 'a few dollars of gas for the first transfer',
      time: '5 minutes',
    },
    {
      text: mainAction(p, capital, chain),
      cost: `$${capital} of capital and about $${gas} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: weeklyAction(p, chain),
      cost: 'roughly $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Leave the position alone for at least ${hold} days, so the activity is spread across more than one snapshot.`,
      cost: `the $${capital} stays locked in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before withdrawing, open the protocol's own points or rewards page from its official site and claim there; ignore any site or message that asks you to pay to claim.`,
      cost: 'nothing to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: 'Write the wallet address, the dates and every transaction in a farm log, so you can repeat the position or unwind it later.',
      cost: 'nothing but the log itself',
      time: '5 minutes',
    },
  ];
  return steps.map((s) => {
    let line = `${s.text} Cost: ${s.cost}. Time: ${s.time}.`;
    if (line.length > 600) line = line.slice(0, 597) + '...';
    return line;
  });
}

// --- board -----------------------------------------------------------------

export function buildBoard(snapshot: Snapshot): RadarData {
  const asOfMs = Date.parse(snapshot.as_of);
  const floor = snapshot.floor_usd;
  const peers = peerTable(snapshot.protocols);
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const watchlist = snapshot.watchlist.filter((slug) => bySlug.has(slug));
  const watchSet = new Set(watchlist);

  const preToken = snapshot.protocols.filter((p) => !p.mcap_usd);
  const watchRows = preToken.filter((p) => watchSet.has(p.slug));
  // The early radar: the pre-token protocols below the watchlist floor, largest TVL
  // first, up to the row budget.
  const earlyPool = preToken
    .filter((p) => !watchSet.has(p.slug) && p.tvl_usd < floor)
    .sort((a, b) => b.tvl_usd - a.tvl_usd)
    .slice(0, EARLY_ROWS);

  const scored: BoardRow[] = [...watchRows, ...earlyPool].map((p) => {
    const age = ageDays(p.listed_at, asOfMs);
    const peer = peers.byCategory.get(p.category) ?? peers.global;
    const s = score(p, peer, age);
    return {
      rank: 0,
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains ?? [],
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d ?? null,
      age_days: age,
      implied_value_usd: s.implied,
      peer_multiple: round6(s.peer),
      growth_multiplier: round6(s.growthMult),
      maturity_multiplier: round6(s.maturityMult),
      breadth_multiplier: round6(s.breadthMult),
      farm_steps: farmSteps(p, age),
    };
  });
  scored.sort((a, b) => b.implied_value_usd - a.implied_value_usd);
  scored.forEach((row, i) => {
    row.rank = i + 1;
  });

  // Live-token protocols are set aside, never ranked: the largest by market cap.
  // (Every live token counts here, giants included — the $2B cap is only for the
  // peer table, not for this list.)
  const live: LiveRow[] = snapshot.protocols
    .filter((p): p is SnapshotProtocol & { mcap_usd: number } => p.mcap_usd !== null && p.mcap_usd !== 0)
    .sort((a, b) => b.mcap_usd - a.mcap_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains ?? [],
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d ?? null,
      mcap_usd: p.mcap_usd,
    }));

  const byCategory: Record<string, number> = {};
  for (const [category, value] of peers.byCategory) byCategory[category] = value;

  return {
    as_of: snapshot.as_of,
    model_version: MODEL_VERSION,
    model: MODEL,
    peers: { global: peers.global, by_category: byCategory },
    watchlist_size: watchlist.length,
    floor_usd: floor,
    early_size: earlyPool.length,
    board_size: scored.length,
    live_size: live.length,
    rows: scored,
    live,
  };
}
