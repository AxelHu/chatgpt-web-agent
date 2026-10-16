import json
import tempfile
import unittest
from pathlib import Path

from plugin.install_plugin import install


class PluginInstallTests(unittest.TestCase):
    def setUp(self):
        self.source = Path(__file__).resolve().parents[1] / "plugin"

    def install_variant(self, platform):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        target = install(self.source, Path(temp.name), platform)
        with open(target / "mcp.json", encoding="utf-8") as f:
            config = json.load(f)
        return target, config["mcpServers"]["webagenttools-home"]

    def test_posix_variant_uses_node_launcher(self):
        target, server = self.install_variant("posix")
        self.assertEqual(server["command"], "node")
        self.assertEqual(server["args"], ["${PLUGIN_ROOT}/bridge-launcher.mjs"])
        self.assertTrue((target / "bridge-launcher.mjs").is_file())
        self.assertTrue((target / "bridge.py").is_file())

    def test_windows_variant_uses_python_bridge(self):
        target, server = self.install_variant("windows")
        self.assertEqual(server["command"], "python")
        self.assertEqual(server["args"], ["${PLUGIN_ROOT}/bridge.py"])
        self.assertTrue((target / "bridge.py").is_file())


if __name__ == "__main__":
    unittest.main()
