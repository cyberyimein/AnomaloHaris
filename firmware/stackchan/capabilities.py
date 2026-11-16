"""Capability metadata shared by the StackChan firmware and API."""


def _object(properties, required=None, additional=False):
    schema = {
        "type": "object",
        "properties": properties,
        "additionalProperties": additional,
    }
    if required:
        schema["required"] = required
    return schema


def _number(minimum, maximum, default=None):
    value = {"type": "number", "minimum": minimum, "maximum": maximum}
    if default is not None:
        value["default"] = default
    return value


def _integer(minimum, maximum, default=None):
    value = {"type": "integer", "minimum": minimum, "maximum": maximum}
    if default is not None:
        value["default"] = default
    return value


def capability_definitions(board, camera, ir, nfc, speaker,
                           display, als, imu, power=None):
    """Return only capabilities backed by initialized hardware modules."""
    definitions = [
        {
            "name": "device.sleep",
            "description": "Put the robot in software standby while keeping its API available.",
            "inputSchema": _object({}),
        },
        {
            "name": "device.wake",
            "description": "Wake the robot display and agent interface without moving its head.",
            "inputSchema": _object({}),
        },
    ]

    if callable(getattr(power, "powerOff", None)):
        definitions.append({
            "name": "device.shutdown",
            "description": "Safely power off the StackChan after the API response is sent.",
            "inputSchema": _object({}),
        })

    if board is not None:
        led_set_properties = {
            "color": _integer(0, 16777215),
            "strip": {"type": "integer", "enum": [0, 1]},
            "index": _integer(0, 5),
        }
        led_set_schema = _object(led_set_properties, required=["color"])
        led_set_schema["anyOf"] = [
            {"required": ["strip"]},
            {
                "type": "object",
                "properties": {"color": led_set_properties["color"]},
                "additionalProperties": False,
            },
        ]
        definitions.extend([
            {
                "name": "led.express",
                "description": "Express conversational attention or emotion through both rear lightbars; expires back to automatic state lighting. Listening does not activate a microphone.",
                "inputSchema": _object({
                    "emotion": {"type": "string", "enum": ["happy", "curious", "thinking", "listening", "speaking", "concerned", "calm"]},
                    "intensity": _number(0.1, 1, 0.5),
                    "durationMs": _integer(1000, 60000, 8000),
                }, required=["emotion"]),
            },
            {
                "name": "led.resume",
                "description": "End temporary emotion or manual RGB control and restore automatic robot-state light patterns.",
                "inputSchema": _object({}),
            },
            {
                "name": "head.release",
                "description": "Release head servo torque so the user can guide the head by hand while position feedback stays active.",
                "inputSchema": _object({}),
            },
            {
                "name": "head.hold",
                "description": "Synchronize to the current measured head pose and hold it with servo torque.",
                "inputSchema": _object({}),
            },
            {
                "name": "head.move",
                "description": "Move the pan and tilt servos within calibrated safe limits.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "pan": _number(-90, 90),
                        "tilt": _number(5, 85),
                        "moveTimeMs": _integer(250, 3000, 800),
                        "speed": _integer(0, 100, 20),
                    },
                    "additionalProperties": False,
                    "anyOf": [{"required": ["pan"]}, {"required": ["tilt"]}],
                },
            },
            {
                "name": "head.home",
                "description": "Return the head to the forward, level home position.",
                "inputSchema": _object({}),
            },
            {
                "name": "led.set",
                "description": "Set the StackChan RGB light bar color.",
                "inputSchema": led_set_schema,
            },
            {
                "name": "touch.read",
            "description": "Read one or all three raw StackChan touch levels (0=none, 1=LOW, 2=MID, 3=HIGH). LOW does not trigger a gesture; MID/HIGH must remain stable for 120 ms.",
                "inputSchema": _object({
                    "zone": {"type": "integer", "enum": [0, 1, 2]},
                }),
            },
            {
                "name": "power.read",
                "description": "Read StackChan battery voltage, current, and power.",
                "inputSchema": _object({}),
            },
        ])

    if camera is not None:
        definitions.append({
            "name": "camera.capture",
            "description": "Capture a fresh QVGA RGB565 frame; the device returns raw RGB565 and the host converts it to PNG.",
            "inputSchema": _object({}),
        })

    if board is not None and camera is not None:
        definitions.append({
            "name": "head.observe",
            "description": "Turn the head toward a direction, let it settle, and capture an image.",
            "inputSchema": _object({
                "direction": {"type": "string", "enum": ["left", "center", "right"]},
                "tilt": _number(5, 85, 45),
                "settleMs": _integer(0, 2000, 250),
            }, required=["direction"]),
            "requires": ["head.move", "camera.capture"],
        })

    if ir is not None:
        definitions.extend([
            {
                "name": "infrared.send",
                "description": "Transmit an 8-bit NEC infrared address and data value.",
                "inputSchema": _object({
                    "address": _integer(0, 255),
                    "data": _integer(0, 255),
                }, required=["address", "data"]),
            },
            {
                "name": "infrared.read",
                "description": "Read the latest received NEC infrared code, if any.",
                "inputSchema": _object({}),
            },
        ])

    if nfc is not None:
        definitions.append({
            "name": "nfc.detect",
            "description": "Detect a nearby NFC tag and return its UID and tag type.",
            "inputSchema": _object({}),
        })

    if speaker is not None:
        definitions.append({
            "name": "speaker.tone",
            "description": "Play a short tone through the onboard speaker.",
            "inputSchema": _object({
                "frequency": _integer(200, 4000, 880),
                "durationMs": _integer(1, 500, 100),
            }),
        })

    if display is not None:
        definitions.append({
            "name": "display.text",
            "description": "Show a short text message on the StackChan display.",
            "inputSchema": _object({
                "text": {"type": "string", "minLength": 1, "maxLength": 240},
                "color": _integer(0, 16777215, 16777215),
            }, required=["text"]),
        })

    if als is not None:
        definitions.append({
            "name": "ambient.read",
            "description": "Read the CoreS3 ambient light sensor raw value.",
            "inputSchema": _object({}),
        })

    if imu is not None:
        definitions.append({
            "name": "imu.read",
            "description": "Read CoreS3 accelerometer and gyroscope values.",
            "inputSchema": _object({}),
        })

    return definitions
