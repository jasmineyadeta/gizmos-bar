import { sb, configured, callFn, isOpen, hoursText, toast, esc, showLoader, hideLoader, gizmoSvg, sleep } from "./common.js";

const $ = (id) => document.getElementById(id);
let settings = null;
let menu = [];
let picked = null;

$("heroGizmo").innerHTML = gizmoSvg();
$("placedGizmo").innerHTML = gizmoSvg();
$("placedGizmo").querySelector("svg").style.cssText = "width:150px;height:171px";

const nameInput = $("name");
try { nameInput.value = localStorage.getItem("guestName") || ""; } catch {}
nameInput.addEventListener("input", () => { try { localStorage.setItem("guestName", nameInput.value.trim()); } catch {} });

async function load(first) {
  if (!configured) { $("status").textContent = "Setting up..."; return; }
  if (first) showLoader("Gizmo's opening up...");
  const started = Date.now();
  const [s, m, ing] = await Promise.all([
    sb.from("settings").select("*").eq("id", 1).single(),
    sb.from("menu_items").select("*").order("sort").order("name"),
    sb.from("ingredients").select("key, name, in_stock, top_shelf"),
  ]);
  if (first) await sleep(Math.max(0, 1200 - (Date.now() - started)));
  hideLoader();
  if (s.error || m.error) { toast("Couldn't reach the bar. Pull down to retry."); return; }
  settings = s.data;
  menu = m.data;
  missing = new Map((ing.data || []).filter((x) => !x.in_stock).map((x) => [x.key, x.name]));
  topShelf = new Map((ing.data || []).filter((x) => x.in_stock && x.top_shelf).map((x) => [x.key, x.top_shelf]));
  render();
}

function render() {
  const open = isOpen(settings);
  document.title = settings.bar_name;
  $("barName").textContent = settings.bar_name;
  $("status").textContent = open ? "Open" : "Closed";
  $("status").className = `pill ${open ? "open" : "closed"}`;
  $("hours").textContent = settings.mode === "auto" ? hoursText(settings) : "";
  $("closed").classList.toggle("hidden", open);
  $("closedMsg").textContent = settings.closed_message;

  renderBrowse(open);
  $("board").classList.toggle("hidden", settings.show_board === false);
  $("boardLink").classList.toggle("hidden", settings.show_board === false);
  if (settings.show_board !== false) loadBoard();
  loadIdeas();
}

// ---------- Suggestion box ----------
// No accounts: each phone gets a random id so it can vote once per idea.
const voter = (() => {
  try {
    let v = localStorage.getItem("voterId");
    if (!v) { v = crypto.randomUUID(); localStorage.setItem("voterId", v); }
    return v;
  } catch { return crypto.randomUUID(); }
})();
let ideaKind = "drink";
const STATUS = { planned: "⚓ Planned", done: "✅ Done" };
async function loadIdeas() {
  const { data, error } = await sb.rpc("request_board", { p_voter: voter });
  if (error) return;
  $("ideaList").innerHTML = (data || []).map((r) => `
    <li class="idea ${r.status}">
      <button class="vote ${r.mine ? "on" : ""}" data-vote="${r.id}" aria-pressed="${r.mine}" aria-label="Thumbs up">👍<b>${r.votes}</b></button>
      <div class="t"><span class="k">${r.kind === "drink" ? "🍹" : "💡"}</span> ${esc(r.body)}
        <small>${r.author ? `from ${esc(r.author)}` : ""}${STATUS[r.status] ? ` <span class="st">${STATUS[r.status]}</span>` : ""}</small></div>
    </li>`).join("") || `<li class="empty-board">No suggestions yet. Be the first!</li>`;
}
$("ideaKind").onclick = (e) => {
  const b = e.target.closest("[data-k]"); if (!b) return;
  ideaKind = b.dataset.k;
  document.querySelectorAll("#ideaKind button").forEach((x) => x.classList.toggle("on", x === b));
  $("ideaText").placeholder = ideaKind === "drink" ? "e.g. Add an espresso martini" : "e.g. Let me save my favourite drink";
};
$("ideaForm").onsubmit = async (e) => {
  e.preventDefault();
  const body = $("ideaText").value.trim();
  if (body.length < 3) return toast("Type a few more words first.");
  $("ideaSend").disabled = true;
  const { error } = await sb.rpc("add_request", { p_body: body, p_kind: ideaKind, p_author: nameInput.value.trim(), p_voter: voter });
  $("ideaSend").disabled = false;
  if (error) return toast(error.message.includes("TOO_MANY") ? "That's plenty of ideas for today. Thanks!" : "Couldn't post that. Try again?");
  $("ideaText").value = "";
  toast("Thanks! Posted to the suggestion box.");
  loadIdeas();
};
$("ideaList").onclick = async (e) => {
  const b = e.target.closest("[data-vote]"); if (!b) return;
  b.disabled = true;
  const { error } = await sb.rpc("toggle_vote", { p_id: b.dataset.vote, p_voter: voter });
  if (error) { b.disabled = false; return toast("Couldn't save your vote."); }
  loadIdeas();
};

