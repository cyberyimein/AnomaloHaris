"""Hardware-independent command router for the StackChan agent device."""

from capabilities import capability_definitions
from schema_validator import validate_arguments, validate_schema

try:
    import time
except ImportError:
    import utime as time

try:
    from driver.scs_servo import SCSCL_TORQUE_ENABLE
except ImportError:
    SCSCL_TORQUE_ENABLE = 40

try:
    import binascii
except ImportError:
    import ubinascii as binascii


def _base64(data):
    return binascii.b2a_base64(data).strip().decode("ascii")


def _integer(args, name, default=None, minimum=None, maximum=None):
    value = args.get(name, default)
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("'{}' must be an integer".format(name))
    if minimum is not None and value < minimum:
        raise ValueError("'{}' is below its supported minimum".format(name))
    if maximum is not None and value > maximum:
        raise ValueError("'{}' is above its supported maximum".format(name))
    return value


def _number(args, name, default=None, minimum=None, maximum=None):
    value = args.get(name, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("'{}' must be a number".format(name))
    if value != value or value == float("inf") or value == float("-inf"):
        raise ValueError("'{}' must be finite".format(name))
    if minimum is not None and value < minimum:
        raise ValueError("'{}' is below its supported minimum".format(name))
    if maximum is not None and value > maximum:
        raise ValueError("'{}' is above its supported maximum".format(name))
    return value


def _object(args):
    if not isinstance(args, dict):
        raise ValueError("Capability args must be an object")
    return args


class _ShutdownInterrupted(RuntimeError):
    """Stop the current action when the service loop starts device shutdown."""


class _ComponentFailure(RuntimeError):
    """Hardware failure tied to a particular component, preserved through routing."""

    def __init__(self, component, message):
        RuntimeError.__init__(self, message)
        self.component = component


def _display_ascii(value):
    return "".join(character if ord(character) < 128 else "?" for character in value)


def _present_display(display):
    present = getattr(display, "present", None)
    if not callable(present):
        return True
    try:
        return present() is not False
    except Exception:
        return False


def draw_startup_feedback(display, brightness_setter=None, cat_renderer=None):
    """Show a cat boot frame when available, otherwise draw the built-in face."""
    if brightness_setter is not None:
        try:
            brightness_setter(128)
        except Exception:
            pass
    if display is None:
        return False
    if cat_renderer is not None:
        try:
            display.fillScreen(0x000000)
            if cat_renderer.render("booting"):
                return True
        except Exception:
            pass

    try:
        background = 0x061321
        display.fillScreen(background)
        width = display.width() if hasattr(display, "width") else 320
        height = display.height() if hasattr(display, "height") else 240
        if hasattr(display, "fillCircle"):
            eye_y = height // 2 - 8
            display.fillCircle(width // 3, eye_y, 19, 0xEAF7FF)
            display.fillCircle((width * 2) // 3, eye_y, 19, 0xEAF7FF)
            display.fillCircle(width // 3, eye_y, 7, 0x39C6F0)
            display.fillCircle((width * 2) // 3, eye_y, 7, 0x39C6F0)
        display.setTextColor(0xD9F4FF, background)
        display.setCursor(14, 12)
        display.setTextSize(2)
        display.print("BOOTING")
    except Exception:
        try:
            display.print("BOOTING")
        except Exception:
            pass
    _present_display(display)
    return False


def poll_power_button(button, device, latched):
    """Request power-off once per long press; call only after M5.update()."""
    if button is None or device is None:
        return False
    if not callable(getattr(getattr(device, "power", None), "powerOff", None)):
        return False
    try:
        if not button.isPressed():
            return False
        if latched:
            return True
        pressed_for = getattr(button, "pressedFor", None)
        if callable(pressed_for) and pressed_for(2000):
            device.request_shutdown()
            device.arm_shutdown_poweroff()
            return True
    except Exception:
        return latched
    return latched


class DeviceController:
    TOUCH_PRESS_STABLE_MS = 120
    TOUCH_RELEASE_STABLE_MS = 200
    SERVO_FEEDBACK_TOLERANCE_DEGREES = 3
    SERVO_FEEDBACK_POLL_MS = 25
    SERVO_FEEDBACK_GRACE_MS = 500
    SERVICE_POLL_INTERVAL_MS = 25
    SHUTDOWN_FALLBACK_DELAY_MS = 2500

    PURE_READ_CAPABILITIES = (
        "touch.read", "power.read", "infrared.read", "nfc.detect",
        "ambient.read", "imu.read",
    )
    SIDE_BAND_CAPABILITIES = PURE_READ_CAPABILITIES + (
        "device.sleep", "device.wake", "led.set", "led.express", "led.resume",
    )
    COMPONENT_BY_CAPABILITY = {
        "head.release": "servo",
        "head.hold": "servo",
        "head.move": "servo",
        "head.home": "servo",
        "head.observe": "camera",
        "camera.capture": "camera",
        "led.set": "lighting",
        "led.express": "lighting",
        "led.resume": "lighting",
        "touch.read": "touch",
        "power.read": "power",
        "infrared.read": "infrared",
        "infrared.send": "infrared",
        "nfc.detect": "nfc",
        "ambient.read": "ambient",
        "imu.read": "imu",
        "speaker.tone": "speaker",
        "display.text": "display",
    }
    RECOVERABLE_COMPONENTS_BY_CAPABILITY = {
        "head.move": ("servo",),
        "head.home": ("servo",),
        "head.observe": ("servo", "camera"),
        "camera.capture": ("camera",),
        "led.set": ("lighting",),
        "led.express": ("lighting",),
        "led.resume": ("lighting",),
        "infrared.send": ("infrared",),
        "speaker.tone": ("speaker",),
        "display.text": ("display",),
    }

    def __init__(self, board, camera, ir=None, nfc=None, speaker=None,
                 display=None, als=None, imu=None, device_id="stackchan",
                 firmware_version="0.3.1", sleep_ms=None, ticks_ms=None,
                 ticks_diff=None, inactivity_sleep_ms=300000,
                 display_brightness=None, cat_renderer=None, power=None,
                 light_engine=None):
        self.board = board
        self.camera = camera
        self.ir = ir
        self.nfc = nfc if nfc is not None else getattr(board, "nfc", None)
        self.speaker = speaker
        self.display = display
        self.cat_renderer = cat_renderer
        self.power = power
        self.als = als
        self.imu = imu
        self.device_id = device_id
        self.firmware_version = firmware_version
        self.sleep_ms = sleep_ms or self._default_sleep
        self.ticks_ms = ticks_ms or self._default_ticks
        self.ticks_diff = ticks_diff or self._default_ticks_diff
        if isinstance(inactivity_sleep_ms, bool) or not isinstance(inactivity_sleep_ms, int) or inactivity_sleep_ms < 0:
            raise ValueError("inactivity_sleep_ms must be a non-negative integer")
        self.inactivity_sleep_ms = inactivity_sleep_ms
        self.display_brightness = display_brightness
        self.active_brightness = 128
        self.sleep_brightness = 12
        self.mode = "booting"
        self.action = "idle"
        self.last_action = None
        self.last_error = None
        self.last_invocation_error = None
        self.faults = []
        self.last_ir = None
        self._servos_ready = False
        self._observed_head = None
        self._head_observed_at_ms = None
        self._service_ready = False
        self._wifi_connected = False
        self._network_started = False
        self._last_activity_ms = self.ticks_ms()
        self._error_since_ms = None
        self._display_message = None
        self._display_message_color = 0xA9C8D7
        self._last_render_state = None
        self._last_brightness = None
        self._pending_render = False
        self._transfer_active = False
        self._defer_render_until_servo_command = False
        self._touch_latched = False
        self._touch_candidate_zones = [0, 0, 0]
        self._touch_candidate_since_ms = self.ticks_ms()
        self._touch_zones = [0, 0, 0]
        self._touch_overlay_active = False
        self._touch_overlay_started_ms = None
        self._touch_led_started_ms = None
        self._manual_led_override = False
        self._led_override_armed = False
        self.guiding = False
        self.light_engine = light_engine
        if self.light_engine is None and board is not None:
            from light_engine import LightEngine
            self.light_engine = LightEngine(board, now_ms=self.ticks_ms)
        self.last_interaction = None
        self._guiding_last_pose = None
        self._guiding_poll_interval_ms = 100
        self._guiding_last_poll_ms = None
        self._guiding_feedback_warning = False
        self.shutdown_requested = False
        self.shutdown_poweroff_armed = False
        self._shutdown_armed_at_ms = None
        self._shutdown_delay_ms = 500
        self._shutdown_requested_at_ms = None
        self._shutdown_poweroff_called = False
        self._service_callback = None
        self._mode_led_colors = {
            "booting": 0x000A14,
            "connecting": 0x100900,
            "ready": 0x001008,
            "acting": 0x000E12,
            "sleeping": 0x00030A,
            "error": 0x140000,
        }
        self._capabilities = capability_definitions(
            self.board, self.camera, self.ir, self.nfc, self.speaker,
            self.display, self.als, self.imu, self.power
        )
        self._capability_by_name = {}
        for capability in self._capabilities:
            validate_schema(capability.get("inputSchema", {"type": "object"}))
            self._capability_by_name[capability["name"]] = capability
        self._handlers = {
            "device.sleep": self._device_sleep,
            "device.wake": self._device_wake,
            "device.shutdown": self._device_shutdown,
            "head.release": self._head_release,
            "head.hold": self._head_hold,
            "head.move": self._head_move,
            "head.home": self._head_home,
            "camera.capture": self._camera_capture,
            "head.observe": self._head_observe,
            "led.set": self._led_set,
            "led.express": self._led_express,
            "led.resume": self._led_resume,
            "touch.read": self._touch_read,
            "power.read": self._power_read,
            "infrared.send": self._infrared_send,
            "infrared.read": self._infrared_read,
            "nfc.detect": self._nfc_detect,
            "speaker.tone": self._speaker_tone,
            "display.text": self._display_text,
            "ambient.read": self._ambient_read,
            "imu.read": self._imu_read,
        }
        if self.ir is not None:
            self.ir.rx_cb(self._record_ir)
        self._apply_lifecycle_led()
        self._render_lifecycle(force=True)

    @staticmethod
    def _default_sleep(duration_ms):
        sleep_ms = getattr(time, "sleep_ms", None)
        if sleep_ms is not None:
            sleep_ms(duration_ms)
        else:
            time.sleep(duration_ms / 1000)

    @staticmethod
    def _default_ticks():
        ticks_ms = getattr(time, "ticks_ms", None)
        if ticks_ms is not None:
            return ticks_ms()
        return int(time.monotonic() * 1000)

    @staticmethod
    def _default_ticks_diff(later, earlier):
        ticks_diff = getattr(time, "ticks_diff", None)
        if ticks_diff is not None:
            return ticks_diff(later, earlier)
        return later - earlier

    def set_service_callback(self, callback):
        """Register the host loop's cooperative hardware/network service hook."""
        if callback is not None and not callable(callback):
            raise ValueError("service callback must be callable or None")
        self._service_callback = callback

    def set_transfer_active(self, active):
        """Pause LCD work during network reads/writes and return the prior state."""
        if not isinstance(active, bool):
            raise ValueError("transfer state must be a boolean")
        previous = self._transfer_active
        self._transfer_active = active
        return previous

    def service(self):
        """Run one host service tick when a callback has been registered."""
        if self._service_callback is not None:
            self._service_callback()
        return not self.shutdown_requested

    def _pump_service(self):
        if self.shutdown_requested:
            raise _ShutdownInterrupted("Device is shutting down")
        self.service()
        if self.shutdown_requested:
            raise _ShutdownInterrupted("Device is shutting down")

    def _cooperative_wait(self, duration_ms):
        """Wait while keeping the UIFlow loop responsive to buttons and I/O."""
        if duration_ms <= 0:
            self._pump_service()
            return
        if self._service_callback is None:
            self.sleep_ms(duration_ms)
            if self.shutdown_requested:
                raise _ShutdownInterrupted("Device is shutting down")
            return

        started_at_ms = self.ticks_ms()
        planned_sleep_ms = 0
        while True:
            elapsed_ms = self.ticks_diff(self.ticks_ms(), started_at_ms)
            if elapsed_ms < planned_sleep_ms:
                elapsed_ms = planned_sleep_ms
            remaining_ms = duration_ms - elapsed_ms
            if remaining_ms <= 0:
                return
            interval_ms = min(self.SERVICE_POLL_INTERVAL_MS, remaining_ms)
            self.sleep_ms(interval_ms)
            planned_sleep_ms += interval_ms
            self._pump_service()

    def register_capability(self, metadata, handler):
        """Register a module-provided capability after controller creation."""
        name = metadata.get("name")
        if not isinstance(name, str) or not name or not callable(handler):
            raise ValueError("A capability needs a non-empty name and handler")
        if name in self._capability_by_name:
            raise ValueError("Capability '{}' is already registered".format(name))
        input_schema = metadata.get("inputSchema", {"type": "object"})
        validate_schema(input_schema)
        required = metadata.get("requires", [])
        for dependency in required:
            if dependency not in self._capability_by_name:
                raise ValueError("Unknown capability dependency '{}'".format(dependency))
        item = {
            "name": name,
            "description": metadata.get("description", ""),
            "inputSchema": input_schema,
        }
        if required:
            item["requires"] = list(required)
        self._capabilities.append(item)
        self._capability_by_name[name] = item
        self._handlers[name] = handler

    def capabilities(self):
        result = []
        for item in self._capabilities:
            copy = dict(item)
            if "requires" in item:
                copy["requires"] = list(item["requires"])
            result.append(copy)
        return result

    def status(self, ip=None, wifi_connected=True, uptime_ms=None):
        if wifi_connected is not None:
            self._wifi_connected = bool(wifi_connected)
        state_status = "busy" if self.mode == "acting" else self.mode
        return {
            "deviceId": self.device_id,
            "firmwareVersion": self.firmware_version,
            "capabilities": self.capabilities(),
            "state": {
                "status": state_status,
                "mode": self.mode,
                "action": self.action,
                "lastAction": self.last_action,
                "lastError": self.last_error,
                "lastInvocationError": self.last_invocation_error,
                "faults": [dict(fault) for fault in self.faults],
                "ip": ip,
                "wifiConnected": wifi_connected,
                "uptimeMs": uptime_ms,
                "head": dict(self._observed_head) if self._servos_ready and self._observed_head is not None else None,
                "headObservedAtMs": self._head_observed_at_ms,
                "guiding": self.guiding,
                "lastInteraction": self._copy_last_interaction(),
                "lighting": self.light_engine.snapshot() if self.light_engine is not None else None,
            },
        }

    def invoke(self, request_id, capability, args):
        try:
            _object(args)
            if not isinstance(request_id, str) or not request_id:
                raise ValueError("requestId must be a non-empty string")
            if capability not in self._capability_by_name:
                raise ValueError("Unknown or unavailable capability '{}'".format(capability))
            item = self._capability_by_name[capability]
            handler = self._handlers.get(capability)
            if handler is None:
                raise ValueError("Capability '{}' has no registered handler".format(capability))
            # Validate before changing activity, mode, lighting, or hardware.
            validate_arguments(item.get("inputSchema", {"type": "object"}), args)
        except ValueError as error:
            self.last_invocation_error = str(error)
            raise

        if self.shutdown_requested:
            if capability == "device.shutdown":
                return {
                    "requestId": request_id,
                    "result": {"ok": True, "mode": "shutting_down"},
                }
            raise RuntimeError("Device is shutting down")

        if self.mode == "sleeping" and capability not in (
                "device.sleep", "device.wake", "device.shutdown"):
            raise RuntimeError("Device is sleeping; invoke device.wake before using capabilities")

        is_sideband = capability in self.SIDE_BAND_CAPABILITIES
        if capability not in self.PURE_READ_CAPABILITIES and capability not in (
                "device.sleep", "device.wake"):
            self._last_activity_ms = self.ticks_ms()

        if is_sideband:
            try:
                result = handler(args)
            except ValueError as error:
                self.last_invocation_error = str(error)
                raise
            except _ShutdownInterrupted:
                raise
            except Exception as error:
                self.last_invocation_error = str(error)
                component = getattr(error, "component", None) or self.COMPONENT_BY_CAPABILITY.get(
                    capability, "module:{}".format(capability)
                )
                self.set_error(str(error), component=component)
                raise
            else:
                self.last_action = capability
                if capability not in self.PURE_READ_CAPABILITIES:
                    self.last_invocation_error = None
                self._clear_recovered_faults(capability, result)
                return {"requestId": request_id, "result": result}
            finally:
                if capability.startswith("led."):
                    self._led_override_armed = False

        if capability not in self.PURE_READ_CAPABILITIES:
            self.action = capability
            if (not self.faults
                    and capability in ("head.move", "head.home", "head.observe")):
                self._defer_render_until_servo_command = True
            if not self.faults:
                self._set_mode("acting")
        try:
            result = handler(args)
            self.last_action = capability
            self.last_invocation_error = None
            self._clear_recovered_faults(capability, result)
            return {"requestId": request_id, "result": result}
        except ValueError as error:
            self.last_invocation_error = str(error)
            raise
        except _ShutdownInterrupted:
            raise
        except Exception as error:
            self.last_invocation_error = str(error)
            component = getattr(error, "component", None) or self.COMPONENT_BY_CAPABILITY.get(
                capability, "module:{}".format(capability)
            )
            self.set_error(str(error), component=component)
            raise
        finally:
            if capability not in self.PURE_READ_CAPABILITIES:
                self._defer_render_until_servo_command = False
                self.action = "idle"
                if self.shutdown_requested:
                    self._render_lifecycle()
                elif self.faults:
                    self._set_mode("error")
                elif self.mode == "acting":
                    self._set_mode(self._connected_mode())
                else:
                    self._render_lifecycle()

    def update(self, wifi_connected=None, service_ready=None):
        try:
            self._update_state(wifi_connected, service_ready)
        finally:
            self._update_lighting(self.ticks_ms())

    def _update_state(self, wifi_connected=None, service_ready=None):
        """Refresh network/lifecycle state and run the inactivity sleep timer."""
        if wifi_connected is not None:
            self._wifi_connected = bool(wifi_connected)
            self._network_started = True
        if service_ready is not None:
            became_ready = service_ready and not self._service_ready
            self._service_ready = bool(service_ready)
            if service_ready:
                self._network_started = True
            if became_ready:
                self._last_activity_ms = self.ticks_ms()

        now = self.ticks_ms()
        if self.shutdown_requested:
            self._power_off_if_due(now)
            self._tick_cat_renderer(now)
            return
        self._poll_touch(now)
        if self.mode == "sleeping":
            self._finish_touch_effects(now)
            self._tick_cat_renderer(now)
            return
        if self.mode == "acting":
            self._finish_touch_effects(now)
            self._tick_cat_renderer(now)
            return
        if self.faults:
            if self.mode != "sleeping":
                self._set_mode("error")
            self._finish_touch_effects(now)
            self._tick_cat_renderer(now)
            return
        if self.mode == "error":
            self._set_mode(self._connected_mode())

        if self._network_started:
            self._set_mode(self._connected_mode())
        self._poll_guiding_feedback(now)
        if (self.inactivity_sleep_ms > 0 and self._service_ready
                and self.mode in ("ready", "connecting")
                and self.ticks_diff(now, self._last_activity_ms) >= self.inactivity_sleep_ms):
            self._enter_sleep()
        self._finish_touch_effects(now)
        self._tick_cat_renderer(now)

    def request_shutdown(self):
        """Begin visible shutdown without cutting power before its response."""
        power_off = getattr(self.power, "powerOff", None)
        if not callable(power_off):
            raise RuntimeError("Hardware power-off API is unavailable")
        if self.shutdown_requested:
            return {"ok": True, "mode": "shutting_down"}

        self.shutdown_requested = True
        self._shutdown_requested_at_ms = self.ticks_ms()
        self.shutdown_poweroff_armed = False
        self._shutdown_armed_at_ms = None
        self._shutdown_poweroff_called = False
        self.guiding = False
        self._guiding_last_pose = None
        self._guiding_last_poll_ms = None
        self._safe_deenergize_servos()
        self._manual_led_override = False
        if self.board is not None:
            try:
                self.board.set_rgb_color(0)
            except Exception:
                pass
        set_power_led = getattr(self.power, "setLed", None)
        if callable(set_power_led):
            try:
                set_power_led(0)
            except Exception:
                pass

        self.action = "device.shutdown"
        self._set_mode("shutting_down")
        self.action = "idle"
        self._render_lifecycle(force=True, immediate=True)
        return {"ok": True, "mode": "shutting_down"}

    def arm_shutdown_poweroff(self):
        """Start the power-off delay after an HTTP response has been flushed."""
        if not self.shutdown_requested or self._shutdown_poweroff_called:
            return False
        if self.shutdown_poweroff_armed:
            return True
        self._shutdown_armed_at_ms = self.ticks_ms()
        self.shutdown_poweroff_armed = True
        return True

    def _power_off_if_due(self, now):
        if self._shutdown_poweroff_called:
            return
        response_delay_elapsed = (
            self.shutdown_poweroff_armed
            and self._shutdown_armed_at_ms is not None
            and self.ticks_diff(now, self._shutdown_armed_at_ms) >= self._shutdown_delay_ms
        )
        fallback_delay_elapsed = (
            self._shutdown_requested_at_ms is not None
            and self.ticks_diff(now, self._shutdown_requested_at_ms)
            >= self.SHUTDOWN_FALLBACK_DELAY_MS
        )
        if not response_delay_elapsed and not fallback_delay_elapsed:
            return
        self.shutdown_poweroff_armed = False
        self._shutdown_poweroff_called = True
        try:
            self.power.powerOff()
        except Exception as error:
            self.shutdown_requested = False
            self._shutdown_poweroff_called = False
            self.set_error(str(error), component="power")

    def set_error(self, message, component="device"):
        """Record a persistent component fault until explicit or proven recovery."""
        if not isinstance(component, str) or not component:
            raise ValueError("fault component must be a non-empty string")
        message = str(message)
        now = self.ticks_ms()
        fault = None
        for existing in self.faults:
            if existing["component"] == component:
                fault = existing
                break
        if fault is None:
            fault = {"component": component, "message": message, "sinceMs": now}
            self.faults.append(fault)
        else:
            fault["message"] = message
        self.last_error = message
        self._error_since_ms = now
        self._set_mode("error")

    def clear_error(self, component):
        """Clear only the named persistent component fault."""
        if not isinstance(component, str) or not component:
            raise ValueError("fault component must be a non-empty string")
        previous_count = len(self.faults)
        self.faults = [fault for fault in self.faults if fault["component"] != component]
        if len(self.faults) == previous_count:
            return False
        self.last_error = self.faults[-1]["message"] if self.faults else None
        self._error_since_ms = None
        if not self.faults and self.mode == "error":
            self._set_mode(self._connected_mode())
        else:
            self._render_lifecycle(force=True)
        return True

    def _clear_recovered_faults(self, capability, result):
        components = self.RECOVERABLE_COMPONENTS_BY_CAPABILITY.get(capability, ())
        if not components:
            return
        if capability in ("head.move", "head.home", "head.observe"):
            if not isinstance(result, dict) or result.get("feedbackVerified") is not True:
                return
        for component in components:
            self.clear_error(component)

    def _connected_mode(self):
        if self._service_ready and self._wifi_connected:
            return "ready"
        if self._network_started:
            return "connecting"
        return "booting"

    def _set_mode(self, mode):
        if self.mode == mode:
            return
        self.mode = mode
        if not self._led_override_armed:
            if self._manual_led_override and self.light_engine is not None:
                self.light_engine.resume()
            self._manual_led_override = False
        self._touch_led_started_ms = None
        self._apply_lifecycle_led()
        self._render_lifecycle()

    def _apply_lifecycle_led(self):
        if self.light_engine is not None:
            self.light_engine.set_state(self.mode, self.action, self.guiding)
            return
        if self.board is None or self._manual_led_override:
            return
        try:
            self.board.set_rgb_color(self._mode_led_colors.get(self.mode, 0))
        except Exception:
            pass

    def _update_lighting(self, now):
        if self.light_engine is not None:
            self.light_engine.update(now)

    def _render_lifecycle(self, force=False, immediate=False):
        if (self._transfer_active
                or (self._service_callback is not None and not immediate)):
            self._pending_render = True
            return

        rendered_action = self.action
        if rendered_action == "idle" and self.guiding:
            rendered_action = "guiding"
        state = (self.mode, rendered_action, self._display_message,
                 self._display_message_color, self._touch_overlay_active)
        state = state + (self.last_error,)
        if not force and state == self._last_render_state:
            return
        self._last_render_state = state
        self._pending_render = False

        brightness = self.sleep_brightness if self.mode == "sleeping" else self.active_brightness
        if self.display_brightness is not None and brightness != self._last_brightness:
            try:
                self.display_brightness(brightness)
                self._last_brightness = brightness
            except Exception:
                pass

        status_text = self._lifecycle_label()
        message = self.last_error if self.mode == "error" else self._display_message
        if self.cat_renderer is not None:
            try:
                if self.cat_renderer.render(
                        self.mode,
                        action=rendered_action,
                        touched=self._touch_overlay_active,
                        message=message):
                    return
            except Exception:
                pass

        if self.display is None:
            return

        background = 0x061321
        try:
            if hasattr(self.display, "fillScreen"):
                self.display.fillScreen(background)
            else:
                self.display.clear(background)

            width = self.display.width() if hasattr(self.display, "width") else 320
            height = self.display.height() if hasattr(self.display, "height") else 240
            left_eye = width // 3
            right_eye = (width * 2) // 3
            eye_y = height // 2 - 8

            if self.mode == "sleeping" and hasattr(self.display, "drawLine"):
                self.display.drawLine(left_eye - 18, eye_y, left_eye + 18, eye_y, 0x66D9FF)
                self.display.drawLine(right_eye - 18, eye_y, right_eye + 18, eye_y, 0x66D9FF)
            elif self.mode == "error" and hasattr(self.display, "drawLine"):
                self._draw_cross(left_eye, eye_y, 0xFF5A62)
                self._draw_cross(right_eye, eye_y, 0xFF5A62)
            elif hasattr(self.display, "fillCircle"):
                pupil_offset = 4 if self.action == "head.observe" else 0
                pupil_color = 0x78F0FF if self._touch_overlay_active else 0x39C6F0
                for eye_x in (left_eye, right_eye):
                    self.display.fillCircle(eye_x, eye_y, 19, 0xEAF7FF)
                    self.display.fillCircle(eye_x + pupil_offset, eye_y, 7, pupil_color)

            self.display.setTextColor(0xD9F4FF, background)
            self.display.setCursor(14, 12)
            self.display.setTextSize(2)
            self.display.print(status_text)
            if self.mode == "sleeping":
                self.display.setTextColor(0x6AA6BD, background)
                self.display.setCursor(14, height - 32)
                self.display.setTextSize(1)
                self.display.print("WAKE BY API OR TOUCH")
            elif message:
                self.display.setTextColor(self._display_message_color, background)
                self.display.setCursor(14, height - 32)
                self.display.setTextSize(1)
                self.display.print(_display_ascii(message[:36]))
        except Exception:
            try:
                self.display.setCursor(0, 0)
                self.display.setTextSize(2)
                self.display.print(status_text)
            except Exception:
                pass
        _present_display(self.display)

    def _draw_cross(self, center_x, center_y, color):
        if not hasattr(self.display, "drawLine"):
            return
        self.display.drawLine(center_x - 12, center_y - 12, center_x + 12, center_y + 12, color)
        self.display.drawLine(center_x - 12, center_y + 12, center_x + 12, center_y - 12, color)

    def _lifecycle_label(self):
        if self.mode == "error":
            return "ERROR"
        if self.mode == "shutting_down":
            return "SHUTTING DOWN"
        if self.guiding:
            return "GUIDING"
        if self.mode == "sleeping":
            return "SLEEPING"
        if self.mode == "acting":
            if self.action == "head.observe":
                return "LOOKING"
            if self.action in ("head.move", "head.home"):
                return "MOVING"
            if self.action.startswith("camera."):
                return "SENSING"
            return "WORKING"
        return self.mode.upper()

    def _device_sleep(self, args):
        if args:
            raise ValueError("device.sleep takes no arguments")
        if self.mode != "sleeping":
            self.action = "device.sleep"
            self._set_mode("acting")
            self._enter_sleep()
        return {"ok": True, "mode": "sleeping"}

    def _enter_sleep(self):
        if self.mode == "sleeping":
            return
        touch_zones = self._touch_values()
        self._touch_zones = touch_zones
        self._touch_candidate_zones = list(touch_zones)
        self._touch_candidate_since_ms = self.ticks_ms()
        self._touch_latched = any(touch_zones)
        self.guiding = False
        self._guiding_last_pose = None
        self._guiding_last_poll_ms = None
        self._safe_deenergize_servos()
        self.action = "idle"
        self.last_action = "device.sleep"
        self._set_mode("sleeping")

    def _device_wake(self, args):
        if args:
            raise ValueError("device.wake takes no arguments")
        if self.mode == "sleeping":
            self._last_activity_ms = self.ticks_ms()
            self.action = "device.wake"
            self._set_mode("acting")
            self.action = "idle"
            self.last_action = "device.wake"
            self._set_mode("error" if self.faults else self._connected_mode())
        elif self.mode == "error":
            self._last_activity_ms = self.ticks_ms()
            self.last_action = "device.wake"
        else:
            self._last_activity_ms = self.ticks_ms()
            self.last_action = "device.wake"
        return {"ok": True, "mode": self.mode}

    def _device_shutdown(self, args):
        if args:
            raise ValueError("device.shutdown takes no arguments")
        return self.request_shutdown()

    def _touch_values(self):
        get_touch = getattr(self.board, "get_touch", None)
        if not callable(get_touch):
            return [0, 0, 0]
        try:
            values = get_touch()
            if values is None:
                return [0, 0, 0]
            if isinstance(values, (list, tuple)):
                return [1 if index < len(values)
                        and self._touch_level_is_gesture(values[index]) else 0
                        for index in range(3)]
            return [1 if self._touch_level_is_gesture(values) else 0, 0, 0]
        except Exception:
            return [0, 0, 0]

    @staticmethod
    def _touch_level_is_gesture(value):
        """Accept medium/high sensor levels and boolean touch drivers."""
        if isinstance(value, bool):
            return value
        return isinstance(value, int) and value >= 2

    def _poll_touch(self, now):
        zones = self._touch_values()
        touched = any(zones)
        self._touch_zones = zones

        if zones != self._touch_candidate_zones:
            self._touch_candidate_zones = list(zones)
            self._touch_candidate_since_ms = now
            return

        stable_ms = self.ticks_diff(now, self._touch_candidate_since_ms)
        if touched:
            if self._touch_latched or stable_ms < self.TOUCH_PRESS_STABLE_MS:
                return
            self._touch_latched = True
        else:
            if not self._touch_latched or stable_ms < self.TOUCH_RELEASE_STABLE_MS:
                return
            self._touch_latched = False
            return

        self.last_interaction = {
            "type": "touch",
            "zones": list(zones),
            "atMs": now,
        }
        self._last_activity_ms = now
        self._touch_overlay_active = True
        self._touch_overlay_started_ms = now
        if self.mode == "sleeping":
            self._device_wake({})
        if self.light_engine is not None:
            self.light_engine.touch()
        elif not self._manual_led_override:
            try:
                self.board.set_rgb_color(0x40A0FF)
                self._touch_led_started_ms = now
            except Exception:
                self._touch_led_started_ms = None
        self._render_lifecycle(force=True)

    def _finish_touch_effects(self, now):
        if (self._touch_overlay_active
                and self._touch_overlay_started_ms is not None
                and self.ticks_diff(now, self._touch_overlay_started_ms) >= 700):
            self._touch_overlay_active = False
            self._touch_overlay_started_ms = None
            self._render_lifecycle(force=True)
        if (self._touch_led_started_ms is not None
                and self.ticks_diff(now, self._touch_led_started_ms) >= 400):
            self._touch_led_started_ms = None
            self._apply_lifecycle_led()

    def _tick_cat_renderer(self, now):
        if self._transfer_active or self._defer_render_until_servo_command:
            return
        self._flush_pending_render()
        if self.cat_renderer is None:
            return
        try:
            self.cat_renderer.tick(now)
        except Exception:
            pass

    def _flush_pending_render(self):
        if (not self._pending_render or self._transfer_active
                or self._defer_render_until_servo_command):
            return False
        self._render_lifecycle(force=True, immediate=True)
        return True

    def _copy_last_interaction(self):
        if self.last_interaction is None:
            return None
        result = dict(self.last_interaction)
        if "zones" in result:
            result["zones"] = list(result["zones"])
        return result

    def _head_position(self):
        if self.board is None or not self._servos_ready:
            return None
        try:
            return self._read_servo_pose()
        except Exception:
            return None

    def _read_servo_pose(self):
        self._observed_head = None
        self._head_observed_at_ms = None
        if self.board is None:
            raise RuntimeError("StackChan board driver is unavailable")
        pose = {
            "pan": self.board.get_servo_angle(self.board.SERVO_ID_X),
            "tilt": self.board.get_servo_angle(self.board.SERVO_ID_Y),
        }
        if (isinstance(pose["pan"], bool)
                or not isinstance(pose["pan"], (int, float))
                or not -135 <= pose["pan"] <= 135):
            raise RuntimeError("Invalid servo feedback for pan position")
        if (isinstance(pose["tilt"], bool)
                or not isinstance(pose["tilt"], (int, float))
                or not 0 <= pose["tilt"] <= 90):
            raise RuntimeError("Invalid servo feedback for tilt position")
        self._observed_head = dict(pose)
        self._head_observed_at_ms = self.ticks_ms()
        return pose

    def _sync_servo_pose(self, pose):
        """Write a freshly measured pose as the goal; SDK goal writes enable torque."""
        servo_api = getattr(self.board, "servo", None)
        raw_write = getattr(servo_api, "write_pos", None)
        zero_positions = getattr(self.board, "_servo_zero_runtime", None)
        if callable(raw_write) and isinstance(zero_positions, dict):
            read_mode = getattr(servo_api, "read_mode", None)
            if callable(read_mode):
                mode = read_mode(self.board.SERVO_ID_X)
                if isinstance(mode, bool) or not isinstance(mode, int) or mode != 0:
                    raise RuntimeError("StackChan X-axis servo is not in position mode")

            angle_to_pos = getattr(self.board, "angle_to_pos", None)
            if not callable(angle_to_pos):
                try:
                    from hardware.stackchan import angle_to_pos
                except ImportError:
                    angle_to_pos = None
            if not callable(angle_to_pos):
                raise RuntimeError("StackChan servo angle converter is unavailable")

            axes = (
                (self.board.SERVO_ID_X, "pan"),
                (self.board.SERVO_ID_Y, "tilt"),
            )
            for servo_id, axis in axes:
                if servo_id not in zero_positions:
                    raise RuntimeError("StackChan servo zero calibration is unavailable")
                raw_position = angle_to_pos(pose[axis], zero_positions[servo_id])
                result = raw_write(servo_id, raw_position, 100, 0)
                if result != 1:
                    raise RuntimeError("Raw servo pose synchronization was rejected")
            return

        pan_result = self.board.set_servo_angle(
            self.board.SERVO_ID_X, pose["pan"], 100, 0
        )
        tilt_result = self.board.set_servo_angle(
            self.board.SERVO_ID_Y, pose["tilt"], 100, 0
        )
        if pan_result is False or tilt_result is False:
            raise RuntimeError("Servo pose synchronization was rejected")

    def _set_servo_torque(self, servo_id, enabled):
        result = self.board.set_servo_torque(servo_id, enabled)
        if result is False:
            raise RuntimeError("Servo torque command was rejected")

    def _verify_servo_torque(self, enabled):
        """Return True when both torque states are read back, or None if unsupported."""
        reader = getattr(self.board, "get_servo_torque", None)
        reader_uses_byte_address = False
        if not callable(reader):
            servo_api = getattr(self.board, "servo", None)
            reader = getattr(servo_api, "read_byte", None)
            if callable(reader):
                reader_uses_byte_address = True
            if not callable(reader):
                reader = getattr(servo_api, "read_torque_enable", None)
                if not callable(reader):
                    reader = getattr(servo_api, "read_torque", None)
        if not callable(reader):
            return None

        for servo_id in (self.board.SERVO_ID_X, self.board.SERVO_ID_Y):
            if reader_uses_byte_address:
                value = reader(servo_id, SCSCL_TORQUE_ENABLE)
            else:
                value = reader(servo_id)
            if isinstance(value, bool):
                actual = value
            elif isinstance(value, int) and value in (0, 1):
                actual = bool(value)
            else:
                raise RuntimeError("Invalid servo torque feedback")
            if actual != enabled:
                raise RuntimeError("Servo torque feedback did not match the requested state")
        return True

    @staticmethod
    def _torque_status(verified):
        return "confirmed" if verified is True else "unconfirmed"

    def _head_release(self, args):
        if args:
            raise ValueError("head.release takes no arguments")
        if self.guiding:
            torque_verified = self._verify_servo_torque(False)
            return {
                "ok": True,
                "guiding": True,
                "head": self._guiding_last_pose,
                "torqueStatus": self._torque_status(torque_verified),
            }
        if self.board is None:
            raise RuntimeError("StackChan board driver is unavailable")

        try:
            if not self._servos_ready:
                self.board.set_servo_power(True)
                self._cooperative_wait(1000)
            self._set_servo_torque(self.board.SERVO_ID_X, False)
            self._set_servo_torque(self.board.SERVO_ID_Y, False)
            pose = self._read_servo_pose()
            torque_verified = self._verify_servo_torque(False)
        except Exception:
            self.guiding = False
            self._guiding_last_pose = None
            self._safe_deenergize_servos()
            raise

        self._servos_ready = True
        self.guiding = True
        self._guiding_last_pose = dict(pose)
        self._guiding_last_poll_ms = self.ticks_ms()
        self._guiding_feedback_warning = False
        self._render_lifecycle(force=True)
        return {
            "ok": True,
            "guiding": True,
            "head": dict(pose),
            "torqueStatus": self._torque_status(torque_verified),
        }

    def _head_hold(self, args):
        if args:
            raise ValueError("head.hold takes no arguments")
        if self.board is None:
            raise RuntimeError("StackChan board driver is unavailable")
        if not self.guiding:
            pose = self._prepare_servos()
            torque_verified = self._verify_servo_torque(True)
            return {
                "ok": True,
                "guiding": False,
                "head": pose,
                "torqueStatus": self._torque_status(torque_verified),
            }

        try:
            pose = self._read_servo_pose()
            self._sync_servo_pose(pose)
            self._set_servo_torque(self.board.SERVO_ID_X, True)
            self._set_servo_torque(self.board.SERVO_ID_Y, True)
            torque_verified = self._verify_servo_torque(True)
        except Exception:
            self.guiding = False
            self._guiding_last_pose = None
            self._safe_deenergize_servos()
            raise

        self.guiding = False
        self._guiding_last_pose = None
        self._guiding_last_poll_ms = None
        self._guiding_feedback_warning = False
        self._render_lifecycle(force=True)
        return {
            "ok": True,
            "guiding": False,
            "head": dict(pose),
            "torqueStatus": self._torque_status(torque_verified),
        }

    def _poll_guiding_feedback(self, now):
        if not self.guiding or self.board is None:
            return
        if (self._guiding_last_poll_ms is not None
                and self.ticks_diff(now, self._guiding_last_poll_ms)
                < self._guiding_poll_interval_ms):
            return
        self._guiding_last_poll_ms = now
        try:
            pose = self._read_servo_pose()
        except Exception as error:
            if not self._guiding_feedback_warning:
                self.last_interaction = {
                    "type": "head.feedback_warning",
                    "reason": str(error),
                    "atMs": now,
                }
                self._guiding_feedback_warning = True
            return

        self._guiding_feedback_warning = False
        previous = self._guiding_last_pose
        if previous is None:
            self._guiding_last_pose = dict(pose)
            return
        if (abs(pose["pan"] - previous["pan"]) >= 2
                or abs(pose["tilt"] - previous["tilt"]) >= 2):
            self._guiding_last_pose = dict(pose)
            self.last_interaction = {
                "type": "head.moved_by_hand",
                "pan": pose["pan"],
                "tilt": pose["tilt"],
                "atMs": now,
            }
            self._last_activity_ms = now
            self._render_lifecycle(force=True)

    def initialize_servos(self):
        """Power and synchronize the head at its current pose during startup."""
        if self.board is None:
            raise RuntimeError("StackChan board driver is unavailable")
        return self._prepare_servos()

    def _prepare_servos(self):
        if self._servos_ready:
            return self._head_position()

        try:
            self.board.set_servo_power(True)
            # The servo rail and UART-backed feedback need time to come up.
            self._cooperative_wait(1000)
            self._set_servo_torque(self.board.SERVO_ID_X, False)
            self._set_servo_torque(self.board.SERVO_ID_Y, False)
            current = self._read_servo_pose()

            # Match each servo target to its measured feedback while torque is off.
            # Enabling torque then holds the observed position until the requested move.
            self._sync_servo_pose(current)
            self._set_servo_torque(self.board.SERVO_ID_X, True)
            self._set_servo_torque(self.board.SERVO_ID_Y, True)
            self._verify_servo_torque(True)
        except Exception:
            self._safe_deenergize_servos()
            raise

        self._servos_ready = True
        return current

    def _safe_deenergize_servos(self):
        if self.board is None:
            self._servos_ready = False
            return
        for servo_id in (self.board.SERVO_ID_X, self.board.SERVO_ID_Y):
            try:
                self.board.set_servo_torque(servo_id, False)
            except Exception:
                pass
        try:
            self.board.set_servo_power(False)
        except Exception:
            pass
        self._servos_ready = False

    def _move_head(self, pan, tilt, move_time_ms, speed):
        try:
            return self._move_head_and_verify(pan, tilt, move_time_ms, speed)
        except _ShutdownInterrupted:
            raise
        except Exception:
            if not self.shutdown_requested:
                self._safe_deenergize_servos()
            raise

    def _move_head_and_verify(self, pan, tilt, move_time_ms, speed):
        if self.guiding:
            current = self._head_hold({})["head"]
        else:
            current = self._prepare_servos()
        if pan is None:
            pan = current["pan"] if current["pan"] is not None else 0
        if tilt is None:
            tilt = current["tilt"] if current["tilt"] is not None else 45
        pan_result = self.board.set_servo_angle(
            self.board.SERVO_ID_X, pan, move_time_ms, speed
        )
        tilt_result = self.board.set_servo_angle(
            self.board.SERVO_ID_Y, tilt, move_time_ms, speed
        )
        if pan_result is False or tilt_result is False:
            raise RuntimeError("Servo motion command was rejected")

        started_at_ms = self.ticks_ms()
        self._defer_render_until_servo_command = False
        self._flush_pending_render()

        elapsed_ms = self.ticks_diff(self.ticks_ms(), started_at_ms)
        remaining_motion_ms = move_time_ms - elapsed_ms
        if remaining_motion_ms > 0:
            self._cooperative_wait(remaining_motion_ms)
        timeout_ms = move_time_ms + self.SERVO_FEEDBACK_GRACE_MS
        last_feedback_error = None
        while True:
            try:
                pose = self._read_servo_pose()
                last_feedback_error = None
                if (abs(pose["pan"] - pan) <= self.SERVO_FEEDBACK_TOLERANCE_DEGREES
                        and abs(pose["tilt"] - tilt) <= self.SERVO_FEEDBACK_TOLERANCE_DEGREES):
                    return {
                        "ok": True,
                        "pan": pose["pan"],
                        "tilt": pose["tilt"],
                        "target": {"pan": pan, "tilt": tilt},
                        "feedbackVerified": True,
                    }
            except RuntimeError as error:
                last_feedback_error = error

            elapsed_ms = self.ticks_diff(self.ticks_ms(), started_at_ms)
            if elapsed_ms >= timeout_ms:
                if last_feedback_error is not None:
                    raise RuntimeError(
                        "Servo feedback unavailable after motion: {}".format(last_feedback_error)
                    )
                raise RuntimeError(
                    "Servo feedback did not reach target within 3 degrees "
                    "(pan={}, tilt={})".format(pose["pan"], pose["tilt"])
                )
            remaining_ms = timeout_ms - elapsed_ms
            self._cooperative_wait(min(self.SERVO_FEEDBACK_POLL_MS, remaining_ms))

    def _head_move(self, args):
        args = _object(args)
        allowed = ("pan", "tilt", "moveTimeMs", "speed")
        if not any(name in args for name in allowed[:2]):
            raise ValueError("At least one of 'pan' or 'tilt' is required")
        for name in args:
            if name not in allowed:
                raise ValueError("Unknown head.move argument '{}'".format(name))
        pan = _number(args, "pan", None, -90, 90) if "pan" in args else None
        tilt = _number(args, "tilt", None, 5, 85) if "tilt" in args else None
        move_time_ms = _integer(args, "moveTimeMs", 800, 250, 3000)
        speed = _integer(args, "speed", 20, 0, 100)
        return self._move_head(pan, tilt, move_time_ms, speed)

    def _head_home(self, args):
        if args:
            raise ValueError("head.home takes no arguments")
        return self._move_head(0, 45, 800, 20)

    def _capture(self):
        self._pump_service()
        try:
            image = self.camera.snapshot()
        except Exception:
            try:
                self._restore_display_after_capture()
            except Exception:
                pass
            raise
        captured_at_ms = getattr(image, "captured_at_ms", None)
        if captured_at_ms is None:
            captured_at_ms = self.ticks_ms()
        self._restore_display_after_capture()
        self._pump_service()
        width = image.width()
        height = image.height()
        pixels = bytes(image.bytearray())
        return {
            "mimeType": "application/x-rgb565",
            "encoding": "rgb565-be",
            "data": _base64(pixels),
            "width": width,
            "height": height,
            "capturedAtMs": captured_at_ms,
        }

    def _restore_display_after_capture(self):
        present = getattr(self.display, "present", None)
        if callable(present) and present() is False:
            raise RuntimeError("Could not restore the robot display after camera capture")

    def _camera_capture(self, args):
        if args:
            raise ValueError("camera.capture takes no arguments")
        return {"image": self._capture()}

    def _head_observe(self, args):
        args = _object(args)
        for name in args:
            if name not in ("direction", "tilt", "settleMs"):
                raise ValueError("Unknown head.observe argument '{}'".format(name))
        direction = args.get("direction")
        pans = {"left": -45, "center": 0, "right": 45}
        if direction not in pans:
            raise ValueError("direction must be left, center, or right")
        tilt = _number(args, "tilt", 45, 5, 85)
        settle_ms = _integer(args, "settleMs", 250, 0, 2000)
        try:
            moved = self._move_head(pans[direction], tilt, 800, 20)
        except _ShutdownInterrupted:
            raise
        except Exception as error:
            raise _ComponentFailure("servo", str(error))
        self._cooperative_wait(settle_ms)
        moved["direction"] = direction
        moved["image"] = self._capture()
        return moved

    def _led_set(self, args):
        args = _object(args)
        for name in args:
            if name not in ("color", "strip", "index"):
                raise ValueError("Unknown led.set argument '{}'".format(name))
        color = _integer(args, "color", minimum=0, maximum=16777215)
        strip = None
        index = None
        if "index" in args:
            if "strip" not in args:
                raise ValueError("'index' requires 'strip'")
            strip = _integer(args, "strip", minimum=0, maximum=1)
            index = _integer(args, "index", minimum=0, maximum=5)
        elif "strip" in args:
            strip = _integer(args, "strip", minimum=0, maximum=1)
        self.light_engine.set_manual(color, strip=strip, index=index)
        lighting = self.light_engine.snapshot()
        if lighting.get("lastError"):
            raise RuntimeError(lighting["lastError"])
        self._manual_led_override = True
        self._led_override_armed = True
        return {"ok": True}

    def _led_express(self, args):
        args = _object(args)
        if any(name not in ("emotion", "intensity", "durationMs") for name in args):
            raise ValueError("led.express accepts emotion, intensity, and durationMs")
        emotion = args.get("emotion")
        if emotion not in ("happy", "curious", "thinking", "listening", "speaking", "concerned", "calm"):
            raise ValueError("Unsupported lighting emotion")
        intensity = _number(args, "intensity", 0.5, 0.1, 1)
        if not 0.1 <= intensity <= 1:
            raise ValueError("Lighting intensity must be finite and between 0.1 and 1")
        duration = _integer(args, "durationMs", 8000, 1000, 60000)
        if self._manual_led_override:
            self.light_engine.resume()
        self._manual_led_override = False
        self._led_override_armed = False
        applied = self.light_engine.express(emotion, intensity=intensity, duration_ms=duration)
        lighting = self.light_engine.snapshot()
        if lighting.get("lastError"):
            raise RuntimeError(lighting["lastError"])
        return {"ok": True, "applied": applied is not False, "lighting": lighting}

    def _led_resume(self, args):
        if _object(args):
            raise ValueError("led.resume takes no arguments")
        self._manual_led_override = False
        self._led_override_armed = False
        self.light_engine.resume()
        lighting = self.light_engine.snapshot()
        if lighting.get("lastError"):
            raise RuntimeError(lighting["lastError"])
        return {"ok": True, "lighting": lighting}

    def _touch_read(self, args):
        args = _object(args)
        if not args:
            return {"zones": self.board.get_touch()}
        if set(args) != {"zone"}:
            raise ValueError("touch.read accepts only an optional 'zone'")
        zone = _integer(args, "zone", minimum=0, maximum=2)
        return {"zone": zone, "level": self.board.get_touch(zone)}

    def _power_read(self, args):
        if args:
            raise ValueError("power.read takes no arguments")
        return {
            "voltage": self.board.get_battery_voltage(),
            "current": self.board.get_battery_current(),
            "power": self.board.get_battery_power(),
        }

    def _infrared_send(self, args):
        args = _object(args)
        if set(args) != {"address", "data"}:
            raise ValueError("infrared.send needs exactly 'address' and 'data'")
        address = _integer(args, "address", minimum=0, maximum=255)
        data = _integer(args, "data", minimum=0, maximum=255)
        self.ir.tx(address, data)
        return {"ok": True, "address": address, "data": data}

    def _record_ir(self, data, address, control):
        self.last_ir = {
            "data": data,
            "address": address,
            "control": control,
            "receivedAtMs": self.ticks_ms(),
        }

    def _infrared_read(self, args):
        if args:
            raise ValueError("infrared.read takes no arguments")
        if self.last_ir is None:
            return {"received": False}
        result = dict(self.last_ir)
        result["received"] = True
        return result

    def _nfc_detect(self, args):
        if args:
            raise ValueError("nfc.detect takes no arguments")
        card = self.nfc.detect()
        if card is None:
            return {"detected": False}
        return {
            "detected": True,
            "uid": getattr(card, "uid_str", None),
            "type": getattr(card, "type_name", None),
            "userMemory": getattr(card, "user_memory", None),
        }

    def _speaker_tone(self, args):
        args = _object(args)
        for name in args:
            if name not in ("frequency", "durationMs"):
                raise ValueError("Unknown speaker.tone argument '{}'".format(name))
        frequency = _integer(args, "frequency", 880, 200, 4000)
        duration_ms = _integer(args, "durationMs", 100, 1, 500)
        self.speaker.tone(frequency, duration_ms)
        return {"ok": True}

    def _display_text(self, args):
        args = _object(args)
        for name in args:
            if name not in ("text", "color"):
                raise ValueError("Unknown display.text argument '{}'".format(name))
        text = args.get("text")
        if not isinstance(text, str) or not text or len(text) > 240:
            raise ValueError("'text' must contain between 1 and 240 characters")
        color = _integer(args, "color", 16777215, 0, 16777215)
        self._display_message = text
        self._display_message_color = color
        self._render_lifecycle(force=True)
        return {"ok": True}

    def _ambient_read(self, args):
        if args:
            raise ValueError("ambient.read takes no arguments")
        return {"value": self.als.getLightSensorData()}

    def _imu_read(self, args):
        if args:
            raise ValueError("imu.read takes no arguments")
        return {
            "acceleration": list(self.imu.getAccel()),
            "gyroscope": list(self.imu.getGyro()),
        }
