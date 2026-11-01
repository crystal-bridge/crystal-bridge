# Several machines

This puts the hub on an always-on host, with a Crystal on each machine you run Claude Code on. The hub can sit on your
tailnet, or anywhere you can give it HTTPS. Every setting is in the [configuration reference](./CONFIGURATION.md).

## With Tailscale

The intended setup puts every machine on one [Tailscale](https://tailscale.com) tailnet, with the **Airship** on an
always-on host, published with `tailscale serve` (HTTPS), limited to your tailnet login (`AIRSHIP_ALLOWED_USERS`), with a
token per Kingdom (`AIRSHIP_NODES`).

Start the hub with the deploy script, which ships the pushed `main` over SSH:

```sh
scripts/deploy-airship.sh hub-host you@example.com    # first run sets the allowed tailnet login
```

Then add each machine from the app: open **Config**, name the new Kingdom under **Add Kingdom**, and run the command it
gives you on that machine. It needs Node 22+ and Claude Code signed in, and only outbound HTTPS: no SSH or inbound
ports. On Linux it asks for sudo once, so the Kingdom keeps running after you log out. To remove a Kingdom, use **Remove**
on its Castle, then run the command it shows on that machine. Its Quests stay as history unless you then choose
**Forget** there. Linux, macOS and Windows are supported.

On Windows, also install [Git for Windows](https://git-scm.com/downloads/win). Run the command as the user who signed
in to Claude Code, with no administrator needed. If PowerShell says running scripts is disabled, run it in Command
Prompt, or first allow scripts for your user with `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`. A Windows
Kingdom runs while that user is signed in, and starts again at each sign-in.

## Without Tailscale

The hub also comes as a container with its own login:

```sh
docker run -d --name crystal-bridge -p 7700:7700 -v crystal-bridge:/data ghcr.io/crystal-bridge/airship:0.4.0
docker logs crystal-bridge   # shows a one-time setup code
```

Put HTTPS in front of it (Caddy, nginx or a tunnel), because tokens travel in the clear without it. Then open the hub,
enter the code and make your login in the browser ([First run](./OPERATIONS.md#first-run)), and add Kingdoms from the
app as above. For a scripted setup, `crystal-bridge-airship token add <name>` still makes a login. The same hub runs
without Docker from the release's tarball, with `AIRSHIP_AUTH=token` and `AIRSHIP_DATA` set; see
[Running a packaged hub](./OPERATIONS.md#running-a-packaged-hub).

## Pushing Crystal over SSH

If you'd rather push Crystal out from a checkout over SSH, the deploy scripts do that too:

```sh
scripts/deploy-crystal.sh node-a-host node-a hub-host  # a Linux machine: <ssh-host> <node-id> <hub-ssh-host>
scripts/deploy-crystal-macos.sh my-mac hub-host        # the Mac you run it on
```

## Next

[Operations](./OPERATIONS.md) covers deploys that wait for running turns, rollbacks, backups, Web Push and monitoring.
Read the [security model](./SECURITY-MODEL.md) before exposing the hub beyond your own private network.
