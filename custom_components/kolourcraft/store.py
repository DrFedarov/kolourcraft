"""Persistent storage for KolourCraft scenes and favorite colors."""

from __future__ import annotations

import copy
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store
from homeassistant.util import ulid

from .const import DEFAULT_MAX_SATURATION, STORAGE_KEY, STORAGE_VERSION


def default_overrides() -> dict[str, dict[str, Any]]:
    return {
        "hold": {"enabled": False, "value": 5},
        "transition": {"enabled": False, "value": 2},
        "brightness": {"enabled": False, "value": 100},
        # Always applied: the highest saturation sent to the lights (see README).
        "saturation": {"value": DEFAULT_MAX_SATURATION},
    }


class KolourCraftStore:
    """Holds scenes and favorites, persisted to .storage/kolourcraft.

    A scene looks like:
        {
            "id": "01J...",
            "name": "Dance",
            "entities": [
                {"entity_id": "light.lamp", "steps": [
                    {"color": [r, g, b], "brightness": 0-100,
                     "hold": seconds, "transition": seconds},
                ]},
            ],
            "overrides": {
                "hold": {"enabled": False, "value": 5},
                "transition": {"enabled": False, "value": 2},
                "brightness": {"enabled": False, "value": 100},
                "saturation": {"value": 75},
            },
        }

    When an override is enabled, its value replaces that field in every step of the scene.
    The per-step values are kept, so unchecking an override brings them back.
    """

    def __init__(self, hass: HomeAssistant) -> None:
        self._store: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self.scenes: dict[str, dict[str, Any]] = {}
        self.favorites: list[list[int]] = []

    async def async_load(self) -> None:
        data = await self._store.async_load() or {}
        self.scenes = {scene["id"]: scene for scene in data.get("scenes", [])}
        for scene in self.scenes.values():
            # Fill in overrides added in later versions without touching existing ones.
            scene["overrides"] = {**default_overrides(), **scene.get("overrides", {})}
        self.favorites = data.get("favorites", [])

    def _schedule_save(self) -> None:
        self._store.async_delay_save(self._data_to_save, 1)

    def _data_to_save(self) -> dict[str, Any]:
        return {"scenes": list(self.scenes.values()), "favorites": self.favorites}

    def as_dict(self) -> dict[str, Any]:
        return copy.deepcopy(self._data_to_save())

    def create_scene(self, name: str) -> dict[str, Any]:
        scene = {"id": ulid.ulid_now(), "name": name, "entities": [], "overrides": default_overrides()}
        self.scenes[scene["id"]] = scene
        self._schedule_save()
        return scene

    def update_scene(self, scene_id: str, changes: dict[str, Any]) -> dict[str, Any]:
        scene = self.scenes[scene_id]
        for key in ("name", "entities", "overrides"):
            if key in changes:
                scene[key] = changes[key]
        self._schedule_save()
        return scene

    def delete_scene(self, scene_id: str) -> None:
        self.scenes.pop(scene_id)
        self._schedule_save()

    def set_favorites(self, favorites: list[list[int]]) -> None:
        self.favorites = favorites
        self._schedule_save()
