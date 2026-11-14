"""Checks which Lab Shop pages answer, and prints one line per page."""
import urllib.request

BASE = "http://shop.lab.localhost:4420"
for path in ["/", "/login", "/search?q=mug", "/help/contact", "/sitemap.xml", "/nope"]:
    try:
        with urllib.request.urlopen(BASE + path, timeout=5) as r:
            print(f"GET {path} -> {r.status}")
    except Exception as e:  # noqa: BLE001
        print(f"GET {path} -> {getattr(e, 'code', 'error')}")
