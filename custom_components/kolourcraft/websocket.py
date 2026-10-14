"""Websocket API used by the KolourCraft sidebar panel."""

from __future__ import annotations

import re
from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import entity_registry as er
import homeassistant.helpers.config_validation as cv
from homeassistant.util import slugify
from homeassistant.helpers.dispatcher import (
    async_dispatcher_connect,
    async_dispatcher_send,
)

from .const import (
    DOMAIN,
    MAX_SECONDS,
    SIGNAL_CHANGED,
    SIGNAL_SCENE_ADDED,
    SIGNAL_SCENE_REMOVED,
)

RGB = vol.All(
    [vol.All(vol.Coerce(int), vol.Range(min=0, max=255))],
    vol.Length(min=3, max=3),
)
SECONDS = vol.All(vol.Coerce(float), vol.Range(min=0, max=MAX_SECONDS))

BRIGHTNESS = vol.All(vol.Coerce(int), vol.Range(min=0, max=100))

STEP_SCHEMA = vol.Schema(
    {
        vol.Required("color"): RGB,
        vol.Required("brightness"): BRIGHTNESS,
        vol.Required("hold"): SECONDS,
        vol.Required("transition"): SECONDS,
    }
)
OVERRIDE_SCHEMA = vol.Schema({vol.Required("enabled"): bool, vol.Required("value"): SECONDS})
OVERRIDES_SCHEMA = vol.Schema(
    {
        vol.Required("hold"): OVERRIDE_SCHEMA,
        vol.Required("transition"): OVERRIDE_SCHEMA,
        vol.Optional("brightness", default={"enabled": False, "value": 100}): vol.Schema(
            {vol.Required("enabled"): bool, vol.Required("value"): BRIGHTNESS}
        ),
    }
)
ENTITY_SCHEMA = vol.Schema(
    {
        vol.Required("entity_id"): cv.entity_domain("light"),
        vol.Required("steps"): [STEP_SCHEMA],
    }
)


def _data(hass: HomeAssistant):
    return hass.data[DOMAIN]


def _snapshot(hass: HomeAssistant) -> dict[str, Any]:
    data = _data(hass)
    result = data.store.as_dict()
    result["running"] = list(data.engine.running)
    registry = er.async_get(hass)
    result["switches"] = {
        scene_id: registry.async_get_entity_id("switch", DOMAIN, scene_id)
        for scene_id in data.store.scenes
    }
    return result


def _follow_rename(hass: HomeAssistant, scene_id: str, old_name: str, new_name: str) -> None:
    """Rename the scene's switch entity_id, unless the user has customised it."""
    registry = er.async_get(hass)
    entity_id = registry.async_get_entity_id("switch", DOMAIN, scene_id)
    if entity_id is None:
        return
    auto = re.escape(f"switch.{slugify(f'{DOMAIN} {old_name}')}")
    if not re.fullmatch(rf"{auto}(_\d+)?", entity_id):
        return
    wanted = registry.async_generate_entity_id(
        "switch", f"{DOMAIN} {new_name}", current_entity_id=entity_id
    )
    if wanted != entity_id:
        registry.async_update_entity(entity_id, new_entity_id=wanted)


def _changed(hass: HomeAssistant) -> None:
    async_dispatcher_send(hass, SIGNAL_CHANGED)


@callback
def async_register(hass: HomeAssistant) -> None:
    for command in (
        ws_subscribe,
        ws_get,
        ws_scene_create,
        ws_scene_update,
        ws_scene_delete,
        ws_scene_start,
        ws_scene_stop,
        ws_favorites_set,
    ):
        websocket_api.async_register_command(hass, command)


def _loaded(connection, msg) -> bool:
    if DOMAIN not in connection.hass.data:
        connection.send_error(msg["id"], "not_loaded", "KolourCraft is not set up")
        return False
    return True


@websocket_api.websocket_command({vol.Required("type"): "kolourcraft/subscribe"})
@websocket_api.require_admin
@callback
def ws_subscribe(hass: HomeAssistant, connection, msg) -> None:
    """Push the full KolourCraft state now and whenever it changes."""
    if not _loaded(connection, msg):
        return

    @callback
    def forward() -> None:
        if DOMAIN in hass.data:
            connection.send_message(websocket_api.event_message(msg["id"], _snapshot(hass)))

    connection.subscriptions[msg["id"]] = async_dispatcher_connect(hass, SIGNAL_CHANGED, forward)
    connection.send_result(msg["id"])
    forward()


