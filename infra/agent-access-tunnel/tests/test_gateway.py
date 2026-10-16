import http.client
import os
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer

from gateway.agent_access_gateway import GatewayApp, GatewayHandler, GatewayState


class GatewayStateTests(unittest.TestCase):
    def make_state(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        return GatewayState(
            db_path=os.path.join(tmp.name, "state.sqlite3"),
            master_key_path=os.path.join(tmp.name, "master.key"),
            public_base="https://example.test/agent-access",
            pair_ttl=60,
            access_ttl=60,
            allowed_profiles={"minimax"},
        )

    def test_pair_refresh_access_and_revoke(self):
        state = self.make_state()
        start = state.start_pairing("minimax-code", "minimax", ["mcp"])
        self.assertEqual(state.poll_pairing(start["device_code"])["status"], "pending")
        client_id = state.approve_pairing(start["user_code"])
        approved = state.poll_pairing(start["device_code"])
        self.assertEqual(approved["client_id"], client_id)
        self.assertEqual(
            state.poll_pairing(start["device_code"])["refresh_token"], approved["refresh_token"]
        )
        access = state.issue_access_token(approved["refresh_token"])
        principal = state.verify_access_token(access["access_token"])
        self.assertEqual(principal["client_id"], client_id)
        self.assertTrue(state.revoke_client(client_id))
        with self.assertRaises(PermissionError):
            state.verify_access_token(access["access_token"])
        with self.assertRaises(PermissionError):
            state.issue_access_token(approved["refresh_token"])

    def test_rejects_unknown_profile_or_scope(self):
        state = self.make_state()
        with self.assertRaises(ValueError):
            state.start_pairing("minimax-code", "other", ["mcp"])
        with self.assertRaises(ValueError):
            state.start_pairing("minimax-code", "minimax", ["admin"])

    def test_error_response_closes_backend_connection(self):
        state = self.make_state()
        server = ThreadingHTTPServer(("127.0.0.1", 0), GatewayHandler)
        server.app = GatewayApp(state, "http://127.0.0.1:9")
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)

        conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
        conn.request(
            "POST",
            "/mcp",
            body=b"{}",
            headers={"Content-Type": "application/json", "Content-Length": "2"},
        )
        response = conn.getresponse()
        response.read()
        self.assertEqual(response.status, 401)
        self.assertEqual(response.getheader("Connection"), "close")
        self.assertTrue(response.will_close)

        # HTTPConnection reconnects cleanly instead of trying to reuse the
        # backend socket that still carried the rejected MCP request body.
        conn.request(
            "POST",
            "/v1/pair/start",
            body=b'{"client_name":"after-error","profile":"minimax","scopes":["mcp"]}',
            headers={"Content-Type": "application/json"},
        )
        followup = conn.getresponse()
        followup.read()
        self.assertEqual(followup.status, 200)
        conn.close()


if __name__ == "__main__":
    unittest.main()
