"""`python -m splat_studio` — start the studio and open it in the browser."""

import argparse
import threading
import webbrowser

import uvicorn


def main():
    ap = argparse.ArgumentParser(description="OneOff Splat Studio")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    if not args.no_browser:
        threading.Timer(
            1.0, webbrowser.open, args=(f"http://{args.host}:{args.port}",)
        ).start()
    uvicorn.run("splat_studio.server:app", host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
