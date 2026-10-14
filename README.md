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
  to use one value for every color of every light in the scene. *Max saturation* (default 75%) is
  always applied; see [Max saturation](#max-saturation). The matching fields in the color boxes are
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
- **Colors are sent at no more than the scene's Max saturation.** See [Max saturation](#max-saturation).
- **Near-opposite colors are faded via a midpoint.** See [Fades between opposite colors](#fades-between-opposite-colors).

## Max saturation

Each scene has a **Max saturation** slider in Global Overrides (default **75%**, range 30–100%).
It is always applied: every color is sent to the lights as hue/saturation with saturation limited
to this value. Lowering it washes colors out, but reduces color snapping caused by the limits of
your lights' LED channels at low brightness, so you can dial it in for your brand of lights. The
colors you pick in the editor are stored unchanged; only what is sent to the lights is limited.

**Why it exists.** On GE Cync Full Color (Matter) bulbs, fades into highly saturated colors such as
pure red snapped visibly part-way through instead of fading smoothly. Saturated colors drive one or
more of the bulb's red, green or blue LED channels to (or near) zero, and the bulb can only dim a
channel in coarse steps at those low levels, so the light jumps instead of gliding. Keeping
saturation below 100% keeps every channel above that range.

Fixes were tested side by side on the same bulbs with 3 s fades:

| Approach | Result |
|---|---|
| Bulb's own fade, colors sent as picked (original behavior) | Visible snaps, mostly on red, purple and cyan |
| Software fades: new color every 0.5 s or 0.25 s | Worse; the steps themselves were visible |
| Fades sent in XY color instead of hue/saturation | Less smooth than limiting saturation |
| Saturation limited to 85% | Smoothest of the above by a large margin; small steps left on red and purple |
| Saturation limited to 75% | Colors still sharp; much smoother, with only a small step on the fade into light purple |
| Saturation limited to 65% | Smoothest, but colors started to look washed out |
| Short hold (0.3 s) at each color | No difference to the steps |

75% was the best balance on those bulbs, so it is the default. Other brands may look best at a
different value, which is why it is a per-scene setting. Colors already at or below the limit are
sent exactly as picked.

The first fade from white into a color can still show some stepping, because white has every
channel at full and that fade drives channels down toward low levels. Fades between colors are smooth.

**Brightness and fade length on GE Cync bulbs.** Later tests recorded the bulbs with a webcam
locked to fixed exposure and measured each bulb's light frame by frame:

| Scene brightness | Large brightness jumps per 27 s (3 bulbs) |
|---|---|
| 100% | 8 |
| 85% | 4 (but more small ones) |
| 75% | 33 |
| 65% | 35 |

Below full brightness the bulbs briefly flash while fading through blue and blue-green. That
happened whether brightness was re-sent with every command or only once, at a 67% or 75%
saturation limit, with or without a hold, and at 3 s or 6 s fades (longer fades pass through those
colors less often, so the flashes come half as often, but each one is just as strong). It comes from
the bulbs' own fade logic on firmware 1.03.190, which is the latest GE has released. For the smoothest
results on these bulbs, run scenes at 100% brightness.

## Fades between opposite colors

Bulbs fade hue the shorter way round the color wheel, judged from wherever they are when the
command arrives. Colors close to opposite each other, such as cyan (182°) and red (0°), are almost
equally far apart both ways. With no hold, a bulb that is still slightly short of cyan when the fade
to red starts takes the "shorter" way back through green, yellow and orange: a yellow flash, plus a
visible snap where the fade reverses direction.

So when two consecutive colors are more than 150° of hue apart, KolourCraft sends the fade as two
halves: first to the color halfway round the short way, then on to the target. Each half is well
under 180°, so the bulb cannot pick the wrong direction. In a 4-bulb scene with no hold, cyan → red
went through yellow on every loop before the change and never after it. The threshold is
`SPLIT_HUE_DEGREES` in `custom_components/kolourcraft/const.py`.

Scenes and favorites are stored in `/config/.storage/kolourcraft`.
