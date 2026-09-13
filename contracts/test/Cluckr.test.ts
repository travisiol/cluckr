import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { Cluckr, MockToken } from "../typechain-types";

const CELLS = 25;
const BPS = 10_000n;
const ONE = ethers.parseEther("1");
const BONEYARD = "0x000000000000000000000000000000000000dEaD";

const PARAMS = {
  edgeBps: 200,
  burnBps: 100,
  maxPayoutBps: 500,
  revealTimeout: 600,
  idleTimeout: 3600,
  minBet: ONE,
  maxBet: ethers.parseEther("1000000"),
};

/** The reference ladder: bet × (1 − edge) × C(25, n) / C(25 − k, n), exact integers. */
function refPayout(bet: bigint, bones: number, n: number, edgeBps = PARAMS.edgeBps): bigint {
  let num = bet * (BPS - BigInt(edgeBps));
  let den = BPS;
  for (let i = 0; i < n; i++) {
    num *= BigInt(CELLS - i);
    den *= BigInt(CELLS - bones - i);
  }
  return num / den;
}

/** A hash chain: seeds[0] is revealed first; tip = H(seeds[0]); H(seeds[i+1]) = seeds[i]. */
function makeChain(length = 25): { tip: string; seeds: string[] } {
  const seeds: string[] = new Array(length);
  seeds[length - 1] = ethers.hexlify(ethers.randomBytes(32));
  for (let i = length - 2; i >= 0; i--) seeds[i] = ethers.keccak256(seeds[i + 1]);
  return { tip: ethers.keccak256(seeds[0]), seeds };
}

/** Mirrors Cluckr.roll and the bone test. */
function isBone(cluckr: string, id: bigint, seed: string, nonce: string, cell: number, level: number, bones: number): boolean {
  const roll = BigInt(
    ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "bytes32", "uint8", "uint256", "address"], [seed, nonce, cell, id, cluckr]),
    ),
  );
  return roll % BigInt(CELLS - level) < BigInt(bones);
}

/** Finds a nonce that makes the next lift a chicken (or a bone). */
function nonceFor(cluckr: string, id: bigint, seed: string, cell: number, level: number, bones: number, wantBone: boolean): string {
  for (let i = 0; i < 100_000; i++) {
    const nonce = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    if (isBone(cluckr, id, seed, nonce, cell, level, bones) === wantBone) return nonce;
  }
  throw new Error("no nonce found");
}

