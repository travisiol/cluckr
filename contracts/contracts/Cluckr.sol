// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Cluckr — 25 cloches, some hide a bone.
/// @notice Bet the token, choose how many bones are on the table (1–24), lift
///         cloches one at a time. Every roast chicken multiplies the bet; the
///         first bone kills the round. Cash out whenever you like. The coop
///         (this contract's token balance) is the house: it pays the winners
///         and keeps the losers' bets. A slice of every bet goes to the
///         boneyard (0x…dEaD) and never comes back.
///
/// @dev  Fairness, in one paragraph. Before a round, the house hands the
///       player a signed `tip`: the top of a hash chain
///       `tip = H(s1)`, `s1 = H(s2)`, … `s24 = H(s25)` whose seeds only the
///       house knows. Every lift is a pick recorded on chain with a nonce the
///       player chooses; it is settled by revealing the next seed, which the
///       contract checks against the current commitment (`H(seed) == commit`)
///       before rolling `keccak(seed, nonce, cell, id)` against
///       `bones / remainingCells`. The house committed to every seed before
///       the first lift and cannot know the nonce; the player cannot know the
///       seed. Neither side can steer the roll. The house's only move is to
///       stay silent — and silence pays the player as if the lift were a
///       chicken (`forceCashout`), so it never pays to stay silent.
///
///       The multiplier after n safe lifts with k bones is
///       `(1 - edge) × C(25, n) / C(25 - k, n)` — exactly the odds of
///       drawing n chickens in a row without replacement, minus the house
///       edge. The pick-by-pick roll `bones / remaining` produces the same
///       distribution as a hidden layout drawn up front.
///
///       Trust, stated plainly: the owner can withdraw whatever is not
///       reserved for live rounds, rotate the house key and change the
///       parameters. Reserved money — the most every live round could win —
///       is untouchable until the round ends. Reverts are strings on
///       purpose: the client shows them verbatim.
contract Cluckr is Ownable2Step, EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ───────────────────────────── constants ─────────────────────────────

    uint8 public constant CELLS = 25;
    uint8 public constant MIN_BONES = 1;
    uint8 public constant MAX_BONES = 24;
    uint256 public constant BPS = 10_000;
    /// @notice Where the burned slice of every bet goes.
    address public constant BONEYARD = 0x000000000000000000000000000000000000dEaD;
    /// @notice EIP-712 type hash of the house's commitment to a hash chain.
    bytes32 public constant COMMIT_TYPEHASH = keccak256("Commit(bytes32 tip,address player,uint256 expiry)");

    // ─────────────────────────────── types ───────────────────────────────

    enum Status {
        None,
        Live,
        Cashed,
        Busted,
        Expired
    }

    struct Params {
        /// @dev House edge taken out of every multiplier, in bps (200 = 2 %).
        uint16 edgeBps;
        /// @dev Slice of every bet sent to the boneyard, in bps (100 = 1 %).
        uint16 burnBps;
        /// @dev Most a single round may win from the free coop, in bps of it.
        uint16 maxPayoutBps;
        /// @dev Seconds the house has to reveal a lift before the player may force a cash-out.
        uint32 revealTimeout;
        /// @dev Seconds of silence after which anyone may close a round at its standing.
        uint32 idleTimeout;
        /// @dev Smallest and largest bet accepted, in token wei, before the burn.
        uint256 minBet;
        uint256 maxBet;
    }

    struct Round {
        address player;
        /// @dev Session key allowed to lift and cash out for the player. Payouts always go to the player.
        address operator;
        uint40 startedAt;
        uint40 lastActionAt;
        uint40 pendingAt;
        uint8 bones;
        /// @dev Safe lifts so far.
        uint8 level;
        uint8 pendingCell;
        bool pending;
        Status status;
        /// @dev Bit i set when cell i has been lifted and was a chicken.
        uint32 revealedMask;
        /// @dev Cell where the bone was found. Only meaningful when Busted.
        uint8 boneCell;
        /// @dev Net stake after the burn.
        uint256 bet;
        /// @dev Most this round can pay, set aside from the coop until it ends.
        uint256 reserved;
        /// @dev Top of the house's hash chain, as signed.
        bytes32 tip;
        /// @dev Current commitment: the hash of the next seed the house must reveal.
        bytes32 commit;
        bytes32 pendingNonce;
        /// @dev What the round paid the player in the end (0 when busted).
        uint256 payout;
    }

    // ──────────────────────────────── state ──────────────────────────────

    /// @notice The token played with. One token, fixed at deployment.
    IERC20 public immutable token;
    /// @notice The house key: signs hash-chain commitments.
    address public house;
    /// @notice While true, no new round can start. Live rounds always finish.
    bool public paused;
    Params public params;

    uint256 public nextRoundId = 1;
    mapping(uint256 id => Round) internal _rounds;
    /// @notice The player's live round id, 0 when none.
    mapping(address player => uint256 id) public roundOf;
    /// @notice A signed tip is good for one round only.
    mapping(bytes32 tip => bool used) public usedTip;

    /// @notice Sum of every live round's `reserved`. The coop can never be drawn below it.
    uint256 public reserved;
    uint256 public totalWagered;
    uint256 public totalPaid;
    uint256 public totalBurned;
    uint256 public roundsPlayed;
    uint256 public roundsBusted;

    // ─────────────────────────────── events ──────────────────────────────

    event Funded(address indexed from, uint256 amount);
    event RoundStarted(
        uint256 indexed id,
        address indexed player,
        address operator,
        uint256 bet,
        uint8 bones,
        bytes32 tip,
        uint256 reserved,
        uint256 burned
    );
    event Picked(uint256 indexed id, uint8 level, uint8 cell, bytes32 nonce);
    /// @param level The new level, after this safe lift.
    event Chicken(uint256 indexed id, uint8 level, uint8 cell, bytes32 seed);
    event Busted(uint256 indexed id, uint8 level, uint8 cell, bytes32 seed, uint256 lost);
    event CashedOut(uint256 indexed id, address indexed player, uint8 level, uint256 payout, bool forced);
    event Expired(uint256 indexed id, address indexed player, uint8 level, uint256 payout);
    event HouseChanged(address indexed previousHouse, address indexed newHouse);
    event ParamsChanged(Params params);
    event PausedSet(bool paused);
    event Withdrawn(address indexed to, uint256 amount);

    // ───────────────────────────── constructor ───────────────────────────

    /// @param token_ The ERC-20 the table is played with.
    /// @param house_ The house key that signs commitments.
    /// @param initialOwner Owns the contract: funds, withdraws the free coop, rotates the house key.
    constructor(IERC20 token_, address house_, address initialOwner, Params memory params_)
        Ownable(initialOwner)
        EIP712("Cluckr", "1")
    {
        require(address(token_) != address(0), "Cluckr: token is zero");
        require(house_ != address(0), "Cluckr: house is zero");
        token = token_;
        house = house_;
        _setParams(params_);
        emit HouseChanged(address(0), house_);
    }

    // ─────────────────────────────── the coop ────────────────────────────

    /// @notice Adds to the coop. Anyone can; nothing funded is ever owed back.
    function fund(uint256 amount) external nonReentrant returns (uint256 received) {
        require(amount > 0, "Cluckr: amount is zero");
        received = _pull(amount);
        emit Funded(msg.sender, received);
    }

    /// @notice Token in the coop that no live round has a claim on.
    function freeBankroll() public view returns (uint256) {
        uint256 balance = token.balanceOf(address(this));
        return balance > reserved ? balance - reserved : 0;
    }

    /// @notice Most a single new round may win right now.
    function maxWin() public view returns (uint256) {
        return (freeBankroll() * params.maxPayoutBps) / BPS;
    }

    // ─────────────────────────────── a round ─────────────────────────────

    /// @notice Puts `amount` on the table and opens a round with `bones` bones
    ///         among the 25 cloches.
    /// @dev Approve this contract first. Credited by balance difference so a
    ///      token with a transfer tax cannot make the coop promise more than
    ///      it holds. `tip`, `expiry` and `signature` come from the house
    ///      (`POST /commit`). `operator` is an optional session key allowed
    ///      to lift and cash out for you; any ETH sent along is forwarded to
    ///      it as gas money so the lifts need no wallet prompt.
    function startRound(
        uint256 amount,
        uint8 bones,
        bytes32 tip,
        uint256 expiry,
        bytes calldata signature,
        address operator
    ) external payable nonReentrant returns (uint256 id) {
        _checkStart(amount, bones, tip, expiry, signature, operator);
        usedTip[tip] = true;
        (uint256 bet, uint256 burned) = _stake(amount);
        id = _open(bet, bones, tip, operator, burned);
        if (msg.value > 0) {
            (bool ok, ) = operator.call{value: msg.value}("");
            require(ok, "Cluckr: gas money refused");
        }
    }

    function _checkStart(
        uint256 amount,
        uint8 bones,
        bytes32 tip,
        uint256 expiry,
        bytes calldata signature,
        address operator
    ) internal view {
        require(!paused, "Cluckr: paused");
        require(roundOf[msg.sender] == 0, "Cluckr: a round is already live");
        require(bones >= MIN_BONES && bones <= MAX_BONES, "Cluckr: bones out of range");
        require(amount >= params.minBet, "Cluckr: below minimum bet");
        require(amount <= params.maxBet, "Cluckr: above maximum bet");
        require(block.timestamp <= expiry, "Cluckr: commitment expired");
        require(!usedTip[tip], "Cluckr: commitment already used");
        require(ECDSA.recover(commitDigest(tip, msg.sender, expiry), signature) == house, "Cluckr: bad house signature");
        require(msg.value == 0 || operator != address(0), "Cluckr: gas money needs an operator");
    }

    /// @dev Pulls the stake and sends the burned slice to the boneyard.
    function _stake(uint256 amount) internal returns (uint256 bet, uint256 burned) {
        uint256 received = _pull(amount);
        burned = (received * params.burnBps) / BPS;
        bet = received - burned;
        require(bet > 0, "Cluckr: bet is zero");
        totalBurned += burned;
        if (burned > 0) token.safeTransfer(BONEYARD, burned);
    }

    /// @dev Reserves the most the round can win and records it.
    function _open(uint256 bet, uint8 bones, bytes32 tip, address operator, uint256 burned) internal returns (uint256 id) {
        // What the house can afford to lose on this round: a slice of the
        // coop that is neither reserved nor this very bet.
        uint256 free = token.balanceOf(address(this)) - reserved - bet;
        uint256 cap = bet + (free * params.maxPayoutBps) / BPS;
        uint256 ceiling = payoutAt(bet, bones, CELLS - bones);
        uint256 reservedForRound = ceiling < cap ? ceiling : cap;
        require(reservedForRound >= payoutAt(bet, bones, 1), "Cluckr: coop too small for this bet");

        id = nextRoundId++;
        Round storage r = _rounds[id];
        r.player = msg.sender;
        r.operator = operator;
        r.startedAt = uint40(block.timestamp);
        r.lastActionAt = uint40(block.timestamp);
        r.bones = bones;
        r.status = Status.Live;
        r.bet = bet;
        r.reserved = reservedForRound;
        r.tip = tip;
        r.commit = tip;
        roundOf[msg.sender] = id;

        reserved += reservedForRound;
        totalWagered += bet;
        roundsPlayed += 1;
        emit RoundStarted(id, msg.sender, operator, bet, bones, tip, reservedForRound, burned);
    }

    /// @notice Lifts cloche `cell`. If the previous lift is still unsettled,
    ///         `prevSeed` settles it first (a bone there ends the round and
    ///         this lift is dropped).
    /// @param nonce Anything the player likes; it goes into the roll so the house cannot know the outcome before the lift.
    function pick(uint256 id, uint8 cell, bytes32 nonce, bytes32 prevSeed) external nonReentrant {
        Round storage r = _live(id);
        _auth(r);
        if (r.pending) {
            require(prevSeed != bytes32(0), "Cluckr: previous lift unsettled");
            if (!_reveal(id, r, prevSeed)) return;
            if (r.status != Status.Live) return; // every cloche lifted: paid out
        }
        require(cell < CELLS, "Cluckr: no such cloche");
        require(r.revealedMask & (uint32(1) << cell) == 0, "Cluckr: already lifted");
        require(r.level < CELLS - r.bones, "Cluckr: nothing left to lift");

        r.pending = true;
        r.pendingCell = cell;
        r.pendingNonce = nonce;
        r.pendingAt = uint40(block.timestamp);
        r.lastActionAt = uint40(block.timestamp);
        emit Picked(id, r.level, cell, nonce);
    }

    /// @notice Settles the pending lift of round `id` with the house's next
    ///         seed. Anyone may call it; the house does for rounds whose
    ///         player never comes back.
    function reveal(uint256 id, bytes32 seed) external nonReentrant {
        Round storage r = _live(id);
        require(r.pending, "Cluckr: nothing to reveal");
        _reveal(id, r, seed);
    }

    /// @notice Takes the money at the current level. Settles a pending lift
    ///         first when `prevSeed` is given.
    function cashout(uint256 id, bytes32 prevSeed) external nonReentrant {
        Round storage r = _live(id);
        _auth(r);
        if (r.pending) {
            require(prevSeed != bytes32(0), "Cluckr: previous lift unsettled");
            if (!_reveal(id, r, prevSeed)) return;
            if (r.status != Status.Live) return;
        }
        require(r.level > 0, "Cluckr: lift at least one cloche first");
        _finish(id, r, Status.Cashed, payoutAt(r.bet, r.bones, r.level), false);
    }

    /// @notice The house went silent on a lift for longer than
    ///         `revealTimeout`: the lift counts as a chicken and the round is
    ///         paid at the next level.
    function forceCashout(uint256 id) external nonReentrant {
        Round storage r = _live(id);
        _auth(r);
        require(r.pending, "Cluckr: nothing pending");
        require(block.timestamp >= uint256(r.pendingAt) + params.revealTimeout, "Cluckr: the house still has time");
        _grantPending(r);
        _finish(id, r, Status.Cashed, payoutAt(r.bet, r.bones, r.level), true);
    }

    /// @notice Closes a round nobody has touched for `idleTimeout`, paying
    ///         its standing to the player (the bet back if nothing was
    ///         lifted). A lift the house never revealed counts as a chicken
    ///         once `revealTimeout` has passed on top. Anyone may call it.
    function expire(uint256 id) external nonReentrant {
        Round storage r = _live(id);
        uint256 since = r.pending ? uint256(r.pendingAt) + params.revealTimeout : uint256(r.lastActionAt);
        require(block.timestamp >= since + params.idleTimeout, "Cluckr: not idle yet");
        if (r.pending) _grantPending(r);
        uint256 payout = r.level == 0 ? r.bet : payoutAt(r.bet, r.bones, r.level);
        _finish(id, r, Status.Expired, payout, false);
    }

    // ─────────────────────────────── views ───────────────────────────────

    function rounds(uint256 id) external view returns (Round memory) {
        return _rounds[id];
    }

    /// @notice Payout after `n` safe lifts of a `bet` with `bones` bones:
    ///         `bet × (1 − edge) × C(25, n) / C(25 − bones, n)`.
    function payoutAt(uint256 bet, uint8 bones, uint8 n) public view returns (uint256) {
        require(bones >= MIN_BONES && bones <= MAX_BONES, "Cluckr: bones out of range");
        require(n <= CELLS - bones, "Cluckr: level out of range");
        uint256 num = bet * (BPS - params.edgeBps);
        uint256 den = BPS;
        for (uint256 i = 0; i < n; i++) {
            num *= CELLS - i;
            den *= CELLS - bones - i;
        }
        return num / den;
    }

    /// @notice Every rung of the ladder for a `bet` with `bones` bones, level 1 first.
    function ladder(uint256 bet, uint8 bones) external view returns (uint256[] memory rungs) {
        require(bones >= MIN_BONES && bones <= MAX_BONES, "Cluckr: bones out of range");
        uint8 top = CELLS - bones;
        rungs = new uint256[](top);
        for (uint8 n = 1; n <= top; n++) {
            rungs[n - 1] = payoutAt(bet, bones, n);
        }
    }

    /// @notice What a round would reserve if it started now: the lowest of the
    ///         ladder's top rung and the coop's cap for one round.
    /// @param amount The bet before the burn.
    function previewReserve(uint256 amount, uint8 bones) external view returns (uint256 bet, uint256 reservedForRound) {
        uint256 burned = (amount * params.burnBps) / BPS;
        bet = amount - burned;
        uint256 cap = bet + maxWin();
        uint256 ceiling = payoutAt(bet, bones, CELLS - bones);
        reservedForRound = ceiling < cap ? ceiling : cap;
    }

    /// @notice EIP-712 digest the house signs to commit to a hash chain for `player`.
    function commitDigest(bytes32 tip, address player, uint256 expiry) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(COMMIT_TYPEHASH, tip, player, expiry)));
    }

    /// @notice The roll a reveal would produce, for anyone checking a round after the fact.
    function roll(uint256 id, bytes32 seed, bytes32 nonce, uint8 cell) public view returns (uint256) {
        return uint256(keccak256(abi.encode(seed, nonce, cell, id, address(this))));
    }

    // ─────────────────────────────── owner ───────────────────────────────

    function setHouse(address newHouse) external onlyOwner {
        require(newHouse != address(0), "Cluckr: house is zero");
        emit HouseChanged(house, newHouse);
        house = newHouse;
    }

    function setParams(Params calldata params_) external onlyOwner {
        _setParams(params_);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    /// @notice Moves token out of the free coop. Never touches what live rounds could win.
    function withdraw(address to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), "Cluckr: to is zero");
        require(amount <= freeBankroll(), "Cluckr: reserved for live rounds");
        token.safeTransfer(to, amount);
        emit Withdrawn(to, amount);
    }

    // ────────────────────────────── internals ────────────────────────────

    function _live(uint256 id) internal view returns (Round storage r) {
        r = _rounds[id];
        require(r.status == Status.Live, "Cluckr: round is not live");
    }

    function _auth(Round storage r) internal view {
        require(msg.sender == r.player || (r.operator != address(0) && msg.sender == r.operator), "Cluckr: not your round");
    }

    /// @dev Checks the seed against the commitment, rolls, and either advances
    ///      the round or busts it. Returns true when the lift was a chicken.
    function _reveal(uint256 id, Round storage r, bytes32 seed) internal returns (bool safe) {
        require(keccak256(abi.encodePacked(seed)) == r.commit, "Cluckr: seed does not match commitment");
        uint8 cell = r.pendingCell;
        uint256 remaining = CELLS - r.level;
        bool bone = roll(id, seed, r.pendingNonce, cell) % remaining < r.bones;

        r.pending = false;
        r.pendingNonce = bytes32(0);
        r.commit = seed;
        r.lastActionAt = uint40(block.timestamp);

        if (bone) {
            r.boneCell = cell;
            uint256 lost = r.bet;
            _close(r, Status.Busted);
            roundsBusted += 1;
            emit Busted(id, r.level, cell, seed, lost);
            return false;
        }

        r.level += 1;
        r.revealedMask |= uint32(1) << cell;
        emit Chicken(id, r.level, cell, seed);
        if (r.level == CELLS - r.bones) {
            _finish(id, r, Status.Cashed, payoutAt(r.bet, r.bones, r.level), false);
        }
        return true;
    }

    /// @dev An unrevealed lift the house owes: count it as a chicken.
    function _grantPending(Round storage r) internal {
        r.pending = false;
        r.pendingNonce = bytes32(0);
        r.level += 1;
        r.revealedMask |= uint32(1) << r.pendingCell;
    }

    function _finish(uint256 id, Round storage r, Status status, uint256 payout, bool forced) internal {
        if (payout > r.reserved) payout = r.reserved;
        r.payout = payout;
        _close(r, status);
        totalPaid += payout;
        if (payout > 0) token.safeTransfer(r.player, payout);
        if (status == Status.Expired) emit Expired(id, r.player, r.level, payout);
        else emit CashedOut(id, r.player, r.level, payout, forced);
    }

    function _close(Round storage r, Status status) internal {
        r.status = status;
        reserved -= r.reserved;
        roundOf[r.player] = 0;
    }

    function _pull(uint256 amount) internal returns (uint256 received) {
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        received = token.balanceOf(address(this)) - before;
        require(received > 0, "Cluckr: nothing received");
    }

    function _setParams(Params memory p) internal {
        require(p.edgeBps <= 1_000, "Cluckr: edge above 10%");
        require(p.burnBps <= 1_000, "Cluckr: burn above 10%");
        require(p.maxPayoutBps >= 1 && p.maxPayoutBps <= 2_000, "Cluckr: max payout out of range");
        require(p.revealTimeout >= 2 minutes && p.revealTimeout <= 1 days, "Cluckr: reveal timeout out of range");
        require(p.idleTimeout >= 10 minutes && p.idleTimeout <= 30 days, "Cluckr: idle timeout out of range");
        require(p.minBet > 0 && p.minBet <= p.maxBet, "Cluckr: bet bounds");
        require(p.maxBet <= 1e36, "Cluckr: max bet too large");
        params = p;
        emit ParamsChanged(p);
    }
}
