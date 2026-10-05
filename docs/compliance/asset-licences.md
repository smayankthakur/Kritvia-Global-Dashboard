# Asset and licence register

Every font, icon set, image, illustration, video, sound and code library we ship, with its licence and
proof. Add a row **before** an asset is merged. Keep receipts or licence pages for paid assets in the
company drive (Legal / Licences) and link them here.

## Fonts, icons and media

| Asset | Used for | Source | Licence | Obligations | Proof |
| --- | --- | --- | --- | --- | --- |
| Plus Jakarta Sans (variable) | All text | `@fontsource-variable/plus-jakarta-sans` 5.3.0 (Tokotype) | SIL Open Font License 1.1 | Don't sell the font by itself; keep the licence with it (included in the package) | `node_modules/@fontsource-variable/plus-jakarta-sans/LICENSE` |
| Lucide icons | Interface icons | `lucide-react` | ISC | Keep copyright notice (in the package) | Package licence |
| Kritvia logo, app icons (`public/icon.svg`, `public/icons/*`) | Brand | Made for Sitelytc | Owned by Sitelytc | — | Design source files |
| Open Graph image | Link previews | Generated in code (`app/opengraph-image.tsx`) | Owned by Sitelytc | — | Source code |
| Product screenshots (`docs/screenshots`) | Documentation | Our own app with seeded test data | Owned by Sitelytc | Use only invented names and data | — |

There are no stock photos, illustrations, videos or sounds in the product today.

## Code libraries

Production dependency licences on 5 October 2026 (`pnpm licenses list --prod`, web):
MIT 184, ISC 18, Apache-2.0 9, BSD-3-Clause 2, 0BSD 1, OFL-1.1 1, CC-BY-4.0 1 (caniuse-lite: browser
data used at build time), LGPL-3.0-or-later 2 (sharp's prebuilt libvips image library, dynamically
linked and unmodified, used by Next.js image optimisation on our server — allowed).

Not allowed in anything we ship: GPL, AGPL, SSPL, BUSL, non-commercial Creative Commons, "Commons
Clause", or no licence at all. The trust scan fails on these.

API (Python): fastapi, starlette, pydantic, uvicorn (MIT/BSD); sqlalchemy, asyncpg (MIT/Apache-2.0);
cryptography (Apache-2.0/BSD); argon2-cffi, pyjwt, httpx, arq, pypdf, defusedxml, pywebpush, pyyaml,
python-multipart, email-validator (MIT/BSD/Apache-2.0/PSF/Unlicense). Re-check with
`pip-licenses --from=mixed` when dependencies change.

## Third-party notices

Ship `THIRD_PARTY_NOTICES.txt` with the desktop app installer and keep it reachable from the website:
generate it with `pnpm licenses list --prod --long` (web) and `pip-licenses --with-license-file` (API)
before each release.
