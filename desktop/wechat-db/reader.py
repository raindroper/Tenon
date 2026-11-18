"""Local JSONL worker for selected WeChat 4.1.15.56 conversations."""

import base64
from contextlib import closing, contextmanager
import ctypes as c
from ctypes import wintypes as w
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import time

from scanner import PAGE_SIZE, SQLITE_HEADER, scan_keys, verify_key

try:
    from compression import zstd
except ImportError:
    zstd = None


MAX_CHATS = 500
MAX_ROWS = 20
MAX_TEXT = 24 * 1024
MAX_MESSAGE = 256 * 1024
MAX_TEXT_UNITS = 4000
MAX_TITLE_UNITS = 200
MAX_SHARDS = 32
MAX_CURSOR = 16 * 1024
MAX_REQUEST = 24 * 1024
MAX_DB = 512 * 1024**2
MAX_WAL = 64 * 1024**2
INT_MAX = 2**63 - 1
AUDITED_IMAGE = "932125cf49bd995345d2c3b1ace0ca8b6cfe5af9ab3f61413a4816a3845312ea"
SHARD_NAME = re.compile(r"message_[0-9]{1,6}\.db")
HEX_ID = re.compile(r"[0-9a-f]{64}")
CHAT_NAME = re.compile(r"[A-Za-z0-9_@.-]{1,128}")
PSEUDO_CHATS = {"brandsessionholder", "fmessage", "newsapp", "notifymessage", "qqmail", "weixin"}
CONTROL_TEXT = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


class ReaderError(Exception):
    """A fixed error code safe to expose across the local protocol."""


def fingerprint(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def chat_table(chat_id):
    return "Msg_" + hashlib.md5(chat_id.encode("ascii"), usedforsecurity=False).hexdigest()


def supported_chat(chat_id):
    return (isinstance(chat_id, str) and CHAT_NAME.fullmatch(chat_id) and chat_id not in PSEUDO_CHATS
            and not chat_id.startswith("gh_") and ("@" not in chat_id or chat_id.endswith("@chatroom")))


def stat_key(info):
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns


def file_signature(path):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    attributes = getattr(info, "st_file_attributes", 0)
    if not stat.S_ISREG(info.st_mode) or attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
        raise ReaderError("database-unreadable")
    return stat_key(info)


def wal_for(path):
    return path.with_name(path.name + "-wal")


def source_signature(path):
    info = file_signature(path)
    wal = file_signature(wal_for(path))
    if not info or info[2] < PAGE_SIZE:
        raise ReaderError("database-unreadable")
    if info[2] > MAX_DB or (wal and wal[2] > MAX_WAL):
        raise ReaderError("database-too-large")
    return info, wal


def first_page(path):
    with path.open("rb") as stream:
        page = stream.read(PAGE_SIZE)
    if len(page) != PAGE_SIZE or page.startswith(SQLITE_HEADER):
        raise ReaderError("database-unreadable")
    return page


def local_path(path, kernel):
    """Accept fixed-drive paths without traversing junctions or symlinks."""
    path = Path(os.path.normpath(path))
    if not path.is_absolute() or not re.fullmatch(r"[A-Za-z]:\\", path.anchor):
        return None
    if kernel.GetDriveTypeW(path.anchor) != 3:
        return None
    current = Path(path.anchor)
    for part in path.parts[1:]:
        if ":" in part or part in (".", ".."):
            return None
        current /= part
        try:
            attrs = current.lstat().st_file_attributes
        except OSError:
            return None
        if attrs & stat.FILE_ATTRIBUTE_REPARSE_POINT:
            return None
    return path.resolve(strict=True)


def candidate_roots(kernel):
    import winreg

    candidates = []
    for variable in ("APPDATA", "LOCALAPPDATA"):
        value = os.environ.get(variable)
        if not value:
            continue
        for rel in ("Tencent/xwechat", "Tencent/xwechat/config", "Tencent/WeChat"):
            directory = local_path(Path(value) / rel, kernel)
            if not directory or not directory.is_dir():
                continue
            for path in sorted(directory.iterdir())[:64]:
                if not local_path(path, kernel) or not path.is_file():
                    continue
                try:
                    with path.open("rb") as stream:
                        raw = stream.read(8192)
                    try:
                        value = raw.decode("utf-8-sig").strip()
                    except UnicodeDecodeError:
                        value = raw.decode("gbk").strip()
                except (OSError, UnicodeDecodeError):
                    continue
                try:
                    parsed = json.loads(value)
                except ValueError:
                    parsed = value
                if isinstance(parsed, dict):
                    candidates.extend(parsed.get(name) for name in (
                        "dataDir", "data_dir", "fileSavePath", "savePath", "path", "defaultFileSavePath"))
                elif isinstance(parsed, list):
                    candidates.extend(parsed[:16])
                elif isinstance(parsed, str):
                    candidates.append(parsed)
    for subkey in (r"Software\Tencent\xwechat", r"Software\Tencent\xwechat\config", r"Software\Tencent\WeChat"):
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, subkey) as key:
                for index in range(64):
                    try:
                        name, value, _ = winreg.EnumValue(key, index)
                    except OSError:
                        break
                    if any(word in name.lower() for word in ("path", "dir", "save")):
                        candidates.append(value)
        except OSError:
            continue
    home = os.environ.get("USERPROFILE")
    if home:
        candidates += [str(Path(home) / "Documents"), home]
    roots = set()
    for value in candidates:
        if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z]:[\\/][^\x00-\x1f]{0,1024}", value):
            continue
        base = local_path(value, kernel)
        if not base or not base.is_dir():
            continue
        roots.add(base)
        for name in ("xwechat_files", "WeChat Files", "xwechat_files_data"):
            path = local_path(base / name, kernel)
            if path and path.is_dir():
                roots.add(path)
    return sorted(roots)


