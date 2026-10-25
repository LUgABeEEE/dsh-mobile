# Own HTTPS reverse proxy

[中文指南](SELF_HOSTED_ORIGIN.md)

> This provider ships from **0.4.2** onward.

This guide covers the default **external proxy** mode, where you manage public HTTPS. On Windows/Linux x64, you can instead choose [Managed Caddy](CADDY_MANAGED.en.md) in the same panel; it requires Tencent Cloud DNSPod credentials and public HTTPS ingress to the computer, and does not traverse CGNAT. The two modes have separate configuration and readiness checks.

## When to use it

Use an existing Lucky, Nginx or Caddy HTTPS proxy rather than a tunnel. Under **Mobile Access → Remote → Self-hosted connection → Own reverse proxy**, DSH Mobile creates a separate private HTTP backend with device authentication:

```text
phone → https://phone.example.com:8815 (your proxy terminates TLS)
      → http://192.168.50.10:3444 (private Mobile backend)
      → current DSH WebServer
```

Only the public HTTPS proxy may face the Internet. **Never port-forward the HTTP backend**, proxy directly to ordinary DSH (default 3080), or reuse the LAN HTTPS gateway (default 3443). HTTP between separate machines is suitable only for a trusted private network.

The backend still enforces device pairing, exact normalized Host/Origin, CSRF, Secure Cookies and WebSocket path policy. Do not test it by opening the private HTTP address in a browser: that has the wrong Host and may break authentication. The operator owns public TLS, renewal, DNS, routing and firewall rules; the plugin does not configure or probe the public route.

## Four settings

Replace these examples with your own addresses:

| Field | Proxy on the DSH computer | Proxy on another private-network host |
| --- | --- | --- |
| Public HTTPS origin | `https://phone.example.com:8815` | `https://phone.example.com:8815` |
| Private listen IP | `127.0.0.1` or `::1` | DSH computer's private address, e.g. `192.168.50.10` or `fd12:3456:789a::10` |
| HTTP backend port | `3444` | `3444` |
| Allowed proxy source CIDR | `127.0.0.0/8` for IPv4; `::1/128` for IPv6 | Actual proxy source, e.g. `192.168.50.1/32` or `fd12:3456:789a::1/128` |

The public origin must be HTTPS and may include a custom port, but no path, credentials, query or fragment. Domains may use A/AAAA records for IPv4, IPv6 or dual-stack access. Private/reserved addresses, local names and IPv6 literals are rejected in the public-origin field.

Bind to an explicit loopback, RFC1918 IPv4 or IPv6 ULA (`fc00::/7`) already assigned to the DSH computer. Enter IPv6 as a bare address such as `::1`, without brackets, port or zone ID; displayed backend URLs add the required brackets, e.g. `http://[::1]:3444`. Wildcards `0.0.0.0`/`::`, hostnames, public IPs and IPv6 link-local addresses are rejected. Choose an unused integer port from 1024–65535, excluding reserved 3080 and 3443. Default 3444 is also the named-cloudflared forward port: only one remote provider runs at a time, but verify the port is released during a switch.

CIDRs match the proxy's **direct TCP peer**, not the phone or `X-Forwarded-For` / `X-Real-IP` / `Forwarded`. Docker or NAT may change that peer. Prefer an actual single-host IPv4 /32 or IPv6 /128. Up to 16 private/loopback CIDRs are accepted, separated by spaces or commas; each must use the listener's IP family and have no host bits set. Explicit private proxy sources are required for a private-network bind; `::/0` is rejected.

Phones behind a proxy may share that direct peer. From plugin 0.6.12, invalid credentials still share its failure budget, but anonymous failures cannot exhaust a valid one-time pairing secret's admission. Authenticated renewals and probes have per-device limits and bounded pending work. Adding or trusting forwarded-IP headers is unnecessary. For `429 rate_limited` on older versions, update the plugin while retaining pairings; do not widen source CIDRs or expose the ordinary DSH listener.

Select **Save and start backend**. An active backend reloads its settings. The panel separates the public HTTPS origin from the actual listening HTTP backend; saved settings remain visible after stopping.

## Proxy requirements, including Lucky

