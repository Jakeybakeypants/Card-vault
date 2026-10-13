# Card Vault

Scan your trading cards with your phone's camera and they go straight into your collection
database. Pokémon, Yu-Gi-Oh!, Magic: The Gathering and Disney Lorcana are supported. It's a web app: no install, no account, and
your collection stays on your device.

<p>
  <img src="docs/scan.png" width="300" alt="Scanning a card">
  <img src="docs/collection.png" width="300" alt="The collection">
</p>

## Running it

```bash
npm install
npm run dev          # http://localhost:5174 on this computer
npm run dev:phone    # https://<your-computer's-LAN-IP>:5174 for your phone
npm test             # parser + catalog unit tests
npm run build        # static site in dist/, host anywhere (GitHub Pages, Netlify…)
```

Browsers only open the camera on `https://` pages or `localhost`. `dev:phone` serves HTTPS with
a self-signed certificate, so the first time you open it on your phone you'll need to accept the
warning. If the camera isn't available, the scan button falls back to the phone's photo picker,
which still works over plain HTTP.

## How scanning works

1. Hold the card inside the on-screen frame and tap the shutter (or press **Space** on a computer).
2. The app reads the strips of the card that identify it:
   - **Pokémon**: the name line, plus the collector number and set code at the bottom
     (`SVI EN 063/198`, `4/102`, `TG05/TG30`, `SWSH050`).
   - **Yu-Gi-Oh!**: the name banner, the set code under the artwork (`LOB-EN005`), the
     1st Edition/Limited Edition stamp, and the 8-digit passcode.
   - **Magic**: the name, plus the collector line bottom-left (`0123 R` / `M21 • EN`, or
     `123/269` on 2015–2019 cards).
   - **Lorcana**: the name and version banner, plus `12/204 • EN • 1` bottom-left (number / set
     size, language, set).
3. It looks those up in the card database and ranks the matches.
4. **One clear match** (number + set + name agree): the card is added immediately, with an
   **Undo** toast, and the camera stays ready for the next card.
   **Several possible matches** (for example, only the name was readable): you get a short
   list with pictures to pick from.

Scanning the same card again increases its quantity. Each copy is tracked by printing,
variant (Holofoil, Reverse Holofoil, 1st Edition…), condition and language, all editable
from the Collection tab.

### Two ways to read a card

| | On-device OCR (default) | AI scan (optional) |
| --- | --- | --- |
| How | [Tesseract](https://github.com/naptha/tesseract.js) in the browser | The photo is sent to Claude, which reads the card |
| Cost | Free | About a cent per scan, on your own [Anthropic API key](https://console.anthropic.com/settings/keys) |
| Privacy | Photo never leaves the phone | Photo goes to api.anthropic.com |
| Good at | Flat, well-lit, non-holo cards | Holo foil, glare, angled shots, non-English cards; detects the game itself |

Turn AI scan on in **Settings**. The key is stored only in your browser.

## Binder: what's left to collect

The **Binder** tab lists every set in the catalog, newest first, with the sets you've started
at the top and a progress bar for each. Open a set to see every card in it as a binder page:
cards you own are in full colour, and the ones you're missing are faded with their collector
number. Tap a faded card to add it. Cards added since you last opened that set flip into colour
with a glint, so after a scanning session you can see exactly what filled in. **Have** / **Need**
filters the page; finishing a set turns its bar gold.

Owning any variant, rarity or condition of a collector number fills that slot.

## Card data

| Game | Source | Prices |
| --- | --- | --- |
| Pokémon | [pokemontcg.io](https://pokemontcg.io) API v2, with [TCGdex](https://tcgdex.dev) as a fallback | TCGplayer market price per variant |
| Yu-Gi-Oh! | [YGOPRODeck](https://ygoprodeck.com/api-guide/) API v7 | TCGplayer price per printing |
| Magic | [Scryfall](https://scryfall.com/docs/api) | USD normal / foil / etched |
| Lorcana | [Lorcast](https://lorcast.com/docs/api) | USD normal / foil |

All are free and need no key.

### Prices

Prices are TCGplayer prices in USD, as the catalogs above publish them (they update about
daily). Each card's price is saved with it, and the app re-fetches today's prices for your whole
collection **once a day** when you open it; **Refresh prices** on the Collection tab does it on
demand. The toast shows the new total and how much it moved. A card's detail sheet shows the
date of its price. If a catalog has no price for a card today, its last known price is kept. A free pokemontcg.io key (Settings) raises its rate limit.
Card images are cached in the browser when you add a card, so the collection works offline and
doesn't keep re-downloading images from the catalogs.

## Your data

The collection is stored in the browser's IndexedDB on the device you scan with. From the
Collection tab you can:

- **Export CSV**: one row per entry (name, set, number, rarity, variant, condition, language,
  quantity, value) for spreadsheets.
- **Back up (JSON)** / **Restore**: a full backup you can move to another device. Restoring
  merges into what's already there.

## Code map

| Area | Files |
| --- | --- |
| Types | `src/types.ts` |
| OCR regions + text parsing | `src/scan/parse.ts` (pure, unit-tested) |
| Camera, cropping | `src/scan/camera.ts` |
| OCR (adaptive threshold → Tesseract) | `src/scan/ocr.ts` |
| AI reader | `src/scan/ai.ts` |
| Scan → candidates | `src/scan/recognize.ts` |
| Catalogs | `src/games/pokemon.ts`, `yugioh.ts`, `mtg.ts`, `lorcana.ts`, ranking in `src/games/game.ts` |
| Collection DB, export | `src/db/store.ts`, `src/db/exchange.ts` |
| Price refresh | `src/db/prices.ts`, each catalog's `refresh()` |
| Set completion (binder) | `src/db/progress.ts` (pure, unit-tested), `src/ui/binderView.ts` |
| UI | `src/ui/*` (no framework), `src/style.css` |

Adding another game (One Piece, Flesh and Blood…) means one new file in `src/games/` that
implements the `Game` interface (OCR regions, a parser, and catalog lookup/search), plus its
entry in `src/games/index.ts`.

## Roadmap

- Auto-capture when the card is steady in the frame (no tap needed).
- Card-edge detection so photos don't need to be framed carefully.
- Optional sync between devices (export/import works today).
- Price history and a "what's my collection worth" chart (prices refresh daily; history isn't kept yet).
- Bulk mode for binders and 9-pocket pages.