@websocket_api.websocket_command({vol.Required("type"): "kolourcraft/get"})
@websocket_api.require_admin
@callback
def ws_get(hass: HomeAssistant, connection, msg) -> None:
    if _loaded(connection, msg):
        connection.send_result(msg["id"], _snapshot(hass))


@websocket_api.websocket_command(
    {vol.Required("type"): "kolourcraft/scene/create", vol.Optional("name", default="New scene"): str}
)
@websocket_api.require_admin
@callback
def ws_scene_create(hass: HomeAssistant, connection, msg) -> None:
    if not _loaded(connection, msg):
        return
    scene = _data(hass).store.create_scene(msg["name"])
    async_dispatcher_send(hass, SIGNAL_SCENE_ADDED, scene)
    _changed(hass)
    connection.send_result(msg["id"], scene)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "kolourcraft/scene/update",
        vol.Required("scene_id"): str,
        vol.Optional("name"): vol.All(str, vol.Length(min=1, max=100)),
        vol.Optional("entities"): [ENTITY_SCHEMA],
        vol.Optional("overrides"): OVERRIDES_SCHEMA,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_scene_update(hass: HomeAssistant, connection, msg) -> None:
    if not _loaded(connection, msg):
        return
    data = _data(hass)
    if msg["scene_id"] not in data.store.scenes:
        connection.send_error(msg["id"], "not_found", "Scene not found")
        return
    changes = {k: msg[k] for k in ("name", "entities", "overrides") if k in msg}
    old_name = data.store.scenes[msg["scene_id"]]["name"]
    scene = data.store.update_scene(msg["scene_id"], changes)
    if "name" in changes and changes["name"] != old_name:
        _follow_rename(hass, scene["id"], old_name, scene["name"])
    if "entities" in changes or "overrides" in changes:
        await data.engine.scene_updated(scene)
    _changed(hass)
    connection.send_result(msg["id"], scene)


@websocket_api.websocket_command(
    {vol.Required("type"): "kolourcraft/scene/delete", vol.Required("scene_id"): str}
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_scene_delete(hass: HomeAssistant, connection, msg) -> None:
    if not _loaded(connection, msg):
        return
    data = _data(hass)
    scene_id = msg["scene_id"]
    if scene_id not in data.store.scenes:
        connection.send_error(msg["id"], "not_found", "Scene not found")
        return
    await data.engine.stop(scene_id)
    data.store.delete_scene(scene_id)
    async_dispatcher_send(hass, SIGNAL_SCENE_REMOVED, scene_id)
    _changed(hass)
    connection.send_result(msg["id"])


@websocket_api.websocket_command(
    {vol.Required("type"): "kolourcraft/scene/start", vol.Required("scene_id"): str}
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_scene_start(hass: HomeAssistant, connection, msg) -> None:
    if not _loaded(connection, msg):
        return
    data = _data(hass)
    scene = data.store.scenes.get(msg["scene_id"])
    if scene is None:
        connection.send_error(msg["id"], "not_found", "Scene not found")
        return
    await data.engine.start(scene)
    connection.send_result(msg["id"])


@websocket_api.websocket_command(
    {vol.Required("type"): "kolourcraft/scene/stop", vol.Required("scene_id"): str}
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_scene_stop(hass: HomeAssistant, connection, msg) -> None:
    if not _loaded(connection, msg):
        return
    await _data(hass).engine.stop(msg["scene_id"])
    connection.send_result(msg["id"])


@websocket_api.websocket_command(
    {vol.Required("type"): "kolourcraft/favorites/set", vol.Required("favorites"): [RGB]}
)
@websocket_api.require_admin
@callback
def ws_favorites_set(hass: HomeAssistant, connection, msg) -> None:
    if not _loaded(connection, msg):
        return
    _data(hass).store.set_favorites(msg["favorites"])
    _changed(hass)
    connection.send_result(msg["id"])
