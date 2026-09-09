---
title: metaflow
emoji: ⚡
colorFrom: indigo
colorTo: purple
sdk: docker
app_port: 7860
pinned: false
---

# META//FLOW — Meta AI Gateway (private Space)

OpenAI-compatible Meta AI proxy + control plane. The app is cloned at build
time from the private GitHub repo `Sexlovr/metaflow` using the **GIT_PAT**
secret — nothing sensitive lives in this Space repo.

## Setup (Space Settings)

1. **Secret GIT_PAT** (required) — a GitHub PAT with repo read access to
   `Sexlovr/metaflow`. Set it before the first build.
2. **Secret ADMIN_PASSWORD** — the control-plane login (defaults to
   `meta-admin` — change it).
3. **Secret API_KEY** — Bearer key required on `/v1/chat/completions` and
   `/v1/models`. On a public Space the proxy is open to the internet without
   it, so set it.
4. Optional **Secrets SEED_COOKIE** + **SEED_TOKEN** — paste the full
   `Cookie:` header from a logged-in meta.ai browser session (must contain
   `ecto_1_sess`) plus its `ecto1:` token to seed the first account at boot.
   You can also add accounts from the website's Accounts page at runtime.

## Persistence

Account cookies/tokens are stored in `/data/state.json`. Attach a persistent
volume (Settings → Volumes, mount at `/data`) to keep the pool across
restarts; otherwise the Space re-seeds from the secrets on each boot.

## Endpoints

- Website: the Space URL itself (login with ADMIN_PASSWORD)
- `POST /v1/chat/completions` — OpenAI-compatible (`meta-instant` /
  `meta-thinking`, `Authorization: Bearer <API_KEY>`)
- Every conversation is auto-deleted after the response (ghost mode).
