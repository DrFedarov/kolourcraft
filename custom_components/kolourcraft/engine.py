"""Runs KolourCraft scenes: one loop per light, all on a shared clock so patterns stay in sync."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
import logging
from typing import Any

from homeassistant.components.light import (
    ATTR_BRIGHTNESS,
    ATTR_COLOR_MODE,
    ATTR_COLOR_TEMP_KELVIN,
    ATTR_HS_COLOR,
    ATTR_RGB_COLOR,
    ATTR_RGBW_COLOR,
    ATTR_RGBWW_COLOR,
    ATTR_XY_COLOR,
    DOMAIN as LIGHT_DOMAIN,
    ColorMode,
)
from homeassistant.const import ATTR_ENTITY_ID, STATE_OFF, STATE_ON, STATE_UNAVAILABLE, STATE_UNKNOWN
from homeassistant.core import HomeAssistant, State, callback
from homeassistant.helpers.dispatcher import async_dispatcher_send

from .adaptive import AdaptiveLighting, member_ids
from .const import (
    INFLIGHT_TIMEOUT,
    MIN_LOOP_SECONDS,
    OFF_TO_ON_SETTLE,
    RESTORE_RETRIES,
    RESTORE_VERIFY_DELAY,
    SIGNAL_CHANGED,
    STOP_SETTLE,
    TURN_ON_TIMEOUT,
)

_LOGGER = logging.getLogger(__name__)

RESTORE_COLOR_ATTR = {
    ColorMode.COLOR_TEMP: ATTR_COLOR_TEMP_KELVIN,
    ColorMode.HS: ATTR_HS_COLOR,
    ColorMode.XY: ATTR_XY_COLOR,
    ColorMode.RGB: ATTR_RGB_COLOR,
    ColorMode.RGBW: ATTR_RGBW_COLOR,
    ColorMode.RGBWW: ATTR_RGBWW_COLOR,
}


def effective_steps(scene: dict[str, Any], steps: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Steps with the scene's enabled global overrides (hold / fade / brightness) applied."""
    overrides = {
        field: o["value"]
        for field, o in (scene.get("overrides") or {}).items()
        if o.get("enabled")
    }
    return [{**step, **overrides} for step in steps] if overrides else steps


def _bulbs(hass: HomeAssistant, scene: dict[str, Any]) -> set[str]:
    """The physical lights a scene drives (light groups expanded to their members)."""
    return {m for e in scene["entities"] for m in member_ids(hass, e["entity_id"])}


