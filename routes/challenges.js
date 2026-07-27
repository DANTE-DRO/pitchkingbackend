// PitchKing — Head-to-Head Challenges (multi-participant)
// This route is COMPLETELY SEPARATE from routes/bets.js (the old 1v1 system).
// The old bets routes remain untouched and fully functional.
//
// Flow:
//   1. Creator creates a challenge → stake deducted → status "open"
//   2. Participants join via challenge ID → stake deducted → added to participants[]
//   3. Creator ends challenge → every participant gets a vote checkbox → status "voting"
//   4. Each participant votes for a winner → once ALL have voted, winner is determined → status "completed"
//   5. Winner's wallet is credited 80% of total pot; system keeps 20%
//   6. Winner can withdraw from wallet
//   7. If nobody joins within 30 minutes, creator can refund and withdraw their stake

const express = require("express");
const crypto = require("crypto");
const store = require("../lib/store");
const { sendEmail } = require("../lib/email");
const { initiateSTKPush } = require("../lib/payment");

const router = express.Router();

const SYSTEM_PERCENT = 20;
const WINNER_PERCENT = 80;
const REFUND_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

function getSettings() {
  const rows = store.readAll("settings");
  return rows[0] || { winnerPercent: WINNER_PERCENT, platformPercent: SYSTEM_PERCENT };
}

function genChallengeId() {
  // Short readable ID like "CH-7F3K9Q2R"
  return "CH-" + crypto.randomBytes(4).toString("hex").toUpperCase();
}

function publicChallenge(c) {
  return {
    id: c.id,
    name: c.name,
    amount: c.amount,
    status: c.status,
    creatorUsername: c.creator.username,
    participantCount: c.participants.length,
    totalPot: c.amount * c.participants.length,
    createdAt: c.createdAt,
    endedAt: c.endedAt || null,
    winner: c.winner || null,
  };
}

// ──────────────────────────────────────────────
// CREATE CHALLENGE
// Body: { name, amount, phone, email, username, agreeRisk, confirm18 }
// ──────────────────────────────────────────────
router.post("/challenges", async (req, res) => {
  const { name, amount, phone, email, username, agreeRisk, confirm18 } = req.body;

  if (!name || !amount || !phone || !email || !username) {
    return res.status(400).json({ error: "Challenge name, amount, phone, email and username are all required" });
  }
  if (!agreeRisk) {
    return res.status(400).json({ error: "You must agree that you are willing to risk your money" });
  }
  if (!confirm18) {
    return res.status(400).json({ error: "You must confirm you are 18 years or above" });
  }

  const stake = Number(amount);
  if (!(stake > 0)) return res.status(400).json({ error: "Amount must be greater than 0" });

  const challengeId = genChallengeId();

  // Placeholder payment — deduct the stake
  const payment = await initiateSTKPush({
    phone,
    amount: stake,
    accountRef: challengeId,
    description: `Stake for challenge "${name}"`,
  });
  if (!payment.success) {
    return res.status(402).json({ error: "Payment could not be completed. Please try again." });
  }

  const creatorParticipant = {
    participantId: crypto.randomUUID(),
    username,
    phone,
    email,
    stakePaid: true,
    voted: false,
    votedFor: null,
    joinedAt: new Date().toISOString(),
  };

  const challenge = {
    id: challengeId,
    name: String(name).trim(),
    amount: stake,
    status: "open", // open | voting | completed | refunded
    creator: {
      username,
      phone,
      email,
      participantId: creatorParticipant.participantId,
    },
    participants: [creatorParticipant],
    winner: null,
    payout: null,
    createdAt: new Date().toISOString(),
    endedAt: null,
  };

  store.insert("challenges", challenge);

  res.status(201).json({
    id: challenge.id,
    name: challenge.name,
    amount: challenge.amount,
    checkoutRequestId: payment.checkoutRequestId || null,
    invoiceNumber: payment.invoiceNumber || null,
    message: "Challenge created successfully! Share the Challenge ID so others can join.",
  });
});

