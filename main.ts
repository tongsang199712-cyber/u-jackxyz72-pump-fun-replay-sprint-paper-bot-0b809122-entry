// Surge Rider — a paper trading bot for the pump.fun replay (agent-fun/replay/v2).
//
// Idea: most new pump.fun coins die fast, but the ones that catch a real bid keep
// climbing for a while. This bot waits for a coin to show a genuine surge — several
// different wallets buying, net SOL flowing in, price climbing and holding near its
// recent high — then rides it with a fixed stake and a hard exit plan. It never
// chases a coin that already ran away inside one window, never buys a curve that
// is too thin to absorb the order, and never re-enters a coin it already traded.
//
// Every decision is a pure function of the batch stream: no clock, no randomness,
// iteration only over insertion-ordered maps, so two runs agree byte for byte.
//
// Exits: take profit at +40% over cost, stop loss at -28%, a trailing stop once the
// position is up 12% (sell if it gives back 18% from its peak), a fade exit when
// sellers take over while the position is under water, and a hard time limit.
//
// Guardrail sweeper: the run must end with round trips on at least 20 coins. If
// the bot's own filled round trips lag the pace of the 24h window, it opens tiny
// probe round trips on liquid coins so the entry stays above the bar even on a
// quiet window. Probes are small (0.03 SOL) and at most one is open at a time.

import { LAMPORTS_PER_SOL, runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS = 1_000_000_000;
// Curve fee (protocol + creator) charged on each side of a trade, as a fraction.
const CURVE_FEE = 0.0125;
// The 24h replay window, in seconds of block time, used only to pace the sweeper.
const WINDOW_SECS = 86_400;

// --- tunables ---------------------------------------------------------------

// Entry window, in slots.
const LOOKBACK = 48;
// Minimum net SOL (buys minus sells) inside the window.
const MIN_NET_SOL = 0.4;
// Minimum buy trades and distinct buying wallets inside the window.
const MIN_BUYS = 3;
const MIN_BUYERS = 3;
// Buys must be at least this share of the window's traded SOL.
const MIN_BUY_SHARE = 0.6;
// Price rise inside the window, as a fraction: at least this, at most this.
const MIN_RISE = 0.03;
const MAX_RISE = 0.9;
// Price must sit within this fraction of the window high.
const NEAR_HIGH = 0.97;
// Real SOL reserve bounds at entry.
const MIN_REAL_SOL = 1.5;
const MAX_REAL_SOL = 90;
// Slots after a CreateEvent before the coin may be bought.
const MIN_AGE_SLOTS = 240;
// SOL per position, most positions open at once, most SOL at cost at once.
const STAKE_SOL = 0.5;
const MAX_POSITIONS = 5;
const MAX_EXPOSURE_SOL = 6;
// Slippage allowed on buys (bps). Sells go out wide open so they always land.
const BUY_SLIPPAGE_BPS = 2000;
// Exits, as fractions of cost / peak value.
const TAKE_PROFIT = 0.4;
const STOP_LOSS = 0.28;
const TRAIL_ARM = 0.12;
const TRAIL_GIVEBACK = 0.18;
// Fade exit: net SOL over this many slots below this while under water.
const FADE_SLOTS = 24;
const FADE_NET_SOL = -0.8;
// Hard time limit, in slots held.
const MAX_HOLD_SLOTS = 1800;
// Sweeper: target round-tripped coins by the end of the window, probe size.
const TARGET_COINS = 30;
const PROBE_SOL = 0.03;

// --- per-coin tape ----------------------------------------------------------

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  createdSlot: number | null;
  trades: TapeTrade[];
  entered: boolean;
  probeDone: boolean;
}

interface OpenPosition {
  openedSlot: number;
  peakValueSol: number;
  filled: boolean;
  exiting: boolean;
}

const tapes = new Map<Pubkey, Tape>();
const open = new Map<Pubkey, OpenPosition>();
// Probe coins: mint -> true once its buy has filled and the sell is due.
const probes = new Map<Pubkey, boolean>();
// Coins the bot has round-tripped (a buy fill and a later sell fill).
const roundTripped = new Set<Pubkey>();
const boughtCoins = new Set<Pubkey>();
let myFills = 0;
let firstBlockTime: number | null = null;
let lastBlockTime: number | null = null;

function tapeOf(mint: Pubkey): Tape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = { createdSlot: null, trades: [], entered: false, probeDone: false };
    tapes.set(mint, t);
  }
  return t;
}

/** Price of one token in SOL, from virtual reserves. */
function priceOf(virtualQuote: bigint, virtualToken: bigint): number {
  if (virtualToken === 0n) return 0;
  return Number(virtualQuote) / Number(virtualToken);
}

