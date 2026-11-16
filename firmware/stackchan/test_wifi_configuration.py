import unittest

from test_http_transport import load_entrypoint


class WifiConfigurationTests(unittest.TestCase):
    def test_agent_body_disables_wifi_power_save_before_static_ip_setup(self):
        module = load_entrypoint()
        calls = []

        class Wlan:
            PM_NONE = 0

            def __init__(self, interface):
                pass

            def active(self, enabled):
                calls.append(("active", enabled))

            def config(self, **kwargs):
                calls.append(("config", kwargs))

            def ifconfig(self, values):
                calls.append(("ifconfig", values))

        module.network.WLAN = Wlan
        module.network.STA_IF = 0
        module.config.DEVICE_IP = "192.168.1.20"
        module.config.NETMASK = "255.255.255.0"
        module.config.GATEWAY = "192.168.1.1"
        module.config.DNS = "192.168.1.1"
        module.configure_wifi()
        self.assertEqual(calls[:2], [("active", True), ("config", {"pm": 0})])
        self.assertEqual(calls[2][0], "ifconfig")

    def test_port_without_power_management_constant_still_connects(self):
        module = load_entrypoint()

        class Wlan:
            def __init__(self, interface):
                pass

            def active(self, enabled):
                self.enabled = enabled

        module.network.WLAN = Wlan
        module.network.STA_IF = 0
        self.assertTrue(module.configure_wifi().enabled)
