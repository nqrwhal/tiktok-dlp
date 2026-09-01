#!/usr/bin/env python3
"""
Instagram private API listing via instagrapi.
Uses the same sessionid as gallery-dl (from the Netscape cookies file)
to fetch posts/stories/highlights via i.instagram.com.
"""
import argparse
import json
import re
import sys
from pathlib import Path

def extract_sessionid(cookies_path: str) -> str:
    text = Path(cookies_path).read_text(errors="ignore")
    # Netscape format: domain \t ... \t sessionid \t value
    m = re.search(r"instagram\.com\s+.*\tsessionid\t([^\s]+)", text)
    if not m:
        # also try without domain prefix
        m = re.search(r"\tsessionid\t([^\s]+)", text)
    if not m:
        raise SystemExit(f"sessionid not found in {cookies_path}")
    return m.group(1).strip()

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--handle", required=True, help="Instagram handle without @")
    p.add_argument("--type", required=True, choices=["posts", "stories", "highlights"])
    p.add_argument("--limit", type=int, default=5)
    p.add_argument("--cookies", default="/app/cookies/instagram.txt")
    args = p.parse_args()

    handle = args.handle.strip().lower().replace("@", "")
    if not re.match(r"^[a-z0-9._]{1,30}$", handle) or ".." in handle:
        print(json.dumps({"error": "invalid handle"}))
        sys.exit(1)

    try:
        sessionid = extract_sessionid(args.cookies)
    except SystemExit as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

    try:
        from instagrapi import Client
        from instagrapi.exceptions import ClientError
    except ImportError as e:
        print(json.dumps({"error": f"instagrapi not installed: {e}"}))
        sys.exit(1)

    cl = Client()
    # Reduce retries and set timeout
    cl.request_timeout = 15
    try:
        cl.login_by_sessionid(sessionid)
    except Exception as e:
        print(json.dumps({"error": f"login_by_sessionid failed: {e}", "kind": "access_denied"}))
        sys.exit(1)

    try:
        user = cl.user_info_by_username(handle)
        user_id = str(user.pk)
    except Exception as e:
        # Try to give a clear kind for monitor backoff
        msg = str(e).lower()
        kind = "not_found" if "not found" in msg or "user not found" in msg else "access_denied" if "login" in msg else "private_error"
        print(json.dumps({"error": f"user lookup failed for {handle}: {e}", "kind": kind}))
        sys.exit(1)

    entries = []
    try:
        if args.type == "posts":
            # user_medias includes photos, videos, carousels
            medias = cl.user_medias(user_id, amount=args.limit)
            for m in medias[: args.limit]:
                # m.code is shortcode, m.pk is numeric id, m.taken_at is datetime
                code = getattr(m, "code", "") or str(getattr(m, "pk", ""))
                if not code:
                    continue
                # taken_at may be datetime
                taken_at = getattr(m, "taken_at", None)
                timestamp = None
                upload_date = ""
                if taken_at:
                    try:
                        # taken_at is datetime
                        import datetime
                        if hasattr(taken_at, "timestamp"):
                            timestamp = int(taken_at.timestamp())
                            upload_date = taken_at.strftime("%Y%m%d")
                    except:
                        pass
                entries.append({
                    "id": code,
                    "videoId": code,
                    "webpage_url": f"https://www.instagram.com/p/{code}/",
                    "url": f"https://www.instagram.com/p/{code}/",
                    "source_url": f"https://www.instagram.com/p/{code}/",
                    "title": (getattr(m, "caption_text", "") or "")[:200],
                    "description": getattr(m, "caption_text", "") or "",
                    "uploader": handle,
                    "username": handle,
                    "uploader_id": user_id,
                    "user_id": user_id,
                    "timestamp": timestamp,
                    "upload_date": upload_date,
                    "taken_at": str(taken_at) if taken_at else "",
                    "media_type": getattr(m, "media_type", 0),
                    "product_type": getattr(m, "product_type", ""),
                    "caption_text": getattr(m, "caption_text", ""),
                })
        elif args.type == "stories":
            # user_stories returns list of Story objects
            try:
                stories = cl.user_stories(user_id)
            except Exception as e:
                # Fallback to private reels_media
                stories = []
                # Try alternative
                try:
                    stories = cl.story_medias(user_id)  # may not exist
                except:
                    pass
            for s in stories[: args.limit]:
                # s.pk is media_id, s.taken_at, s.media_type
                pk = str(getattr(s, "pk", "") or getattr(s, "id", ""))
                if not pk:
                    continue
                # Normalize pk: may be like "3976487684889744146_99206928181" -> take first part? For story, pk is like "3976487684889744146"
                # instagrapi may return pk as "3976487684889744146_..." -> extract first
                if "_" in pk:
                    pk = pk.split("_")[0]
                taken_at = getattr(s, "taken_at", None)
                timestamp = None
                upload_date = ""
                if taken_at:
                    try:
                        import datetime
                        if hasattr(taken_at, "timestamp"):
                            timestamp = int(taken_at.timestamp())
                            upload_date = taken_at.strftime("%Y%m%d")
                    except:
                        pass
                entries.append({
                    "id": f"story_{pk}",
                    "videoId": f"story_{pk}",
                    "media_id": pk,
                    "webpage_url": f"https://www.instagram.com/stories/{handle}/{pk}/",
                    "url": f"https://www.instagram.com/stories/{handle}/{pk}/",
                    "source_url": f"https://www.instagram.com/stories/{handle}/{pk}/",
                    "title": "",
                    "description": "",
                    "uploader": handle,
                    "username": handle,
                    "uploader_id": user_id,
                    "user_id": user_id,
                    "timestamp": timestamp,
                    "upload_date": upload_date,
                    "taken_at": str(taken_at) if taken_at else "",
                    "mediaType": "story",
                    "type": "story",
                })
        elif args.type == "highlights":
            highlights = cl.user_highlights(user_id)
            # highlights is list of Highlight objects
            for h in highlights[: args.limit]:
                # h.id is like "highlight:18055303945979837" or numeric
                raw_id = str(getattr(h, "id", "") or getattr(h, "pk", ""))
                # Normalize: highlight:180553... -> 180553...
                highlight_id = raw_id.split(":")[-1] if ":" in raw_id else raw_id
                if not highlight_id:
                    continue
                title = getattr(h, "title", "") or ""
                # h.taken_at or h.latest_reel_media?
                # For highlights, use cover_media taken_at?
                # Use h.taken_at if available
                taken_at = getattr(h, "taken_at", None)
                timestamp = None
                upload_date = ""
                if taken_at:
                    try:
                        import datetime
                        if hasattr(taken_at, "timestamp"):
                            timestamp = int(taken_at.timestamp())
                            upload_date = taken_at.strftime("%Y%m%d")
                    except:
                        pass
                entries.append({
                    "id": f"highlight_{highlight_id}",
                    "videoId": f"highlight_{highlight_id}",
                    "highlight_id": highlight_id,
                    "highlight_title": title,
                    "webpage_url": f"https://www.instagram.com/stories/highlights/{highlight_id}/",
                    "url": f"https://www.instagram.com/stories/highlights/{highlight_id}/",
                    "source_url": f"https://www.instagram.com/stories/highlights/{highlight_id}/",
                    "title": title or f"Highlight {highlight_id}",
                    "description": title,
                    "uploader": handle,
                    "username": handle,
                    "uploader_id": user_id,
                    "user_id": user_id,
                    "timestamp": timestamp,
                    "upload_date": upload_date,
                    "taken_at": str(taken_at) if taken_at else "",
                    "mediaType": "highlight",
                    "type": "highlight",
                    "count": getattr(h, "media_count", 0) or 0,
                })
    except Exception as e:
        msg = str(e).lower()
        kind = "rate_limited" if "429" in msg or "throttled" in msg else "not_found" if "not found" in msg else "private_error"
        print(json.dumps({"error": f"{args.type} fetch failed for {handle}: {e}", "kind": kind}))
        sys.exit(1)

    # Build metadata
    metadata = {
        "id": user_id,
        "user_id": user_id,
        "uploader_id": user_id,
        "channel_id": user_id,
        "uploader": handle,
        "username": handle,
        "creator_id": user_id,
        "hasStory": None,
        "mediaType": args.type,
    }
    # For posts, we can infer hasStory? Not needed
    result = {
        "sourceUrl": f"https://www.instagram.com/{handle}/{'highlights' if args.type=='highlights' else 'stories' if args.type=='stories' else 'posts'}/",
        "count": len(entries),
        "metadata": metadata,
        "entries": entries,
    }
    # For stories/highlights, also include storyUrl
    if args.type == "stories":
        result["storyUrl"] = f"https://www.instagram.com/stories/{handle}/"
    print(json.dumps(result))

if __name__ == "__main__":
    main()
