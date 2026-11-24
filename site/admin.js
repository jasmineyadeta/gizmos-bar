import { makeClient, configured, callFn, isOpen, DAYS, toast, esc, showLoader, hideLoader, gizmoSvg } from "./common.js";

const $ = (id) => document.getElementById(id);
let settings = null;
let menu = [];

$("authGizmo").innerHTML = gizmoSvg();
$("guestLink").href = new URL("./", location.href).href;
$("guestLink").textContent = new URL("./", location.href).href;
$("qr").src = "qr.png";

// ---------- Family admin link ----------
// The link looks like admin.html?k=CODE. The code is remembered on this device,
// and sent with every change so the database knows it's family.
let sb = null;
let key = "";

function readKey(text) {
  const t = String(text || "").trim();
  try { return new URL(t).searchParams.get("k") || ""; } catch { return t; }
}
function saveKey(k) { try { localStorage.setItem("barKey", k); } catch {} }
function loadKey() { try { return localStorage.getItem("barKey") || ""; } catch { return ""; } }

async function tryKey(k) {
  if (!k) return false;
  const client = makeClient({ "x-bar-key": k });
  const { data } = await client.rpc("has_admin_key");
  if (data !== true) return false;
  sb = client; key = k; saveKey(k);
  return true;
}

async function boot() {
  if (!configured) { document.body.innerHTML = "<main><p>Still being set up. Check back soon.</p></main>"; return; }
  showLoader("Gizmo's warming up...");
  const fromUrl = new URLSearchParams(location.search).get("k");
  if (await tryKey(fromUrl || loadKey())) return startApp();
  hideLoader();
  if (fromUrl) $("authHint").textContent = "That link doesn't work anymore. Ask for the new one.";
  $("authView").classList.remove("hidden");
}

$("authForm").onsubmit = async (e) => {
  e.preventDefault();
  showLoader("Checking...");
  if (await tryKey(readKey($("keyIn").value))) { $("authView").classList.add("hidden"); return startApp(); }
  hideLoader();
  toast("That link or code doesn't work.");
};

$("signOut").onclick = async () => {
  if ($("signOut").dataset.confirm !== "1") { $("signOut").dataset.confirm = "1"; $("signOut").textContent = "Tap again to forget this phone"; return; }
  await turnOffPush();
  try { localStorage.removeItem("barKey"); } catch {}
  location.href = "./admin.html";
};

// ---------- App ----------
async function startApp() {
  await loadIngredients();
  await Promise.all([loadSettings(), loadMenu()]);
  await loadOrders();
  renderStock();
  loadRequests();
  hideLoader();
  $("appView").classList.remove("hidden");
  refreshPushState();
  setInterval(() => { if (!document.hidden) loadOrders(); }, 8000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) loadOrders(); });
  if (location.hash) showTab(location.hash.slice(1));
}

