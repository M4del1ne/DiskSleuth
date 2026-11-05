"""Network configuration: TCP/IP interfaces (SYSTEM) and known network profiles (SOFTWARE NetworkList)."""
import struct
from datetime import datetime

from disksleuth import unix_to_text
from winreg_util import (CONFIG, as_bytes, current_control_set, get_key, get_value, get_value_of, key_last_write, open_hive,
                         subkeys, try_open_hive)

NET_CLASS = r"\Control\Network\{4D36E972-E325-11CE-BFC1-08002BE10318}"
NETWORK_LIST = r"\Microsoft\Windows NT\CurrentVersion\NetworkList"
NAME_TYPES = {0x47: "Wireless", 0x06: "Wired", 0x17: "Mobile broadband", 0xF3: "Mobile broadband"}
CATEGORIES = {0: "Public", 1: "Private", 2: "Domain"}


def joined(v) -> str:
    """REG_MULTI_SZ / comma or space separated strings -> 'a, b'."""
    if v is None:
        return ""
    if isinstance(v, (list, tuple)):
        return ", ".join(str(x) for x in v if x and str(x) != "0.0.0.0")
    return ", ".join(x for x in str(v).replace(",", " ").split() if x and x != "0.0.0.0")


def systemtime(b: bytes) -> str:
    """16-byte SYSTEMTIME (year, month, weekday, day, hour, minute, second, ms) -> text."""
    if len(b) < 16:
        return ""
    y, mo, _wd, d, h, mi, s, _ms = struct.unpack_from("<8H", b)
    try:
        return datetime(y, mo, d, h, mi, s).strftime("%Y-%m-%d %H:%M:%S")
    except ValueError:
        return ""


def adapter_names(software) -> dict[str, str]:
    """Interface GUID (upper case) -> adapter description, from SOFTWARE NetworkCards."""
    out = {}
    for k in subkeys(get_key(software, r"\Microsoft\Windows NT\CurrentVersion\NetworkCards")) if software else []:
        guid = str(get_value_of(k, "ServiceName") or "").upper()
        if guid:
            out[guid] = str(get_value_of(k, "Description") or "")
    return out


def run(ctx):
    system = open_hive(ctx, CONFIG + "SYSTEM")
    software = try_open_hive(ctx, CONFIG + "SOFTWARE")
    cs = current_control_set(system)
    adapters = adapter_names(software)

    base = rf"\{cs}\Services\Tcpip\Parameters\Interfaces"
    for k in subkeys(get_key(system, base)):
        guid = k.name.upper()
        p = rf"{base}\{k.name}"
        dhcp = get_value(system, p, "EnableDHCP") == 1
        ip = get_value(system, p, "DhcpIPAddress") if dhcp else get_value(system, p, "IPAddress")
        row = {
            "connection": get_value(system, rf"\{cs}{NET_CLASS}\{k.name}\Connection", "Name"),
            "adapter": adapters.get(guid, ""),
            "dhcp": dhcp,
            "ip": joined(ip),
            "mask": joined(get_value(system, p, "DhcpSubnetMask") if dhcp else get_value(system, p, "SubnetMask")),
            "gateway": joined(get_value(system, p, "DhcpDefaultGateway") if dhcp else get_value(system, p, "DefaultGateway")),
            "dns": joined(get_value(system, p, "NameServer") or get_value(system, p, "DhcpNameServer")),
            "dhcpServer": joined(get_value(system, p, "DhcpServer")) if dhcp else "",
            "domain": get_value(system, p, "Domain") or get_value(system, p, "DhcpDomain"),
            "leaseObtained": unix_to_text(get_value(system, p, "LeaseObtainedTime")) if dhcp else "",
            "leaseExpires": unix_to_text(get_value(system, p, "LeaseTerminatesTime")) if dhcp else "",
            "lastWrite": key_last_write(k),
            "guid": k.name,
            "source": f"SYSTEM{p}",
        }
        # skip empty interfaces (tunnels, adapters that never got an address)
        if row["ip"] or row["gateway"] or row["dhcpServer"] or row["connection"]:
            ctx.emit("netifaces", row, file=CONFIG + "SYSTEM")
    ctx.progress(0.5, "NetworkList")

    if software is None:
        return
    # signatures carry the gateway MAC and DNS suffix; they point at a profile by ProfileGuid
    sigs = {}
    for kind in ("Unmanaged", "Managed"):
        for k in subkeys(get_key(software, rf"{NETWORK_LIST}\Signatures\{kind}")):
            pg = str(get_value_of(k, "ProfileGuid") or "").upper()
            mac = as_bytes(get_value_of(k, "DefaultGatewayMac"))
            sigs[pg] = {
                "gatewayMac": "-".join(f"{b:02X}" for b in mac[:6]) if mac else "",
                "dnsSuffix": str(get_value_of(k, "DnsSuffix") or "").replace("<none>", ""),
            }
    for k in subkeys(get_key(software, rf"{NETWORK_LIST}\Profiles")):
        sig = sigs.get(k.name.upper(), {})
        ctx.emit("netprofiles", {
            "name": get_value_of(k, "ProfileName"),
            "type": NAME_TYPES.get(get_value_of(k, "NameType"), str(get_value_of(k, "NameType") or "")),
            "category": CATEGORIES.get(get_value_of(k, "Category"), ""),
            "firstConnected": systemtime(as_bytes(get_value_of(k, "DateCreated"))),
            "lastConnected": systemtime(as_bytes(get_value_of(k, "DateLastConnected"))),
            "gatewayMac": sig.get("gatewayMac", ""),
            "dnsSuffix": sig.get("dnsSuffix", ""),
            "description": get_value_of(k, "Description"),
            "source": rf"SOFTWARE{NETWORK_LIST}\Profiles\{k.name}",
        }, file=CONFIG + "SOFTWARE")
