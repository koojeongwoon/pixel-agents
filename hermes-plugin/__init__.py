"""Hermes observer plugin for a colocated Pixel Agents standalone server.

The plugin is deliberately metadata-only: it never forwards prompt text,
assistant output, tool results, terminal commands, or approval descriptions.
Delivery is best-effort and can never fail a Hermes hook callback.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable

HOOK_EVENTS = (
    "on_session_start",
    "post_llm_call",
    "pre_tool_call",
    "post_tool_call",
    "pre_approval_request",
    "on_session_end",
    "on_session_finalize",
    "on_session_reset",
)

SCHEMA_VERSION = "hermes.observer.v1"
DEFAULT_STATE_DIR = Path.home() / ".pixel-agents"
REQUEST_TIMEOUT_SECONDS = 0.75
MAX_REGISTRY_FILES = 32
MAX_SAFE_PATH_LENGTH = 1024

# Only these path-like arguments improve the office label. Everything else,
# especially terminal commands and web queries, stays inside Hermes.
SAFE_TOOL_INPUT_KEYS: dict[str, tuple[str, ...]] = {
    "read_file": ("path", "file_path"),
    "write_file": ("path", "file_path"),
    "patch": ("path", "file_path"),
}


def _non_empty_string(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _session_id(event_name: str, kwargs: dict[str, Any]) -> str | None:
    direct = _non_empty_string(kwargs.get("session_id"))
    if direct:
        return direct
    if event_name in {"pre_tool_call", "post_tool_call"}:
        return _non_empty_string(kwargs.get("task_id"))
    if event_name in {"pre_approval_request", "post_approval_response"}:
        return _non_empty_string(kwargs.get("session_key"))
    if event_name == "on_session_reset":
        return _non_empty_string(kwargs.get("old_session_id"))
    return None


def _safe_tool_input(tool_name: str, kwargs: dict[str, Any]) -> dict[str, str] | None:
    raw = kwargs.get("tool_input")
    if not isinstance(raw, dict):
        raw = kwargs.get("args")
    if not isinstance(raw, dict):
        return None

    safe: dict[str, str] = {}
    for key in SAFE_TOOL_INPUT_KEYS.get(tool_name, ()):
        value = _non_empty_string(raw.get(key))
        if value:
            safe[key] = value[:MAX_SAFE_PATH_LENGTH]
    return safe or None


def payload_for_event(event_name: str, kwargs: dict[str, Any]) -> dict[str, Any] | None:
    """Build the minimal wire payload, or None when it cannot be routed."""

    session_id = _session_id(event_name, kwargs)
    if not session_id:
        return None

    payload: dict[str, Any] = {
        "telemetry_schema_version": SCHEMA_VERSION,
        "hook_event_name": event_name,
        "session_id": session_id,
    }

    cwd = _non_empty_string(kwargs.get("cwd"))
    if event_name == "on_session_start" and not cwd:
        cwd = os.getcwd()
    if cwd:
        payload["cwd"] = cwd[:MAX_SAFE_PATH_LENGTH]

    if event_name == "on_session_start":
        platform = _non_empty_string(kwargs.get("platform"))
        if platform:
            payload["platform"] = platform

    if event_name in {"pre_tool_call", "post_tool_call"}:
        tool_name = _non_empty_string(kwargs.get("tool_name"))
        tool_call_id = _non_empty_string(kwargs.get("tool_call_id"))
        if not tool_name:
            return None
        payload["tool_name"] = tool_name
        if tool_call_id:
            payload["tool_call_id"] = tool_call_id
        if event_name == "pre_tool_call":
            safe_input = _safe_tool_input(tool_name, kwargs)
            if safe_input:
                payload["tool_input"] = safe_input

    reason = _non_empty_string(kwargs.get("reason"))
    if reason and event_name in {"on_session_finalize", "on_session_reset"}:
        payload["reason"] = reason

    return payload


def _state_dir() -> Path:
    configured = _non_empty_string(os.environ.get("PIXEL_AGENTS_STATE_DIR"))
    return Path(configured) if configured else DEFAULT_STATE_DIR


def _server_target(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    port = value.get("port")
    token = value.get("token")
    if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
        return None
    if not isinstance(token, str) or not token:
        return None
    return {"port": port, "token": token}


def discover_servers() -> list[dict[str, Any]]:
    """Read current registry entries, falling back to legacy server.json.

    PID liveness is intentionally not checked: the Hermes and Pixel Agents
    containers do not share a PID namespace. Failed POSTs are the liveness test.
    """

    state_dir = _state_dir()
    targets: list[dict[str, Any]] = []
    registry_dir = state_dir / "servers"
    try:
        files = sorted(registry_dir.glob("*.json"))[:MAX_REGISTRY_FILES]
    except OSError:
        files = []

    for file_path in files:
        try:
            target = _server_target(json.loads(file_path.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError):
            target = None
        if target and target not in targets:
            targets.append(target)

    if targets:
        return targets

    try:
        legacy = json.loads((state_dir / "server.json").read_text(encoding="utf-8"))
        target = _server_target(legacy)
        return [target] if target else []
    except (OSError, json.JSONDecodeError):
        return []


def configured_server() -> dict[str, Any] | None:
    """Return the explicitly configured remote target, when both values exist."""

    url = _non_empty_string(os.environ.get("PIXEL_AGENTS_HOOK_URL"))
    token = _non_empty_string(os.environ.get("PIXEL_AGENTS_HOOK_TOKEN"))
    if not url or not token:
        return None
    try:
        parsed = urllib.parse.urlparse(url)
    except ValueError:
        return None
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return None
    if parsed.username or parsed.password or parsed.fragment:
        return None
    return {"url": url.rstrip("/"), "token": token}


def _post(target: dict[str, Any], payload: dict[str, Any]) -> None:
    data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        target.get("url", f"http://127.0.0.1:{target.get('port')}/api/hooks/hermes"),
        data=data,
        method="POST",
        headers={
            "Authorization": f"Bearer {target['token']}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS):
            pass
    except (OSError, urllib.error.URLError, ValueError):
        pass


def publish(event_name: str, kwargs: dict[str, Any]) -> None:
    """Best-effort delivery. No exception may escape into Hermes."""

    try:
        payload = payload_for_event(event_name, kwargs)
        if payload is None:
            return
        remote = configured_server()
        targets = [remote] if remote else discover_servers()
        for target in targets:
            _post(target, payload)
    except Exception:
        # Hermes hooks are observational. Visualization must never affect the agent.
        return


def _make_hook(event_name: str) -> Callable[..., None]:
    def hook(**kwargs: Any) -> None:
        publish(event_name, kwargs)

    return hook


def register(ctx: Any) -> None:
    for event_name in HOOK_EVENTS:
        ctx.register_hook(event_name, _make_hook(event_name))