@dataclass(frozen=True)
class Account:
    folder: Path

    @property
    def id(self):
        return fingerprint("another-rae-wechat-account-v1\0" + os.path.normcase(str(self.folder)))

    @property
    def session(self):
        return self.folder / "db_storage" / "session" / "session.db"

    @property
    def contact(self):
        return self.folder / "db_storage" / "contact" / "contact.db"

    def message_shards(self, kernel):
        directory = self.folder / "db_storage" / "message"
        if local_path(directory, kernel) != directory or not directory.is_dir():
            raise ReaderError("database-unreadable")
        files = {}
        for path in directory.iterdir():
            if not SHARD_NAME.fullmatch(path.name):
                continue
            if len(files) == MAX_SHARDS:
                raise ReaderError("database-too-large")
            if local_path(path, kernel) != path:
                raise ReaderError("database-unreadable")
            files[path.name] = path
        if not files:
            raise ReaderError("database-unreadable")
        return dict(sorted(files.items()))


def accounts(kernel):
    found = set()
    for root in candidate_roots(kernel):
        if root.name.casefold() in {"xwechat_files", "wechat files", "xwechat_files_data"}:
            children = root.iterdir()
        else:
            children = (entry for entry in root.iterdir() if CHAT_NAME.fullmatch(entry.name))
        for entry in children:
            if not CHAT_NAME.fullmatch(entry.name):
                continue
            account = Account(entry)
            session = local_path(account.session, kernel)
            if session == account.session and session.is_file():
                found.add(account)
                if len(found) > 16:
                    raise ReaderError("account-ambiguous")
    return sorted(found, key=lambda account: account.id)


class ProcessKey(c.Structure):
    _fields_ = [("pid", w.DWORD), ("creation", w.FILETIME)]


class ProcessInfo(c.Structure):
    _fields_ = [("process", ProcessKey), ("name", w.WCHAR * 256), ("service", w.WCHAR * 64),
                ("kind", w.UINT), ("status", w.ULONG), ("session", w.DWORD), ("restartable", w.BOOL)]


def filetime(value):
    return value.dwHighDateTime << 32 | value.dwLowDateTime


class WindowsSource:
    def __init__(self):
        self.kernel = c.WinDLL("kernel32", use_last_error=True)
        self.kernel.GetDriveTypeW.argtypes = (w.LPCWSTR,)
        self.kernel.GetDriveTypeW.restype = w.UINT
        self.kernel.OpenProcess.argtypes = (w.DWORD, w.BOOL, w.DWORD)
        self.kernel.OpenProcess.restype = w.HANDLE
        self.kernel.CloseHandle.argtypes = (w.HANDLE,)
        self.kernel.CloseHandle.restype = w.BOOL
        self.kernel.GetProcessTimes.argtypes = (w.HANDLE,) + (c.POINTER(w.FILETIME),) * 4
        self.kernel.GetProcessTimes.restype = w.BOOL
        self.kernel.ProcessIdToSessionId.argtypes = (w.DWORD, c.POINTER(w.DWORD))
        self.kernel.ProcessIdToSessionId.restype = w.BOOL
        self.kernel.QueryFullProcessImageNameW.argtypes = (w.HANDLE, w.DWORD, w.LPWSTR, c.POINTER(w.DWORD))
        self.kernel.QueryFullProcessImageNameW.restype = w.BOOL
        self.rm = c.WinDLL("rstrtmgr", use_last_error=True)
        self.rm.RmStartSession.argtypes = (c.POINTER(w.DWORD), w.DWORD, w.LPWSTR)
        self.rm.RmRegisterResources.argtypes = (w.DWORD, w.UINT, c.POINTER(w.LPCWSTR), w.UINT,
                                                 c.POINTER(ProcessKey), w.UINT, c.POINTER(w.LPCWSTR))
        self.rm.RmGetList.argtypes = (w.DWORD, c.POINTER(w.UINT), c.POINTER(w.UINT),
                                     c.POINTER(ProcessInfo), c.POINTER(w.DWORD))
        self.rm.RmEndSession.argtypes = (w.DWORD,)
        self.trusted_image = None
        self.account_cache = None
        self.account_cache_until = 0

    def openers(self, files):
        session = w.DWORD()
        key = c.create_unicode_buffer(33)
        if self.rm.RmStartSession(c.byref(session), 0, key):
            raise ReaderError("database-busy")
        try:
            paths = (w.LPCWSTR * len(files))(*(str(path) for path in files))
            if self.rm.RmRegisterResources(session, len(files), paths, 0, None, 0, None):
                raise ReaderError("database-busy")
            needed, count, reason = w.UINT(), w.UINT(), w.DWORD()
            status = self.rm.RmGetList(session, c.byref(needed), c.byref(count), None, c.byref(reason))
            if status == 0:
                return set()
            if status != 234 or needed.value > 64:
                raise ReaderError("database-busy")
            count.value = needed.value
            values = (ProcessInfo * count.value)()
            status = self.rm.RmGetList(session, c.byref(needed), c.byref(count), values, c.byref(reason))
            if status:
                raise ReaderError("database-busy")
            return {(row.process.pid, filetime(row.process.creation)) for row in values[:count.value]}
        finally:
            self.rm.RmEndSession(session)

    @contextmanager
    def process(self, binding, read=False):
        pid, expected_creation = binding
        handle = self.kernel.OpenProcess(0x0410 if read else 0x1000, False, pid)
        if not handle:
            raise ReaderError("access-denied")
        try:
            process_session, own_session = w.DWORD(), w.DWORD()
            times = [w.FILETIME() for _ in range(4)]
            image = c.create_unicode_buffer(32768)
            length = w.DWORD(len(image))
            if (not self.kernel.GetProcessTimes(handle, *(c.byref(value) for value in times))
                or filetime(times[0]) != expected_creation
                or not self.kernel.ProcessIdToSessionId(pid, c.byref(process_session))
                or not self.kernel.ProcessIdToSessionId(os.getpid(), c.byref(own_session))
                or process_session.value != own_session.value
                or not self.kernel.QueryFullProcessImageNameW(handle, 0, image, c.byref(length))):
                raise ReaderError("account-changed")
            path = Path(image.value)
            if path.name.casefold() != "weixin.exe":
                yield None
                return
            path = local_path(path, self.kernel)
            if not path:
                raise ReaderError("unsupported-version")
            before = file_signature(path)
            if not before or before[2] > 256 * 1024**2:
                raise ReaderError("unsupported-version")
            if self.trusted_image != (path, before):
                with path.open("rb") as stream:
                    digest = hashlib.file_digest(stream, "sha256").hexdigest()
                if digest != AUDITED_IMAGE or before != file_signature(path):
                    raise ReaderError("unsupported-version")
                self.trusted_image = path, before
            yield handle
        finally:
            self.kernel.CloseHandle(handle)

    def active(self, refresh=False):
        if refresh or time.monotonic() >= self.account_cache_until:
            self.account_cache = accounts(self.kernel)
            self.account_cache_until = time.monotonic() + 15
        matched = []
        unsupported = False
        for account in self.account_cache:
            if local_path(account.session, self.kernel) != account.session:
                continue
            wal = wal_for(account.session)
            files = [account.session] + ([wal] if file_signature(wal) else [])
            for binding in self.openers(files):
                try:
                    with self.process(binding) as process:
                        if process:
                            matched.append((account, binding))
                except ReaderError as error:
                    if str(error) == "unsupported-version":
                        unsupported = True
                    elif str(error) not in {"access-denied", "account-changed"}:
                        raise
        if unsupported:
            raise ReaderError("unsupported-version")
        if len(matched) > 1:
            raise ReaderError("account-ambiguous")
        if not matched:
            raise ReaderError("not-running")
        return matched[0]


