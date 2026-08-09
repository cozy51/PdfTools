#!/usr/bin/env python3
"""PDF Tools をローカルHTTPサーバーで配信し、ブラウザーで開く起動スクリプト。

このアプリは ES Modules と Web Worker を使うため、index.html を直接開くと
ブラウザーが CORS でスクリプトの読み込みを拒否し、操作できなくなります。
このスクリプト経由なら http://127.0.0.1:8000/ で配信されるため正常に動作します。

使い方:
    python3 serve.py [ポート番号]
"""

import http.server
import sys
import threading
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
HOST = "127.0.0.1"
DEFAULT_PORT = 8000
PORT_ATTEMPTS = 20


class Handler(http.server.SimpleHTTPRequestHandler):
    """このディレクトリを配信するハンドラー。"""

    # Windows ではレジストリ由来の MIME 設定で .js が text/plain になることがあり、
    # その場合モジュールの読み込みが失敗するため、拡張子の対応を明示しておく。
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".json": "application/json",
        ".css": "text/css",
        ".html": "text/html",
        ".svg": "image/svg+xml",
        ".webmanifest": "application/manifest+json",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        # 編集後のファイルが古いまま表示されないようにする。
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass  # アクセスログは表示しない


class Server(http.server.ThreadingHTTPServer):
    # Windows では SO_REUSEADDR が使用中のポートへの bind を許してしまい、
    # 空きポート検出が正しく動かないため無効にする。
    allow_reuse_address = False
    daemon_threads = True


def start_server(first_port):
    """空いているポートを探してサーバーを起動する。"""
    last_error = None
    for port in range(first_port, first_port + PORT_ATTEMPTS):
        try:
            return Server((HOST, port), Handler)
        except OSError as error:
            last_error = error
    raise SystemExit(
        f"ポート {first_port}〜{first_port + PORT_ATTEMPTS - 1} がすべて使用中のため"
        f"起動できませんでした（{last_error}）。"
    )


def parse_port(argv):
    if len(argv) < 2:
        return DEFAULT_PORT
    try:
        port = int(argv[1])
    except ValueError:
        raise SystemExit(f"ポート番号として解釈できません: {argv[1]}")
    if not 1 <= port <= 65535:
        raise SystemExit(f"ポート番号の範囲が不正です: {port}")
    return port


def main():
    if not (ROOT / "index.html").is_file():
        raise SystemExit(f"index.html が見つかりません: {ROOT}")

    server = start_server(parse_port(sys.argv))
    url = f"http://{HOST}:{server.server_address[1]}/"

    print("PDF Tools を起動しました。")
    print(f"  {url}")
    print("ブラウザーが自動で開きます。開かない場合は上のURLを開いてください。")
    print("終了するには Ctrl+C を押すか、このウィンドウを閉じてください。")

    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        opened = webbrowser.open(url)
    except (webbrowser.Error, OSError):
        opened = False
    if not opened:
        print("ブラウザーを自動で開けませんでした。上のURLを手動で開いてください。")

    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        print("\n終了します。")
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
