// Admin API base — because the admin panel is served from the SAME origin
// as the backend (Render), we can use a relative URL. No cross-origin issues.
const API_BASE = "/api";

function getToken() { return localStorage.getItem("pk_admin_token"); }
function setToken(token, username) {
  localStorage.setItem("pk_admin_token", token);
  localStorage.setItem("pk_admin_username", username);
}
function clearToken() {
  localStorage.removeItem("pk_admin_token");
  localStorage.removeItem("pk_admin_username");
}
function requireLogin() {
  if (!getToken()) window.location.href = "login.html";
}

async function adminGet(path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "x-admin-token": getToken() },
  });
  if (res.status === 401) { clearToken(); window.location.href = "login.html"; return; }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Something went wrong");
  return data;
}

async function adminPost(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": getToken() },
    body: JSON.stringify(body || {}),
  });
  if (res.status === 401) { clearToken(); window.location.href = "login.html"; return; }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Something went wrong");
  return data;
}

async function adminPut(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "x-admin-token": getToken() },
    body: JSON.stringify(body || {}),
  });
  if (res.status === 401) { clearToken(); window.location.href = "login.html"; return; }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Something went wrong");
  return data;
}

async function adminDelete(path) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "DELETE",
    headers: { "x-admin-token": getToken() },
  });
  if (res.status === 401) { clearToken(); window.location.href = "login.html"; return; }
  return res.json();
}

async function adminUpload(path, file) {
  const form = new FormData();
  form.append("image", file);
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "x-admin-token": getToken() },
    body: form,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Upload failed");
  return data;
}

function moneyKsh(n) { return `KSh ${Number(n).toLocaleString()}`; }

function initHeader() {
  const el = document.getElementById("adminUsername");
  if (el) el.textContent = localStorage.getItem("pk_admin_username") || "Admin";
  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) logoutBtn.onclick = () => { clearToken(); window.location.href = "login.html"; };
}
