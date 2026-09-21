# CaringBridge First Entry — voice composer

This was built using Claude Code for a class demo.

A simulated CaringBridge journal composer. The user writes their first journal
entry themselves, speaks it in one go, or is walked through it a question at a
time; spoken input is transcribed in the browser, sent to Claude to strip filler
words and false starts, and returned as a draft they edit before a simulated
publish.

Publishing is simulated throughout. Nothing is sent to CaringBridge, no account
is connected, and the page carries a demo marker and a disclaimer.

## Files

| File | Role |
|---|---|
| `composer.html` | The whole app — markup, CSS, speech capture, Claude call. **Source of truth; edit this.** |
| `server.py` | Local host, and the `/api/cleanup`, `/api/revise` and `/api/adjust` proxies to the Anthropic API. |
| `build.py` | Wraps `composer.html` into a complete document at `serve/index.html`. |
| `reload.sh` | Rebuild and restart in one step. |
| `test_recorder.js` | Headless check of the recorder state machine, the guided flow and the adjust-the-draft controls (no browser, no mic). |
| `Caddyfile.example` | Optional TLS front end. |
| `render.yaml` | Render Blueprint for the hosted copy. |
| `.github/workflows/deploy.yml` | GitHub Actions: run the checks, then trigger the Render deploy. |
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

Every route — the page and the API endpoints — requires HTTP Basic
credentials, taken from `BASIC_AUTH_USER` and `BASIC_AUTH_PASS` in `.env`. The
one exception is `GET /healthz`, the hosting platform's liveness probe, which
answers `ok` and nothing else.

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

## Hosting it on Render with GitHub Actions

