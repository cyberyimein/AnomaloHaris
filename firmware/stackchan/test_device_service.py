import unittest

from device_service import DeviceServicePump, transfer_call


class DeviceServicePumpTests(unittest.TestCase):
    def test_transfer_scope_restores_previous_state_even_after_an_error(self):
        class Device:
            active = False

            def set_transfer_active(self, value):
                previous = self.active
                self.active = value
                return previous

        device = Device()

        def fail():
            self.assertTrue(device.active)
            raise OSError("disconnected client")

        with self.assertRaisesRegex(OSError, "disconnected client"):
            transfer_call(device, fail)
        self.assertFalse(device.active)
        device.active = True
        self.assertTrue(transfer_call(device, lambda: device.active))
        self.assertTrue(device.active)

    def test_expensive_tick_does_not_immediately_trigger_another_tick(self):
        clock = [0]
        calls = []

        def update():
            calls.append(True)
            clock[0] += 30

        pump = DeviceServicePump(update, now_ms=lambda: clock[0], interval_ms=20)
        self.assertTrue(pump.service())
        self.assertFalse(pump.service())
        clock[0] += 19
        self.assertFalse(pump.service())
        clock[0] += 1
        self.assertTrue(pump.service())
        self.assertEqual(len(calls), 2)
        self.assertEqual(pump.metrics["maxServiceGapMs"], 50)
        self.assertEqual(pump.metrics["serviceCount"], 2)

    def test_tick_failure_propagates_and_keeps_retry_interval(self):
        clock = [0]

        def update():
            clock[0] += 40
            raise RuntimeError("failed peripheral")

        pump = DeviceServicePump(update, now_ms=lambda: clock[0])
        with self.assertRaisesRegex(RuntimeError, "failed peripheral"):
            pump.service()
        self.assertFalse(pump.service())
