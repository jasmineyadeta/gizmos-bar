import { sb, configured, callFn, isOpen, DAYS, toast, esc, showLoader, hideLoader, GIZMO_SVG } from "./common.js";

const $ = (id) => document.getElementById(id);
let user = null;
let settings = null;
let menu = [];

$("authGizmo").innerHTML = GIZMO_SVG;
$("guestLink").href = new URL("./", location.href).href;
$("guestLink").textContent = new URL("./", location.href).href;
$("qr").src = "qr.png";

// ---------- Auth ----------
let firstTime = false;

async function boot() {
  if (!configured) { document.body.innerHTML = "<main><p>Still being set up. Check back soon.</p></main>"; return; }
  showLoader("Gizmo's warming up...");
  const { data: { session } } = await sb.auth.getSession();
  if (session) {
    user = session.user;
    if (await ensureOwner()) return startApp();
  }
  const { data: exists } = await sb.rpc("owner_exists");
  firstTime = exists === false;
  if (firstTime) {
    $("authHint").textContent = "First time here! Pick the email and password Gizmo will use to sign in.";
    $("authBtn").textContent = "Create owner login";
    $("pw").autocomplete = "new-password";
  }
  hideLoader();
  $("authView").classList.remove("hidden");
}

async function ensureOwner() {
  const { data: owner } = await sb.rpc("claim_owner");
  if (owner) return true;
  await sb.auth.signOut();
  user = null;
  toast("That account isn't the bar owner.");
  return false;
}

$("authForm").onsubmit = async (e) => {
  e.preventDefault();
  const email = $("email").value.trim();
  const password = $("pw").value;
  showLoader(firstTime ? "Setting up your bar..." : "Signing in...");
  const { data, error } = firstTime
    ? await sb.auth.signUp({ email, password })
    : await sb.auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    hideLoader();
    toast(error?.message === "Invalid login credentials" ? "Wrong email or password." : (error?.message || "Couldn't sign in."));
    return;
  }
  user = data.session.user;
  if (await ensureOwner()) { $("authView").classList.add("hidden"); startApp(); }
  else hideLoader();
};

$("signOut").onclick = async () => { await sb.auth.signOut(); location.reload(); };

// ---------- App ----------
async function startApp() {
  await Promise.all([loadSettings(), loadMenu(), loadOrders()]);
  hideLoader();
  $("appView").classList.remove("hidden");
  refreshPushState();
  setInterval(() => { if (!document.hidden) loadOrders(); }, 8000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) loadOrders(); });
  if (location.hash) showTab(location.hash.slice(1));
}

function showTab(name) {
  if (!document.querySelector(`[data-panel="${name}"]`)) return;
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  document.querySelectorAll("[data-panel]").forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== name));
}
$("tabs").onclick = (e) => { const b = e.target.closest("button"); if (b) { showTab(b.dataset.tab); history.replaceState(null, "", `#${b.dataset.tab}`); } };

// ---------- Orders ----------
async function loadOrders() {
  const { data, error } = await sb.from("orders").select("*").order("created_at", { ascending: false }).limit(100);
  if (error) return;
  const fresh = data.filter((o) => o.status === "new");
  $("badge").textContent = fresh.length;
  $("badge").classList.toggle("hidden", !fresh.length);
  const ago = (t) => {
    const m = Math.round((Date.now() - new Date(t)) / 60000);
    return m < 1 ? "just now" : m < 60 ? `${m} min ago` : new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  };
  const list = [...fresh.reverse(), ...data.filter((o) => o.status === "done")];
  $("orders").innerHTML = list.map((o) => `
    <div class="card order ${o.status}">
      <div class="t">
        <div class="who">${esc(o.guest_name)}</div>
        <div class="what">${esc(o.item_name)}</div>
        ${o.notes ? `<div class="note">"${esc(o.notes)}"</div>` : ""}
        <div class="time">${ago(o.created_at)}</div>
      </div>
      ${o.status === "new" ? `<button class="btn" data-done="${o.id}">Served</button>` : `<span class="small muted">Served</span>`}
    </div>`).join("") || `<div class="card notice"><p>No orders yet. Thirsty crowd incoming.</p></div>`;
  if (settings) setOwnerStatus();
}
$("orders").onclick = async (e) => {
  const id = e.target.dataset.done;
  if (!id) return;
  e.target.disabled = true;
  await sb.from("orders").update({ status: "done" }).eq("id", id);
  loadOrders();
};
$("clearDone").onclick = async () => {
  await sb.from("orders").delete().eq("status", "done");
  loadOrders();
};