// ──────────────────────────────────────────────
// JOIN CHALLENGE
// Body: { challengeId, username, email, phone, amount, agreeRisk, confirm18 }
// ──────────────────────────────────────────────
router.post("/challenges/join", async (req, res) => {
  const { challengeId, username, email, phone, amount, agreeRisk, confirm18 } = req.body;

  if (!challengeId || !username || !email || !phone || !amount) {
    return res.status(400).json({ error: "Challenge ID, username, email, phone and amount are all required" });
  }
  if (!agreeRisk) {
    return res.status(400).json({ error: "You must agree that you are willing to risk your money" });
  }
  if (!confirm18) {
    return res.status(400).json({ error: "You must confirm you are 18 years or above" });
  }

  const c = store.readAll("challenges").find((b) => b.id === challengeId.toUpperCase());
  if (!c) return res.status(404).json({ error: "No challenge found with that Challenge ID" });
  if (c.status !== "open") {
    return res.status(400).json({ error: "This challenge is no longer open for new participants" });
  }

  const joinAmount = Number(amount);
  if (joinAmount !== c.amount) {
    return res.status(400).json({ error: `The stake amount for this challenge is KSh ${c.amount}. You must match it exactly.` });
  }

  // Prevent duplicate join (same email or phone)
  const alreadyIn = c.participants.some((p) => p.email === email || p.phone === phone);
  if (alreadyIn) {
    return res.status(409).json({ error: "You have already joined this challenge" });
  }

  // Placeholder payment — deduct the stake
  const payment = await initiateSTKPush({
    phone,
    amount: joinAmount,
    accountRef: c.id,
    description: `Stake to join challenge "${c.name}"`,
  });
  if (!payment.success) {
    return res.status(402).json({ error: "Payment could not be completed. Please try again." });
  }

  const newParticipant = {
    participantId: crypto.randomUUID(),
    username,
    phone,
    email,
    stakePaid: true,
    voted: false,
    votedFor: null,
    joinedAt: new Date().toISOString(),
  };

  c.participants.push(newParticipant);
  store.update("challenges", c.id, { participants: c.participants });

  res.json({
    id: c.id,
    name: c.name,
    amount: c.amount,
    participantCount: c.participants.length,
    checkoutRequestId: payment.checkoutRequestId || null,
    invoiceNumber: payment.invoiceNumber || null,
    message: "You joined the challenge successfully!",
  });
});

// ──────────────────────────────────────────────
// GET CHALLENGE DETAILS (public — by ID)
// ──────────────────────────────────────────────
router.get("/challenges/:id", (req, res) => {
  const c = store.findById("challenges", req.params.id.toUpperCase());
  if (!c) return res.status(404).json({ error: "Challenge not found" });
  res.json({
    id: c.id,
    name: c.name,
    amount: c.amount,
    status: c.status,
    creatorUsername: c.creator.username,
    participants: c.participants.map((p) => ({
      participantId: p.participantId,
      username: p.username,
      voted: p.voted,
      votedFor: p.votedFor,
    })),
    participantCount: c.participants.length,
    totalPot: c.amount * c.participants.length,
    winner: c.winner,
    payout: c.payout,
    createdAt: c.createdAt,
    endedAt: c.endedAt,
    refundEligible: isRefundEligible(c),
  });
});

function isRefundEligible(c) {
  if (c.status !== "open") return false;
  // Only the creator alone (no other participants) and 30 minutes passed
  if (c.participants.length > 1) return false;
  const elapsed = Date.now() - new Date(c.createdAt).getTime();
  return elapsed >= REFUND_WINDOW_MS;
}

// ──────────────────────────────────────────────
// LIST ALL OPEN CHALLENGES (for notifications / browse)
// ──────────────────────────────────────────────
router.get("/challenges", (req, res) => {
  const all = store.readAll("challenges");
  res.json(
    all
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map(publicChallenge)
  );
});

// ──────────────────────────────────────────────
// END CHALLENGE (creator only) → starts voting
// Body: { creatorParticipantId }
// ──────────────────────────────────────────────
router.post("/challenges/:id/end", (req, res) => {
  const c = store.findById("challenges", req.params.id.toUpperCase());
  if (!c) return res.status(404).json({ error: "Challenge not found" });
  if (c.status !== "open") {
    return res.status(400).json({ error: "This challenge cannot be ended in its current state" });
  }

  const { creatorParticipantId } = req.body;
  if (creatorParticipantId !== c.creator.participantId) {
    return res.status(403).json({ error: "Only the challenge creator can end this challenge" });
  }
  if (c.participants.length < 2) {
    return res.status(400).json({ error: "You need at least 2 participants to end a challenge" });
  }

  const updated = store.update("challenges", c.id, {
    status: "voting",
    endedAt: new Date().toISOString(),
  });

  res.json({
    id: updated.id,
    status: updated.status,
    message: "Challenge ended. All participants can now vote for the winner.",
  });
});

