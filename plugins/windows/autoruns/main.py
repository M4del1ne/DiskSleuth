"""Services, drivers and autostart locations (Run keys, Winlogon, Startup folders)."""
from disksleuth import unix_to_text
from winreg_util import (CONFIG, current_control_set, get_key, get_value, get_value_of, key_last_write, open_hive, subkeys,
                         try_open_hive, user_hives, values)

START = {0: "Boot", 1: "System", 2: "Automatic", 3: "Manual", 4: "Disabled"}
RUN_KEYS = [
    r"\Microsoft\Windows\CurrentVersion\Run",
    r"\Microsoft\Windows\CurrentVersion\RunOnce",
    r"\Microsoft\Windows\CurrentVersion\RunServices",
    r"\Microsoft\Windows\CurrentVersion\Policies\Explorer\Run",
    r"\Wow6432Node\Microsoft\Windows\CurrentVersion\Run",
    r"\Wow6432Node\Microsoft\Windows\CurrentVersion\RunOnce",
]
WINLOGON = r"\Microsoft\Windows NT\CurrentVersion\Winlogon"
STARTUP = "AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup"
STARTUP_ALL = "/ProgramData/Microsoft/Windows/Start Menu/Programs/Startup"


def service_type(t) -> str:
    try:
        t = int(t)
    except (TypeError, ValueError):
        return ""
    if t & 0x1:
        return "Kernel driver"
    if t & 0x2:
        return "File system driver"
    if t & 0x10:
        return "Service (own process)"
    if t & 0x20:
        return "Service (shared process)"
    return f"0x{t:X}"


def run(ctx):
    system = open_hive(ctx, CONFIG + "SYSTEM")
    cs = current_control_set(system)
    base = rf"\{cs}\Services"
    rows = []
    for k in subkeys(get_key(system, base)):
        start = get_value_of(k, "Start")
        if start is None and get_value_of(k, "ImagePath") is None:
            continue  # parameter-only keys
        rows.append({
            "name": k.name,
            "displayName": _clean(get_value_of(k, "DisplayName")),
            "start": START.get(start, "" if start is None else str(start)),
            "type": service_type(get_value_of(k, "Type")),
            "imagePath": get_value_of(k, "ImagePath"),
            "account": get_value_of(k, "ObjectName"),
            "lastWrite": key_last_write(k),
            "source": rf"SYSTEM{base}\{k.name}",
        })
    # most recently changed first: newly installed services stand out
    for r in sorted(rows, key=lambda r: r["lastWrite"], reverse=True):
        ctx.emit("services", r, file=CONFIG + "SYSTEM")
    ctx.progress(0.4, "Run keys")

    software = try_open_hive(ctx, CONFIG + "SOFTWARE")
    if software is not None:
        for kp in RUN_KEYS:
            emit_run_key(ctx, software, kp, "All users", "SOFTWARE", CONFIG + "SOFTWARE")
        for name in ("Shell", "Userinit", "Taskman", "AppSetup"):
            v = get_value(software, WINLOGON, name)
            if v:
                ctx.emit("runkeys", {"location": "Winlogon", "scope": "All users", "name": name, "command": v,
                                     "lastWrite": key_last_write(get_key(software, WINLOGON)),
                                     "source": rf"SOFTWARE{WINLOGON} > {name}"}, file=CONFIG + "SOFTWARE")
    for user, path, hive in user_hives(ctx):
        for kp in RUN_KEYS[:4]:
            emit_run_key(ctx, hive, r"\Software" + kp, user, f"{user}\\NTUSER.DAT", path)
    ctx.progress(0.8, "Startup folders")

    for e in ctx.glob(STARTUP_ALL + "/*"):
        emit_startup_file(ctx, e, "All users", "Startup folder (all users)")
    for prof in ctx.user_profiles():
        for e in ctx.glob(f"{prof['path']}/{STARTUP}/*"):
            emit_startup_file(ctx, e, prof["name"], "Startup folder")


def emit_run_key(ctx, hive, key_path, scope, label, hive_path):
    key = get_key(hive, key_path)
    for name, value in values(key):
        ctx.emit("runkeys", {
            "location": key_path.strip("\\").replace("Software\\", "", 1).split("Microsoft\\Windows\\CurrentVersion\\")[-1],
            "scope": scope, "name": name, "command": value, "lastWrite": key_last_write(key),
            "source": f"{label}{key_path} > {name}",
        }, file=hive_path)


def emit_startup_file(ctx, e, scope, location):
    if e["isDir"] or e["name"].lower() == "desktop.ini":
        return
    ctx.emit("runkeys", {"location": location, "scope": scope, "name": e["name"], "command": e["path"],
                         "lastWrite": unix_to_text(e["modified"]), "source": e["path"]}, file=e)


def _clean(v):
    """Display names like '@%SystemRoot%\\system32\\x.dll,-100' are resource references; keep them as they are, but strip NULs."""
    return str(v).strip("\x00") if v else ""
