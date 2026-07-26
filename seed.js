// Optional one-time helper: pre-creates the 7 raffle accounts at the
// prices you specified, so you don't have to type them into the admin
// panel by hand. Run once with:  npm run seed
// You can then edit each one's name, image and features from the admin panel.

const crypto = require("crypto");
const store = require("./lib/store");

store.init();

const tiers = [
  { name: "Account #1 — Elite Tier", worth: 30000, ticketPrice: 180 },
  { name: "Account #2", worth: 15000, ticketPrice: 130 },
  { name: "Account #3", worth: 13000, ticketPrice: 100 },
  { name: "Account #4", worth: 12000, ticketPrice: 80 },
  { name: "Account #5", worth: 10000, ticketPrice: 70 },
  { name: "Account #6", worth: 3500, ticketPrice: 45 },
  { name: "Account #7", worth: 1300, ticketPrice: 20 },
];

const existing = store.readAll("accounts");
if (existing.length > 0) {
  console.log("Accounts already exist — seed skipped. Delete data/accounts.json if you want to reseed from scratch.");
  process.exit(0);
}

tiers.forEach((tier) => {
  store.insert("accounts", {
    id: crypto.randomUUID(),
    name: tier.name,
    worth: tier.worth,
    ticketPrice: tier.ticketPrice,
    features: ["Add this account's real features from the admin panel"],
    image: null,
    ticketsSold: 0,
    status: "open",
    winnerTicket: null,
    winnerEmail: null,
    createdAt: new Date().toISOString(),
  });
});

console.log(`Seeded ${tiers.length} raffle accounts. Edit their names/features/images from the admin panel.`);
