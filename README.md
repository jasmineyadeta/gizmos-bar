# Gizmo's Bar

A free drink-ordering site for Gizmo's home bar. Guests scan a QR code, type their name and pick a drink. Gizmo gets a push on his iPhone: **THIS PERSON NEEDS A DRINK**.

- Guest menu: `https://jasmineyadeta.github.io/gizmos-bar/`
- Owner page: the private family admin link

## How it works
- `site/` is a static web app (no build step), hosted on GitHub Pages.
- Supabase (free tier) stores the menu, hours and orders, handles Gizmo's sign-in, and runs the `bar` edge function that places orders and sends web push.
- `.github/workflows/deploy.yml` sets up everything on each push to `main`: database schema, sign-in settings, push keys (first run), edge function, and the site. It needs one repo secret: `SUPABASE_ACCESS_TOKEN`.
- `.github/workflows/keepalive.yml` pings Supabase every 3 days so the free project doesn't pause.

## Family admin link
Anyone who opens the family admin link (`admin.html?k=CODE`) can manage the bar from their phone; the code is remembered on that device. Only the SHA-256 of the code is stored (in `supabase/schema.sql`), so it never appears in this public repo. To change the link, put the hash of a new code there and push.

## Gizmo's iPhone setup (iOS 16.4 or newer)
1. Open the family admin link in **Safari**.
2. Tap **Share** → **Add to Home Screen** → **Add**.
3. Open **Gizmo's Bar** from the Home Screen.
4. Go to **Phone setup** → **Turn on drink alerts** → **Allow**.
5. Tap **Send a test alert** to check it works.
