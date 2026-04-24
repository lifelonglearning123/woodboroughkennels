"""Scrape all images from woodboroughkennels.co.uk into images/website/."""
import os
import re
import sys
import time
from pathlib import Path
from urllib.parse import urljoin, urlparse, unquote

import requests

BASE = "https://www.woodboroughkennels.co.uk"
OUT_DIR = Path(__file__).parent / "images" / "website"
OUT_DIR.mkdir(parents=True, exist_ok=True)

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
    ),
    "Referer": BASE + "/",
}

IMG_EXT_RE = re.compile(r"\.(jpe?g|png|gif|webp|svg|bmp|ico|avif)(?:\?|$)", re.I)
URL_RE = re.compile(r"https?://[^\s'\"<>()]+", re.I)


def discover_pages() -> list[str]:
    """Crawl one level from homepage to find all internal page URLs."""
    pages = {BASE + "/"}
    try:
        r = requests.get(BASE + "/", headers=HEADERS, timeout=20)
        if r.status_code == 200:
            for m in re.finditer(r"href=[\"']([^\"']+)[\"']", r.text, re.I):
                href = m.group(1)
                full = urljoin(BASE + "/", href)
                p = urlparse(full)
                if p.netloc.endswith("woodboroughkennels.co.uk") and not IMG_EXT_RE.search(full):
                    # strip query/fragment
                    clean = f"https://{p.netloc}{p.path}"
                    if not clean.endswith((".css", ".js", ".xml", ".pdf")):
                        pages.add(clean)
    except Exception as e:
        print(f"[!] discover error: {e}")
    return sorted(pages)


def extract_image_urls(html: str, page_url: str) -> set[str]:
    urls = set()
    for m in re.finditer(r"<img[^>]+src=[\"']([^\"']+)[\"']", html, re.I):
        urls.add(urljoin(page_url, m.group(1)))
    for m in re.finditer(r"srcset=[\"']([^\"']+)[\"']", html, re.I):
        for part in m.group(1).split(","):
            url = part.strip().split(" ")[0]
            if url:
                urls.add(urljoin(page_url, url))
    for m in re.finditer(r"url\((['\"]?)([^)'\"]+)\1\)", html, re.I):
        url = m.group(2).strip()
        if IMG_EXT_RE.search(url):
            urls.add(urljoin(page_url, url))
    for m in URL_RE.finditer(html):
        url = m.group(0).rstrip(".,);'\"")
        if IMG_EXT_RE.search(url):
            urls.add(url)
    for m in re.finditer(r"data-(?:src|original|lazy-src)=[\"']([^\"']+)[\"']", html, re.I):
        url = urljoin(page_url, m.group(1))
        if IMG_EXT_RE.search(url):
            urls.add(url)
    return urls


def safe_filename(url: str) -> str:
    parsed = urlparse(url)
    name = unquote(os.path.basename(parsed.path)) or "image"
    name = re.sub(r"[^A-Za-z0-9._-]", "_", name)
    if not IMG_EXT_RE.search(name):
        name += ".jpg"
    return name


def download_with_retry(url: str, attempts: int = 3) -> tuple[bytes | None, str]:
    last = ""
    for i in range(attempts):
        try:
            r = requests.get(url, headers=HEADERS, timeout=30)
            if r.status_code == 200 and r.content:
                return r.content, "ok"
            last = f"HTTP {r.status_code}"
        except Exception as e:
            last = type(e).__name__ + ": " + str(e)[:120]
        time.sleep(1.5 * (i + 1))
    return None, last


def main() -> int:
    pages = discover_pages()
    print(f"Discovered {len(pages)} internal pages:")
    for p in pages:
        print(f"  {p}")
    print()

    all_urls: set[str] = set()
    for url in pages:
        try:
            r = requests.get(url, headers=HEADERS, timeout=20)
        except Exception as e:
            print(f"[!] {url} -> {e}")
            continue
        if r.status_code != 200:
            print(f"[!] {url} -> HTTP {r.status_code}")
            continue
        found = extract_image_urls(r.text, url)
        print(f"[+] {url} -> {len(found)} image refs")
        all_urls.update(found)

    image_urls = {u for u in all_urls if IMG_EXT_RE.search(u)}
    print(f"\nTotal unique image URLs: {len(image_urls)}\n")

    downloaded, skipped, failed = 0, 0, 0
    seen_names: dict[str, int] = {}
    failures: list[tuple[str, str]] = []

    for url in sorted(image_urls):
        name = safe_filename(url)
        # Already-downloaded check by basename
        candidate = OUT_DIR / name
        if candidate.exists() and candidate.stat().st_size > 0:
            skipped += 1
            seen_names[name] = seen_names.get(name, 0)
            continue

        if name in seen_names:
            seen_names[name] += 1
            stem, ext = os.path.splitext(name)
            name = f"{stem}_{seen_names[name]}{ext}"
            candidate = OUT_DIR / name
        else:
            seen_names[name] = 0

        content, status = download_with_retry(url)
        if content:
            candidate.write_bytes(content)
            downloaded += 1
            print(f"    {name}  ({len(content)//1024} KB)")
        else:
            failed += 1
            failures.append((url, status))
            print(f"    [FAIL {status}] {url}")

    total_files = sum(1 for _ in OUT_DIR.iterdir())
    total_bytes = sum(p.stat().st_size for p in OUT_DIR.iterdir() if p.is_file())
    print(f"\nDownloaded: {downloaded}, skipped (already present): {skipped}, failed: {failed}")
    print(f"Total in {OUT_DIR}: {total_files} files, {total_bytes/1024/1024:.2f} MB")
    if failures:
        print("\nFailures:")
        for u, err in failures:
            print(f"  {err}: {u}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
