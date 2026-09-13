#!/bin/sh
# Rebuild serve/index.html and restart the composer server.
#
#   ./reload.sh        rebuild, restart, stay in the foreground (Ctrl-C stops)
#   ./reload.sh -d     rebuild, restart detached, log to reload.log
#
# Safe to run whether or not a server is already up.

set -eu

cd "$(dirname "$0")"

PORT=8777
LOG=reload.log
PYTHON=./venv/bin/python

[ -x "$PYTHON" ] || {
    echo "No venv yet. Run: python3 -m venv venv && ./venv/bin/pip install -r requirements.txt" >&2
    exit 1
}

# Stop whatever holds the port, then wait for it to actually let go -
# starting too soon gives "Address already in use".
pids=$(lsof -ti "tcp:$PORT" 2>/dev/null || true)
if [ -n "$pids" ]; then
    echo "Stopping $(echo "$pids" | tr '\n' ' ')on port $PORT"
    # shellcheck disable=SC2086 # word splitting is how we pass several pids
    kill $pids 2>/dev/null || true
    n=0
    while [ -n "$(lsof -ti "tcp:$PORT" 2>/dev/null || true)" ]; do
        n=$((n + 1))
        if [ "$n" -gt 20 ]; then
            echo "Port $PORT still held after 10s; forcing." >&2
            # shellcheck disable=SC2086
            kill -9 $pids 2>/dev/null || true
            sleep 1
            break
        fi
        sleep 0.5
    done
fi

python3 build.py

if [ "${1-}" = "-d" ] || [ "${1-}" = "--detach" ]; then
    nohup "$PYTHON" -u server.py >"$LOG" 2>&1 &
    sleep 2
    head -4 "$LOG"
    if lsof -ti "tcp:$PORT" >/dev/null 2>&1; then
        echo "Detached (pid $!). Log: $LOG"
    else
        echo "Server exited on startup - see $LOG" >&2
        exit 1
    fi
else
    exec "$PYTHON" -u server.py
fi
