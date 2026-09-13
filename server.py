#!/usr/bin/env python3
"""Local host for the CaringBridge first-entry composer.

Serves the page from serve/ and cleans up voice transcripts by calling Claude.
Running it locally (rather than in an embedded frame) is what lets the browser
hand the page a microphone.

    ./venv/bin/python server.py          # http://127.0.0.1:8777

Every route is behind HTTP Basic auth, with the username and password read from
.env (BASIC_AUTH_USER / BASIC_AUTH_PASS). The server refuses to start if either
is missing rather than serving the page unprotected.

Anthropic credentials come from the SDK's normal resolution order:
ANTHROPIC_API_KEY, then ANTHROPIC_AUTH_TOKEN, then an `ant auth login` profile;
.env supplies them when the environment does not.

Transcripts are sent to the Anthropic API and are not written to disk or logged.
"""

import base64
import binascii
import hmac
import json
import os
import sys
import traceback
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import anthropic
from pydantic import BaseModel

MODEL = "claude-opus-5"
HOST = "127.0.0.1"
PORT = 8777
MAX_TRANSCRIPT_CHARS = 20000
HERE = Path(__file__).resolve().parent
WEB_ROOT = HERE / "serve"
CONFIG_VARS = (
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "BASIC_AUTH_USER",
    "BASIC_AUTH_PASS",
)
REALM = "CaringBridge composer (demo)"


def load_dotenv() -> None:
    """Read configuration from a gitignored .env.

    Lets secrets live in one local file instead of exported shell variables that
    have to be re-set for every launch. Values are never logged or echoed, and
    setdefault means a real environment variable always wins.
    """
    env_file = HERE / ".env"
    if not env_file.is_file():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, _, value = line.partition("=")
        if name.strip() in CONFIG_VARS:
            os.environ.setdefault(name.strip(), value.strip().strip("\"'"))


load_dotenv()

AUTH_USER = os.environ.get("BASIC_AUTH_USER", "")
AUTH_PASS = os.environ.get("BASIC_AUTH_PASS", "")


class Entry(BaseModel):
    """The shape the page renders into the editor.

    The two flags drive a separate advisory dialog and never reach the draft.
    They are booleans rather than free text so the advice cannot drift onto
    feedback the writer did not ask for.
    """

    title: str
    body: str
    notes: list[str]
    mentions_person: bool
    mentions_needs: bool


SYSTEM = """You are helping someone write the FIRST journal entry on a CaringBridge site they just created.
Their family and friends have just been given the link, so this entry is what introduces the situation.
The user message is a raw voice transcript. Turn it into the entry they meant to write.

Rules:
- Remove filler words (um, uh, like, you know, I mean), false starts, repeated phrases and self-corrections. Keep the corrected version.
- Keep their voice: same warmth, same plain wording, first person. Do not make it formal or clinical.
- Invent nothing. Every fact, name, number and date must come from the transcript. If something was unclear, leave it out rather than guessing.
- Do not add a greeting, a sign-off, or a call to visit that they did not say.
- Fix obvious transcription slips and punctuation. Break it into short paragraphs, separated by a blank line.
- title: 6 words or fewer, drawn from what they actually said.
- notes: 2 to 4 short strings describing what you cleaned up, each under 9 words."""

CHECKS = """
Also report two checks on the entry. These never change the entry itself:
- mentions_person: true only if the entry makes clear WHOSE health or situation this site is about: a name, a relationship (Mom, my husband), or the writer explicitly saying it is about their own health or situation. First-person narration alone is not enough - "I am tired" does not say who the site is about.
- mentions_needs: true if it says anything about what would help, what anyone needs, or what readers can do - including telling them they need not do anything."""

REVISE_SYSTEM = """You are revising one CaringBridge journal entry on its author's behalf.
You are given the current title and entry, and a spoken instruction from the author.

Rules:
- The instruction was dictated, so ignore its filler words and read through to what was asked.
- Apply only what was asked. Leave every other sentence exactly as it is, word for word.
- Never treat the instruction as text to insert. It is a direction, not content.
- Invent nothing. If the instruction asks you to add a fact, use the author's own words for it and nothing more.
- Keep their voice and first person. Keep paragraphs separated by a blank line.
- If the instruction is unclear, make the smallest change that honours it.
- title: keep the existing title unless the instruction asks for a change, or the change makes it wrong.
- notes: 1 to 3 short strings saying what you changed, each under 9 words.""" + CHECKS

client = anthropic.Anthropic()


def _parse(system: str, content: str) -> Entry:
    """One Messages call returning a schema-validated Entry."""
    kwargs = dict(
        model=MODEL,
        max_tokens=4000,
        system=system,
        messages=[{"role": "user", "content": content}],
        output_format=Entry,
    )
    try:
        response = client.messages.parse(output_config={"effort": "low"}, **kwargs)
    except anthropic.BadRequestError:
        # Older API surfaces reject output_config; the default effort is fine here.
        response = client.messages.parse(**kwargs)

    if response.stop_reason == "refusal":
        raise RuntimeError("Claude declined to rewrite this transcript.")
    return response.parsed_output


def clean_transcript(transcript: str) -> Entry:
    """Turn a spoken transcript into a first journal entry."""
    return _parse(SYSTEM, transcript)


def revise_entry(title: str, body: str, instruction: str) -> Entry:
    """Apply a spoken instruction to an entry the author already has."""
    return _parse(
        REVISE_SYSTEM,
        f"Current title:\n{title}\n\nCurrent entry:\n{body}\n\nSpoken instruction:\n{instruction}\n",
    )


