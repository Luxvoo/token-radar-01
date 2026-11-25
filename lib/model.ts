// lib/model.ts — Token Radar model (radar-2, round 3).
//
// A pre-token protocol's implied token value is estimated from the snapshot's own
// figures only, never from its name:
//
//   implied = TVL x peer multiple x growth multiplier x maturity multiplier x breadth
//
// Peer multiple: for each category, the median market-cap-to-TVL ratio of the
// live-token protocols in that category (market cap above zero, TVL at most $2B),
// shrunk toward the global median with (n * category + 6 * global) / (n + 6) so a
// category with one or two live peers cannot set a wild multiple, then clamped to
// 0.08-0.80. Categories with no live peers use the global median. A protocol
// counts as live-token only when its market cap is a real positive number:
// mcap 0 or null means no token on record, and the -1 sentinel means a token
// exists but its cap is not tracked, so it is neither a peer nor pre-token.
//
// Growth: the 7-day TVL change, clamped to -50..+80%, with multiplier
// 1 + growth / 100 * 0.4. Maturity: 0.7 + min(age_days, 1095) / 1095 * 0.3, where
// age is days from listed_at to the snapshot date (365 days when unlisted).
// Breadth: 1 + 0.02 * min(chains - 1, 5).
//
// The board is the 40 watchlist slugs (every protocol at or above the $50M floor
// with no token on record) plus the top 186 pre-token protocols below the floor
// by TVL. Live-token protocols are set aside: the 24 largest by market cap are
// shown with their caps, never mixed into the ranking. Each board row carries a
// 6-step farm plan with chain-aware gas costs and category-specific actions.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number;
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

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number;
  age_days: number;
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
  change_7d: number;
  mcap_usd: number;
}

export interface Board {
  as_of: string;
  model_version: string;
  model: Record<string, number>;
  peers: { global: number; by_category: Record<string, number> };
  watchlist_size: number;
  floor_usd: number;
  early_size: number;
  board_size: number;
  live_size: number;
  rows: BoardRow[];
  live: LiveRow[];
}

