"""Browser history and downloads: Chromium family (History database) and Firefox (places.sqlite).

Chromium times are microseconds since 1601 (WebKit); Firefox times are microseconds since 1970 (PRTime)."""
import sqlite3

from disksleuth import filetime_to_text, unix_to_text

# (browser, path below the profile folder with * for the browser profile)
CHROMIUM = [
    ("Chrome", "AppData/Local/Google/Chrome/User Data/*/History"),
    ("Edge", "AppData/Local/Microsoft/Edge/User Data/*/History"),
    ("Brave", "AppData/Local/BraveSoftware/Brave-Browser/User Data/*/History"),
    ("Chromium", "AppData/Local/Chromium/User Data/*/History"),
    ("Vivaldi", "AppData/Local/Vivaldi/User Data/*/History"),
    ("Opera", "AppData/Roaming/Opera Software/Opera Stable/History"),
    ("360 Chrome", "AppData/Local/360Chrome/Chrome/User Data/*/History"),
    ("360 Browser", "AppData/Roaming/360se6/User Data/*/History"),
    ("QQ Browser", "AppData/Local/Tencent/QQBrowser/User Data/*/History"),
    ("Sogou", "AppData/Roaming/SogouExplorer/Webkit/*/History"),
]
FIREFOX = ("Firefox", "AppData/Roaming/Mozilla/Firefox/Profiles/*/places.sqlite")
TRANSITIONS = {0: "Link", 1: "Typed", 2: "Bookmark", 3: "Subframe", 4: "Subframe", 5: "Generated", 6: "Start page",
               7: "Form submit", 8: "Reload", 9: "Keyword", 10: "Keyword"}
DOWNLOAD_STATES = {0: "In progress", 1: "Complete", 2: "Cancelled", 3: "Interrupted", 4: "Interrupted"}


def webkit(us) -> str:
    return filetime_to_text(int(us) * 10) if us else ""


def prtime(us) -> str:
    return unix_to_text(int(us) / 1_000_000) if us else ""


def copy_db(ctx, entry, dest) -> str:
    """Copy a SQLite database and its -wal / -journal companions so pending changes are included."""
    local = ctx.export(entry, dest_dir=dest)
    for suffix in ("-wal", "-journal"):
        side = ctx.stat(entry["path"] + suffix)
        if side is not None and side["size"] > 0:
            ctx.export({**side, "name": entry["name"] + suffix}, dest_dir=dest)
    return local


def query(db: str, sql: str):
    con = sqlite3.connect(db)
    try:
        return con.execute(sql).fetchall()
    finally:
        con.close()


def run(ctx):
    found = 0
    profiles = ctx.user_profiles()
    for pi, prof in enumerate(profiles):
        ctx.progress(pi / max(len(profiles), 1), prof["name"])
        for browser, pattern in CHROMIUM + [FIREFOX]:
            for entry in ctx.glob(f"{prof['path']}/{pattern}"):
                if entry["isDir"] or entry["size"] == 0:
                    continue
                found += 1
                profile = entry["path"].split("/")[-2]
                dest = ctx.temp_dir(f"db{found}")
                try:
                    db = copy_db(ctx, entry, dest)
                    if browser == "Firefox":
                        firefox(ctx, db, browser, prof["name"], profile, entry["path"])
                    else:
                        chromium(ctx, db, browser, prof["name"], profile, entry["path"])
                except Exception as e:
                    ctx.warn(f"{browser} {entry['path']}: {type(e).__name__}: {e}")
                finally:
                    ctx.flush()
    ctx.log(f"{found} browser databases")


def chromium(ctx, db, browser, user, profile, src):
    rows = query(db, """SELECT v.visit_time, u.url, u.title, u.visit_count, v.transition
                        FROM visits v JOIN urls u ON v.url = u.id ORDER BY v.visit_time DESC""")
    for t, url, title, count, trans in rows:
        ctx.emit("browser_history", {"time": webkit(t), "browser": browser, "user": user, "title": title, "url": url,
                                     "visitCount": count, "transition": TRANSITIONS.get((trans or 0) & 0xFF, ""),
                                     "profile": profile, "source": src}, file=src)
    try:
        downloads = query(db, """SELECT d.start_time, d.end_time, d.target_path, d.total_bytes, d.received_bytes, d.state,
                                        (SELECT c.url FROM downloads_url_chains c WHERE c.id = d.id ORDER BY c.chain_index DESC LIMIT 1)
                                 FROM downloads d ORDER BY d.start_time DESC""")
    except sqlite3.Error:
        downloads = []
    for start, end, target, total, received, state, url in downloads:
        ctx.emit("browser_downloads", {"start": webkit(start), "end": webkit(end), "browser": browser, "user": user,
                                       "target": target, "url": url, "size": total or received or 0,
                                       "state": DOWNLOAD_STATES.get(state, str(state)), "source": src}, file=src)
    ctx.log(f"{browser} ({user}/{profile}): {len(rows)} visits, {len(downloads)} downloads")


def firefox(ctx, db, browser, user, profile, src):
    rows = query(db, """SELECT v.visit_date, p.url, p.title, p.visit_count, v.visit_type
                        FROM moz_historyvisits v JOIN moz_places p ON v.place_id = p.id ORDER BY v.visit_date DESC""")
    ff_types = {1: "Link", 2: "Typed", 3: "Bookmark", 4: "Subframe", 5: "Reload", 6: "Reload", 7: "Link", 8: "Subframe", 9: "Reload"}
    for t, url, title, count, vt in rows:
        ctx.emit("browser_history", {"time": prtime(t), "browser": browser, "user": user, "title": title, "url": url,
                                     "visitCount": count, "transition": ff_types.get(vt, ""), "profile": profile, "source": src}, file=src)
    try:
        downloads = query(db, """SELECT a.dateAdded, p.url, a.content FROM moz_annos a
                                 JOIN moz_anno_attributes n ON a.anno_attribute_id = n.id
                                 JOIN moz_places p ON a.place_id = p.id
                                 WHERE n.name = 'downloads/destinationFileURI' ORDER BY a.dateAdded DESC""")
    except sqlite3.Error:
        downloads = []
    for added, url, target in downloads:
        ctx.emit("browser_downloads", {"start": prtime(added), "end": "", "browser": browser, "user": user,
                                       "target": target, "url": url, "size": 0, "state": "", "source": src}, file=src)
    ctx.log(f"{browser} ({user}/{profile}): {len(rows)} visits, {len(downloads)} downloads")

