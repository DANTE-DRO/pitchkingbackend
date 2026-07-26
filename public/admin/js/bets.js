requireLogin();
initHeader();

const alertBox = document.getElementById("alertBox");
function showAlert(msg, type = "info") {
  alertBox.innerHTML = `<div class="alert ${type}">${msg}</div>`;
  setTimeout(() => (alertBox.innerHTML = ""), 5000);
}

const STATUS_ORDER = ["disputed", "awaiting_admin", "active", "awaiting_opponent", "paid", "cancelled"];

async function loadBets() {
  const list = document.getElementById("betsList");
  try {
    const bets = await adminGet("/admin/bets");
    if (!bets.length) {
      list.innerHTML = `<p class="help">No challenges created yet.</p>`;
      return;
    }
    bets.sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));
    list.innerHTML = bets.map(renderBet).join("");
    bets.forEach(wireBet);
  } catch (err) {
    list.innerHTML = `<div class="alert error">${err.message}</div>`;
  }
}

function renderBet(b) {
  const pot = b.amount * 2;
  return `
    <div class="panel" id="bet-${b.id}">
      <div style="display:flex; justify-content:space-between; flex-wrap:wrap; gap:10px;">
        <div>
          <strong style="color:#fff;font-size:15px;">Code: <span style="color:var(--cyan);letter-spacing:2px;">${b.playingCode}</span></strong>
          <span class="badge ${b.status}">${b.status.replace("_", " ")}</span>
          <div class="help" style="margin-top:6px;">Stake ${moneyKsh(b.amount)} each &middot; Pot ${moneyKsh(pot)} &middot; Created ${new Date(b.createdAt).toLocaleString()}</div>
        </div>
      </div>

      <table style="margin-top:12px;">
        <tr><th></th><th>Phone</th><th>Email</th><th>Result claim</th></tr>
        <tr>
          <td style="color:#fff;">Creator</td>
          <td>${b.creator.phone}</td>
          <td>${b.creator.email}</td>
          <td>${b.creator.resultClaim || "—"}</td>
        </tr>
        <tr>
          <td style="color:#fff;">Opponent</td>
          <td>${b.opponent ? b.opponent.phone : "—"}</td>
          <td>${b.opponent ? b.opponent.email : "—"}</td>
          <td>${b.opponent ? b.opponent.resultClaim || "—" : "—"}</td>
        </tr>
      </table>

      ${b.adminNote ? `<div class="alert info" style="margin-top:10px;">${b.adminNote}</div>` : ""}

      ${
        b.status === "disputed"
          ? `
        <div style="margin-top:12px; display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
          <label style="font-size:12px;color:var(--cyan);text-transform:uppercase;letter-spacing:1px;font-weight:700;">Pick the winner:</label>
          <select class="resolve-select" id="resolve-${b.id}" style="padding:8px 12px;background:rgba(5,9,20,.6);border:1.5px solid var(--line);border-radius:6px;color:var(--ink);">
            <option value="creator">Creator (${b.creator.phone})</option>
            <option value="opponent">Opponent (${b.opponent ? b.opponent.phone : ""})</option>
          </select>
          <button class="btn small resolve-btn" data-id="${b.id}">Resolve dispute</button>
        </div>`
          : ""
      }

      ${
        b.status === "awaiting_admin" && b.payout
          ? `
        <div class="panel" style="background:rgba(255,212,0,.06);border-color:rgba(255,212,0,.4); margin-top:12px;">
          <strong style="color:var(--gold);">▸ Ready to pay out</strong>
          <div class="help" style="margin-top:6px;">Winner: <strong style="color:#fff;">${b.winnerSide}</strong> (${b.payout.winnerPhone}) &middot; Send <strong style="color:var(--gold);">${moneyKsh(b.payout.winnerAmount)}</strong> manually via M-Pesa.
          Platform keeps ${moneyKsh(b.payout.platformAmount)} (${b.payout.platformPercent}%).</div>
          <button class="btn gold small authorize-btn" data-id="${b.id}" style="margin-top:10px;">I've sent — mark as paid</button>
        </div>`
          : ""
      }

      ${b.status === "awaiting_opponent" || b.status === "active" ? `<button class="btn danger small cancel-btn" data-id="${b.id}" style="margin-top:10px;">Cancel challenge</button>` : ""}
    </div>
  `;
}

function wireBet(b) {
  const row = document.getElementById(`bet-${b.id}`);

  const resolveBtn = row.querySelector(".resolve-btn");
  if (resolveBtn) {
    resolveBtn.addEventListener("click", async () => {
      const winnerSide = document.getElementById(`resolve-${b.id}`).value;
      try {
        await adminPost(`/admin/bets/${b.id}/resolve`, { winnerSide });
        showAlert("Dispute resolved. Payout is now queued for authorisation.", "success");
        loadBets();
      } catch (err) {
        showAlert(err.message, "error");
      }
    });
  }

  const authBtn = row.querySelector(".authorize-btn");
  if (authBtn) {
    authBtn.addEventListener("click", async () => {
      if (!confirm("Confirm you have actually sent the money to the winner?")) return;
      try {
        await adminPost(`/admin/bets/${b.id}/authorize`);
        showAlert("Marked as paid.", "success");
        loadBets();
      } catch (err) {
        showAlert(err.message, "error");
      }
    });
  }

  const cancelBtn = row.querySelector(".cancel-btn");
  if (cancelBtn) {
    cancelBtn.addEventListener("click", async () => {
      if (!confirm("Cancel this challenge?")) return;
      await adminPost(`/admin/bets/${b.id}/cancel`);
      loadBets();
    });
  }
}

loadBets();
