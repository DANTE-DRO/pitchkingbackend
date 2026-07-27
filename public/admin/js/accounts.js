requireLogin();
initHeader();

const alertBox = document.getElementById("alertBox");
function showAlert(msg, type = "info") {
  alertBox.innerHTML = `<div class="alert ${type}">${msg}</div>`;
  setTimeout(() => (alertBox.innerHTML = ""), 5000);
}

// ---------- Create account: feature tag builder ----------
let newFeatures = [];
function renderNewFeatureTags() {
  document.getElementById("newFeatureTags").innerHTML = newFeatures
    .map((f, i) => `<span class="feature-tag">${f} <button onclick="removeNewFeature(${i})">&times;</button></span>`)
    .join("");
}
function removeNewFeature(i) {
  newFeatures.splice(i, 1);
  renderNewFeatureTags();
}
document.getElementById("addFeatureBtn").addEventListener("click", () => {
  const input = document.getElementById("newFeature");
  const val = input.value.trim();
  if (val) {
    newFeatures.push(val);
    input.value = "";
    renderNewFeatureTags();
  }
});

document.getElementById("createAccountBtn").addEventListener("click", async () => {
  const name = document.getElementById("newName").value.trim();
  const worth = document.getElementById("newWorth").value;
  const ticketPrice = document.getElementById("newPrice").value;
  if (!name || !worth || !ticketPrice) {
    showAlert("Please fill in name, worth and ticket price.", "error");
    return;
  }
  try {
    await adminPost("/admin/accounts", { name, worth, ticketPrice, features: newFeatures });
    document.getElementById("newName").value = "";
    document.getElementById("newWorth").value = "";
    document.getElementById("newPrice").value = "";
    newFeatures = [];
    renderNewFeatureTags();
    showAlert("Account created.", "success");
    loadAccounts();
  } catch (err) {
    showAlert(err.message, "error");
  }
});

// ---------- List + manage existing accounts ----------
async function loadAccounts() {
  const list = document.getElementById("accountsList");
  try {
    const accounts = await adminGet("/admin/accounts");
    if (!accounts.length) {
      list.innerHTML = `<p class="help">No accounts yet — add one above.</p>`;
      return;
    }
    list.innerHTML = accounts.map(renderAccountRow).join("");
    accounts.forEach(wireAccountRow);
  } catch (err) {
    list.innerHTML = `<div class="alert error">${err.message}</div>`;
  }
}

function renderAccountRow(a) {
  const image = a.image ? a.image : null;
  const countdownEndsStr = a.countdownEndsAt
    ? new Date(a.countdownEndsAt).toLocaleString()
    : "— (using default from Settings)";
  return `
    <div class="panel" id="acc-${a.id}">
      <div style="display:flex; gap:14px; flex-wrap:wrap; align-items:flex-start;">
        ${image ? `<img class="thumb" src="${image}" />` : `<div class="thumb"></div>`}
        <div style="flex:1; min-width:220px;">
          <strong style="color:#fff;font-size:15px;">${a.name}</strong>
          <span class="badge ${a.status}">${a.status}</span>
          <div class="help" style="margin-top:6px;">${moneyKsh(a.worth)} &middot; ${moneyKsh(a.ticketPrice)}/ticket &middot; ${a.ticketsSold} sold</div>
          <div class="help" style="margin-top:4px;color:var(--cyan);">⏱ Countdown ends: <strong>${countdownEndsStr}</strong></div>
          ${a.winnerTicket ? `<div class="help" style="color:var(--gold);margin-top:4px;">Winning ticket: <strong>${a.winnerTicket}</strong> (${a.winnerEmail})</div>` : ""}
        </div>
        <div style="display:flex; flex-direction:column; gap:6px;">
          <label class="btn secondary small" style="text-align:center; cursor:pointer;">
            Upload image
            <input type="file" accept="image/*" style="display:none;" class="img-input" data-id="${a.id}" />
          </label>
          <button class="btn secondary small edit-btn" data-id="${a.id}">Edit</button>
          ${a.status === "open" ? `<button class="btn gold small draw-btn" data-id="${a.id}">Draw winner</button>` : ""}
          ${a.status === "open" ? `<button class="btn secondary small close-btn" data-id="${a.id}">Close</button>` : ""}
          <button class="btn danger small delete-btn" data-id="${a.id}">Delete</button>
        </div>
      </div>

      <div class="feature-tags" style="margin-top:10px;">
        ${(a.features || []).map((f) => `<span class="feature-tag">${f}</span>`).join("")}
      </div>

      <div id="edit-${a.id}" style="display:none; margin-top:14px; border-top:1px solid var(--line); padding-top:14px;">
        <div class="form-row"><label>Name</label><input type="text" class="edit-name" value="${a.name}" /></div>
        <div class="form-row"><label>Worth (KSh)</label><input type="number" class="edit-worth" value="${a.worth}" /></div>
        <div class="form-row"><label>Ticket price (KSh)</label><input type="number" class="edit-price" value="${a.ticketPrice}" /></div>
        <div class="form-row">
          <label>Features (one per line)</label>
          <textarea class="edit-features">${(a.features || []).join("\n")}</textarea>
          <span class="help">Saving this updates what buyers see on the public site immediately.</span>
        </div>
        <div class="form-row">
          <label>Countdown — days from now (overrides default)</label>
          <input type="number" min="1" max="365" class="edit-countdown-days" placeholder="e.g. 7" />
          <span class="help">Sets a new countdown end time for this raffle only. Leave blank to keep the current end time.</span>
        </div>
        <button class="btn small save-edit-btn" data-id="${a.id}">Save changes</button>
      </div>
    </div>
  `;
}