// The model's constants, also published in the board so the dashboard can show
// them and a reader can check the arithmetic.
const MODEL = {
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

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const round6 = (x: number): number => Math.round(x * 1_000_000) / 1_000_000;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function parseDay(text: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function ageDays(listedAt: string | null, asOf: string): number {
  if (!listedAt) return MODEL.unknown_age_days;
  const listed = parseDay(listedAt);
  const snap = parseDay(asOf);
  if (Number.isNaN(listed) || Number.isNaN(snap)) return MODEL.unknown_age_days;
  return Math.max(0, Math.round((snap - listed) / 86_400_000));
}

// A protocol has a token when its market cap is a recorded number other than
// zero: null and 0 mean no token on record, -1 means a token exists whose cap
// is not tracked.
function hasToken(p: SnapshotProtocol): boolean {
  return typeof p.mcap_usd === 'number' && p.mcap_usd !== 0;
}

// A live-token peer needs a real positive cap to form a market-cap-to-TVL ratio.
function isPeer(p: SnapshotProtocol): boolean {
  return (
    typeof p.mcap_usd === 'number' &&
    p.mcap_usd > 0 &&
    typeof p.tvl_usd === 'number' &&
    p.tvl_usd > 0 &&
    p.tvl_usd <= MODEL.peer_tvl_cap_usd
  );
}

// ---------------------------------------------------------------- gas costs
//
// What one transaction costs on a chain, in honest round numbers. The first
// chain listed for a protocol is its main chain, so the farm plan prices gas
// there. Cheap chains cost cents, rollups about a dime, mid-tier L1s about
// thirty cents, Ethereum about five dollars, Bitcoin about two dollars of
// network fees, and anything unlisted about a dollar.

interface GasPrice {
  tx: string;
  first: string;
}

const CENT: GasPrice = { tx: 'about $0.01 of gas', first: 'a few cents of gas' };
const DIME: GasPrice = { tx: 'about $0.10 of gas', first: 'under $1 of gas' };
const QUARTER: GasPrice = { tx: 'about $0.30 of gas', first: 'under $1 of gas' };
const ETH: GasPrice = { tx: 'about $5 of gas', first: 'a few dollars of gas' };
const BTC: GasPrice = { tx: 'about $2 of network fees', first: 'a few dollars of network fees' };
const DEFAULT_GAS: GasPrice = { tx: 'about $1 of gas', first: 'about $1 of gas' };

const GAS_BY_CHAIN: Record<string, GasPrice> = {
  Solana: CENT,
  Sui: CENT,
  Aptos: CENT,
  Near: CENT,
  Sei: CENT,
  Injective: CENT,
  Osmosis: CENT,
  Cosmos: CENT,
  Celestia: CENT,
  Secret: CENT,
  Neutron: CENT,
  Kujira: CENT,
  Noble: CENT,
  Stride: CENT,
  Persistence: CENT,
  Agoric: CENT,
  Juno: CENT,
  Terra2: CENT,
  XPLA: CENT,
  Migaloo: CENT,
  Dymension: CENT,
  Archway: CENT,
  Chihuahua: CENT,
  Umee: CENT,
  'Fetch Hub': CENT,
  Akash: CENT,
  BandChain: CENT,
  Orai: CENT,
  Mantra: CENT,
  Initia: CENT,
  Algorand: CENT,
  Stellar: CENT,
  Ripple: CENT,
  TON: CENT,
  Hedera: CENT,
  XION: CENT,
  Base: DIME,
  Arbitrum: DIME,
  Optimism: DIME,
  Polygon: DIME,
  'zkSync Era': DIME,
  Linea: DIME,
  Scroll: DIME,
  Blast: DIME,
  Mode: DIME,
  Unichain: DIME,
  Ink: DIME,
  Katana: DIME,
  Monad: DIME,
  MegaETH: DIME,
  'World Chain': DIME,
  Manta: DIME,
  Morph: DIME,
  Pharos: DIME,
  RISE: DIME,
  Tempo: DIME,
  'Immutable zkEVM': DIME,
  Starknet: DIME,
  Zircuit: DIME,
  Zora: DIME,
  Abstract: DIME,
  Gravity: DIME,
  Kroma: DIME,
  Lisk: DIME,
  Redbelly: DIME,
  LightLink: DIME,
  Degen: DIME,
  Sophon: DIME,
  ApeChain: DIME,
  'Reya Network': DIME,
  MetalL2: DIME,
  Lens: DIME,
  Matchain: DIME,
  Supra: DIME,
  Soneium: DIME,
  Swellchain: DIME,
  Etherlink: DIME,
  Fraxtal: DIME,
  Boba: DIME,
  Boba_Bnb: DIME,
  Boba_Avax: DIME,
  'Cronos zkEVM': DIME,
  'Polygon zkEVM': DIME,
  'Astar zkEVM': DIME,
  'Silicon zkEVM': DIME,
  Zkfair: DIME,
  Fluent: DIME,
  Hemi: DIME,
  Botanix: DIME,
  Bitlayer: DIME,
  BOB: DIME,
  Merlin: DIME,
  RSK: DIME,
  BSquared: DIME,
  Mezo: DIME,
  Binance: QUARTER,
  Avalanche: QUARTER,
  Tron: QUARTER,
  Fantom: QUARTER,
  Celo: QUARTER,
  xDai: QUARTER,
  Moonbeam: QUARTER,
  Moonriver: QUARTER,
  Cronos: QUARTER,
  Klaytn: QUARTER,
  Flare: QUARTER,
  Berachain: QUARTER,
  'Hyperliquid L1': QUARTER,
  Plasma: QUARTER,
  Arc: QUARTER,
  Mantle: QUARTER,
  Chiliz: QUARTER,
  Tezos: QUARTER,
  EOS: QUARTER,
  Bittensor: QUARTER,
  Filecoin: QUARTER,
  HydraDX: QUARTER,
  Provenance: QUARTER,
  Pulse: QUARTER,
  'BOT Chain': QUARTER,
  Kava: QUARTER,
  Evmos: QUARTER,
  Aurora: QUARTER,
  Fuse: QUARTER,
  Velas: QUARTER,
  Kucoin: QUARTER,
  OKExChain: QUARTER,
  Wanchain: QUARTER,
  Heco: QUARTER,
  PlatON: QUARTER,
  Ontology: QUARTER,
  OntologyEVM: QUARTER,
  Neo3: QUARTER,
  Harmony: QUARTER,
  Canto: QUARTER,
  REI: QUARTER,
  Meter: QUARTER,
  TomoChain: QUARTER,
  ThunderCore: QUARTER,
  Electroneum: QUARTER,
  Stratis: QUARTER,
  Taraxa: QUARTER,
  Kardia: QUARTER,
  HAQQ: QUARTER,
  'Elysium Kinetiq': QUARTER,
  Shibarium: QUARTER,
  ZIGChain: QUARTER,
  ZetaChain: QUARTER,
  Mint: QUARTER,
  GodwokenV1: QUARTER,
  DFK: QUARTER,
  Palm: QUARTER,
  Europa: QUARTER,
  Conflux: QUARTER,
  Qubic: QUARTER,
  Canton: QUARTER,
  Arweave: QUARTER,
  Kaspa: QUARTER,
  Ergo: QUARTER,
  Zilliqa: QUARTER,
  Mina: QUARTER,
  Alephium: QUARTER,
  Proton: QUARTER,
  Massa: QUARTER,
  Oasys: QUARTER,
  Somnia: QUARTER,
  'Aura Network': QUARTER,
  EnergyWeb: QUARTER,
  AirDAO: QUARTER,
  'BEVM Canary': QUARTER,
  Cube: QUARTER,
  ENULS: QUARTER,
  'EOS EVM': QUARTER,
  Bahamut: QUARTER,
  Fuel: QUARTER,
  GateLayer: QUARTER,
  GravityBridge: QUARTER,
  Hibachi: QUARTER,
  Shiden: QUARTER,
  Karura: QUARTER,
  Acala: QUARTER,
  Astar: QUARTER,
  Bifrost: QUARTER,
  'Bifrost Network': QUARTER,
  Ethereum: ETH,
  Bitcoin: BTC,
  Bitcoincash: BTC,
  'BSV Blockchain': BTC,
  Doge: BTC,
  Litecoin: BTC,
  Zcash: BTC,
  Dash: BTC,
  Decred: BTC,
  Stacks: BTC,
};

function gasFor(chain: string): GasPrice {
  return GAS_BY_CHAIN[chain] ?? DEFAULT_GAS;
}

// The deposit asset for a farm: USDT on Tron, BTC on Bitcoin-family chains,
// USDC everywhere else.
const BTC_CHAINS = new Set([
  'Bitcoin',
  'Bitcoincash',
  'BSV Blockchain',
  'Doge',
  'Litecoin',
  'Zcash',
  'Dash',
  'Decred',
  'Stacks',
  'Bitlayer',
  'BOB',
  'Merlin',
  'RSK',
  'BSquared',
  'Mezo',
]);

function depositAsset(chain: string): string {
  if (chain === 'Tron') return 'USDT';
  if (BTC_CHAINS.has(chain)) return 'BTC';
  return 'USDC';
}

// ---------------------------------------------------------------- farm plans
//
// Every row gets six steps. Step 1 sets up a fresh wallet, step 2 is the
// category-specific main action, step 3 is a weekly qualifying action, step 4
// holds the position for at least 30 days, step 5 claims only from the
// protocol's own site, step 6 keeps a farm log. Each step names what it costs
// and how long it takes, and none of them promises an airdrop or a return.

interface CategoryAction {
  main: string;
  weekly: string;
}

function categoryAction(
  category: string,
  name: string,
  chain: string,
  asset: string,
  capital: number,
): CategoryAction {
  const c = `$${capital}`;
  switch (category) {
    case 'Lending':
      return {
        main: `Supply ${c} of ${asset} to ${name} on ${chain} and borrow a small amount against it, keeping the loan well collateralised.`,
        weekly: `Repay or top up a little of the ${name} loan on ${chain} so the position stays active and healthy.`,
      };
    case 'Dexs':
      return {
        main: `Add ${c} of liquidity to ${name}'s main pool on ${chain} and keep the position inside its active price range.`,
        weekly: `Swap a small amount through ${name} on ${chain}, or add and then remove a little liquidity.`,
      };
    case 'Risk Curators':
      return {
        main: `Deposit ${c} into a ${name} vault on ${chain} and hold the vault shares.`,
        weekly: `Make one qualifying move on ${name} — a deposit, a swap, a vote or a claim — on ${chain}.`,
      };
    case 'Onchain Capital Allocator':
      return {
        main: `Deposit ${c} into a ${name} allocator vault on ${chain} and hold the shares.`,
        weekly: `Add a little more to the ${name} vault on ${chain}, or vote on one of its allocations.`,
      };
    case 'Liquid Staking':
      return {
        main: `Stake ${c} with ${name} on ${chain} and hold the receipt token it issues.`,
        weekly: `Stake a small extra amount with ${name} on ${chain}, or claim and restake the rewards.`,
      };
    case 'Liquid Restaking':
      return {
        main: `Restake ${c} through ${name} on ${chain} and hold the receipt token.`,
        weekly: `Restake a small extra amount through ${name} on ${chain}.`,
      };
    case 'Restaking':
      return {
        main: `Restake ${c} through ${name} on ${chain} and keep the position staked.`,
        weekly: `Add a little more stake through ${name} on ${chain}.`,
      };
    case 'Staking Pool':
      return {
        main: `Stake ${c} in the ${name} pool on ${chain} and keep it staked.`,
        weekly: `Add a small amount to the ${name} stake on ${chain}, or claim and restake the rewards.`,
      };
    case 'CDP':
      return {
        main: `Lock ${c} of collateral in ${name} on ${chain} and mint a modest amount of its stablecoin.`,
        weekly: `Adjust the ${name} position on ${chain} a little — add collateral or repay some of the mint.`,
      };
    case 'CDP Manager':
      return {
        main: `Open a ${name} position on ${chain} with ${c} of collateral and keep it safely collateralised.`,
        weekly: `Check and adjust the ${name} position on ${chain} so it stays healthy.`,
      };
    case 'Bridge':
    case 'Canonical Bridge':
    case 'Cross Chain Bridge':
      return {
        main: `Bridge ${c} through ${name} to ${chain} and hold the bridged funds there.`,
        weekly: `Bridge a small amount through ${name} to ${chain} and back once.`,
      };
    case 'Yield':
      return {
        main: `Deposit ${c} into a ${name} strategy on ${chain} and leave it earning.`,
        weekly: `Harvest and redeposit the ${name} yield on ${chain}.`,
      };
    case 'Yield Aggregator':
      return {
        main: `Deposit ${c} into a ${name} aggregator vault on ${chain}.`,
        weekly: `Harvest the ${name} yield on ${chain} and put it back into the vault.`,
      };
    case 'Basis Trading':
      return {
        main: `Deposit ${c} into the ${name} basis vault on ${chain}.`,
        weekly: `Top up the ${name} basis position on ${chain} by a small amount.`,
      };
    case 'Derivatives':
      return {
        main: `Open a small hedged position on ${name} on ${chain} with ${c} of margin.`,
        weekly: `Rebalance the ${name} hedge on ${chain} a little.`,
      };
    case 'Leveraged Farming':
      return {
        main: `Open a small leveraged farm on ${name} on ${chain} with ${c} of collateral, at low leverage.`,
        weekly: `Check the ${name} farm's health on ${chain} and adjust the leverage if needed.`,
      };
    case 'Farm':
      return {
        main: `Deposit ${c} into the ${name} farm on ${chain} and keep it staked.`,
        weekly: `Claim the ${name} farm rewards on ${chain} and restake them.`,
      };
    case 'RWA':
      return {
        main: `Buy ${c} of the tokenised asset ${name} offers on ${chain} and hold it.`,
        weekly: `Buy a small extra amount of the ${name} asset on ${chain}.`,
      };
    case 'Synthetics':
      return {
        main: `Mint a small synthetic position with ${name} on ${chain} using ${c} of collateral.`,
        weekly: `Adjust the ${name} synthetic position on ${chain} a little.`,
      };
    case 'Indexes':
      return {
        main: `Buy ${c} of the ${name} index on ${chain} and hold it.`,
        weekly: `Add a small amount to the ${name} index position on ${chain}.`,
      };
    case 'Launchpad':
      return {
        main: `Hold ${c} in ${name}'s launchpad allocation on ${chain} to qualify for its sales.`,
        weekly: `Check ${name} for a new sale on ${chain} and join one with a small amount.`,
      };
    case 'Insurance':
      return {
        main: `Buy ${c} of cover from ${name} on ${chain} for a position you hold.`,
        weekly: `Review the ${name} cover on ${chain} and renew or top it up if needed.`,
      };
    case 'Payments':
      return {
        main: `Spend ${c} through ${name} on ${chain} for something you would buy anyway.`,
        weekly: `Make one small payment through ${name} on ${chain}.`,
      };
    case 'Crypto Card Issuer':
      return {
        main: `Load ${c} onto the ${name} card on ${chain} and spend it on everyday purchases.`,
        weekly: `Spend a small amount with the ${name} card on ${chain}.`,
      };
    case 'Token Locker':
      return {
        main: `Lock ${c} of tokens with ${name} on ${chain} for the longest term you accept.`,
        weekly: `Check the ${name} lock on ${chain} and extend it a little if you plan to hold.`,
      };
    case 'Options Vault':
      return {
        main: `Deposit ${c} into the ${name} options vault on ${chain}.`,
        weekly: `Check the ${name} vault's epoch on ${chain} and roll the position if it ended.`,
      };
    case 'Options':
      return {
        main: `Buy one small option through ${name} on ${chain} with ${c} of premium.`,
        weekly: `Open or close one small option on ${name} on ${chain}.`,
      };
    case 'Algo-Stables':
      return {
        main: `Mint ${c} of the ${name} stablecoin on ${chain} against collateral and hold it.`,
        weekly: `Check the ${name} peg on ${chain} and adjust the position if it drifts.`,
      };
    case 'Dual-Token Stablecoin':
      return {
        main: `Mint ${c} of the ${name} stablecoin on ${chain} and hold it.`,
        weekly: `Check the ${name} stablecoin's peg on ${chain} and rebalance if needed.`,
      };
    case 'Stablecoin Wrapper':
      return {
        main: `Wrap ${c} into the ${name} stablecoin on ${chain} and hold it.`,
        weekly: `Wrap or unwrap a small amount through ${name} on ${chain}.`,
      };
    case 'Stablecoin Issuer':
      return {
        main: `Mint ${c} of the ${name} stablecoin on ${chain} and hold it.`,
        weekly: `Check the ${name} stablecoin backing on ${chain} and adjust if needed.`,
      };
    case 'Chain':
      return {
        main: `Bridge ${c} onto ${name} and use one of its apps for a swap.`,
        weekly: `Do one small transaction on ${name} — a swap or a transfer.`,
      };
    case 'CEX':
      return {
        main: `Do ${c} of spot volume on ${name}, in small trades you would make anyway.`,
        weekly: `Make one small spot trade on ${name}.`,
      };
    case 'CeDeFi':
      return {
        main: `Deposit ${c} into the ${name} vault on ${chain} and hold the position.`,
        weekly: `Add a small amount to the ${name} vault on ${chain}.`,
      };
    case 'Collateral Markets':
    case 'Collateral Management':
      return {
        main: `Supply ${c} of ${asset} as collateral on ${name} on ${chain}.`,
        weekly: `Top up the ${name} collateral on ${chain} a little.`,
      };
    case 'Anchor BTC':
      return {
        main: `Deposit ${c} of BTC with ${name} on ${chain} and hold the receipt token.`,
        weekly: `Add a small amount of BTC to ${name} on ${chain}.`,
      };
    case 'Decentralized BTC':
      return {
        main: `Bridge ${c} of BTC into ${name} on ${chain} and use it in one of its apps.`,
        weekly: `Use a small amount of BTC inside ${name} on ${chain}.`,
      };
    case 'Restaked BTC':
      return {
        main: `Restake ${c} of BTC through ${name} on ${chain}.`,
        weekly: `Add a small amount of BTC to the ${name} restake on ${chain}.`,
      };
    case 'Governance Incentives':
      return {
        main: `Lock ${c} with ${name} on ${chain} to earn its governance incentives.`,
        weekly: `Vote on one ${name} proposal on ${chain}.`,
      };
    case 'Decentralized AI':
      return {
        main: `Spend ${c} on ${name}'s AI service on ${chain}.`,
        weekly: `Run one small job through ${name} on ${chain}.`,
      };
    case 'AI Agents':
      return {
        main: `Spend ${c} using ${name}'s agents on ${chain}.`,
        weekly: `Run one small task through ${name} on ${chain}.`,
      };
    case 'Prediction Market':
      return {
        main: `Place ${c} of predictions with ${name} on ${chain}, spread over two outcomes you have researched.`,
        weekly: `Place one small prediction with ${name} on ${chain}.`,
      };
    case 'Privacy':
      return {
        main: `Move ${c} through ${name}'s private transfer on ${chain}.`,
        weekly: `Make one small private transfer with ${name} on ${chain}.`,
      };
    case 'DOR':
    case 'Reserve Currency':
      return {
        main: `Hold ${c} of the ${name} reserve token on ${chain}.`,
        weekly: `Add a small amount to the ${name} reserve position on ${chain}.`,
      };
    case 'NFT Marketplace':
      return {
        main: `Buy one small NFT on ${name} on ${chain} for ${c} or less and hold it.`,
        weekly: `List or buy one small item on ${name} on ${chain}.`,
      };
    case 'Liquidity Manager':
      return {
        main: `Deposit ${c} into the ${name} managed liquidity vault on ${chain}.`,
        weekly: `Check the ${name} vault's range on ${chain} and let it rebalance.`,
      };
    case 'Interest Rate Derivatives':
      return {
        main: `Open a small rate position on ${name} on ${chain} with ${c} of margin.`,
        weekly: `Adjust the ${name} rate position on ${chain} a little.`,
      };
    case 'OTC Marketplace':
      return {
        main: `Complete one small OTC trade through ${name} on ${chain} for ${c}.`,
        weekly: `Check ${name} for a small OTC trade on ${chain}.`,
      };
    default:
      return {
        main: `Deposit ${c} into ${name} on ${chain} and hold the position.`,
        weekly: `Do one small qualifying action on ${name} on ${chain}.`,
      };
  }
}

function farmSteps(p: SnapshotProtocol): string[] {
  const chain = p.chains && p.chains.length > 0 ? (p.chains[0] as string) : 'Ethereum';
  const gas = gasFor(chain);
  const asset = depositAsset(chain);
  const tvl = typeof p.tvl_usd === 'number' ? p.tvl_usd : 0;
  const capital = tvl >= 500_000_000 ? 150 : tvl >= 100_000_000 ? 100 : 50;
  const action = categoryAction(p.category, p.name, chain, asset, capital);
  return [
    `Start with a fresh wallet that holds only the funds you plan to farm on ${chain}, and store its recovery phrase offline, never in a screenshot or a message. Cost: ${gas.first} for the first transfer. Time: 5 minutes.`,
    `${action.main} Cost: $${capital} of capital and ${gas.tx}. Time: 15 minutes to set up.`,
    `${action.weekly} Cost: ${gas.tx} a week. Time: 10 minutes a week.`,
    `Leave the position alone for at least 30 days, so the activity is spread across more than one snapshot. Cost: the $${capital} stays in the position. Time: 30 days.`,
    `Before withdrawing, open the protocol's own points or rewards page from its official site and claim there; ignore any site or message that asks you to pay to claim. Cost: nothing to check, and never pay to claim. Time: 10 minutes.`,
    `Write the wallet address, the dates and every transaction in a farm log, so you can repeat the position or unwind it later. Cost: nothing but the log itself. Time: 5 minutes.`,
  ];
}

// ---------------------------------------------------------------- the board

export function buildBoard(snapshot: Snapshot): Board {
  const asOf = snapshot.as_of;
  const floor = snapshot.floor_usd;
  const protocols = snapshot.protocols;
  const bySlug = new Map<string, SnapshotProtocol>();
  for (const p of protocols) bySlug.set(p.slug, p);

  // Peer multiples from live-token protocols with a real positive cap.
  const peers = protocols.filter(isPeer);
  const global = median(peers.map((p) => (p.mcap_usd as number) / (p.tvl_usd as number)));
  const byCategory = new Map<string, number>();
  const cats = new Map<string, number[]>();
  for (const p of peers) {
    const list = cats.get(p.category) ?? [];
    list.push((p.mcap_usd as number) / (p.tvl_usd as number));
    cats.set(p.category, list);
  }
  for (const [cat, ratios] of cats) {
    const med = median(ratios);
    const shrunk = (ratios.length * med + MODEL.shrink_k * global) / (ratios.length + MODEL.shrink_k);
    byCategory.set(cat, clamp(shrunk, MODEL.peer_floor, MODEL.peer_cap));
  }
  const peerMultiple = (category: string): number => {
    const v = byCategory.get(category);
    return clamp(v === undefined ? global : v, MODEL.peer_floor, MODEL.peer_cap);
  };

  // The board: the watchlist, plus the top 186 pre-token protocols below the
  // floor by TVL. Pre-token above the floor that the house did not watchlist
  // is left out entirely.
  const watchlist = snapshot.watchlist
    .map((slug) => bySlug.get(slug))
    .filter((p): p is SnapshotProtocol => p !== undefined && !hasToken(p));
  const belowFloor = protocols
    .filter((p) => !snapshot.watchlist.includes(p.slug) && !hasToken(p) && (p.tvl_usd ?? 0) < floor)
    .sort((a, b) => (b.tvl_usd ?? 0) - (a.tvl_usd ?? 0))
    .slice(0, 186);
  const picked = [...watchlist, ...belowFloor];

  const rows: BoardRow[] = picked.map((p) => {
    const tvl = p.tvl_usd ?? 0;
    const growth = clamp(p.change_7d ?? 0, MODEL.growth_floor, MODEL.growth_cap);
    const growthMultiplier = round6(1 + (growth / 100) * MODEL.growth_weight);
    const age = ageDays(p.listed_at ?? null, asOf);
    const maturityMultiplier = round6(
      MODEL.maturity_floor + (Math.min(age, MODEL.maturity_days) / MODEL.maturity_days) * MODEL.maturity_range,
    );
    const breadthMultiplier = round6(
      1 + MODEL.breadth_step * Math.min((p.chains?.length ?? 1) - 1, MODEL.breadth_max_chains),
    );
    const peer = round6(peerMultiple(p.category));
    const implied = Math.round(tvl * peer * growthMultiplier * maturityMultiplier * breadthMultiplier);
    return {
      rank: 0,
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains ?? [],
      tvl_usd: tvl,
      change_7d: p.change_7d ?? 0,
      age_days: age,
      implied_value_usd: implied,
      peer_multiple: peer,
      growth_multiplier: growthMultiplier,
      maturity_multiplier: maturityMultiplier,
      breadth_multiplier: breadthMultiplier,
      farm_steps: farmSteps(p),
    };
  });
  rows.sort((a, b) => b.implied_value_usd - a.implied_value_usd || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1));
  rows.forEach((r, i) => {
    r.rank = i + 1;
  });

  // Live-token protocols set aside: the 24 largest by market cap.
  const live: LiveRow[] = protocols
    .filter((p) => typeof p.mcap_usd === 'number' && (p.mcap_usd as number) > 0)
    .sort((a, b) => ((b.mcap_usd as number) ?? 0) - ((a.mcap_usd as number) ?? 0))
    .slice(0, 24)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains ?? [],
      tvl_usd: p.tvl_usd ?? 0,
      change_7d: p.change_7d ?? 0,
      mcap_usd: p.mcap_usd as number,
    }));

  const byCategoryObj: Record<string, number> = {};
  for (const [cat, v] of [...byCategory.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) byCategoryObj[cat] = v;

  return {
    as_of: asOf,
    model_version: 'radar-2',
    model: { ...MODEL },
    peers: { global, by_category: byCategoryObj },
    watchlist_size: watchlist.length,
    floor_usd: floor,
    early_size: belowFloor.length,
    board_size: rows.length,
    live_size: live.length,
    rows,
    live,
  };
}
