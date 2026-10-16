import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


class BridgePairingUxTests(unittest.TestCase):
    def setUp(self):
        self.bridge = (
            Path(__file__).resolve().parents[1]
            / "plugin"
            / "webagenttools-home"
            / "bridge.py"
        )

    def test_status_reports_pairing_required_structurally(self):
        with tempfile.TemporaryDirectory() as temp:
            env = {
                **os.environ,
                "PLUGIN_DATA": temp,
                "AGENT_ACCESS_BASE_URL": "https://example.invalid/agent-access",
            }
            result = subprocess.run(
                [sys.executable, str(self.bridge), "--status"],
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
        self.assertEqual(result.returncode, 1)
        body = json.loads(result.stdout)
        self.assertFalse(body["paired"])
        self.assertEqual(body["state"], "pairing_required")
        self.assertEqual(body["code"], "AGENT_ACCESS_PAIRING_REQUIRED")

    def test_stdio_error_says_installed_but_not_authorized(self):
        request = {
            "jsonrpc": "2.0",
            "id": "probe",
            "method": "server/discover",
            "params": {},
        }
        with tempfile.TemporaryDirectory() as temp:
            env = {
                **os.environ,
                "PLUGIN_DATA": temp,
                "AGENT_ACCESS_BASE_URL": "https://example.invalid/agent-access",
            }
            result = subprocess.run(
                [sys.executable, str(self.bridge)],
                env=env,
                text=True,
                input=json.dumps(request) + "\n",
                capture_output=True,
                check=False,
            )
        self.assertEqual(result.returncode, 0)
        self.assertIn("AGENT_ACCESS_PAIRING_REQUIRED", result.stderr)
        self.assertIn("not a Plugin-enable or MCP-registration failure", result.stderr)
        response = json.loads(result.stdout)
        self.assertEqual(response["id"], "probe")
        self.assertIn("AGENT_ACCESS_PAIRING_REQUIRED", response["error"]["message"])
        self.assertIn("future sessions authenticate automatically", response["error"]["message"])


if __name__ == "__main__":
    unittest.main()
