# Deploying the relay

The relay is one Node process (`server/index.js`) kept alive by pm2, behind any reverse proxy that terminates TLS.

```sh
# once, on the host
git clone https://github.com/Hemisphere-Project/Syntone.git /srv/apps/syntone
cd /srv/apps/syntone && deploy/update.sh

# afterwards, from a workstation, after pushing main
TARGET=user@host deploy/deploy.sh
```

## Reverse proxy

Phones need HTTPS, and the relay speaks WebSocket on `/ws`, so the proxy must pass the upgrade and must not time the socket out between pings (one per second). For nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:3002;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 120s;
    proxy_send_timeout 120s;
    proxy_buffering off;
}
```

Every proxy hop adds a little delay to each clock exchange, the same in both directions, so it costs latency but not sync. The later low-delay work (WebTransport) needs UDP 443 straight to the relay, which a plain HTTP reverse proxy does not carry.
