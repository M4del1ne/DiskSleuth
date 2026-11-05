"""Installed programs: Uninstall keys of HKLM (incl. 32-bit Wow6432Node) and of each user's HKCU."""
from winreg_util import CONFIG, get_value, key_last_write, open_hive, user_hives

UNINSTALL = r"\Microsoft\Windows\CurrentVersion\Uninstall"


def install_date(v) -> str:
    """InstallDate is usually 'YYYYMMDD'."""
    s = str(v or "").strip()
    if len(s) == 8 and s.isdigit():
        return f"{s[:4]}-{s[4:6]}-{s[6:]}"
    return s


def scan(ctx, hive, key_path: str, scope: str, hive_label: str, hive_path: str) -> int:
    try:
        root = hive.get_key(key_path)
    except Exception:
        return 0
    n = 0
    for sk in root.iter_subkeys():
        p = f"{key_path}\\{sk.name}"
        name = get_value(hive, p, "DisplayName")
        if not name:  # entries without a display name are mostly updates or components
            continue
        if get_value(hive, p, "SystemComponent") == 1:
            continue
        ctx.emit("software", {
            "name": name,
            "version": get_value(hive, p, "DisplayVersion"),
            "publisher": get_value(hive, p, "Publisher"),
            "installDate": install_date(get_value(hive, p, "InstallDate")),
            "lastWrite": key_last_write(sk),
            "scope": scope,
            "location": get_value(hive, p, "InstallLocation"),
            "uninstall": get_value(hive, p, "UninstallString"),
            "source": f"{hive_label}{p}",
        }, file=hive_path)
        n += 1
    return n


def run(ctx):
    software = open_hive(ctx, CONFIG + "SOFTWARE")
    total = scan(ctx, software, UNINSTALL, "All users", "SOFTWARE", CONFIG + "SOFTWARE")
    total += scan(ctx, software, r"\Wow6432Node" + UNINSTALL, "All users (32-bit)", "SOFTWARE", CONFIG + "SOFTWARE")
    ctx.progress(0.5, "NTUSER.DAT")
    for user, path, hive in user_hives(ctx):
        total += scan(ctx, hive, r"\Software" + UNINSTALL, user, f"{user}\\NTUSER.DAT", path)
    ctx.log(f"{total} programs")
