from __future__ import annotations

import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

PLUGIN_PATH = Path(__file__).with_name("__init__.py")
SPEC = importlib.util.spec_from_file_location("pixel_agents_status", PLUGIN_PATH)
assert SPEC and SPEC.loader
plugin = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(plugin)


class PayloadContractTest(unittest.TestCase):
    def test_session_start_always_includes_a_working_directory(self) -> None:
        with patch.object(plugin.os, "getcwd", return_value="/workspace"):
            payload = plugin.payload_for_event("on_session_start", {"session_id": "session-1"})

        self.assertEqual(payload["cwd"], "/workspace")

    def test_tool_payload_keeps_only_safe_path_metadata(self) -> None:
        payload = plugin.payload_for_event(
            "pre_tool_call",
            {
                "session_id": "telegram:123",
                "tool_call_id": "call-1",
                "tool_name": "read_file",
                "args": {
                    "path": "/workspace/README.md",
                    "content": "secret file contents",
                    "api_key": "secret-key",
                },
                "result": "secret result",
                "user_message": "secret prompt",
            },
        )

        self.assertEqual(
            payload,
            {
                "telemetry_schema_version": "hermes.observer.v1",
                "hook_event_name": "pre_tool_call",
                "session_id": "telegram:123",
                "tool_call_id": "call-1",
                "tool_name": "read_file",
                "tool_input": {"path": "/workspace/README.md"},
            },
        )

    def test_terminal_command_is_never_forwarded(self) -> None:
        payload = plugin.payload_for_event(
            "pre_tool_call",
            {
                "session_id": "telegram:123",
                "tool_name": "terminal",
                "args": {"command": "cat /run/secrets/token"},
            },
        )
        self.assertNotIn("tool_input", payload or {})
        self.assertNotIn("command", json.dumps(payload))

    def test_tool_hook_uses_hermes_task_id_when_session_id_is_absent(self) -> None:
        payload = plugin.payload_for_event(
            "post_tool_call",
            {"task_id": "task-123", "tool_name": "read_file"},
        )
        self.assertEqual(payload["session_id"], "task-123")

    def test_approval_uses_session_key_without_command(self) -> None:
        payload = plugin.payload_for_event(
            "pre_approval_request",
            {
                "session_key": "telegram:123",
                "command": "sudo dangerous-command",
                "description": "sensitive reason",
            },
        )
        self.assertEqual(
            payload,
            {
                "telemetry_schema_version": "hermes.observer.v1",
                "hook_event_name": "pre_approval_request",
                "session_id": "telegram:123",
            },
        )

    def test_unroutable_event_is_dropped(self) -> None:
        self.assertIsNone(plugin.payload_for_event("post_llm_call", {}))


class RegistryTest(unittest.TestCase):
    def test_uses_valid_explicit_remote_target(self) -> None:
        env = {
            "PIXEL_AGENTS_HOOK_URL": "http://pixel-agents:3000/api/hooks/hermes",
            "PIXEL_AGENTS_HOOK_TOKEN": "remote-token",
        }
        with patch.dict(os.environ, env, clear=True):
            self.assertEqual(
                plugin.configured_server(),
                {
                    "url": "http://pixel-agents:3000/api/hooks/hermes",
                    "token": "remote-token",
                },
            )

    def test_rejects_credentials_embedded_in_remote_url(self) -> None:
        env = {
            "PIXEL_AGENTS_HOOK_URL": "http://user:pass@pixel-agents:3000/api/hooks/hermes",
            "PIXEL_AGENTS_HOOK_TOKEN": "remote-token",
        }
        with patch.dict(os.environ, env, clear=True):
            self.assertIsNone(plugin.configured_server())

    def test_discovers_valid_registry_entries_without_pid_visibility(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp)
            registry = state / "servers"
            registry.mkdir()
            (registry / "valid.json").write_text(
                json.dumps({"port": 3100, "pid": 999999, "token": "token-1"}),
                encoding="utf-8",
            )
            (registry / "invalid.json").write_text('{"port":"bad"}', encoding="utf-8")
            with patch.dict(os.environ, {"PIXEL_AGENTS_STATE_DIR": tmp}):
                self.assertEqual(plugin.discover_servers(), [{"port": 3100, "token": "token-1"}])

    def test_falls_back_to_legacy_server_json(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp)
            (state / "server.json").write_text(
                json.dumps({"port": 3200, "pid": 1, "token": "legacy"}),
                encoding="utf-8",
            )
            with patch.dict(os.environ, {"PIXEL_AGENTS_STATE_DIR": tmp}):
                self.assertEqual(plugin.discover_servers(), [{"port": 3200, "token": "legacy"}])


class DeliveryTest(unittest.TestCase):
    def test_explicit_remote_target_takes_precedence_over_local_registry(self) -> None:
        remote = {
            "url": "http://pixel-agents:3000/api/hooks/hermes",
            "token": "remote-token",
        }
        with patch.object(plugin, "configured_server", return_value=remote):
            with patch.object(plugin, "discover_servers") as discover:
                with patch.object(plugin, "_post") as post:
                    plugin.publish("on_session_start", {"session_id": "session-1"})

        discover.assert_not_called()
        post.assert_called_once()
        self.assertEqual(post.call_args.args[0], remote)

    def test_publish_is_fail_open(self) -> None:
        with patch.object(plugin, "discover_servers", side_effect=RuntimeError("boom")):
            plugin.publish("on_session_start", {"session_id": "session-1"})

    def test_posts_with_bearer_auth_to_hermes_route(self) -> None:
        captured = {}

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

        def fake_urlopen(request, timeout):
            captured["url"] = request.full_url
            captured["authorization"] = request.headers["Authorization"]
            captured["body"] = json.loads(request.data)
            captured["timeout"] = timeout
            return Response()

        with patch.object(plugin, "discover_servers", return_value=[{"port": 3100, "token": "abc"}]):
            with patch.object(plugin.urllib.request, "urlopen", side_effect=fake_urlopen):
                plugin.publish("on_session_start", {"session_id": "session-1"})

        self.assertEqual(captured["url"], "http://127.0.0.1:3100/api/hooks/hermes")
        self.assertEqual(captured["authorization"], "Bearer abc")
        self.assertEqual(captured["body"]["session_id"], "session-1")
        self.assertEqual(captured["timeout"], plugin.REQUEST_TIMEOUT_SECONDS)


if __name__ == "__main__":
    unittest.main()
