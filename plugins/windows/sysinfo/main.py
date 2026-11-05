"""Windows system info: host name, OS version, install date, time zone, last logged-on user, local accounts."""
import struct
from datetime import datetime, timezone

from disksleuth import filetime_to_text
from winreg_util import CONFIG, as_bytes, current_control_set, get_value, open_hive, signed32, try_open_hive

CV = r"\Microsoft\Windows NT\CurrentVersion"
LOGON = r"\Microsoft\Windows\CurrentVersion\Authentication\LogonUI"


def hive_file(source: str) -> str:
    """'SOFTWARE\\Microsoft\\...' -> path of the hive the value came from."""
    return CONFIG + source.replace("\\", " ").split()[0]


def run(ctx):
    system = open_hive(ctx, CONFIG + "SYSTEM")
    software = open_hive(ctx, CONFIG + "SOFTWARE")
    ctx.progress(0.3, "SYSTEM / SOFTWARE")

    cs = current_control_set(system)
    tz_key = rf"\{cs}\Control\TimeZoneInformation"
    tcpip = rf"\{cs}\Services\Tcpip\Parameters"

    def row(item, value, source):
        if value not in (None, ""):
            ctx.emit("sysinfo", {"item": item, "value": str(value), "source": source}, file=hive_file(source))

    host = get_value(system, rf"\{cs}\Control\ComputerName\ComputerName", "ComputerName")
    row("Computer name", host, rf"SYSTEM\{cs}\Control\ComputerName\ComputerName > ComputerName")
    row("Host name (TCP/IP)", get_value(system, tcpip, "Hostname"), rf"SYSTEM{tcpip} > Hostname")
    row("Domain (TCP/IP)", get_value(system, tcpip, "Domain"), rf"SYSTEM{tcpip} > Domain")

    product = get_value(software, CV, "ProductName")
    csd = get_value(software, CV, "CSDVersion")
    build = get_value(software, CV, "CurrentBuildNumber") or get_value(software, CV, "CurrentBuild")
    row("Operating system", product, rf"SOFTWARE{CV} > ProductName")
    row("Edition", get_value(software, CV, "EditionID"), rf"SOFTWARE{CV} > EditionID")
    row("Service pack", csd, rf"SOFTWARE{CV} > CSDVersion")
    row("Build", build, rf"SOFTWARE{CV} > CurrentBuildNumber")
    row("Registered owner", get_value(software, CV, "RegisteredOwner"), rf"SOFTWARE{CV} > RegisteredOwner")
    row("Registered organization", get_value(software, CV, "RegisteredOrganization"), rf"SOFTWARE{CV} > RegisteredOrganization")
    row("System root", get_value(software, CV, "SystemRoot"), rf"SOFTWARE{CV} > SystemRoot")
    env = rf"\{cs}\Control\Session Manager\Environment"
    row("Processor architecture", get_value(system, env, "PROCESSOR_ARCHITECTURE"), rf"SYSTEM{env} > PROCESSOR_ARCHITECTURE")

    install = get_value(software, CV, "InstallDate")
    install_text = datetime.fromtimestamp(install, timezone.utc).strftime("%Y-%m-%d %H:%M:%S") + " UTC" if install else ""
    row("Install date", install_text, rf"SOFTWARE{CV} > InstallDate ({install})")

    shutdown = as_bytes(get_value(system, rf"\{cs}\Control\Windows", "ShutdownTime"))
    if len(shutdown) >= 8:
        row("Last shutdown", filetime_to_text(struct.unpack_from("<Q", shutdown)[0]) + " UTC",
            rf"SYSTEM\{cs}\Control\Windows > ShutdownTime")

    last_user = get_value(software, LOGON, "LastLoggedOnUser")
    row("Last logged-on user", last_user, rf"SOFTWARE{LOGON} > LastLoggedOnUser")
    row("Last logged-on user (SAM)", get_value(software, LOGON, "LastLoggedOnSAMUser"), rf"SOFTWARE{LOGON} > LastLoggedOnSAMUser")

    # time zone: ActiveTimeBias = UTC - local, in minutes
    tzname = get_value(system, tz_key, "TimeZoneKeyName") or get_value(system, tz_key, "StandardName") or "unknown"
    bias = get_value(system, tz_key, "ActiveTimeBias")
    if bias is None:
        bias = get_value(system, tz_key, "Bias", 0)
    offset = -signed32(bias)
    sign = "-" if offset < 0 else "+"
    offset_text = f"UTC{sign}{abs(offset) // 60:02d}:{abs(offset) % 60:02d}"
    ctx.emit("timezone", {"item": "TimeZoneKeyName", "value": tzname, "source": rf"SYSTEM{tz_key} > TimeZoneKeyName"}, file=CONFIG + "SYSTEM")
    ctx.emit("timezone", {"item": "UTC offset", "value": offset_text, "source": rf"SYSTEM{tz_key} > ActiveTimeBias"}, file=CONFIG + "SYSTEM")
    if get_value(system, tz_key, "DynamicDaylightTimeDisabled") == 1:
        ctx.emit("timezone", {"item": "Daylight saving disabled", "value": "Yes",
                              "source": rf"SYSTEM{tz_key} > DynamicDaylightTimeDisabled"}, file=CONFIG + "SYSTEM")

    ctx.progress(0.7, "SAM")
    for u in sam_users(ctx):
        ctx.emit("users", u, file=CONFIG + "SAM")

    # evidence summary (case page)
    ctx.summary("hostname", host)
    ctx.summary("os", " ".join(x for x in (product, csd) if x) + (f" ({build})" if build else ""))
    ctx.summary("installDate", install_text)
    ctx.summary("lastUser", (last_user or "").split("\\")[-1])
    ctx.summary("timezone", f"{tzname} ({offset_text})")


def _v_string(v: bytes, table_offset: int) -> str:
    """Read one string of the SAM V value; its (offset, length) pair is at table_offset, data starts at 0xCC."""
    try:
        off, ln = struct.unpack_from("<II", v, table_offset)
        return v[0xCC + off:0xCC + off + ln].decode("utf-16-le")
    except Exception:
        return ""


def sam_users(ctx):
    """SAM\\Domains\\Account\\Users\\<RID>: F holds times and counters, V holds the names.
    F offsets: 0x08 last logon, 0x18 password last set, 0x38 account flags (0x0001 = disabled), 0x42 logon count."""
    sam = try_open_hive(ctx, CONFIG + "SAM")
    if sam is None:
        return []
    base = r"\SAM\Domains\Account\Users"
    out = []
    for sk in sam.get_key(base).iter_subkeys():
        try:
            rid = int(sk.name, 16)
        except ValueError:
            continue  # "Names"
        f = as_bytes(sk.get_value("F"))
        v = as_bytes(sk.get_value("V"))
        ft = lambda o: filetime_to_text(struct.unpack_from("<Q", f, o)[0]) if len(f) >= o + 8 else ""  # noqa: E731
        flags = struct.unpack_from("<H", f, 0x38)[0] if len(f) >= 0x3A else 0
        out.append({
            "name": _v_string(v, 0x0C) or f"RID {rid}",
            "rid": rid,
            "fullName": _v_string(v, 0x18),
            "logons": struct.unpack_from("<H", f, 0x42)[0] if len(f) >= 0x44 else 0,
            "lastLogin": ft(0x08),
            "pwdSet": ft(0x18),
            "disabled": bool(flags & 0x0001),
            "source": rf"SAM{base}\{rid:08X} > F, V",
        })
    return sorted(out, key=lambda u: u["lastLogin"], reverse=True)
