# lyra-record

On-chain trade ledger for the Lyra Protocol — a permanent, public record of every trade written to Solana using Anchor/Rust. Immutable, permissionless, open source.

## What it is

`lyra-record` is a Solana smart contract (program) that acts as a permanent, tamper-proof trade journal. Every time the Lyra trading bot completes a trade, it writes the result here. The record lives on-chain forever — anyone can read it, nobody can edit or delete it.

Think of it as a notebook that lives on the blockchain. The bot writes in it. The world reads it.

## Stack

* **Language** — Rust
* **Framework** — Anchor
* **Tests** — TypeScript
* **Package manager** — pnpm
* **Blockchain** — Solana (Devnet → Mainnet)

## What the contract does

The program exposes four instructions:

| Instruction      | Description                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------- |
| `initialize`   | Creates a storage account on-chain tied to your wallet. Call this once before anything else. |
| `record_trade` | Writes a completed trade permanently on-chain. Called by the bot after every trade.          |
| `get_trades`   | Public. Returns the full trade history. No auth required.                                    |
| `get_stats`    | Public. Returns win rate, total return, trade count, and average profit. Auto-calculated.    |

## Data structures

**Trade**

```
entry_price       — price the position was opened at
exit_price        — price the position was closed at
open_timestamp    — when the trade was opened (unix)
close_timestamp   — when the trade was closed (unix)
pair              — trading pair e.g. "SOL/USDC"
pnl               — profit or loss (can be negative)
result            — WIN or LOSS
```

**TradingRecord** (the on-chain account)

```
owner             — wallet address of the account owner
trades            — list of all Trade records
total_trades      — running count
total_wins        — running count
total_losses      — running count
cumulative_pnl    — total profit/loss across all trades
```

## Getting started

### Prerequisites

Install the full toolchain in this order:

```bash
# 1. Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env

# 2. Solana CLI
sh -c "$(curl -sSfL https://release.solana.com/stable/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# 3. Anchor
cargo install --git https://github.com/coral-xyz/anchor avm --locked
avm install latest
avm use latest

# 4. pnpm
npm install -g pnpm
```

### Wallet setup

```bash
solana-keygen new
solana config set --url devnet
solana airdrop 2
solana balance
```

### Clone and install

```bash
git clone https://github.com/lyra-protocol/lyra-record.git
cd lyra-record
pnpm install
```

### Build

```bash
anchor build
```

### Test

```bash
anchor test
```

Tests initialize an account, record three trades, read them back, and verify that stats calculate correctly (2/3 wins = 66% win rate).

### Deploy to devnet

```bash
anchor deploy
```

Save your **Program ID** — you will need it to connect the bot and the dashboard.

## Project structure

```
lyra-record/
├── programs/
│   └── lyra-record/
│       └── src/
│           ├── lib.rs        # four main instructions
│           ├── state.rs      # Trade and TradingRecord structs
│           └── errors.rs     # custom error types
├── tests/
│   └── lyra-record.ts        # TypeScript integration tests
├── Anchor.toml
└── Cargo.toml
```

## Verifying on-chain

After deploying and calling `record_trade`, check your records on the Solana block explorer:

* Devnet — [explorer.solana.com](https://explorer.solana.com/?cluster=devnet)
* Or [Solscan](https://solscan.io/) with devnet selected

Search your Program ID or wallet address to see all recorded trades.

## Part of the Lyra Protocol

`lyra-record` is one piece of a larger open source system:

* `lyra-record` — this repo. on-chain trade ledger.
* `lyra-core` — the trading bot logic (Node.js)
* `lyra-ui` — the dashboard (TypeScript)

## License

MIT