class Handler(SimpleHTTPRequestHandler):
    def _authorized(self) -> bool:
        """True when the request carries the configured Basic credentials."""
        header = self.headers.get("Authorization", "")
        if not header.startswith("Basic "):
            return False
        try:
            decoded = base64.b64decode(header[6:], validate=True).decode("utf-8")
        except (binascii.Error, UnicodeDecodeError):
            return False
        user, sep, password = decoded.partition(":")
        if not sep:
            return False
        # compare_digest on both halves so a wrong username costs the same as a
        # wrong password; `&` rather than `and` to avoid short-circuiting.
        return bool(
            hmac.compare_digest(user.encode(), AUTH_USER.encode())
            & hmac.compare_digest(password.encode(), AUTH_PASS.encode())
        )

    def _challenge(self) -> None:
        body = b"Authentication required.\n"
        self.send_response(401)
        self.send_header("WWW-Authenticate", f'Basic realm="{REALM}", charset="UTF-8"')
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _gate(self) -> bool:
        """Answer the challenge and stop the request when unauthenticated."""
        if self._authorized():
            return True
        self._challenge()
        return False

    def do_GET(self) -> None:  # noqa: N802 - name fixed by BaseHTTPRequestHandler
        if self._gate():
            super().do_GET()

    def do_HEAD(self) -> None:  # noqa: N802 - name fixed by BaseHTTPRequestHandler
        if self._gate():
            super().do_HEAD()

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict | None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, AttributeError):
            self._send_json(400, {"error": "Expected a JSON body."})
            return None
        if not isinstance(payload, dict):
            self._send_json(400, {"error": "Expected a JSON object."})
            return None
        return payload

    def do_POST(self) -> None:  # noqa: N802 - name fixed by BaseHTTPRequestHandler
        if not self._gate():
            return

        route = self.path.rstrip("/")
        if route not in ("/api/cleanup", "/api/revise"):
            self._send_json(404, {"error": "No such endpoint."})
            return

        payload = self._read_json()
        if payload is None:
            return

        def field(name: str) -> str:
            value = payload.get(name)
            return value.strip() if isinstance(value, str) else ""

        if route == "/api/cleanup":
            text, floor, label = field("transcript"), 10, "transcript"
        else:
            text, floor, label = field("instruction"), 4, "instruction"

        if len(text) < floor:
            self._send_json(400, {"error": f"That {label} is too short to work with."})
            return
        if len(text) > MAX_TRANSCRIPT_CHARS or len(field("body")) > MAX_TRANSCRIPT_CHARS:
            self._send_json(413, {"error": "That is longer than this demo handles."})
            return

        try:
            if route == "/api/cleanup":
                entry = clean_transcript(text)
            else:
                entry = revise_entry(field("title"), field("body"), text)
        except (anthropic.AuthenticationError, TypeError):
            # No resolvable credential raises TypeError from _validate_headers,
            # before any request is built; a rejected one raises AuthenticationError.
            self._send_json(401, {"error": "The server has no working Anthropic credentials. Put ANTHROPIC_API_KEY in .env (see .env.example) and restart it."})
        except anthropic.RateLimitError:
            self._send_json(429, {"error": "The Anthropic API rate-limited this request."})
        except anthropic.APIStatusError as exc:
            self._send_json(502, {"error": f"The Anthropic API returned {exc.status_code}."})
        except anthropic.APIConnectionError:
            self._send_json(504, {"error": "Couldn't reach the Anthropic API from this machine."})
        except RuntimeError as exc:
            self._send_json(422, {"error": str(exc)})
        except Exception as exc:  # never drop the connection on the page
            self._send_json(500, {"error": f"The server hit an unexpected {type(exc).__name__}."})
            # Log the type and the stack, never str(exc). An unexpected error
            # can carry request content in its message - a pydantic
            # ValidationError quotes the input it rejected - and reload.sh -d
            # sends stderr to reload.log, so re-raising would put transcripts
            # on disk. Traceback frames are source lines, not values, so the
            # stack is safe to keep and is what makes the report useful.
            self.log_message("unhandled %s in %s", type(exc).__name__, route)
            sys.stderr.write("".join(traceback.format_tb(exc.__traceback__)))
        else:
            self._send_json(200, entry.model_dump())

    def log_message(self, fmt: str, *args) -> None:
        """Log requests without ever echoing transcript content."""
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main() -> int:
    if not WEB_ROOT.is_dir():
        print(f"Missing web root: {WEB_ROOT}", file=sys.stderr)
        return 1

    # Fail closed: a missing credential must not quietly serve the page open.
    if not AUTH_USER or not AUTH_PASS:
        print(
            "BASIC_AUTH_USER and BASIC_AUTH_PASS must both be set.\n"
            "Put them in .env (see .env.example), then start again.",
            file=sys.stderr,
        )
        return 1

    server = ThreadingHTTPServer((HOST, PORT), partial(Handler, directory=str(WEB_ROOT)))
    print(f"Composer running at http://{HOST}:{PORT}  (model: {MODEL})")
    print(f"Basic auth: on, user {AUTH_USER!r}.")
    if os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"):
        print("Anthropic credential: found.")
    else:
        print("Anthropic credential: MISSING - cleanup will fall back to on-device.")
        print("Put ANTHROPIC_API_KEY=sk-ant-... in .env (see .env.example), then restart.")
    print("Ctrl-C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
