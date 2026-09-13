# CaringBridge First Entry — voice composer

This was built using Claude Code for a class demo.

A simulated CaringBridge journal composer. The user either writes their first
journal entry themselves, or speaks it; spoken input is transcribed in the
browser, sent to Claude to strip filler words and false starts, and returned as
a draft they edit before a simulated publish.

Publishing is simulated throughout. Nothing is sent to CaringBridge, no account
is connected, and the page carries a demo marker and a disclaimer.

## Files

| File | Role |
|---|---|
| `composer.html` | The whole app — markup, CSS, speech capture, Claude call. **Source of truth; edit this.** |
| `server.py` | Local host, and the `/api/cleanup` + `/api/revise` proxies to the Anthropic API. |
| `build.py` | Wraps `composer.html` into a complete document at `serve/index.html`. |
| `reload.sh` | Rebuild and restart in one step. |
| `test_recorder.js` | Headless check of the recorder state machine (no browser, no mic). |
| `Caddyfile.example` | Optional TLS front end. |
| `CLAUDE.md` | Orientation for Claude Code sessions working on this directory. |
| `serve/index.html` | Generated. Do not edit — `build.py` overwrites it. |

`composer.html` is authored to be published directly as a Claude Artifact, which
supplies its own `<head>`/`<body>` skeleton; `build.py` adds one for local use.

## Running it

```sh
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
cp .env.example .env        # then paste your key into it
./venv/bin/python server.py
```

Then open <http://127.0.0.1:8777/>.

