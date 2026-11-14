#!/usr/bin/env python3
"""
Surveille les nouveaux posts X d'un compte et les envoie sur un webhook Discord.

Compte par défaut : discordnew8r
API : twikit (guest token, ou cookies / login si secrets fournis)

Secrets / env :
  X_WATCH_WEBHOOK_URL ou TWITTER_WEBHOOK_URL ou DISCORD_WEBHOOK_URL
  X_WATCH_SCREEN_NAME (défaut: discordnew8r)
  TWIKIT_COOKIES_JSON  — JSON cookies navigateur (recommandé sur CI)
  TWIKIT_AUTH_INFO_1 / TWIKIT_AUTH_INFO_2 / TWIKIT_PASSWORD — login alternatif

État : data/seen_x_posts.json (commité par le workflow)
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
SEEN_FILE = DATA / "seen_x_posts.json"
MAX_SEEN = 500
MAX_SEND_PER_RUN = int(os.environ.get("X_WATCH_MAX_PER_RUN", "5"))

SCREEN_NAME = (os.environ.get("X_WATCH_SCREEN_NAME") or "discordnew8r").lstrip("@").strip()
WEBHOOK = (
    os.environ.get("X_WATCH_WEBHOOK_URL")
    or os.environ.get("TWITTER_WEBHOOK_URL")
    or os.environ.get("DISCORD_WEBHOOK_URL")
    or ""
).strip()


def load_seen() -> dict:
    if not SEEN_FILE.is_file():
        return {"screen_name": SCREEN_NAME, "user_id": None, "ids": []}
    try:
        data = json.loads(SEEN_FILE.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return {"screen_name": SCREEN_NAME, "user_id": None, "ids": []}
        ids = data.get("ids") or []
        if not isinstance(ids, list):
            ids = []
        return {
            "screen_name": data.get("screen_name") or SCREEN_NAME,
            "user_id": data.get("user_id"),
            "ids": [str(x) for x in ids],
        }
    except Exception as e:
        print(f"[x-watch] seen load fail: {e}", flush=True)
        return {"screen_name": SCREEN_NAME, "user_id": None, "ids": []}


def save_seen(state: dict) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    ids = list(dict.fromkeys(str(i) for i in state.get("ids") or []))[-MAX_SEEN:]
    out = {
        "screen_name": state.get("screen_name") or SCREEN_NAME,
        "user_id": state.get("user_id"),
        "ids": ids,
    }
    tmp = SEEN_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(SEEN_FILE)


def tweet_url(screen_name: str, tweet_id: str) -> str:
    return f"https://x.com/{screen_name}/status/{tweet_id}"


def media_urls(tweet) -> list[str]:
    urls: list[str] = []
    try:
        for m in getattr(tweet, "media", None) or []:
            u = getattr(m, "media_url", None) or getattr(m, "url", None)
            if u and u not in urls:
                urls.append(u)
    except Exception:
        pass
    thumb = getattr(tweet, "thumbnail_url", None)
    if thumb and thumb not in urls:
        urls.append(thumb)
    return urls[:4]


def build_payload(tweet, screen_name: str) -> dict:
    tid = str(tweet.id)
    text = (getattr(tweet, "text", None) or getattr(tweet, "full_text", None) or "").strip()
    if len(text) > 3900:
        text = text[:3900] + "…"
    url = tweet_url(screen_name, tid)
    created = getattr(tweet, "created_at", None) or ""
    author_name = screen_name
    author_icon = None
    try:
        user = getattr(tweet, "user", None)
        if user is not None:
            author_name = getattr(user, "name", None) or screen_name
            author_icon = getattr(user, "profile_image_url", None) or getattr(
                user, "profile_image_url_https", None
            )
            if author_icon:
                author_icon = str(author_icon).replace("_normal.", ".")
    except Exception:
        pass

    embed: dict = {
        "author": {
            "name": f"@{screen_name}" + (f" · {author_name}" if author_name != screen_name else ""),
            "url": f"https://x.com/{screen_name}",
        },
        "description": text or "*(sans texte)*",
        "url": url,
        "color": 0x1DA1F2,
        "footer": {"text": f"X · {created}".strip(" ·")},
    }
    if author_icon:
        embed["author"]["icon_url"] = author_icon

    images = media_urls(tweet)
    if images:
        embed["image"] = {"url": images[0]}

    embeds = [embed]
    for extra in images[1:]:
        embeds.append({"url": url, "image": {"url": extra}, "color": 0x1DA1F2})

    return {
        "username": "X · Discord News",
        "avatar_url": "https://abs.twimg.com/icons/apple-touch-icon-192x192.png",
        "content": f"Nouveau post de **@{screen_name}**",
        "embeds": embeds[:10],
        "allowed_mentions": {"parse": []},
    }


def post_webhook(payload: dict) -> bool:
    if not WEBHOOK:
        print("[x-watch] pas de webhook", flush=True)
        return False
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        WEBHOOK,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json", "User-Agent": "discord-canary-scraper-x-watch"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            ok = 200 <= res.status < 300
            print(f"[x-watch] webhook {res.status}", flush=True)
            return ok
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", errors="replace")[:300]
        print(f"[x-watch] webhook HTTP {e.code}: {err}", flush=True)
        if e.code == 429:
            # simple wait once
            import time

            ra = int(e.headers.get("Retry-After", 5) or 5)
            time.sleep(min(ra, 30))
            try:
                with urllib.request.urlopen(req, timeout=20) as res2:
                    return 200 <= res2.status < 300
            except Exception as e2:
                print(f"[x-watch] webhook retry fail: {e2}", flush=True)
        return False
    except Exception as e:
        print(f"[x-watch] webhook error: {e}", flush=True)
        return False


async def make_client():
    cookies_json = (os.environ.get("TWIKIT_COOKIES_JSON") or "").strip()
    auth1 = (os.environ.get("TWIKIT_AUTH_INFO_1") or "").strip()
    auth2 = (os.environ.get("TWIKIT_AUTH_INFO_2") or "").strip()
    password = (os.environ.get("TWIKIT_PASSWORD") or "").strip()

    if cookies_json:
        from twikit import Client

        client = Client("en-US")
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
            f.write(cookies_json)
            path = f.name
        try:
            client.load_cookies(path)
            print("[x-watch] auth: cookies", flush=True)
            return client, "cookies"
        finally:
            try:
                os.unlink(path)
            except OSError:
                pass

    if auth1 and password:
        from twikit import Client

        client = Client("en-US")
        await client.login(auth_info_1=auth1, auth_info_2=auth2 or auth1, password=password)
        print("[x-watch] auth: login", flush=True)
        return client, "login"

    from twikit.guest import GuestClient

    client = GuestClient()
    await client.activate()
    print("[x-watch] auth: guest", flush=True)
    return client, "guest"


async def fetch_tweets(client, user_id: str, count: int = 20):
    # GuestClient: get_user_tweets(user_id, tweet_type='Tweets', count=…)
    # Client: get_user_tweets(user_id, 'Tweets', count=…)
    try:
        return await client.get_user_tweets(user_id, "Tweets", count=count)
    except TypeError:
        return await client.get_user_tweets(user_id, count=count)


async def run() -> int:
    print(f"=== X watch @{SCREEN_NAME} ===", flush=True)
    if not WEBHOOK:
        print("[x-watch] X_WATCH_WEBHOOK_URL manquant — soft skip", flush=True)
        return 0

    state = load_seen()
    seen = set(state["ids"])

    try:
        client, mode = await make_client()
    except Exception as e:
        print(f"[x-watch] client fail ({e}) — soft skip", flush=True)
        return 0

    try:
        user = await client.get_user_by_screen_name(SCREEN_NAME)
        user_id = str(user.id)
        state["user_id"] = user_id
        state["screen_name"] = SCREEN_NAME
        print(f"[x-watch] user_id={user_id} mode={mode}", flush=True)
        tweets = await fetch_tweets(client, user_id, count=20)
    except Exception as e:
        print(f"[x-watch] fetch fail: {e}", flush=True)
        return 0

    if not tweets:
        print("[x-watch] aucun tweet", flush=True)
        save_seen(state)
        return 0

    # ordre chronologique (ancien → récent) pour envoyer dans l'ordre
    ordered = list(reversed(list(tweets)))
    ids_now = [str(t.id) for t in ordered]

    if not seen:
        # premier run : seed, pas d'envoi spam
        state["ids"] = ids_now[-MAX_SEEN:]
        save_seen(state)
        print(f"[x-watch] seed {len(state['ids'])} ids — aucun envoi", flush=True)
        return 0

    new_tweets = [t for t in ordered if str(t.id) not in seen]
    print(f"[x-watch] tweets={len(ordered)} new={len(new_tweets)}", flush=True)

    sent = 0
    for t in new_tweets[-MAX_SEND_PER_RUN:]:
        payload = build_payload(t, SCREEN_NAME)
        if post_webhook(payload):
            sent += 1
            seen.add(str(t.id))
            state["ids"].append(str(t.id))
        else:
            print(f"[x-watch] envoi échoué id={t.id} — stop (retry next run)", flush=True)
            break

    # marquer aussi les ids vus non envoyés (au-delà du plafond) pour éviter backlog infini
    for t in new_tweets:
        tid = str(t.id)
        if tid not in seen:
            # non envoyés faute de plafond : on les garde pour le prochain run
            pass

    state["ids"] = list(dict.fromkeys(state["ids"]))[-MAX_SEEN:]
    # s'assurer que tous les ids de la timeline récente entrent dans seen après envoi réussi
    for tid in ids_now:
        if tid not in state["ids"] and tid in seen:
            state["ids"].append(tid)
    state["ids"] = list(dict.fromkeys(state["ids"]))[-MAX_SEEN:]
    save_seen(state)
    print(f"[x-watch] done sent={sent}", flush=True)
    return 0


def main() -> None:
    try:
        code = asyncio.run(run())
    except KeyboardInterrupt:
        code = 130
    except Exception as e:
        print(f"[x-watch] fatal: {e}", flush=True)
        code = 0  # soft-fail CI
    sys.exit(code)


if __name__ == "__main__":
    main()