// ---------- Crew leaderboard ----------
const RANKS = ["🧑‍✈️ Captain", "⚓ First Mate", "🪢 Bosun"];
async function loadBoard() {
  const { data, error } = await sb.rpc("leaderboard", { p_scope: "all" });
  if (error) return;
  const me = nameInput.value.trim().replace(/\s+/g, " ");
  $("boardList").innerHTML = (data || []).map((r, i) => `
    <li class="${r.name === me ? "me" : ""}">
      <span class="rk">${i + 1}</span>
      <span class="who"><b>${esc(r.name)}</b><small>${RANKS[i] || "Deckhand"}</small></span>
      <span class="n">${r.drinks} <small>drink${r.drinks == 1 ? "" : "s"}</small></span>
    </li>`).join("") ||
    `<li class="empty-board">No drinks yet. First order makes you Captain!</li>`;
}

const MOODS = [
  { key: "fizzy", label: "🫧 Fizzy", tags: ["fizzy"] },
  { key: "citrusy", label: "🍋 Citrusy", tags: ["citrusy", "tart"] },
  { key: "strong", label: "🥃 Strong", tags: ["strong", "stirred"] },
  { key: "fruity", label: "🍓 Fruity", tags: ["fruity"] },
  { key: "sweet", label: "🍬 Sweet", tags: ["sweet"] },
  { key: "warming", label: "🔥 Warming", tags: ["warming", "spicy"] },
  { key: "savory", label: "🌶️ Savory", tags: ["savory"] },
];
let mood = null;
let spirit = null;
let missing = new Map();
let topShelf = new Map();
const PLACEHOLDER = "drinks/placeholder.svg";
const isOut = (d) => !d.available || d.stock === 0 || (d.needs || []).some((k) => missing.has(k));

function outLabel(d) {
  const k = (d.needs || []).find((x) => missing.has(x));
  return k && d.available && d.stock !== 0 ? `Out of ${missing.get(k).split(" /")[0].toLowerCase()}` : "All out";
}

function filtered() {
  const m = MOODS.find((x) => x.key === mood);
  return menu.filter((d) =>
    (!spirit || d.category === spirit) &&
    (!m || (d.tags || []).some((t) => m.tags.includes(t))));
}

function renderBrowse(open) {
  const usedTags = new Set(menu.flatMap((d) => d.tags || []));
  const moods = MOODS.filter((m) => m.tags.some((t) => usedTags.has(t)));
  $("moods").innerHTML = moods.map((m) =>
    `<button class="chip ${mood === m.key ? "on" : ""}" data-mood="${m.key}">${m.label}</button>`).join("");
  const ORDER = ["By the glass", "Gin", "Vodka", "Tequila", "Rum", "Whisky", "Wine & Brandy", "Highballs"];
  const COVER = { "By the glass": "Glass of red wine", Gin: "Dry Martini", Vodka: "Moscow Mule", Tequila: "Margarita", Rum: "Mojito", Whisky: "Old Fashioned", "Wine & Brandy": "Kir Royale" };
  const rank = (c) => (ORDER.indexOf(c) + 1) || 99;
  const spirits = [...new Set(menu.map((d) => d.category))].sort((a, b) => rank(a) - rank(b));
  const cover = (c) => {
    const inCat = menu.filter((d) => d.category === c);
    return (inCat.find((d) => d.name === COVER[c] && d.image) || inCat.find((d) => d.image))?.image || PLACEHOLDER;
  };
  $("spirits").innerHTML = [`<button class="circ ${!spirit ? "on" : ""}" data-spirit=""><span class="ring all">⚓</span>All</button>`]
    .concat(spirits.map((c) => `<button class="circ ${spirit === c ? "on" : ""}" data-spirit="${esc(c)}"><span class="ring"><img src="${esc(cover(c))}" alt=""></span>${esc(c)}</button>`)).join("");
  const sel = $("spirits").querySelector(".on");
  if (sel && spirit) sel.scrollIntoView({ block: "nearest", inline: "nearest" });

  const list = filtered().sort((a, b) => isOut(a) - isOut(b));
  const avail = list.filter((d) => !isOut(d)).length;
  const moodName = MOODS.find((x) => x.key === mood)?.label.split(" ").slice(1).join(" ").toLowerCase();
  const kind = spirit && !["Highballs", "Wine & Brandy", "By the glass"].includes(spirit) ? `${spirit.toLowerCase()} ` : "";
  $("count").textContent = list.length
    ? `${avail} ${kind}drink${avail === 1 ? "" : "s"}${spirit && !kind ? (spirit === "By the glass" ? " by the glass" : ` in ${spirit}`) : ""}${moodName ? ` · ${moodName}` : ""}${!mood && !spirit ? " on the menu" : ""}`
    : "";
  $("surprise").disabled = !open || !avail;
  $("menu").innerHTML = list.map((d) => {
    const out = isOut(d);
    return `<button class="tile ${out ? "out" : ""}" data-id="${d.id}" ${out || !open ? "disabled" : ""}>
      <img src="${esc(d.image || PLACEHOLDER)}" alt="" loading="lazy">
      ${out ? `<span class="badge-out">${esc(outLabel(d))}</span>` : ""}
      <b>${esc(d.name)}</b>
    </button>`;
  }).join("") || `<p class="muted empty">Nothing matches. Try another mood or spirit.</p>`;
}

