import unittest

from light_engine import LightEngine
from test_light_driver import LegacyBoard, little_endian_frame, rgb_tuple


class FakeBoard:
    def __init__(self):
        self.strips = [[0] * 6 for _ in range(2)]
        self.calls = []

    def set_rgb_color(self, *args):
        self.calls.append(args)
        if len(args) == 1:
            color = args[0]
            self.strips = [[color] * 6 for _ in range(2)]
        else:
            strip, index, color = args
            self.strips[strip][index] = color


class PartiallyFailingBoard(FakeBoard):
    def set_rgb_color(self, *args):
        if len(args) == 3 and args[:2] == (0, 0):
            self.calls.append(args)
            raise RuntimeError("LED write failed")
        super().set_rgb_color(*args)


class BufferedBoard:
    """Model the SDK's staged color cache and separate LED refresh latch."""
    def __init__(self):
        self.staged = [[0] * 6 for _ in range(2)]
        self.visible = [[0] * 6 for _ in range(2)]
        self.set_calls = []
        self.refresh_calls = 0
        self.fail_refresh = False
        self.fail_at = None
        self.rgb = self

    def set_rgb_color(self, *args):
        self.set_calls.append(args)
        if len(args) == 1:
            color = args[0]
            self.staged = [[color] * 6 for _ in range(2)]
        else:
            strip, index, color = args
            if self.fail_at == (strip, index):
                raise RuntimeError("staged LED write failed")
            self.staged[strip][index] = color

    def refresh(self):
        self.refresh_calls += 1
        if self.fail_refresh:
            raise RuntimeError("LED latch failed")
        self.visible = [row[:] for row in self.staged]