1. Terminate public TLS with a trusted certificate. Never ask the phone to ignore a public certificate error.
2. Point the proxy at the displayed private HTTP backend, not the phone's public HTTPS address.
3. Preserve the external **Host including non-default port**: the example requires `phone.example.com:8815`, not the private target or a hostname without its port.
4. Preserve Origin, Cookie, Set-Cookie and authentication/CSRF headers. Do not rewrite Cookie domain/security attributes or cache authentication responses.
5. Forward HTTP/1.1 WebSocket upgrades and bidirectional data. The existing WebSocket path allowlist keeps applying; when a third-party plugin needs its own path, approve it separately in diagnostics.

[Lucky's official Web documentation](https://www.lucky666.cn/docs/modules/web/) describes WebSocket support. UI labels vary by version, but this backend requires the incoming external Host. Do not enable target-address Host; if a version offers custom Host, provide the full public hostname and port. Certificates belong on Lucky, not this HTTP backend.

For a separate proxy host, configure routing and a firewall rule limited to its actual private source yourself. This provider does not change the firewall.

### Nginx and IPv6

The phone's public IPv6 connection to Nginx and Nginx's HTTP connection to DSH Mobile are separate connections. **An IPv6 public entry does not require an IPv6 backend.** On the same computer, Nginx can accept public IPv6 and forward to `http://127.0.0.1:3444`; the source CIDR remains IPv4 loopback. For an explicit `::1` backend, use `http://[::1]:3444` and `::1/128` instead.

In an existing Nginx HTTPS site with its certificate configured, preserve the external Host and WebSocket upgrade headers:

```nginx
# In the http block; reuse an existing map when already defined.
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

# In the corresponding HTTPS server block.
location / {
    proxy_pass http://127.0.0.1:3444;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_buffering off;
}
```

`$http_host` preserves a non-default port from the phone's request; do not replace it with the backend address. See [Nginx WebSocket documentation](https://nginx.org/en/docs/http/websocket.html) and [request-header settings](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header). You still configure public AAAA records, the Nginx IPv6 HTTPS listener, certificates and firewall.

When Nginx and DSH run on separate machines connected only through the Internet, do not expose this plain HTTP backend publicly. Establish a trusted private/VPN link first, then use its private IPv4/ULA address and the proxy's actual source CIDR. A public IPv6 address alone does not provide that private link.

## State and phone verification

**Backend listening proves the local listener only, not public HTTPS, certificates or WebSocket connectivity.** External-proxy diagnostics do not probe the public origin.

Generate a remote pairing QR code and use **Remote access** in Android app **0.4.0 or later**, not Local network. A publicly trusted origin also supports mobile-browser pairing. Verify from the intended external network:

- The hostname, public port and trusted certificate are correct.
- Pairing and DSH login succeed.
- A live conversation or other real-time operation keeps WebSockets working.
- Stopping the backend disables this remote entry without affecting LAN access.

Local real-socket HTTPS/HTTP/WebSocket tests do not replace your own proxy and phone acceptance.

## Stop, remove settings or reset devices

| Action | Result |
| --- | --- |
| Disable remote access | Stops the backend; keeps settings and paired devices |
| Clear proxy settings, after confirmation | Stops this backend and deletes its settings; keeps remote pairings, LAN and other provider settings |
| Reset remote devices, after confirmation | Clears shared remote authorizations; remote devices must pair again, while proxy settings and LAN devices remain |
| Switch provider | Stops the previous remote provider; LAN is unaffected |

Under the default `$DSH_HOME/mobile-access/` root, settings are in `remote/origin/config/settings.json`, enabled state in `remote/origin/control.json`, and remote devices in shared `remote/devices.json`. Normal shutdown retains settings; only the selected, enabled provider resumes after DSH restarts.

## Troubleshooting

| Symptom | First check |
| --- | --- |
| Port occupied | Choose an unused backend port and update the proxy target |
| Listen address unavailable | Use loopback, private IPv4 or ULA assigned to the DSH computer, not the proxy host; public IPv6 access does not imply a local ULA exists |
| Refused / HTTP 403 | Verify direct source CIDR, full external Host and HTTPS Origin; forwarded headers cannot bypass them |
| Page works but real-time operations fail | Check WebSocket forwarding, timeout and approved paths without disabling trust checks |
| Only Backend listening | Expected local state; verify public DNS, HTTPS routing, certificate and actual phone access |