The Caddy route above needs a domain and inbound ports 80 and 443, which a
workstation on a campus network usually cannot offer. The hosted copy runs on
[Render](https://render.com) instead: a free web service with a stable
`https://<name>.onrender.com` address and a certificate, so the page is a
secure context and the microphone works exactly as it does on `127.0.0.1`.
GitHub Actions is the gate in front of it — `.github/workflows/deploy.yml` runs
the build, compiles the server and runs the headless recorder test on every
push to `main`, and only when all of that passes does it trigger the deploy.
Render's own deploy-on-push is off so nothing reaches the site untested.

The server needs two things from the platform, both already handled:
`server.py` reads `HOST` and `PORT` from the environment (Render assigns the
port and `render.yaml` sets `HOST=0.0.0.0`), and it answers `GET /healthz`
without credentials for Render's probe. `serve/` is gitignored, so
`build.py` runs in the build command rather than being committed.

One-time setup, in this order:

1. **Create the service.** In the Render dashboard, *New → Web Service*. If
   the repo is connected through Render's GitHub app, choose *Blueprint*
   instead and `render.yaml` supplies everything below. For a repo Render
   only pulls as a *Public Git repository*, enter the same values by hand:

   | Setting | Value |
   |---|---|
   | Runtime | Python |
   | Branch | `main` |
   | Build command | `pip install -r requirements.txt && python build.py` |
   | Start command | `python server.py` |
   | Health check path | `/healthz` |
   | Auto-deploy | **Off** (the workflow deploys) |
   | Instance type | Free |

2. **Set the environment variables** on the service: `PYTHON_VERSION=3.13.5`,
   `HOST=0.0.0.0`, and the three from `.env.example` — `ANTHROPIC_API_KEY`,
   `BASIC_AUTH_USER`, `BASIC_AUTH_PASS`. The page is now on the public
   internet, so pick a real password here rather than the local one.

3. **Give the workflow the deploy hook.** *Settings → Deploy Hook* on the
   service shows a URL; store it as the repository secret
   `RENDER_DEPLOY_HOOK_URL`. Optionally also store a Render API key
   (*Account settings → API Keys*) as `RENDER_API_KEY`; with it the workflow
   waits for the deploy to go live and fails if Render's build or start fails.
   Both can be set from the command line by a collaborator:

   ```sh
   gh secret set RENDER_DEPLOY_HOOK_URL     # paste the URL at the prompt
   gh secret set RENDER_API_KEY             # optional
   ```

After that, every push to `main` deploys, and *Actions → Deploy → Run
workflow* redeploys the current `main` on demand. Without the deploy-hook
secret the checks still run and the deploy step is skipped, so any clone of
the repo gets CI for free.

The free instance sleeps after fifteen minutes without traffic and takes
30–60 seconds to wake, so open the URL once before a demo. Basic auth still
gates the hosted copy; the browser prompts on first load just as it does
locally.

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

The server calls `claude-sonnet-5` via `messages.parse()` against a Pydantic
`Entry` model, so `title` / `body` / `notes` come back schema-validated. Effort
is `low` — filler removal is simple and this keeps the wait short.

Transcripts go to the Anthropic API. They are not written to disk, and request
logging deliberately omits body content.

## Walk me through it

Facing one empty box and a microphone is the hardest version of this. The third
option on the entry page asks six short questions instead, one screen at a
time:

1. **Who is this site about?** — their name and a bit about them, or about
   yourself if the site is yours. It says outright that the diagnosis comes
   next, so nobody feels they have to cram everything into the first answer.
2. **What's been happening?**
3. **What happens next?** — "we don't know yet" is an answer worth giving.
4. **What would actually help?**
5. **How would you like people to reach out?** — calls or texts, whether they
   want to talk the whole thing through or think about something else for a
   while, whether they'd rather people waited to be contacted. The one thing
   readers of a first entry most often get wrong, and the one thing nobody
   thinks to write down.
6. **Anything else you want people to know?**

Every question can be skipped, **Back** returns to the previous one with the
answer still in the box, and each has a sample answer for demoing without a
microphone. Stopping the mic moves to the next question, the same way stopping
it elsewhere submits.

There are two ways out at any point, in one button that says which one it is:
with nothing answered yet it reads **I'd rather just write it** and opens a
blank editor; once there is an answer it reads **Finish with what I've said**
and writes up what there is. Neither discards anything.

The answers are assembled into one transcript with each answer under its
question — `Who this site is about:` and so on — and sent down the same cleanup
path as a single recording. All three prompts say the headings are the page's
words, not the writer's: they tell the parts apart and never appear in the
entry. `localClean()`, the on-device last resort, strips them with a regex built
from the same labels.

## Spoken revisions

The review step has a **Speak changes** panel: the writer says what to add, cut
or reword ("add that the surgery is Thursday morning, and take out the bit about
the food") and it is applied to the draft in place. `POST /api/revise` takes the
current title and body plus the instruction; `notes` comes back as a "What
changed" list under the editor, and the subject check re-runs on the result.

The instruction is a *direction, never content* — the prompt says so explicitly,
so a dictated sentence is never pasted into the entry. Everything not covered by
the instruction is required to come back word for word.

All three capture points — one long recording, each guided answer, and spoken
revisions — share one recorder. `RECORDERS` in `composer.html` maps a target
name to its element ids, prompts and buffer, so the mic, level ring, timer, live
transcript and typed fallback behave identically everywhere and cannot drift
apart. The guided flow is a single target whose buffer and example swap between
questions, not five recorders.

## Adjusting the draft

Below the editor, **Adjust the draft** has three sliders, each 1–5 with the
middle position meaning "as it is now":

- **Length** — just the essentials … everything I said. Anything above the
  middle may only bring back detail from the raw transcript; on the
  "Write it myself" path there is no transcript, so the entry cannot grow.
- **Emotion** — just the facts … openly heartfelt. Only feelings the writer
  actually expressed are foregrounded or softened; none are added.
- **Wording** — reworded for flow … my exact words. How closely the writer's own
  phrasing is kept.

**Suggest changes** sends the current title and entry, the transcript and the
three positions to `POST /api/adjust` (or the artifact `sample` capability) and
gets back one rewrite. Nothing is applied yet: the entry box switches to a
tracked-changes view — removed words struck through, added words highlighted —
with the model's notes underneath and two buttons, **Use this version** and
**Keep what I have**. Accepting writes the text into the editor and logs the
notes in "What changed"; keeping restores the editor untouched. Publish and
Speak changes are disabled while a suggestion is waiting for a decision.

The slider positions are integers on the wire; `server.py` maps each to a
sentence in `LEVELS`, and `composer.html` carries the same table for the
artifact path and the captions. The settings are directions, never content, and
the diff view is built with `textContent` only, so nothing typed, spoken or
generated reaches `innerHTML`.

## Testing the recorder

The speech path is the easiest thing here to break and the most tedious to check
by hand. `test_recorder.js` stubs enough DOM and `SpeechRecognition` to drive
every recorder headlessly:

```sh
sed -n '/^<script>$/,/^<\/script>$/p' composer.html | sed '1d;$d' > /tmp/composer-check.js
/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc test_recorder.js
node test_recorder.js      # same thing on a machine where node works
```

It runs against the JS extracted from `composer.html` (the `sed` line), so it
exercises the shipped code rather than a copy, and it seeds each stub element's `hidden` /
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
| Port | 8777 free on loopback | Defaults in `server.py`; `HOST` and `PORT` in the environment override them, which is how a hosting platform hands the server its port. |
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
