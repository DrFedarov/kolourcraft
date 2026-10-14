<p align="center"><img src="custom_components/kolourcraft/brand/icon@2x.png" alt="KolourCraft icon" width="160"></p>

# KolourCraft

Color-cycling light scenes for Home Assistant, edited from a sidebar panel.

- Each light (or light group) in a scene has its own loop of colors.
- Every color in the loop has its own **brightness** (0% = off), **hold** time and **fade** time.
- Colors are picked with a built-in picker that has saved **favorites** shared across scenes.
- Each scene is exposed as `switch.kolourcraft_<scene_name>`. Add it to any dashboard (tile, button or
  entities card) to start and stop the scene, or use it in automations.
- Turning a scene on switches on any of its lights that are off, then starts every light's loop at
  the same moment on a shared clock, so patterns stay in sync.
- Turning it off puts every light back to the state and color it had when the scene was turned on,
  and hands lights back to **Adaptive Lighting** (see below).

## Install

### HACS

1. In HACS, open the menu (⋮) → **Custom repositories**.
2. Add `https://github.com/DrFedarov/kolourcraft` with type **Integration**.
3. Find **KolourCraft** in HACS, download it, and restart Home Assistant.
4. Add **KolourCraft** under *Settings → Devices & services → Add integration*.

A **KolourCraft** entry appears in the sidebar (admin users only).

### Manual

Copy `custom_components/kolourcraft` to `/config/custom_components/`, restart Home Assistant,
then add the integration as in step 4 above.

Requires Home Assistant 2026.7 or newer (the version it was built and tested on).

## How it behaves

- **Timing:** a color step lasts *fade + hold* seconds: the light fades to the color, then holds it.
- **Global Overrides:** at the top of a scene's editor, tick *Hold (s)*, *Fade (s)* and/or *Brightness*
  to use one value for every color of every light in the scene. The matching fields in the color boxes are
  greyed out while an override is on; their own values are kept and come back when you untick it.
- **Groups:** you can add a light group, its individual member lights, or both. If a group and one of
  its members are in the same scene, both send commands to that bulb (the editor warns about this).
- **Adaptive Lighting:** while a scene runs, its lights are marked *manually controlled* in Adaptive
  Lighting, so it neither intercepts nor overrides the scene. On stop, lights are restored, then the
  ones Adaptive Lighting was managing are released, so it resumes adapting them. Lights you had
  already taken out of Adaptive Lighting stay that way.
- **One scene per light:** starting a scene stops any running scene that shares a light with it. The new
  scene inherits the shared lights' original states, so stopping it still restores the look from
  before either scene ran.
- **Restore:** on stop, the member bulbs are restored and re-checked a few seconds later; any bulb that
  dropped the command is sent it again.
- **Bulbs that ignore brightness when turning on** (seen on Matter bulbs): when a step turns a light on
  from off, KolourCraft switches it on first and then sends the color and brightness, so you may see a
  brief full-brightness blink at the start of the loop or after an "Off" step.

- **Fades are done by the bulb.** KolourCraft sends each color once with a fade time and the bulb
  fades itself. Stepping the fade in software was tested and looked worse (see below).
- **Colors are sent at no more than 85% saturation.** See the next section.

## Why colors are capped at 85% saturation

On GE Cync Full Color (Matter) bulbs, fades into fully saturated colors such as pure red snapped
visibly part-way through instead of fading smoothly. Fully saturated colors drive one or more of the
bulb's red, green or blue LED channels to (or near) zero, and the bulb can only dim a channel in coarse
steps at those very low levels, so the light jumps instead of gliding.

Several fixes were tested side by side on the same bulbs, fading red → purple → cyan with 3 s fades:

| Approach | Result |
|---|---|
| Bulb's own fade, colors sent as picked (previous behavior) | Visible snaps, mostly on red, purple and cyan |
| Software fades: new color every 0.5 s or 0.25 s | Worse; the steps themselves were visible |
| Fades sent in XY color instead of hue/saturation | Less smooth than the saturation cap |
| Hue/saturation with saturation capped at 85% | Smoothest by a large margin |

So KolourCraft converts each color to hue/saturation and limits saturation to 85% before sending it.
Every LED channel then stays above the range where the bulb steps coarsely. The colors you pick in
the editor are stored unchanged; only what is sent to the lights is capped, so fully saturated
colors appear very slightly softer (pure red is sent as 85% saturated red). Colors already at or below
85% saturation, such as most pastels, are sent exactly as picked.

The first fade from white into a color can still show some stepping, because white has every
channel at full and that fade drives channels down toward low levels. Fades between colors are smooth.

The cap is the `MAX_SATURATION` constant in `custom_components/kolourcraft/const.py`.

Scenes and favorites are stored in `/config/.storage/kolourcraft`.
