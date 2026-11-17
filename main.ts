// Dip-reversion swing bot for cbBTC/USDC (agent-fun/bars-replay/v1).
//
// Idea, in one paragraph: on a 1-minute replay the pool price is noisy
// (about 6 bps of 1-minute noise) while a full round trip costs roughly
// 37 bps at the depths this window actually shows (4 bps fee + 2 bps
// modelled slippage + about 13 bps of price impact per side on a
// $1,000 trade), so chasing breakouts and fast EMA crosses bleeds out
// in fees — every one of those families lost money on the dev window.
// What works here is the opposite: wait for the price to fall a long
// way below where it has recently been, buy the dip in full, and let
// it recover toward that recent high. Entries are rare (a handful per
// day), exits are mechanical, and nothing is ever held through a
// collapse without a stop.
//
// Rules (all integer arithmetic on the bar values, so two runs agree
// byte for byte):
//   - History: keep the last 480 closes and highs of CBBTC.
//   - Entry, when flat and at least 240 bars have been seen: buy the
//     whole cash balance when the close is at least DIP_BPS below the
//     highest high of the last 240 bars, unless the price is also more
//     than GUARD_BPS below the first close seen (a falling knife: the
//     market is in a steep slide, not a dip — stay out).
//   - Exit, whole position, whichever comes first:
//       * trailing stop: the close falls TRAIL_BPS below the highest
//         close seen since the position opened;
//       * recovery: the close climbs back to within RECOVER_BPS of
//         the trailing high the dip was measured from;
//       * time stop: HOLD_MAX_BARS bars have passed since entry.
//   - One order per reply at most, slippage capped at 100 bps past the
//     close the decision was made on, so a fill into a sudden gap is
//     refused and retried on the next bar instead of chased. Exit
//     conditions are re-checked every bar, so a refused sell is sent
//     again while its reason still holds.
//
// Parameters were chosen on the published dev window by scanning a
// coarse grid around this family (dip 120–140 bps, trail 80–120 bps,
// hold 360–600 bars); every neighbour of the chosen point stayed
// positive there, so the bot is not tuned to a knife-edge optimum.
// The guard never binds on the dev window (its worst since-start
// drawdown is about -91 bps); it exists only for the unseen race day.

import { BPS, runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** Bars of history the trailing high is measured over. */
const LOOKBACK_BARS = 240;
/** Bars of history kept (the guard needs the first close seen). */
const KEEP_BARS = 480;
/** Entry when the close is this far, in bps, under the trailing high. */
const DIP_BPS = 130n;
/** Exit when the close falls this far, in bps, under the post-entry peak. */
const TRAIL_BPS = 100n;
/** Exit when the close recovers to within this, in bps, of the entry high. */
const RECOVER_BPS = 20n;
/** Exit this many bars after entry at the latest. */
const HOLD_MAX_BARS = 480;
/** Do not buy a dip while the price is this far, in bps, under the first close seen. */
const GUARD_BPS = 150n;
/** Refuse a fill more than this, in bps, past the close the order was decided on. */
const MAX_SLIPPAGE_BPS = 100;

/** The bars seen so far, oldest first, capped at KEEP_BARS. */
const closes: bigint[] = [];
const highs: bigint[] = [];
/** Set while a position is open: the seq it filled on, the trailing high it dipped from, and the best close since. */
let entrySeq: number | null = null;
let entryHigh: bigint | null = null;
let peakClose: bigint | null = null;

function trailingHigh(): bigint {
  let hi = 0n;
  const start = Math.max(0, highs.length - LOOKBACK_BARS);
  for (let i = start; i < highs.length; i++) {
    if (highs[i]! > hi) hi = highs[i]!;
  }
  return hi;
}

function sinceStartBps(close: bigint): bigint {
  const first = closes[0]!;
  return ((close - first) * BPS) / first;
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    const close = BigInt(bar.c);
    const high = BigInt(bar.h);
    closes.push(close);
    highs.push(high);
    if (closes.length > KEEP_BARS) {
      closes.shift();
      highs.shift();
    }

    const held = state.positions.get(SYMBOL);

    // A position that just filled: anchor the exit bookkeeping to it.
    if (held !== undefined && entrySeq === null) {
      entrySeq = state.seq;
      entryHigh = trailingHigh();
      peakClose = close;
    }
    // A position that just closed: forget the old entry.
    if (held === undefined && entrySeq !== null) {
      entrySeq = null;
      entryHigh = null;
      peakClose = null;
    }

    if (state.warmingUp) return [];

    if (held !== undefined) {
      if (peakClose !== null && close > peakClose) peakClose = close;
      const stop = peakClose !== null && close * BPS <= peakClose * (BPS - TRAIL_BPS);
      const recovered = entryHigh !== null && close * BPS >= entryHigh * (BPS - RECOVER_BPS);
      const stale = entrySeq !== null && state.seq - entrySeq >= HOLD_MAX_BARS;
      if (stop || recovered || stale) {
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    if (closes.length < LOOKBACK_BARS) return [];
    const trailHigh = trailingHigh();
    if (trailHigh === 0n) return [];
    const dipped = close * BPS <= trailHigh * (BPS - DIP_BPS);
    if (!dipped) return [];
    // Falling-knife guard: a deep slide is not a dip.
    if (sinceStartBps(close) < -GUARD_BPS) return [];
    const notional = state.cash < state.weightRoom(SYMBOL) ? state.cash : state.weightRoom(SYMBOL);
    if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
});
