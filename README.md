# JPGPanel

JPGPanel is the instance panel for Mirelia Cloud. It is kept as a separate
repository (`panels/JPGPanel`) and linked into the main workspace, so the panel
can be versioned and deployed independently of the cloud core.

## Packages

```text
server-instances  instance framework: types, specs, lifecycle, console, configuration, store integration
mc-instance       reference instance type: Minecraft servers (MCSM-scale configuration)
file-manager      file browser/editor, uploads and backups for every instance
backup            scheduled backups driven by each type's autoBackupHours setting
```

### `server-instances`

The framework owns everything that is the same for every kind of server:

* **Instance types** — plugins register an `InstanceTypeDefinition` through
  `ctx.component.instances.registerType(...)`: a catalogue `offer` with
  per-type options, plus `create`, `start`, `stop` and `destroy` hooks. Types may
  also mount their own JSON endpoints under `/api/instances/:id/type/*`.
* **Specifications** — site administrators define CPU, memory, disk and price
  per instance type under *Administration → Instance specifications*. Every
  enabled specification is published to the store automatically as an option of
  that type's product, so a purchase is priced by the specification that was picked.
* **Purchase → instance** — a paid store order is handed to the panel through
  `registerPurchaseHandler`, which creates the instance, allocates its directory
  under `data/instances/<id>` and records the project product.
* **Lifecycle and console** — start/stop run a supervised process owned by the
  instance type; stdout/stderr are kept in a bounded buffer and streamed to the
  browser over server-sent events, and console commands are written to stdin.
* **Configuration schema** — an instance type describes every knob as a JSON-Schema
  subset (`configSchema`). The panel renders the form generically, validates and merges
  values over defaults, stores them per instance and calls the type's `applyConfig`
  to write the files. Types may also intercept console commands and mount extra routes.
* **Files and downloads** — types declare the files they manage and remote sources
  (server jars, mods, plugins) the panel can fetch.
* **Activity log** — every create, configure, start and stop is recorded and shown
  on the instance page.

### `mc-instance`

A reference instance type that sells Minecraft servers, modelled on MCSM. It
supports Paper, Purpur, Fabric and vanilla jars (custom jars too), writes
`server.properties` from a schema with **59 settings across five sections**
(software and JVM, network and RCON, gameplay, world, panel runtime), gates
starting on the Minecraft EULA, and intercepts the `eula` console command.

### `file-manager`

Browser for the instance directory with folder creation, upload, rename, delete and
an editor for managed files. It also creates `tar.gz` backups (excluding backups
themselves), restores them after snapshotting the current state, and keeps the last
`backupKeep` archives.

### `backup`

Schedules backups: every `intervalMinutes` it looks for instances whose
`autoBackupHours` is set and asks the file manager to archive them.

## Configuration

```json
"@jpgpanel/server-instances": { "publicUrl": "http://localhost:3001", "terminalBufferLines": 500, "defaultGraceMs": 10000 },
"@jpgpanel/mc-instance": { "handshakeTimeoutMs": 180000 }
```

## Adding another instance type

Add `@jpgpanel/server-instances` as a dependency, then:

```ts
export const depend = ["instances"];

export async function apply(ctx: Context) {
  ctx.component.instances.registerType({
    id: "valheim", name: "Valheim server", pluginId: "valheim-instance",
    offer: { id: "valheim", name: "Valheim server", priceCents: 1500, spec: { cpu: 2, memoryMb: 4096 } },
    async create(request, provisioner) { /* write files, return { id, name, port } */ },
    async start(instance, provisioner) { provisioner.runtime.start(["./valheim_server", "-port", "2456"]); },
    async stop(instance, provisioner) { provisioner.runtime.write("quit"); },
    routes: [{ method: "GET", path: "world", async handle(session) { session.respond({ ok: true }, "json"); } }],
  });
}
```

A type-specific frontend panel is contributed through the dashboard slot named
`instance:<type id>`.
