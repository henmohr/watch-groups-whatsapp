#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


APP_ID = os.environ.get("APP_ID", "watchgroups")
APP_PORT = int(os.environ.get("APP_PORT", "8000"))
APP_HOST = os.environ.get("APP_HOST", "0.0.0.0")
APP_DISPLAY_NAME = os.environ.get("APP_DISPLAY_NAME", "Watch Groups WhatsApp")
APP_VERSION = os.environ.get("APP_VERSION", "0.1.0")
APP_SECRET = os.environ.get("APP_SECRET", "")
NEXTCLOUD_URL = os.environ.get("NEXTCLOUD_URL", "").rstrip("/")
PERSISTENT_STORAGE = Path(os.environ.get("APP_PERSISTENT_STORAGE", "/tmp/watchgroups"))
TOP_MENU_NAME = "watchgroups-dashboard"
ICON_SVG = """<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\" role=\"img\" aria-label=\"Watch Groups\">
  <defs>
    <linearGradient id=\"g\" x1=\"0%\" y1=\"0%\" x2=\"100%\" y2=\"100%\">
      <stop offset=\"0%\" stop-color=\"#22c55e\"/>
      <stop offset=\"100%\" stop-color=\"#0f172a\"/>
    </linearGradient>
  </defs>
  <rect width=\"64\" height=\"64\" rx=\"16\" fill=\"url(#g)\"/>
  <path d=\"M18 22h28a4 4 0 0 1 4 4v12a4 4 0 0 1-4 4H30l-10 8v-8h-2a4 4 0 0 1-4-4V26a4 4 0 0 1 4-4z\" fill=\"rgba(15,23,42,.92)\"/>
  <circle cx=\"26\" cy=\"32\" r=\"3\" fill=\"#e5e7eb\"/>
  <circle cx=\"32\" cy=\"32\" r=\"3\" fill=\"#e5e7eb\" opacity=\".85\"/>
  <circle cx=\"38\" cy=\"32\" r=\"3\" fill=\"#e5e7eb\" opacity=\".7\"/>
</svg>
"""


