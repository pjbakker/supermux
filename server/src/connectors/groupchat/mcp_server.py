#!/usr/bin/env python3
"""group-chat — the agent's half of the Company Group Chat connector.

A tiny, credential-free, stdlib-only MCP stdio server. It owns NO state: the
Rust server does. Every tool here is a thin forward to ONE local supermux
endpoint (`POST $SUPERMUX_URL/api/hook/groupchat/tool`), authenticated with the
pane's own per-session `$SUPERMUX_HOOK_TOKEN` and scoped to `$SUPERMUX_SESSION`.

WHY THE SERVER OWNS EVERY RULE. The channel's whole design is a token economy:
a bot's post must never wake another bot, a routing turn must never fan out to
twenty agents, and a history pull must never quietly eat a context window. Those
are enforced server-side — the `@`-strip, the in-company check, the two-tags-
per-turn cap, the 20-row/2k-token read budget. If this script decided any of
them, an agent that rewrote it would decide them instead. It is a forwarder.

WHY THE HOOK TOKEN. It is the same per-session secret the status, board and
browser hooks use: session A's token authenticates ONLY session A. So bot A can
never post as bot B, even though every bot runs this identical script. The
dashboard bearer token is NEVER handed to an agent.

TOOLS
  read_history(budget_tokens?, since_seq?)  -> recent rows, server-budgeted
  who_tagged_me()                           -> why you were pulled in (cheap)
  post_message(text)                        -> one milestone row; wakes nobody
  tag_bot(session, distilled_request)       -> ROUTER ONLY; wakes exactly one bot
  whoami()                                  -> your session + company identity

Transport: MCP stdio — newline-delimited JSON-RPC 2.0, one message per line.
Nothing but protocol JSON goes to stdout (diagnostics go to stderr).

Dependencies: Python 3 standard library only (json, os, sys, urllib).
"""

import json
import os
import sys
import urllib.error
import urllib.request

SERVER_NAME = "group_chat"
SERVER_VERSION = "1.0.0"
DEFAULT_PROTOCOL = "2025-06-18"

# The one endpoint every tool forwards to. Session-scoped + hook-token
# authenticated on the server side.
TOOL_PATH = "/api/hook/groupchat/tool"

# Generous for a local call, short enough that a wedged request surfaces as an
# error the agent can read instead of a hung turn.
CALL_TIMEOUT_SECONDS = 30


def _env(name):
    """Read `name`, treating an UNEXPANDED `${VAR}` placeholder as absent.

    The connector's `mcpServers` entry passes these as `${VAR}` references the
    host expands from the pane environment. If a host ever fails to expand one,
    we must not send the literal `${...}` as a credential — fall through to this
    process's own inherited environment instead (this server is a child of the
    pane, so the real values are there either way)."""
    v = os.environ.get(name) or ""
    if v.startswith("${") and v.endswith("}"):
        return ""
    return v


def _base_url():
    return (_env("SUPERMUX_URL") or "http://127.0.0.1:8823").rstrip("/")


def _session():
    return _env("SUPERMUX_SESSION")


def _token():
    return _env("SUPERMUX_HOOK_TOKEN")


# ── tool descriptors ─────────────────────────────────────────────────────────
READ_HISTORY_TOOL = {
    "name": "read_history",
    "description": (
        "Read recent messages from your company's group chat. The server caps "
        "this at 20 rows and ~2000 tokens whatever you ask for, so it is safe "
        "to call — but call it only when you actually need the context, not on "
        "every turn. Pass `since_seq` (from a previous result) to read forward "
        "through what you have not seen yet; omit it for the newest rows. If "
        "`more_seq` comes back non-null there is more after the last row you "
        "got — call again with `since_seq` set to it."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "budget_tokens": {
                "type": "integer",
                "description": "How much context you are willing to spend. Clamped to 2000.",
            },
            "since_seq": {
                "type": "integer",
                "description": "Return rows AFTER this seq (oldest first). Omit for the newest.",
            },
        },
    },
}

WHO_TAGGED_ME_TOOL = {
    "name": "who_tagged_me",
    "description": (
        "Why you were pulled into the group chat: the assistant's routing line "
        "that tagged you, and the human request behind it. This is the cheap "
        "default — call it FIRST when a delegation arrives, before reaching for "
        "read_history. `tagged: false` means nobody tagged you; that is a real "
        "answer, not an error."
    ),
    "inputSchema": {"type": "object", "properties": {}},
}

POST_MESSAGE_TOOL = {
    "name": "post_message",
    "description": (
        "Post one short milestone to your company's channel — something a human "
        "colleague should see (a thing shipped, a decision made, a blocker "
        "found). It wakes nobody: bots do not read each other's posts, so this "
        "costs no other agent a turn. Every '@' is stripped server-side, so you "
        "cannot summon anyone from here — if you need a specific bot, ask the "
        "human or the assistant. Keep it to a sentence or two."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {"text": {"type": "string", "description": "The milestone, in a sentence or two."}},
        "required": ["text"],
    },
}

TAG_BOT_TOOL = {
    "name": "tag_bot",
    "description": (
        "ROUTER ONLY. Hand ONE distilled request to ONE bot in this company — "
        "this is the only thing in the channel that wakes another agent. At "
        "most two tags per routing turn: the server DROPS the third whatever "
        "you emit, so spend them on the bots that actually own the work. "
        "`distilled_request` is what that bot will read; write the request, not "
        "a pointer to it."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "session": {"type": "string", "description": "The bot's session name, in this company."},
            "distilled_request": {
                "type": "string",
                "description": "The request, distilled to what that one bot needs.",
            },
        },
        "required": ["session", "distilled_request"],
    },
}