`.env` is gitignored and holds two things: the Anthropic API key (get one at
<https://console.anthropic.com/settings/keys>) and the Basic auth username and
password. Exported environment variables take precedence over the file.

The browser prompts for the username and password on first load; the API routes
are behind the same gate. On startup the server prints whether auth is on and
whether it found an Anthropic credential — without the latter, cleanup falls
back to the on-device path.

After any change, `./reload.sh` rebuilds `serve/index.html` and restarts the
server in one step:

```sh
./reload.sh       # foreground; Ctrl-C stops it
./reload.sh -d    # detached, logging to reload.log
```

It stops whatever holds port 8777 first and waits for the port to be released,
so it is safe to run repeatedly and whether or not a server is already up.

## Basic auth

Every route — the page and both API endpoints — requires HTTP Basic
credentials, taken from `BASIC_AUTH_USER` and `BASIC_AUTH_PASS` in `.env`.

- **Fails closed.** If either variable is missing the server prints why and
  exits rather than serving the page unprotected.
- **Constant-time comparison.** Both halves go through `hmac.compare_digest`,
  combined with `&` rather than `and`, so a wrong username takes the same time
  as a wrong password.
- **Malformed credentials are just a 401** — bad base64 or a header with no
  colon is rejected without a traceback.

Basic auth sends the password base64-encoded, not encrypted. Over loopback that
is fine; do not expose this server beyond `127.0.0.1` without TLS in front — see
below.

## Putting it behind TLS

`Caddyfile.example` fronts the app with Caddy and a Let's Encrypt certificate:

```sh
cp Caddyfile.example Caddyfile
$EDITOR Caddyfile                  # set the domain and the ACME email
caddy validate --config Caddyfile  # always, before restarting the service
./reload.sh -d                     # start the Python server on loopback first
sudo caddy run                     # sudo only because of ports 80 and 443
```

**Validate before restarting.** A Caddyfile whose global options block loses its
closing brace still looks fine to the eye, but every later block ends up nested
inside it. `caddy validate` catches that in a second; a service restart turns it
into downtime. `caddy fmt` re-indents and makes the nesting obvious.

`server.py` binds `127.0.0.1` only, so once Caddy is in front the app is
reachable exclusively through it.

Let's Encrypt needs three things before the first run — a real domain whose
A/AAAA record points at the host, inbound TCP **80 and 443** from the internet
(port 80 carries the HTTP-01 challenge as well as the HTTPS redirect, so do not
firewall it away), and a contact email. Caddy then requests, installs and renews
the certificate unattended. While you are still getting DNS and firewall right,
uncomment the `acme_ca` staging line in the global block: staging certificates
are not publicly trusted, so the browser warns, but the rate limits are far
looser and a misconfiguration costs nothing.

For local work, change the site address to `localhost`. Let's Encrypt cannot
validate that name, so Caddy issues from its own internal CA there.

The config is a single inlined site block on purpose — no snippet, no `import`.
Snippets only register at the *top level* of the file, so a global block missing
its brace silently nests the snippet and `import` then fails with "File to
import not found". Inlining cannot fail that way. For a second hostname, wrap
the body in `(composer) { }` at top level and `import composer` from each site.

Two reasons this matters beyond tidiness:

- Basic auth base64-encodes the password rather than encrypting it, so any
  non-loopback use needs TLS.
- `SpeechRecognition` and `getUserMedia` require a secure context. `localhost`
  qualifies; **any other hostname needs real HTTPS or the microphone will not
  work** — the same constraint that pushed this out of an embedded frame.

The config sets `Permissions-Policy: microphone=(self)` and forbids framing
(`frame-ancestors 'none'` plus `X-Frame-Options`), since being framed is exactly
what withholds mic access. Its CSP allows `'unsafe-inline'` for the page's own
`<style>` and `<script>`; that is acceptable here only because no user text ever
reaches `innerHTML` — the two `innerHTML` writes are static SVG constants and
everything spoken or typed is rendered with `textContent`.

Caddy auth is left commented out. `server.py` already gates every route, and
Caddy forwards the `Authorization` header, so enabling both with the same
credentials is redundant but harmless; with *different* credentials the browser
gets challenged twice.

## Why it runs locally

Speech recognition needs microphone access, and a browser only grants that to a
secure context whose embedder permits it. In an embedded frame the mic is
withheld regardless of the browser's own site permission. `127.0.0.1` is a
secure context at top level, so the microphone works there.

## How the page reaches Claude

`cleanUp()` tries three routes in order:

1. **Artifact `sample` capability** — when the page runs as a published Claude
   Artifact, `claude.use("sample")` calls the model with no key needed.
2. **`POST /api/cleanup`** — this repo's `server.py`, using the `anthropic` SDK.
3. **On-device regex** — a filler-word stripper in `localClean()`. Last resort
   only; it removes ums but cannot repair false starts or repetition. When it
   runs, the page says so rather than passing the output off as the model's.

The server calls `claude-opus-5` via `messages.parse()` against a Pydantic
`Entry` model, so `title` / `body` / `notes` come back schema-validated. Effort
is `low` — filler removal is simple and this keeps the wait short.

Transcripts go to the Anthropic API. They are not written to disk, and request
logging deliberately omits body content.

## Spoken revisions

The review step has a **Speak changes** panel: the writer says what to add, cut
or reword ("add that the surgery is Thursday morning, and take out the bit about
the food") and it is applied to the draft in place. `POST /api/revise` takes the
current title and body plus the instruction; `notes` comes back as a "What
changed" list under the editor, and the subject check re-runs on the result.

The instruction is a *direction, never content* — the prompt says so explicitly,
so a dictated sentence is never pasted into the entry. Everything not covered by
the instruction is required to come back word for word.

Both capture points share one recorder. `RECORDERS` in `composer.html` maps a
target name to its element ids, prompts and buffer, so the mic, level ring,
timer, live transcript and typed fallback behave identically in both places and
cannot drift apart.

## Testing the recorder

The speech path is the easiest thing here to break and the most tedious to check
by hand. `test_recorder.js` stubs enough DOM and `SpeechRecognition` to drive
both recorders headlessly:

```sh
/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc test_recorder.js
```

It runs against the JS extracted from `composer.html`, so it exercises the
shipped code rather than a copy, and it seeds each stub element's `hidden` /
`disabled` state from the real markup — without that the stubs all start visible
and enabled, which produces false failures.

Its fake recognizer deliberately delivers a final result *during* `stop()`,
which is how real engines behave and how the ordering bug below was caught.

## Stop means go

Pressing stop processes what was said — on both recorders. The explicit buttons
remain for anyone typing into the fallback, but nobody speaking has to find a
second button.

The submit does **not** fire from the stop handler. `SpeechRecognition` usually
delivers its last final result *after* `stop()` returns, so submitting there
clips the end of the last sentence. Instead `stopRecording({submit: true})` arms
`state.pendingSubmit` and `flushSubmit()` runs from the recognizer's `onend`,
once the final results are in; a 1.5s timer backstops browsers that never fire
`onend`. Arming is unconditional — whether enough was said is only knowable in
`flushSubmit`, after those finals land.

Order inside `stopRecording` is load-bearing:

1. **Detach first** (`state.recognition`, `state.active`, `state.recording`).
   `stop()` can fire `onend` synchronously, and the submit that follows calls
   `stopRecording()` again — without detaching, that stops the recognizer twice.
2. **Arm `pendingSubmit` before calling `stop()`**, for the same reason: a
   synchronous `onend` reaches `flushSubmit` with nothing armed, and the
   auto-submit is silently lost.

Only the mic button passes `{submit: true}`. Cancel, Back, Use a sample, and
Start over all call `stopRecording()` plain, so navigating away never fires off a
request.

## The subject check

A first entry that never says who it is about, or what would help, leaves its
readers with nowhere to go. Alongside the draft the model returns two booleans —
`mentions_person` and `mentions_needs` — and if either is false the page opens a
separate dialog suggesting the writer add it.

Two deliberate constraints:

- **The advice never enters the draft.** The dialog is its own element; the
  entry the writer sees is only ever their own words cleaned up.
- **The model returns booleans, not prose.** All three wordings are fixed in
  `flagMissingSubject()`, so the dialog cannot drift into unrequested feedback
  about tone, length, or anything else.

`mentions_person` deliberately does not count first-person narration — "I'm
tired" does not tell a reader whose site this is. It needs a name, a
relationship, or the writer saying the site is about their own situation.

The on-device fallback never raises the dialog; it has no way to judge this, and
guessing would be worse than staying quiet.

## System requirements

**Server**

| | Minimum | Why |
|---|---|---|
| Python | **3.10** | `anthropic` 1.x and `httpx2` both declare `>=3.10`; `server.py` also uses `dict \| None` annotations (PEP 604), which 3.9 evaluates at def time and rejects. |
| Packages | `anthropic` >= 1.5, `pydantic` >= 2 | `messages.parse()` with a Pydantic `output_format`. |
| Disk | ~50 MB | The venv measures 44 MB. |
| Network | outbound HTTPS to `api.anthropic.com` | Every cleanup and revision is an API call. |
| Credential | an Anthropic API key | Without one the page silently drops to on-device cleanup. |
| Auth | `BASIC_AUTH_USER` + `BASIC_AUTH_PASS` | Required — the server exits without them. |
| Port | 8777 free on loopback | Hardcoded as `PORT` in `server.py`. |
| OS | anything with POSIX `sh`, `lsof`, `nohup` | Only `reload.sh` needs these — macOS and Linux qualify. On Windows run `server.py` directly. |

No database, no build toolchain, no Node. `server.py` is Python standard library
apart from the two packages above.

**Browser** — floors set by the features actually used:

| Feature | Chrome/Edge | Safari | Firefox |
|---|---|---|---|
| `SpeechRecognition` (voice input) | 33 (`webkit`), 139 unprefixed | **14.1** (`webkit`) | **142** |
| `dialog.showModal()` (subject check) | 37 | 15.4 | 98 |

So: **Chrome/Edge 37+, Safari 15.4+, Firefox 142+** for the full experience.
Below the speech floor everything else still works — the page detects the
missing API and offers a textarea for the transcript, which exercises the same
cleanup path. A microphone is optional in that mode, and **Use a sample** loads
a realistic transcript for demoing without one.

Chrome's and Safari's recognizers are **server-based**: audio goes to the
browser vendor for transcription, so voice input needs a live connection and is
not private to the machine. Only the cleanup step involves Anthropic.

The page must also be a **secure context at top level** — `127.0.0.1` or HTTPS,
not inside a frame that withholds microphone permission. See "Why it runs
locally" above.

`getUserMedia` drives only the level ring around the mic; if it is unavailable
or denied, recording still works without the animation. Figtree loads from
Google Fonts and falls back to Helvetica/Arial offline.

**Development extras** — `test_recorder.js` needs a JS engine: macOS ships one
at the `jsc` path given above; `node --check` works elsewhere.

## Design

The visual identity is taken from caringbridge.org's own stylesheet rather than
approximated: berry `#963862` (their `--color-primary`), brave-blue `#617bd6`,
indigo `#24384c` body text, sky `#c6dde7`, coral `#ff7c6f`, their 6/8/12px radii
and pill buttons, and Figtree via Google Fonts. Light-only, matching the real
site.
