// Look-only browser check of the live guest site on phone and iPad sizes.
// Never places an order or posts anything.
import { chromium, devices } from "playwright";
import { mkdirSync } from "fs";
const SITE = process.env.SITE;
mkdirSync("shots", { recursive: true });
const b = await chromium.launch();
let failed = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) failed++; };
for (const dev of ["iPhone 13", "iPad Mini", "iPad Mini landscape"]) {
  const ctx = await b.newContext({ ...devices[dev], serviceWorkers: "block" });
  const p = await ctx.newPage();
  const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(SITE + "?t=" + Date.now(), { waitUntil: "networkidle" });
  await p.waitForTimeout(3500);
  const status = (await p.textContent("#status"))?.trim();
  ok(`${dev}: bar status shows (${status})`, status === "Open" || status === "Closed");
  const tiles = await p.locator(".tile").count();
  ok(`${dev}: menu shows ${tiles} drinks`, tiles >= 10);
  ok(`${dev}: spirit circles`, (await p.locator("[data-spirit]").count()) >= 5);
  ok(`${dev}: suggestion box`, await p.isVisible("#ideaForm"));
  ok(`${dev}: no sideways scroll`, await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await p.screenshot({ path: `shots/${dev.replace(/ /g, "_")}.png` });
  await p.fill("#name", "Live check");
  await p.click(".tile:not(.out)");
  await p.waitForTimeout(600);
  if (status === "Closed") ok(`${dev}: closed tap shows napping toast`, /napping/.test(await p.evaluate(() => document.body.innerText)));
  else {
    ok(`${dev}: tapping a drink opens the order sheet`, await p.evaluate(() => document.getElementById("sheet").classList.contains("show")));
    await p.screenshot({ path: `shots/${dev.replace(/ /g, "_")}-sheet.png` });
    await p.click("#cancelBtn");
  }
  ok(`${dev}: no script errors ${errs.join(" | ")}`, errs.length === 0);
  await ctx.close();
}
const a = await b.newPage();
await a.goto(SITE + "admin.html", { waitUntil: "networkidle" });
await a.waitForTimeout(2500);
ok("admin page loads and asks for the family link", (await a.evaluate(() => document.body.innerText)).length > 20);
await a.screenshot({ path: "shots/admin-locked.png" });
await b.close();
process.exit(failed ? 1 : 0);
