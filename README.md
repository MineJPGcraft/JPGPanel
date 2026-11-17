# JPGPanel

JPGPanel is the instance panel for Mirelia Cloud. It is kept as a separate
repository (`panels/JPGPanel`) and linked into the main workspace, so the panel
can be versioned and deployed independently of the cloud core.

Every instance is a Docker container. The panel owns containers, ports, folders,
files, consoles and terminals; plugins only contribute small UI components.

## Packages

```text
server-instances  the platform: types, groups, presets, specs, Docker lifecycle, store
mc-instance       two panels for Minecraft servers: online players and server.properties
file-manager      file browser/editor, uploads and backups for every instance
backup            scheduled backups driven by an instance parameter
```

## Five levels

```
type     what a plugin can host: mc, shell          (declared by the platform/plugins)
 └ group   a screen an administrator names, e.g. "MC服务器"
    └ preset one runnable program: Paper, Purpur, Terraria …   (image, ports, mounts, files)
       └ spec   compute and price only: 2 vCPU / 4 GB / ¥20   (combinable with any preset)
          └ instance  created by a purchase
```

* **Group** — must belong to a type; it is the heading the store groups cards under.
* **Preset** — belongs to exactly one group. It describes the container: image and pull
  policy, command, environment, ports, mounts, pre-copied files, health check, stop
  behaviour and restart policy. This is what makes "Paper" and "Purpur" separate products
  even though they share a family.
* **Specification** — deliberately has no type, group or image. Any preset can offer any
  spec, which is what lets buyers combine freely.

## Preset parameters

A preset carries a list of parameters. The same field definition (`string`, `number`,
`boolean`, `enum`, `array`) is used in three places:

| Where | Scope | Purpose |
| --- | --- | --- |
| Environment | fixed | written into the container env, `{{name}}` expands it |
| Pre-copied files | fixed | rendered into files before the container is created |
| Purchase options | `purchase` | the buyer picks a value; it becomes an instance parameter and an env var |

Placeholders available in commands, env values, mount paths, file targets and contents:
`{{param}}`, `{{port:<name>}}`, `{{instanceId}}`, `{{projectId}}`, `{{name}}`.

Administrators add or remove parameters freely; a preset without purchase options simply
sells its defaults.

## Provisioning

```
purchase → instance id → folder data/instances/<id> → allocate host ports (auto or fixed)
        → pre-copy files → docker create (mounts, env, port bindings, CPU/memory limits)
        → docker start → health check (none / tcp / http / log) → running
```

If any step fails the instance is marked `failed`, the reason is stored and the order
line is refunded. Stopping sends the preset's stop signal (default `SIGTERM`) and the
restart policy decides whether Docker brings it back.

The terminal attaches to `docker exec` over a hijacked connection, so full-screen
programs work. The console page tails `docker logs`. The file manager edits the mounted
folders on the host directly.

## Configuration

```json
"@jpgpanel/server-instances": {
  "dockerSocket": "/var/run/docker.sock",
  "dataDir": "./data/instances",
  "portRangeStart": 30000,
  "portRangeEnd": 30999,
  "healthTimeoutSeconds": 180,
  "pullOnCreate": true
}
```

The panel needs a reachable Docker daemon. When it is unreachable the instance catalog
still works and purchases fail with a refund, so presets can be prepared before the host
is ready.

## Administration

*Administration → Instance catalog* has three sections: groups, presets and
specifications. Create a spec once, then reference it from any number of presets.

## Minecraft panels

`mc-instance` registers no type and installs nothing. It contributes two components to
the `instance:mc` slot, shown under *Instance → Type tools*:

* **Online players** — runs `list` in the container and parses the answer.
* **Server settings** — a searchable form over `server.properties` served by the panel.
