# Dynamic Greetings - Exotel voice campaigns with a swappable MP3 library

Upload MP3s, click one to make it the greeting, schedule an Exotel voice
campaign, and receive **per-call** results on a webhook. The MP3 is chosen
dynamically at call time - Exotel's flow asks this app which file to play.

## How it works (the important part)

Exotel's Campaign API has **no parameter to attach an MP3 directly**. A
campaign always points at a **Flow (callflow)**. So:

```
Campaign API ──points at──▶ Flow (has a Greeting/Connect applet with a dynamic URL)
                                     │  GET  /exotel/audio?To=…&CallSid=…
                                     ▼
                            THIS APP  ──text/plain──▶  https://…/audio/<file>.mp3
```

- One flow serves **every** MP3. Which file plays is decided per-call by
  `/exotel/audio`, based on which campaign dialed that number (falling back
  to the globally-selected "default" greeting).
- Each upload gets a **unique URL** → defeats Exotel's URL-based audio cache,
  so switching greetings always takes effect.
- Exotel posts each call's outcome to `/exotel/call-status` (the per-call
  `call_status_callback`, **not** the cumulative campaign stats).

## Prerequisites (one-time Exotel setup)

1. **Enable Campaigns API** on your account (ask Exotel support - it's gated).
2. **Create one Flow** in App Bazaar with a **Greeting applet** (or Connect
   applet) set to *dynamic URL* / "read text like a robot":
   ```
   https://<your-railway-domain>/exotel/audio
   ```
   Note the Flow's **App ID** (the number in the flow URL) → `EXOTEL_APP_ID`.
3. Grab **SID / API Key / API Token** from the API Settings page.

## Setup

```bash
npm install
cp .env.example .env      # fill in the values
npm start
```

Open http://localhost:3000. No database to provision - greetings, campaigns,
and call rows are stored in a single JSON file at `$DATA_DIR/db.json`, next to
the MP3s in `$DATA_DIR/audio/`.

> Requires **Node 18.17+**. `ffmpeg` ships via `ffmpeg-static` - no system
> install needed. (Duration probing needs `ffprobe`; if absent it's simply
> left blank - harmless.)

## Environment

See [.env.example](.env.example). Key ones:

| Var | Meaning |
|-----|---------|
| `PUBLIC_BASE_URL` | This app's public URL - what Exotel fetches audio from / posts calls to |
| `DATA_DIR` | Where MP3s + `db.json` are written (Railway: mount a Volume here) |
| `EXOTEL_SID` / `EXOTEL_API_KEY` / `EXOTEL_API_TOKEN` / `EXOTEL_SUBDOMAIN` | API auth |
| `EXOTEL_APP_ID` | The flow that plays our dynamic audio |
| `EXOTEL_CALLER_ID` | Default ExoPhone (overridable per campaign) |
| `WEBHOOK_TOKEN` | Optional shared secret appended to callback URLs as `?token=` |

## Deploy on Railway

1. Push this repo; create a Railway service from it (Nixpacks auto-detects Node).
2. Add a **Volume** and mount it at `/data` → set `DATA_DIR=/data`
   (so uploaded MP3s **and** `db.json` survive redeploys).
3. Set every env var above. Set `PUBLIC_BASE_URL` to the service's public URL.
4. Deploy. Point the Flow's Greeting applet URL at
   `https://<domain>/exotel/audio`.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET/POST | `/api/greetings` | list / upload MP3s |
| POST | `/api/greetings/:id/select` | set global default greeting |
| DELETE | `/api/greetings/:id` | delete |
| GET/POST | `/api/campaigns` | list / create+schedule |
| GET | `/api/campaigns/:id/calls` | calls for one campaign |
| GET | `/api/calls` | all per-call rows (`?campaign=<exotelId>`) |
| GET/HEAD | `/exotel/audio` | **Exotel** dynamic-audio webhook → `text/plain` MP3 URL |
| POST/GET | `/exotel/call-status` | **Exotel** per-call `call_status_callback` |
| ALL | `/exotel/call-schedule`, `/exotel/campaign-status` | logged |

## Notes / things to verify against your account

- **Number provisioning:** static campaigns dial a **List SID**. This app
  auto-creates contacts → a list → the campaign
  ([src/exotel.js](src/exotel.js) `provisionAndCreateCampaign`). Field names
  in Exotel's create-list/contacts/campaign responses vary slightly by account
  version; the client tolerates several shapes, but check the logs on your
  first real run and adjust the `sid`/`id` extraction if needed.
- **Audio format:** uploads are transcoded to 8 kHz mono MP3 @ 32 kbps, well
  under Exotel's 2 MB cap. Keep greetings short.
- **Per-campaign audio isolation:** the `/exotel/audio` webhook resolves the
  dialed number → its most recent campaign's greeting. If you dial the *same
  number* from two overlapping live campaigns, the most recent one wins. For
  hard isolation, use a separate flow per greeting instead.