describe("Cluckr", () => {
  async function deploy() {
    const [owner, house, alice, bob, operator, stranger] = await ethers.getSigners();
    const token = (await (await ethers.getContractFactory("MockToken")).deploy("Cluck", "CLUCK")) as unknown as MockToken;
    const cluckr = (await (await ethers.getContractFactory("Cluckr")).deploy(await token.getAddress(), house.address, owner.address, PARAMS)) as unknown as Cluckr;
    const cluckrAddress = await cluckr.getAddress();
    for (const s of [owner, alice, bob]) {
      await token.mint(s.address, ethers.parseEther("10000000"));
      await token.connect(s).approve(cluckrAddress, ethers.MaxUint256);
    }
    await cluckr.fund(ethers.parseEther("1000000"));
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const domain = { name: "Cluckr", version: "1", chainId, verifyingContract: cluckrAddress };
    const types = { Commit: [{ name: "tip", type: "bytes32" }, { name: "player", type: "address" }, { name: "expiry", type: "uint256" }] };

    async function commit(player: HardhatEthersSigner, signer: HardhatEthersSigner = house, expiry?: number) {
      const chain = makeChain();
      const exp = expiry ?? (await time.latest()) + 600;
      const signature = await signer.signTypedData(domain, types, { tip: chain.tip, player: player.address, expiry: exp });
      return { ...chain, expiry: exp, signature };
    }

    async function start(player: HardhatEthersSigner, amount: bigint, bones: number, opts: { operator?: string; value?: bigint; commitFor?: HardhatEthersSigner } = {}) {
      const c = await commit(opts.commitFor ?? player);
      const tx = await cluckr.connect(player).startRound(amount, bones, c.tip, c.expiry, c.signature, opts.operator ?? ethers.ZeroAddress, { value: opts.value ?? 0n });
      await tx.wait();
      const id = await cluckr.roundOf(player.address);
      return { id, ...c };
    }

    return { owner, house, alice, bob, operator, stranger, token, cluckr, cluckrAddress, commit, start, domain, types };
  }

  describe("deployment", () => {
    it("records the token, the house and the params", async () => {
      const { cluckr, token, house } = await loadFixture(deploy);
      expect(await cluckr.token()).to.equal(await token.getAddress());
      expect(await cluckr.house()).to.equal(house.address);
      const p = await cluckr.params();
      expect(p.edgeBps).to.equal(200n);
      expect(p.burnBps).to.equal(100n);
      expect(p.maxPayoutBps).to.equal(500n);
      expect(await cluckr.freeBankroll()).to.equal(ethers.parseEther("1000000"));
      expect(await cluckr.maxWin()).to.equal(ethers.parseEther("50000"));
    });

    it("rejects a zero token or house and out-of-range params", async () => {
      const { token, house, owner } = await loadFixture(deploy);
      const F = await ethers.getContractFactory("Cluckr");
      await expect(F.deploy(ethers.ZeroAddress, house.address, owner.address, PARAMS)).to.be.revertedWith("Cluckr: token is zero");
      await expect(F.deploy(await token.getAddress(), ethers.ZeroAddress, owner.address, PARAMS)).to.be.revertedWith("Cluckr: house is zero");
      await expect(F.deploy(await token.getAddress(), house.address, owner.address, { ...PARAMS, edgeBps: 1001 })).to.be.revertedWith("Cluckr: edge above 10%");
      await expect(F.deploy(await token.getAddress(), house.address, owner.address, { ...PARAMS, maxPayoutBps: 0 })).to.be.revertedWith("Cluckr: max payout out of range");
      await expect(F.deploy(await token.getAddress(), house.address, owner.address, { ...PARAMS, revealTimeout: 60 })).to.be.revertedWith("Cluckr: reveal timeout out of range");
      await expect(F.deploy(await token.getAddress(), house.address, owner.address, { ...PARAMS, minBet: 0 })).to.be.revertedWith("Cluckr: bet bounds");
    });
  });

  describe("the ladder", () => {
    it("matches bet × (1 − edge) × C(25, n) / C(25 − k, n) for every bones and level", async () => {
      const { cluckr } = await loadFixture(deploy);
      const bet = ethers.parseEther("100");
      for (let bones = 1; bones <= 24; bones++) {
        const rungs = await cluckr.ladder(bet, bones);
        expect(rungs.length).to.equal(CELLS - bones);
        for (let n = 1; n <= CELLS - bones; n++) {
          const expected = refPayout(bet, bones, n);
          expect(await cluckr.payoutAt(bet, bones, n)).to.equal(expected);
          expect(rungs[n - 1]).to.equal(expected);
        }
      }
    });

    it("has the numbers a player expects", async () => {
      const { cluckr } = await loadFixture(deploy);
      const bet = ethers.parseEther("100");
      // 3 bones: 25/22 × 0.98 = 1.1136…
      expect(await cluckr.payoutAt(bet, 3, 1)).to.equal(111363636363636363636n);
      // 24 bones, one lift: 25 × 0.98 = ×24.5
      expect(await cluckr.payoutAt(bet, 24, 1)).to.equal(ethers.parseEther("2450"));
      // 1 bone, all 24 lifts: also ×24.5 (only one layout survives)
      expect(await cluckr.payoutAt(bet, 1, 24)).to.equal(ethers.parseEther("2450"));
      // 5 bones, 5 lifts: 53130/15504 × 0.98 = 3.358…
      expect(await cluckr.payoutAt(bet, 5, 5)).to.equal(refPayout(bet, 5, 5));
      expect(refPayout(bet, 5, 5) / 10n ** 16n).to.equal(33583n);
      expect(await cluckr.payoutAt(bet, 3, 0)).to.equal(ethers.parseEther("98"));
    });

    it("refuses impossible levels", async () => {
      const { cluckr } = await loadFixture(deploy);
      await expect(cluckr.payoutAt(ONE, 3, 23)).to.be.revertedWith("Cluckr: level out of range");
      await expect(cluckr.payoutAt(ONE, 0, 1)).to.be.revertedWith("Cluckr: bones out of range");
      await expect(cluckr.payoutAt(ONE, 25, 1)).to.be.revertedWith("Cluckr: bones out of range");
    });
  });

  describe("starting a round", () => {
    it("burns the slice, stakes the rest, reserves the ceiling and records the tip", async () => {
      const { cluckr, token, alice, start, cluckrAddress } = await loadFixture(deploy);
      const amount = ethers.parseEther("100");
      const before = await token.balanceOf(cluckrAddress);
      const { id, tip } = await start(alice, amount, 3);
      expect(id).to.equal(1n);
      const r = await cluckr.rounds(id);
      expect(r.player).to.equal(alice.address);
      expect(r.bones).to.equal(3n);
      expect(r.level).to.equal(0n);
      expect(r.status).to.equal(1n); // Live
      expect(r.bet).to.equal(ethers.parseEther("99"));
      expect(r.tip).to.equal(tip);
      expect(r.commit).to.equal(tip);
      expect(await token.balanceOf(BONEYARD)).to.equal(ethers.parseEther("1"));
      expect(await token.balanceOf(cluckrAddress)).to.equal(before + ethers.parseEther("99"));
      // Ceiling for 3 bones = ×(0.98 × 2300) is far above the 5 % cap → reserve = bet + 5 % of the free coop.
      const free = before;
      const cap = ethers.parseEther("99") + (free * 500n) / BPS;
      expect(r.reserved).to.equal(cap);
      expect(await cluckr.reserved()).to.equal(cap);
      expect(await cluckr.usedTip(tip)).to.equal(true);
      expect(await cluckr.totalBurned()).to.equal(ethers.parseEther("1"));
      expect(await cluckr.totalWagered()).to.equal(ethers.parseEther("99"));
      expect(await cluckr.roundsPlayed()).to.equal(1n);
    });

    it("reserves the ladder's top rung when that is below the cap", async () => {
      const { cluckr, alice, start } = await loadFixture(deploy);
      const { id } = await start(alice, ethers.parseEther("10"), 24);
      const r = await cluckr.rounds(id);
      // 24 bones: one lift, ×24.5 of a 9.9 stake = 242.55, well under 5 % of a million.
      expect(r.reserved).to.equal(refPayout(ethers.parseEther("9.9"), 24, 1));
      const [bet, reserved] = await cluckr.previewReserve(ethers.parseEther("10"), 24);
      expect(bet).to.equal(ethers.parseEther("9.9"));
      expect(reserved).to.equal(r.reserved);
    });

    it("forwards gas money to the operator", async () => {
      const { alice, operator, start } = await loadFixture(deploy);
      const before = await ethers.provider.getBalance(operator.address);
      await start(alice, ethers.parseEther("10"), 3, { operator: operator.address, value: ethers.parseEther("0.001") });
      expect(await ethers.provider.getBalance(operator.address)).to.equal(before + ethers.parseEther("0.001"));
    });

    it("refuses gas money without an operator", async () => {
      const { cluckr, alice, commit } = await loadFixture(deploy);
      const c = await commit(alice);
      await expect(cluckr.connect(alice).startRound(ONE, 3, c.tip, c.expiry, c.signature, ethers.ZeroAddress, { value: 1n })).to.be.revertedWith("Cluckr: gas money needs an operator");
    });

    it("checks the house signature, the player it was issued to, its expiry and its reuse", async () => {
      const { cluckr, alice, bob, stranger, commit, start } = await loadFixture(deploy);
      const forged = await commit(alice, stranger);
      await expect(cluckr.connect(alice).startRound(ONE, 3, forged.tip, forged.expiry, forged.signature, ethers.ZeroAddress)).to.be.revertedWith("Cluckr: bad house signature");
      const bobs = await commit(bob);
      await expect(cluckr.connect(alice).startRound(ONE, 3, bobs.tip, bobs.expiry, bobs.signature, ethers.ZeroAddress)).to.be.revertedWith("Cluckr: bad house signature");
      const stale = await commit(alice, undefined, (await time.latest()) - 1);
      await expect(cluckr.connect(alice).startRound(ONE, 3, stale.tip, stale.expiry, stale.signature, ethers.ZeroAddress)).to.be.revertedWith("Cluckr: commitment expired");
      const used = await start(alice, ONE, 3);
      await expect(cluckr.connect(alice).startRound(ONE, 3, used.tip, used.expiry, used.signature, ethers.ZeroAddress)).to.be.revertedWith("Cluckr: a round is already live");
      await cluckr.connect(alice).pick(used.id, 0, ethers.ZeroHash, ethers.ZeroHash);
      await cluckr.reveal(used.id, used.seeds[0]);
      const after = await cluckr.rounds(used.id);
      if (after.status === 1n) await cluckr.connect(alice).cashout(used.id, ethers.ZeroHash);
      await expect(cluckr.connect(alice).startRound(ONE, 3, used.tip, used.expiry, used.signature, ethers.ZeroAddress)).to.be.revertedWith("Cluckr: commitment already used");
    });

    it("enforces the bet bounds, the bones range and the pause", async () => {
      const { cluckr, alice, commit } = await loadFixture(deploy);
      const c = await commit(alice);
      await expect(cluckr.connect(alice).startRound(ONE - 1n, 3, c.tip, c.expiry, c.signature, ethers.ZeroAddress)).to.be.revertedWith("Cluckr: below minimum bet");
      await expect(cluckr.connect(alice).startRound(PARAMS.maxBet + 1n, 3, c.tip, c.expiry, c.signature, ethers.ZeroAddress)).to.be.revertedWith("Cluckr: above maximum bet");
      await expect(cluckr.connect(alice).startRound(ONE, 0, c.tip, c.expiry, c.signature, ethers.ZeroAddress)).to.be.revertedWith("Cluckr: bones out of range");
      await expect(cluckr.connect(alice).startRound(ONE, 25, c.tip, c.expiry, c.signature, ethers.ZeroAddress)).to.be.revertedWith("Cluckr: bones out of range");
      await cluckr.setPaused(true);
      await expect(cluckr.connect(alice).startRound(ONE, 3, c.tip, c.expiry, c.signature, ethers.ZeroAddress)).to.be.revertedWith("Cluckr: paused");
    });

    it("refuses a bet the coop cannot cover at the first rung", async () => {
      const { cluckr, owner, alice, commit } = await loadFixture(deploy);
      // Drain the coop to 10 tokens: 5 % of it (0.5) cannot cover the first rung of a 100-token bet with 24 bones.
      await cluckr.withdraw(owner.address, (await cluckr.freeBankroll()) - ethers.parseEther("10"));
      const c = await commit(alice);
      await expect(cluckr.connect(alice).startRound(ethers.parseEther("100"), 24, c.tip, c.expiry, c.signature, ethers.ZeroAddress)).to.be.revertedWith("Cluckr: coop too small for this bet");
    });
  });

  describe("lifting cloches", () => {
    it("a chicken advances the level, the mask and the commitment", async () => {
      const { cluckr, alice, start, cluckrAddress } = await loadFixture(deploy);
      const { id, seeds } = await start(alice, ethers.parseEther("100"), 3);
      const nonce = nonceFor(cluckrAddress, id, seeds[0], 7, 0, 3, false);
      await expect(cluckr.connect(alice).pick(id, 7, nonce, ethers.ZeroHash)).to.emit(cluckr, "Picked").withArgs(id, 0, 7, nonce);
      let r = await cluckr.rounds(id);
      expect(r.pending).to.equal(true);
      expect(r.pendingCell).to.equal(7n);
      await expect(cluckr.reveal(id, seeds[0])).to.emit(cluckr, "Chicken").withArgs(id, 1, 7, seeds[0]);
      r = await cluckr.rounds(id);
      expect(r.pending).to.equal(false);
      expect(r.level).to.equal(1n);
      expect(r.revealedMask).to.equal(1n << 7n);
      expect(r.commit).to.equal(seeds[0]);
      expect(r.status).to.equal(1n);
    });

    it("a bone busts the round: the stake stays, the reserve is freed", async () => {
      const { cluckr, token, alice, start, cluckrAddress } = await loadFixture(deploy);
      const { id, seeds } = await start(alice, ethers.parseEther("100"), 3);
      const before = await token.balanceOf(alice.address);
      const nonce = nonceFor(cluckrAddress, id, seeds[0], 12, 0, 3, true);
      await cluckr.connect(alice).pick(id, 12, nonce, ethers.ZeroHash);
      await expect(cluckr.reveal(id, seeds[0])).to.emit(cluckr, "Busted").withArgs(id, 0, 12, seeds[0], ethers.parseEther("99"));
      const r = await cluckr.rounds(id);
      expect(r.status).to.equal(3n); // Busted
      expect(r.boneCell).to.equal(12n);
      expect(r.payout).to.equal(0n);
      expect(await cluckr.reserved()).to.equal(0n);
      expect(await cluckr.roundOf(alice.address)).to.equal(0n);
      expect(await cluckr.roundsBusted()).to.equal(1n);
      expect(await token.balanceOf(alice.address)).to.equal(before);
      expect(await cluckr.freeBankroll()).to.equal(ethers.parseEther("1000099"));
    });

    it("rejects a seed that does not match the commitment", async () => {
      const { cluckr, alice, start } = await loadFixture(deploy);
      const { id, seeds } = await start(alice, ethers.parseEther("100"), 3);
      await cluckr.connect(alice).pick(id, 0, ethers.ZeroHash, ethers.ZeroHash);
      await expect(cluckr.reveal(id, seeds[1])).to.be.revertedWith("Cluckr: seed does not match commitment");
      await expect(cluckr.reveal(id, ethers.ZeroHash)).to.be.revertedWith("Cluckr: seed does not match commitment");
      await expect(cluckr.reveal(id, seeds[0])).not.to.be.reverted;
      expect((await cluckr.rounds(id)).pending).to.equal(false);
    });

    it("the next lift can carry the previous seed", async () => {
      const { cluckr, alice, start, cluckrAddress } = await loadFixture(deploy);
      const { id, seeds } = await start(alice, ethers.parseEther("100"), 3);
      const n0 = nonceFor(cluckrAddress, id, seeds[0], 0, 0, 3, false);
      await cluckr.connect(alice).pick(id, 0, n0, ethers.ZeroHash);
      await expect(cluckr.connect(alice).pick(id, 1, ethers.ZeroHash, ethers.ZeroHash)).to.be.revertedWith("Cluckr: previous lift unsettled");
      const n1 = nonceFor(cluckrAddress, id, seeds[1], 1, 1, 3, false);
      await expect(cluckr.connect(alice).pick(id, 1, n1, seeds[0])).to.emit(cluckr, "Chicken").withArgs(id, 1, 0, seeds[0]).and.to.emit(cluckr, "Picked").withArgs(id, 1, 1, n1);
      await expect(cluckr.reveal(id, seeds[1])).to.emit(cluckr, "Chicken").withArgs(id, 2, 1, seeds[1]);
      expect((await cluckr.rounds(id)).level).to.equal(2n);
    });

    it("a lift carrying a seed that busts is dropped, not recorded", async () => {
      const { cluckr, alice, start, cluckrAddress } = await loadFixture(deploy);
      const { id, seeds } = await start(alice, ethers.parseEther("100"), 3);
      const n0 = nonceFor(cluckrAddress, id, seeds[0], 0, 0, 3, true);
      await cluckr.connect(alice).pick(id, 0, n0, ethers.ZeroHash);
      await expect(cluckr.connect(alice).pick(id, 1, ethers.ZeroHash, seeds[0])).to.emit(cluckr, "Busted").and.not.to.emit(cluckr, "Picked");
      expect((await cluckr.rounds(id)).status).to.equal(3n);
    });

    it("refuses a cloche already lifted, an unknown cloche and a stranger", async () => {
      const { cluckr, alice, stranger, start, cluckrAddress } = await loadFixture(deploy);
      const { id, seeds } = await start(alice, ethers.parseEther("100"), 3);
      const n0 = nonceFor(cluckrAddress, id, seeds[0], 4, 0, 3, false);
      await cluckr.connect(alice).pick(id, 4, n0, ethers.ZeroHash);
      await cluckr.reveal(id, seeds[0]);
      await expect(cluckr.connect(alice).pick(id, 4, ethers.ZeroHash, ethers.ZeroHash)).to.be.revertedWith("Cluckr: already lifted");
      await expect(cluckr.connect(alice).pick(id, 25, ethers.ZeroHash, ethers.ZeroHash)).to.be.revertedWith("Cluckr: no such cloche");
      await expect(cluckr.connect(stranger).pick(id, 5, ethers.ZeroHash, ethers.ZeroHash)).to.be.revertedWith("Cluckr: not your round");
      await expect(cluckr.reveal(id, seeds[1])).to.be.revertedWith("Cluckr: nothing to reveal");
      await expect(cluckr.connect(alice).pick(99, 5, ethers.ZeroHash, ethers.ZeroHash)).to.be.revertedWith("Cluckr: round is not live");
    });

    it("the operator may lift and cash out; the payout still goes to the player", async () => {
      const { cluckr, token, alice, operator, start, cluckrAddress } = await loadFixture(deploy);
      const { id, seeds } = await start(alice, ethers.parseEther("100"), 3, { operator: operator.address });
      const n0 = nonceFor(cluckrAddress, id, seeds[0], 2, 0, 3, false);
      await cluckr.connect(operator).pick(id, 2, n0, ethers.ZeroHash);
      const before = await token.balanceOf(alice.address);
      await cluckr.connect(operator).cashout(id, seeds[0]);
      expect(await token.balanceOf(alice.address)).to.equal(before + refPayout(ethers.parseEther("99"), 3, 1));
      expect(await token.balanceOf(operator.address)).to.equal(0n);
    });

    it("the last cloche pays out on its own", async () => {
      const { cluckr, token, alice, start, cluckrAddress } = await loadFixture(deploy);
      const { id, seeds } = await start(alice, ethers.parseEther("10"), 24);
      const n0 = nonceFor(cluckrAddress, id, seeds[0], 0, 0, 24, false);
      await cluckr.connect(alice).pick(id, 0, n0, ethers.ZeroHash);
      const before = await token.balanceOf(alice.address);
      await expect(cluckr.reveal(id, seeds[0])).to.emit(cluckr, "CashedOut").withArgs(id, alice.address, 1, refPayout(ethers.parseEther("9.9"), 24, 1), false);
      expect(await token.balanceOf(alice.address)).to.equal(before + refPayout(ethers.parseEther("9.9"), 24, 1));
      expect((await cluckr.rounds(id)).status).to.equal(2n);
      await expect(cluckr.connect(alice).pick(id, 1, ethers.ZeroHash, ethers.ZeroHash)).to.be.revertedWith("Cluckr: round is not live");
    });

    it("refuses to lift past the last chicken", async () => {
      const { cluckr, alice, start, cluckrAddress } = await loadFixture(deploy);
      const { id, seeds } = await start(alice, ethers.parseEther("10"), 23);
      // 2 safe lifts possible. Take one, then the other via pick-with-seed, which pays out; a third is refused.
      const n0 = nonceFor(cluckrAddress, id, seeds[0], 0, 0, 23, false);
      await cluckr.connect(alice).pick(id, 0, n0, ethers.ZeroHash);
      await cluckr.reveal(id, seeds[0]);
      const n1 = nonceFor(cluckrAddress, id, seeds[1], 1, 1, 23, false);
      await cluckr.connect(alice).pick(id, 1, n1, ethers.ZeroHash);
      await expect(cluckr.connect(alice).pick(id, 2, ethers.ZeroHash, seeds[1])).to.emit(cluckr, "CashedOut");
    });
  });

  describe("cashing out", () => {
    it("needs at least one lift", async () => {
      const { cluckr, alice, start } = await loadFixture(deploy);
      const { id } = await start(alice, ethers.parseEther("100"), 3);
      await expect(cluckr.connect(alice).cashout(id, ethers.ZeroHash)).to.be.revertedWith("Cluckr: lift at least one cloche first");
    });

    it("pays the ladder at the current level and frees the reserve", async () => {
      const { cluckr, token, alice, start, cluckrAddress } = await loadFixture(deploy);
      const { id, seeds } = await start(alice, ethers.parseEther("100"), 5);
      const cells = [3, 8, 13, 18, 22];
      for (let i = 0; i < cells.length; i++) {
        const nonce = nonceFor(cluckrAddress, id, seeds[i], cells[i], i, 5, false);
        await cluckr.connect(alice).pick(id, cells[i], nonce, i === 0 ? ethers.ZeroHash : seeds[i - 1]);
      }
      const before = await token.balanceOf(alice.address);
      const expected = refPayout(ethers.parseEther("99"), 5, 5);
      await expect(cluckr.connect(alice).cashout(id, seeds[4])).to.emit(cluckr, "CashedOut").withArgs(id, alice.address, 5, expected, false);
      expect(await token.balanceOf(alice.address)).to.equal(before + expected);
      expect(await cluckr.reserved()).to.equal(0n);
      expect(await cluckr.roundOf(alice.address)).to.equal(0n);
      expect(await cluckr.totalPaid()).to.equal(expected);
      const r = await cluckr.rounds(id);
      expect(r.status).to.equal(2n);
      expect(r.payout).to.equal(expected);
    });

    it("never pays more than the round reserved", async () => {
      const { cluckr, token, owner, alice, start, cluckrAddress } = await loadFixture(deploy);
      // A small coop: 1,000 tokens free → cap = bet + 50.
      await cluckr.withdraw(owner.address, (await cluckr.freeBankroll()) - ethers.parseEther("1000"));
      const { id, seeds } = await start(alice, ethers.parseEther("100"), 3);
      const r0 = await cluckr.rounds(id);
      expect(r0.reserved).to.equal(ethers.parseEther("149"));
      const cells = [0, 1, 2, 3, 4, 5];
      for (let i = 0; i < cells.length; i++) {
        const nonce = nonceFor(cluckrAddress, id, seeds[i], cells[i], i, 3, false);
        await cluckr.connect(alice).pick(id, cells[i], nonce, i === 0 ? ethers.ZeroHash : seeds[i - 1]);
      }
      expect(refPayout(ethers.parseEther("99"), 3, 6)).to.be.greaterThan(ethers.parseEther("149"));
      const before = await token.balanceOf(alice.address);
      await cluckr.connect(alice).cashout(id, seeds[5]);
      expect(await token.balanceOf(alice.address)).to.equal(before + ethers.parseEther("149"));
    });

    it("a cash-out whose settling seed busts pays nothing", async () => {
      const { cluckr, token, alice, start, cluckrAddress } = await loadFixture(deploy);
      const { id, seeds } = await start(alice, ethers.parseEther("100"), 3);
      const n0 = nonceFor(cluckrAddress, id, seeds[0], 0, 0, 3, false);
      await cluckr.connect(alice).pick(id, 0, n0, ethers.ZeroHash);
      await cluckr.reveal(id, seeds[0]);
      const n1 = nonceFor(cluckrAddress, id, seeds[1], 1, 1, 3, true);
      await cluckr.connect(alice).pick(id, 1, n1, ethers.ZeroHash);
      const before = await token.balanceOf(alice.address);
      await expect(cluckr.connect(alice).cashout(id, seeds[1])).to.emit(cluckr, "Busted").and.not.to.emit(cluckr, "CashedOut");
      expect(await token.balanceOf(alice.address)).to.equal(before);
      await expect(cluckr.connect(alice).cashout(id, ethers.ZeroHash)).to.be.revertedWith("Cluckr: round is not live");
    });
  });

  describe("when the house goes quiet", () => {
    it("the player may force a cash-out after the reveal timeout, paid as if the lift were a chicken", async () => {
      const { cluckr, token, alice, start, cluckrAddress } = await loadFixture(deploy);
      const { id, seeds } = await start(alice, ethers.parseEther("100"), 3);
      const n0 = nonceFor(cluckrAddress, id, seeds[0], 0, 0, 3, false);
      await cluckr.connect(alice).pick(id, 0, n0, ethers.ZeroHash);
      await cluckr.reveal(id, seeds[0]);
      // The second lift would have been a bone — the house stays silent anyway and pays for it.
      const n1 = nonceFor(cluckrAddress, id, seeds[1], 1, 1, 3, true);
      await cluckr.connect(alice).pick(id, 1, n1, ethers.ZeroHash);
      await expect(cluckr.connect(alice).forceCashout(id)).to.be.revertedWith("Cluckr: the house still has time");
      await time.increase(PARAMS.revealTimeout);
      const before = await token.balanceOf(alice.address);
      const expected = refPayout(ethers.parseEther("99"), 3, 2);
      await expect(cluckr.connect(alice).forceCashout(id)).to.emit(cluckr, "CashedOut").withArgs(id, alice.address, 2, expected, true);
      expect(await token.balanceOf(alice.address)).to.equal(before + expected);
      const r = await cluckr.rounds(id);
      expect(r.revealedMask).to.equal(0b11n);
      expect(r.status).to.equal(2n);
    });

    it("only the player or the operator may force", async () => {
      const { cluckr, alice, stranger, start } = await loadFixture(deploy);
      const { id } = await start(alice, ethers.parseEther("100"), 3);
      await cluckr.connect(alice).pick(id, 0, ethers.ZeroHash, ethers.ZeroHash);
      await time.increase(PARAMS.revealTimeout);
      await expect(cluckr.connect(stranger).forceCashout(id)).to.be.revertedWith("Cluckr: not your round");
      await expect(cluckr.connect(alice).cashout(id, ethers.ZeroHash)).to.be.revertedWith("Cluckr: previous lift unsettled");
    });

    it("nothing pending: forcing is refused", async () => {
      const { cluckr, alice, start } = await loadFixture(deploy);
      const { id } = await start(alice, ethers.parseEther("100"), 3);
      await expect(cluckr.connect(alice).forceCashout(id)).to.be.revertedWith("Cluckr: nothing pending");
    });
  });

  describe("when the player goes quiet", () => {
    it("anyone may close an idle round at its standing", async () => {
      const { cluckr, token, alice, stranger, start, cluckrAddress } = await loadFixture(deploy);
      const { id, seeds } = await start(alice, ethers.parseEther("100"), 3);
      const n0 = nonceFor(cluckrAddress, id, seeds[0], 0, 0, 3, false);
      await cluckr.connect(alice).pick(id, 0, n0, ethers.ZeroHash);
      await cluckr.reveal(id, seeds[0]);
      await expect(cluckr.connect(stranger).expire(id)).to.be.revertedWith("Cluckr: not idle yet");
      await time.increase(PARAMS.idleTimeout);
      const before = await token.balanceOf(alice.address);
      const expected = refPayout(ethers.parseEther("99"), 3, 1);
      await expect(cluckr.connect(stranger).expire(id)).to.emit(cluckr, "Expired").withArgs(id, alice.address, 1, expected);
      expect(await token.balanceOf(alice.address)).to.equal(before + expected);
      expect((await cluckr.rounds(id)).status).to.equal(4n);
      expect(await cluckr.reserved()).to.equal(0n);
    });

    it("an idle round with nothing lifted gets its stake back", async () => {
      const { cluckr, token, alice, stranger, start } = await loadFixture(deploy);
      const { id } = await start(alice, ethers.parseEther("100"), 3);
      await time.increase(PARAMS.idleTimeout);
      const before = await token.balanceOf(alice.address);
      await cluckr.connect(stranger).expire(id);
      expect(await token.balanceOf(alice.address)).to.equal(before + ethers.parseEther("99"));
    });

    it("an idle round with an unrevealed lift waits for both timeouts, then counts the lift as a chicken", async () => {
      const { cluckr, token, alice, stranger, start } = await loadFixture(deploy);
      const { id } = await start(alice, ethers.parseEther("100"), 3);
      await cluckr.connect(alice).pick(id, 0, ethers.ZeroHash, ethers.ZeroHash);
      await time.increase(PARAMS.idleTimeout);
      await expect(cluckr.connect(stranger).expire(id)).to.be.revertedWith("Cluckr: not idle yet");
      await time.increase(PARAMS.revealTimeout);
      const before = await token.balanceOf(alice.address);
      await expect(cluckr.connect(stranger).expire(id)).to.emit(cluckr, "Expired").withArgs(id, alice.address, 1, refPayout(ethers.parseEther("99"), 3, 1));
      expect(await token.balanceOf(alice.address)).to.equal(before + refPayout(ethers.parseEther("99"), 3, 1));
    });
  });

  describe("the coop", () => {
    it("anyone may fund it; the owner may only withdraw what no live round could win", async () => {
      const { cluckr, token, owner, alice, bob, start } = await loadFixture(deploy);
      await expect(cluckr.connect(bob).fund(ethers.parseEther("1000"))).to.emit(cluckr, "Funded").withArgs(bob.address, ethers.parseEther("1000"));
      expect(await cluckr.freeBankroll()).to.equal(ethers.parseEther("1001000"));
      await start(alice, ethers.parseEther("100"), 3);
      const free = await cluckr.freeBankroll();
      const reserved = await cluckr.reserved();
      expect(free + reserved).to.equal(await token.balanceOf(await cluckr.getAddress()));
      await expect(cluckr.withdraw(owner.address, free + 1n)).to.be.revertedWith("Cluckr: reserved for live rounds");
      await expect(cluckr.connect(alice).withdraw(alice.address, 1n)).to.be.revertedWithCustomError(cluckr, "OwnableUnauthorizedAccount");
      const before = await token.balanceOf(owner.address);
      await cluckr.withdraw(owner.address, free);
      expect(await token.balanceOf(owner.address)).to.equal(before + free);
      expect(await cluckr.freeBankroll()).to.equal(0n);
    });

    it("counts only what a taxed token actually delivers", async () => {
      const [owner, house, alice, , , sink] = await ethers.getSigners();
      const taxed = await (await ethers.getContractFactory("TaxedToken")).deploy(500, sink.address);
      const cluckr = (await (await ethers.getContractFactory("Cluckr")).deploy(await taxed.getAddress(), house.address, owner.address, PARAMS)) as unknown as Cluckr;
      const cluckrAddress = await cluckr.getAddress();
      await taxed.mint(owner.address, ethers.parseEther("1000000"));
      await taxed.mint(alice.address, ethers.parseEther("1000"));
      await taxed.approve(cluckrAddress, ethers.MaxUint256);
      await taxed.connect(alice).approve(cluckrAddress, ethers.MaxUint256);
      await cluckr.fund(ethers.parseEther("100000"));
      expect(await cluckr.freeBankroll()).to.equal(ethers.parseEther("95000"));

      const chainId = (await ethers.provider.getNetwork()).chainId;
      const chain = makeChain();
      const expiry = (await time.latest()) + 600;
      const signature = await house.signTypedData(
        { name: "Cluckr", version: "1", chainId, verifyingContract: cluckrAddress },
        { Commit: [{ name: "tip", type: "bytes32" }, { name: "player", type: "address" }, { name: "expiry", type: "uint256" }] },
        { tip: chain.tip, player: alice.address, expiry },
      );
      await cluckr.connect(alice).startRound(ethers.parseEther("100"), 3, chain.tip, expiry, signature, ethers.ZeroAddress);
      const r = await cluckr.rounds(1);
      // 100 sent, 95 arrived, 1 % of that burned (0.95, of which the boneyard gets 95 %), 94.05 staked.
      expect(r.bet).to.equal(ethers.parseEther("94.05"));
      expect(await taxed.balanceOf(BONEYARD)).to.equal(ethers.parseEther("0.9025"));
      const balance = await taxed.balanceOf(cluckrAddress);
      expect(balance).to.equal(ethers.parseEther("95000") + ethers.parseEther("94.05"));
      expect(balance).to.be.gte(await cluckr.reserved());
    });

    it("stays solvent across a long random session", async () => {
      const { cluckr, token, alice, bob, start, cluckrAddress } = await loadFixture(deploy);
      // Shrink the coop so the caps actually bite.
      const [owner] = await ethers.getSigners();
      await cluckr.withdraw(owner.address, (await cluckr.freeBankroll()) - ethers.parseEther("5000"));
      let seed = 7;
      const rand = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      for (let round = 0; round < 24; round++) {
        const player = round % 2 === 0 ? alice : bob;
        const bones = 1 + Math.floor(rand() * 24);
        let amount = ethers.parseEther(String(1 + Math.floor(rand() * 50)));
        // A bet whose first rung the coop cannot cover is refused; a smaller one is not.
        const firstRung = refPayout((amount * 99n) / 100n, bones, 1);
        if (firstRung > (amount * 99n) / 100n + (await cluckr.maxWin())) {
          await expect(start(player, amount, bones)).to.be.revertedWith("Cluckr: coop too small for this bet");
          amount = ONE;
        }
        const { id, seeds } = await start(player, amount, bones);
        let level = 0;
        let prev = ethers.ZeroHash;
        let alive = true;
        while (alive && level < CELLS - bones) {
          const cell = level; // cells are interchangeable; lift them in order
          const nonce = ethers.hexlify(ethers.randomBytes(32));
          await cluckr.connect(player).pick(id, cell, nonce, prev);
          if ((await cluckr.rounds(id)).status !== 1n) break;
          await cluckr.reveal(id, seeds[level]);
          const r = await cluckr.rounds(id);
          if (r.status !== 1n) {
            alive = false;
            break;
          }
          level += 1;
          prev = seeds[level - 1];
          if (rand() < 0.35) {
            await cluckr.connect(player).cashout(id, ethers.ZeroHash);
            alive = false;
          }
        }
        const balance = await token.balanceOf(cluckrAddress);
        expect(balance).to.be.gte(await cluckr.reserved());
        expect(await cluckr.roundOf(player.address)).to.equal(0n);
      }
      expect(await cluckr.reserved()).to.equal(0n);
      expect(await cluckr.roundsPlayed()).to.equal(24n);
    });
  });

  describe("the roll", () => {
    it("busts at bones / remaining, near enough, over many seeds", async () => {
      const { cluckr, cluckrAddress } = await loadFixture(deploy);
      const bones = 5;
      const level = 10; // 15 cloches left, 5 bones → a third of lifts bust
      let busts = 0;
      const N = 1500;
      for (let i = 0; i < N; i++) {
        const seed = ethers.keccak256(ethers.toBeHex(i, 32));
        const nonce = ethers.keccak256(ethers.toBeHex(i + 1_000_000, 32));
        if (isBone(cluckrAddress, 1n, seed, nonce, 3, level, bones)) busts += 1;
      }
      // Sample the contract's own roll on a few to prove the mirror is exact.
      for (let i = 0; i < 20; i++) {
        const seed = ethers.keccak256(ethers.toBeHex(i, 32));
        const nonce = ethers.keccak256(ethers.toBeHex(i + 1_000_000, 32));
        const onChain = (await cluckr.roll(1, seed, nonce, 3)) % BigInt(CELLS - level) < BigInt(bones);
        expect(onChain).to.equal(isBone(cluckrAddress, 1n, seed, nonce, 3, level, bones));
      }
      const p = busts / N;
      expect(p).to.be.greaterThan(0.28).and.lessThan(0.39);
    });
  });

  describe("ownership", () => {
    it("rotates the house key, changes params within bounds, pauses", async () => {
      const { cluckr, alice, stranger } = await loadFixture(deploy);
      await expect(cluckr.setHouse(stranger.address)).to.emit(cluckr, "HouseChanged");
      expect(await cluckr.house()).to.equal(stranger.address);
      await expect(cluckr.setHouse(ethers.ZeroAddress)).to.be.revertedWith("Cluckr: house is zero");
      await expect(cluckr.setParams({ ...PARAMS, burnBps: 1001 })).to.be.revertedWith("Cluckr: burn above 10%");
      await expect(cluckr.setParams({ ...PARAMS, idleTimeout: 60 })).to.be.revertedWith("Cluckr: idle timeout out of range");
      await expect(cluckr.setParams({ ...PARAMS, maxBet: 10n ** 37n })).to.be.revertedWith("Cluckr: max bet too large");
      await cluckr.setParams({ ...PARAMS, edgeBps: 100 });
      expect((await cluckr.params()).edgeBps).to.equal(100n);
      expect(await cluckr.payoutAt(ethers.parseEther("100"), 24, 1)).to.equal(ethers.parseEther("2475"));
      await expect(cluckr.connect(alice).setPaused(true)).to.be.revertedWithCustomError(cluckr, "OwnableUnauthorizedAccount");
      await cluckr.transferOwnership(alice.address);
      expect(await cluckr.owner()).to.not.equal(alice.address);
      await cluckr.connect(alice).acceptOwnership();
      expect(await cluckr.owner()).to.equal(alice.address);
    });
  });
});
