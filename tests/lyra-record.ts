import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { assert } from "chai";
import { LyraRecord } from "../target/types/lyra_record";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Null-padded ASCII byte array of fixed length. */
function toFixedBytes(str: string, len: number): number[] {
  const buf = Buffer.alloc(len, 0);
  buf.write(str, "utf8");
  return Array.from(buf);
}

/** Zero-filled byte array. */
function zeroBytes(len: number): number[] {
  return Array.from(Buffer.alloc(len, 0));
}

function tradePda(
  ownerPk: PublicKey,
  tradeIndex: number,
  programId: PublicKey
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("lyra_trade"),
      ownerPk.toBuffer(),
      new anchor.BN(tradeIndex).toArrayLike(Buffer, "le", 8),
    ],
    programId
  );
  return pda;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const PRICE_DECIMALS = 1_000_000;
const SOL_PRICE      = 150 * PRICE_DECIMALS; // $150.00 entry
const SOL_EXIT_WIN   = 165 * PRICE_DECIMALS; // $165.00 exit → win
const SOL_EXIT_LOSS  = 135 * PRICE_DECIMALS; // $135.00 exit → loss
const NOTIONAL       = 1000 * PRICE_DECIMALS; // $1,000 position
const OPEN_TS        = 1_700_000_000;
const CLOSE_TS       = 1_700_003_600;
const PNL_WIN        = 100 * PRICE_DECIMALS;
const PNL_LOSS       = -(80 * PRICE_DECIMALS);

// ─── Suite ──────────────────────────────────────────────────────────────────

