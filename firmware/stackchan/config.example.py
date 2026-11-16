"""Copy to config.py on the device and set local network credentials."""

WIFI_SSID = "your-2.4ghz-wifi"
WIFI_PASSWORD = "replace-this"

# Use the address reserved for this device in the router, or configure all four
# fields to assign a static address directly from the firmware.
DEVICE_IP = "192.168.1.50"
NETMASK = "255.255.255.0"
GATEWAY = "192.168.1.1"
DNS = "192.168.1.1"

DEVICE_ID = "stackchan-bedroom"
BUDDY_DEVICE_TOKEN = ""
HTTP_PORT = 8080

# Sleep the display and servo rail after five minutes without agent actions.
# Set to 0 to disable automatic sleep. Wi-Fi and the device API stay available.
INACTIVITY_SLEEP_MS = 300000