function showTab(name) {
  if (!document.querySelector(`[data-panel="${name}"]`)) return;
  if (name === "hours") loadCrew();
  if (name === "requests") loadRequests();
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
  const tz = settings?.timezone;
  const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", ...(tz ? { timeZone: tz } : {}) });
  const ago = (t) => {
    const m = Math.round((Date.now() - new Date(t)) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m} min ago`;
    const h = Math.floor(m / 60);
    return h < 24 ? `${h} hr ${m % 60 ? `${m % 60} min ` : ""}ago` : new Date(t).toLocaleDateString([], { month: "short", day: "numeric", ...(tz ? { timeZone: tz } : {}) });
  };
  const open = new Set([...document.querySelectorAll("#orders details[open]")].map((d) => d.dataset.order));
  const howTo = (o) => {
    const d = menu.find((x) => x.id === o.item_id);
    const lowMark = (r) => ingredients.some((i) => i.key === r.key && i.low && i.in_stock) ? " (running low)" : "";
    const rows = d?.recipe?.length ? d.recipe.map((r) => rowText(r) + lowMark(r)) : (d?.description || "").split(" · ").filter(Boolean);
    if (!rows.length) return "";
    return `<details class="howto" data-order="${o.id}" ${open.has(o.id) ? "open" : ""}><summary>How to make it</summary>
      <ul class="recipe">${rows.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></details>`;
  };
  const list = [...fresh.reverse(), ...data.filter((o) => o.status === "done")];
  $("orders").innerHTML = list.map((o) => `
    <div class="card order ${o.status}">
      <div class="row" style="flex-wrap:nowrap;align-items:flex-start">
        <div class="t">
          <div class="who">${esc(o.guest_name)}</div>
          <div class="what">${esc(o.item_name)}</div>
          ${o.top_shelf ? `<div class="top">⭐ Top shelf: ${esc(o.top_shelf)}</div>` : ""}
          ${o.notes ? `<div class="note">"${esc(o.notes)}"</div>` : ""}
          <div class="time">Ordered ${clock(o.created_at)} · ${ago(o.created_at)}</div>
        </div>
        ${o.status === "new" ? `<button class="btn" data-done="${o.id}">Served</button>` : `<span class="small muted">Served</span>`}
      </div>
      ${o.status === "new" ? howTo(o) : ""}
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

// ---------- Stock (ingredients) ----------
const GROUPS = ["Spirits", "Liqueurs & wine", "Mixers & juice", "Fruit & garnish", "Pantry"];
let ingredients = [];
const ingName = (k) => ingredients.find((i) => i.key === k)?.name || k;
const usedBy = (k) => menu.filter((d) => (d.needs || []).includes(k));
const grouped = () => {
  const gs = [...GROUPS, ...new Set(ingredients.map((i) => i.grp).filter((g) => !GROUPS.includes(g)))];
  return gs.map((g) => [g, ingredients.filter((i) => i.grp === g)]).filter(([, l]) => l.length);
};

async function loadIngredients() {
  const { data } = await sb.from("ingredients").select("*").order("sort").order("name");
  ingredients = data || [];
}
const TOP_SHELF_GROUPS = ["Spirits"];
const stateOf = (i) => !i.in_stock ? "out" : i.low ? "low" : "in";
function renderStock() {
  const outCount = ingredients.filter((i) => !i.in_stock).length;
  $("stockBadge").textContent = outCount;
  $("stockBadge").classList.toggle("hidden", !outCount);
  $("stockList").innerHTML = grouped().map(([g, list]) => `<h3 class="grp-h">${esc(g)}</h3>` + list.map((i) => {
    const st = stateOf(i);
    const need = usedBy(i.key).map((d) => d.name);
    const garnish = menu.filter((d) => !need.includes(d.name) && (d.recipe || []).some((r) => r.key === i.key)).map((d) => d.name);
    const hint = [
      need.length ? `${st === "out" ? "Hidden from guests" : "Needed for"}: ${need.map(esc).join(", ")}` : "",
      garnish.length ? `Garnish on: ${garnish.map(esc).join(", ")}` : "",
    ].filter(Boolean).join("<br>") || "Not in any drink yet";
    const top = TOP_SHELF_GROUPS.includes(i.grp)
      ? `<label class="topshelf">⭐ Top shelf bottle <input data-top="${esc(i.key)}" value="${esc(i.top_shelf || "")}" maxlength="60" placeholder="e.g. Macallan 12 (leave blank if none)"></label>` : "";
    return `<div class="ing ${st}" data-ing="${esc(i.key)}">
      <div class="t"><span class="n">${esc(i.name)}</span><br><span class="d">${hint}</span></div>
      <div class="seg3" role="group" aria-label="${esc(i.name)} stock">
        <button data-st="in" class="${st === "in" ? "on" : ""}">Got it</button>
        <button data-st="low" class="${st === "low" ? "on" : ""}">Running low</button>
        <button data-st="out" class="${st === "out" ? "on" : ""}">Out</button>
      </div>
      ${top}
    </div>`;
  }).join("")).join("");
  $("ingGrp").innerHTML = GROUPS.map((g) => `<option>${esc(g)}</option>`).join("");
}
$("stockList").onclick = async (e) => {
  const b = e.target.closest("[data-st]"); if (!b) return;
  const ing = ingredients.find((i) => i.key === b.closest("[data-ing]").dataset.ing);
  const was = stateOf(ing), next = b.dataset.st;
  if (was === next) return;
  const patch = { in_stock: next !== "out", low: next === "low" };
  const { error } = await sb.from("ingredients").update(patch).eq("key", ing.key);
  if (error) return toast("Couldn't save that.");
  Object.assign(ing, patch);
  const n = usedBy(ing.key).length, drinks = `${n} drink${n > 1 ? "s" : ""}`;
  toast(next === "out" ? `Out of ${ing.name}${n ? `. ${drinks} switched off` : ""}`
    : next === "low" ? `${ing.name} is running low. Guests can still order.`
    : `${ing.name} is stocked${was === "out" && n ? `. ${drinks} back on` : ""}`);
  renderStock(); renderMenu();
};
$("stockList").addEventListener("change", async (e) => {
  const k = e.target.dataset.top; if (!k) return;
  const v = e.target.value.trim() || null;
  const { error } = await sb.from("ingredients").update({ top_shelf: v }).eq("key", k);
  if (error) return toast("Couldn't save that.");
  ingredients.find((i) => i.key === k).top_shelf = v;
  toast(v ? `Guests can now ask for ${v}` : "Top shelf option removed");
});
$("ingForm").onsubmit = async (e) => {
  e.preventDefault();
  const name = $("ingName").value.trim();
  const key = name.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || `ing_${Date.now()}`;
  if (ingredients.some((i) => i.key === key)) return toast("That one's already on the list.");
  const { error } = await sb.from("ingredients").insert({ key, name, grp: $("ingGrp").value, sort: ingredients.length + 1 });
  if (error) return toast("Couldn't add that.");
  $("ingName").value = "";
  toast(`${name} added`);
  await loadIngredients(); renderStock(); renderMenu();
};

// ---------- Menu ----------
const TAGS = [["fizzy", "🫧 Fizzy"], ["citrusy", "🍋 Citrusy"], ["strong", "🥃 Strong"], ["fruity", "🍓 Fruity"],
  ["sweet", "🍬 Sweet"], ["warming", "🔥 Warming"], ["savory", "🌶️ Savory"]];
const PLACEHOLDER = "drinks/placeholder.svg";
const tagChips = (tags, attr) => TAGS.map(([k, l]) =>
  `<button type="button" class="chip ${(tags || []).includes(k) ? "on" : ""}" ${attr}="${k}">${l}</button>`).join("");

// ----- Recipes: one row per ingredient {key, amt, as}. Mirrors the SQL trigger. -----
const AMOUNTS = ["1/4 oz", "1/2 oz", "3/4 oz", "1 oz", "1 1/2 oz", "2 oz", "3 oz", "4 oz", "1 dash", "2 dashes", "3 dashes",
  "1/2 tsp", "1 tsp", "splash", "to top", "to taste", "garnish", "optional"];
const isOpt = (amt) => /garnish|optional|taste/i.test(amt || "");
const label = (r) => (r.as || "").trim() || (r.key ? ingName(r.key) : "");
const rowText = (r) => {
  const a = (r.amt || "").trim(), l = label(r);
  return !a ? l : /^(to |garnish|optional)/i.test(a) ? `${l}, ${a}` : `${a} ${l}`;
};
const recipeText = (rec) => rec.map(rowText).join(" · ").slice(0, 500);
const recipeNeeds = (rec) => [...new Set(rec.filter((r) => r.key && !isOpt(r.amt)).map((r) => r.key))];
const isMissing = (k) => ingredients.some((i) => i.key === k && !i.in_stock);
const recipeSummary = (d) => {
  const rec = d.recipe || [];
  if (!rec.length) return esc(d.description || "No recipe yet. Tap to add ingredients.");
  return rec.map((r) => r.key && !isOpt(r.amt) && isMissing(r.key) ? `<b>${esc(rowText(r))} (out)</b>` : esc(rowText(r))).join(" · ");
};
const ingOptions = (sel) => `<option value="" ${!sel ? "selected" : ""}>Other (type it below)</option>` +
  grouped().map(([g, list]) => `<optgroup label="${esc(g)}">` +
    list.map((i) => `<option value="${esc(i.key)}" ${i.key === sel ? "selected" : ""}>${esc(i.name)}</option>`).join("") + `</optgroup>`).join("");
const recipeRow = (r = {}) => `<div class="rrow">
    <select data-r="key" aria-label="Ingredient">${ingOptions(r.key)}</select>
    <input data-r="amt" list="amts" value="${esc(r.amt || "")}" placeholder="Amount" aria-label="Amount" autocapitalize="off">
    <button type="button" class="rdel" data-rdel aria-label="Remove ingredient">✕</button>
    <input data-r="as" class="ras" value="${esc(r.as || "")}" maxlength="60" placeholder="Guests see: ${esc(r.key ? ingName(r.key) : "type the ingredient")}" aria-label="What guests see">
  </div>`;
const recipeEditor = (rec) => `<div class="rlist">${(rec.length ? rec : [{}]).map(recipeRow).join("")}</div>
  <button type="button" class="btn-ghost btn-small" data-radd>+ Add ingredient</button>
  <p class="small muted" style="margin:6px 0 0">Use "garnish" or "optional" as the amount for things that shouldn't switch the drink off.</p>`;
const readRecipe = (box) => [...box.querySelectorAll(".rrow")].map((row) => ({
  key: row.querySelector('[data-r="key"]').value,
  amt: row.querySelector('[data-r="amt"]').value.trim(),
  as: row.querySelector('[data-r="as"]').value.trim(),
})).filter((r) => r.key || r.as);

// Shared row behaviour for the add form and every drink card. Returns true when the recipe changed.
function recipeEvent(e) {
  const box = e.target.closest("[data-recipe]");
  if (!box) return false;
  if (e.type === "click" && e.target.closest("[data-radd]")) {
    box.querySelector(".rlist").insertAdjacentHTML("beforeend", recipeRow());
    box.querySelector(".rrow:last-child select").focus();
    return false;
  }
  if (e.type === "click" && e.target.closest("[data-rdel]")) { e.target.closest(".rrow").remove(); return true; }
  if (e.type === "change" && e.target.dataset.r === "key") {
    const as = e.target.closest(".rrow").querySelector('[data-r="as"]');
    as.value = ""; // wording belonged to the old ingredient
    as.placeholder = `Guests see: ${e.target.value ? ingName(e.target.value) : "type the ingredient"}`;
    if (!e.target.value) as.focus();
    return true;
  }
  return e.type === "change" && !!e.target.dataset.r;
}

// Shrink a photo on the phone to a small square JPEG so it loads fast for guests.
async function photoToDataUrl(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = url; });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const c = document.createElement("canvas"); c.width = c.height = 480;
    c.getContext("2d").drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 480, 480);
    return c.toDataURL("image/jpeg", 0.75);
  } finally { URL.revokeObjectURL(url); }
}