describe("lyra-record v2", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.LyraRecord as Program<LyraRecord>;

  // Owner is the test wallet; agent is a fresh keypair (simulates the Lyra agent wallet).
  const owner = provider.wallet;
  const agent = Keypair.generate();
  const agentV2 = Keypair.generate();

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lyra_config"), owner.publicKey.toBuffer()],
    program.programId
  );

  // ── Setup ────────────────────────────────────────────────────────────────

  before("fund agent wallets for rent payments", async () => {
    for (const kp of [agent, agentV2]) {
      const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }
  });

  // ── initialize_config ────────────────────────────────────────────────────

  describe("initialize_config", () => {
    it("creates AgentConfig with correct initial state", async () => {
      await program.methods
        .initializeConfig(agent.publicKey, 1)
        .accounts({ owner: owner.publicKey })
        .rpc();

      const config = await program.account.agentConfig.fetch(configPda);
      assert.isTrue(config.owner.equals(owner.publicKey));
      assert.isTrue(config.agent.equals(agent.publicKey));
      assert.equal(config.agentVersion, 1);
      assert.isTrue(config.isActive);
      assert.equal(config.tradeCount.toNumber(), 0);
      assert.equal(config.totalClosed, 0);
      assert.equal(config.totalWins, 0);
      assert.equal(config.totalLosses, 0);
      assert.equal(config.totalBreakeven, 0);
      assert.equal(config.cumulativePnl.toNumber(), 0);
    });

    it("rejects a second initialization for the same owner", async () => {
      try {
        await program.methods
          .initializeConfig(agent.publicKey, 1)
          .accounts({ owner: owner.publicKey })
          .rpc();
        assert.fail("Should have thrown");
      } catch (e: any) {
        // Anchor rejects init on an already-existing PDA
        assert.ok(e);
      }
    });
  });

  // ── open_trade ───────────────────────────────────────────────────────────

  describe("open_trade", () => {
    it("agent opens trade 0 — counter increments, status is Open", async () => {
      await program.methods
        .openTrade(
          toFixedBytes("SOL/USDC", 16),
          { long: {} },
          new anchor.BN(SOL_PRICE),
          new anchor.BN(NOTIONAL),
          5,
          new anchor.BN(OPEN_TS),
          toFixedBytes("strat_v1", 8),
          toFixedBytes("tradingview:WHALE", 32),
          zeroBytes(32) // arweave_hash not yet stored
        )
        .accounts({
          config: configPda,
          tradeRecord: tradePda(owner.publicKey, 0, program.programId),
          owner: owner.publicKey,
          agent: agent.publicKey,
        })
        .signers([agent])
        .rpc();

      const config = await program.account.agentConfig.fetch(configPda);
      assert.equal(config.tradeCount.toNumber(), 1);
      assert.equal(config.totalClosed, 0); // not closed yet

      const trade = await program.account.tradeRecord.fetch(
        tradePda(owner.publicKey, 0, program.programId)
      );
      assert.isTrue(trade.owner.equals(owner.publicKey));
      assert.isTrue(trade.agent.equals(agent.publicKey));
      assert.equal(trade.agentVersion, 1);
      assert.equal(trade.tradeIndex.toNumber(), 0);
      assert.deepEqual(trade.direction, { long: {} });
      assert.equal(trade.entryPrice.toNumber(), SOL_PRICE);
      assert.equal(trade.exitPrice.toNumber(), 0);
      assert.equal(trade.leverage, 5);
      assert.deepEqual(trade.status, { open: {} });
      assert.deepEqual(trade.outcome, { pending: {} });
    });

    it("rejects open_trade from wrong agent", async () => {
      const imposter = Keypair.generate();
      const sig = await provider.connection.requestAirdrop(
        imposter.publicKey,
        LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);

      try {
        await program.methods
          .openTrade(
            toFixedBytes("BTC/USDC", 16),
            { long: {} },
            new anchor.BN(50_000 * PRICE_DECIMALS),
            new anchor.BN(NOTIONAL),
            1,
            new anchor.BN(OPEN_TS),
            zeroBytes(8),
            zeroBytes(32),
            zeroBytes(32)
          )
          .accounts({
            config: configPda,
            tradeRecord: tradePda(owner.publicKey, 1, program.programId),
            owner: owner.publicKey,
            agent: imposter.publicKey,
          })
          .signers([imposter])
          .rpc();
        assert.fail("Should have thrown UnauthorizedAgent");
      } catch (e: any) {
        assert.include(e.toString(), "UnauthorizedAgent");
      }
    });

    it("rejects open_trade with leverage > 40", async () => {
      try {
        await program.methods
          .openTrade(
            toFixedBytes("SOL/USDC", 16),
            { short: {} },
            new anchor.BN(SOL_PRICE),
            new anchor.BN(NOTIONAL),
            41, // over the MAX_LEVERAGE cap
            new anchor.BN(OPEN_TS),
            zeroBytes(8),
            zeroBytes(32),
            zeroBytes(32)
          )
          .accounts({
            config: configPda,
            tradeRecord: tradePda(owner.publicKey, 1, program.programId),
            owner: owner.publicKey,
            agent: agent.publicKey,
          })
          .signers([agent])
          .rpc();
        assert.fail("Should have thrown InvalidLeverage");
      } catch (e: any) {
        assert.include(e.toString(), "InvalidLeverage");
      }
    });
  });

  // ── close_trade ──────────────────────────────────────────────────────────

  describe("close_trade", () => {
    it("agent closes trade 0 as a Win — stats update correctly", async () => {
      const arweaveHash = Array.from(Buffer.alloc(32).fill(0xab));

      await program.methods
        .closeTrade(
          new anchor.BN(0),           // trade_index
          new anchor.BN(SOL_EXIT_WIN),
          new anchor.BN(CLOSE_TS),
          new anchor.BN(PNL_WIN),
          { win: {} },
          { closed: {} },
          arweaveHash
        )
        .accounts({
          config: configPda,
          tradeRecord: tradePda(owner.publicKey, 0, program.programId),
          owner: owner.publicKey,
          agent: agent.publicKey,
        })
        .signers([agent])
        .rpc();

      const config = await program.account.agentConfig.fetch(configPda);
      assert.equal(config.totalClosed, 1);
      assert.equal(config.totalWins, 1);
      assert.equal(config.totalLosses, 0);
      assert.equal(config.cumulativePnl.toNumber(), PNL_WIN);

      const trade = await program.account.tradeRecord.fetch(
        tradePda(owner.publicKey, 0, program.programId)
      );
      assert.deepEqual(trade.status, { closed: {} });
      assert.deepEqual(trade.outcome, { win: {} });
      assert.equal(trade.exitPrice.toNumber(), SOL_EXIT_WIN);
      assert.equal(trade.pnl.toNumber(), PNL_WIN);
      assert.deepEqual(trade.arweaveHash, arweaveHash);
    });

    it("rejects closing an already-closed trade — immutability enforced", async () => {
      try {
        await program.methods
          .closeTrade(
            new anchor.BN(0),
            new anchor.BN(SOL_EXIT_WIN),
            new anchor.BN(CLOSE_TS),
            new anchor.BN(PNL_WIN),
            { win: {} },
            { closed: {} },
            zeroBytes(32)
          )
          .accounts({
            config: configPda,
            tradeRecord: tradePda(owner.publicKey, 0, program.programId),
            owner: owner.publicKey,
            agent: agent.publicKey,
          })
          .signers([agent])
          .rpc();
        assert.fail("Should have thrown TradeAlreadyClosed");
      } catch (e: any) {
        assert.include(e.toString(), "TradeAlreadyClosed");
      }
    });

    it("rejects close_trade with outcome = Pending", async () => {
      // Open a fresh trade first.
      await program.methods
        .openTrade(
          toFixedBytes("SOL/USDC", 16),
          { short: {} },
          new anchor.BN(SOL_PRICE),
          new anchor.BN(NOTIONAL),
          1,
          new anchor.BN(OPEN_TS),
          zeroBytes(8),
          zeroBytes(32),
          zeroBytes(32)
        )
        .accounts({
          config: configPda,
          tradeRecord: tradePda(owner.publicKey, 1, program.programId),
          owner: owner.publicKey,
          agent: agent.publicKey,
        })
        .signers([agent])
        .rpc();

      try {
        await program.methods
          .closeTrade(
            new anchor.BN(1),
            new anchor.BN(SOL_EXIT_LOSS),
            new anchor.BN(CLOSE_TS),
            new anchor.BN(PNL_LOSS),
            { pending: {} }, // invalid
            { closed: {} },
            zeroBytes(32)
          )
          .accounts({
            config: configPda,
            tradeRecord: tradePda(owner.publicKey, 1, program.programId),
            owner: owner.publicKey,
            agent: agent.publicKey,
          })
          .signers([agent])
          .rpc();
        assert.fail("Should have thrown InvalidOutcome");
      } catch (e: any) {
        assert.include(e.toString(), "InvalidOutcome");
      }
    });
  });

  // ── record_completed_trade ───────────────────────────────────────────────

  describe("record_completed_trade", () => {
    it("records a completed loss trade — stats accumulate correctly", async () => {
      // trade index 1 is still Open from prior test; use trade index 2
      const configBefore = await program.account.agentConfig.fetch(configPda);
      const nextIndex = configBefore.tradeCount.toNumber();

      await program.methods
        .recordCompletedTrade(
          toFixedBytes("BTC/USDC", 16),
          { short: {} },
          new anchor.BN(60_000 * PRICE_DECIMALS),
          new anchor.BN(58_000 * PRICE_DECIMALS),
          new anchor.BN(5000 * PRICE_DECIMALS),
          3,
          new anchor.BN(OPEN_TS),
          new anchor.BN(CLOSE_TS),
          new anchor.BN(-(200 * PRICE_DECIMALS)),
          { loss: {} },
          toFixedBytes("strat_v1", 8),
          toFixedBytes("claude:v1.0", 32),
          zeroBytes(32)
        )
        .accounts({
          config: configPda,
          tradeRecord: tradePda(owner.publicKey, nextIndex, program.programId),
          owner: owner.publicKey,
          agent: agent.publicKey,
        })
        .signers([agent])
        .rpc();

      const config = await program.account.agentConfig.fetch(configPda);
      assert.equal(config.totalLosses, 1);
      assert.equal(
        config.cumulativePnl.toNumber(),
        PNL_WIN + (-(200 * PRICE_DECIMALS))
      );

      const trade = await program.account.tradeRecord.fetch(
        tradePda(owner.publicKey, nextIndex, program.programId)
      );
      assert.deepEqual(trade.status, { closed: {} });
      assert.deepEqual(trade.outcome, { loss: {} });
      assert.deepEqual(trade.direction, { short: {} });
    });
  });

  // ── revoke_agent / update_agent ──────────────────────────────────────────

  describe("revoke_agent and update_agent", () => {
    it("owner revokes agent — subsequent open_trade is rejected", async () => {
      await program.methods
        .revokeAgent()
        .accounts({ config: configPda, owner: owner.publicKey })
        .rpc();

      const config = await program.account.agentConfig.fetch(configPda);
      assert.isFalse(config.isActive);

      const nextIndex = config.tradeCount.toNumber();

      try {
        await program.methods
          .openTrade(
            toFixedBytes("SOL/USDC", 16),
            { long: {} },
            new anchor.BN(SOL_PRICE),
            new anchor.BN(NOTIONAL),
            1,
            new anchor.BN(OPEN_TS),
            zeroBytes(8),
            zeroBytes(32),
            zeroBytes(32)
          )
          .accounts({
            config: configPda,
            tradeRecord: tradePda(owner.publicKey, nextIndex, program.programId),
            owner: owner.publicKey,
            agent: agent.publicKey,
          })
          .signers([agent])
          .rpc();
        assert.fail("Should have thrown AgentRevoked");
      } catch (e: any) {
        assert.include(e.toString(), "AgentRevoked");
      }
    });

    it("owner updates to agentV2 — agentV2 can write, original agent cannot", async () => {
      await program.methods
        .updateAgent(agentV2.publicKey, 2)
        .accounts({ config: configPda, owner: owner.publicKey })
        .rpc();

      const config = await program.account.agentConfig.fetch(configPda);
      assert.isTrue(config.agent.equals(agentV2.publicKey));
      assert.equal(config.agentVersion, 2);
      assert.isTrue(config.isActive);

      const nextIndex = config.tradeCount.toNumber();

      // agentV2 can open
      await program.methods
        .openTrade(
          toFixedBytes("SOL/USDC", 16),
          { long: {} },
          new anchor.BN(SOL_PRICE),
          new anchor.BN(NOTIONAL),
          1,
          new anchor.BN(OPEN_TS),
          zeroBytes(8),
          zeroBytes(32),
          zeroBytes(32)
        )
        .accounts({
          config: configPda,
          tradeRecord: tradePda(owner.publicKey, nextIndex, program.programId),
          owner: owner.publicKey,
          agent: agentV2.publicKey,
        })
        .signers([agentV2])
        .rpc();

      // original agent is rejected
      const nextIndexAfter = nextIndex + 1;
      try {
        await program.methods
          .openTrade(
            toFixedBytes("SOL/USDC", 16),
            { long: {} },
            new anchor.BN(SOL_PRICE),
            new anchor.BN(NOTIONAL),
            1,
            new anchor.BN(OPEN_TS),
            zeroBytes(8),
            zeroBytes(32),
            zeroBytes(32)
          )
          .accounts({
            config: configPda,
            tradeRecord: tradePda(owner.publicKey, nextIndexAfter, program.programId),
            owner: owner.publicKey,
            agent: agent.publicKey,
          })
          .signers([agent])
          .rpc();
        assert.fail("Old agent should be rejected");
      } catch (e: any) {
        assert.include(e.toString(), "UnauthorizedAgent");
      }

      // Verify the new trade carries agentVersion = 2
      const trade = await program.account.tradeRecord.fetch(
        tradePda(owner.publicKey, nextIndex, program.programId)
      );
      assert.equal(trade.agentVersion, 2);
    });
  });
});