def copy_encrypted(source, target, deadline):
    wal = wal_for(source)
    target_wal = wal_for(target)
    for _ in range(4):
        before = source_signature(source)
        try:
            for path, destination, signature in ((source, target, before[0]), (wal, target_wal, before[1])):
                if signature is None:
                    destination.unlink(missing_ok=True)
                    continue
                with path.open("rb") as reader, destination.open("wb") as writer:
                    remaining = signature[2]
                    while remaining > 0:
                        if time.monotonic() > deadline:
                            raise ReaderError("database-busy")
                        block = reader.read(min(remaining, 1024**2))
                        if not block:
                            break
                        writer.write(block)
                        remaining -= len(block)
                    if remaining or reader.read(1):
                        break
            else:
                if before == source_signature(source):
                    return before
        except FileNotFoundError:
            pass
        time.sleep(0.15)
    raise ReaderError("database-busy")


def required_columns(connection, table, names):
    # Identifiers originate from fixed schema names or the ASCII digest in chat_table.
    schema = connection.execute("SELECT sql FROM sqlite_schema WHERE type='table' AND name=? COLLATE NOCASE", (table,)).fetchone()
    if not schema or not re.match(r"CREATE TABLE\b", schema[0] or "", flags=re.IGNORECASE):
        raise ReaderError("unsupported-schema")
    columns = {row[1] for row in connection.execute(f'PRAGMA table_info("{table}")')}
    if not names <= columns:
        raise ReaderError("unsupported-schema")


def has_message_table(connection, table):
    present = connection.execute("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=? COLLATE NOCASE", (table,)).fetchone()
    if not present:
        return False
    required_columns(connection, table, {"sort_seq", "local_id", "server_id", "create_time", "local_type", "message_content", "real_sender_id"})
    return True


def integer(value, *, signed=False):
    if type(value) is not int or not (-INT_MAX - 1 if signed else 0) <= value <= INT_MAX:
        raise ReaderError("unsupported-schema")
    return value


def cursor_value(value):
    if not isinstance(value, str) or not re.fullmatch(r"0|[1-9][0-9]{0,18}", value) or int(value) > INT_MAX:
        raise ReaderError("invalid-cursor")
    return int(value)


class CursorState(dict):
    def __init__(self, shards=(), *, history=None, parts=None):
        super().__init__(shards)
        self.history = history
        self.parts = parts or {}


def encode_cursor(account_id, chat_id, shards):
    options = {"history": getattr(shards, "history", None), "parts": getattr(shards, "parts", {})}
    body = json.dumps([2, account_id, fingerprint(chat_id), shards, options], separators=(",", ":"), sort_keys=True)
    token = base64.urlsafe_b64encode(body.encode("ascii")).decode("ascii").rstrip("=")
    if len(token) > MAX_CURSOR:
        raise ReaderError("invalid-cursor")
    return token


