// How the radar turns one sealed snapshot into a ranked board.
//
// This module holds the whole scoring model, radar-2. It reads nothing from disk and reaches no
// network: the caller hands it a parsed snapshot and gets back the ranked rows, the live set, and
// the compact dataset the dashboard renders. Everything a row claims comes from the snapshot's own
// numbers for that protocol — its TVL, its seven-day move, how long it has been tracked, and how
// many chains it runs on. No name is ever treated specially; the same arithmetic scores each row.
//
// The board is two groups joined and ranked together. First comes the watchlist, the floor: every
// slug the snapshot names there, because the gate requires the board to cover it whole. Then the
// early group: every other pre-token protocol the snapshot carries below the watchlist floor, with
// no TVL cut inside it — a small protocol the list leaves out is exactly the early find this radar
// exists to name. Live-token protocols never enter the board; they are set aside at their market
// values and shown apart, never mixed into the ranking.
//
// One function prices every row, impliedValue. Its factors, each from the snapshot alone:
//   base     — a quarter of the protocol's TVL, the same multiple for every row, so the other
//               factors do the separating instead of the multiple.
//   growth   — the seven-day TVL change, clamped to -60..120 and half-weighted, so a protocol the
//               market is piling into now is worth more than a flat one at the same TVL.
//   maturity — 0.6 plus up to 0.4 for age, capped at three years, so a protocol that has run for
//               years with no token on record scores as overdue, but age alone cannot carry a row.
//   chain    — four points per extra chain, capped at five, for wider distribution and liquidity.
//   fade     — a tenth off when a protocol is over two years old, shrinking, and still tokenless:
//               fading, not ripening. Young rows and growing rows never fade.
//   implied  — base times the four multipliers, rounded, at least a dollar.

/** One protocol entry, exactly the ten fields the sealed snapshot carries for it. */
export interface SnapshotProtocol {
  slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null;
  listed_at: string | null; gecko_id: string | null; symbol: string | null;
}

/** The snapshot document as a whole. */
export interface Snapshot {
  as_of: string; source: string; floor_usd: number;
  protocols: SnapshotProtocol[]; watchlist: string[];
}

/** The model's constants, stated the same way the dashboard states them. */
export interface ModelConstants {
  base_multiple: number; growth_weight: number; growth_floor: number; growth_cap: number;
  maturity_floor: number; maturity_range: number; maturity_days: number; unknown_age_days: number;
  chain_step: number; chain_cap: number; fade_age_days: number; fade_multiplier: number;
}

export const MODEL: ModelConstants = {
  base_multiple: 0.25, growth_weight: 0.5, growth_floor: -60, growth_cap: 120,
  maturity_floor: 0.6, maturity_range: 0.4, maturity_days: 1095, unknown_age_days: 365,
  chain_step: 0.04, chain_cap: 5, fade_age_days: 730, fade_multiplier: 0.9,
};

/** The version the dashboard names and the rules quote. */
export const MODEL_VERSION = 'radar-2';

/** How many live-token rows the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** One farm step: what to do, what it costs, and how long it takes. */
export interface FarmStep {
  text: string; cost: string; time: string;
}

/** One row of board.json, the ranked board's row. */
export interface BoardRow {
  rank: number; slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null; listed_at: string | null;
  gecko_id: string | null; symbol: string | null; token_status: 'pre-token';
  age_days: number | null; implied_value_usd: number;
  model: {
    base_multiple: number; growth_pct: number; growth_multiplier: number;
    maturity_multiplier: number; chain_multiplier: number; fade_multiplier: number; age_days: number | null;
  };
  farm_steps: string[];
}

/** One row in compact form for data.js, its farm plan generated in the page. */
export interface RadarRow {
  rank: number; slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null; listed_at: string | null;
  age_days: number | null; implied_value_usd: number; growth_multiplier: number;
  maturity_multiplier: number; chain_multiplier: number; fade_multiplier: number; watchlist: boolean;
}

/** A live-token protocol: it trades already, so the board shows the market's own value. */
export interface LiveRow {
  slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; mcap_usd: number | null; change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, and the model behind them. */
export interface RadarData {
  as_of: string; source: string; floor_usd: number; model: ModelConstants; model_version: string;
  watchlist_size: number; board_size: number; early_size: number; live_size: number;
  rows: RadarRow[]; live: LiveRow[];
}

/** Why a snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, or the fallback when the value is missing or not a number. */
function asNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return fallback;
}

/** `value` held inside [`low`, `high`]. */
function clamp(value: number, low: number, high: number): number {
  if (value < low) {
    return low;
  }
  if (value > high) {
    return high;
  }
  return value;
}

