"""Helpers for Windows registry plugins (built on regipy)."""
from __future__ import annotations

import codecs
import logging
import struct
from typing import Iterator

from regipy.registry import RegistryHive

from disksleuth import Context, PluginError, filetime_to_text

logging.getLogger("regipy").setLevel(logging.ERROR)

CONFIG = "/Windows/System32/config/"


def open_hive(ctx: Context, target) -> RegistryHive:
    """Export a hive from the evidence and open it. target is a path (e.g. '/Windows/System32/config/SYSTEM') or an entry dict."""
    return RegistryHive(ctx.export(target))


def try_open_hive(ctx: Context, target) -> RegistryHive | None:
    """Like open_hive but returns None (and logs) when the hive is missing or unreadable."""
    try:
        if isinstance(target, str) and not ctx.exists(target):
            return None
        return open_hive(ctx, target)
    except Exception as e:  # damaged or partially overwritten hives are common on deleted profiles
        ctx.log(f"cannot open hive {target if isinstance(target, str) else target.get('path')}: {e}")
        return None


def user_hives(ctx: Context, kind: str = "NTUSER.DAT") -> Iterator[tuple[str, str, RegistryHive]]:
    """Yield (user name, hive path, hive) for every profile that has the hive.
    kind is "NTUSER.DAT" or "UsrClass.dat" (AppData/Local/Microsoft/Windows/UsrClass.dat on Vista+)."""
    for prof in ctx.user_profiles():
        if kind.lower() == "usrclass.dat":
            candidates = [prof["path"] + "/AppData/Local/Microsoft/Windows/UsrClass.dat",
                          prof["path"] + "/Local Settings/Application Data/Microsoft/Windows/UsrClass.dat"]
        else:
            candidates = [prof["path"] + "/" + kind]
        for path in candidates:
            hive = try_open_hive(ctx, path)
            if hive is not None:
                yield prof["name"], path, hive
                break


def get_key(hive: RegistryHive, key_path: str):
    """Return the key or None."""
    try:
        return hive.get_key(key_path)
    except Exception:
        return None


def get_value(hive: RegistryHive, key_path: str, name: str, default=None):
    """Read a value; default when missing. REG_SZ is cut at the first \\0 (Win7 often leaves junk after it)."""
    try:
        v = hive.get_key(key_path).get_value(name, case_sensitive=False)
    except Exception:
        return default
    if v is None:
        return default
    if isinstance(v, str):
        v = v.split("\x00", 1)[0]
    return v


def values(key) -> Iterator[tuple[str, object]]:
    """Yield (name, value) of a key; strings are cut at the first \\0."""
    if key is None:
        return
    try:
        for v in key.iter_values(trim_values=False):  # regipy trims to 256 bytes by default
            val = v.value
            if isinstance(val, str):
                val = val.split("\x00", 1)[0]
            yield v.name, val
    except Exception:
        return


def subkeys(key) -> list:
    if key is None:
        return []
    try:
        return list(key.iter_subkeys())
    except Exception:
        return []


def as_bytes(v) -> bytes:
    """regipy sometimes returns binary values as hex strings; always return bytes."""
    if isinstance(v, (bytes, bytearray)):
        return bytes(v)
    if isinstance(v, str):
        try:
            return bytes.fromhex(v)
        except ValueError:
            return v.encode("utf-8", "replace")
    return b""


def utf16z(b: bytes) -> str:
    """Decode a NUL-terminated UTF-16LE string."""
    s = b.decode("utf-16-le", "replace")
    return s.split("\x00", 1)[0]


def current_control_set(system: RegistryHive) -> str:
    """Return a name like 'ControlSet001' (from SYSTEM\\Select\\Current)."""
    n = get_value(system, r"\Select", "Current", 1)
    return f"ControlSet{int(n):03d}"


def key_last_write(key) -> str:
    """Last write time of a key (UTC text)."""
    try:
        return filetime_to_text(key.header.last_modified)
    except Exception:
        return ""


def signed32(v) -> int:
    return struct.unpack("<i", struct.pack("<I", int(v) & 0xFFFFFFFF))[0]


def rot13(s: str) -> str:
    return codecs.decode(s, "rot_13")


def mru_order(key) -> list[int]:
    """Order of an MRUListEx value (list of uint32 indexes ending with 0xFFFFFFFF)."""
    raw = as_bytes(get_value_of(key, "MRUListEx"))
    out = []
    for i in range(0, len(raw) - 3, 4):
        n = struct.unpack_from("<I", raw, i)[0]
        if n == 0xFFFFFFFF:
            break
        out.append(n)
    return out


def get_value_of(key, name: str, default=None):
    if key is None:
        return default
    try:
        v = key.get_value(name, case_sensitive=False)
    except Exception:
        return default
    return default if v is None else v


__all__ = [
    "CONFIG", "PluginError", "open_hive", "try_open_hive", "user_hives", "get_key", "get_value", "get_value_of",
    "values", "subkeys", "as_bytes", "utf16z", "current_control_set", "key_last_write", "signed32", "rot13", "mru_order",
]