function setOwnerStatus() {
  const open = isOpen(settings);
  $("ownerStatus").textContent = open ? "Bar is open" : "Bar is closed";
  $("ownerStatus").className = `pill ${open ? "open" : "closed"}`;
}

// ---------- Menu ----------
async function loadMenu() {
  const { data } = await sb.from("menu_items").select("*").order("category").order("sort").order("name");
  menu = data || [];
  $("cats").innerHTML = [...new Set(menu.map((d) => d.category))].map((c) => `<option value="${esc(c)}">`).join("");
  $("menuList").innerHTML = menu.map((d) => `
    <div class="card stack" data-id="${d.id}">
      <div class="row">
        <input class="grow" data-f="name" value="${esc(d.name)}" maxlength="80" aria-label="Drink name">
        <label class="switch" title="Available"><input type="checkbox" data-f="available" ${d.available ? "checked" : ""}><span></span></label>
      </div>
      <input data-f="description" value="${esc(d.description)}" maxlength="300" placeholder="Description" aria-label="Description">
      <div class="row">
        <input class="grow" data-f="category" value="${esc(d.category)}" list="cats" maxlength="40" aria-label="Section">
        <input style="width:90px" data-f="stock" type="number" min="0" inputmode="numeric" value="${d.stock ?? ""}" placeholder="No limit" aria-label="How many left">
        <button class="btn-danger btn-small" data-del>Remove</button>
      </div>
    </div>`).join("");
}

$("menuList").addEventListener("change", async (e) => {
  const card = e.target.closest("[data-id]");
  const f = e.target.dataset.f;
  if (!card || !f) return;
  let v = e.target.type === "checkbox" ? e.target.checked : e.target.value.trim();
  if (f === "stock") v = v === "" ? null : Math.max(0, parseInt(v, 10) || 0);
  if (f === "name" && !v) return toast("A drink needs a name.");
  const patch = { [f]: v };
  if (f === "stock" && v > 0) patch.available = true;
  const { error } = await sb.from("menu_items").update(patch).eq("id", card.dataset.id);
  if (error) return toast("Couldn't save that.");
  toast("Saved");
  if (f === "stock" || f === "category") loadMenu();
});
$("menuList").addEventListener("click", async (e) => {
  if (!e.target.hasAttribute("data-del")) return;
  const card = e.target.closest("[data-id]");
  if (e.target.dataset.confirm !== "1") { e.target.dataset.confirm = "1"; e.target.textContent = "Tap to confirm"; return; }
  await sb.from("menu_items").delete().eq("id", card.dataset.id);
  loadMenu();
});
$("addForm").onsubmit = async (e) => {
  e.preventDefault();
  const stock = $("mStock").value === "" ? null : parseInt($("mStock").value, 10);
  const { error } = await sb.from("menu_items").insert({
    name: $("mName").value.trim(), description: $("mDesc").value.trim(), category: $("mCat").value.trim() || "Cocktails",
    stock, available: stock !== 0, sort: menu.length + 1,
  });
  if (error) return toast("Couldn't add that drink.");
  $("mName").value = ""; $("mDesc").value = ""; $("mStock").value = "";
  toast("Added to the menu");
  loadMenu();
};