async function loadMenu() {
  const { data } = await sb.from("menu_items").select("*").order("sort").order("name");
  menu = data || [];
  renderMenu();
}
function renderMenu() {
  $("cats").innerHTML = [...new Set(menu.map((d) => d.category))].map((c) => `<option value="${esc(c)}">`).join("");
  $("amts").innerHTML = AMOUNTS.map((a) => `<option value="${a}">`).join("");
  if (!$("mTags").children.length) $("mTags").innerHTML = tagChips(newTags, "data-ntag");
  if (!$("mRecipe").children.length) $("mRecipe").innerHTML = recipeEditor([]);
  const open = new Set([...document.querySelectorAll("#menuList details[open]")].map((x) => x.closest("[data-id]").dataset.id));
  $("menuList").innerHTML = menu.map((d) => `
    <div class="card stack" data-id="${d.id}">
      <div class="row" style="flex-wrap:nowrap">
        <label class="edit-img" title="Change photo"><img src="${esc(d.image || PLACEHOLDER)}" alt=""><span>${d.image ? "Change" : "Add photo"}</span><input type="file" accept="image/*" data-img hidden></label>
        <input class="grow" data-f="name" value="${esc(d.name)}" maxlength="80" aria-label="Drink name">
        <label class="switch" title="Available"><input type="checkbox" data-f="available" ${d.available ? "checked" : ""}><span></span></label>
      </div>
      <details class="needs" ${open.has(d.id) ? "open" : ""}><summary><span class="needs-note">${recipeSummary(d)}</span> <span class="edit-link">Edit recipe</span></summary>
        <div data-recipe>${recipeEditor(d.recipe || [])}</div></details>
      <div class="chips small">${tagChips(d.tags, "data-tag")}</div>
      <div class="row">
        <input class="grow" data-f="category" value="${esc(d.category)}" list="cats" maxlength="40" aria-label="Section">
        <input style="width:90px" data-f="stock" type="number" min="0" inputmode="numeric" value="${d.stock ?? ""}" placeholder="No limit" aria-label="How many left">
        <button class="btn-danger btn-small" data-del>Remove</button>
      </div>
    </div>`).join("");
}

