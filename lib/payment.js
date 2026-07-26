// Placeholder payment — swap this for a real M-Pesa Daraja STK Push later.
async function initiateSTKPush({ phone, amount, accountRef, description }) {
  console.log(
    `[payment:PLACEHOLDER] Would charge ${phone} KSh ${amount} for "${description}" (ref: ${accountRef})`
  );
  await new Promise((resolve) => setTimeout(resolve, 400));
  return {
    success: true,
    placeholder: true,
    transactionId: `SIM-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
  };
}

module.exports = { initiateSTKPush };
