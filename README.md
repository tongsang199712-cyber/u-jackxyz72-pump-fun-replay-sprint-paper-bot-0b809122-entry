[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/tongsang199712-cyber/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-entry/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/tongsang199712-cyber/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-entry/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

# Surge Rider — Pump.fun Replay Paper Bot

A deterministic paper-trading bot for the [Pump.fun Replay Sprint](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) on make.fun. It trades 10 SOL of paper money on a 24h replay of pump.fun bonding-curve activity.

## Strategy

Most new pump.fun coins die fast, but the ones that catch a real bid keep climbing for a while. Surge Rider waits for a genuine surge — several different wallets buying, net SOL flowing in, price climbing and holding near its recent high — then rides it with a fixed 0.5 SOL stake and a hard exit plan:

- **Entry:** over a 48-slot window, net inflow ≥ 0.4 SOL, ≥ 3 buys from ≥ 3 distinct wallets, buys ≥ 60% of window volume, price up 3–90% and within 3% of the window high, real SOL reserve 1.5–90 SOL, coin at least 240 slots old. One entry per coin, max 5 open positions.
- **Exits:** take profit +40%, stop loss −28%, trailing stop (18% giveback once up 12%), fade exit when sellers take over while under water, hard 1800-slot time limit.
- **Guardrail sweeper:** if round-tripped coins lag the pace of the 24h window, the bot opens tiny 0.03 SOL probe round trips on liquid coins so the entry stays above the 20-coin minimum bar.

Every decision is a pure function of the batch stream — no clock, no randomness — so two runs agree byte for byte.

## Layout

- `main.ts` — the bot (entrypoint, run by the grader as `node /bot/main.ts`)
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` shim, vendored byte-identical

## License

MIT — see [LICENSE](LICENSE).
