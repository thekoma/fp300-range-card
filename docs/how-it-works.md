# ⚙️ How it works

## The sensor

The FP300 has no 2D zones. It measures only the straight-line distance, and splits its field
(120°, about 6 m) into 24 rings of 0.25 m. Each ring, or band, can be switched on or off. The card
draws them as a fan seen from above.

In Zigbee2MQTT the bands are `detection_range_composite`, an object with the booleans
`detection_range_0` to `detection_range_23`. Band `i` covers `i × 0.25` m to `(i + 1) × 0.25` m.
`detection_range` is the same value as a 24-bit mask.

## What the card sends

- **Applica** publishes one message to `<base_topic>/<friendly_name>/set`, with
  `detection_range_composite` and all 24 bands. Zigbee2MQTT treats a missing band as off, so the
  card always sends all of them. No other setting is touched and `detection_range_prefix` is
  never written.
- Right after, the card asks for a read-back on `<base_topic>/<friendly_name>/get`. It waits in
  the queue behind the write. The goal is that one wake-up writes the bands and reports the real
  value. Whether Zigbee2MQTT delivers both in the same wake-up has to be checked on the device,
  see the [test checklist](testing.md).
- With `applied_entity` the card keeps what it applied on the retained topic
  `fp300_range_card/<friendly_name>/applied`, outside Zigbee2MQTT.
- **Avvia tracciamento** publishes `{"track_target_distance": "start_tracking_distance"}`. The
  sensor reports `target_distance` for a short while, then stops on its own.
- Nothing is ever published with `retain`, except the applied state.

## Why you have to press the button

The FP300 runs on batteries and sleeps. Zigbee2MQTT keeps a request in a queue until the sensor
wakes up: press the button on the FP300 once, without holding it. The queue expires after about
one hour, and the card shows how many minutes are left.

## What the card knows, and what it does not

The card can know only two things: that Home Assistant accepted the publish, and what Zigbee2MQTT
reports. Its messages say no more than that.

| Card says | What it means |
|---|---|
| "In attesa che il sensore si svegli" | The request was published. No state arrived after it yet. |
| "Zigbee2MQTT ha confermato la scrittura" | Zigbee2MQTT published the new state. This is an echo of what was written, not a read-back. |
| "Dopo la richiesta è arrivato un messaggio dal sensore" | A message arrived after **Rileggi dal sensore**, with the bands it reports. |
| "Fasce cambiate" | Zigbee2MQTT reports bands that differ from the ones applied. They were changed elsewhere, or the sensor went back on its own. |
| "Nessuna conferma da oltre un'ora" | The queued request has probably expired. Send it again. |

If the broker drops the message (for example because of ACLs), or Zigbee2MQTT restarts with a
request in the queue, the card stays "in attesa" until the request expires.

## Rules the card follows

- Nothing is sent until you press **Applica**. **Annulla** discards the draft.
- **Annulla** does not take back a request that is already queued. To take it back, apply the
  previous bands again.
- The card never shows made-up bands. If the sensor has not reported them yet, the fan stays empty
  and cannot be edited.
- The card does not apply an empty selection, because the effect of zero active bands on the
  sensor is not known.
- Without `applied_entity` the applied bands are saved in the browser. The "waiting" and "bands
  changed" notices then appear only on the device where you pressed **Applica**.
- The user interface is in Italian.

## Development

```sh
npm test                                        # logic tests, no dependencies (Node 22 or later)
python3 -m http.server 8765 --bind 127.0.0.1    # then open http://127.0.0.1:8765/demo/
```

The demo page fakes Home Assistant and Zigbee2MQTT. The buttons at the top wake the sensor, change
the reported bands, the distance and the presence, and take Zigbee2MQTT offline.
