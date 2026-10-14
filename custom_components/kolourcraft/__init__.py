"""KolourCraft: per-light color cycling scenes with a sidebar editor."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
from pathlib import Path

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
import homeassistant.helpers.config_validation as cv
from homeassistant.helpers.typing import ConfigType

from . import websocket
from .const import (
    DOMAIN,
    NAME,
    PANEL_COMPONENT,
    PANEL_ICON,
    PANEL_URL_PATH,
    STATIC_URL,
    VERSION,
)
from .engine import SceneEngine
from .store import KolourCraftStore

PLATFORMS = [Platform.SWITCH]
CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)
_STATIC_REGISTERED = f"{DOMAIN}_static_registered"


def _panel_hash() -> str:
    """Cache-buster so browsers pick up a new panel file after an update."""
    content = (Path(__file__).parent / "frontend" / "kolourcraft-panel.js").read_bytes()
    return f"{VERSION}-{hashlib.sha1(content).hexdigest()[:8]}"


@dataclass
class KolourCraftData:
    store: KolourCraftStore
    engine: SceneEngine


async def async_setup(hass: HomeAssistant, _: ConfigType) -> bool:
    websocket.async_register(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    store = KolourCraftStore(hass)
    await store.async_load()
    hass.data[DOMAIN] = KolourCraftData(store, SceneEngine(hass))

    # Static paths can't be unregistered, so only register once per HA run.
    if not hass.data.get(_STATIC_REGISTERED):
        await hass.http.async_register_static_paths(
            [StaticPathConfig(STATIC_URL, str(Path(__file__).parent / "frontend"), False)]
        )
        hass.data[_STATIC_REGISTERED] = True

    await panel_custom.async_register_panel(
        hass,
        webcomponent_name=PANEL_COMPONENT,
        frontend_url_path=PANEL_URL_PATH,
        sidebar_title=NAME,
        sidebar_icon=PANEL_ICON,
        module_url=f"{STATIC_URL}/kolourcraft-panel.js?v={await hass.async_add_executor_job(_panel_hash)}",
        require_admin=True,
        config={},
    )

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        data: KolourCraftData = hass.data.pop(DOMAIN)
        await data.engine.stop_all()
        frontend.async_remove_panel(hass, PANEL_URL_PATH)
    return unloaded
