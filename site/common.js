import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";
export { showLoader, hideLoader, GIZMO_SVG } from "./gizmo.js";

const cfg = window.BAR_CONFIG || {};
export const configured = Boolean(cfg.url && cfg.anonKey);
export const sb = configured ? createClient(cfg.url, cfg.anonKey) : null;
export const makeClient = (headers) => createClient(cfg.url, cfg.anonKey, { global: { headers }, auth: { persistSession: false } });
export const fnUrl = configured ? `${cfg.url}/functions/v1/bar` : "";

export async function callFn(body, token, extra = {}) {
  const res = await fetch(fnUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: cfg.anonKey,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extra,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}

export const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function localNow(tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return { dow: DAYS.indexOf(get("weekday")), hm: `${get("hour")}:${get("minute")}` };
}

// Mirrors bar_is_open() in schema.sql.
export function isOpen(s) {
  if (!s) return false;
  if (s.mode === "open") return true;
  if (s.mode === "closed") return false;
  const { dow, hm } = localNow(s.timezone);
  const today = s.schedule[String(dow)];
  const yday = s.schedule[String((dow + 6) % 7)];
  if (today?.on) {
    if (today.open <= today.close) { if (hm >= today.open && hm < today.close) return true; }
    else if (hm >= today.open) return true;
  }
  if (yday?.on && yday.open > yday.close && hm < yday.close) return true;
  return false;
}

export function fmtTime(hm) {
  const [h, m] = hm.split(":").map(Number);
  const ampm = h >= 12 ? "pm" : "am";
  const h12 = h % 12 || 12;
  return m ? `${h12}:${String(m).padStart(2, "0")}${ampm}` : `${h12}${ampm}`;
}

export function hoursText(s) {
  if (s.mode === "open") return "Open now";
  if (s.mode === "closed") return "Closed";
  const { dow } = localNow(s.timezone);
  const d = s.schedule[String(dow)];
  return d?.on ? `Today ${fmtTime(d.open)} to ${fmtTime(d.close)}` : "Closed today";
}

export function toast(msg) {
  let t = document.querySelector(".toast");
  if (!t) { t = document.createElement("div"); t.className = "toast"; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("show"), 3200);
}

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
