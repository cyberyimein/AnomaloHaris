# Buddy CLI

The `buddy` command talks to the AnomaloHaris Buddy service using the same capability names as the Agent tools. The service checks the permissions configured on the Buddy dashboard.

Configure `BUDDY_SERVICE_URL` and `BUDDY_SERVICE_TOKEN`, or use the existing `ANOMALOHARIS_BUDDY_SERVICE_URL` and `ANOMALOHARIS_BUDDY_SERVICE_TOKEN` variables.

```sh
npm exec -- buddy status
npm exec -- buddy capabilities --json
npm exec -- buddy look left
npm exec -- buddy observe --direction center --out room.png
npm exec -- buddy invoke infrared.send --args '{"address":1,"data":2}' --json
```

`look` moves the head without taking a picture. `observe` moves the head and captures a fresh image. Use `--out` to write an image result to a file. `--json` prints structured output for scripts.