/** Whole days from `listedAt` to `asOf`, never below zero; null when a date is missing or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) {
    return null;
  }
  const listedMs = Date.parse(listedAt + 'T00:00:00Z');
  const asOfMs = Date.parse(asOf + 'T00:00:00Z');
  if (!Number.isFinite(listedMs) || !Number.isFinite(asOfMs)) {
    return null;
  }
  const days = Math.floor((asOfMs - listedMs) / DAY_MS);
  return days > 0 ? days : 0;
}

/** The multipliers and the implied value one protocol earns under `model`. */
export function impliedValue(protocol: SnapshotProtocol, asOf: string, model: ModelConstants): { implied: number; growthPct: number; growthMult: number; maturityMult: number; chainMult: number; fadeMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const rawGrowth = asNumber(protocol.change_7d, 0);
  const growthPct = clamp(rawGrowth, model.growth_floor, model.growth_cap);
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age === null ? model.unknown_age_days : age;
  const cappedAge = clamp(ageForModel, 0, model.maturity_days);
  const maturityMult = model.maturity_floor + (cappedAge / model.maturity_days) * model.maturity_range;
  const extraChains = clamp(protocol.chains.length - 1, 0, model.chain_cap);
  const chainMult = 1 + model.chain_step * extraChains;
  let fadeMult = 1;
  if (age !== null && age > model.fade_age_days && growthPct < 0) {
    fadeMult = model.fade_multiplier;
  }
  const base = protocol.tvl_usd * model.base_multiple;
  const product = base * growthMult * maturityMult * chainMult * fadeMult;
  const implied = Math.max(1, Math.round(product));
  return { implied, growthPct, growthMult, maturityMult, chainMult, fadeMult, age };
}

/** A release suffix at the end of a name marks a pool of another protocol. */
const VERSION_MARK = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  const { mcap_usd: cap, gecko_id: gecko, symbol: sym } = p;
  return cap === null && gecko === null && sym === null;
}

/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) {
    return false;
  }
  if (p.category === 'CEX') {
    return false;
  }
  return !VERSION_MARK.test(p.name);
}

/** The snapshot's protocols keyed by slug. */
function indexBySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  const out = new Map<string, SnapshotProtocol>();
  for (const entry of protocols) {
    out.set(entry.slug, entry);
  }
  return out;
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = indexBySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor, so every slug it names goes in first. Coverage of the watchlist is
  // one of the gate's rows, and it is never gambled on a record that might be missing.
  for (const slug of snapshot.watchlist) {
    const found = index.get(slug);
    if (found !== undefined) {
      chosen.set(slug, found);
    }
  }
  // Then the early radar: every other rankable pre-token protocol under the floor. No TVL cut
  // inside it — a small protocol the watchlist leaves out is the early find the radar exists to name.
  for (const candidate of snapshot.protocols) {
    const alreadyIn = chosen.has(candidate.slug);
    const belowFloor = candidate.tvl_usd < snapshot.floor_usd;
    if (!alreadyIn && belowFloor && isRankable(candidate)) {
      chosen.set(candidate.slug, candidate);
    }
  }

  const scored = [...chosen.values()].map((proto) => {
    const v = impliedValue(proto, snapshot.as_of, model);
    return { proto, ...v };
  });
  scored.sort((a, b) => {
    if (b.implied !== a.implied) {
      return b.implied - a.implied;
    }
    if (a.proto.slug < b.proto.slug) {
      return -1;
    }
    return a.proto.slug > b.proto.slug ? 1 : 0;
  });
  return scored.map((hit, i) => ({
    rank: i + 1, slug: hit.proto.slug, name: hit.proto.name, category: hit.proto.category,
    chains: hit.proto.chains, tvl_usd: hit.proto.tvl_usd, change_7d: hit.proto.change_7d,
    mcap_usd: hit.proto.mcap_usd, listed_at: hit.proto.listed_at, gecko_id: hit.proto.gecko_id,
    symbol: hit.proto.symbol, token_status: 'pre-token', age_days: hit.age,
    implied_value_usd: hit.implied,
    model: {
      base_multiple: model.base_multiple, growth_pct: hit.growthPct,
      growth_multiplier: toFour(hit.growthMult), maturity_multiplier: toFour(hit.maturityMult),
      chain_multiplier: toFour(hit.chainMult), fade_multiplier: hit.fadeMult, age_days: hit.age,
    },
    farm_steps: farmSteps(hit.proto, hit.age).map(stepText),
  }));
}

