"""Bounded read-only Config.Cipher scan for the audited Windows build.

Adapted from the pinned Apache-2.0 scanner listed in NOTICE.md. Raw key
fallback, printing, output files, and process discovery were removed.
"""

import ctypes as c
from ctypes import wintypes as w
import hashlib
import hmac
import re
import struct
import time

PAGE_SIZE = 4096
SQLITE_HEADER = b"SQLite format 3\x00"
CONFIG_NAME = b"com.Tencent.WCDB.Config.Cipher"
CONFIG_MASK = bytes.fromhex("d2c7442458020000004889442450488b450048844c2448488944254048584c24")
LITERAL = re.compile(rb"[xX]'([0-9a-fA-F]{64,192})'")
MAX_ADDRESS = 0x0000800000000000
READABLE = {0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80}


class MemoryRegion(c.Structure):
    _fields_ = [("base", c.c_uint64), ("allocation", c.c_uint64), ("allocation_protect", w.DWORD),
                ("padding", w.DWORD), ("size", c.c_uint64), ("state", w.DWORD),
                ("protect", w.DWORD), ("kind", w.DWORD), ("padding2", w.DWORD)]


def verify_key(key, page):
    if len(key) != 32 or len(page) != PAGE_SIZE or page.startswith(SQLITE_HEADER):
        return False
    salt = bytes(value ^ 0x3A for value in page[:16])
    mac_key = hashlib.pbkdf2_hmac("sha512", key, salt, 2, dklen=32)
    mac = hmac.digest(mac_key, page[16:4032] + struct.pack("<I", 1), "sha512")
    return hmac.compare_digest(mac, page[4032:])


def config_candidates(blob):
    decoded = bytes(value ^ CONFIG_MASK[i % len(CONFIG_MASK)] for i, value in enumerate(blob))
    for match in LITERAL.finditer(decoded):
        value = match.group(1)
        starts = [0]
        if len(value) > 96:
            starts += list(range(32, len(value) - 63, 32)) + [len(value) - 64]
        for start in dict.fromkeys(starts):
            key = bytes.fromhex(value[start:start + 64].decode("ascii"))
            if len(set(key)) >= 15:
                salt = value[start + 64:start + 96]
                yield key, bytes.fromhex(salt.decode("ascii")) if len(salt) == 32 else None


def scan_keys(kernel, handle, pages):
    """Return in-memory raw keys indexed only by validated page salts."""
    if not pages:
        return {}
    query = kernel.VirtualQueryEx
    query.argtypes = (w.HANDLE, c.c_uint64, c.POINTER(MemoryRegion), c.c_size_t)
    query.restype = c.c_size_t
    read_memory = kernel.ReadProcessMemory
    read_memory.argtypes = (w.HANDLE, c.c_uint64, c.c_void_p, c.c_size_t, c.POINTER(c.c_size_t))
    read_memory.restype = w.BOOL
    deadline = time.monotonic() + 28
    budget = 3 * 1024**3

    def check_budget():
        if budget < 0 or time.monotonic() >= deadline:
            raise TimeoutError

    def read(address, size):
        nonlocal budget
        budget -= size
        check_budget()
        if not 0x10000 <= address < MAX_ADDRESS or address + size > MAX_ADDRESS:
            return b""
        buffer = c.create_string_buffer(size)
        actual = c.c_size_t()
        if not read_memory(handle, address, buffer, size, c.byref(actual)):
            return b""
        return buffer.raw[:actual.value]

    regions = []
    address = 0
    region = MemoryRegion()
    while address < MAX_ADDRESS and len(regions) < 100_000:
        check_budget()
        if not query(handle, address, c.byref(region), c.sizeof(region)):
            break
        if region.state == 0x1000 and region.protect in READABLE and 0 < region.size < 500 * 1024**2:
            regions.append((region.base, region.size))
        end = region.base + region.size
        if end <= address:
            break
        address = end

    def chunks(overlap):
        for base, size in regions:
            tail = b""
            step = 2 * 1024**2
            for offset in range(0, size, step):
                count = min(step, size - offset)
                part = read(base + offset, count)
                if len(part) != count:
                    tail = b""
                    continue
                data = tail + part
                yield base + offset - len(tail), data
                tail = data[-overlap:]

    addresses = set()
    keys = {}
    try:
        for base, data in chunks(len(CONFIG_NAME) - 1):
            offset = data.find(CONFIG_NAME)
            while offset >= 0:
                addresses.add(base + offset)
                if len(addresses) > 256:
                    raise TimeoutError
                offset = data.find(CONFIG_NAME, offset + 1)
        pointers = [struct.pack("<QQ", address, len(CONFIG_NAME)) for address in sorted(addresses)]
        if not pointers:
            return keys
        checked = set()
        remaining = dict(pages)
        for base, data in chunks(0x80):
            for pointer in pointers:
                check_budget()
                offset = data.find(pointer)
                while offset >= 0:
                    node = read(base + offset - 0x10, 0x50)
                    offset = data.find(pointer, offset + 1)
                    if len(node) < 0x40 or node[0x10:0x20] != pointer:
                        continue
                    config = struct.unpack_from("<Q", node, 0x28)[0]
                    obj = read(config + 0x88, 0x28) if 0x10000 <= config < MAX_ADDRESS else b""
                    if len(obj) < 0x18:
                        continue
                    target, size = struct.unpack_from("<QQ", obj, 8)
                    blob = read(target, size) if 0 < size <= 1024 else b""
                    for key, embedded_salt in config_candidates(blob):
                        candidate = key, embedded_salt
                        if candidate in checked:
                            continue
                        if len(checked) >= 8192:
                            raise TimeoutError
                        checked.add(candidate)
                        salts = [embedded_salt] if embedded_salt in remaining else list(remaining)
                        for salt in salts:
                            if verify_key(key, remaining[salt]):
                                keys[salt] = key
                                del remaining[salt]
                        if not remaining:
                            return keys
    except TimeoutError:
        if not keys:
            raise
    return keys
