import { sb, configured, callFn, isOpen, hoursText, toast, esc, showLoader, hideLoader, GIZMO_SVG, sleep } from "./common.js";

const $ = (id) => document.getElementById(id);
let settings = null;
let menu = [];
let picked = null;

$("heroGizmo").innerHTML = GIZMO_SVG;
$("placedGizmo").innerHTML = GIZMO_SVG;
$("placedGizmo").querySelector("svg").style.cssText = "width:150px;height:171px";

const nameInput = $("name");
try { nameInput.value = localStorage.getItem("guestName") || ""; } catch {}
nameInput.addEventListener("input", () => { try { localStorage.setItem("guestName", nameInput.value.trim()); } catch {} });

async function load(first) {
  if (!configured) { $("status").textContent = "Setting up..."; return; }
  if (first) showLoader("Gizmo's opening up...");
  const started = Date.now();
  const [s, m] = await Promise.all([
    sb.from("settings").select("*").eq("id", 1).single(),
    sb.from("menu_items").select("*").order("category").order("sort").order("name"),
  ]);
  if (first) await sleep(Math.max(0, 1200 - (Date.now() - started)));
  hideLoader();
  if (s.error || m.error) { toast("Couldn't reach the bar. Pull down to retry."); return; }
  settings = s.data;
  menu = m.data;
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

  const groups = {};
  for (const d of menu) (groups[d.category] ||= []).push(d);
  $("menu").innerHTML = Object.entries(groups).map(([cat, items]) => `
    <h3 class="cat">${esc(cat)}</h3>
    ${items.map((d) => {
      const out = !d.available || d.stock === 0;
      return `<button class="drink ${out ? "out" : ""}" data-id="${d.id}" ${out || !open ? "disabled" : ""}>
        <div class="t"><div class="n">${esc(d.name)}</div>${d.description ? `<div class="d">${esc(d.description)}</div>` : ""}</div>
        <div class="go">${out ? "All out" : open ? "Order" : ""}</div>
      </button>`;
    }).join("")}
  `).join("") || `<p class="muted">Gizmo hasn't stocked the menu yet.</p>`;
}

$("menu").addEventListener("click", (e) => {
  const b = e.target.closest(".drink");
  if (!b || b.disabled) return;
  if (!nameInput.value.trim()) {
    toast("Pop your name in first!");
    nameInput.focus();
    return;
  }
  picked = menu.find((d) => d.id === b.dataset.id);
  $("sheetName").textContent = picked.name;
  $("sheetDesc").textContent = picked.description;
  $("notes").value = "";
  openSheet(true);
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
    const { id } = await callFn({ action: "order", name, item_id: picked.id, notes: $("notes").value });
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
  $("menu").classList.add("hidden");
  $("nameCard").classList.add("hidden");
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
  $("menu").classList.remove("hidden");
  $("nameCard").classList.remove("hidden");
  load();
};

document.addEventListener("visibilitychange", () => { if (!document.hidden && configured) load(); });
load(true);
