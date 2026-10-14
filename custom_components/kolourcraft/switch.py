"""One switch per KolourCraft scene, for automations and dashboards."""

from __future__ import annotations

from typing import Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, SIGNAL_CHANGED, SIGNAL_SCENE_ADDED, SIGNAL_SCENE_REMOVED


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    data = hass.data[DOMAIN]
    async_add_entities(KolourCraftSceneSwitch(scene_id) for scene_id in data.store.scenes)

    @callback
    def scene_added(scene: dict[str, Any]) -> None:
        async_add_entities([KolourCraftSceneSwitch(scene["id"])])

    @callback
    def scene_removed(scene_id: str) -> None:
        registry = er.async_get(hass)
        if entity_id := registry.async_get_entity_id("switch", DOMAIN, scene_id):
            registry.async_remove(entity_id)

    entry.async_on_unload(async_dispatcher_connect(hass, SIGNAL_SCENE_ADDED, scene_added))
    entry.async_on_unload(async_dispatcher_connect(hass, SIGNAL_SCENE_REMOVED, scene_removed))


class KolourCraftSceneSwitch(SwitchEntity):
    _attr_should_poll = False
    _attr_icon = "mdi:palette"

    def __init__(self, scene_id: str) -> None:
        self._scene_id = scene_id
        self._attr_unique_id = scene_id

    @property
    def _data(self):
        return self.hass.data[DOMAIN]

    @property
    def name(self) -> str:
        scene = self._data.store.scenes.get(self._scene_id)
        return f"KolourCraft {scene['name']}" if scene else "KolourCraft scene"

    @property
    def available(self) -> bool:
        return self._scene_id in self._data.store.scenes

    @property
    def is_on(self) -> bool:
        return self._data.engine.is_running(self._scene_id)

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        scene = self._data.store.scenes.get(self._scene_id) or {}
        return {"lights": [e["entity_id"] for e in scene.get("entities", [])]}

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(
            async_dispatcher_connect(self.hass, SIGNAL_CHANGED, self.async_write_ha_state)
        )

    async def async_turn_on(self, **_: Any) -> None:
        if scene := self._data.store.scenes.get(self._scene_id):
            await self._data.engine.start(scene)

    async def async_turn_off(self, **_: Any) -> None:
        await self._data.engine.stop(self._scene_id)
