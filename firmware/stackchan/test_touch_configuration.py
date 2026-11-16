import types
import unittest

from test_http_transport import load_entrypoint


class TouchConfigurationTests(unittest.TestCase):
    def test_startup_uses_original_stackchan_touch_sensitivity(self):
        calls = []
        touch = types.SimpleNamespace(
            set_sensitivity=lambda kind, level: calls.append((kind, level)) or 0,
        )
        module = load_entrypoint()
        self.assertTrue(module.configure_touch(types.SimpleNamespace(touch=touch)))
        self.assertEqual(calls, [(1, 4)])

    def test_unavailable_touch_driver_is_optional(self):
        self.assertFalse(load_entrypoint().configure_touch(types.SimpleNamespace()))

    def test_rejected_configuration_is_reported(self):
        touch = types.SimpleNamespace(set_sensitivity=lambda kind, level: -1)
        with self.assertRaisesRegex(RuntimeError, "sensitivity"):
            load_entrypoint().configure_touch(types.SimpleNamespace(touch=touch))