// ---------- Hours ----------
async function loadSettings() {
  const { data } = await sb.from("settings").select("*").eq("id", 1).single();
  settings = data;
  renderHours();
}
function renderHours() {
  document.querySelectorAll("#mode button").forEach((b) => b.classList.toggle("on", b.dataset.mode === settings.mode));
  $("modeHint").textContent = {
    auto: "Opens and closes on its own using the schedule below.",
    open: "Open until you change it, whatever the schedule says.",
    closed: "Closed until you change it. Guests can still see the menu.",
  }[settings.mode];
  const order = [1, 2, 3, 4, 5, 6, 0];
  $("days").innerHTML = order.map((i) => {
    const d = settings.schedule[String(i)];
    return `<div class="day" data-day="${i}">
      <b>${DAYS[i]}</b>
      <label class="switch"><input type="checkbox" data-k="on" ${d.on ? "checked" : ""}><span></span></label>
      <input type="time" data-k="open" value="${d.open}" aria-label="${DAYS[i]} opens">
      <input type="time" data-k="close" value="${d.close}" aria-label="${DAYS[i]} closes">
    </div>`;
  }).join("");
  $("barNameIn").value = settings.bar_name;
  $("closedMsgIn").value = settings.closed_message;
  const zones = Intl.supportedValuesOf ? Intl.supportedValuesOf("timeZone") : [settings.timezone];
  if (!zones.includes(settings.timezone)) zones.unshift(settings.timezone);
  $("tzIn").innerHTML = zones.map((z) => `<option ${z === settings.timezone ? "selected" : ""}>${z}</option>`).join("");
  setOwnerStatus();
}
$("mode").onclick = async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  const { error } = await sb.from("settings").update({ mode: b.dataset.mode }).eq("id", 1);
  if (error) return toast("Couldn't save.");
  settings.mode = b.dataset.mode;
  renderHours();
  toast(b.dataset.mode === "auto" ? "Following the schedule" : `Bar is now ${b.dataset.mode}`);
};
$("saveHours").onclick = async () => {
  const schedule = {};
  document.querySelectorAll("#days .day").forEach((row) => {
    schedule[row.dataset.day] = {
      on: row.querySelector('[data-k="on"]').checked,
      open: row.querySelector('[data-k="open"]').value || "17:00",
      close: row.querySelector('[data-k="close"]').value || "23:00",
    };
  });
  const patch = {
    schedule, bar_name: $("barNameIn").value.trim() || "Gizmo's Bar",
    closed_message: $("closedMsgIn").value.trim() || "The bar is closed right now.",
    timezone: $("tzIn").value, updated_at: new Date().toISOString(),
  };
  const { error } = await sb.from("settings").update(patch).eq("id", 1);
  if (error) return toast("Couldn't save.");
  Object.assign(settings, patch);
  renderHours();
  toast("Hours saved");
};

// ---------- Push ----------
const standalone = Boolean(matchMedia("(display-mode: standalone)").matches || navigator.standalone);
const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

async function refreshPushState() {
  $("installHelp").classList.toggle("hidden", standalone && pushSupported);
  if (!pushSupported) {
    $("pushState").textContent = "Alerts need this page added to your Home Screen first (steps below).";
    $("pushOn").disabled = true;
    return;
  }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub && Notification.permission === "granted") {
    $("pushState").textContent = "Drink alerts are on for this phone.";
    $("pushOn").textContent = "Re-connect drink alerts";
  } else if (Notification.permission === "denied") {
    $("pushState").textContent = "Alerts are blocked. Turn them on in Settings → Notifications → Gizmo's Bar.";
  } else {
    $("pushState").textContent = "Alerts are off. Tap below to turn them on.";
  }
}

function b64ToBytes(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

$("pushOn").onclick = async () => {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { toast("Alerts weren't allowed."); return refreshPushState(); }
    const { data: cfg } = await sb.from("app_config").select("value").eq("key", "vapid_public").single();
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (sub) await sub.unsubscribe();
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(cfg.value) });
    const { error } = await sb.from("push_subscriptions").upsert({ endpoint: sub.endpoint, subscription: sub.toJSON(), user_id: user.id });
    if (error) throw error;
    toast("Drink alerts are on!");
  } catch (err) {
    console.error(err);
    toast("Couldn't turn on alerts. Try again from the Home Screen app.");
  }
  refreshPushState();
};

$("pushTest").onclick = async () => {
  try {
    const { data: { session } } = await sb.auth.getSession();
    const { sent } = await callFn({ action: "test" }, session.access_token);
    toast(sent ? `Test sent to ${sent} phone${sent > 1 ? "s" : ""}` : "No phones have alerts turned on yet.");
  } catch (err) { toast(err.message); }
};

boot();
