// Quick manual test for the KCB Buni STK Push integration.
// Run with:  node test-stk.js
// Requires internet access to reach https://api.buni.kcbgroup.com (KCB_ENV=production),
// and your .env file must be filled in (see .env.example).
//
// It will send a real STK push of KSh 1 to the phone number below and print
// the final result once you respond to the prompt on your phone (or after
// it times out).

require("dotenv").config();
const { initiateSTKPush } = require("./lib/payment");

const TEST_PHONE = "0797977136";
const TEST_AMOUNT = 1;

async function main() {
  console.log(`Sending a test STK push of KSh ${TEST_AMOUNT} to ${TEST_PHONE}...`);
  console.log("Check your phone for the M-Pesa PIN prompt.\n");

  const result = await initiateSTKPush({
    phone: TEST_PHONE,
    amount: TEST_AMOUNT,
    accountRef: "TEST-" + Date.now(),
    description: "PitchKing integration test",
  });

  console.log("\n=== Result ===");
  console.log(result);

  if (result.success) {
    console.log(`\n✅ Payment successful. M-Pesa receipt: ${result.transactionId}`);
  } else {
    console.log(`\n❌ Payment not completed: ${result.error}`);
  }
}

main().catch((err) => {
  console.error("Test script error:", err);
  process.exit(1);
});
