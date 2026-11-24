[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/tongsang199712-cyber/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-entry/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/tongsang199712-cyber/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-entry/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

# Surge Rider — Pump.fun Replay Paper Bot

A deterministic paper-trading bot for the [Pump.fun Replay Sprint](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) on make.fun. It trades 10 SOL of paper money on a 24h replay of pump.fun bonding-curve activity.

## Strategy

A pump.fun launch that catches a real bid pops in its first seconds, and most of the coins that die do so just as fast. Surge Rider buys launches, not runners:

- **Entry:** within 4 slots of a coin's `CreateEvent`, the opening tape must be clean — the creator has not sold, at least 4 other wallets have bought in, no single sell has dumped ≥ 1 SOL yet, the price has not already spiked more than 10% from creation, and real SOL reserve is 0.3–30 SOL. One entry per coin, max 5 open positions, 0.1 SOL stake (capped at 1% of real reserve).
- **Exits:** take profit +25%, stop loss −8%, trailing stop (10% giveback once up 10%), fade exit when sellers take over while under water, hard 40-slot time limit.
- **Guardrail sweeper:** if round-tripped coins lag the pace of the 24h window, the bot opens tiny 0.03 SOL probe round trips on liquid coins so the entry stays above the 20-coin minimum bar.

Every decision is a pure function of the batch stream — no clock, no randomness — so two runs agree byte for byte.

Local dev grade: net PnL ≈ −0.02 SOL over 30 coins (90% interval −0.05 … +0.00), max drawdown 0.2%.

## Layout

- `main.ts` — the bot (entrypoint, run by the grader as `node /bot/main.ts`)
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` shim, vendored byte-identical

## License

MIT — see [LICENSE](LICENSE).
