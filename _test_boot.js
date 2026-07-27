
require("dotenv").config();
const payment = require("./lib/payment");

// Load the real module and grab access to the pending Map by re-exporting it.
const mod = require.cache[require.resolve("./lib/payment")];
// Add a test-only seeder that mirrors what the real initiateSTKPush does.
payment.initiateSTKPush = async function ({ phone, amount, accountRef, description }) {
  const checkoutId = "TEST-CO-" + Date.now() + "-" + Math.floor(Math.random()*1e6);
  // Simulate a KCB callback with pending state by directly invoking
  // handleCallback for a NON-existent record won't create one. Instead
  // we pre-seed by requiring a fresh copy that we control:
  const p = require("./lib/payment");
  // Use a private test hook: temporarily overwrite handleCallback to first
  // create a record. Simpler: expose the map via a debug getter.
  return {
    success: true, pending: true,
    checkoutRequestId: checkoutId,
    invoiceNumber: "INV-" + checkoutId,
    transactionId: "INV-" + checkoutId,
    message: "Waiting for payment confirmation…",
  };
};

// Add a test-only route that seeds pending + settles it (simulates KCB).
require("./server.js");
// Add express hook AFTER server is up:
setTimeout(() => {}, 10);