async function saveItem(id, patch, msg = "Saved") {
  const { error } = await sb.from("menu_items").update(patch).eq("id", id);
  if (error) { toast("Couldn't save that."); return false; }
  Object.assign(menu.find((d) => d.id === id), patch);
  toast(msg);
  return true;
}
async function saveRecipe(card) {
  const d = menu.find((x) => x.id === card.dataset.id);
  const recipe = readRecipe(card.querySelector("[data-recipe]"));
  if (!(await saveItem(d.id, { recipe }, "Recipe saved"))) return;
  d.needs = recipeNeeds(recipe); d.description = recipeText(recipe); // the database works these out the same way
  card.querySelector(".needs-note").innerHTML = recipeSummary(d);
  renderStock();
}
const toggle = (arr, k) => (arr || []).includes(k) ? arr.filter((x) => x !== k) : [...(arr || []), k];

$("menuList").addEventListener("change", async (e) => {
  const card = e.target.closest("[data-id]");
  if (!card) return;
  if (recipeEvent(e)) return saveRecipe(card);
  if (e.target.hasAttribute("data-img")) {
    const file = e.target.files[0]; if (!file) return;
    showLoader("Saving photo...");
    try { if (await saveItem(card.dataset.id, { image: await photoToDataUrl(file) }, "Photo saved")) renderMenu(); }
    catch { toast("Couldn't read that photo."); }
    hideLoader();
    return;
  }
  const f = e.target.dataset.f;
  if (!f) return;
  let v = e.target.type === "checkbox" ? e.target.checked : e.target.value.trim();
  if (f === "stock") v = v === "" ? null : Math.max(0, parseInt(v, 10) || 0);
  if (f === "name" && !v) return toast("A drink needs a name.");
  const patch = { [f]: v };
  if (f === "stock" && v > 0) patch.available = true;
  if (await saveItem(card.dataset.id, patch) && (f === "stock" || f === "category")) renderMenu();
});
$("menuList").addEventListener("click", async (e) => {
  const card = e.target.closest("[data-id]");
  if (!card) return;
  if (recipeEvent(e)) return saveRecipe(card);
  const d = menu.find((x) => x.id === card.dataset.id);
  const t = e.target.closest("[data-tag]");
  if (t) {
    if (await saveItem(d.id, { tags: toggle(d.tags, t.dataset.tag) })) t.classList.toggle("on");
    return;
  }
  if (!e.target.hasAttribute("data-del")) return;
  if (e.target.dataset.confirm !== "1") { e.target.dataset.confirm = "1"; e.target.textContent = "Tap to confirm"; return; }
  await sb.from("menu_items").delete().eq("id", d.id);
  await loadMenu(); renderStock();
});

