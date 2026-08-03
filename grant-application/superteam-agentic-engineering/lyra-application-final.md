# Lyra — Superteam Agentic Engineering Grant Application

Generated: April 24, 2026
Grant link: https://superteam.fun/earn/grants/agentic-engineering

## Step 1: Basics

**Project Title**
> Lyra

**One Line Description**
> Lyra is a Solana-first MCP trading terminal that lets Claude execute paper trades within user-defined risk rules and adds verifiable on-chain trade records through Lyra Record.

**TG username**
> t.me/atomdbc

**Wallet Address**
> C3gqihgZbTkVgdtx5SeNoQmk4ZSMu9LgNG5M9CymCs3x

## Step 2: Details

**Project Details**
> Lyra is building the execution layer for AI traders on Solana. Today, AI assistants can analyze markets and generate ideas, but they usually cannot safely execute actions with permissioning, risk controls, and auditable outcomes. Lyra solves that by giving users a trading terminal plus an MCP server that connects to Claude, Cursor, or ChatGPT, so the model can read trading context, suggest actions, and execute within explicit user-defined rules.
>
> The current MVP already has real proof of work: a live terminal, a deployed MCP endpoint, per-user session routing, Privy authentication, Supabase-backed trading state, paper perpetual trading, eight order types, leverage and rule validation, and a working MCP install flow. The project is split across active repos for the UI, MCP server, signal pipeline, and Solana program.
>
> A key Solana-native component is Lyra Record, an on-chain verification layer for trade history and receipts. That makes Lyra more than a trading UI: it becomes an agent-ready execution and proof system where intent, execution, and outcome can be traced clearly on Solana.
>
> I am already using Claude and Codex as my core agentic engineering workflow for this build. This grant will help me accelerate the remaining MVP work — completing market reads, trade suggestions, signal ingestion, and full position lifecycle support — and ship a stronger Frontier-ready product with public proof of work.

**Deadline**
> May 11, 2026

**Proof of Work**
> Live product: https://www.lyrabuild.xyz/terminal
>
> Live MCP endpoint: https://mcp.lyrabuild.xyz/mcp
>
> GitHub profile: https://github.com/atomdbc
>
> Repositories:
> - https://github.com/lyra-protocol/lyra-mcp
> - https://github.com/lyra-protocol/lyra-record
> - https://github.com/lyra-protocol/lyra-signal
> - https://github.com/atomdbc/lyra-ui
>
> Recent shipped work includes a deployed trading MCP, per-user session routing, paper trade execution, terminal UX improvements, signal pipeline iteration, and an Anchor-based on-chain trade ledger. The build history is visible in active commits across the repos, including MCP trading mode, execute_trade support, signal scoring improvements, terminal trading UX, and Lyra Record instruction and test implementation.
>
> I also exported the AI-assisted build transcripts directly from this workspace as `claude-session.jsonl` and `codex-session.jsonl`, which I will attach as part of the application evidence.

**Personal X Profile**
> x.com/theonchaindev

**Personal GitHub Profile**
> github.com/atomdbc

**Colosseum Crowdedness Score**
> I will generate the Lyra crowdedness score in Colosseum Copilot, upload the screenshot to a public Google Drive link, and include that link in the application.

**AI Session Transcript**
> I will attach `claude-session.jsonl` and/or `codex-session.jsonl` from the project root as proof of AI-assisted development.

## Step 3: Milestones

**Goals and Milestones**
> **Milestone 1 — Core trading lifecycle (April 24, 2026 to April 30, 2026)**
> Ship `close_position`, `modify_position`, `get_open_positions`, and `cancel_order`, and complete `read_market` so Claude has stronger context before execution.
>
> **Milestone 2 — Agent decision layer (May 1, 2026 to May 5, 2026)**
> Finish `suggest_trade`, connect the signal pipeline into the trading flow, and surface usable alerts and trade ideas inside Lyra’s MCP and terminal.
>
> **Milestone 3 — Verifiable execution layer (May 6, 2026 to May 9, 2026)**
> Tighten Lyra Record integration so trade outcomes are auditable on Solana and clearly tied to agent-assisted trading actions.
>
> **Milestone 4 — Frontier-ready release (May 10, 2026 to May 11, 2026)**
> Final QA, docs, demo polish, public proof packaging, and complete the Frontier submission with repo and artifact links.

**Primary KPI**
> 25 users connect Lyra’s MCP and complete at least one paper trade by May 11, 2026.

**Final tranche checkbox**
> I understand that to receive the final tranche, I need to submit the Colosseum project link, GitHub repo, and AI coding subscription receipt.

## Google Drive upload checklist

- `lyra-record/grant-application/superteam-agentic-engineering/lyra-application-final.md`
- `claude-session.jsonl`
- `codex-session.jsonl`
- Colosseum crowdedness score screenshot

## Ready links

- Grant page: https://superteam.fun/earn/grants/agentic-engineering
- Live app: https://www.lyrabuild.xyz/terminal
- Live MCP: https://mcp.lyrabuild.xyz/mcp
- GitHub: https://github.com/atomdbc