function wireAccountRow(a) {
  const row = document.getElementById(`acc-${a.id}`);

  row.querySelector(".edit-btn").addEventListener("click", () => {
    const panel = document.getElementById(`edit-${a.id}`);
    panel.style.display = panel.style.display === "none" ? "block" : "none";
  });

  row.querySelector(".save-edit-btn").addEventListener("click", async () => {
    const name = row.querySelector(".edit-name").value.trim();
    const worth = row.querySelector(".edit-worth").value;
    const ticketPrice = row.querySelector(".edit-price").value;
    const features = row.querySelector(".edit-features").value.split("\n").map((s) => s.trim()).filter(Boolean);
    const countdownDaysRaw = row.querySelector(".edit-countdown-days").value;
    const payload = { name, worth, ticketPrice, features };
    if (countdownDaysRaw !== "" && countdownDaysRaw !== null) {
      const d = Number(countdownDaysRaw);
      if (!(d > 0) || d > 365) {
        showAlert("Countdown days must be between 1 and 365.", "error");
        return;
      }
      payload.countdownDaysFromNow = d;
    }
    try {
      await adminPut(`/admin/accounts/${a.id}`, payload);
      showAlert("Account updated.", "success");
      loadAccounts();
    } catch (err) {
      showAlert(err.message, "error");
    }
  });

  const imgInput = row.querySelector(".img-input");
  imgInput.addEventListener("change", async () => {
    if (!imgInput.files[0]) return;
    try {
      await adminUpload(`/admin/accounts/${a.id}/image`, imgInput.files[0]);
      showAlert("Image uploaded.", "success");
      loadAccounts();
    } catch (err) {
      showAlert(err.message, "error");
    }
  });

  const drawBtn = row.querySelector(".draw-btn");
  if (drawBtn) {
    drawBtn.addEventListener("click", async () => {
      if (!confirm(`Draw a random winner for "${a.name}" now? This closes the raffle.`)) return;
      try {
        const result = await adminPost(`/admin/accounts/${a.id}/draw`);
        showAlert(`Winner drawn! Ticket #${result.winningTicket.ticketNumber} (${result.winningTicket.buyerEmail}).`, "success");
        loadAccounts();
      } catch (err) {
        showAlert(err.message, "error");
      }
    });
  }

  const closeBtn = row.querySelector(".close-btn");
  if (closeBtn) {
    closeBtn.addEventListener("click", async () => {
      if (!confirm(`Close "${a.name}" without drawing a winner?`)) return;
      try {
        await adminPut(`/admin/accounts/${a.id}`, { status: "archived" });
        loadAccounts();
      } catch (err) {
        showAlert(err.message, "error");
      }
    });
  }

  row.querySelector(".delete-btn").addEventListener("click", async () => {
    if (!confirm(`Delete "${a.name}" permanently? This cannot be undone.`)) return;
    await adminDelete(`/admin/accounts/${a.id}`);
    loadAccounts();
  });
}

loadAccounts();
