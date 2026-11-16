"""Read-only developer diagnostics; never reconstruct a purported LCD capture."""

from display_debug import capture_display


def _lighting_snapshot(device):
    engine = getattr(device, "light_engine", None)
    result = dict(engine.snapshot()) if engine is not None else {}
    result["manualOverride"] = getattr(device, "_manual_led_override", False)
    board = getattr(device, "board", None)
    read_color = getattr(board, "get_rgb_color", None)
    if callable(read_color):
        try:
            strips = [
                [read_color(strip, index) for index in range(6)]
                for strip in range(2)
            ]
            if engine is not None:
                result["driverStrips"] = strips
                result["driverSource"] = "board_driver"
            else:
                result["strips"] = strips
                result["source"] = "board_driver"
        except Exception as error:
            result["error"] = str(error)
    return result


def build_debug_snapshot(device, ip=None, wifi_connected=True, uptime_ms=None):
    status = device.status(ip=ip, wifi_connected=wifi_connected, uptime_ms=uptime_ms)
    renderer = getattr(device, "cat_renderer", None)
    renderer_state = {
        "frame": getattr(renderer, "last_frame", None),
        "error": getattr(renderer, "last_error", None),
        "family": getattr(renderer, "_family", None),
        "frameIndex": getattr(renderer, "_frame_index", None),
    }
    brightness = getattr(device, "_last_brightness", None)
    lighting = _lighting_snapshot(device)
    board = getattr(device, "board", None)
    read_touch = getattr(board, "get_touch", None)
    try:
        touch_levels = read_touch() if callable(read_touch) else device._touch_values()
    except Exception:
        touch_levels = None
    display = capture_display(
        getattr(device, "display", None), progress=getattr(device, "service", None),
    )
    display["renderer"] = renderer_state
    display["brightness"] = brightness
    return {
        "status": status,
        "display": display,
        "touch": {
            "levels": touch_levels,
            "lastPolledZones": list(getattr(device, "_touch_zones", [])),
        },
        "lighting": lighting,
    }
