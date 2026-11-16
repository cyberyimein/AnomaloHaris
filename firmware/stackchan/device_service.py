"""Rate-limit cooperative peripheral work by completion time, not start time."""

import time


def _now_ms():
    ticks = getattr(time, "ticks_ms", None)
    return ticks() if ticks else int(time.monotonic() * 1000)


def transfer_call(device, operation):
    """Service physical inputs during I/O while deferring expensive LCD updates."""
    set_active = getattr(device, "set_transfer_active", None)
    if not callable(set_active):
        return operation()
    previous = set_active(True)
    try:
        return operation()
    finally:
        set_active(previous)


class DeviceServicePump:
    def __init__(self, update, now_ms=None, interval_ms=20):
        self.update = update
        self.now_ms = now_ms or _now_ms
        self.interval_ms = interval_ms
        self.last_started = None
        self.last_finished = None
        self.metrics = {"maxServiceGapMs": 0, "lastServiceAtMs": None, "serviceCount": 0}

    @staticmethod
    def _elapsed(now, previous):
        difference = getattr(time, "ticks_diff", None)
        return difference(now, previous) if difference else now - previous

    def service(self):
        now = self.now_ms()
        if self.last_finished is not None:
            if self._elapsed(now, self.last_finished) < self.interval_ms:
                return False
        if self.last_started is not None:
            self.metrics["maxServiceGapMs"] = max(
                self.metrics["maxServiceGapMs"], self._elapsed(now, self.last_started),
            )
        self.last_started = now
        self.metrics["lastServiceAtMs"] = now
        self.metrics["serviceCount"] += 1
        try:
            self.update()
        finally:
            # Slow native rendering/I2C must leave a window for socket progress.
            self.last_finished = self.now_ms()
        return True