// ──────────────────────────────────────────────
// VOTE FOR WINNER (participant only)
// Body: { participantId, voteForParticipantId }
// ──────────────────────────────────────────────
router.post("/challenges/:id/vote", (req, res) => {
  const c = store.findById("challenges", req.params.id.toUpperCase());
  if (!c) return res.status(404).json({ error: "Challenge not found" });
  if (c.status !== "voting") {
    return res.status(400).json({ error: "Voting is not open for this challenge" });
  }

  const { participantId, voteForParticipantId } = req.body;
  if (!participantId || !voteForParticipantId) {
    return res.status(400).json({ error: "participantId and voteForParticipantId are required" });
  }

  const voter = c.participants.find((p) => p.participantId === participantId);
  if (!voter) return res.status(403).json({ error: "You are not a participant in this challenge" });
  if (voter.voted) return res.status(400).json({ error: "You have already voted" });

  const candidate = c.participants.find((p) => p.participantId === voteForParticipantId);
  if (!candidate) return res.status(400).json({ error: "The participant you voted for does not exist" });

  voter.voted = true;
  voter.votedFor = voteForParticipantId;
  store.update("challenges", c.id, { participants: c.participants });

  // Check if everyone has voted
  const allVoted = c.participants.every((p) => p.voted);
  if (allVoted) {
    return res.json(determineWinner(c));
  }

  const remaining = c.participants.filter((p) => !p.voted).length;
  res.json({
    id: c.id,
    status: c.status,
    message: `Vote recorded. Waiting for ${remaining} more participant(s) to vote.`,
  });
});

function determineWinner(c) {
  // Tally votes
  const tally = {};
  c.participants.forEach((p) => {
    if (p.votedFor) {
      tally[p.votedFor] = (tally[p.votedFor] || 0) + 1;
    }
  });

  let maxVotes = 0;
  let winners = [];
  Object.entries(tally).forEach(([pid, count]) => {
    if (count > maxVotes) {
      maxVotes = count;
      winners = [pid];
    } else if (count === maxVotes) {
      winners.push(pid);
    }
  });

  // Tie-breaker: pick randomly among tied participants
  const winnerPid = winners[Math.floor(Math.random() * winners.length)];
  const winnerParticipant = c.participants.find((p) => p.participantId === winnerPid);

  const settings = getSettings();
  const totalPot = c.amount * c.participants.length;
  const winnerAmount = Math.round((totalPot * settings.winnerPercent) / 100);
  const platformAmount = totalPot - winnerAmount;

  const updated = store.update("challenges", c.id, {
    status: "completed",
    winner: {
      participantId: winnerParticipant.participantId,
      username: winnerParticipant.username,
      email: winnerParticipant.email,
      phone: winnerParticipant.phone,
      votesReceived: maxVotes,
    },
    payout: {
      totalPot,
      winnerPercent: settings.winnerPercent,
      platformPercent: settings.platformPercent,
      winnerAmount,
      platformAmount,
    },
  });

  // Credit winner's wallet
  ensureWallet(winnerParticipant.email, winnerParticipant.username, winnerParticipant.phone);
  creditWallet(winnerParticipant.email, winnerAmount, c.id, c.name);

  // Send email to winner
  sendEmail({
    to: winnerParticipant.email,
    subject: `You won the challenge "${c.name}" on PitchKing!`,
    html: `
      <p>Congratulations <strong>${winnerParticipant.username}</strong>!</p>
      <p>You won the challenge <strong>${c.name}</strong> (ID: ${c.id}).</p>
      <p>Total pot: KSh ${totalPot.toLocaleString()}<br/>
         Your winnings (80%): <strong style="color:#00ff88;">KSh ${winnerAmount.toLocaleString()}</strong><br/>
         Platform fee (20%): KSh ${platformAmount.toLocaleString()}</p>
      <p>The winnings have been credited to your PitchKing wallet. You can withdraw anytime.</p>
      <p>— PitchKing</p>
    `,
  }).catch(() => {});

  return {
    id: updated.id,
    status: "completed",
    winner: updated.winner,
    payout: updated.payout,
    message: `All participants have voted. The winner is ${winnerParticipant.username}! KSh ${winnerAmount.toLocaleString()} has been credited to their wallet.`,
  };
}

// ──────────────────────────────────────────────
// REFUND (creator only, when nobody joined within 30 min)
// Body: { creatorParticipantId }
// ──────────────────────────────────────────────
router.post("/challenges/:id/refund", (req, res) => {
  const c = store.findById("challenges", req.params.id.toUpperCase());
  if (!c) return res.status(404).json({ error: "Challenge not found" });

  const { creatorParticipantId } = req.body;
  if (creatorParticipantId !== c.creator.participantId) {
    return res.status(403).json({ error: "Only the challenge creator can request a refund" });
  }
  if (c.participants.length > 1) {
    return res.status(400).json({ error: "Refund is only available when nobody has joined your challenge" });
  }
  if (!isRefundEligible(c)) {
    const elapsedMin = Math.floor((Date.now() - new Date(c.createdAt).getTime()) / 60000);
    const remainingMin = Math.ceil((REFUND_WINDOW_MS - (Date.now() - new Date(c.createdAt).getTime())) / 60000);
    return res.status(400).json({
      error: `Refund is available 30 minutes after creation. ${remainingMin > 0 ? `Please wait ${remainingMin} more minute(s).` : ""} (Elapsed: ${elapsedMin} min)`,
    });
  }

  // Credit the creator's wallet with their stake back
  ensureWallet(c.creator.email, c.creator.username, c.creator.phone);
  creditWallet(c.creator.email, c.amount, c.id, `Refund: ${c.name}`);

  store.update("challenges", c.id, {
    status: "refunded",
    endedAt: new Date().toISOString(),
  });

  res.json({
    id: c.id,
    status: "refunded",
    message: `Your stake of KSh ${c.amount.toLocaleString()} has been refunded to your wallet. You can withdraw it anytime.`,
  });
});

