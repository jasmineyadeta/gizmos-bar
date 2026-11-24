// Gizmos Bar edge function.
//   { action: "order", name, item_id, notes }  -> places an order, pushes to Gizmo
//   { action: "test" } (owner auth header)      -> sends a test push
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-bar-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT") ?? "mailto:bar@example.com",
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);

async function pushAll(payload: Record<string, unknown>) {
  const { data: subs } = await admin.from("push_subscriptions").select("endpoint, subscription");
  let sent = 0;
  await Promise.all((subs ?? []).map(async (s) => {
    try {
      await webpush.sendNotification(s.subscription, JSON.stringify(payload), { TTL: 600, urgency: "high" });
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) {
        await admin.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
      } else {
        console.error("push failed", code, (e as Error).message);
      }
    }
  }));
  return sent;
}

const friendly: Record<string, string> = {
  BAR_CLOSED: "Sorry, the bar just closed.",
  SOLD_OUT: "Ah, that one just ran out. Pick another?",
  NO_SUCH_DRINK: "That drink is no longer on the menu.",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }

  if (body.action === "test") {
    const key = req.headers.get("x-bar-key") ?? "";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
    const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
    const { data: row } = await admin.from("admin_key").select("key_hash").eq("id", 1).maybeSingle();
    if (!key || row?.key_hash !== hash) return json({ error: "Open the family admin link first." }, 403);
    const sent = await pushAll({ title: "THIS PERSON NEEDS A DRINK", body: "Test: Gizmo ordered an Old Fashioned", url: "./admin.html", tag: "test" });
    return json({ sent });
  }

  if (body.action === "order") {
    const name = String(body.name ?? "").trim().slice(0, 40);
    const notes = String(body.notes ?? "").trim().slice(0, 200);
    const item = String(body.item_id ?? "");
    if (!name) return json({ error: "Please tell Gizmo your name." }, 400);
    if (!/^[0-9a-f-]{36}$/i.test(item)) return json({ error: "Pick a drink." }, 400);

    const { data: order, error } = await admin.rpc("place_order", { p_name: name, p_item: item, p_notes: notes });
    if (error) {
      const key = Object.keys(friendly).find((k) => error.message.includes(k));
      return json({ error: key ? friendly[key] : "Something went wrong. Try again?" }, key ? 409 : 500);
    }
    const o = order as { id: string; guest_name: string; item_name: string; notes: string };
    await pushAll({
      title: "THIS PERSON NEEDS A DRINK",
      body: `${o.guest_name} ordered ${o.item_name}${o.notes ? ` (${o.notes})` : ""}`,
      url: "./admin.html",
      tag: o.id,
    });
    return json({ id: o.id });
  }

  return json({ error: "Unknown action" }, 400);
});
