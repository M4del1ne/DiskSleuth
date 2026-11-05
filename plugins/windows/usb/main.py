"""USB devices: SYSTEM\\<ControlSet>\\Enum\\USBSTOR (storage), Enum\\USB (all USB devices) and MountedDevices."""
import struct
import uuid

from winreg_util import (CONFIG, as_bytes, current_control_set, get_key, get_value, get_value_of, key_last_write, open_hive,
                         subkeys, try_open_hive, values)

WPD = r"\Microsoft\Windows Portable Devices\Devices"


def parse_class(name: str) -> dict:
    """'Disk&Ven_Kingston&Prod_DataTraveler_3.0&Rev_PMAP' -> vendor / product / revision"""
    out = {"vendor": "", "product": "", "revision": ""}
    for part in name.split("&"):
        for prefix, key in (("Ven_", "vendor"), ("Prod_", "product"), ("Rev_", "revision")):
            if part.startswith(prefix):
                out[key] = part[len(prefix):].replace("_", " ").strip()
    return out


def clean(desc) -> str:
    """DeviceDesc is often '@usb.inf,%usb.devicedesc%;USB Composite Device'; keep the readable part after ';'."""
    s = str(desc or "")
    return s.split(";")[-1].strip() if s.startswith("@") else s


def volume_names(software) -> dict[str, str]:
    """Serial (upper case) -> volume label or drive letter, from Windows Portable Devices."""
    out = {}
    for k in subkeys(get_key(software, WPD)) if software else []:
        name = get_value_of(k, "FriendlyName")
        parts = k.name.upper().split("#")
        # ...#USBSTOR#DISK&VEN_X&PROD_Y&REV_Z#<SERIAL>&0#{GUID}
        i = next((n for n, x in enumerate(parts) if x.endswith("USBSTOR")), -1)  # "USBSTOR" or "_??_USBSTOR"
        if i >= 0 and name and i + 2 < len(parts):
            out[parts[i + 2]] = str(name)
    return out




def run(ctx):
    system = open_hive(ctx, CONFIG + "SYSTEM")
    software = try_open_hive(ctx, CONFIG + "SOFTWARE")
    cs = current_control_set(system)
    labels = volume_names(software)
    mounts = [(name, *describe_mount(as_bytes(data))) for name, data in values(get_key(system, r"\MountedDevices"))]

    stor = rf"\{cs}\Enum\USBSTOR"
    classes = subkeys(get_key(system, stor))
    if not classes:
        ctx.log("no USBSTOR key (no USB storage device was ever attached)")
    for cls in classes:
        info = parse_class(cls.name)
        for inst in subkeys(cls):
            p = rf"{stor}\{cls.name}\{inst.name}"
            ctx.emit("usbstor", {
                "friendlyName": get_value(system, p, "FriendlyName"),
                **info,
                # a suffix like '&0' is an instance number added by Windows
                "serial": inst.name.rsplit("&", 1)[0] if inst.name.count("&") == 1 else inst.name,
                "volumeName": labels.get(inst.name.upper(), ""),
                "drive": drive_letter(mounts, inst.name),
                "lastWrite": key_last_write(inst),
                "source": f"SYSTEM{p}",
            }, file=CONFIG + "SYSTEM")
    ctx.progress(0.4, "Enum\\USB")

    usb = rf"\{cs}\Enum\USB"
    for dev in subkeys(get_key(system, usb)):
        if not dev.name.upper().startswith("VID_"):
            continue  # ROOT_HUB etc.
        for inst in subkeys(dev):
            p = rf"{usb}\{dev.name}\{inst.name}"
            ctx.emit("usb", {
                "vidpid": dev.name,
                "description": clean(get_value(system, p, "FriendlyName") or get_value(system, p, "DeviceDesc")),
                "serial": inst.name,
                "lastWrite": key_last_write(inst),
                "source": f"SYSTEM{p}",
            }, file=CONFIG + "SYSTEM")
    ctx.progress(0.8, "MountedDevices")

    for name, kind, detail in mounts:
        ctx.emit("mounted", {
            "name": name.replace("\\DosDevices\\", "").replace("\\??\\", ""),
            "kind": "Drive letter" if name.startswith("\\DosDevices\\") else "Volume GUID",
            "detail": f"{kind}: {detail}" if kind else detail,
            "source": rf"SYSTEM\MountedDevices > {name}",
        }, file=CONFIG + "SYSTEM")


def drive_letter(mounts, instance: str) -> str:
    """Drive letter whose MountedDevices entry points at this USBSTOR instance (last known assignment)."""
    serial = "#" + instance.upper() + "#"
    for name, kind, detail in mounts:
        if name.startswith("\\DosDevices\\") and kind == "Device" and serial in detail.upper():
            return name[len("\\DosDevices\\"):]
    return ""


def describe_mount(b: bytes) -> tuple[str, str]:
    """MountedDevices data: 12 bytes = MBR disk signature + partition offset; 'DMIO:ID:' + GUID = GPT partition;
    otherwise a UTF-16 device path such as \\??\\USBSTOR#Disk&Ven_...#serial&0#{guid}."""
    if len(b) == 12:
        sig, off = struct.unpack("<IQ", b)
        return "MBR disk", f"signature {sig:08X}, offset {off}"
    if b.startswith(b"DMIO:ID:") and len(b) >= 24:
        return "GPT partition", "{" + str(uuid.UUID(bytes_le=b[8:24])).upper() + "}"
    try:
        s = b.decode("utf-16-le").strip("\x00")
        if s.isprintable():
            return "Device", s
    except UnicodeDecodeError:
        pass
    return "", b.hex()