let newTags = [], newImage = null;
$("mTags").onclick = (e) => { const b = e.target.closest("[data-ntag]"); if (!b) return; newTags = toggle(newTags, b.dataset.ntag); b.classList.toggle("on"); };
$("mRecipe").addEventListener("click", recipeEvent);
$("mRecipe").addEventListener("change", recipeEvent);
$("mImg").onchange = async () => {
  const file = $("mImg").files[0]; if (!file) return;
  try { newImage = await photoToDataUrl(file); $("mImgPrev").src = newImage; } catch { toast("Couldn't read that photo."); }
};
$("addForm").onsubmit = async (e) => {
  e.preventDefault();
  const stock = $("mStock").value === "" ? null : parseInt($("mStock").value, 10);
  const recipe = readRecipe($("mRecipe"));
  const { error } = await sb.from("menu_items").insert({
    name: $("mName").value.trim(), category: $("mCat").value.trim() || "Cocktails",
    stock, available: stock !== 0, sort: menu.length + 1, image: newImage, tags: newTags,
    recipe, needs: recipeNeeds(recipe), description: recipeText(recipe),
  });
  if (error) return toast("Couldn't add that drink.");
  $("mName").value = ""; $("mStock").value = ""; $("mImg").value = "";
  newTags = []; newImage = null; $("mImgPrev").src = PLACEHOLDER; $("mTags").innerHTML = ""; $("mRecipe").innerHTML = "";
  toast("Added to the menu");
  await loadMenu(); renderStock();
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
  $("showBoard").checked = settings.show_board !== false;
}
$("showBoard").onchange = async () => {
  const v = $("showBoard").checked;
  const { error } = await sb.from("settings").update({ show_board: v }).eq("id", 1);
  if (error) return toast("Couldn't save.");
  settings.show_board = v;
  toast(v ? "Leaderboard is showing" : "Leaderboard hidden from guests");
};
const ADMIN_VOTER = "00000000-0000-0000-0000-000000000000";
async function loadRequests() {
  const { data, error } = await sb.rpc("request_board", { p_voter: ADMIN_VOTER, p_all: true });
  if (error) { $("reqList").innerHTML = `<p class="muted">Couldn't load ideas.</p>`; return; }
  const list = data || [];
  const fresh = list.filter((r) => r.status === "open" && !r.hidden).length;
  $("ideaBadge").textContent = fresh; $("ideaBadge").classList.toggle("hidden", !fresh);
  if (!list.length) { $("reqList").innerHTML = `<div class="card"><p class="muted" style="margin:0">No ideas yet. Guests can post them from the bottom of the menu.</p></div>`; return; }
  $("reqList").innerHTML = list.map((r) => `
    <div class="card req${r.hidden ? " is-hidden" : ""}" data-id="${r.id}">
      <div class="row"><span class="votes">👍 ${r.votes}</span>
        <span class="grow"><b>${esc(r.body)}</b><br><span class="small muted">${r.kind === "drink" ? "🍸 Drink" : "💡 Feature"}${r.author ? " · " + esc(r.author) : ""}${r.hidden ? " · hidden" : ""}</span></span></div>
      <div class="row" style="margin-top:10px">
        <div class="seg seg3 grow">${["open", "planned", "done"].map((s) => `<button data-status="${s}" class="${r.status === s ? "on" : ""}">${s[0].toUpperCase() + s.slice(1)}</button>`).join("")}</div>
        <button class="btn-ghost btn-small" data-hide="${r.hidden ? "0" : "1"}">${r.hidden ? "Unhide" : "Hide"}</button>
      </div>
    </div>`).join("");
}
$("reqList").onclick = async (e) => {
  const b = e.target.closest("button"); const card = e.target.closest(".req"); if (!b || !card) return;
  const p = { p_id: card.dataset.id, p_status: null, p_hidden: null };
  if (b.dataset.status) p.p_status = b.dataset.status;
  else if (b.dataset.hide) p.p_hidden = b.dataset.hide === "1";
  else return;
  const { error } = await sb.rpc("set_request", p);
  if (error) return toast("Couldn't save.");
  toast(b.dataset.status ? `Marked ${b.dataset.status}` : (p.p_hidden ? "Hidden from guests" : "Showing to guests again"));
  loadRequests();
};
let crew = [];
async function loadCrew() {
  const { data, error } = await sb.rpc("crew_names");
  if (error) return;
  crew = data || [];
  const opts = (list) => list.map((c) => `<option value="${esc(c.name)}">${esc(c.name)} (${c.drinks})</option>`).join("");
  const loose = crew.filter((c) => !c.merged_into);
  $("mergeFrom").innerHTML = `<option value="">Pick a name</option>` + opts(loose);
  $("mergeInto").innerHTML = `<option value="">Pick a name</option>` + opts(loose);
  const merged = crew.filter((c) => c.merged_into);
  $("merges").innerHTML = merged.length ? `<label>Merged</label>` + merged.map((c) => `
    <div class="merged"><span><b>${esc(c.name)}</b> → ${esc(c.merged_into)} <span class="muted small">(${c.drinks})</span></span>
      <button class="btn-ghost btn-small" data-unmerge="${esc(c.name)}">Unmerge</button></div>`).join("") : "";
}
$("mergeBtn").onclick = async () => {
  const f = $("mergeFrom").value, t = $("mergeInto").value;
  if (!f || !t) return toast("Pick both names first.");
  if (f === t) return toast("Pick two different names.");
  const { error } = await sb.rpc("merge_names", { p_from: f, p_into: t });
  if (error) return toast("Couldn't merge.");
  toast(`${f} now counts as ${t}`);
  loadCrew();
};
$("merges").onclick = async (e) => {
  const n = e.target.dataset.unmerge; if (!n) return;
  const { error } = await sb.rpc("unmerge_name", { p_alias: n });
  if (error) return toast("Couldn't unmerge.");
  toast(`${n} counts separately again`);
  loadCrew();
};
$("resetBoard").onclick = async () => {
  const b = $("resetBoard");
  if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "Tap again to wipe all counts"; return; }
  const { error } = await sb.rpc("reset_leaderboard");
  b.dataset.confirm = ""; b.textContent = "Reset leaderboard";
  toast(error ? "Couldn't reset." : "Leaderboard wiped. Fresh start!");
  loadCrew();
};
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
    $("pushOff").classList.add("hidden");
    $("pushState").textContent = "Alerts need this page added to your Home Screen first (steps below).";
    $("pushOn").disabled = true;
    return;
  }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  $("pushOff").classList.toggle("hidden", !sub);
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
    const { error } = await sb.from("push_subscriptions").upsert({ endpoint: sub.endpoint, subscription: sub.toJSON() });
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
    const { sent } = await callFn({ action: "test" }, null, { "x-bar-key": key });
    toast(sent ? `Test sent to ${sent} phone${sent > 1 ? "s" : ""}` : "No phones have alerts turned on yet.");
  } catch (err) { toast(err.message); }
};

async function turnOffPush() {
  if (!pushSupported) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  await sb?.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
  await sub.unsubscribe();
}
$("pushOff").onclick = async () => {
  await turnOffPush();
  toast("Alerts are off on this phone.");
  refreshPushState();
};

boot();
