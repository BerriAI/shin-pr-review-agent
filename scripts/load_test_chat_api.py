#!/usr/bin/env python3
"""Load test POST /chat/api with a batch of PR URLs in parallel.

Required env:
    SERVER_URL   - base URL of the server (default: http://localhost:8081)
    BOT_API_KEY  - bearer token if BOT_API_KEYS is configured (optional)

Usage:
    python load_test_chat_api.py https://github.com/org/repo/pull/1 https://github.com/org/repo/pull/2 ...
    python load_test_chat_api.py --file pr_urls.txt
    python load_test_chat_api.py --concurrency 3 https://github.com/org/repo/pull/1 ...
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from dataclasses import dataclass, field
from typing import Optional


try:
    import aiohttp
except ImportError:
    print("Missing dependency: pip install aiohttp", file=sys.stderr)
    sys.exit(1)


SERVER_URL = os.environ.get("SERVER_URL", "http://localhost:8081").rstrip("/")
BOT_API_KEY = os.environ.get("BOT_API_KEY", "")


@dataclass
class Result:
    url: str
    status: int
    thread_id: Optional[str] = None
    output: Optional[str] = None
    error: Optional[str] = None
    elapsed_s: float = 0.0


async def review_one(
    session: aiohttp.ClientSession,
    pr_url: str,
    semaphore: asyncio.Semaphore,
) -> Result:
    headers = {"Content-Type": "application/json"}
    if BOT_API_KEY:
        headers["Authorization"] = f"Bearer {BOT_API_KEY}"

    payload = {
        "message": f"Review this PR: {pr_url}",
    }

    t0 = time.perf_counter()
    async with semaphore:
        try:
            async with session.post(
                f"{SERVER_URL}/chat/api",
                json=payload,
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=600),
            ) as resp:
                elapsed = time.perf_counter() - t0
                body = await resp.json(content_type=None)
                if resp.status == 200:
                    return Result(
                        url=pr_url,
                        status=resp.status,
                        thread_id=body.get("thread_id"),
                        output=body.get("output", "")[:300],
                        elapsed_s=elapsed,
                    )
                else:
                    return Result(
                        url=pr_url,
                        status=resp.status,
                        error=str(body),
                        elapsed_s=elapsed,
                    )
        except Exception as exc:
            elapsed = time.perf_counter() - t0
            return Result(url=pr_url, status=0, error=str(exc), elapsed_s=elapsed)


def print_result(r: Result, idx: int, total: int) -> None:
    ok = r.status == 200
    icon = "✓" if ok else "✗"
    print(f"\n[{idx}/{total}] {icon} {r.url}")
    print(f"    status={r.status}  elapsed={r.elapsed_s:.1f}s  thread={r.thread_id}")
    if r.error:
        print(f"    error: {r.error}")
    elif r.output:
        preview = r.output.replace("\n", " ")
        print(f"    output: {preview[:200]}")


async def run(urls: list[str], concurrency: int) -> None:
    semaphore = asyncio.Semaphore(concurrency)
    t_start = time.perf_counter()
    total = len(urls)

    print(f"Load test: {total} PRs  concurrency={concurrency}  server={SERVER_URL}")
    print("-" * 60)

    connector = aiohttp.TCPConnector(limit=concurrency + 2)
    async with aiohttp.ClientSession(connector=connector) as session:
        tasks = [review_one(session, url, semaphore) for url in urls]
        completed = 0
        results: list[Result] = []
        for coro in asyncio.as_completed(tasks):
            r = await coro
            completed += 1
            results.append(r)
            print_result(r, completed, total)

    wall = time.perf_counter() - t_start
    ok = [r for r in results if r.status == 200]
    fail = [r for r in results if r.status != 200]
    avg = sum(r.elapsed_s for r in results) / len(results) if results else 0

    print("\n" + "=" * 60)
    print(f"Done in {wall:.1f}s  |  {len(ok)} ok  {len(fail)} failed  |  avg {avg:.1f}s/PR")
    if fail:
        print("Failed:")
        for r in fail:
            print(f"  {r.url}  [{r.status}] {r.error}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Load test /chat/api with multiple PRs")
    parser.add_argument("urls", nargs="*", help="PR URLs to review")
    parser.add_argument("--file", "-f", help="Text file with one PR URL per line")
    parser.add_argument("--concurrency", "-c", type=int, default=5, help="Max parallel requests (default 5)")
    args = parser.parse_args()

    urls: list[str] = list(args.urls)
    if args.file:
        with open(args.file) as fh:
            for line in fh:
                line = line.strip()
                if line and not line.startswith("#"):
                    urls.append(line)

    if not urls:
        parser.error("Provide PR URLs as args or via --file")

    asyncio.run(run(urls, args.concurrency))


if __name__ == "__main__":
    main()
