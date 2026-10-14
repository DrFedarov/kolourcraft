"""Hands lights over to and back from the Adaptive Lighting custom integration.

While a scene runs, its lights are marked "manually controlled" in Adaptive Lighting so it
neither intercepts KolourCraft's turn_on calls nor re-adapts the lights mid-scene. On stop,
only the lights KolourCraft marked are released, which makes Adaptive Lighting adapt them
again. Lights the user had already taken out of Adaptive Lighting are left that way.
"""

from __future__ import annotations

import logging

from homeassistant.config_entries import ConfigEntryState
from homeassistant.const import ATTR_ENTITY_ID
from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er

_LOGGER = logging.getLogger(__name__)

AL_DOMAIN = "adaptive_lighting"
ATTR_MANUAL_CONTROL = "manual_control"


def member_ids(hass: HomeAssistant, entity_id: str) -> list[str]:
    """Return the member lights of a light group, or the light itself."""
    state = hass.states.get(entity_id)
    members = state.attributes.get(ATTR_ENTITY_ID) if state else None
    if isinstance(members, (list, tuple)) and members:
        return [m for m in members if isinstance(m, str)]
    return [entity_id]


class AdaptiveLighting:
    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass

    def _switches(self) -> dict[str, set[str]]:
        """Map each loaded Adaptive Lighting main switch to the bulbs it manages."""
        if not self.hass.services.has_service(AL_DOMAIN, "set_manual_control"):
            return {}
        registry = er.async_get(self.hass)
        result: dict[str, set[str]] = {}
        for entry in self.hass.config_entries.async_entries(AL_DOMAIN):
            if entry.state is not ConfigEntryState.LOADED:
                continue
            configured = {**entry.data, **entry.options}.get("lights") or []
            bulbs = {m for light in configured for m in member_ids(self.hass, light)}
            for reg in er.async_entries_for_config_entry(registry, entry.entry_id):
                state = self.hass.states.get(reg.entity_id)
                # The main switch is the one that reports which lights are manually controlled.
                if reg.domain == "switch" and state and ATTR_MANUAL_CONTROL in state.attributes:
                    result[reg.entity_id] = bulbs
        return result

    def _manual_now(self, switch: str, lights: set[str]) -> set[str]:
        """Bulbs Adaptive Lighting currently treats as manually controlled.

        The switch's `manual_control` attribute is only refreshed on Adaptive Lighting's next
        state write, so read its live manager when available and fall back to the attribute.
        """
        registry = er.async_get(self.hass)
        if (reg := registry.async_get(switch)) and reg.config_entry_id:
            try:
                manager = self.hass.data[AL_DOMAIN][reg.config_entry_id]["switch"].manager
                return {light for light in lights if manager.manual_control.get(light)}
            except (KeyError, AttributeError, TypeError):
                pass
        state = self.hass.states.get(switch)
        return set(state.attributes.get(ATTR_MANUAL_CONTROL) or []) & lights if state else set()

    async def _set(self, switch: str, lights: set[str], manual: bool) -> None:
        try:
            await self.hass.services.async_call(
                AL_DOMAIN,
                "set_manual_control",
                {ATTR_ENTITY_ID: switch, "lights": sorted(lights), "manual_control": manual},
                blocking=True,
            )
        except Exception as err:
            _LOGGER.warning("KolourCraft: Adaptive Lighting %s on %s failed: %s", switch, lights, err)

    async def take(self, bulbs: set[str]) -> dict[str, set[str]]:
        """Pause Adaptive Lighting for these bulbs. Returns {switch: bulbs to hand back later}."""
        taken: dict[str, set[str]] = {}
        for switch, managed in self._switches().items():
            ours = bulbs & managed
            if not ours:
                continue
            already_manual = self._manual_now(switch, ours)
            await self._set(switch, ours, True)
            if hand_back := ours - already_manual:
                taken[switch] = hand_back
        return taken

    async def release(self, taken: dict[str, set[str]], bulbs: set[str]) -> None:
        """Resume Adaptive Lighting for these bulbs (it re-adapts the ones that are on)."""
        for switch, lights in taken.items():
            if selected := lights & bulbs:
                await self._set(switch, selected, False)