def decode_cursor(value, account_id, chat_id):
    if not isinstance(value, str) or len(value) > MAX_CURSOR or not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        raise ReaderError("invalid-cursor")
    try:
        body = json.loads(base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)))
    except (ValueError, UnicodeError, RecursionError):
        raise ReaderError("invalid-cursor") from None
    if (not isinstance(body, list) or len(body) not in (4, 5) or body[0] not in (1, 2)
        or body[1:3] != [account_id, fingerprint(chat_id)] or len(body) != (4 if body[0] == 1 else 5)):
        raise ReaderError("invalid-cursor")
    shards = body[3]
    if not isinstance(shards, dict) or not 1 <= len(shards) <= MAX_SHARDS:
        raise ReaderError("invalid-cursor")
    for name, item in shards.items():
        if (not SHARD_NAME.fullmatch(name) or not isinstance(item, list) or len(item) != 5
            or not all(isinstance(item[index], str) for index in (0, 1, 2, 3, 4))
            or item[0] not in {"ready", "missing-table", "dormant"} or not HEX_ID.fullmatch(item[1])
            or (item[4] and not HEX_ID.fullmatch(item[4]))):
            raise ReaderError("invalid-cursor")
        cursor_value(item[2])
        cursor_value(item[3])
        if item[0] != "ready" and (item[2:4] != ["0", "0"] or not item[4]):
            raise ReaderError("invalid-cursor")
    options = body[4] if body[0] == 2 else {"history": None, "parts": {}}
    if not isinstance(options, dict) or set(options) != {"history", "parts"}:
        raise ReaderError("invalid-cursor")
    history, parts = options["history"], options["parts"]
    if history is not None:
        if (not isinstance(history, dict) or set(history) != {"since", "until", "heads"}
            or type(history["since"]) is not int or type(history["until"]) is not int
            or not 0 <= history["since"] <= history["until"] <= INT_MAX
            or not isinstance(history["heads"], dict) or set(history["heads"]) != set(shards)):
            raise ReaderError("invalid-cursor")
        for point in history["heads"].values():
            if not isinstance(point, list) or len(point) != 2:
                raise ReaderError("invalid-cursor")
            for value in point:
                cursor_value(value)
    if not isinstance(parts, dict) or not set(parts) <= set(shards):
        raise ReaderError("invalid-cursor")
    for value in parts.values():
        if (not isinstance(value, list) or len(value) != 2 or not isinstance(value[0], str)
            or not HEX_ID.fullmatch(value[0]) or type(value[1]) is not int or not 1 <= value[1] <= 256):
            raise ReaderError("invalid-cursor")
    return CursorState(shards, history=history, parts=parts)


def stamp(signature):
    return fingerprint(repr(signature))


def generation(signature, page):
    return fingerprint(f"{signature[0][0]}:{signature[0][1]}:{page[:16].hex()}")


def utf16_units(value):
    return len(value.encode("utf-16-le")) // 2


def plain_text(blob, sender):
    if not isinstance(blob, bytes) or not blob or len(blob) > MAX_MESSAGE:
        return None
    if blob.startswith(b"\x28\xb5\x2f\xfd"):
        if zstd is None:
            return None
        try:
            decoder = zstd.ZstdDecompressor(options={zstd.DecompressionParameter.window_log_max: 20})
            blob = decoder.decompress(blob, max_length=MAX_MESSAGE + 1)
            if len(blob) > MAX_MESSAGE or not decoder.eof or decoder.unused_data:
                return None
        except zstd.ZstdError:
            return None
    try:
        text = blob.decode("utf-8")
    except UnicodeDecodeError:
        return None
    if sender:
        for separator in (":\r\n", ":\n"):
            prefix = sender + separator
            if text.startswith(prefix):
                text = text[len(prefix):]
                break
    return text if text.replace("\ufeff", "").strip() and not CONTROL_TEXT.search(text) else None


def text_parts(text):
    parts, current, units = [], [], 0
    for char in text:
        size = 2 if ord(char) > 0xffff else 1
        if units + size > MAX_TEXT_UNITS:
            parts.append("".join(current))
            current, units = [], 0
        current.append(char)
        units += size
    if current:
        parts.append("".join(current))
    return parts


def history_time(value):
    if not isinstance(value, str) or len(value) > 40:
        raise ReaderError("invalid-request")
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if result.tzinfo is None:
            raise ValueError()
        timestamp = int(result.timestamp())
    except (ValueError, OverflowError):
        raise ReaderError("invalid-request") from None
    if timestamp < 0 or timestamp > time.time() + 60:
        raise ReaderError("invalid-request")
    return timestamp


def safe_title(title, chat_id):
    if chat_id == "filehelper" and not title:
        title = "\u6587\u4ef6\u4f20\u8f93\u52a9\u624b"
    if not isinstance(title, str) or not title.replace("\ufeff", "").strip() or re.search(r"[\x00-\x1f\x7f]", title):
        return chat_id
    units = title[:MAX_TITLE_UNITS].encode("utf-16-le")
    return units[:MAX_TITLE_UNITS * 2].decode("utf-16-le", errors="ignore")


