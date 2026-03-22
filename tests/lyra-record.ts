import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { LyraRecord } from "../target/types/lyra_record";
import { assert } from "chai";

describe("lyra-record", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.LyraRecord as Program<LyraRecord>;
  const owner = provider.wallet;

  // derive the PDA the same way the contract does
  const [tradingRecordPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("lyra"), owner.publicKey.toBuffer()],
    program.programId
  );

  const toNumber = (value: number | anchor.BN): number =>
    value instanceof anchor.BN ? value.toNumber() : value;

  const fetchTradingRecord = async () =>
    program.account.tradingRecord.fetch(tradingRecordPda);

  const expectedWinRate = (wins: number, totalTrades: number): number => {
    if (totalTrades === 0) return 0;
    return Math.floor((wins / totalTrades) * 100);
  };

  it("initialize: creates trading record account", async () => {
    try {
      await fetchTradingRecord();
    } catch {
      await program.methods
        .initialize()
        .accounts({
          owner: owner.publicKey,
        })
        .rpc();
    }

    const account = await fetchTradingRecord();

    assert.isTrue(account.owner.equals(owner.publicKey));
    assert.isTrue(account.isInitialized);
  });

  it("record_trade: appends trade and updates stats", async () => {
    const before = await fetchTradingRecord();

    await program.methods
      .recordTrade(
        new anchor.BN(100),
        new anchor.BN(120),
        new anchor.BN(1_700_000_000),
        new anchor.BN(1_700_003_600),
        "SOL/USDC",
        new anchor.BN(20),
        { win: {} }
      )
      .accounts({
        owner: owner.publicKey,
      })
      .rpc();

    const account = await fetchTradingRecord();
    const trade = account.trades[account.trades.length - 1];

    assert.equal(
      toNumber(account.totalTrades),
      toNumber(before.totalTrades) + 1
    );
    assert.equal(toNumber(account.totalWins), toNumber(before.totalWins) + 1);
    assert.equal(toNumber(account.totalLosses), toNumber(before.totalLosses));
    assert.equal(
      toNumber(account.totalBreakeven),
      toNumber(before.totalBreakeven)
    );
    assert.equal(
      toNumber(account.cumulativePnl),
      toNumber(before.cumulativePnl) + 20
    );

    assert.equal(toNumber(trade.entryPrice), 100);
    assert.equal(toNumber(trade.exitPrice), 120);
    assert.equal(toNumber(trade.openTimestamp), 1_700_000_000);
    assert.equal(toNumber(trade.closeTimestamp), 1_700_003_600);
    assert.equal(trade.pair, "SOL/USDC");
    assert.equal(toNumber(trade.pnl), 20);
    assert.deepEqual(trade.result, { win: {} });
  });

  it("get_stats: returns computed summary", async () => {
    const account = await fetchTradingRecord();
    const stats = await program.methods
      .getStats()
      .accounts({
        owner: owner.publicKey,
      })
      .view();

    const totalTrades = toNumber(account.totalTrades);
    const totalWins = toNumber(account.totalWins);
    const totalLosses = toNumber(account.totalLosses);
    const totalBreakeven = toNumber(account.totalBreakeven);
    const cumulativePnl = toNumber(account.cumulativePnl);
    const averagePnl = totalTrades > 0 ? Math.trunc(cumulativePnl / totalTrades) : 0;

    assert.equal(toNumber(stats.totalTrades), totalTrades);
    assert.equal(toNumber(stats.totalWins), totalWins);
    assert.equal(toNumber(stats.totalLosses), totalLosses);
    assert.equal(toNumber(stats.totalBreakeven), totalBreakeven);
    assert.equal(toNumber(stats.cumulativePnl), cumulativePnl);
    assert.equal(toNumber(stats.winRate), expectedWinRate(totalWins, totalTrades));
    assert.equal(toNumber(stats.averagePnl), averagePnl);
  });
});