class LightEngineTests(unittest.TestCase):
    def test_false_returning_fake_setter_can_stage_a_frame(self):
        class FalseReturningFakeBoard(BufferedBoard):
            def set_rgb_color(self, *args):
                super().set_rgb_color(*args)
                return False

        board = FalseReturningFakeBoard()
        engine = LightEngine(board, now_ms=lambda: 0)
        engine.set_state("ready")
        self.assertIsNone(engine.snapshot()["lastError"])
        self.assertEqual(board.refresh_calls, 1)
        self.assertTrue(any(pixel for strip in board.visible for pixel in strip))
        engine.express("happy")
        self.assertEqual(board.refresh_calls, 2)
        self.assertIsNone(engine.snapshot()["lastError"])

    def test_engine_routes_legacy_sdk_around_false_return_setter(self):
        board = LegacyBoard()
        engine = LightEngine(board, now_ms=lambda: 0)

        engine.set_state("connecting")

        state = engine.snapshot()
        writes = board.rgb.ioe1.i2c.writes
        self.assertEqual([entry[1] for entry in writes], [0x30, 0x24])
        self.assertEqual(len(writes[0][2]), 24)
        self.assertEqual(writes[1][2], bytes((76,)))
        self.assertEqual(board.sdk_set_calls, [])
        self.assertEqual(board.rgb.set_color_calls, [])
        logical = [
            [(red << 16) | (green << 8) | blue for red, green, blue in strip]
            for strip in state["strips"]
        ]
        physical = logical[0] + list(reversed(logical[1]))
        self.assertEqual(writes[0][2], little_endian_frame(physical))
        self.assertEqual(board.rgb._colors, [rgb_tuple(color) for color in physical])
        self.assertIsNone(state["lastError"])

    def test_legacy_latch_failure_preserves_engine_snapshot_and_retries_full_frame(self):
        now = [0]
        board = LegacyBoard()
        engine = LightEngine(board, now_ms=lambda: now[0])
        engine.set_state("ready")
        committed = engine.snapshot()
        cached_driver_colors = board.rgb._colors[:]

        now[0] = 80
        board.rgb.ioe1.i2c.fail_memaddr = 0x24
        engine.update(now[0], force=True)
        failed = engine.snapshot()
        self.assertIn("I2C write failed", failed["lastError"])
        self.assertEqual(failed["strips"], committed["strips"])
        self.assertEqual(failed["lastPresentedAtMs"], committed["lastPresentedAtMs"])
        self.assertEqual(board.rgb._colors, cached_driver_colors)

        now[0] = 160
        board.rgb.ioe1.i2c.fail_memaddr = None
        engine.update(now[0], force=True)
        recovered = engine.snapshot()
        self.assertIsNone(recovered["lastError"])
        self.assertEqual(recovered["lastPresentedAtMs"], 160)
        self.assertEqual([entry[1] for entry in board.rgb.ioe1.i2c.writes[-2:]], [0x30, 0x24])

    def test_buffered_sdk_refreshes_once_before_snapshot_colors_are_committed(self):
        board = BufferedBoard()
        engine = LightEngine(board, now_ms=lambda: 0)

        engine.set_state("ready")

        state = engine.snapshot()
        self.assertEqual(board.refresh_calls, 1)
        self.assertEqual(board.visible, board.staged)
        self.assertEqual(
            state["strips"],
            [[[(color >> 16) & 0xFF, (color >> 8) & 0xFF, color & 0xFF]
              for color in row] for row in board.visible],
        )

    def test_unchanged_frame_does_not_refresh_buffered_sdk(self):
        board = BufferedBoard()
        engine = LightEngine(board, now_ms=lambda: 0)
        engine.set_state("error")
        first_presented_at = engine.snapshot()["lastPresentedAtMs"]

        engine.update(0, force=True)

        self.assertEqual(board.refresh_calls, 1)
        self.assertEqual(engine.snapshot()["lastPresentedAtMs"], first_presented_at)

    def test_refresh_failure_keeps_last_success_and_retry_presents_pending_frame(self):
        now = [0]
        board = BufferedBoard()
        board.fail_refresh = True
        engine = LightEngine(board, now_ms=lambda: now[0])

        engine.set_state("ready")
        failed = engine.snapshot()
        self.assertIn("LED latch failed", failed["lastError"])
        self.assertEqual(failed["strips"], [[[0, 0, 0]] * 6] * 2)
        self.assertEqual(board.visible, [[0] * 6 for _ in range(2)])
        self.assertIsNone(failed["lastPresentedAtMs"])

        board.fail_refresh = False
        now[0] = 80
        engine.update(now[0], force=True)
        recovered = engine.snapshot()

        self.assertIsNone(recovered["lastError"])
        self.assertEqual(board.refresh_calls, 2)
        self.assertEqual(board.visible, board.staged)
        self.assertEqual(recovered["lastPresentedAtMs"], 80)
        self.assertEqual(
            recovered["strips"],
            [[[(color >> 16) & 0xFF, (color >> 8) & 0xFF, color & 0xFF]
              for color in row] for row in board.visible],
        )

    def test_partial_staging_error_flushes_successful_pixels_and_retries_failed_pixel(self):
        now = [0]
        board = BufferedBoard()
        board.fail_at = (0, 0)
        engine = LightEngine(board, now_ms=lambda: now[0])

        engine.set_state("connecting")
        partial = engine.snapshot()
        self.assertIn("staged LED write failed", partial["lastError"])
        self.assertEqual(board.refresh_calls, 1)
        self.assertEqual(partial["strips"][0][0], [0, 0, 0])
        self.assertEqual(board.visible[0][0], 0)
        self.assertEqual(partial["lastPresentedAtMs"], 0)

        board.fail_at = None
        now[0] = 80
        engine.update(now[0], force=True)
        recovered = engine.snapshot()

        self.assertIsNone(recovered["lastError"])
        self.assertEqual(board.refresh_calls, 2)
        self.assertEqual(recovered["strips"][0][0], [127, 77, 16])
        self.assertEqual(board.visible[0][0], 0x7F4D10)

    def test_idle_ready_breath_uses_at_most_half_the_previous_peak_brightness(self):
        now = [0]
        board = FakeBoard()
        engine = LightEngine(board, now_ms=lambda: now[0])

        engine.set_state("ready")
        first_peak = None
        for timestamp in range(0, 20001, engine.FRAME_INTERVAL_MS):
            now[0] = timestamp
            engine.update(timestamp, force=True)
            frame = engine.snapshot()
            self.assertEqual(frame["source"], "lifecycle")
            self.assertEqual(frame["pattern"], "ready_breathe")
            self.assertEqual(frame["intensity"], 0.25)
            channels = [channel
                        for strip in frame["strips"]
                        for pixel in strip
                        for channel in pixel]
            self.assertEqual(max(pixel[2] for strip in frame["strips"]
                                 for pixel in strip), 0)
            self.assertTrue(all(
                not any(pixel) or pixel[0] > pixel[1] > pixel[2]
                for strip in frame["strips"]
                for pixel in strip
            ))
            self.assertLessEqual(
                max(channels), 26,
            )
            if timestamp == 2000:
                first_peak = max(channels)
        self.assertEqual(first_peak, 26)

    def test_ready_breath_is_slow_and_stays_in_ready_over_extended_idle(self):
        now = [0]
        engine = LightEngine(FakeBoard(), now_ms=lambda: now[0])

        engine.set_state("ready")
        for timestamp in range(0, 20001, engine.FRAME_INTERVAL_MS):
            now[0] = timestamp
            engine.update(timestamp, force=True)
            frame = engine.snapshot()
            self.assertEqual(frame["mode"], "ready")
            self.assertEqual(frame["pattern"], "ready_breathe")
            if timestamp == 2000:
                self.assertEqual(frame["strips"][0][0], [26, 20, 0])

    def test_ready_breath_is_nonblocking_and_snapshot_reports_written_colors(self):
        now = [0]
        board = FakeBoard()
        engine = LightEngine(board, now_ms=lambda: now[0])

        engine.set_state("ready")
        first_calls = len(board.calls)
        first_colors = [row[:] for row in board.strips]
        first_frame = [
            [[(color >> 16) & 0xFF, (color >> 8) & 0xFF, color & 0xFF]
             for color in row]
            for row in board.strips
        ]
        self.assertEqual(first_calls, 1)
        self.assertEqual(engine.snapshot()["strips"], first_frame)

        now[0] = 79
        engine.update(now[0])
        self.assertEqual(len(board.calls), first_calls)

        now[0] = 80
        engine.update(now[0])
        self.assertGreater(len(board.calls), first_calls)
        self.assertNotEqual(board.strips, first_colors)

    def test_priority_modes_and_camera_action_override_lower_priority_effects(self):
        now = [0]
        board = FakeBoard()
        engine = LightEngine(board, now_ms=lambda: now[0])

        engine.set_state("connecting")
        connecting = engine.snapshot()
        self.assertEqual(connecting["pattern"], "connecting_chase")
        self.assertTrue(any(color[0] and color[1] for strip in connecting["strips"] for color in strip))

        engine.set_state("acting", action="camera.capture")
        capture = engine.snapshot()
        self.assertEqual(capture["pattern"], "camera_recording")
        self.assertTrue(engine.express("happy", intensity=0.5, duration_ms=1000))
        self.assertTrue(engine.touch())
        self.assertEqual(engine.snapshot()["pattern"], "camera_recording")

        engine.set_state("sleeping")
        sleeping = engine.snapshot()
        self.assertEqual(sleeping["pattern"], "sleep_breathe")
        self.assertIsNone(sleeping["emotion"])
        self.assertLessEqual(max(channel for strip in sleeping["strips"] for color in strip for channel in color), 17)

        engine.set_state("error")
        error = engine.snapshot()
        self.assertEqual(error["pattern"], "error_pulse")
        self.assertTrue(all(color[1:] == [0, 0] for strip in error["strips"] for color in strip))
        self.assertFalse(engine.express("curious"))
        self.assertFalse(engine.touch())

        engine.set_state("shutting_down")
        self.assertEqual(engine.snapshot()["pattern"], "shutdown_black")
        self.assertTrue(all(color == [0, 0, 0] for strip in engine.snapshot()["strips"] for color in strip))
        self.assertFalse(engine.express("calm"))
        now[0] += 1000
        engine.update(now[0])
        self.assertTrue(all(color == [0, 0, 0] for strip in engine.snapshot()["strips"] for color in strip))

    def test_guiding_has_its_own_lifecycle_pattern(self):
        board = FakeBoard()
        engine = LightEngine(board, now_ms=lambda: 0)

        engine.set_state("ready", guiding=True)

        state = engine.snapshot()
        self.assertTrue(state["guiding"])
        self.assertEqual(state["pattern"], "guiding_pair")
        self.assertNotEqual(state["strips"][0], state["strips"][1])

    def test_emotion_leases_are_named_timed_and_revert_to_lifecycle(self):
        emotions = (
            "happy", "curious", "thinking", "listening", "speaking",
            "concerned", "calm",
        )
        observed_patterns = set()
        for emotion in emotions:
            with self.subTest(emotion=emotion):
                now = [0]
                engine = LightEngine(FakeBoard(), now_ms=lambda: now[0])
                engine.set_state("ready")

                self.assertTrue(engine.express(emotion, intensity=0.7, duration_ms=1000))
                active = engine.snapshot()
                self.assertEqual(active["source"], "emotion")
                self.assertEqual(active["emotion"], emotion)
                self.assertEqual(active["remainingMs"], 1000)
                self.assertEqual(active["intensity"], 0.7)
                self.assertNotEqual(active["strips"][0], active["strips"][1])
                observed_patterns.add(active["pattern"])

                now[0] = 1000
                engine.update(now[0])
                expired = engine.snapshot()
                self.assertEqual(expired["source"], "lifecycle")
                self.assertEqual(expired["pattern"], "ready_breathe")
                self.assertIsNone(expired["emotion"])

        self.assertEqual(len(observed_patterns), len(emotions))

    def test_snapshot_at_lease_expiry_is_read_only_and_marks_last_presented_frame(self):
        now = [0]
        board = FakeBoard()
        engine = LightEngine(board, now_ms=lambda: now[0])
        engine.set_state("ready")
        engine.express("happy", intensity=0.5, duration_ms=1000)
        call_count = len(board.calls)
        presented_at = engine.snapshot()["lastPresentedAtMs"]

        now[0] = 1000
        state = engine.snapshot()

        self.assertEqual(state["source"], "emotion")
        self.assertIsNone(state["emotion"])
        self.assertEqual(state["remainingMs"], 0)
        self.assertEqual(state["lastPresentedAtMs"], presented_at)
        self.assertEqual(len(board.calls), call_count)

        engine.update(now[0])
        self.assertEqual(engine.snapshot()["source"], "lifecycle")
        self.assertEqual(len(board.calls), call_count + 1)

    def test_touch_wave_temporarily_precedes_emotion_then_yields_back(self):
        now = [0]
        board = FakeBoard()
        engine = LightEngine(board, now_ms=lambda: now[0])
        engine.set_state("ready")
        engine.express("happy", intensity=0.5, duration_ms=2000)

        self.assertTrue(engine.touch())
        touched = engine.snapshot()
        self.assertEqual(touched["source"], "touch")
        self.assertEqual(touched["pattern"], "touch_wave")
        self.assertEqual(touched["remainingMs"], 700)
        self.assertTrue(any(color[2] > color[0] for strip in touched["strips"] for color in strip))

        now[0] = 700
        engine.update(now[0])
        self.assertEqual(engine.snapshot()["source"], "emotion")
        self.assertEqual(engine.snapshot()["emotion"], "happy")

    def test_manual_colors_suspend_effects_and_resume_or_yield_to_lifecycle(self):
        now = [0]
        board = FakeBoard()
        engine = LightEngine(board, now_ms=lambda: now[0])
        engine.set_state("ready")

        self.assertTrue(engine.set_manual(0x123456))
        self.assertEqual(board.calls[-1], (0x123456,))
        manual = engine.snapshot()
        self.assertEqual(manual["source"], "manual")
        self.assertTrue(manual["suspended"])
        self.assertEqual(manual["strips"], [[[0x12, 0x34, 0x56]] * 6] * 2)

        call_count = len(board.calls)
        now[0] += 400
        engine.update(now[0])
        self.assertEqual(len(board.calls), call_count)

        self.assertTrue(engine.resume())
        self.assertEqual(engine.snapshot()["source"], "lifecycle")
        self.assertFalse(engine.snapshot()["suspended"])
        self.assertNotEqual(board.strips[0][0], 0x123456)

        self.assertTrue(engine.set_manual(0xABCDEF, strip=1, index=4))
        self.assertEqual(board.calls[-1], (1, 4, 0xABCDEF))
        engine.set_state("error")
        self.assertEqual(engine.snapshot()["source"], "lifecycle")
        self.assertFalse(engine.snapshot()["suspended"])
        self.assertFalse(engine.set_manual(0x123456))

    def test_normal_mode_change_keeps_manual_override_until_parent_resumes(self):
        now = [0]
        board = FakeBoard()
        engine = LightEngine(board, now_ms=lambda: now[0])
        engine.set_state("ready")
        engine.set_manual(0x123456)
        call_count = len(board.calls)

        now[0] = 40
        engine.set_state("acting", action="camera.capture")
        engine.update(now[0] + 200)

        self.assertEqual(len(board.calls), call_count)
        self.assertEqual(engine.snapshot()["source"], "manual")
        self.assertTrue(engine.snapshot()["suspended"])
        self.assertTrue(engine.resume())
        self.assertEqual(engine.snapshot()["source"], "lifecycle")

    def test_resume_clears_emotion_and_touch_leases_before_lifecycle(self):
        board = FakeBoard()
        engine = LightEngine(board, now_ms=lambda: 0)
        engine.set_state("ready")
        engine.express("happy", intensity=0.5, duration_ms=1000)
        engine.touch()
        engine.set_manual(0x123456)

        self.assertTrue(engine.resume())

        state = engine.snapshot()
        self.assertEqual(state["source"], "lifecycle")
        self.assertIsNone(state["emotion"])
        self.assertIsNone(state["remainingMs"])

    def test_partial_driver_write_failure_is_reported_without_raising(self):
        engine = LightEngine(PartiallyFailingBoard(), now_ms=lambda: 0)

        engine.set_state("booting")

        self.assertIn("LED write failed", engine.snapshot()["lastError"])
        self.assertEqual(len(engine.snapshot()["strips"]), 2)

    def test_unchanged_chase_frames_do_not_write_and_changed_frames_are_differential(self):
        now = [0]
        board = FakeBoard()
        engine = LightEngine(board, now_ms=lambda: now[0])

        engine.set_state("connecting")
        initial_count = len(board.calls)
        self.assertLessEqual(initial_count, 12)

        now[0] = 80
        engine.update(now[0])
        self.assertEqual(len(board.calls), initial_count)

        now[0] = 160
        engine.update(now[0])
        self.assertLess(len(board.calls) - initial_count, 12)


if __name__ == "__main__":
    unittest.main()