class Reader:
    def __init__(self, source, cipher, scratch_root=None):
        self.source = source
        self.cipher = cipher
        self.scratch_root = scratch_root
        self.binding = None
        self.keys = {}
        self.failed_salts = {}
        self.session_cache = {}
        self.contact_cache = None

    def bind(self, *, expected=None, refresh=False):
        account, process = self.source.active(refresh)
        binding = account.id, process
        if self.binding != binding:
            self.keys.clear()
            self.failed_salts.clear()
            self.session_cache.clear()
            self.contact_cache = None
            self.binding = binding
        if expected is not None and account.id != expected:
            raise ReaderError("account-changed")
        return account, process

    def confirm(self, account, process):
        if self.bind(expected=account.id) != (account, process):
            raise ReaderError("account-changed")

    def prepare_keys(self, process, pages):
        now = time.monotonic()
        pending = {}
        for page in pages:
            salt = page[:16]
            if salt in self.keys and verify_key(self.keys[salt], page):
                continue
            self.keys.pop(salt, None)
            if self.failed_salts.get(salt, 0) <= now:
                pending[salt] = page
        if not pending:
            return
        with self.source.process(process, read=True) as handle:
            if not handle:
                raise ReaderError("account-changed")
            try:
                keys = scan_keys(self.source.kernel, handle, pending)
            except TimeoutError:
                keys = {}
        self.keys.update(keys)
        for salt in pending.keys() - keys.keys():
            self.failed_salts[salt] = time.monotonic() + 15

    @contextmanager
    def snapshot(self, source, page, scratch, deadline):
        key = self.keys.get(page[:16])
        if not key or not verify_key(key, page):
            raise ReaderError("database-unreadable")
        target = scratch / source.name
        signature = copy_encrypted(source, target, deadline)
        copied_page = first_page(target)
        if page[:16] != copied_page[:16] or not verify_key(key, copied_page):
            raise ReaderError("database-busy")
        with closing(self.cipher.connect(target.as_uri() + "?mode=ro", uri=True, timeout=2)) as connection:
            connection.execute(f'''PRAGMA key = "x'{key.hex()}{page[:16].hex()}'"''')
            connection.execute("PRAGMA query_only=ON")
            connection.execute("PRAGMA trusted_schema=OFF")
            connection.execute("PRAGMA temp_store=MEMORY")
            if connection.execute("PRAGMA cipher_version").fetchone() is None:
                raise ReaderError("database-unreadable")
            connection.set_progress_handler(lambda: time.monotonic() > deadline, 1000)
            yield connection, signature

    def check_database(self, path):
        if local_path(path, self.source.kernel) != path:
            raise ReaderError("database-unreadable")
        source_signature(path)
        return first_page(path)

    def list(self):
        account, process = self.bind(refresh=True)
        session_page = self.check_database(account.session)
        contact_page = self.check_database(account.contact)
        self.prepare_keys(process, [session_page, contact_page])
        deadline = time.monotonic() + 12
        with tempfile.TemporaryDirectory(prefix="rae-wechat-encrypted-", dir=self.scratch_root) as temporary:
            scratch = Path(temporary)
            with self.snapshot(account.session, session_page, scratch, deadline) as (sessions, _):
                required_columns(sessions, "SessionTable", {"username", "is_hidden", "sort_timestamp", "last_timestamp"})
                rows = sessions.execute("SELECT username,last_timestamp FROM SessionTable WHERE is_hidden=0 AND last_timestamp>0 ORDER BY sort_timestamp DESC, username LIMIT ?", (MAX_CHATS,)).fetchall()
            with self.snapshot(account.contact, contact_page, scratch, deadline) as (contacts, _):
                required_columns(contacts, "contact", {"username", "remark", "nick_name"})
                chats = {}
                for chat_id, last_timestamp in rows:
                    if not supported_chat(chat_id) or chat_id in chats:
                        continue
                    names = contacts.execute("SELECT remark,nick_name FROM contact WHERE username=? LIMIT 2", (chat_id,)).fetchall()
                    label = (names[0][0] or names[0][1]) if len(names) == 1 else None
                    details = []
                    if len(names) == 1 and names[0][0] and names[0][1] and names[0][0] != names[0][1]:
                        details.append("原名 " + safe_title(names[0][1], ""))
                    try:
                        recent = datetime.fromtimestamp(integer(last_timestamp), timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M")
                        details.append("最近活动 " + recent)
                    except (ValueError, OverflowError, OSError):
                        pass
                    chats[chat_id] = {"accountId": account.id, "chatId": chat_id, "title": safe_title(label, chat_id),
                                      "chatType": "group" if chat_id.endswith("@chatroom") else "private",
                                      "disambiguation": safe_title(" · ".join(details), "请在微信中设置不同的会话备注后刷新")}
            self.confirm(account, process)
            return {"chats": list(chats.values())}

    def verify_session(self, account, chat_id, session_page, scratch, deadline):
        signature = source_signature(account.session)
        if self.session_cache.get(chat_id, (None,))[0] == signature:
            return self.session_cache[chat_id][1]
        with self.snapshot(account.session, session_page, scratch, deadline) as (session, captured):
            required_columns(session, "SessionTable", {"username", "is_hidden", "last_timestamp"})
            rows = session.execute("SELECT last_timestamp FROM SessionTable WHERE username=? AND is_hidden=0 AND last_timestamp>0 LIMIT 2", (chat_id,)).fetchall()
            if len(rows) != 1:
                raise ReaderError("chat-unavailable")
            timestamp = integer(rows[0][0])
            if len(self.session_cache) >= 16:
                self.session_cache.clear()
            self.session_cache[chat_id] = captured, timestamp
            return timestamp

    def verify(self, account_id, chat_id):
        # Saved grants name an exact conversation. The recent chooser is capped
        # and cannot establish whether that authorized conversation still exists.
        account, process = self.bind(expected=account_id, refresh=True)
        session_page = self.check_database(account.session)
        self.prepare_keys(process, [session_page])
        deadline = time.monotonic() + 12
        with tempfile.TemporaryDirectory(prefix="rae-wechat-encrypted-", dir=self.scratch_root) as temporary:
            scratch = Path(temporary)
            self.verify_session(account, chat_id, session_page, scratch, deadline)
            names = self.sender_names(account, process, {chat_id}, scratch, deadline)
            self.confirm(account, process)
            return {"chatTitle": names[chat_id]} if chat_id in names else {}

    def baseline(self, account_id, chat_id, since=None, until=None):
        lower = history_time(since) if since is not None else None
        upper = history_time(until) if until is not None else INT_MAX
        if until is not None and lower is None or lower is not None and lower > upper:
            raise ReaderError("invalid-request")
        account, process = self.bind(expected=account_id, refresh=True)
        session_page = self.check_database(account.session)
        sources = account.message_shards(self.source.kernel)
        signatures = {name: source_signature(path) for name, path in sources.items()}
        pages = {name: first_page(path) for name, path in sources.items()}
        self.prepare_keys(process, [session_page, *pages.values()])
        table = chat_table(chat_id)
        result = CursorState()
        heads = {}
        found = False
        newest = 0
        dormant = False
        deadline = time.monotonic() + 20
        with tempfile.TemporaryDirectory(prefix="rae-wechat-encrypted-", dir=self.scratch_root) as temporary:
            scratch = Path(temporary)
            session_time = self.verify_session(account, chat_id, session_page, scratch, deadline)
            for name, path in sources.items():
                signature, page = signatures[name], pages[name]
                if not self.keys.get(page[:16]):
                    if lower is not None:
                        raise ReaderError("shard-unavailable")
                    paths = [path] + ([wal_for(path)] if signature[1] else [])
                    if process in self.source.openers(paths) or signature != source_signature(path):
                        raise ReaderError("shard-unavailable")
                    result[name] = ["dormant", generation(signature, page), "0", "0", stamp(signature)]
                    dormant = True
                    continue
                with self.snapshot(path, page, scratch, deadline) as (connection, captured):
                    shard = generation(captured, page)
                    if not has_message_table(connection, table):
                        result[name] = ["missing-table", shard, "0", "0", stamp(captured)]
                        heads[name] = ["0", "0"]
                    else:
                        found = True
                        head = connection.execute(f'SELECT sort_seq,local_id,create_time FROM "{table}" ORDER BY sort_seq DESC,local_id DESC LIMIT 1').fetchone()
                        sequence, local_id, timestamp = (integer(value) for value in head) if head else (0, 0, 0)
                        newest = max(newest, timestamp)
                        result[name] = ["ready", shard, str(sequence), str(local_id), stamp(captured)]
                        heads[name] = [str(sequence), str(local_id)]
                        if lower is not None:
                            first = connection.execute(f'SELECT sort_seq,local_id FROM "{table}" WHERE create_time BETWEEN ? AND ? ORDER BY sort_seq,local_id LIMIT 1', (lower, upper)).fetchone()
                            if first:
                                prior = connection.execute(f'SELECT sort_seq,local_id FROM "{table}" WHERE (sort_seq,local_id)<(?,?) ORDER BY sort_seq DESC,local_id DESC LIMIT 1', first).fetchone()
                                result[name][2:5] = [str(integer(prior[0])) if prior else "0", str(integer(prior[1])) if prior else "0", ""]
                for suffix in ("", "-wal", "-shm"):
                    (scratch / (name + suffix)).unlink(missing_ok=True)
            if not found or (dormant and (session_time <= 0 or newest < session_time)):
                raise ReaderError("shard-unavailable" if dormant else "chat-unavailable")
            self.confirm(account, process)
            if lower is not None:
                result.history = {"since": lower, "until": upper, "heads": heads}
            return {"cursor": encode_cursor(account_id, chat_id, result)}

    def read(self, account_id, chat_id, cursor):
        states = decode_cursor(cursor, account_id, chat_id)
        account, process = self.bind(expected=account_id)
        session_page = self.check_database(account.session)
        sources = account.message_shards(self.source.kernel)
        if states.keys() != sources.keys():
            raise ReaderError("shard-changed")
        signatures = {name: source_signature(path) for name, path in sources.items()}
        pending = {}
        for name, path in sources.items():
            signature = signatures[name]
            page = first_page(path)
            state, shard, _, _, previous = states[name]
            if generation(signature, page) != shard:
                raise ReaderError("shard-changed")
            if previous == stamp(signature):
                continue
            if state == "dormant":
                raise ReaderError("shard-changed")
            pending[name] = page

        self.prepare_keys(process, [session_page, *pending.values()])
        table = chat_table(chat_id)
        candidates = []
        batches = {}
        deadline = time.monotonic() + 18
        with tempfile.TemporaryDirectory(prefix="rae-wechat-encrypted-", dir=self.scratch_root) as temporary:
            scratch = Path(temporary)
            self.verify_session(account, chat_id, session_page, scratch, deadline)
            for name, page in pending.items():
                path = sources[name]
                state, shard, sequence, local_id, _ = states[name]
                with self.snapshot(path, page, scratch, deadline) as (connection, captured):
                    if generation(captured, page) != shard or has_message_table(connection, table) != (state == "ready"):
                        raise ReaderError("shard-changed")
                    if state == "missing-table":
                        states[name][4] = stamp(captured)
                    else:
                        rows = self.after_cursor(connection, table, sequence, local_id)
                        candidates.extend((seq, name, local, server, content, sender, timestamp, kind, own)
                                          for seq, local, server, content, sender, timestamp, kind, own in rows)
                        last = (rows[-1][0], name, rows[-1][1]) if len(rows) > MAX_ROWS else None
                        batches[name] = (stamp(captured), len(rows), last)
                        states[name][4] = ""
                for suffix in ("", "-wal", "-shm"):
                    (scratch / (name + suffix)).unlink(missing_ok=True)
            names = self.sender_names(account, process, {chat_id} | {row[5] for row in candidates if row[5]}, scratch, deadline)
            result = self.collect_rows(account_id, chat_id, states, batches, candidates, names)
            self.confirm(account, process)
            response = {"cursor": encode_cursor(account_id, chat_id, states), "rows": result}
            if chat_id in names:
                response["chatTitle"] = names[chat_id]
            return response

    def sender_names(self, account, process, senders, scratch, deadline):
        if not senders:
            return {}
        try:
            signature = source_signature(account.contact)
            cached = self.contact_cache
            if cached and cached[0] == signature and senders <= cached[1].keys():
                return {sender: cached[1][sender] for sender in senders if cached[1][sender]}
            page = self.check_database(account.contact)
            self.prepare_keys(process, [page])
            with self.snapshot(account.contact, page, scratch, deadline) as (contacts, captured):
                required_columns(contacts, "contact", {"username", "remark", "nick_name"})
                result = dict(cached[1]) if cached and cached[0] == captured and len(cached[1]) < 4096 else {}
                for sender in senders:
                    found = contacts.execute("SELECT remark,nick_name FROM contact WHERE username=? LIMIT 2", (sender,)).fetchall()
                    result[sender] = None
                    if len(found) == 1:
                        label = found[0][0] or found[0][1]
                        if isinstance(label, str) and label.strip() and not re.search(r"[\x00-\x1f\x7f]", label):
                            result[sender] = safe_title(label, sender)
                self.contact_cache = captured, result
                return {sender: result[sender] for sender in senders if result[sender]}
        except ReaderError:
            return {}

    def after_cursor(self, connection, table, sequence, local_id):
        sender = "NULL"
        if connection.execute("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='Name2Id'").fetchone():
            required_columns(connection, "Name2Id", {"user_name"})
            sender = "(SELECT user_name FROM Name2Id WHERE rowid=m.real_sender_id)"
        columns = {row[1] for row in connection.execute(f'PRAGMA table_info("{table}")')}
        # Only explicit direction fields are evidence of authorship. Contact names and folder names are not.
        direction = next((f'm."{name}"' for name in ("is_sender", "is_send") if name in columns), "NULL")
        rows = connection.execute(f'''SELECT m.sort_seq,m.local_id,m.server_id,
                CASE WHEN (m.local_type & 4294967295)=1
                    AND length(CAST(m.message_content AS BLOB)) BETWEEN 1 AND ?
                    THEN CAST(m.message_content AS BLOB) END,
                {sender},m.create_time,(m.local_type & 4294967295),{direction}
            FROM "{table}" AS m WHERE (m.sort_seq,m.local_id)>(?,?)
            ORDER BY m.sort_seq,m.local_id LIMIT ?''',
            (MAX_MESSAGE, cursor_value(sequence), cursor_value(local_id), MAX_ROWS + 1)).fetchall()
        checked = []
        prior = (cursor_value(sequence), cursor_value(local_id))
        for seq, local, server, content, user, timestamp, kind, own in rows:
            point = integer(seq), integer(local)
            if point <= prior or not point[1]:
                raise ReaderError("unsupported-schema")
            prior = point
            user = user if isinstance(user, str) and CHAT_NAME.fullmatch(user) else None
            checked.append((*point, integer(server, signed=True) if server is not None else 0, content, user,
                            integer(timestamp), integer(kind), bool(own) if type(own) is int and own in (0, 1) else None))
        return checked

    @staticmethod
    def collect_rows(account_id, chat_id, states, batches, candidates, names=None):
        rows = []
        seen = set()
        used = 0
        names = names or {}
        consumed = {name: 0 for name in batches}
        incomplete = [last for _, _, last in batches.values() if last is not None]
        safe_end = min(incomplete) if incomplete else None
        message_types = {1: ("text", "[文字无法解析或超过读取上限]"), 3: ("image", "[图片，尚未解析]"),
                         34: ("voice", "[语音，尚未解析]"), 43: ("video", "[视频，尚未解析]"),
                         47: ("emoji", "[表情，尚未解析]"), 49: ("attachment", "[文件或分享内容，尚未解析]"),
                         10000: ("system", "[系统消息，尚未解析]"), 10002: ("system", "[系统变更，尚未解析]")}
        for sequence, name, local_id, server_id, content, sender, timestamp, kind, own in sorted(candidates, key=lambda row: row[:3]):
            if safe_end is not None and (sequence, name, local_id) > safe_end:
                break
            history = states.history
            historical = history is not None and (sequence, local_id) <= tuple(cursor_value(v) for v in history["heads"][name])
            if historical and not history["since"] <= timestamp <= history["until"]:
                states[name][2:4] = [str(sequence), str(local_id)]
                consumed[name] += 1
                continue
            message_type, placeholder = message_types.get(kind, ("other", "[暂不支持的消息类型]"))
            text = plain_text(content, sender) if kind == 1 else None
            if kind == 1 and text is None:
                message_type = "unreadable-text"
            chunks = text_parts(text or placeholder)
            identity = f"server:{server_id}" if server_id else f"local:{states[name][1]}:{local_id}"
            row_id = fingerprint(f"another-rae-wechat-row-v1\0{account_id}\0{chat_id}\0{identity}")
            metadata = {"messageId": row_id, "messageType": message_type}
            if sender in names:
                metadata["senderName"] = names[sender]
            if own is not None:
                metadata["isSelf"] = own
            if timestamp:
                try:
                    metadata["sentAt"] = datetime.fromtimestamp(timestamp, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
                except (ValueError, OverflowError, OSError):
                    pass
            partial = states.parts.get(name)
            if partial and (partial[0] != row_id or partial[1] >= len(chunks)):
                raise ReaderError("invalid-cursor")
            next_part = partial[1] if partial else 0
            while next_part < len(chunks):
                part_id = row_id if len(chunks) == 1 else f"{row_id}_{next_part}"
                if part_id in seen:
                    next_part += 1
                    continue
                length = len(chunks[next_part].encode("utf-8"))
                if len(rows) >= MAX_ROWS or used + length > MAX_TEXT:
                    break
                row = {"id": part_id, "text": chunks[next_part], **metadata}
                if len(chunks) > 1:
                    row.update(partIndex=next_part, partCount=len(chunks))
                rows.append(row)
                used += length
                seen.add(part_id)
                next_part += 1
            if next_part < len(chunks):
                if next_part:
                    states.parts[name] = [row_id, next_part]
                break
            states.parts.pop(name, None)
            states[name][2:4] = [str(sequence), str(local_id)]
            consumed[name] += 1
        for name, (last_stamp, count, _) in batches.items():
            if consumed[name] == count and count <= MAX_ROWS:
                states[name][4] = last_stamp
        return rows


ERROR_CODES = frozenset({
    "access-denied", "account-ambiguous", "account-changed", "chat-unavailable", "database-busy",
    "database-too-large", "database-unreadable", "invalid-cursor", "invalid-request", "not-running",
    "shard-changed", "shard-unavailable", "unsupported-platform", "unsupported-schema", "unsupported-version",
})


def dispatch(reader, request):
    if not isinstance(request, dict) or set(request) != {"id", "command", "args"}:
        raise ReaderError("invalid-request")
    command, args = request["command"], request["args"]
    if not isinstance(args, dict):
        raise ReaderError("invalid-request")
    if command == "list" and not args:
        return reader.list()
    if command == "verify" and set(args) == {"accountId", "chatId"}:
        cursor = None
    elif command == "baseline" and {"accountId", "chatId"} <= set(args) <= {"accountId", "chatId", "since", "until"}:
        cursor = None
    elif command == "read" and set(args) == {"accountId", "chatId", "cursor"}:
        cursor = args["cursor"]
    else:
        raise ReaderError("invalid-request")
    account_id, chat_id = args["accountId"], args["chatId"]
    if (not isinstance(account_id, str) or not HEX_ID.fullmatch(account_id)
        or not supported_chat(chat_id)):
        raise ReaderError("invalid-request")
    if command == "verify":
        return reader.verify(account_id, chat_id)
    if command == "baseline":
        return reader.baseline(account_id, chat_id, args.get("since"), args.get("until"))
    return reader.read(account_id, chat_id, cursor)


def error_code(error, cipher):
    if isinstance(error, ReaderError) and str(error) in ERROR_CODES:
        return str(error)
    if isinstance(error, PermissionError):
        return "access-denied"
    if isinstance(error, TimeoutError):
        return "database-busy"
    if cipher and isinstance(error, cipher.Error) and getattr(error, "sqlite_errorcode", None) in {5, 6, 9}:
        return "database-busy"
    return "database-unreadable"


def write_response(response):
    sys.stdout.buffer.write(json.dumps(response, ensure_ascii=True, separators=(",", ":")).encode("ascii") + b"\n")
    sys.stdout.buffer.flush()


def main():
    reader, cipher = None, None
    setup_error = "unsupported-platform"
    if sys.platform == "win32" and c.sizeof(c.c_void_p) == 8:
        setup_error = "database-unreadable"
        try:
            from sqlcipher3 import dbapi2 as cipher
            source = WindowsSource()
            candidate = sys.argv[1] if len(sys.argv) == 2 else os.environ.get("TEMP") if len(sys.argv) == 1 else None
            scratch_root = local_path(candidate, source.kernel) if candidate else None
            if scratch_root and scratch_root.is_dir():
                reader = Reader(source, cipher, scratch_root)
        except (ImportError, OSError):
            pass
    while line := sys.stdin.buffer.readline(MAX_REQUEST + 1):
        request_id = None
        if len(line) > MAX_REQUEST or not line.endswith(b"\n"):
            write_response({"id": request_id, "ok": False, "error": "invalid-request"})
            break
        try:
            request = json.loads(line.decode("utf-8"))
            request_id = request.get("id") if isinstance(request, dict) else None
            if type(request_id) is not int or not 0 <= request_id <= 2**53 - 1:
                request_id = None
                raise ReaderError("invalid-request")
        except (ReaderError, ValueError, UnicodeError, RecursionError):
            write_response({"id": request_id, "ok": False, "error": "invalid-request"})
            continue
        try:
            if not reader:
                raise ReaderError(setup_error)
            result = dispatch(reader, request)
        except Exception as error:
            write_response({"id": request_id, "ok": False, "error": error_code(error, cipher)})
        else:
            write_response({"id": request_id, "ok": True, "result": result})


if __name__ == "__main__":
    main()
