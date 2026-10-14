// KolourCraft sidebar panel. Plain web component, no build step.

const DEFAULT_STEP = { color: [255, 0, 0], brightness: 100, hold: 5, transition: 2 };
const STARTER_STEPS = [
  { color: [255, 0, 0], brightness: 100, hold: 5, transition: 2 },
  { color: [0, 0, 255], brightness: 100, hold: 5, transition: 2 },
];
const PRESETS = [
  [255, 0, 0], [255, 128, 0], [255, 220, 0], [0, 255, 0], [0, 255, 200], [0, 160, 255],
  [0, 0, 255], [140, 0, 255], [255, 0, 200], [255, 255, 255], [255, 180, 110],
];

const OVERRIDE_FIELDS = [
  ["hold", "Hold (s)"],
  ["transition", "Fade (s)"],
];
const DEFAULT_OVERRIDES = {
  hold: { enabled: false, value: 5 },
  transition: { enabled: false, value: 2 },
  brightness: { enabled: false, value: 100 },
};
const briLabel = (v) => (+v === 0 ? "Off" : `${v}%`);

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const clone = (o) => JSON.parse(JSON.stringify(o));
const rgbCss = (c) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function rgbToHex([r, g, b]) {
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHsv([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max ? d / max : 0, max];
}
function hsvToRgb([h, s, v]) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255);
  };
  return [f(5), f(3), f(1)];
}
const sameColor = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

class KolourCraftPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._data = null; // {scenes, favorites, running, switches}
    this._sceneId = null; // scene open in the editor
    this._renamingId = null; // scene whose name is being edited in the list
    this._picker = null; // open color picker state
    this._entityDialog = null; // open "add entity" dialog state
    this._saveTimers = {};
    this._inflight = 0;
    this._renderPending = false;
    this.shadowRoot.addEventListener("click", (e) => this._onClick(e));
    this.shadowRoot.addEventListener("input", (e) => this._onInput(e));
    this.shadowRoot.addEventListener("change", (e) => this._onChange(e));
    this.shadowRoot.addEventListener("keydown", (e) => this._onKeyDown(e));
    this.shadowRoot.addEventListener("focusout", (e) => this._onFocusOut(e));
    this.shadowRoot.addEventListener("pointerdown", (e) => this._onPointerDown(e));
    // Never swap the DOM between pointerdown and click, or the click is lost.
    this.shadowRoot.addEventListener("pointerdown", () => (this._pointerDown = true), true);
    window.addEventListener("pointerup", () => {
      this._pointerDown = false;
      if (this._renderPending) setTimeout(() => this._flushRender(), 0);
    });
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) {
      this._subscribe();
      this._render();
    }
  }
  get hass() {
    return this._hass;
  }
  set narrow(v) {
    const changed = this._narrow !== v;
    this._narrow = v;
    if (changed && this._hass) this._render();
  }
  set panel(v) {
    this._panel = v;
  }

  disconnectedCallback() {
    if (this._unsub) {
      this._unsub.then((u) => u()).catch(() => {});
      this._unsub = null;
    }
  }
  connectedCallback() {
    if (this._hass && !this._unsub) this._subscribe();
  }

  _subscribe() {
    this._unsub = this._hass.connection.subscribeMessage((msg) => this._onData(msg), {
      type: "kolourcraft/subscribe",
    });
    this._unsub.catch((err) => {
      this._error = err.message || String(err);
      this._render();
    });
  }

  _onData(msg) {
    const saving = this._inflight > 0 || Object.keys(this._saveTimers).length > 0;
    if (this._data && saving) {
      // Our own edits are authoritative until every save has landed.
      this._data.running = msg.running;
      this._data.favorites = msg.favorites;
      this._data.switches = msg.switches;
      const known = new Set(this._data.scenes.map((s) => s.id));
      for (const s of msg.scenes) if (!known.has(s.id)) this._data.scenes.push(s);
      const live = new Set(msg.scenes.map((s) => s.id));
      this._data.scenes = this._data.scenes.filter((s) => live.has(s.id));
    } else {
      this._data = msg;
    }
    if (this._sceneId && !this._scene(this._sceneId)) this._sceneId = null;
    this._requestRender();
  }

  // Avoid wiping out a field the user is typing in or a drag in progress.
  _requestRender() {
    const active = this.shadowRoot.activeElement;
    if (this._dragging || this._pointerDown || (active && ["INPUT", "TEXTAREA"].includes(active.tagName))) {
      this._renderPending = true;
      return;
    }
    this._renderPending = false;
    this._render();
  }

  _flushRender() {
    if (this._renderPending) this._requestRender();
  }

  _scene(id) {
    return this._data?.scenes.find((s) => s.id === id);
  }
  _isRunning(id) {
    return this._data?.running.includes(id);
  }
  _ws(msg) {
    return this._hass.callWS(msg).catch((err) => {
      this._toast(err.message || String(err));
      throw err;
    });
  }

  _queueSave(scene) {
    clearTimeout(this._saveTimers[scene.id]);
    this._saveTimers[scene.id] = setTimeout(async () => {
      delete this._saveTimers[scene.id];
      this._inflight++;
      try {
        await this._ws({
          type: "kolourcraft/scene/update",
          scene_id: scene.id,
          entities: scene.entities,
          overrides: this._overrides(scene),
        });
      } catch (_) {
        /* toast already shown */
      } finally {
        this._inflight--;
      }
    }, 350);
  }

  _toast(message) {
    this.dispatchEvent(
      new CustomEvent("hass-notification", { detail: { message }, bubbles: true, composed: true })
    );
  }

  // ---------- light helpers ----------

  _lights() {
    return Object.values(this._hass.states)
      .filter((s) => s.entity_id.startsWith("light."))
      .map((s) => ({
        id: s.entity_id,
        name: s.attributes.friendly_name || s.entity_id,
        state: s.state,
        members: Array.isArray(s.attributes.entity_id) ? s.attributes.entity_id : null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  _lightName(id) {
    return this._hass.states[id]?.attributes.friendly_name || id;
  }
  _stateDot(id) {
    const st = this._hass.states[id]?.state || "unavailable";
    return `<span class="dot ${esc(st)}" title="${esc(st)}"></span>`;
  }

  // ---------- events ----------

  _onClick(e) {
    const el = e.target.closest("[data-act]");
    if (!el) return;
    const act = el.dataset.act;
    const d = el.dataset;
    const scene = this._scene(d.scene || this._sceneId);
    switch (act) {
      case "menu":
        this.dispatchEvent(new Event("hass-toggle-menu", { bubbles: true, composed: true }));
        break;
      case "new-scene":
        this._newScene();
        break;
      case "open-scene":
        if (e.target.closest("input, button:not([data-act=open-scene])")) return;
        this._sceneId = d.scene;
        this._render();
        break;
      case "back":
        this._sceneId = null;
        this._render();
        break;
      case "rename":
        this._renamingId = d.scene;
        this._render();
        this._focusRename();
        break;
      case "toggle-run":
        this._ws({
          type: this._isRunning(scene.id) ? "kolourcraft/scene/stop" : "kolourcraft/scene/start",
          scene_id: scene.id,
        });
        break;
      case "delete-scene":
        if (confirm(`Delete scene "${scene.name}"?`)) {
          this._ws({ type: "kolourcraft/scene/delete", scene_id: scene.id });
          if (this._sceneId === scene.id) this._sceneId = null;
        }
        break;
      case "add-entity":
        this._entityDialog = { search: "", selected: new Set() };
        this._render();
        this.shadowRoot.querySelector(".entity-search")?.focus();
        break;
      case "close-dialog":
        this._entityDialog = null;
        this._picker = null;
        this._render();
        break;
      case "toggle-entity": {
        const sel = this._entityDialog.selected;
        sel.has(d.entity) ? sel.delete(d.entity) : sel.add(d.entity);
        this._renderEntityList();
        break;
      }
      case "confirm-entities":
        this._addEntities([...this._entityDialog.selected]);
        break;
      case "remove-entity":
        scene.entities.splice(+d.ent, 1);
        this._queueSave(scene);
        this._render();
        break;
      case "copy-to-all": {
        const steps = scene.entities[+d.ent].steps;
        scene.entities.forEach((ent) => (ent.steps = clone(steps)));
        this._queueSave(scene);
        this._render();
        this._toast("Colors copied to every light in this scene");
        break;
      }
      case "add-step": {
        const steps = scene.entities[+d.ent].steps;
        steps.push(clone(steps[steps.length - 1] || DEFAULT_STEP));
        this._queueSave(scene);
        this._render();
        break;
      }
      case "remove-step":
        scene.entities[+d.ent].steps.splice(+d.step, 1);
        this._queueSave(scene);
        this._render();
        break;
      case "move-step": {
        const steps = scene.entities[+d.ent].steps;
        const i = +d.step, j = i + +d.dir;
        if (j < 0 || j >= steps.length) return;
        [steps[i], steps[j]] = [steps[j], steps[i]];
        this._queueSave(scene);
        this._render();
        break;
      }
      case "pick": {
        const color = scene.entities[+d.ent].steps[+d.step].color;
        this._picker = { ent: +d.ent, step: +d.step, hsv: rgbToHsv(color), original: color };
        this._render();
        break;
      }
      case "picker-swatch":
        this._picker.hsv = rgbToHsv(JSON.parse(d.color));
        this._updatePicker();
        break;
      case "fav-save": {
        const rgb = hsvToRgb(this._picker.hsv);
        const favs = this._data.favorites;
        if (!favs.some((f) => sameColor(f, rgb))) {
          favs.push(rgb);
          this._ws({ type: "kolourcraft/favorites/set", favorites: favs });
          this._renderFavorites();
        }
        break;
      }
      case "fav-remove": {
        e.stopPropagation();
        this._data.favorites.splice(+d.idx, 1);
        this._ws({ type: "kolourcraft/favorites/set", favorites: this._data.favorites });
        this._renderFavorites();
        break;
      }
      case "picker-apply": {
        const step = scene.entities[this._picker.ent].steps[this._picker.step];
        step.color = hsvToRgb(this._picker.hsv);
        this._picker = null;
        this._queueSave(scene);
        this._render();
        break;
      }
      case "overlay":
        if (e.target === el) {
          this._entityDialog = null;
          this._picker = null;
          this._render();
        }
        break;
    }
  }

  _onInput(e) {
    const t = e.target;
    if (t.classList.contains("entity-search")) {
      this._entityDialog.search = t.value;
      this._renderEntityList();
    } else if (t.classList.contains("hue")) {
      this._picker.hsv[0] = +t.value;
      this._updatePicker();
    } else if (t.classList.contains("hex")) {
      const rgb = hexToRgb(t.value);
      if (rgb) {
        this._picker.hsv = rgbToHsv(rgb);
        this._updatePicker(true);
      }
    } else if (t.dataset.field === "brightness") {
      t.closest(".step").querySelector(".bri-value").textContent = briLabel(t.value);
    } else if (t.dataset.ov === "brightness" && t.type === "range") {
      this._mirrorBrightness(t.value);
    }
  }

  _onChange(e) {
    const t = e.target;
    if (t.dataset.ov) return this._onOverrideChange(t);
    const field = t.dataset.field;
    if (!field) return;
    const scene = this._scene(this._sceneId);
    const step = scene.entities[+t.dataset.ent].steps[+t.dataset.step];
    if (field === "brightness") step.brightness = clamp(Math.round(+t.value), 0, 100);
    else {
      const v = clamp(Number.isFinite(+t.value) ? +t.value : 0, 0, 3600);
      step[field] = Math.round(v * 10) / 10;
      t.value = step[field];
    }
    this._queueSave(scene);
  }

  _onOverrideChange(t) {
    const scene = this._scene(this._sceneId);
    const ov = this._overrides(scene)[t.dataset.ov];
    if (t.type === "checkbox") {
      ov.enabled = t.checked;
      this._queueSave(scene);
      this._render();
      return;
    }
    if (t.dataset.ov === "brightness") {
      ov.value = clamp(Math.round(+t.value), 0, 100);
      this._mirrorBrightness(ov.value);
      this._queueSave(scene);
      return;
    }
    const v = clamp(Number.isFinite(+t.value) ? +t.value : 0, 0, 3600);
    ov.value = Math.round(v * 10) / 10;
    t.value = ov.value;
    // Mirror the new value into the greyed-out step fields without a full re-render.
    this.shadowRoot
      .querySelectorAll(`input[data-field="${t.dataset.ov}"]`)
      .forEach((input) => (input.value = ov.value));
    this.shadowRoot.querySelectorAll(".loop-len").forEach((el) => {
      const ent = scene.entities[+el.dataset.ent];
      el.textContent = this._loopLength(scene, ent);
    });
    this._queueSave(scene);
  }

  // Show the global brightness on the override slider and the greyed-out step sliders.
  _mirrorBrightness(value) {
    const root = this.shadowRoot;
    root.querySelector(".ov-bri-value").textContent = briLabel(value);
    root.querySelectorAll('input[data-field="brightness"]').forEach((input) => {
      input.value = value;
      input.closest(".step").querySelector(".bri-value").textContent = briLabel(value);
    });
  }

  _overrides(scene) {
    if (!scene.overrides) scene.overrides = clone(DEFAULT_OVERRIDES);
    for (const k of Object.keys(DEFAULT_OVERRIDES)) if (!scene.overrides[k]) scene.overrides[k] = clone(DEFAULT_OVERRIDES[k]);
    return scene.overrides;
  }

  // The value a step actually runs with, after global overrides.
  _effective(scene, step, field) {
    const ov = this._overrides(scene)[field];
    return ov.enabled ? ov.value : step[field];
  }

  _loopLength(scene, ent) {
    const total = ent.steps.reduce(
      (t, s) => t + this._effective(scene, s, "hold") + this._effective(scene, s, "transition"),
      0
    );
    return `${Math.round(total * 10) / 10}s loop`;
  }

  _onKeyDown(e) {
    const t = e.target;
    if (t.classList.contains("name-input")) {
      if (e.key === "Enter") t.blur();
      if (e.key === "Escape") {
        t.value = this._scene(t.dataset.scene)?.name || "";
        t.blur();
      }
    } else if (e.key === "Escape" && (this._picker || this._entityDialog)) {
      this._picker = null;
      this._entityDialog = null;
      this._render();
    } else if (e.key === "Enter" && t.classList.contains("entity-search") && this._entityDialog.selected.size) {
      this._addEntities([...this._entityDialog.selected]);
    }
  }

  _onFocusOut(e) {
    const t = e.target;
    if (t.classList.contains("name-input")) {
      const scene = this._scene(t.dataset.scene);
      const name = t.value.trim();
      if (scene && name && name !== scene.name) {
        scene.name = name;
        this._ws({ type: "kolourcraft/scene/update", scene_id: scene.id, name });
      }
      if (this._renamingId === t.dataset.scene) {
        this._renamingId = null;
        this._renderPending = true;
      }
      setTimeout(() => this._flushRender(), 0);
      return;
    }
    if (this._renderPending) setTimeout(() => this._flushRender(), 0);
  }

  _onPointerDown(e) {
    const sv = e.target.closest(".sv");
    if (!sv) return;
    e.preventDefault();
    this._dragging = true;
    const move = (ev) => {
      const r = sv.getBoundingClientRect();
      this._picker.hsv[1] = clamp((ev.clientX - r.left) / r.width, 0, 1);
      this._picker.hsv[2] = 1 - clamp((ev.clientY - r.top) / r.height, 0, 1);
      this._updatePicker();
    };
    const up = () => {
      this._dragging = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      this._flushRender();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    move(e);
  }

  // ---------- actions ----------

  async _newScene() {
    const used = new Set(this._data.scenes.map((s) => s.name));
    let name = "New scene", n = 2;
    while (used.has(name)) name = `New scene ${n++}`;
    let scene;
    try {
      scene = await this._ws({ type: "kolourcraft/scene/create", name });
    } catch (_) {
      return;
    }
    if (!this._scene(scene.id)) this._data.scenes.push(scene);
    this._renamingId = scene.id;
    this._render();
    this._focusRename();
  }

  _focusRename() {
    const input = this.shadowRoot.querySelector(`.name-input[data-scene="${this._renamingId}"]`);
    if (input) {
      input.focus();
      input.select();
    }
  }

  _addEntities(ids) {
    const scene = this._scene(this._sceneId);
    const template = scene.entities[0]?.steps;
    for (const id of ids) {
      if (scene.entities.some((e) => e.entity_id === id)) continue;
      scene.entities.push({ entity_id: id, steps: clone(template || STARTER_STEPS) });
    }
    this._entityDialog = null;
    this._queueSave(scene);
    this._render();
  }

  // ---------- rendering ----------

  _render() {
    if (!this._hass) return;
    const scene = this._sceneId && this._scene(this._sceneId);
    let body;
    if (this._error) body = `<div class="empty error">KolourCraft could not load: ${esc(this._error)}</div>`;
    else if (!this._data) body = `<div class="empty">Loading…</div>`;
    else if (scene) body = this._renderEditor(scene);
    else body = this._renderList();

    this.shadowRoot.innerHTML = `
      <style>${STYLES}</style>
      <div class="toolbar">
        ${this._narrow ? `<button class="icon-btn" data-act="menu" title="Menu"><ha-icon icon="mdi:menu"></ha-icon></button>` : ""}
        ${scene ? `<button class="icon-btn" data-act="back" title="Back to scenes"><ha-icon icon="mdi:arrow-left"></ha-icon></button>` : ""}
        <div class="title">KolourCraft</div>
      </div>
      <div class="content">${body}</div>
      ${this._entityDialog ? this._renderEntityDialog() : ""}
      ${this._picker ? this._renderPicker() : ""}
    `;
    if (this._entityDialog) this._renderEntityList();
    if (this._picker) {
      this._renderFavorites();
      this._updatePicker();
    }
  }

  _sceneSwatches(scene) {
    if (!scene.entities.length) return `<span class="muted">No lights yet</span>`;
    return scene.entities
      .slice(0, 4)
      .map(
        (ent) =>
          `<div class="mini-row" title="${esc(this._lightName(ent.entity_id))}">${ent.steps
            .map((s) => `<span class="mini" style="background:${rgbCss(s.color)}"></span>`)
            .join("")}</div>`
      )
      .join("") + (scene.entities.length > 4 ? `<span class="muted">+${scene.entities.length - 4} more</span>` : "");
  }

  _renderList() {
    const scenes = this._data.scenes;
    return `
      <div class="list-head">
        <button class="primary" data-act="new-scene"><ha-icon icon="mdi:plus"></ha-icon> New scene</button>
      </div>
      ${scenes.length ? "" : `<div class="empty">No scenes yet. Press <b>New scene</b> to create one.</div>`}
      <div class="scene-list">
        ${scenes
          .map((s) => {
            const running = this._isRunning(s.id);
            const nameHtml =
              this._renamingId === s.id
                ? `<input class="name-input" data-scene="${s.id}" value="${esc(s.name)}" maxlength="100">`
                : `<div class="scene-name">${esc(s.name)}</div>`;
            return `
            <div class="card scene-card ${running ? "running" : ""}" data-act="open-scene" data-scene="${s.id}">
              <div class="scene-main">
                ${nameHtml}
                <div class="scene-meta">${s.entities.length} light${s.entities.length === 1 ? "" : "s"}${
                  running ? ` · <span class="badge">Running</span>` : ""
                }</div>
                <div class="swatches">${this._sceneSwatches(s)}</div>
              </div>
              <div class="scene-actions">
                <button class="icon-btn" data-act="rename" data-scene="${s.id}" title="Rename"><ha-icon icon="mdi:pencil"></ha-icon></button>
                <button class="icon-btn ${running ? "on" : ""}" data-act="toggle-run" data-scene="${s.id}" title="${running ? "Stop" : "Start"}" ${
                  s.entities.length ? "" : "disabled"
                }><ha-icon icon="${running ? "mdi:stop" : "mdi:play"}"></ha-icon></button>
                <button class="icon-btn" data-act="delete-scene" data-scene="${s.id}" title="Delete"><ha-icon icon="mdi:delete-outline"></ha-icon></button>
              </div>
            </div>`;
          })
          .join("")}
      </div>`;
  }

  _renderEditor(scene) {
    const running = this._isRunning(scene.id);
    const ids = new Set(scene.entities.map((e) => e.entity_id));
    const overlaps = scene.entities
      .filter((e) => (this._hass.states[e.entity_id]?.attributes.entity_id || []).some((m) => ids.has(m)))
      .map((e) => this._lightName(e.entity_id));
    const switchId = this._data.switches?.[scene.id];
    return `
      <div class="editor-head">
        <input class="name-input big" data-scene="${scene.id}" value="${esc(scene.name)}" maxlength="100" title="Scene name">
        <button class="${running ? "danger" : "primary"}" data-act="toggle-run" ${scene.entities.length ? "" : "disabled"}>
          <ha-icon icon="${running ? "mdi:stop" : "mdi:play"}"></ha-icon> ${running ? "Stop" : "Start"}
        </button>
      </div>
      ${switchId ? `<div class="muted small">Automations can turn this scene on or off with <code>${esc(switchId)}</code>.</div>` : ""}
      ${this._renderOverrides(scene)}
      <div class="list-head">
        <button class="primary" data-act="add-entity"><ha-icon icon="mdi:plus"></ha-icon> Add entity</button>
      </div>
      ${
        overlaps.length
          ? `<div class="warn">${esc(overlaps.join(", "))} ${overlaps.length === 1 ? "is a group" : "are groups"} whose member lights are also in this scene. Both will send commands to the same bulbs.</div>`
          : ""
      }
      ${scene.entities.length ? "" : `<div class="empty">Add one or more lights to start building this scene.</div>`}
      ${scene.entities.map((ent, i) => this._renderEntityCard(scene, ent, i)).join("")}
    `;
  }

  _renderOverrides(scene) {
    const ov = this._overrides(scene);
    return `
      <div class="card overrides">
        <div class="overrides-title">Global Overrides</div>
        <div class="overrides-row">
          ${OVERRIDE_FIELDS.map(
            ([field, label]) => `
            <div class="override ${ov[field].enabled ? "on" : ""}">
              <label class="override-check">
                <input type="checkbox" data-ov="${field}" ${ov[field].enabled ? "checked" : ""}>
                <span>${label}</span>
              </label>
              <label class="field">
                <input type="number" min="0" max="3600" step="0.1" value="${ov[field].value}" data-ov="${field}"
                  ${ov[field].enabled ? "" : "disabled"} aria-label="Global ${label}">
              </label>
            </div>`
          ).join("")}
          <div class="override bri ${ov.brightness.enabled ? "on" : ""}">
            <label class="override-check">
              <input type="checkbox" data-ov="brightness" ${ov.brightness.enabled ? "checked" : ""}>
              <span>Brightness</span>
            </label>
            <label class="field">
              <span><b class="ov-bri-value">${briLabel(ov.brightness.value)}</b></span>
              <input type="range" min="0" max="100" step="1" value="${ov.brightness.value}" data-ov="brightness"
                ${ov.brightness.enabled ? "" : "disabled"} aria-label="Global brightness">
            </label>
          </div>
        </div>
        <div class="muted small">Checked settings apply to every color of every light in this scene.</div>
      </div>`;
  }

  _renderEntityCard(scene, ent, i) {
    const count = scene.entities.length;
    const st = this._hass.states[ent.entity_id];
    const members = st?.attributes.entity_id;
    return `
      <div class="card entity-card">
        <div class="entity-head">
          ${this._stateDot(ent.entity_id)}
          <div class="entity-title">
            <div class="entity-name">${esc(this._lightName(ent.entity_id))} ${
              Array.isArray(members) ? `<span class="badge">Group · ${members.length}</span>` : ""
            }</div>
            <div class="muted small">${esc(ent.entity_id)} · ${ent.steps.length} color${ent.steps.length === 1 ? "" : "s"} · <span class="loop-len" data-ent="${i}">${this._loopLength(scene, ent)}</span></div>
          </div>
          ${count > 1 ? `<button class="text-btn" data-act="copy-to-all" data-ent="${i}" title="Use these colors on every light in this scene">Copy to all</button>` : ""}
          <button class="icon-btn" data-act="remove-entity" data-ent="${i}" title="Remove from scene"><ha-icon icon="mdi:close"></ha-icon></button>
        </div>
        <div class="steps">
          ${ent.steps.map((s, j) => this._renderStep(scene, s, i, j, ent.steps.length)).join("")}
          <button class="add-step" data-act="add-step" data-ent="${i}" title="Add a color to the loop">
            <ha-icon icon="mdi:plus"></ha-icon><span>Add color</span>
          </button>
        </div>
      </div>`;
  }

  _renderStep(scene, s, i, j, n) {
    const a = `data-ent="${i}" data-step="${j}"`;
    const ov = this._overrides(scene);
    const timing = (field, label) =>
      ov[field].enabled
        ? `<label class="field overridden" title="Set by Global Overrides"><span>${label}</span>
            <input type="number" value="${ov[field].value}" data-field="${field}" ${a} disabled></label>`
        : `<label class="field"><span>${label}</span>
            <input type="number" min="0" max="3600" step="0.1" value="${s[field]}" data-field="${field}" ${a}></label>`;
    return `
      <div class="step">
        <div class="step-top">
          <span class="step-num">${j + 1}</span>
          <span class="spacer"></span>
          <button class="icon-btn tiny" data-act="move-step" data-dir="-1" ${a} ${j ? "" : "disabled"} title="Move earlier"><ha-icon icon="mdi:chevron-left"></ha-icon></button>
          <button class="icon-btn tiny" data-act="move-step" data-dir="1" ${a} ${j < n - 1 ? "" : "disabled"} title="Move later"><ha-icon icon="mdi:chevron-right"></ha-icon></button>
          <button class="icon-btn tiny" data-act="remove-step" ${a} ${n > 1 ? "" : "disabled"} title="Remove color"><ha-icon icon="mdi:close"></ha-icon></button>
        </div>
        <button class="swatch" data-act="pick" ${a} style="background:${rgbCss(s.color)}" title="Change color">
          <span>${rgbToHex(s.color)}</span>
        </button>
        ${
          ov.brightness.enabled
            ? `<label class="field overridden" title="Set by Global Overrides">
                <span>Brightness <b class="bri-value">${briLabel(ov.brightness.value)}</b></span>
                <input type="range" min="0" max="100" step="1" value="${ov.brightness.value}" data-field="brightness" ${a} disabled>
              </label>`
            : `<label class="field">
                <span>Brightness <b class="bri-value">${briLabel(s.brightness)}</b></span>
                <input type="range" min="0" max="100" step="1" value="${s.brightness}" data-field="brightness" ${a}>
              </label>`
        }
        <div class="field-row">
          ${timing("hold", "Hold (s)")}
          ${timing("transition", "Fade (s)")}
        </div>
      </div>`;
  }

  _renderEntityDialog() {
    return `
      <div class="overlay" data-act="overlay">
        <div class="dialog entity-dialog" role="dialog" aria-label="Add entity">
          <div class="dialog-head">
            <div class="dialog-title">Add entity</div>
            <button class="icon-btn" data-act="close-dialog" title="Close"><ha-icon icon="mdi:close"></ha-icon></button>
          </div>
          <input class="entity-search" type="search" placeholder="Search lights" value="${esc(this._entityDialog.search)}">
          <div class="entity-list"></div>
          <div class="dialog-actions">
            <button class="text-btn" data-act="close-dialog">Cancel</button>
            <button class="primary confirm-entities" data-act="confirm-entities" disabled>Add</button>
          </div>
        </div>
      </div>`;
  }

  // Groups first, each followed by its member lights, then everything else.
  _renderEntityList() {
    const list = this.shadowRoot.querySelector(".entity-list");
    if (!list) return;
    const dlg = this._entityDialog;
    const scene = this._scene(this._sceneId);
    const inScene = new Set(scene.entities.map((e) => e.entity_id));
    const lights = this._lights();
    const byId = Object.fromEntries(lights.map((l) => [l.id, l]));
    const q = dlg.search.trim().toLowerCase();
    const match = (l) => !q || l.name.toLowerCase().includes(q) || l.id.includes(q);

    const rows = [];
    const placed = new Set();
    const row = (l, opts = {}) => {
      placed.add(l.id);
      const added = inScene.has(l.id);
      const checked = added || dlg.selected.has(l.id);
      const tag = l.members ? `<span class="badge">Group · ${l.members.length}</span>` : "";
      return `
        <div class="entity-row ${opts.child ? "child" : ""} ${added ? "added" : ""}" ${
          added ? "" : `data-act="toggle-entity" data-entity="${esc(l.id)}"`
        }>
          <span class="check ${checked ? "checked" : ""}">${checked ? '<ha-icon icon="mdi:check"></ha-icon>' : ""}</span>
          ${this._stateDot(l.id)}
          <div class="entity-row-text">
            <div>${esc(l.name)} ${tag}</div>
            <div class="muted small">${esc(l.id)}${added ? " · already in scene" : ""}</div>
          </div>
        </div>`;
    };

    for (const g of lights.filter((l) => l.members)) {
      const kids = g.members.map((m) => byId[m]).filter(Boolean);
      const shownKids = kids.filter(match);
      if (!match(g) && !shownKids.length) continue;
      rows.push(row(g));
      for (const k of q && !match(g) ? shownKids : kids) rows.push(row(k, { child: true }));
    }
    for (const l of lights) if (!placed.has(l.id) && !l.members && match(l)) rows.push(row(l));

    list.innerHTML = rows.length ? rows.join("") : `<div class="empty">No lights match "${esc(dlg.search)}"</div>`;
    const btn = this.shadowRoot.querySelector(".confirm-entities");
    btn.disabled = !dlg.selected.size;
    btn.textContent = dlg.selected.size ? `Add ${dlg.selected.size}` : "Add";
  }

  _renderPicker() {
    return `
      <div class="overlay" data-act="overlay">
        <div class="dialog picker" role="dialog" aria-label="Pick a color">
          <div class="dialog-head">
            <div class="dialog-title">Pick a color</div>
            <button class="icon-btn" data-act="close-dialog" title="Close"><ha-icon icon="mdi:close"></ha-icon></button>
          </div>
          <div class="sv"><div class="sv-white"></div><div class="sv-black"></div><div class="sv-thumb"></div></div>
          <input class="hue" type="range" min="0" max="360" step="1" aria-label="Hue">
          <div class="picker-row">
            <div class="preview-pair">
              <div class="preview old" style="background:${rgbCss(this._picker.original)}" title="Current"></div>
              <div class="preview new" title="New"></div>
            </div>
            <input class="hex" maxlength="7" spellcheck="false" aria-label="Hex color">
          </div>
          <div class="section-head">
            <span>Favorites</span>
            <button class="text-btn" data-act="fav-save"><ha-icon icon="mdi:star-plus-outline"></ha-icon> Save color</button>
          </div>
          <div class="favs"></div>
          <div class="section-head"><span>Presets</span></div>
          <div class="palette">
            ${PRESETS.map(
              (c) => `<button class="pal" data-act="picker-swatch" data-color="[${c}]" style="background:${rgbCss(c)}" title="${rgbToHex(c)}"></button>`
            ).join("")}
          </div>
          <div class="muted small">Lights are sent at most 85% saturation, which keeps color fades smooth.</div>
          <div class="dialog-actions">
            <button class="text-btn" data-act="close-dialog">Cancel</button>
            <button class="primary" data-act="picker-apply">Apply</button>
          </div>
        </div>
      </div>`;
  }

  _renderFavorites() {
    const el = this.shadowRoot.querySelector(".favs");
    if (!el) return;
    const favs = this._data.favorites;
    el.innerHTML = favs.length
      ? favs
          .map(
            (c, i) => `
          <div class="fav">
            <button class="pal" data-act="picker-swatch" data-color="[${c}]" style="background:${rgbCss(c)}" title="${rgbToHex(c)}"></button>
            <button class="fav-x" data-act="fav-remove" data-idx="${i}" title="Remove favorite">×</button>
          </div>`
          )
          .join("")
      : `<span class="muted small">No favorites yet. Pick a color and press Save color.</span>`;
  }

  // Update the open picker in place so dragging stays smooth.
  _updatePicker(fromHex = false) {
    const root = this.shadowRoot;
    const [h, s, v] = this._picker.hsv;
    const rgb = hsvToRgb(this._picker.hsv);
    root.querySelector(".sv").style.backgroundColor = `hsl(${h}, 100%, 50%)`;
    const thumb = root.querySelector(".sv-thumb");
    thumb.style.left = `${s * 100}%`;
    thumb.style.top = `${(1 - v) * 100}%`;
    thumb.style.background = rgbCss(rgb);
    root.querySelector(".hue").value = Math.round(h);
    root.querySelector(".preview.new").style.background = rgbCss(rgb);
    if (!fromHex) root.querySelector(".hex").value = rgbToHex(rgb);
  }
}

const STYLES = `
  :host {
    display: block; min-height: 100vh;
    background: var(--primary-background-color);
    color: var(--primary-text-color);
    font-family: var(--paper-font-body1_-_font-family, Roboto, system-ui, sans-serif);
    --kc-radius: 12px;
  }
  * { box-sizing: border-box; }
  button { font: inherit; color: inherit; }
  ha-icon { --mdc-icon-size: 20px; }
  .toolbar {
    display: flex; align-items: center; gap: 4px; height: 56px; padding: 0 12px;
    background: var(--app-header-background-color, var(--primary-color));
    color: var(--app-header-text-color, var(--text-primary-color, #fff));
    position: sticky; top: 0; z-index: 2;
  }
  .toolbar .title { font-size: 20px; margin-left: 8px; }
  .toolbar .icon-btn { color: inherit; }
  .content { max-width: 1100px; margin: 0 auto; padding: 16px; }
  .list-head { display: flex; gap: 8px; margin: 4px 0 16px; }
  .card {
    background: var(--card-background-color, #fff);
    border-radius: var(--ha-card-border-radius, var(--kc-radius));
    border: 1px solid var(--divider-color, rgba(0,0,0,.12));
    box-shadow: var(--ha-card-box-shadow, none);
  }
  .primary, .danger {
    display: inline-flex; align-items: center; gap: 6px; border: 0; cursor: pointer;
    padding: 9px 16px; border-radius: 20px; font-weight: 500;
    background: var(--primary-color); color: var(--text-primary-color, #fff);
  }
  .danger { background: var(--error-color, #db4437); }
  .primary:disabled, .danger:disabled { opacity: .45; cursor: default; }
  .text-btn {
    display: inline-flex; align-items: center; gap: 4px; background: none; border: 0;
    color: var(--primary-color); cursor: pointer; padding: 6px 10px; border-radius: 16px; font-weight: 500;
  }
  .text-btn:hover { background: rgba(127,127,127,.12); }
  .icon-btn {
    display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px;
    border: 0; border-radius: 50%; background: none; cursor: pointer; color: var(--secondary-text-color);
  }
  .icon-btn:hover:not(:disabled) { background: rgba(127,127,127,.15); }
  .icon-btn:disabled { opacity: .3; cursor: default; }
  .icon-btn.on { color: var(--primary-color); }
  .icon-btn.tiny { width: 26px; height: 26px; }
  .icon-btn.tiny ha-icon { --mdc-icon-size: 16px; }
  .muted { color: var(--secondary-text-color); }
  .small { font-size: 12px; }
  .empty { padding: 32px 16px; text-align: center; color: var(--secondary-text-color); }
  .error { color: var(--error-color); }
  .badge {
    display: inline-block; font-size: 11px; font-weight: 500; padding: 1px 8px; border-radius: 10px;
    background: rgba(127,127,127,.15); color: var(--secondary-text-color); vertical-align: middle;
  }
  .running .badge { background: var(--primary-color); color: var(--text-primary-color, #fff); }
  .warn {
    margin: 0 0 16px; padding: 10px 14px; border-radius: 8px; font-size: 14px;
    background: rgba(255,166,0,.15); border-left: 4px solid var(--warning-color, #ffa600);
  }
  code { font-size: 12px; padding: 1px 5px; border-radius: 4px; background: rgba(127,127,127,.15); }

  .scene-list { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
  .scene-card { display: flex; gap: 8px; padding: 14px 8px 14px 16px; cursor: pointer; }
  .scene-card:hover { border-color: var(--primary-color); }
  .scene-card.running { border-color: var(--primary-color); border-width: 2px; padding: 13px 7px 13px 15px; }
  .scene-main { flex: 1; min-width: 0; }
  .scene-name { font-size: 17px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .scene-meta { font-size: 13px; color: var(--secondary-text-color); margin: 2px 0 10px; }
  .scene-actions { display: flex; flex-direction: column; }
  .swatches { display: flex; flex-direction: column; gap: 4px; }
  .mini-row { display: flex; gap: 3px; flex-wrap: wrap; }
  .mini { width: 18px; height: 12px; border-radius: 3px; border: 1px solid rgba(127,127,127,.3); }

  .name-input {
    width: 100%; font: inherit; font-size: 17px; font-weight: 500; padding: 4px 8px; margin: -5px 0 0 -9px;
    border: 1px solid var(--primary-color); border-radius: 6px; outline: none;
    background: var(--card-background-color); color: var(--primary-text-color);
  }
  .name-input.big {
    font-size: 24px; margin: 0; flex: 1; min-width: 0; border-color: transparent; background: transparent;
  }
  .name-input.big:hover { border-color: var(--divider-color); }
  .name-input.big:focus { border-color: var(--primary-color); background: var(--card-background-color); }
  .editor-head { display: flex; align-items: center; gap: 12px; margin-bottom: 4px; }

  .entity-card { margin-bottom: 16px; padding: 12px 12px 16px; }
  .entity-head { display: flex; align-items: center; gap: 10px; padding: 0 0 12px 4px; }
  .entity-title { flex: 1; min-width: 0; }
  .entity-name { font-size: 16px; font-weight: 500; }
  .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; background: var(--disabled-text-color, #999); }
  .dot.on { background: var(--state-light-active-color, #ffc107); box-shadow: 0 0 6px var(--state-light-active-color, #ffc107); }
  .dot.off { background: var(--secondary-text-color); opacity: .5; }
  .dot.unavailable { background: var(--error-color, #db4437); opacity: .7; }

  .steps { display: flex; gap: 12px; overflow-x: auto; padding: 2px 2px 6px; }
  .step {
    flex: 0 0 168px; display: flex; flex-direction: column; gap: 8px; padding: 8px 10px 10px;
    border: 1px solid var(--divider-color); border-radius: 10px; background: var(--secondary-background-color, transparent);
  }
  .step-top { display: flex; align-items: center; margin: -2px -4px 0 0; }
  .step-num { font-size: 12px; font-weight: 600; color: var(--secondary-text-color); }
  .spacer { flex: 1; }
  .swatch {
    height: 64px; border-radius: 8px; border: 1px solid rgba(127,127,127,.35); cursor: pointer;
    display: flex; align-items: flex-end; justify-content: flex-end; padding: 4px 6px;
  }
  .swatch span { font-size: 11px; font-family: monospace; background: rgba(0,0,0,.45); color: #fff; padding: 1px 5px; border-radius: 4px; }
  .swatch:hover { box-shadow: 0 0 0 2px var(--primary-color); }
  .field { display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: var(--secondary-text-color); min-width: 0; }
  .field span { display: flex; justify-content: space-between; }
  .field b { color: var(--primary-text-color); font-weight: 500; }
  .field-row { display: flex; gap: 8px; }
  .field-row > .field { flex: 1 1 0; }
  .field input:disabled { opacity: .45; cursor: not-allowed; }
  .field.overridden span { opacity: .6; }
  .overrides { padding: 12px 16px 12px; margin: 12px 0 16px; display: flex; flex-direction: column; gap: 10px; }
  .overrides-title { font-size: 16px; font-weight: 500; }
  .overrides-row { display: flex; flex-wrap: wrap; gap: 12px; }
  .override {
    display: flex; align-items: center; gap: 12px; padding: 8px 12px; border-radius: 10px;
    border: 1px solid var(--divider-color); background: var(--secondary-background-color, transparent);
  }
  .override.on { border-color: var(--primary-color); }
  .override .field { width: 78px; }
  .override.bri .field { width: 140px; }
  .override.bri .field span { justify-content: flex-end; }
  .override:not(.on) .ov-bri-value { opacity: .5; }
  .override-check { display: flex; align-items: center; gap: 8px; font-size: 14px; cursor: pointer; }
  .override-check input { width: 18px; height: 18px; margin: 0; accent-color: var(--primary-color); cursor: pointer; }
  .field input[type=number] {
    width: 100%; font: inherit; font-size: 14px; padding: 5px 6px; border-radius: 6px;
    border: 1px solid var(--divider-color); background: var(--card-background-color); color: var(--primary-text-color);
  }
  .field input[type=range] { width: 100%; accent-color: var(--primary-color); margin: 2px 0; }
  .add-step {
    flex: 0 0 110px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
    border: 2px dashed var(--divider-color); border-radius: 10px; background: none; cursor: pointer;
    color: var(--secondary-text-color); font-size: 13px;
  }
  .add-step:hover { border-color: var(--primary-color); color: var(--primary-color); }

  .overlay {
    position: fixed; inset: 0; z-index: 10; background: rgba(0,0,0,.45);
    display: flex; align-items: center; justify-content: center; padding: 16px;
  }
  .dialog {
    width: 100%; max-height: calc(100vh - 32px); display: flex; flex-direction: column; gap: 12px;
    background: var(--card-background-color, #fff); color: var(--primary-text-color);
    border-radius: 16px; padding: 16px 20px 14px; box-shadow: 0 10px 40px rgba(0,0,0,.35);
  }
  .entity-dialog { max-width: 520px; }
  .picker { max-width: 360px; overflow-y: auto; }
  .dialog-head { display: flex; align-items: center; margin-right: -8px; }
  .dialog-title { flex: 1; font-size: 20px; font-weight: 500; }
  .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
  .entity-search {
    font: inherit; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--divider-color);
    background: var(--secondary-background-color, transparent); color: var(--primary-text-color); outline: none;
  }
  .entity-search:focus { border-color: var(--primary-color); }
  .entity-list { overflow-y: auto; min-height: 120px; max-height: 55vh; margin: 0 -8px; }
  .entity-row { display: flex; align-items: center; gap: 10px; padding: 8px; border-radius: 8px; cursor: pointer; }
  .entity-row:hover:not(.added) { background: rgba(127,127,127,.12); }
  .entity-row.child { padding-left: 36px; }
  .entity-row.added { cursor: default; opacity: .55; }
  .entity-row-text { flex: 1; min-width: 0; }
  .check {
    width: 20px; height: 20px; flex: none; border-radius: 4px; border: 2px solid var(--secondary-text-color);
    display: flex; align-items: center; justify-content: center;
  }
  .check.checked { background: var(--primary-color); border-color: var(--primary-color); color: var(--text-primary-color, #fff); }
  .check ha-icon { --mdc-icon-size: 16px; }

  .sv { position: relative; height: 190px; border-radius: 10px; cursor: crosshair; touch-action: none; }
  .sv-white, .sv-black { position: absolute; inset: 0; border-radius: 10px; }
  .sv-white { background: linear-gradient(to right, #fff, rgba(255,255,255,0)); }
  .sv-black { background: linear-gradient(to top, #000, rgba(0,0,0,0)); }
  .sv-thumb {
    position: absolute; width: 18px; height: 18px; border-radius: 50%; transform: translate(-50%, -50%);
    border: 3px solid #fff; box-shadow: 0 0 0 1px rgba(0,0,0,.5), 0 1px 4px rgba(0,0,0,.4); pointer-events: none;
  }
  .hue {
    -webkit-appearance: none; appearance: none; width: 100%; height: 14px; border-radius: 7px; margin: 0;
    background: linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00);
  }
  .hue::-moz-range-thumb { width: 18px; height: 18px; border-radius: 50%; border: 3px solid #fff; background: transparent; box-shadow: 0 0 0 1px rgba(0,0,0,.5); }
  .hue::-webkit-slider-thumb { -webkit-appearance: none; width: 18px; height: 18px; border-radius: 50%; border: 3px solid #fff; background: transparent; box-shadow: 0 0 0 1px rgba(0,0,0,.5); }
  .picker-row { display: flex; align-items: center; gap: 12px; }
  .preview-pair { display: flex; border-radius: 8px; overflow: hidden; border: 1px solid rgba(127,127,127,.35); }
  .preview { width: 40px; height: 36px; }
  .hex {
    flex: 1; min-width: 0; font: inherit; font-family: monospace; font-size: 15px; padding: 7px 10px; border-radius: 8px;
    border: 1px solid var(--divider-color); background: var(--secondary-background-color, transparent); color: var(--primary-text-color);
  }
  .section-head { display: flex; align-items: center; justify-content: space-between; font-size: 13px; font-weight: 500; color: var(--secondary-text-color); margin-bottom: -6px; }
  .favs, .palette { display: flex; flex-wrap: wrap; gap: 8px; min-height: 30px; align-items: center; }
  .pal { width: 30px; height: 30px; border-radius: 50%; border: 1px solid rgba(127,127,127,.4); cursor: pointer; padding: 0; }
  .pal:hover { box-shadow: 0 0 0 2px var(--primary-color); }
  .fav { position: relative; }
  .fav-x {
    position: absolute; top: -6px; right: -6px; width: 17px; height: 17px; border-radius: 50%; padding: 0;
    font-size: 12px; line-height: 15px; border: 1px solid var(--divider-color); cursor: pointer;
    background: var(--card-background-color); color: var(--secondary-text-color); display: none;
  }
  .fav:hover .fav-x { display: block; }
  @media (hover: none) { .fav-x { display: block; } }

  @media (max-width: 600px) {
    .content { padding: 12px; }
    .scene-list { grid-template-columns: 1fr; }
    .editor-head { flex-wrap: wrap; }
    .name-input.big { font-size: 20px; }
  }
`;

if (!customElements.get("kolourcraft-panel")) customElements.define("kolourcraft-panel", KolourCraftPanel);
