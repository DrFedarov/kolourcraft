"""Constants for KolourCraft."""

DOMAIN = "kolourcraft"
NAME = "KolourCraft"
VERSION = "0.1.4"

STORAGE_KEY = DOMAIN
STORAGE_VERSION = 1

PANEL_URL_PATH = "kolourcraft"
PANEL_COMPONENT = "kolourcraft-panel"
PANEL_ICON = "mdi:palette"
STATIC_URL = "/kolourcraft_static"

SIGNAL_SCENE_ADDED = f"{DOMAIN}_scene_added"
SIGNAL_SCENE_REMOVED = f"{DOMAIN}_scene_removed"
SIGNAL_CHANGED = f"{DOMAIN}_changed"

# Limits for a single color step.
MAX_SECONDS = 3600
MIN_LOOP_SECONDS = 0.1

# Default highest saturation sent to bulbs. Fades into highly saturated colors step visibly
# on GE Cync Matter bulbs because LED channels at low levels dim coarsely. Side-by-side tests
# at 85%, 75% and 65%: 75% kept colors sharp while removing most steps; 65% looked washed out.
# See README "Max saturation".
DEFAULT_MAX_SATURATION = 75  # percent; each scene can change it under Global Overrides
MIN_MAX_SATURATION = 30  # lowest Max saturation a scene can set; below this colors are near white

# Fades between colors more than this many degrees of hue apart are sent as two halves via a
# midpoint, so bulbs can't fade the wrong way round the color wheel (cyan -> red via yellow).
SPLIT_HUE_DEGREES = 150
# Turning a light on from off: wait for it to report on, then settle before the real command.
TURN_ON_TIMEOUT = 3
OFF_TO_ON_SETTLE = 0.2
# On stop, how long to wait for light commands already in flight before restoring.
INFLIGHT_TIMEOUT = 5
STOP_SETTLE = 0.75
# After restoring, check the lights this long later and re-send if a bulb dropped it.
RESTORE_VERIFY_DELAY = 2.5
RESTORE_RETRIES = 3

DEFAULT_STEPS = [
    {"color": [255, 0, 0], "brightness": 100, "hold": 5, "transition": 2},
    {"color": [0, 0, 255], "brightness": 100, "hold": 5, "transition": 2},
]
