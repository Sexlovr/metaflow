# META//FLOW — Meta AI Gateway

Private OpenAI-compatible proxy + control plane for Meta AI (meta.ai).

- **Transport**: raw DGW binary WebSocket (wss://gateway.meta.ai/ws/clippy), browser-identical TLS handshake
- **Auth**: ecto1 token minted from the meta.ai page HTML (cookie auth), no cookies needed on the wire
- **Modes**: `meta-instant` (Muse Spark MODE_FAST) / `meta-thinking` (mode_thinking, reasoning streams live)
- **Big context**: > 24k chars auto-routes through the rupload document-attachment pipeline (~500k tokens, verified 2MB)
- **Ghost mode**: every conversation is auto-deleted after the response (deleteConversation mutation) — nothing lands in Meta history
- **Account pool**: per-account serialization (same-account simultaneous requests merge server-side), add accounts by pasting cookie headers

## Run

    node server.js          # http://127.0.0.1:3117  (default password: meta-admin, override via ADMIN_PASSWORD)

## API

    POST /v1/chat/completions   (OpenAI-compatible, SSE + JSON)
    GET  /v1/models
    Admin: /api/login /api/status /api/accounts /api/logs /api/conversations /api/cleanup /api/config

## Files

- `meta_lib.js` — protocol library: protobuf codec (byte-faithful template patching), frame builders (connect / continuation / attachment), TLS WebSocket session, graphql caller, token mint, rupload upload, conversation delete, OpenAI-messages→prompt
- `server.js` — account pool, chat pipeline, SSE pacing (thinking live, answer buffered+replayed — Meta's answer deltas are out-of-order tail fragments), admin API, static serving
- `public/` — control-plane SPA (dark glass UI: chat, dashboard, accounts, live logs, server chats, settings)
- `conn556_00.bin` / `conn556_01.bin` / `verbatim_0d.bin` / `attachment_frame.b64` — captured browser frame templates (session-bound field values ride inside; craft per-account templates if the server rejects a different account session)

Reverse-engineered 2026-09-09. Not affiliated with Meta.
