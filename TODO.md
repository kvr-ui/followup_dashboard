# Followup Dashboard — TODO

Last updated: 2026-07-11

---

## ✅ Completed

### v1 — Lead follow-up dashboard
- [x] Node backend + React (Vite) frontend, separate folders
- [x] Bigin task webhook ingest (`POST /webhook`) — instant response, background enrichment
- [x] MongoDB Atlas (production) — deduped by contact id, no duplicates
- [x] Auth: admin + sales roles, JWT, 30-day sessions
- [x] Sales users only see their own leads (filtered by `Owner.email`)
- [x] Lead table: filters, search, quick tabs, summary cards, overdue highlighting
- [x] Lead detail: status write-back to Bigin, notes, history, contact phone + copy button
- [x] Admin analytics: per-salesperson performance
- [x] WhatsApp send via WATI (71 approved templates)
- [x] Docker deployment on port **7007**
- [x] Zoho rate-limit fixes (throttle, retry, no Zoho calls on the read path)

### v2 — Call grading (in progress)
- [x] TeleCMI CDR sync — **701 calls** imported (May 1 → now)
- [x] Bigin deal sync — **149 won / 2,471 lost**
- [x] Calls matched to leads + deals by phone number
- [x] Deal products auto-fetched from Bigin (related list, not in webhook)
- [x] Audio transcoding via ffmpeg (TeleCMI's MPEG-2.5 won't play in browsers)
- [x] Recording proxied through our server (TeleCMI secret never exposed)
- [x] Admin **Calls** tab: lead journeys, audio player, speaker-split transcript
- [x] Transcription pipeline — ElevenLabs `scribe_v2`, auto-detect Tamil/English, diarization
- [x] **22 calls transcribed** (quality verified)
- [x] Bigin deal webhook (`POST /webhook/deal`) — **verified live**, handles won + lost, custom pipelines
- [x] TeleCMI call webhook (`POST /webhook/call`) — built + tested (handles `cmiuuid`/`answeredsec`/`user`)
- [x] Reconcile polls every 15 min (safety net — webhooks can silently miss events)
- [x] ElevenLabs quota circuit-breaker (pauses 1 hr instead of hammering)
- [x] Won/lost outcome tagging on every call

---

## 🔴 Blockers (need action from you)

- [ ] **Repoint both webhooks to a live URL** — ngrok is stopped, so the old URLs are dead
  - Bigin (Zoho Flow) → `https://follo.focasedu.in/webhook/deal`
  - TeleCMI (CDR)     → `https://follo.focasedu.in/webhook/call`
  - *(or restart ngrok against port 7007 for local testing)*

- [ ] **Upgrade ElevenLabs to Creator** ($22 first month, then $11/mo — 121k credits)
  - Free tier (10k credits) ran out after 22 calls
  - **152 calls still pending** (~34k credits needed)
  - The worker resumes **automatically** once credits exist — no restart needed

---

## 🟡 The actual grading (buildable now — no blockers)

- [ ] **AI call grading** — score each call against a rubric
  - opening, needs discovery, product pitch, objection handling, next-step booked, tone
  - can be built + validated against the 22 existing transcripts

- [ ] **AI journey grading** — score the whole multi-call arc to the close
  - avg 2.8 calls per closed lead (some up to 11) — a sale is a journey, not one call

- [ ] **Won vs Lost comparison analytics** — the key insight
  - 226 won calls + 208 lost calls already tagged
  - e.g. "won: avg score 78, discovery in 82% of calls / lost: avg 54, discovery in 31%"

---

## 🟢 Follow-ups

- [ ] Switch `TRANSCRIBE_SCOPE=won` → `all` once credits allow (~$11/mo covers everything)
- [ ] **Change the default admin password** (`admin123`) before going public
- [ ] Add a webhook secret — `/webhook/*` endpoints are currently open to anyone
- [ ] Recreate the 3 sales accounts on production (veera, nithish, amrithia)
- [ ] Investigate the 10 failed transcriptions (non-quota errors)
- [ ] Rotate the MongoDB Atlas password (shared in chat; also contains `@` needing URL-encoding)
- [ ] Tighten the Atlas IP allowlist (currently `0.0.0.0/0`)
- [ ] Consider a Docker volume for the transcoded-audio cache (currently cleared on restart)

---

## 📌 Known data facts

- **83 of 149** closed sales have a recorded call — the other 66 closed via WhatsApp / personal
  phone / walk-in, so they can't be graded. Worth knowing as a process gap.
- Average **2.8 calls** per closed lead (max 11).
- Agent extension mapping (auto-derived): `5001` = veera, `5003` = nithish, `5004` = amrithia.
- Bigin stages: won = `Closed with Sale`, lost = `Closed without Sale` (custom pipeline).

---

## ⚙️ Key config (`backend/.env`)

```
TRANSCRIBE_SCOPE=won          # won | closed | all
TELECMI_MIN_DURATION_SEC=30   # skip misdials
CALL_POLL_MINUTES=15          # TeleCMI reconcile
DEAL_POLL_MINUTES=15          # Bigin reconcile
TRANSCRIBE_POLL_MINUTES=10    # transcription worker
BIGIN_WON_STAGE=Closed with Sale
BIGIN_LOST_STAGE=Closed without Sale
```

## 🚀 Deploy

```bash
docker compose up -d --build     # → http://localhost:7007
```
