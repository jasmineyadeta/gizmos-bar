# Gizmo's Bar

A free drink-ordering site for Gizmo's home bar. Guests scan a QR code, type their name and pick a drink. Gizmo gets a push on his iPhone: **THIS PERSON NEEDS A DRINK**.

- Guest menu: `https://jasmineyadeta.github.io/gizmos-bar/`
- Owner page: `https://jasmineyadeta.github.io/gizmos-bar/admin.html`

## How it works
- `site/` is a static web app (no build step), hosted on GitHub Pages.
- Supabase (free tier) stores the menu, hours and orders, handles Gizmo's sign-in, and runs the `bar` edge function that places orders and sends web push.
- `.github/workflows/deploy.yml` sets up everything on each push to `main`: database schema, sign-in settings, push keys (first run), edge function, and the site. It needs one repo secret: `SUPABASE_ACCESS_TOKEN`.
- `.github/workflows/keepalive.yml` pings Supabase every 3 days so the free project doesn't pause.

## Owner account
The first person to open the owner page and create a login becomes the owner. Nobody else can manage the bar after that.

## Gizmo's iPhone setup (iOS 16.4 or newer)
1. Open the owner page link in **Safari**.
2. Tap **Share** → **Add to Home Screen** → **Add**.
3. Open **Gizmo's Bar** from the Home Screen and sign in.
4. Go to **Phone setup** → **Turn on drink alerts** → **Allow**.
5. Tap **Send a test alert** to check it works.