class Handler(BaseHTTPRequestHandler):
    server_version = "WatchGroupsExApp/1.0"

    def _send_json(self, status: int, payload: dict) -> None:
        data = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_text(self, status: int, text: str) -> None:
        data = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format: str, *args) -> None:  # noqa: A003
        print(f"{self.address_string()} - {format % args}")

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/heartbeat":
            self._send_text(200, "ok")
            return

        if self.path == "/img/icon.svg":
            data = ICON_SVG.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "image/svg+xml; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        if self.path == "/":
            self._send_text(200, render_dashboard())
            return

        self._send_text(404, "not found")

    def do_POST(self) -> None:  # noqa: N802
        if self.path == "/init":
            PERSISTENT_STORAGE.mkdir(parents=True, exist_ok=True)
            state_file = PERSISTENT_STORAGE / "state.json"
            state_file.write_text(
                json.dumps(
                    {
                        "appId": APP_ID,
                        "displayName": APP_DISPLAY_NAME,
                        "version": APP_VERSION,
                        "appSecretPresent": bool(APP_SECRET),
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )
            self._send_json(200, {"status": "initialized"})
            return

        self._send_text(404, "not found")

    def do_PUT(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/enabled":
            query = urllib.parse.parse_qs(parsed.query)
            enabled = query.get("enabled", ["1"])[0] not in {"0", "false", "False"}

            try:
                if enabled:
                    self.register_top_menu()
                    self._send_json(200, {"status": "enabled"})
                else:
                    self.unregister_top_menu()
                    self._send_json(200, {"status": "disabled"})
            except Exception as exc:  # noqa: BLE001
                self._send_json(500, {"status": "error", "error": str(exc)})
            return

        self._send_text(404, "not found")

    def register_top_menu(self) -> None:
        if not NEXTCLOUD_URL:
            raise RuntimeError("NEXTCLOUD_URL not configured")

        self._post_nextcloud(
            "/ocs/v2.php/apps/app_api/api/v1/ui/top-menu",
            {
                "name": TOP_MENU_NAME,
                "displayName": APP_DISPLAY_NAME,
                "icon": "img/icon.svg",
                "adminRequired": "0",
            },
        )

    def unregister_top_menu(self) -> None:
        if not NEXTCLOUD_URL:
            raise RuntimeError("NEXTCLOUD_URL not configured")

        self._delete_nextcloud(
            "/ocs/v2.php/apps/app_api/api/v1/ui/top-menu",
            {
                "name": TOP_MENU_NAME,
            },
        )

    def _post_nextcloud(self, path: str, payload: dict) -> None:
        self._request_nextcloud("POST", path, payload)

    def _delete_nextcloud(self, path: str, payload: dict) -> None:
        self._request_nextcloud("DELETE", path, payload)

    def _request_nextcloud(self, method: str, path: str, payload: dict) -> None:
        headers = self._appapi_headers()
        headers["OCS-APIRequest"] = "true"
        headers["Content-Type"] = "application/json"

        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            f"{NEXTCLOUD_URL}{path}",
            data=data,
            headers=headers,
            method=method,
        )

        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                if response.status >= 400:
                    raise RuntimeError(f"Nextcloud returned HTTP {response.status}")
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Nextcloud returned HTTP {error.code}: {body}") from error
        except urllib.error.URLError as error:
            raise RuntimeError(f"Failed to contact Nextcloud: {error}") from error

    def _appapi_headers(self) -> dict[str, str]:
        auth = self.headers.get("AUTHORIZATION-APP-API", "")
        aa_version = self.headers.get("AA-VERSION", "1")
        ex_app_id = self.headers.get("EX-APP-ID", APP_ID)
        ex_app_version = self.headers.get("EX-APP-VERSION", APP_VERSION)

        if not auth:
            raise RuntimeError("Missing AUTHORIZATION-APP-API header")

        return {
            "AA-VERSION": aa_version,
            "EX-APP-ID": ex_app_id,
            "EX-APP-VERSION": ex_app_version,
            "AUTHORIZATION-APP-API": auth,
        }


def main() -> None:
    PERSISTENT_STORAGE.mkdir(parents=True, exist_ok=True)
    print(f"Starting {APP_ID} on {APP_HOST}:{APP_PORT}")
    server = ThreadingHTTPServer((APP_HOST, APP_PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def render_dashboard() -> str:
    return f"""<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{APP_DISPLAY_NAME}</title>
  <style>
    :root {{
      color-scheme: dark;
      --bg: #0f172a;
      --panel: #111827;
      --panel-2: #1f2937;
      --text: #e5e7eb;
      --muted: #9ca3af;
      --accent: #22c55e;
      --border: #334155;
      --warning: #f59e0b;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: radial-gradient(circle at top, #1e293b, var(--bg) 45%);
      color: var(--text);
    }}
    .wrap {{ max-width: 1200px; margin: 0 auto; padding: 32px 20px 48px; }}
    header {{ display: flex; justify-content: space-between; gap: 16px; align-items: end; flex-wrap: wrap; }}
    h1 {{ margin: 0; font-size: 28px; }}
    .sub {{ color: var(--muted); margin-top: 8px; }}
    .pill {{
      display: inline-flex; align-items: center; gap: 8px;
      padding: 8px 12px; border-radius: 999px;
      background: rgba(17,24,39,.7); border: 1px solid var(--border);
      font-size: 14px;
    }}
    .dot {{ width: 10px; height: 10px; border-radius: 50%; background: var(--warning); }}
    .dot.open {{ background: var(--accent); }}
    .grid {{ display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 16px; margin-top: 24px; }}
    .card {{
      background: rgba(17,24,39,.88);
      border: 1px solid rgba(51,65,85,.9);
      border-radius: 20px;
      padding: 18px;
      box-shadow: 0 20px 40px rgba(0,0,0,.2);
    }}
    .span-4 {{ grid-column: span 4; }}
    .span-12 {{ grid-column: span 12; }}
    .label {{ color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }}
    .value {{ font-size: 18px; margin-top: 8px; }}
    .group-list {{ display: grid; gap: 12px; }}
    .group {{
      background: rgba(31,41,55,.7);
      border: 1px solid rgba(51,65,85,.9);
      border-radius: 16px;
      padding: 16px;
    }}
    .group h3 {{ margin: 0 0 8px; font-size: 18px; }}
    .meta {{ color: var(--muted); font-size: 13px; display: flex; flex-wrap: wrap; gap: 12px; }}
    .summary {{ white-space: pre-wrap; margin-top: 12px; line-height: 1.55; color: #dbe4ee; }}
    .messages {{ display: grid; gap: 8px; margin-top: 12px; }}
    .msg {{ padding: 10px 12px; background: rgba(15,23,42,.85); border-radius: 12px; border: 1px solid rgba(51,65,85,.75); }}
    .msg small {{ color: var(--muted); display: block; margin-bottom: 4px; }}
    @media (max-width: 900px) {{
      .span-4 {{ grid-column: span 12; }}
    }}
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <div>
        <h1>{APP_DISPLAY_NAME}</h1>
        <div class="sub">Dashboard do monitoramento de grupos do WhatsApp.</div>
      </div>
      <div class="pill"><span class="dot" id="statusDot"></span><span id="status">loading</span></div>
    </header>

    <section class="grid">
      <div class="card span-4">
        <div class="label">Grupos acompanhados</div>
        <div class="value" id="watchedCount">0</div>
      </div>
      <div class="card span-4">
        <div class="label">Resumos prontos</div>
        <div class="value" id="summaryCount">0</div>
      </div>
      <div class="card span-4">
        <div class="label">Última atualização</div>
        <div class="value" id="updatedAt">-</div>
      </div>

      <div class="card span-12">
        <div class="label">Grupos</div>
        <div class="group-list" id="groups"></div>
      </div>
    </section>
  </div>

  <script>
    async function refresh() {{
      const res = await fetch('api/state');
      const data = await res.json();
      document.getElementById('status').textContent = data.connectionStatus;
      document.getElementById('statusDot').className = 'dot ' + (data.connectionStatus === 'open' ? 'open' : '');
      document.getElementById('watchedCount').textContent = data.watchedCount;
      document.getElementById('summaryCount').textContent = data.groups.filter(g => g.latestSummary).length;
      document.getElementById('updatedAt').textContent = new Date(data.generatedAt).toLocaleString('pt-BR');

      const container = document.getElementById('groups');
      container.innerHTML = '';
      if (!data.groups.length) {{
        container.innerHTML = '<div class="group">Nenhum grupo carregado ainda. Aguarde a conexão com o WhatsApp.</div>';
        return;
      }}

      data.groups.forEach((group) => {{
        const el = document.createElement('div');
        el.className = 'group';
        const summaryText = group.latestSummary ? escapeHtml(group.latestSummary.preview) : 'Sem resumo ainda.';
        const messagesHtml = group.recentMessages.slice().reverse().map((msg) => {{
          return '<div class="msg">' +
            '<small>' + escapeHtml(msg.ts + ' · ' + (msg.senderName || msg.sender || 'unknown')) + '</small>' +
            '<div>' + escapeHtml(msg.text || '[sem texto]') + '</div>' +
          '</div>';
        }}).join('');
        el.innerHTML =
          '<h3>' + escapeHtml(group.subject) + '</h3>' +
          '<div class="meta">' +
            '<span>ID: ' + escapeHtml(group.id) + '</span>' +
            '<span>Mensagens recentes: ' + group.recentMessages.length + '</span>' +
            '<span>Resumo: ' + (group.latestSummary ? 'sim' : 'não') + '</span>' +
          '</div>' +
          '<div class="summary">' + summaryText + '</div>' +
          '<div class="messages">' + messagesHtml + '</div>';
        container.appendChild(el);
      }});
    }}

    function escapeHtml(value) {{
      return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }}

    refresh();
    setInterval(refresh, 5000);
  </script>
</body>
</html>"""


if __name__ == "__main__":
    main()