class SceneRunner:
    """A running scene.

    On start it snapshots every bulb and pauses Adaptive Lighting for them. On stop it puts
    every bulb back to its snapshot and then hands the bulbs back to Adaptive Lighting.
    """

    def __init__(self, hass: HomeAssistant, scene: dict[str, Any], adaptive: AdaptiveLighting) -> None:
        self.hass = hass
        self.scene_id: str = scene["id"]
        self._scene = scene
        self._adaptive = adaptive
        self._main: asyncio.Task | None = None
        self._inflight: set[asyncio.Task] = set()
        self._last_command = 0.0
        self.snapshot: dict[str, State] = {}
        self.al_taken: dict[str, set[str]] = {}

    @property
    def lights(self) -> set[str]:
        """Every light entity this scene touches: the configured ones and their members."""
        return {e["entity_id"] for e in self._scene["entities"]} | _bulbs(self.hass, self._scene)

    def start(
        self,
        inherited: dict[str, State] | None = None,
        inherited_al: dict[str, set[str]] | None = None,
    ) -> None:
        """Start the scene. `inherited` carries pre-scene states taken over from another scene."""
        inherited = inherited or {}
        for switch, lights in (inherited_al or {}).items():
            self.al_taken.setdefault(switch, set()).update(lights)
        new = _bulbs(self.hass, self._scene) - inherited.keys()
        self.snapshot = dict(inherited)
        self.snapshot.update({eid: s for eid in new if (s := self.hass.states.get(eid))})
        self._main = self.hass.async_create_background_task(
            self._run(new), f"kolourcraft {self.scene_id}"
        )

    async def update(self, scene: dict[str, Any]) -> None:
        """Apply an edited scene while it keeps running (the original snapshot is kept)."""
        await self._cancel()
        self._scene = scene
        bulbs = _bulbs(self.hass, scene)
        # Bulbs removed from the scene go back to how they were right away.
        if removed := self.snapshot.keys() - bulbs:
            await asyncio.gather(*(self._restore(self.snapshot.pop(eid)) for eid in removed))
            await self._adaptive.release(self.al_taken, removed)
            for lights in self.al_taken.values():
                lights -= removed
        new = bulbs - self.snapshot.keys()
        self.snapshot.update({eid: s for eid in new if (s := self.hass.states.get(eid))})
        self._main = self.hass.async_create_background_task(
            self._run(new), f"kolourcraft {self.scene_id}"
        )

    async def _run(self, take_from_adaptive: set[str]) -> None:
        if take_from_adaptive:
            for switch, lights in (await self._adaptive.take(take_from_adaptive)).items():
                self.al_taken.setdefault(switch, set()).update(lights)

        entities = [
            {"entity_id": e["entity_id"], "steps": effective_steps(self._scene, e["steps"])}
            for e in self._scene["entities"]
            if e.get("steps")
        ]
        # Turn on every light that is off first, so all loops can start on the same tick.
        woken = await asyncio.gather(*(self._wake(e["entity_id"], e["steps"][0]) for e in entities))
        if any(woken):
            await asyncio.sleep(OFF_TO_ON_SETTLE)

        start = asyncio.get_running_loop().time()
        await asyncio.gather(*(self._loop(e["entity_id"], e["steps"], start) for e in entities))

    async def _loop(self, entity_id: str, steps: list[dict[str, Any]], start: float) -> None:
        # Steps are scheduled against the shared start time, so a slow bulb never drifts
        # out of sync with the others.
        loop = asyncio.get_running_loop()
        at, index = start, 0
        while True:
            if (delay := at - loop.time()) > 0:
                await asyncio.sleep(delay)
            step = steps[index]
            await self._apply_step(entity_id, step)
            at += max(float(step["transition"]) + float(step["hold"]), MIN_LOOP_SECONDS)
            index = (index + 1) % len(steps)

    def _step_data(self, entity_id: str, step: dict[str, Any]) -> dict[str, Any]:
        return {
            ATTR_ENTITY_ID: entity_id,
            "rgb_color": list(step["color"]),
            "brightness_pct": int(step["brightness"]),
        }

    async def _wake(self, entity_id: str, step: dict[str, Any]) -> bool:
        """Turn a light on at its first color if it is off. Returns True if it was woken."""
        state = self.hass.states.get(entity_id)
        if state is None or state.state != STATE_OFF or int(step["brightness"]) <= 0:
            return False
        try:
            await self._call("turn_on", self._step_data(entity_id, step))
            await self._wait_until_on(entity_id)
        except asyncio.CancelledError:
            raise
        except Exception as err:
            _LOGGER.warning("KolourCraft: turning on %s failed: %s", entity_id, err)
        return True

    async def _call(self, service: str, data: dict[str, Any]) -> None:
        # Shielded so that a cancelled loop still lets the command finish; stop() waits for it.
        task = self.hass.async_create_task(
            self.hass.services.async_call(LIGHT_DOMAIN, service, data, blocking=True),
            eager_start=True,
        )
        self._inflight.add(task)
        task.add_done_callback(self._command_done)
        await asyncio.shield(task)

    def _command_done(self, task: asyncio.Task) -> None:
        self._inflight.discard(task)
        self._last_command = asyncio.get_running_loop().time()

    async def _wait_until_on(self, entity_id: str) -> None:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + TURN_ON_TIMEOUT
        while loop.time() < deadline:
            state = self.hass.states.get(entity_id)
            if state and state.state != STATE_OFF:
                return
            await asyncio.sleep(0.05)

    async def _apply_step(self, entity_id: str, step: dict[str, Any]) -> None:
        state = self.hass.states.get(entity_id)
        if state is None or state.state in (STATE_UNAVAILABLE, STATE_UNKNOWN):
            return
        transition = float(step["transition"])
        try:
            if int(step["brightness"]) <= 0:
                await self._call("turn_off", {ATTR_ENTITY_ID: entity_id, "transition": transition})
                return
            if state.state == STATE_OFF:
                # Some bulbs (e.g. Matter) come on at their power-on level and ignore the
                # brightness sent with the turn-on command, so switch on first.
                await self._wake(entity_id, step)
                await asyncio.sleep(OFF_TO_ON_SETTLE)
            await self._call("turn_on", {**self._step_data(entity_id, step), "transition": transition})
        except asyncio.CancelledError:
            raise
        except Exception as err:  # A flaky bulb must not kill the loop.
            _LOGGER.warning("KolourCraft: updating %s failed: %s", entity_id, err)

    async def _cancel(self) -> None:
        if self._main:
            self._main.cancel()
            await asyncio.gather(self._main, return_exceptions=True)
            self._main = None
        # Let commands already sent to bulbs land, so they can't override the restore.
        # Some bulbs drop a command that arrives right after the previous one was acked.
        if self._inflight:
            await asyncio.wait(self._inflight, timeout=INFLIGHT_TIMEOUT)
        since = asyncio.get_running_loop().time() - self._last_command
        if since < STOP_SETTLE:
            await asyncio.sleep(STOP_SETTLE - since)

    async def stop(self, keep: set[str] = frozenset()) -> None:
        """Stop the loops and restore every bulb except those in `keep`."""
        await self._cancel()
        await asyncio.gather(
            *(self._restore(s) for eid, s in self.snapshot.items() if eid not in keep)
        )

    async def finish_restore(self, is_claimed: Callable[[str], bool]) -> None:
        """Re-send the restore to bulbs that dropped it, then hand them back to Adaptive Lighting."""
        for _ in range(RESTORE_RETRIES):
            await asyncio.sleep(RESTORE_VERIFY_DELAY)
            wrong = [s for eid, s in self.snapshot.items() if not is_claimed(eid) and self._differs(s)]
            if not wrong:
                break
            _LOGGER.debug("KolourCraft: re-sending restore to %s", [s.entity_id for s in wrong])
            await asyncio.gather(*(self._restore(s) for s in wrong))
        hand_back = {eid for lights in self.al_taken.values() for eid in lights if not is_claimed(eid)}
        await self._adaptive.release(self.al_taken, hand_back)

    def _differs(self, saved: State) -> bool:
        current = self.hass.states.get(saved.entity_id)
        if current is None or current.state not in (STATE_ON, STATE_OFF):
            return False
        if current.state != saved.state:
            return True
        if saved.state == STATE_ON:
            want, have = saved.attributes.get(ATTR_BRIGHTNESS), current.attributes.get(ATTR_BRIGHTNESS)
            return want is not None and have is not None and abs(want - have) > 5
        return False

    async def _restore(self, saved: State) -> None:
        # Always send the command: reproduce_state would skip lights whose reported state
        # hasn't caught up yet (Matter bulbs lag ~1s), leaving them stuck on.
        if saved.state not in (STATE_ON, STATE_OFF):
            return
        data: dict[str, Any] = {ATTR_ENTITY_ID: saved.entity_id}
        if saved.state == STATE_ON:
            attrs = saved.attributes
            if attrs.get(ATTR_BRIGHTNESS) is not None:
                data[ATTR_BRIGHTNESS] = attrs[ATTR_BRIGHTNESS]
            color_attr = RESTORE_COLOR_ATTR.get(attrs.get(ATTR_COLOR_MODE))
            if color_attr and attrs.get(color_attr) is not None:
                data[color_attr] = attrs[color_attr]
        try:
            await self._call("turn_on" if saved.state == STATE_ON else "turn_off", data)
        except Exception as err:
            _LOGGER.warning("KolourCraft: restoring %s failed: %s", saved.entity_id, err)


