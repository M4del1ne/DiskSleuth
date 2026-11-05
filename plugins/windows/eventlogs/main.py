"""Key events from the Windows event logs.

The .evtx files are exported from the evidence and queried with the built-in Windows tool
``wevtutil qe <file> /lf:true /f:xml``, filtered by event ID with an XPath query."""
import os
import re
import subprocess
import sys
import xml.etree.ElementTree as ET

LOGS = "/Windows/System32/winevt/Logs/"
NS = "{http://schemas.microsoft.com/win/2004/08/events/event}"
LOGON_TYPES = {2: "2 Interactive", 3: "3 Network", 4: "4 Batch", 5: "5 Service", 7: "7 Unlock", 8: "8 Network cleartext",
               9: "9 New credentials", 10: "10 Remote interactive (RDP)", 11: "11 Cached interactive"}
RDP_LOG = "Microsoft-Windows-TerminalServices-LocalSessionManager%4Operational.evtx"
HEX_BLOB = re.compile(r"^[0-9A-Fa-f]{16,}$")
NOISY_USERS = {"SYSTEM", "LOCAL SERVICE", "NETWORK SERVICE", "ANONYMOUS LOGON"}

SECURITY_LOGON = {4624: "Logon", 4625: "Logon failed", 4634: "Logoff", 4647: "User initiated logoff",
                  4648: "Logon with explicit credentials", 4778: "Session reconnected", 4779: "Session disconnected"}
SECURITY_CHANGES = {4720: "User account created", 4722: "User account enabled", 4723: "Password change attempted",
                    4724: "Password reset", 4725: "User account disabled", 4726: "User account deleted",
                    4732: "Member added to local group", 4733: "Member removed from local group",
                    4738: "User account changed", 4740: "User account locked out", 1102: "Security log cleared",
                    4697: "Service installed", 4719: "Audit policy changed", 4616: "System time changed"}
SYSTEM_EVENTS = {6005: "Event log service started (boot)", 6006: "Event log service stopped (shutdown)",
                 6008: "Unexpected shutdown", 6009: "OS version at boot", 6013: "System uptime",
                 1074: "Shutdown or restart initiated", 7045: "Service installed", 104: "Log cleared",
                 12: "Operating system started", 13: "Operating system shutting down", 41: "Rebooted without a clean shutdown"}
RDP_EVENTS = {21: "RDP session logon", 22: "RDP shell start", 23: "RDP session logoff", 24: "RDP session disconnected",
              25: "RDP session reconnected"}


def query(path: str, ids) -> list:
    """Run wevtutil on an exported .evtx and return the parsed <Event> elements (newest first)."""
    xpath = "*[System[(" + " or ".join(f"EventID={i}" for i in ids) + ")]]"
    p = subprocess.run(["wevtutil", "qe", path, "/lf:true", "/f:xml", "/rd:true", "/e:Events", f"/q:{xpath}"],
                       capture_output=True, creationflags=0x08000000)  # CREATE_NO_WINDOW
    if p.returncode != 0:
        raise RuntimeError((decode(p.stderr) or decode(p.stdout)).strip() or f"wevtutil exit code {p.returncode}")
    return list(ET.fromstring(decode(p.stdout)))


def decode(b: bytes) -> str:
    if b.startswith(b"\xff\xfe") or (len(b) > 1 and b[1] == 0):
        return b.decode("utf-16-le", "replace").lstrip("﻿")
    try:
        return b.decode("utf-8")
    except UnicodeDecodeError:
        return b.decode("mbcs", "replace")


def fields(ev) -> dict:
    """System fields + EventData/UserData values of one event."""
    sysn = ev.find(NS + "System")
    out = {
        "id": int(sysn.findtext(NS + "EventID") or 0),
        "time": (sysn.find(NS + "TimeCreated").get("SystemTime") or "")[:19].replace("T", " "),
        "record": sysn.findtext(NS + "EventRecordID") or "",
        "provider": (sysn.find(NS + "Provider").get("Name") or "") if sysn.find(NS + "Provider") is not None else "",
        "computer": sysn.findtext(NS + "Computer") or "",
    }
    data = {}
    ed = ev.find(NS + "EventData")
    if ed is not None:
        for i, d in enumerate(ed):
            data[d.get("Name") or f"param{i + 1}"] = (d.text or "").strip()
    ud = ev.find(NS + "UserData")
    if ud is not None:
        for el in ud.iter():
            if len(el) == 0 and el.text:
                data[el.tag.split("}")[-1]] = el.text.strip()
    out["data"] = data
    return out


def export(ctx, name: str):
    st = ctx.stat(LOGS + name)
    if st is None or st["size"] == 0:
        return None
    return ctx.export(LOGS + name, dest_dir=os.path.join(ctx.workdir, "evtx"))


