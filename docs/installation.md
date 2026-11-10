# 🛠️ Installation

Three steps: the card file, two MQTT sensors per FP300, and the card on a dashboard.

## 0. Find the name of your sensor

Open the Zigbee2MQTT frontend and copy the **friendly name** of your FP300 exactly as written.
The examples below use `fp300_a`. You need it in every step.

## 1. The card file

### With the Marketplace (recommended)

1. In Home Assistant open the Marketplace (HACS on older versions).
2. Add `thekoma/fp300-range-card` as a custom repository of type **Dashboard**.
3. Download **FP300 Range Card**. The dashboard resource is registered for you.
4. Reload the browser page.

### By hand

1. Copy `fp300-range-card.js` to `/config/www/` (create the folder if it is missing, then restart
   Home Assistant).
2. Go to **Settings → Dashboards → ⋮ → Resources → Add resource**.
3. URL `/local/fp300-range-card.js?v=1`, type **JavaScript module**.
4. Reload the browser page. When you update the file, raise the number in `?v=`.

## 2. The MQTT sensors (YAML package)

The card reads the sensor through two MQTT sensors:

- **raw** keeps the whole Zigbee2MQTT payload in its attributes.
- **applied** reads back the bands last applied from a card, so every phone, tablet and PC shows
  the same "waiting" and "bands changed" notices.

Home Assistant files live in `/config`. Reach it with the **File editor** or **Studio Code Server**
app, or the Samba share.

1. Create `/config/packages/` if it is missing and copy
   [`packages/fp300_range.yaml`](../packages/fp300_range.yaml) into it.
2. Open the file. It has a pair of sensors for `fp300_a` and one for `fp300_b`. Keep one pair per
   FP300 and replace the friendly name in `name`, `unique_id`, `state_topic` and
   `json_attributes_topic`. Delete the pairs you do not need.
3. If `configuration.yaml` already has a `recorder:` block, move the `sensor.fp300_raw_*` line
   there and delete the `recorder:` block from the package. Otherwise Home Assistant reports a
   conflict.
4. If you do not use packages yet, add this to `configuration.yaml`. If `homeassistant:` already
   exists, add only the `packages:` line inside it.

   ```yaml
   homeassistant:
     packages: !include_dir_named packages
   ```

5. Check the configuration (**Developer tools → YAML → Check configuration**) and restart Home
   Assistant.
6. In **Developer tools → States** look for `sensor.fp300_raw_<name>`. Its attributes must include
   `detection_range` and `detection_range_composite`.

Right after a restart the raw sensor can be empty: Zigbee2MQTT does not retain the last message,
so the attributes arrive with the next message from the device. Press the button on the FP300 or
wait a few minutes.

The package keeps the raw sensors out of the recorder, because they change at every message and
carry large attributes. Their availability follows the Zigbee2MQTT bridge, not the single sensor.

## 3. The card

On a dashboard: **Edit dashboard → Add card → Manual**, then paste:

```yaml
type: custom:fp300-range-card
entity: sensor.fp300_raw_fp300_a
applied_entity: sensor.fp300_applied_fp300_a
friendly_name: fp300_a
title: FP300
```

| Option | Required | Default | What it does |
|---|---|---|---|
| `entity` | yes | | The raw MQTT sensor from the package |
| `friendly_name` | yes | | The friendly name of the device in Zigbee2MQTT |
| `base_topic` | no | `zigbee2mqtt` | The Zigbee2MQTT base topic |
| `title` | no | `FP300 · <friendly_name>` | Card title |
| `applied_entity` | no | | The applied sensor from the package: shares the applied state between devices |
| `simple` | no | `false` | Simple mode: fan, limit, **Applica** and **Annulla** only |
| `bands_open` | no | `false` | Opens the 24-band panel right away |
| `background` | no | | Floor plan behind the fan, see below |

Add one card per FP300.

### Simple mode

For people at home who are not technical. It shows the fan, a plain sentence such as "Il sensore
rileva da 0 a 2 m", the limit with − and +, **Applica** and **Annulla**. Tracking, read-back and
single bands stay in the full card, which you can keep on a maintenance view.

```yaml
type: custom:fp300-range-card
entity: sensor.fp300_raw_fp300_a
applied_entity: sensor.fp300_applied_fp300_a
friendly_name: fp300_a
title: Sensore di presenza
simple: true
```

### Floor plan background

Use a picture **seen from above**: the floor plan of the room, a sketch to scale or a photo taken
from the ceiling. A photo taken from where the sensor sits does not work. The sensor does not see
a picture, it only measures distances, so in a front view a band does not match an area of the
frame.

Copy the picture to `/config/www/` and add:

```yaml
background:
  image: /local/floorplan.png
  width_m: 3.2      # real width covered by the picture, in metres
  sensor_x: 0.5     # where the sensor is in the picture: 0 = left edge, 1 = right edge
  sensor_y: 1       # 0 = top edge, 1 = bottom edge
  rotation: 0       # degrees clockwise, around the sensor
  opacity: 0.5
```

In the fan the sensor looks up. If it looks another way in your floor plan, use `rotation` to line
it up. Tune the values in the card editor: the preview updates while you type.

Files in `/config/www/` are served by Home Assistant **without login**. If your instance can be
reached from outside your home, use a sketch and not a detailed floor plan.

## 🔒 Security

- Anyone who can publish to `zigbee2mqtt/#` can change the bands or fake what the card shows.
  Protect the broker with users and ACLs.
- The MQTT user of Home Assistant needs to read `zigbee2mqtt/<name>` and
  `zigbee2mqtt/bridge/state`, to write `zigbee2mqtt/<name>/set` and `zigbee2mqtt/<name>/get`, and
  to read and write `fp300_range_card/#` if you use `applied_entity`.