class SceneEngine:
    """Tracks which scenes are running. A bulb belongs to at most one running scene."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self.adaptive = AdaptiveLighting(hass)
        self.running: dict[str, SceneRunner] = {}

    def is_running(self, scene_id: str) -> bool:
        return scene_id in self.running

    @callback
    def _notify(self) -> None:
        async_dispatcher_send(self.hass, SIGNAL_CHANGED)

    def _is_claimed(self, entity_id: str) -> bool:
        return any(entity_id in runner.lights for runner in self.running.values())

    async def start(self, scene: dict[str, Any]) -> None:
        if scene["id"] in self.running or not scene["entities"]:
            return
        runner = SceneRunner(self.hass, scene, self.adaptive)
        bulbs = _bulbs(self.hass, scene)
        # A scene that takes over bulbs from another running scene inherits their
        # pre-scene state, so stopping it later still restores the original look.
        inherited: dict[str, State] = {}
        inherited_al: dict[str, set[str]] = {}
        for other in list(self.running.values()):
            shared = bulbs & other.snapshot.keys()
            if not (shared or other.lights & runner.lights):
                continue
            inherited.update({eid: other.snapshot[eid] for eid in shared})
            for switch, lights in other.al_taken.items():
                if moved := lights & shared:
                    inherited_al.setdefault(switch, set()).update(moved)
                    lights -= moved
            for eid in shared:
                other.snapshot.pop(eid)
            await self.stop(other.scene_id)
        self.running[scene["id"]] = runner
        runner.start(inherited, inherited_al)
        self._notify()

    async def stop(self, scene_id: str) -> None:
        runner = self.running.pop(scene_id, None)
        if runner is None:
            return
        self._notify()
        await runner.stop()
        self.hass.async_create_background_task(
            runner.finish_restore(self._is_claimed), f"kolourcraft restore {scene_id}"
        )

    async def scene_updated(self, scene: dict[str, Any]) -> None:
        if runner := self.running.get(scene["id"]):
            if scene["entities"]:
                await runner.update(scene)
            else:
                await self.stop(scene["id"])

    async def stop_all(self) -> None:
        for scene_id in list(self.running):
            runner = self.running.pop(scene_id)
            await runner.stop()
            await runner.finish_restore(lambda _: False)
