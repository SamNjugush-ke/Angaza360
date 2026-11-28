# Angaza360 — frontend

The web application for Angaza360: accounting, POS, inventory, payroll and KRA eTIMS
compliance for Kenyan businesses. It renders state and calls the backend API; it never
computes balances, tax or payroll figures itself.

## Stack

- Next.js 16 (App Router), React 19 and TypeScript
- Tailwind CSS, with the brand and semantic design tokens in `app/globals.css` and
  `tailwind.config.ts`
- `next/font/local` with VENDORED fonts (Montserrat, IBM Plex Sans, IBM Plex Mono): latin-subset
  woff2 under `app/fonts/<family>/`, each family with its SIL Open Font License (`OFL.txt`). The
  build fetches nothing from Google Fonts. Commercial font files are never committed.

## Assets

- Curated, served brand assets live in `public/` (`brand/`, `icons/`, favicons,
  `site.webmanifest`).
- The full brand masters live in `brand-kit/`, which is gitignored and never served.

## Commands

```bash
npm install      # install dependencies
npm run dev      # development server on http://localhost:3000
npm run build    # production build
npm run start    # serve the production build
npm run lint     # ESLint 9 (flat config, eslint.config.mjs)
npm run typecheck # tsc --noEmit — the app and the test suite (tsconfig includes tests/)
npm run test     # Vitest
npm run gen:api  # regenerate lib/api/schema.d.ts from lib/api/openapi.json
```

Set `NEXT_PUBLIC_SITE_URL` to the CANONICAL origin (default `https://angaza360.co.ke`, the
apex): metadata, canonicals, the sitemap and JSON-LD resolve against it. The app itself is served
from `app.angaza360.co.ke` and stays noindex. **`www.angaza360.co.ke` must 301 to the apex** —
that redirect is infrastructure (DNS / edge), not application code.
`MARKETING_HOST` and `APP_HOST` (server-side) split "/" by host: on the marketing host (the apex,
default `SITE_URL`'s host) an anonymous "/" is the public landing page; on the app host (default
`app.<MARKETING_HOST>`) or a business's own subdomain it goes to sign in. Any other host — localhost,
a preview deployment — shows the landing. A signed-in visitor's "/" goes to their workspace on every
host. `NEXT_PUBLIC_CONTACT_EMAIL` (unset by default) is now only a fallback for `NEXT_PUBLIC_LEGAL_SUPPORT_EMAIL` (M4.5 W2). The legal pages read `NEXT_PUBLIC_LEGAL_ENTITY`, `_REGISTERED_ADDRESS`, `_DPO_NAME`, `_DPO_EMAIL`, `_SUPPORT_EMAIL`, `_ODPC_REG_NO`, `_EFFECTIVE_DATE`, `_GOVERNING_COUNTY` (each unset one shows "[to be completed]") and `NEXT_PUBLIC_LEGAL_REVIEWED=true` removes the draft notice;
leave it unset until a real, monitored address exists.
`NEXT_PUBLIC_GA_ID` (unset by default) enables the analytics slot, and only for visitors who have
granted consent; no tracker is bundled.
Set `API_BASE_URL` (server-side only, never exposed to the browser) to the backend origin
(default `http://localhost:4000`).

## API client

`lib/api/client.ts` is a typed client for the backend, generated from the backend's own
OpenAPI document and used server-side only (BFF route handlers and server components). Money
arrives as a string of cents and stays one — format it with `lib/money.ts`.

The spec is committed (`lib/api/openapi.json`), so `npm run gen:api` needs no running backend.
When the API changes, refresh it:

```bash
cd ../backend && npm run dev                                    # in another terminal
curl -fsS http://localhost:4000/docs/json -o lib/api/openapi.json  # from frontend/
npm run gen:api
```

Commit both `openapi.json` and `schema.d.ts`. `lib/api/schema-assertions.ts` fails the type
check if a relied-on endpoint disappears or a money field stops being a string.

## SEO assets

- `app/robots.ts` and `app/sitemap.ts` — the sitemap lists only public, indexable routes; robots
  disallows the whole authenticated area and `/api`.
- `public/og-image.png` (1200×630) is the hand-approved social card — replace it only with a
  newly approved image of the same size.

## CI

`.github/workflows/frontend-ci.yml` runs on every push and pull request that touches
`frontend/**`: `npm ci` → `npm run typecheck` → `npm run lint` → `npm test` → `npm run build` →
`npm audit --audit-level=high`, on Node 22. It needs no secrets, database or backend.
