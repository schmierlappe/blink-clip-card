# Blink Clip Card

A Lovelace card that plays the newest clip saved by `blink.save_recent_clips`, with a strip of recent events underneath.

Blink cameras don't stream, so the built-in camera card only ever shows a still thumbnail. This card reads the clips you already save to your media folder and plays them in place, so a Blink camera looks and behaves like the rest of your dashboard.

Clips are fetched through Home Assistant's media source API, which means they stay behind authentication — nothing needs to be copied into `/config/www`.

## Requirements

- The [Blink integration](https://www.home-assistant.io/integrations/blink/), set up and working
- An automation that calls `blink.save_recent_clips` into a folder under `/media`
- Home Assistant 2023.6 or newer

## Install

### HACS

1. HACS → three-dot menu → **Custom repositories**
2. Add `https://github.com/schmierlappe/blink-clip-card`, category **Dashboard**
3. Find **Blink Clip Card** in HACS and install it
4. Hard-refresh your browser

### Manual

Copy `dist/blink-clip-card.js` to `/config/www/community/blink-clip-card/`, then add the resource under Settings → Dashboards → three-dot menu → **Resources**:

```
/local/community/blink-clip-card/blink-clip-card.js
```

as a **JavaScript module**.

## Saving the clips

The card only displays what's already on disk. This automation puts them there:

```yaml
- alias: "Save Blink Clips"
  mode: single
  max_exceeded: silent
  triggers:
    - trigger: time_pattern
      minutes: "/3"
  actions:
    - action: homeassistant.update_entity
      target:
        entity_id: camera.back_entrance
    - delay: "00:00:10"
    - action: blink.save_recent_clips
      target:
        entity_id:
          - camera.back_entrance
          - camera.driveway
      data:
        file_path: /media/blink
```

Files land as `YYYYMMDD_HHmmSS_CameraName.mp4`. The name isn't configurable, which is what the card relies on to sort clips and to tell cameras apart when they share a folder.

## Configuration

```yaml
type: custom:blink-clip-card
title: Hintereingang
path: local/blink
camera: Back_Entrance
entity: camera.back_entrance
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `path` | string | `local/blink` | Media source path. `local` is the media root, so `/media/blink` is `local/blink`. |
| `camera` | string | — | Camera name as it appears in the filename. Leave out if the folder holds one camera. |
| `entity` | string | — | Camera entity. Only used for the poster image and the fallback title. |
| `title` | string | — | Overrides the name shown on the video. |
| `clips` | number | `6` | How many recent clips appear in the strip. |
| `refresh_interval` | number | `60` | Seconds between checks for new clips. Never interrupts playback. |
| `aspect_ratio` | string | `16:9` | Card proportions, e.g. `4:3` or `1:1`. |
| `autoplay` | boolean | `false` | Start playing when a new clip arrives. |
| `muted` | boolean | `true` | Start muted. Browsers block autoplay with sound. |
| `utc_timestamps` | boolean | `true` | Blink records clip times in UTC. Turn off if the displayed times are shifted by your timezone offset. |

A visual editor is included, so all of this is editable from the card picker.

### Several cameras

One card each, pointed at the same folder:

```yaml
type: grid
columns: 2
square: false
cards:
  - type: custom:blink-clip-card
    path: local/blink
    camera: Back_Entrance
    title: Hintereingang
  - type: custom:blink-clip-card
    path: local/blink
    camera: Driveway
    title: Einfahrt
```

## Troubleshooting

**"No clips found"** — Open Media in the sidebar and navigate to the folder. If the clips aren't there, the automation is the problem, not the card. If they are there but the card disagrees, check that `camera` exactly matches the name in the filename, including capitals and underscores.

**"Could not read local/blink"** — The `path` is wrong. It's relative to your media root, without a leading slash: `/media/blink` → `local/blink`, `/media/cams/blink` → `local/cams/blink`.

**Clips stop appearing after a NAS reboot** — If your media folder is a network mount, Home Assistant may not have remounted it. Check Settings → System → Storage.

## Licence

MIT