$("moods").addEventListener("click", (e) => {
  const b = e.target.closest("[data-mood]"); if (!b) return;
  mood = mood === b.dataset.mood ? null : b.dataset.mood;
  renderBrowse(isOpen(settings));
});
$("spirits").addEventListener("click", (e) => {
  const b = e.target.closest("[data-spirit]"); if (!b) return;
  spirit = b.dataset.spirit || null;
  renderBrowse(isOpen(settings));
});

function needName() {
  if (nameInput.value.trim()) return false;
  toast("Pop your name in first!");
  nameInput.focus();
  return true;
}

$("surprise").onclick = async () => {
  if (needName()) return;
  const pool = filtered().filter((d) => !isOut(d));
  if (!pool.length) return;
  showLoader("Gizmo's picking for you...");
  await sleep(1400);
  hideLoader();
  openDrink(pool[Math.floor(Math.random() * pool.length)], true);
};

function openDrink(d, surprise) {
  picked = d;
  $("sheetName").textContent = (surprise ? "🎲 " : "") + picked.name;
  const parts = (picked.description || "").split(" · ").filter(Boolean);
  $("sheetDesc").innerHTML = parts.length > 1
    ? `<ul class="recipe">${parts.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : esc(parts[0] || "");
  $("sheetImg").src = picked.image || PLACEHOLDER;
  $("sheetImg").classList.toggle("contain", $("sheetImg").src.endsWith(".svg"));
  $("notes").value = "";
  const bottles = [...new Set((d.needs || []).filter((k) => topShelf.has(k)).map((k) => topShelf.get(k)))];
  $("topOpt").classList.toggle("hidden", !bottles.length);
  $("topName").textContent = bottles.length ? `(${bottles.join(", ")})` : "";
  $("topChk").checked = false;
  openSheet(true);
}

$("menu").addEventListener("click", (e) => {
  const b = e.target.closest(".tile");
  if (!b || b.disabled || needName()) return;
  openDrink(menu.find((d) => d.id === b.dataset.id));
});

function openSheet(on) {
  $("sheet").classList.toggle("show", on);
  $("sheetBg").classList.toggle("show", on);
}
$("sheetBg").onclick = $("cancelBtn").onclick = () => openSheet(false);

$("orderBtn").onclick = async () => {
  const name = nameInput.value.trim();
  openSheet(false);
  showLoader("Sending to Gizmo...");
  const started = Date.now();
  try {
    const { id } = await callFn({ action: "order", name, item_id: picked.id, notes: $("notes").value, top_shelf: $("topChk").checked && !$("topOpt").classList.contains("hidden") });
    await sleep(Math.max(0, 1800 - (Date.now() - started)));
    hideLoader();
    showPlaced(name, picked.name, id);
  } catch (err) {
    hideLoader();
    toast(err.message);
    load();
  }
};

let pollTimer;
function showPlaced(name, drink, id) {
  $("placedTitle").textContent = "Gizmo's on it!";
  $("placedText").textContent = `${drink} for ${name}. We'll let you know here when it's ready.`;
  $("placed").classList.remove("hidden");
  $("nameCard").classList.add("hidden");
  $("browse").classList.add("hidden");
  if (settings.show_board !== false) loadBoard();
  window.scrollTo({ top: 0, behavior: "smooth" });
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const { data } = await sb.rpc("order_status", { p_id: id });
    if (data === "done") {
      clearInterval(pollTimer);
      $("placedTitle").textContent = "Your drink is ready!";
      $("placedText").textContent = `Come grab your ${drink}, ${name}. Cheers!`;
      if (navigator.vibrate) navigator.vibrate(200);
    }
  }, 5000);
}

$("again").onclick = () => {
  clearInterval(pollTimer);
  $("placed").classList.add("hidden");
  $("nameCard").classList.remove("hidden");
  $("browse").classList.remove("hidden");
  load();
};

document.addEventListener("visibilitychange", () => { if (!document.hidden && configured) load(); });
load(true);