// ──────────────────────────────────────────────
// WALLET: Get balance and history
// Query: ?email=...
// ──────────────────────────────────────────────
router.get("/wallet", (req, res) => {
  const email = (req.query.email || "").trim().toLowerCase();
  if (!email) return res.status(400).json({ error: "email query parameter is required" });

  const wallet = store.readAll("wallets").find((w) => w.email === email);
  if (!wallet) {
    return res.json({ email, username: null, balance: 0, transactions: [], totalWithdrew: 0 });
  }
  res.json(wallet);
});

// ──────────────────────────────────────────────
// WALLET: Withdraw
// Body: { email, amount, phone }
// ──────────────────────────────────────────────
router.post("/wallet/withdraw", async (req, res) => {
  const { email, amount, phone } = req.body;
  if (!email || !amount || !phone) {
    return res.status(400).json({ error: "email, amount and phone are required" });
  }

  const withdrawAmount = Number(amount);
  if (!(withdrawAmount > 0)) return res.status(400).json({ error: "Amount must be greater than 0" });

  const wallet = store.readAll("wallets").find((w) => w.email === email.trim().toLowerCase());
  if (!wallet) return res.status(404).json({ error: "No wallet found for this email" });
  if (wallet.balance < withdrawAmount) {
    return res.status(400).json({ error: `Insufficient balance. Your wallet has KSh ${wallet.balance.toLocaleString()}.` });
  }

  // Placeholder payout — send money to phone
  const payment = await initiateSTKPush({
    phone,
    amount: withdrawAmount,
    accountRef: `WALLET-${wallet.id}`,
    description: `Wallet withdrawal`,
  });
  if (!payment.success) {
    return res.status(402).json({ error: "Withdrawal could not be completed. Please try again." });
  }

  const txn = {
    id: crypto.randomUUID(),
    type: "withdrawal",
    amount: withdrawAmount,
    phone,
    transactionId: payment.transactionId,
    timestamp: new Date().toISOString(),
  };

  wallet.balance -= withdrawAmount;
  wallet.totalWithdrew += withdrawAmount;
  wallet.transactions.push(txn);
  store.update("wallets", wallet.id, {
    balance: wallet.balance,
    totalWithdrew: wallet.totalWithdrew,
    transactions: wallet.transactions,
  });

  res.json({
    balance: wallet.balance,
    withdrew: withdrawAmount,
    transactionId: payment.transactionId,
    checkoutRequestId: payment.checkoutRequestId || null,
    invoiceNumber: payment.invoiceNumber || null,
    message: `Withdrawal of KSh ${withdrawAmount.toLocaleString()} successful. Remaining balance: KSh ${wallet.balance.toLocaleString()}.`,
  });
});

// ──────────────────────────────────────────────
// WALLET HELPERS
// ──────────────────────────────────────────────
function ensureWallet(email, username, phone) {
  const normalizedEmail = email.trim().toLowerCase();
  const wallets = store.readAll("wallets");
  let wallet = wallets.find((w) => w.email === normalizedEmail);
  if (!wallet) {
    wallet = {
      id: crypto.randomUUID(),
      email: normalizedEmail,
      username,
      phone,
      balance: 0,
      totalWithdrew: 0,
      transactions: [],
      createdAt: new Date().toISOString(),
    };
    store.insert("wallets", wallet);
  }
  return wallet;
}

function creditWallet(email, amount, challengeId, description) {
  const wallets = store.readAll("wallets");
  const normalizedEmail = email.trim().toLowerCase();
  const wallet = wallets.find((w) => w.email === normalizedEmail);
  if (!wallet) return;

  const txn = {
    id: crypto.randomUUID(),
    type: "credit",
    amount,
    challengeId,
    description,
    timestamp: new Date().toISOString(),
  };

  wallet.balance += amount;
  wallet.transactions.push(txn);
  store.update("wallets", wallet.id, {
    balance: wallet.balance,
    transactions: wallet.transactions,
  });
}

module.exports = router;
