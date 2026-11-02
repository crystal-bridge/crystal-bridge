# Several machines

This puts the hub on an always-on host, with a Crystal on each machine you run Claude Code on. The hub can sit on your
tailnet, or anywhere you can give it HTTPS. Every setting is in the [configuration reference](./CONFIGURATION.md).

## With Tailscale

The intended setup puts every machine on one [Tailscale](https://tailscale.com) tailnet, with the **Airship** on an
always-on host, published with `tailscale serve` (HTTPS), limited to your tailnet login (`AIRSHIP_ALLOWED_USERS`), with a
token per Kingdom (`AIRSHIP_NODES`).

Start the hub with the deploy script, which ships the pushed `main` over SSH. Run it from a clean checkout of `main`. The
hub host needs:

- Node 22+ and pnpm, installed where `sudo` and systemd find them, which rules out a per-user install such as nvm
- Passwordless `sudo` for your SSH user
- Tailscale, signed in, with HTTPS certificates allowed on the tailnet (the DNS page of its admin console)

```sh
scripts/deploy-airship.sh hub-host you@example.com    # first run sets the allowed tailnet login
```

That hub runs from git, so it names no version, and Kingdoms you add to it never update themselves or warn that they're
behind. To have them follow the hub, put it on a release first, with `scripts/deploy-airship-package.sh hub-host <version>`
([Moving onto packages](./OPERATIONS.md#moving-onto-packages)).

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
docker run -d --name crystal-bridge -p 7700:7700 -v crystal-bridge:/data ghcr.io/crystal-bridge/airship:0.6.0
docker logs crystal-bridge   # shows a one-time setup code
```

Put HTTPS in front of it (Caddy, nginx or a tunnel), because tokens travel in the clear without it. Then open the hub,
enter the code and make your login in the browser ([First run](./OPERATIONS.md#first-run)), and add Kingdoms from the
app as above. For a scripted setup, `crystal-bridge-airship token add <name>` still makes a login. The same hub runs
without Docker from the release's tarball, with `AIRSHIP_AUTH=token` and `AIRSHIP_DATA` set; see
[Running a packaged hub](./OPERATIONS.md#running-a-packaged-hub).

Whatever sits in front has to pass WebSocket upgrades on `/client` (browsers) and `/node` (Kingdoms), or the app loads and
never connects. Caddy's `reverse_proxy` does this by itself. With nginx, in the `http` block:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    server_name hub.example.com;
    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:7700;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

The hub marks its login cookie `Secure` only when `X-Forwarded-Proto` says `https`.

## Behind a proxy or TLS inspection

A work network can stand between a Kingdom and its hub. A Kingdom makes two kinds of connection, and they differ:

- **The hub link can't use a proxy.** It's a WebSocket through the `ws` library, which ignores `HTTP_PROXY` and
  `HTTPS_PROXY` whatever else is set. A Kingdom needs a direct route to its hub, such as a tailnet.
- **`join` and self-update use `fetch`**, which ignores those variables too unless Node's own proxy support is on:
  `NODE_USE_ENV_PROXY=1`, or `--use-env-proxy`, from Node 22.21, which Node marks as still in development.

Node trusts its own list of root certificates and, by default, not the Windows certificate store, so a proxy that
inspects TLS fails with an error such as "self-signed certificate in certificate chain". Node offers two ways out:
`NODE_EXTRA_CA_CERTS`, naming a PEM file of extra roots, or `--use-system-ca`, from Node 22.15, which adds the system's
store. A failed connection prints Node's reason, and `npx` itself has npm's own `proxy` and `cafile` settings.

Set these for the `join` command in its shell, and for the service as well. `crystal.env` isn't the place for
`NODE_USE_ENV_PROXY` or `NODE_EXTRA_CA_CERTS`: tried on Node 26, neither took effect from a file given to `--env-file`,
because Node reads them too early. `NODE_OPTIONS=--use-env-proxy` in `crystal.env`, with `HTTPS_PROXY` beside it, did.
On Windows, a user environment variable reaches the task from the next sign-in.
Nobody has tried this on a real inspected network yet, so the first such Kingdom is a test.

## Pushing Crystal over SSH

If you'd rather push Crystal out from a checkout over SSH, the deploy scripts do that too:

```sh
scripts/deploy-crystal.sh node-a-host node-a hub-host  # a Linux machine: <ssh-host> <node-id> <hub-ssh-host>
scripts/deploy-crystal-macos.sh my-mac hub-host        # the Mac you run it on
```

## Next

[Operations](./OPERATIONS.md) covers deploys that wait for running turns, rollbacks, backups, Web Push and monitoring.
Read the [security model](./SECURITY-MODEL.md) before exposing the hub beyond your own private network. If something
doesn't work, try [Troubleshooting](./TROUBLESHOOTING.md).
