# ✅ Manual test checklist

To see what goes through MQTT, keep a terminal listening:

```sh
mosquitto_sub -h <broker> -u <user> -P <password> -v \
  -t 'zigbee2mqtt/<name>/#' -t 'zigbee2mqtt/bridge/logging' -t 'fp300_range_card/#'
```

Or use **Settings → Devices & services → MQTT → Configure → Listen to a topic**.

## Reading

- [ ] The card shows the bands that Zigbee2MQTT reports in `detection_range_composite`, and the
      sentence under the fan describes them correctly.
- [ ] The presence state changes when you walk in and out of the field.
- [ ] The card works in the light and in the dark theme.
- [ ] On a phone there is no horizontal scrolling and the buttons are easy to hit.

## Draft

- [ ] Move the limit with − and +, then tap a band in "Scegli le singole fasce". The sentence
      becomes "Bozza: …" and the card asks you to press **Applica**.
- [ ] Nothing changed in Zigbee2MQTT and no message went through MQTT.
- [ ] **Annulla** brings the bands back.
- [ ] With every band off, **Applica** stays disabled.

## The change really reaches the sensor

- [ ] Write down the value of `detection_range_prefix` in Zigbee2MQTT.
- [ ] Set "Solo fino a 2 m" and press **Applica**. The card shows "In attesa che il sensore si
      svegli: premi il pulsante sull'FP300", with the minutes left, and the changed bands are
      dashed.
- [ ] MQTT shows one message on `…/set` that holds only `detection_range_composite` with 24 keys,
      one on `…/get`, and with `applied_entity` one on `fp300_range_card/<name>/applied`.
- [ ] Open the same dashboard on a second device. With `applied_entity` it shows the same wait.
- [ ] Press the button on the FP300. Within a few seconds the card says "Zigbee2MQTT ha confermato
      la scrittura".
- [ ] In the Zigbee2MQTT log (`zigbee2mqtt/bridge/logging`) check that the attribute read went
      out after the write, in the same wake-up. If it did not, the check needs a second wake-up
      with **Rileggi dal sensore**.
- [ ] In Zigbee2MQTT `detection_range` is `255` (the first 8 bands) and `detection_range_prefix`
      did not change.
- [ ] Press **Rileggi dal sensore** and then the button on the FP300. The card says "Dopo la
      richiesta è arrivato un messaggio dal sensore" with the bands from 0 to 2 m, and "Fasce
      cambiate" does not appear.
- [ ] Physical test: stand at about 1 m, presence turns on. Leave, wait until it clears, then
      stand still at about 4 m, outside the active bands: presence stays off. To rule out the PIR
      sensor, first set `presence_detection_options` to `mmwave` in Zigbee2MQTT.

## Bands changed

- [ ] After a confirmed write, publish different bands from another client, then wake the sensor:

      ```sh
      mosquitto_pub -h <broker> -u <user> -P <password> \
        -t 'zigbee2mqtt/<name>/set' -m '{"detection_range": 65535}'
      ```

      The card shows "Fasce cambiate", says which ones, and marks them with a dotted border.
- [ ] **Rimanda le mie fasce** queues the applied bands again. **Tieni quelle del sensore** closes
      the notice.
- [ ] The next day press **Rileggi dal sensore** and wake the sensor, to see whether the settings
      went back on their own.

## Tracking

- [ ] Press **Avvia tracciamento** and then the button on the FP300. The distance updates, the arc
      moves and the band you stand in is highlighted.
- [ ] When tracking stops, the value stays with the note "ultimo valore, misura non in corso".

## Errors

- [ ] Stop Zigbee2MQTT. After a few seconds the card says "Il sensore non risponde", the fan
      empties and the controls are disabled.
- [ ] With an `entity` that does not exist the card says "Entità … non trovata", with no errors in
      the console.
- [ ] Reload the page while a request is waiting: the notice is still there.
