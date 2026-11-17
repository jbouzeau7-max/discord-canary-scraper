"""
Cog Discord.py — multi-dispatch GitHub Actions
cogs/canary_trigger.py

  await bot.load_extension("cogs.canary_trigger")

Sécurité :
  - Ne JAMAIS committer de PAT dans ce fichier.
  - GITHUB_TOKEN / GH_TOKEN uniquement via variable d'environnement.
  - Si un token a fuité : le révoquer immédiatement sur GitHub.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import socket
import time
import urllib.error
import urllib.request
from pathlib import Path

import discord
from discord.ext import commands, tasks

# ═══════════════════════════════════════════════════════
# CONFIG
# ═══════════════════════════════════════════════════════
# PAT classic : scope repo + workflow — UNIQUEMENT via env
GITHUB_TOKEN = (os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or "").strip()
GITHUB_REPO = os.environ.get("GITHUB_REPO", "jbouzeau7-max/discord-canary-scraper").strip()

# Events alignés sur .github/workflows/*.yml de ce dépôt
DISPATCH_EVENT = "trigger-scraping"  # scrape.yml

# User / rollouts — toutes les ~2 minutes
USER_ROLLOUT_EVENT = "trigger-user-rollouts"  # rollouts.yml
USER_ROLLOUT_INTERVAL_SECONDS = 120

# Autres workflows (events séparés) — PAS de user-rollouts ici (géré à part)
EXTRA_EVENTS = [
    "trigger-quests",  # quests.yml
    "trigger-mobile",  # mobile-versions.yml
    "trigger-x-watch",  # x-watch.yml
    "trigger-rollouts",  # rollouts.yml (apex / fast)
    "trigger-shop",  # shop.yml
    "trigger-news",  # news.yml
    "trigger-blog",  # blog-tracker.yml
]

# Vitesse : on poll Canary très souvent (léger, ~1 requête HTML) et on dispatch
# IMMÉDIATEMENT dès que le build change.
# AVANT : force toutes les 65 s → pendant les 28 min du watcher (qui détecte
# déjà les builds en local, 1 tick/s), chaque dispatch créait un run « pending »
# qui ANNIULAIT le précédent → ~95 % des runs « Scrape » restaient annulés.
# Le workflow a déjà un cron */5 en filet de sécurité : on force maintenant le
# scrape bien moins souvent (SCRAPE_FORCE_INTERVAL_SECONDS, défaut 900 s).
POLL_SECONDS = max(2, int(os.environ.get("CANARY_POLL_SECONDS", "2")))
FORCE_INTERVAL_SECONDS = 65
SCRAPE_FORCE_INTERVAL_SECONDS = max(60, int(os.environ.get("SCRAPE_FORCE_INTERVAL_SECONDS", "900")))
INTERVAL_SECONDS = POLL_SECONDS  # compat
FORCE_ALWAYS = True
# Extras : toutes les N ticks force (~6 * 65s ≈ 6–7 min)
EXTRA_EVERY_N_TICKS = 6

STATE_FILE = Path(__file__).resolve().parent / "last_canary_build.txt"
# ═══════════════════════════════════════════════════════

CANARY_URL = "https://canary.discord.com/app"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
_BUILD_RE = re.compile(r'"BUILD_NUMBER"\s*:\s*"?(\d+)"?')
_HASH_RE = re.compile(r'"VERSION_HASH"\s*:\s*"([a-f0-9]{8,})"', re.I)

HTTP_TIMEOUT = 8
DISPATCH_TIMEOUT = 12

_last_dispatch_ok = 0.0
_min_gap_after_429 = 15.0
_tick_count = 0
_last_user_rollout = 0.0
_last_force = 0.0
_last_scrape_force = 0.0
_last_seen_token: str | None = None


def _opener() -> urllib.request.OpenerDirector:
    return urllib.request.build_opener()


_OPENER = _opener()


def _read_build_fast(url: str) -> tuple[str | None, str | None]:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "text/html",
            "Accept-Encoding": "identity",
            "Connection": "close",
        },
        method="GET",
    )
    try:
        with _OPENER.open(req, timeout=HTTP_TIMEOUT) as res:
            buf = ""
            while True:
                chunk = res.read(4096)
                if not chunk:
                    break
                buf += chunk.decode("utf-8", errors="replace")
                m = _BUILD_RE.search(buf)
                if m:
                    build = m.group(1)
                    h = _HASH_RE.search(buf)
                    if not h and len(buf) < 20000:
                        extra = res.read(8192)
                        if extra:
                            buf += extra.decode("utf-8", errors="replace")
                            h = _HASH_RE.search(buf)
                    return build, (h.group(1)[:12] if h else None)
            m = _BUILD_RE.search(buf)
            if m:
                h = _HASH_RE.search(buf)
                return m.group(1), (h.group(1)[:12] if h else None)
    except Exception as e:
        print(f"[canary-cog] fetch fail: {e}", flush=True)
    return None, None


def _read_last() -> str | None:
    try:
        if STATE_FILE.is_file():
            return STATE_FILE.read_text(encoding="utf-8").strip() or None
    except Exception:
        pass
    return None


def _write_last(token: str) -> None:
    try:
        STATE_FILE.write_text(token, encoding="utf-8")
    except Exception as e:
        print(f"[canary-cog] state write fail: {e}", flush=True)


def _state_token(build: str, version_hash: str | None) -> str:
    if version_hash:
        return f"{build}:{version_hash}"
    return build


def _dispatch(event: str, client_payload: dict | None = None) -> tuple[bool, str]:
    global _last_dispatch_ok

    if not GITHUB_TOKEN or len(GITHUB_TOKEN) < 20:
        return False, "GITHUB_TOKEN manquant / invalide (env GITHUB_TOKEN ou GH_TOKEN)"

    url = f"https://api.github.com/repos/{GITHUB_REPO}/dispatches"
    payload: dict = {"event_type": event}
    if client_payload:
        payload["client_payload"] = client_payload
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {GITHUB_TOKEN}",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
            "User-Agent": "canary-cog-jbouzeau7",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=DISPATCH_TIMEOUT) as res:
            _last_dispatch_ok = time.monotonic()
            return True, f"OK {res.status} {event}"
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", errors="replace")
        if e.code == 429:
            time.sleep(_min_gap_after_429)
        return False, f"HTTP {e.code} {event}: {err[:160]}"
    except Exception as e:
        return False, f"{event}: {e}"


def _maybe_user_rollout() -> str | None:
    """Dispatch User Rollouts % au plus toutes les USER_ROLLOUT_INTERVAL_SECONDS."""
    global _last_user_rollout
    now = time.monotonic()
    if _last_user_rollout and (now - _last_user_rollout) < USER_ROLLOUT_INTERVAL_SECONDS:
        return None
    ok, msg = _dispatch(USER_ROLLOUT_EVENT)
    if ok:
        _last_user_rollout = now
    return ("✅ " if ok else "❌ ") + f"user-rollouts | {msg}"


def _tick_fast() -> str | None:
    """Poll rapide : dispatch immédiat si nouveau build, sinon force périodique.

    Retourne None quand rien n'a été fait (pas de log spam).
    """
    global _last_seen_token
    build, vhash = _read_build_fast(CANARY_URL)
    if build:
        token = _state_token(build, vhash)
        if _last_seen_token is None:
            _last_seen_token = _read_last()
        if token != _last_seen_token:
            ok, msg = _dispatch(DISPATCH_EVENT, {"build": build, "hash": vhash or ""})
            if ok:
                prev = _last_seen_token
                _last_seen_token = token
                _write_last(token)
                return f"[NEW-FAST] build={token} prev={prev} | {msg}"
            return f"[NEW-FAST] build={token} dispatch fail | {msg}"
    if time.monotonic() - _last_force >= FORCE_INTERVAL_SECONDS:
        return _tick_force(build, vhash)
    return None


def _tick_force(build: str | None = None, vhash: str | None = None) -> str:
    """Canary + user-rollouts ~2 min + extras périodiques."""
    global _tick_count, _last_force, _last_seen_token
    _tick_count += 1
    _last_force = time.monotonic()

    if build is None:
        build, vhash = _read_build_fast(CANARY_URL)
    token = _state_token(build, vhash) if build else "?"
    last = _read_last()
    changed = bool(build) and last != token
    scrape_force_due = time.monotonic() - _last_scrape_force >= SCRAPE_FORCE_INTERVAL_SECONDS

    # 1) Canary scrape — UNIQUement si nouveau build, ou filet de sécurité
    # espacé (le cron */5 du workflow relance déjà le watcher en continu).
    ok, msg = None, "skip (build inchangé, watcher actif)"
    if changed or scrape_force_due:
        ok, msg = _dispatch(DISPATCH_EVENT, {"build": build, "hash": vhash or ""} if build else None)
        if ok:
            if build:
                _write_last(token)
                _last_seen_token = token
            _last_scrape_force = time.monotonic()

    lines = [f"[{'NEW' if changed else 'force'}] build={token} last={last} | {msg}"]

    # 2) User Rollouts % — toutes les ~2 minutes
    ur = _maybe_user_rollout()
    if ur:
        lines.append(ur)

    # 3) Extras (quests, mobile, shop, news…) — pas à chaque tick
    if FORCE_ALWAYS and EXTRA_EVENTS and (_tick_count % EXTRA_EVERY_N_TICKS == 0):
        for ev in EXTRA_EVENTS:
            time.sleep(0.5)
            e_ok, e_msg = _dispatch(ev)
            lines.append(("✅ " if e_ok else "❌ ") + e_msg)

    return "\n".join(lines)


class CanaryTrigger(commands.Cog):
    """Dispatch GitHub : canary en continu + user-rollouts 2 min + extras périodiques."""

    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self._lock = asyncio.Lock()
        self.auto_check.change_interval(seconds=INTERVAL_SECONDS)
        self.auto_check.start()

    def cog_unload(self):
        self.auto_check.cancel()

    @tasks.loop(seconds=INTERVAL_SECONDS)
    async def auto_check(self):
        if self._lock.locked():
            return
        async with self._lock:
            result = await asyncio.to_thread(_tick_fast)
            if result:
                print(f"[canary-cog] {result}", flush=True)

    @auto_check.before_loop
    async def before_auto(self):
        await self.bot.wait_until_ready()
        try:
            await asyncio.to_thread(socket.getaddrinfo, "canary.discord.com", 443)
            await asyncio.to_thread(socket.getaddrinfo, "api.github.com", 443)
        except Exception:
            pass
        print(
            f"[canary-cog] poll canary every {POLL_SECONDS}s (dispatch on change) · "
            f"force every {FORCE_INTERVAL_SECONDS}s · "
            f"user-rollouts every {USER_ROLLOUT_INTERVAL_SECONDS}s · "
            f"extras every {EXTRA_EVERY_N_TICKS} ticks → {GITHUB_REPO}",
            flush=True,
        )

    @commands.command(name="canary_check")
    @commands.is_owner()
    async def canary_check(self, ctx: commands.Context):
        """Un tick force (canary + user-rollouts si intervalle OK + extras si compteur)."""
        await ctx.send("Force tick…")
        result = await asyncio.to_thread(_tick_force)
        await ctx.send(f"```\n{result[:1800]}\n```")

    @commands.command(name="canary_force")
    @commands.is_owner()
    async def canary_force(self, ctx: commands.Context):
        """Force uniquement le scrape Canary."""
        ok, msg = await asyncio.to_thread(_dispatch, DISPATCH_EVENT)
        await ctx.send(f"{'✅' if ok else '❌'} `{msg}`")

    @commands.command(name="rollouts_force")
    @commands.is_owner()
    async def rollouts_force(self, ctx: commands.Context):
        """Force User Rollouts % immédiatement (ignore le timer 2 min)."""
        global _last_user_rollout
        _last_user_rollout = 0.0
        ok, msg = await asyncio.to_thread(_dispatch, USER_ROLLOUT_EVENT)
        if ok:
            _last_user_rollout = time.monotonic()
        await ctx.send(f"{'✅' if ok else '❌'} `{msg}`")

    @commands.command(name="dispatch_all")
    @commands.is_owner()
    async def dispatch_all(self, ctx: commands.Context):
        """Force canary + user-rollouts + tous les extras immédiatement."""
        await ctx.send("Dispatch all…")

        def _all():
            lines = []
            for ev in [DISPATCH_EVENT, USER_ROLLOUT_EVENT, *EXTRA_EVENTS]:
                ok, msg = _dispatch(ev)
                lines.append(("✅ " if ok else "❌ ") + msg)
                time.sleep(0.5)
            return "\n".join(lines)

        result = await asyncio.to_thread(_all)
        await ctx.send(f"```\n{result[:1800]}\n```")


async def setup(bot: commands.Bot):
    await bot.add_cog(CanaryTrigger(bot))