const toFour = (n: number): number => Math.round(n * 1e4) / 1e4;

/** One step as a single string: its action, then its cost and time, within 20..600 characters. */
export function stepText(step: FarmStep): string {
  let joined = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
  if (joined.length > 600) {
    joined = joined.slice(0, 596) + '...';
  }
  if (joined.length < 20) {
    joined = joined + " Hold the position and check the protocol's own page.";
  }
  return joined;
}

/** The first chain a protocol names, or a neutral phrase when it names none. */
function firstChain(p: SnapshotProtocol): string {
  if (p.chains.length > 0) {
    return p.chains[0]!;
  }
  return 'its main chain';
}

/** What one transaction costs on a chain, in words a farmer can budget with. */
export function gasFor(chain: string): string {
  if (chain === 'Ethereum') return 'about $8 to $15 of gas';
  if (chain === 'Bitcoin') return 'about $3 to $8 of network fees';
  if (chain === 'Solana') return 'about $0.05 of gas';
  const cheapChains = new Set([
    'Arbitrum', 'Optimism', 'Base', 'Binance', 'Polygon', 'Avalanche', 'Linea', 'Scroll',
    'Blast', 'Mode', 'Ink', 'Unichain', 'zkSync Era', 'Mantle', 'Celo', 'Gnosis',
    'Fantom', 'Tron', 'Stellar', 'Flare', 'Sei', 'Sui', 'Aptos', 'Near',
    'Berachain', 'Monad', 'Hyperliquid L1', 'Plume Mainnet', 'Story', 'Sonic',
    'Abstract', 'Katana', 'Pharos', 'Robinhood Chain', 'TAC', 'Stable', 'Tempo',
  ]);
  if (cheapChains.has(chain)) return 'about $0.10 to $1 of gas';
  return 'about $1 to $3 of gas';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function stakeFor(p: SnapshotProtocol): number {
  const tvl = p.tvl_usd;
  if (tvl >= 5_000_000_000) {
    return 250;
  }
  if (tvl >= 1_000_000_000) {
    return 150;
  }
  if (tvl >= 100_000_000) {
    return 100;
  }
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdFor(age: number | null): number {
  if (age === null) {
    return 30;
  }
  if (age < 180) {
    return 60;
  }
  if (age < 365) {
    return 45;
  }
  return 30;
}

/** The category's one action, in words a farmer can follow. */
function moveFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const kind = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (kind.includes('lend') || kind.includes('cdp') || kind.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and borrow a small amount against it, then repay the borrow.`;
  if (kind.includes('dex')) return `Provide $${capital} of liquidity to ${name}'s main USDC pool on ${chain} and keep the position in range.`;
  if (kind.includes('yield') || kind.includes('leveraged farm')) return `Deposit $${capital} into ${name}'s highest-TVL vault on ${chain} and keep the shares.`;
  if (kind.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (kind.includes('staking') || kind.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt token.`;
  if (kind.includes('perpetual') || kind.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge, then close it.`;
  if (kind.includes('prediction')) return `Fund $${capital} and place one market position on ${name}, then settle it.`;
  if (kind.includes('curator') || kind.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares until the epoch ends.`;
  if (kind.includes('stable')) return `Mint $${capital} of the stable asset through ${name} on ${chain} and hold it in your wallet.`;
  if (kind.includes('rwa')) return `Mint $${capital} of the protocol's yield-bearing asset on ${chain} and hold it for the full term.`;
  if (kind.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy until it expires.`;
  if (kind.includes('basis')) return `Deposit $${capital} of USDC into ${name}'s basis vault on ${chain} and keep the position open.`;
  if (kind.includes('payment')) return `Send $${capital} through ${name} on ${chain} and keep the receipt for the record.`;
  if (kind.includes('chain')) return `Bridge $${capital} of USDC to the chain ${name} secures and use it in one app there.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time. The plan comes from
 * the protocol's own record — its category, its chains, its TVL, its age — never from a hand-written
 * list of names. Gas is priced per chain, capital per TVL, the hold per age, and a second chain is
 * used only when the protocol actually runs on one.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = firstChain(p);
  const gas = gasFor(chain);
  const capital = stakeFor(p);
  const hold = holdFor(age);
  const action = moveFor(p, capital, chain);
  const second = p.chains.length > 1
    ? `Repeat the same position on ${p.chains[1]} so the farm covers a second chain the protocol runs on.`
    : `Deepen the position once, adding $${Math.round(capital / 2)} more, so the farm is not a single deposit.`;
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`, cost: gas + ' for the first transaction',
      time: '5 minutes',
    },
    { text: action, cost: `$${capital} of capital and ${gas}`, time: '15 minutes to set up' },
    { text: second, cost: `$${Math.round(capital / 2)} of capital and ${gas}`, time: '15 minutes' },
    {
      text: `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.`, cost: gas + ' a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`, cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`, cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log, then plan the exit before the token launches.`, cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  const trading = snapshot.protocols.filter((entry) => !isPreToken(entry) && entry.category !== 'CEX');
  trading.sort((a, b) => {
    const capGap = (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0);
    if (capGap !== 0) {
      return capGap;
    }
    return b.tvl_usd - a.tvl_usd;
  });
  return trading.slice(0, LIVE_ROWS).map((entry) => ({
    slug: entry.slug, name: entry.name, category: entry.category, chains: entry.chains,
    tvl_usd: entry.tvl_usd, mcap_usd: entry.mcap_usd, change_7d: entry.change_7d,
  }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow, watchlist: Set<string>): RadarRow {
  return {
    rank: row.rank, slug: row.slug, name: row.name, category: row.category, chains: row.chains,
    tvl_usd: row.tvl_usd, change_7d: row.change_7d, mcap_usd: row.mcap_usd, listed_at: row.listed_at,
    age_days: row.age_days, implied_value_usd: row.implied_value_usd,
    growth_multiplier: row.model.growth_multiplier, maturity_multiplier: row.model.maturity_multiplier,
    chain_multiplier: row.model.chain_multiplier, fade_multiplier: row.model.fade_multiplier,
    watchlist: watchlist.has(row.slug),
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const watchlist = new Set(snapshot.watchlist);
  const early = board.filter((row) => !watchlist.has(row.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of, source: snapshot.source, floor_usd: snapshot.floor_usd, model,
    model_version: MODEL_VERSION, watchlist_size: snapshot.watchlist.length,
    board_size: board.length, early_size: early, live_size: live.length,
    rows: board.map((r) => radarRow(r, watchlist)), live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SnapshotError('snapshot.json is not a JSON object');
  }
  const doc = parsed as Record<string, unknown>;
  if (typeof doc.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(doc.as_of)) {
    throw new SnapshotError('snapshot.json has no as_of date');
  }
  if (typeof doc.source !== 'string') {
    throw new SnapshotError('snapshot.json has no source');
  }
  if (typeof doc.floor_usd !== 'number' || !Number.isSafeInteger(doc.floor_usd) || doc.floor_usd <= 0) {
    throw new SnapshotError('snapshot.json has no floor_usd');
  }
  if (!Array.isArray(doc.protocols)) {
    throw new SnapshotError('snapshot.json has no protocols array');
  }
  if (!Array.isArray(doc.watchlist) || doc.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotError('snapshot.json has no watchlist of slugs');
  }
  const protocols = doc.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    }
    const entry = v as Record<string, unknown>;
    if (typeof entry.slug !== 'string' || typeof entry.name !== 'string' || typeof entry.tvl_usd !== 'number' || !Number.isFinite(entry.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: entry.slug, name: entry.name,
      category: typeof entry.category === 'string' ? entry.category : null,
      chains: Array.isArray(entry.chains) ? entry.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: entry.tvl_usd,
      change_7d: typeof entry.change_7d === 'number' && Number.isFinite(entry.change_7d) ? entry.change_7d : null,
      mcap_usd: typeof entry.mcap_usd === 'number' && Number.isFinite(entry.mcap_usd) ? entry.mcap_usd : null,
      listed_at: typeof entry.listed_at === 'string' ? entry.listed_at : null,
      gecko_id: typeof entry.gecko_id === 'string' ? entry.gecko_id : null,
      symbol: typeof entry.symbol === 'string' ? entry.symbol : null,
    };
  });
  return {
    as_of: doc.as_of, source: doc.source, floor_usd: doc.floor_usd, protocols,
    watchlist: doc.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const seen = new Set(board.map((row) => row.slug));
  const missing = snapshot.watchlist.filter((s) => !seen.has(s));
  if (missing.length > 0) {
    return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  }
  const ordered = board.map((row) => row.rank);
  ordered.sort((a, b) => a - b);
  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i] !== i + 1) {
      return `rank ${i + 1} is ${ordered[i]}`;
    }
  }
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) {
      return `row ${i + 1} outranks row ${i} on implied value`;
    }
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) {
      return `${r.slug} has ${steps.length} farm steps`;
    }
    for (const s of steps) {
      if (s.length < 20 || s.length > 600) {
        return `${r.slug} has a farm step of ${s.length} characters`;
      }
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