WHOAMI_TOOL = {
    "name": "whoami",
    "description": (
        "Who you are in this channel: your session name, your company, and "
        "whether you are its assistant (the router). Call this if you are "
        "unsure whether tag_bot is yours to use."
    ),
    "inputSchema": {"type": "object", "properties": {}},
}

TOOLS = [
    READ_HISTORY_TOOL,
    WHO_TAGGED_ME_TOOL,
    POST_MESSAGE_TOOL,
    TAG_BOT_TOOL,
    WHOAMI_TOOL,
]


# ── the forward ──────────────────────────────────────────────────────────────
def _post_tool(tool, args):
    """POST one tool call to supermux. Returns (payload_dict, http_status).

    Never raises: a transport failure comes back as a payload the agent can
    read, because an MCP tool that throws is a dead end for the turn."""
    session = _session()
    token = _token()
    if not session or not token:
        return (
            {
                "ok": False,
                "error": (
                    "the group chat is not wired into this session "
                    "(SUPERMUX_SESSION / SUPERMUX_HOOK_TOKEN missing)"
                ),
            },
            0,
        )
    body = json.dumps({"session": session, "tool": tool, "args": args}).encode("utf-8")
    req = urllib.request.Request(
        _base_url() + TOOL_PATH,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json", "X-Supermux-Hook-Token": token},
    )
    try:
        with urllib.request.urlopen(req, timeout=CALL_TIMEOUT_SECONDS) as resp:
            raw = resp.read().decode("utf-8", "replace")
            status = resp.status
    except urllib.error.HTTPError as e:  # 4xx/5xx still carry a JSON body
        raw = e.read().decode("utf-8", "replace") if e.fp else ""
        status = e.code
    except Exception as exc:  # transport / timeout
        return ({"ok": False, "error": f"supermux group-chat endpoint unreachable: {exc}"}, 0)
    try:
        payload = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        payload = {"ok": False, "error": f"unreadable response ({status})"}
    if not isinstance(payload, dict):
        payload = {"ok": False, "error": f"unexpected response ({status})"}
    return payload, status


def _text_result(payload):
    return {"content": [{"type": "text", "text": json.dumps(payload, indent=2, ensure_ascii=False)}]}


def _error_result(payload):
    out = _text_result(payload)
    out["isError"] = True
    return out


def _call(tool, args):
    payload, status = _post_tool(tool, args)
    if status == 403:
        # A REFUSAL, not a failure: say which rule in words the agent can act on.
        return _error_result(
            {
                "refused": payload.get("error") or "not allowed",
                "hint": "This tool is not yours to call in this company.",
            }
        )
    if status != 200 or payload.get("ok") is False:
        return _error_result(
            {"error": payload.get("error") or f"group-chat tool failed ({status})", "tool": tool}
        )
    return _text_result(payload.get("result", payload))


def tool_read_history(args):
    payload = {}
    if args.get("budget_tokens") is not None:
        payload["budget_tokens"] = args["budget_tokens"]
    if args.get("since_seq") is not None:
        payload["since_seq"] = args["since_seq"]
    return _call("read_history", payload)


def tool_who_tagged_me(_args):
    return _call("who_tagged_me", {})


def tool_post_message(args):
    text = (args.get("text") or "").strip()
    if not text:
        return _error_result({"error": "post_message needs `text`"})
    return _call("post_message", {"text": text})


def tool_tag_bot(args):
    session = (args.get("session") or "").strip()
    request = (args.get("distilled_request") or "").strip()
    if not session or not request:
        return _error_result({"error": "tag_bot needs `session` and `distilled_request`"})
    return _call("tag_bot", {"session": session, "distilled_request": request})


def tool_whoami(_args):
    return _call("whoami", {})


HANDLERS = {
    "read_history": tool_read_history,
    "who_tagged_me": tool_who_tagged_me,
    "post_message": tool_post_message,
    "tag_bot": tool_tag_bot,
    "whoami": tool_whoami,
}


# ── JSON-RPC / MCP plumbing (same shape as the browser + connect servers) ─────
def _send(msg):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def _result(req_id, result):
    _send({"jsonrpc": "2.0", "id": req_id, "result": result})


def _error(req_id, code, message):
    _send({"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}})


def _handle(msg):
    method = msg.get("method")
    req_id = msg.get("id")
    is_notification = "id" not in msg

    if method == "initialize":
        params = msg.get("params") or {}
        proto = params.get("protocolVersion") or DEFAULT_PROTOCOL
        _result(
            req_id,
            {
                "protocolVersion": proto,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
            },
        )
        return
    if method in ("notifications/initialized", "initialized"):
        return
    if method == "ping":
        _result(req_id, {})
        return
    if method == "tools/list":
        _result(req_id, {"tools": TOOLS})
        return
    if method == "tools/call":
        params = msg.get("params") or {}
        name = params.get("name")
        args = params.get("arguments") or {}
        handler = HANDLERS.get(name)
        if handler is None:
            _error(req_id, -32602, f"unknown tool: {name}")
            return
        _result(req_id, handler(args))
        return

    if is_notification:
        return
    _error(req_id, -32601, f"method not found: {method}")


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        try:
            _handle(msg)
        except Exception as exc:  # never let a handler bug kill the loop
            sys.stderr.write(f"group-chat handler error: {exc}\n")
            sys.stderr.flush()


if __name__ == "__main__":
    main()