def run(ctx):
    if sys.platform != "win32":
        raise RuntimeError("this plugin uses the Windows wevtutil tool and runs on Windows only")

    sec = export(ctx, "Security.evtx")
    if sec:
        ctx.progress(0.1, "Security.evtx")
        skipped = 0
        for ev in map(fields, query(sec, list(SECURITY_LOGON) + list(SECURITY_CHANGES))):
            d, eid = ev["data"], ev["id"]
            src = f"Security.evtx #{ev['record']}"
            if eid in SECURITY_LOGON:
                user = d.get("TargetUserName") or d.get("AccountName") or d.get("SubjectUserName", "")
                lt = int(d.get("LogonType") or 0) if (d.get("LogonType") or "").isdigit() else 0
                if eid in (4624, 4634) and (lt == 5 or user.upper() in NOISY_USERS or user.startswith(("DWM-", "UMFD-"))):
                    skipped += 1  # service and system logons: thousands of them, rarely of interest
                    continue
                ctx.emit("evt_logons", {
                    "time": ev["time"], "eventId": eid, "event": SECURITY_LOGON[eid], "user": user,
                    "domain": d.get("TargetDomainName") or d.get("AccountDomain", ""),
                    "logonType": LOGON_TYPES.get(lt, str(lt or "")),
                    "ip": "" if d.get("IpAddress") in ("-", None) else d["IpAddress"],
                    "workstation": "" if d.get("WorkstationName") in ("-", None) else d["WorkstationName"],
                    "process": d.get("ProcessName") or d.get("LogonProcessName", ""),
                    "logonId": d.get("TargetLogonId", ""), "log": "Security", "source": src,
                }, file=LOGS + "Security.evtx")
            else:
                target = d.get("TargetUserName") or d.get("MemberName") or d.get("ServiceName") or ""
                if d.get("TargetDomainName") and d.get("TargetUserName"):
                    target = f"{d['TargetDomainName']}\\{d['TargetUserName']}"
                detail = ", ".join(f"{k}={v}" for k, v in d.items()
                                   if v and v != "-" and k not in ("SubjectUserSid", "SubjectDomainName", "SubjectLogonId", "TargetSid"))
                ctx.emit("evt_security", {"time": ev["time"], "eventId": eid, "event": SECURITY_CHANGES[eid],
                                          "subject": d.get("SubjectUserName", ""), "target": target, "detail": detail, "source": src}, file=LOGS + "Security.evtx")
        ctx.log(f"Security.evtx: skipped {skipped} service / system account logon events")

    rdp = export(ctx, RDP_LOG)
    if rdp:
        ctx.progress(0.6, "TerminalServices")
        for ev in map(fields, query(rdp, list(RDP_EVENTS))):
            d = ev["data"]
            user = d.get("User", "")
            ctx.emit("evt_logons", {
                "time": ev["time"], "eventId": ev["id"], "event": RDP_EVENTS[ev["id"]],
                "user": user.split("\\")[-1], "domain": user.split("\\")[0] if "\\" in user else "",
                "logonType": "10 Remote interactive (RDP)", "ip": d.get("Address", ""), "workstation": "",
                "process": "", "logonId": d.get("SessionID", ""), "log": "LocalSessionManager",
                "source": f"TerminalServices-LocalSessionManager #{ev['record']}",
            }, file=LOGS + RDP_LOG)

    system = export(ctx, "System.evtx")
    if system:
        ctx.progress(0.8, "System.evtx")
        for ev in map(fields, query(system, list(SYSTEM_EVENTS))):
            eid, d = ev["id"], ev["data"]
            # IDs 12/13/41/104 are reused by other providers; keep only the ones we mean
            if eid in (12, 13) and ev["provider"] != "Microsoft-Windows-Kernel-General":
                continue
            if eid == 41 and ev["provider"] != "Microsoft-Windows-Kernel-Power":
                continue
            if eid == 104 and ev["provider"] != "Microsoft-Windows-Eventlog":
                continue
            if eid == 7045:
                detail = f"{d.get('ServiceName', '')}: {d.get('ImagePath', '')} ({d.get('StartType', '')}, {d.get('AccountName', '')})"
            else:
                vals = {k: v for k, v in d.items() if v and len(v) < 300 and not HEX_BLOB.match(v)}  # drop binary data
                detail = ", ".join(f"{k}={v}" for k, v in vals.items() if not k.startswith("param")) \
                    or ", ".join(vals.values())
            ctx.emit("evt_system", {"time": ev["time"], "eventId": eid, "event": SYSTEM_EVENTS[eid],
                                    "provider": ev["provider"], "detail": detail, "source": f"System.evtx #{ev['record']}"}, file=LOGS + "System.evtx")
