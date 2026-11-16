"""UIFlow2 entry point for the StackChan agent device."""

import socket
import time
import gc

import M5
import network

from device import DeviceController, draw_startup_feedback, poll_power_button
from http_api import BuddyHttpApi
from cooperative_http import read_request, send_response, configure_connection
from device_service import DeviceServicePump, transfer_call

try:
    import config
except ImportError:
    raise RuntimeError("Copy config.example.py to config.py and set Wi-Fi and device credentials")


def configure_touch(board):
    """Match the original StackChan firmware instead of SDK maximum sensitivity."""
    touch = getattr(board, "touch", None)
    set_sensitivity = getattr(touch, "set_sensitivity", None)
    if not callable(set_sensitivity):
        return False
    # Si12T High range, level 4 (0xCC), as used by StackChan-BSP.
    if set_sensitivity(1, 4) == -1:
        raise RuntimeError("Touch sensitivity configuration was rejected")
    return True


def configure_wifi():
    wlan = network.WLAN(network.STA_IF)
    wlan.active(True)
    power_mode = getattr(network.WLAN, "PM_NONE", None)
    if power_mode is not None:
        # Match the original body firmware's WiFi.setSleep(false).
        wlan.config(pm=power_mode)
    if getattr(config, "DEVICE_IP", ""):
        wlan.ifconfig((
            config.DEVICE_IP,
            config.NETMASK,
            config.GATEWAY,
            config.DNS,
        ))
    return wlan


def try_connect_wifi(wlan):
    if wlan.isconnected():
        return True
    try:
        wlan.connect(config.WIFI_SSID, config.WIFI_PASSWORD)
    except Exception:
        pass
    return wlan.isconnected()


def build_device():
    M5.begin()
    # UIFlow's small default threshold repeatedly scans the heap during frames.
    gc.threshold(max(256 * 1024, gc.mem_free() // 4))
    display = getattr(M5, "Lcd", None)
    if display is not None:
        try:
            from display_debug import SoftwareDisplay
            display = SoftwareDisplay(display)
        except Exception:
            print("Screen framebuffer unavailable; native display diagnostics only")
    try:
        from M5 import Widgets
    except ImportError:
        Widgets = getattr(M5, "Widgets", None)
    widgets = Widgets
    brightness_setter = getattr(widgets, "setBrightness", None)
    cat_renderer = None
    try:
        from cat_renderer import CatRenderer
        cat_renderer = CatRenderer(display, asset_dir="assets/cats")
    except Exception:
        print("Cat face renderer is unavailable; using the built-in status face")
    if not draw_startup_feedback(display, brightness_setter, cat_renderer):
        if cat_renderer is not None:
            print("Cat boot frame failed; using the built-in status face")
            cat_renderer = None

    board = None
    camera_device = None
    ir = None
    speaker = None
    startup_errors = []

    try:
        from hardware.stackchan import StackChan
        board = StackChan(i2c=1, uart=1)
    except Exception:
        print("StackChan board driver is unavailable")
        startup_errors.append(("board", "StackChan board unavailable"))

    try:
        configure_touch(board)
    except Exception:
        print("Touch sensitivity configuration failed")
        startup_errors.append(("touch", "Touch sensitivity configuration failed"))

    try:
        import camera
        from lazy_camera import OwnedCameraAdapter
        camera_device = OwnedCameraAdapter(camera)
    except Exception:
        print("Onboard camera is unavailable")
        startup_errors.append(("camera", "Camera unavailable"))

    try:
        from hardware import IR
        ir = IR()
    except Exception:
        print("Infrared module is unavailable")
        startup_errors.append(("infrared", "Infrared unavailable"))

    try:
        from M5 import Speaker
        Speaker.begin()
        speaker = Speaker
    except Exception:
        print("Onboard speaker is unavailable")
        startup_errors.append(("speaker", "Speaker unavailable"))

    device = DeviceController(
        board,
        camera_device,
        ir=ir,
        nfc=getattr(board, "nfc", None),
        speaker=speaker,
        display=display,
        als=getattr(M5, "Als", None),
        imu=getattr(M5, "Imu", None),
        power=getattr(M5, "Power", None),
        device_id=config.DEVICE_ID,
        firmware_version="0.5.0",
        inactivity_sleep_ms=getattr(config, "INACTIVITY_SLEEP_MS", 300000),
        display_brightness=brightness_setter,
        cat_renderer=cat_renderer,
    )
    device.update(wifi_connected=False, service_ready=False)
    for component, message in startup_errors:
        device.set_error(message, component=component)
    if board is not None:
        try:
            device.initialize_servos()
        except Exception as error:
            print("Servo feedback unavailable at startup; movement will retry initialization")
            device.set_error("Servo feedback unavailable: {}".format(error), component="servo")
    return device


def serve_forever():
    device = build_device()
    wlan = configure_wifi()
    device.update(wifi_connected=wlan.isconnected(), service_ready=False)
    try_connect_wifi(wlan)
    next_wifi_retry = time.ticks_add(time.ticks_ms(), 5000)
    power_button = getattr(M5, "BtnPWR", None)
    power_button_latched = False
    def update_device():
        nonlocal next_wifi_retry, power_button_latched
        M5.update()
        power_button_latched = poll_power_button(
            power_button, device, power_button_latched
        )
        if (not wlan.isconnected()
                and time.ticks_diff(time.ticks_ms(), next_wifi_retry) >= 0):
            try_connect_wifi(wlan)
            next_wifi_retry = time.ticks_add(time.ticks_ms(), 5000)
        device.update(wifi_connected=wlan.isconnected(), service_ready=True)

    service_pump = DeviceServicePump(update_device)
    service_device = service_pump.service
    device.set_service_callback(service_device)
    api = BuddyHttpApi(
        device,
        config.BUDDY_DEVICE_TOKEN,
        ip_provider=lambda: wlan.ifconfig()[0],
        uptime_provider=time.ticks_ms,
        wifi_provider=wlan.isconnected,
        service_callback=service_device,
        runtime_provider=lambda: dict(service_pump.metrics),
    )
    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("0.0.0.0", config.HTTP_PORT))
    listener.listen(2)
    listener.settimeout(0)
    device.update(wifi_connected=wlan.isconnected(), service_ready=True)
    while True:
        try:
            connection, _address = listener.accept()
        except OSError:
            service_device()
            time.sleep_ms(5)
            continue
        response_sent = False
        try:
            configure_connection(connection)
            method, path, headers, body = transfer_call(
                device, lambda: read_request(connection, pump=service_device),
            )
            status, response = api.handle(method, path, headers, body)
            transfer_call(
                device, lambda: send_response(connection, status, response, pump=service_device),
            )
            response_sent = True
        except Exception as error:
            response = api._json({
                "error": {"code": "bad_request", "message": str(error)}
            })
            try:
                transfer_call(
                    device, lambda: send_response(connection, 400, response, pump=service_device),
                )
                response_sent = True
            except Exception:
                pass
        finally:
            try:
                connection.close()
            except Exception:
                pass
        if response_sent and device.shutdown_requested:
            device.arm_shutdown_poweroff()


if __name__ == "__main__":
    serve_forever()