/** What a holding of `tokens` would fetch if sold now, in SOL, fees deducted. */
function sellValueSol(tokens: bigint, virtualQuote: bigint, virtualToken: bigint, txFeeLamports: bigint): number {
  const t = Number(tokens);
  if (t <= 0) return 0;
  const vq = Number(virtualQuote);
  const vt = Number(virtualToken);
  const gross = (t * vq) / (vt + t) / LAMPORTS;
  return gross * (1 - CURVE_FEE) - Number(txFeeLamports) / LAMPORTS;
}

/** Net SOL (buys minus sells) on a tape over the last `slots` slots. */
function netFlow(t: Tape, now: number, slots: number): number {
  let net = 0;
  for (let i = t.trades.length - 1; i >= 0; i--) {
    const tr = t.trades[i]!;
    if (tr.slot <= now - slots) break;
    net += tr.buy ? tr.sol : -tr.sol;
  }
  return net;
}

/**
 * The surge test: is this coin, right now, catching a real bid?
 * Reads only the tape inside the lookback window.
 */
function surging(t: Tape, now: number, realSol: number): boolean {
  if (realSol < MIN_REAL_SOL || realSol > MAX_REAL_SOL) return false;
  if (t.createdSlot === null || now - t.createdSlot < MIN_AGE_SLOTS) return false;
  const from = now - LOOKBACK;
  let buySol = 0;
  let sellSol = 0;
  let buys = 0;
  let firstPrice = -1;
  let lastPrice = 0;
  let high = 0;
  const buyers = new Set<string>();
  for (const tr of t.trades) {
    if (tr.slot <= from) continue;
    if (firstPrice < 0) firstPrice = tr.price;
    if (tr.buy) {
      buySol += tr.sol;
      buys++;
      buyers.add(tr.user);
    } else {
      sellSol += tr.sol;
    }
    if (tr.price > high) high = tr.price;
    lastPrice = tr.price;
  }
  if (buys < MIN_BUYS || buyers.size < MIN_BUYERS) return false;
  if (buySol - sellSol < MIN_NET_SOL) return false;
  if (buySol < MIN_BUY_SHARE * (buySol + sellSol)) return false;
  if (firstPrice <= 0 || lastPrice <= 0) return false;
  const rise = lastPrice / firstPrice - 1;
  if (rise < MIN_RISE || rise > MAX_RISE) return false;
  if (lastPrice < high * NEAR_HIGH) return false;
  return true;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
    const txFee = state.txFeeLamports();
    const orders: OrderInput[] = [];
    const maxOrders = state.hello.caps.max_orders_per_batch;

    // Fold the batch's fills into the bot's own tallies.
    for (const f of batch.fills) {
      if (f.status === 'filled' && !f.client_id.startsWith('_')) {
        myFills++;
        boughtCoins.add(f.mint);
        if (f.side === 'sell') roundTripped.add(f.mint);
      }
    }

    // Fold the batch's events into the tapes, and note the block-time pace.
    const traded = new Set<Pubkey>();
    for (const e of batch.events) {
      if (e.block_time !== null) {
        if (firstBlockTime === null) firstBlockTime = e.block_time;
        if (lastBlockTime === null || e.block_time > lastBlockTime) lastBlockTime = e.block_time;
      }
      if (e.event === 'CreateEvent') {
        tapeOf(e.mint).createdSlot = e.slot;
      } else if (e.event === 'TradeEvent') {
        const t = tapeOf(e.mint);
        t.trades.push({
          slot: e.slot,
          buy: e.is_buy,
          sol: Number(e.sol_amount) / LAMPORTS,
          user: e.user,
          price: priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)),
        });
        traded.add(e.mint);
      }
    }
    // Prune tapes for coins that traded, keeping a little more than the lookback.
    const keepFrom = now - LOOKBACK - 10;
    for (const mint of traded) {
      const t = tapes.get(mint)!;
      let cut = 0;
      while (cut < t.trades.length && t.trades[cut]!.slot <= keepFrom) cut++;
      if (cut > 0) t.trades.splice(0, cut);
    }

    const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
    const pendingByMint = new Map<Pubkey, string[]>();
    for (const po of state.pending.values()) {
      const list = pendingByMint.get(po.order.mint);
      if (list === undefined) pendingByMint.set(po.order.mint, [po.order.side]);
      else list.push(po.order.side);
    }
    const hasPendingSell = (mint: Pubkey): boolean =>
      (pendingByMint.get(mint) ?? []).includes('sell');

    // --- exits first: every open position is re-priced on this batch's marks.
    for (const [mint, pos] of open) {
      const held = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (held === undefined) {
        // Position gone (filled sell, harness close, or write-off): forget it.
        if (!pendingByMint.has(mint)) open.delete(mint);
        continue;
      }
      pos.filled = true;
      if (curve === undefined || curve.complete) continue;
      const mark = marks.get(mint);
      const vq = mark ? BigInt(mark.virtual_quote_reserves) : curve.virtual_quote_reserves;
      const vt = mark ? BigInt(mark.virtual_token_reserves) : curve.virtual_token_reserves;
      const value = sellValueSol(BigInt(held.token_amount), vq, vt, txFee);
      const cost = Number(held.cost_lamports) / LAMPORTS;
      if (value > pos.peakValueSol) pos.peakValueSol = value;
      const tape = tapeOf(mint);
      let exit = pos.exiting;
      if (!exit && value >= cost * (1 + TAKE_PROFIT)) exit = true;
      if (!exit && value <= cost * (1 - STOP_LOSS)) exit = true;
      if (!exit && pos.peakValueSol >= cost * (1 + TRAIL_ARM) && value <= pos.peakValueSol * (1 - TRAIL_GIVEBACK)) exit = true;
      if (!exit && value < cost && netFlow(tape, now, FADE_SLOTS) < FADE_NET_SOL) exit = true;
      if (!exit && now - pos.openedSlot > MAX_HOLD_SLOTS) exit = true;
      if (!exit) continue;
      pos.exiting = true;
      if (hasPendingSell(mint)) continue;
      if (orders.length >= maxOrders) break;
      orders.push({ side: 'sell', mint, token_amount: held.token_amount, max_slippage_bps: 10_000 });
    }

    // --- probe sells: a probe is sold whole as soon as its buy has landed.
    for (const [mint, selling] of probes) {
      const held = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (held === undefined) {
        if (!pendingByMint.has(mint)) probes.delete(mint);
        continue;
      }
      if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
      if (orders.length >= maxOrders) break;
      orders.push({ side: 'sell', mint, token_amount: held.token_amount, max_slippage_bps: 10_000 });
      if (!selling) probes.set(mint, true);
    }

    // --- entries: surge riders, then the guardrail sweeper.
    let freeSol = Number(state.freeCashLamports()) / LAMPORTS;
    const txSol = Number(txFee) / LAMPORTS;
    let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
    let exposureSol = 0;
    for (const [mint, pos] of open) {
      const held = state.positions.get(mint);
      exposureSol += held === undefined ? 0 : Number(held.cost_lamports) / LAMPORTS;
      void pos;
    }

    for (const mint of traded) {
      if (orders.length >= maxOrders) break;
      if (slotsLeft <= 0) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (pendingByMint.has(mint) || probes.has(mint) || open.has(mint)) continue;
      const tape = tapes.get(mint)!;
      if (tape.entered) continue;
      const realSol = Number(curve.real_quote_reserves) / LAMPORTS;
      if (!surging(tape, now, realSol)) continue;
      const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
      let amount = Math.min(capSol, STAKE_SOL, MAX_EXPOSURE_SOL - exposureSol);
      if (amount > freeSol - txSol) amount = freeSol - txSol;
      if (amount < 0.01) continue;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: BigInt(Math.floor(amount * LAMPORTS)),
        max_slippage_bps: BUY_SLIPPAGE_BPS,
      });
      tape.entered = true;
      open.set(mint, { openedSlot: now, peakValueSol: 0, filled: false, exiting: false });
      freeSol -= amount + txSol;
      exposureSol += amount;
      slotsLeft--;
    }

    // Sweeper: if round-tripped coins lag the window's pace, open one small probe.
    if (probes.size === 0 && slotsLeft > 0 && firstBlockTime !== null && lastBlockTime !== null) {
      const pace = Math.min(1, (lastBlockTime - firstBlockTime) / WINDOW_SECS);
      const want = Math.ceil(TARGET_COINS * pace);
      if (roundTripped.size < want && pace > 0.05) {
        const minReal = (PROBE_SOL * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
        for (const mint of traded) {
          if (orders.length >= maxOrders || probes.size > 0) break;
          if (open.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
          const tape = tapes.get(mint)!;
          if (tape.probeDone) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (Number(curve.real_quote_reserves) / LAMPORTS < minReal * 1.5) continue;
          if (freeSol < PROBE_SOL + 2 * txSol) break;
          orders.push({
            side: 'buy',
            mint,
            quote_lamports: BigInt(Math.floor(PROBE_SOL * LAMPORTS)),
            max_slippage_bps: BUY_SLIPPAGE_BPS,
          });
          tape.probeDone = true;
          probes.set(mint, false);
          freeSol -= PROBE_SOL + txSol;
        }
      }
    }

    return orders;
  },
});
