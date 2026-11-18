"""Offline tests with synthetic encrypted databases. No WeChat process is used."""

from contextlib import closing
import base64
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from sqlcipher3 import dbapi2 as cipher

from reader import Account, MAX_MESSAGE, Reader, ReaderError, chat_table, decode_cursor, dispatch, fingerprint, plain_text, safe_title, text_parts, wal_for, zstd


GROUP = "0123@chatroom"
OTHER = "wxid_fixture"
HIGH_SEQUENCE = 2**53 + 16


class SyntheticSource:
    def __init__(self, account):
        self.account = account
        self.kernel = None

    def active(self, refresh=False):
        return self.account, (12, 34)


class ReaderTests(unittest.TestCase):
    def setUp(self):
        self.temp = self.enterContext(tempfile.TemporaryDirectory())
        self.root = Path(self.temp).resolve()
        self.account = Account(self.root / "fixture-account")
        self.source = SyntheticSource(self.account)
        self.worker = Reader(self.source, cipher, self.root)
        self.worker.binding = (self.account.id, (12, 34))
        self.enterContext(patch("reader.local_path", side_effect=lambda value, _: value))
        self.encrypted = {}
        self.shard = self.account.folder / "db_storage" / "message" / "message_0.db"
        self.second = self.shard.with_name("message_1.db")
        self.make(self.account.session, "CREATE TABLE SessionTable(username TEXT,is_hidden INTEGER,sort_timestamp INTEGER,last_timestamp INTEGER);")
        self.make(self.account.contact, "CREATE TABLE contact(username TEXT,remark TEXT,nick_name TEXT);")
        self.run_sql(self.account.session, "INSERT INTO SessionTable VALUES (?,?,?,?)", (GROUP, 0, 50, 50))
        self.run_sql(self.account.session, "INSERT INTO SessionTable VALUES (?,?,?,?)", (OTHER, 0, 48, 48))
        self.run_sql(self.account.session, "INSERT INTO SessionTable VALUES (?,?,?,?)", ("hidden", 1, 90, 90))
        self.run_sql(self.account.session, "INSERT INTO SessionTable VALUES (?,?,?,?)", ("gh_fixture", 0, 80, 80))
        self.run_sql(self.account.contact, "INSERT INTO contact VALUES (?,?,?)", (GROUP, "Fixture remark", "Fixture name"))
        self.run_sql(self.account.contact, "INSERT INTO contact VALUES (?,?,?)", ("wxid_sender", "", "Fixture sender"))
        for path in (self.shard, self.second):
            schema = "CREATE TABLE Name2Id(user_name TEXT); INSERT INTO Name2Id VALUES ('wxid_sender');"
            for chat in (GROUP, OTHER):
                schema += f'CREATE TABLE "{chat_table(chat)}"(local_id INTEGER PRIMARY KEY,sort_seq INTEGER,server_id INTEGER,create_time INTEGER,local_type INTEGER,message_content BLOB,real_sender_id INTEGER);'
            self.make(path, schema)
        self.insert(self.shard, GROUP, 1, HIGH_SEQUENCE, 15, 50, 1, b"fixture old text")

    def make(self, path, schema):
        path.parent.mkdir(parents=True, exist_ok=True)
        key = bytes(range(32))
        salt = len(self.encrypted).to_bytes(16, "big")
        self.encrypted[path] = key, salt
        self.worker.keys[salt] = key
        with closing(self.connect(path)) as database:
            database.executescript(schema)
            database.commit()

    def connect(self, path):
        connection = cipher.connect(path)
        key, salt = self.encrypted[path]
        connection.execute(f'''PRAGMA key="x'{key.hex()}{salt.hex()}'"''')
        return connection

    def run_sql(self, path, statement, params):
        with closing(self.connect(path)) as database:
            database.execute(statement, params)
            database.commit()

    def insert(self, shard, chat, local, sequence, server, timestamp, kind, text):
        self.run_sql(shard, f'INSERT INTO "{chat_table(chat)}" VALUES (?,?,?,?,?,?,1)', (local, sequence, server, timestamp, kind, text))

    def test_list_and_only_selected_new_rows_in_encrypted_wal(self):
        listed = self.worker.list()["chats"]
        self.assertEqual([{key: row[key] for key in ("accountId", "chatId", "title")} for row in listed], [
            {"accountId": self.account.id, "chatId": GROUP, "title": "Fixture remark"},
            {"accountId": self.account.id, "chatId": OTHER, "title": OTHER},
        ])
        self.assertEqual([row["chatType"] for row in listed], ["group", "private"])
        self.assertIn("Fixture name", listed[0]["disambiguation"])
        self.assertIn("最近活动", listed[0]["disambiguation"])
        self.assertNotIn(GROUP, listed[0]["disambiguation"])
        self.assertNotEqual(listed[0]["disambiguation"], listed[1]["disambiguation"])
        cursor = self.worker.baseline(self.account.id, GROUP)["cursor"]
        state = decode_cursor(cursor, self.account.id, GROUP)
        self.assertEqual(state[self.shard.name][2], str(HIGH_SEQUENCE))
        self.insert(self.second, GROUP, 1, HIGH_SEQUENCE + 2, 17, 52, 1, b"wxid_sender:\nfixture second")
        with closing(self.connect(self.shard)) as active:
            active.execute("PRAGMA journal_mode=WAL")
            active.execute("PRAGMA wal_autocheckpoint=0")
            active.execute(f'INSERT INTO "{chat_table(GROUP)}" VALUES (2,?,16,51,1,?,1)', (HIGH_SEQUENCE + 1, b"fixture first"))
            active.execute(f'INSERT INTO "{chat_table(OTHER)}" VALUES (1,?,91,51,1,?,1)', (HIGH_SEQUENCE + 1, b"unselected text"))
            active.execute(f'INSERT INTO "{chat_table(GROUP)}" VALUES (3,?,18,52,3,?,1)', (HIGH_SEQUENCE + 3, b"non-text"))
            active.commit()
            self.assertTrue(wal_for(self.shard).exists())
            result = self.worker.read(self.account.id, GROUP, cursor)
            self.assertEqual([row["text"] for row in result["rows"][:2]], ["fixture first", "fixture second"])
            self.assertEqual(result["rows"][2]["messageType"], "image")
            self.assertEqual(result["rows"][0]["senderName"], "Fixture sender")
            self.assertEqual(result["rows"][0]["sentAt"], "1970-01-01T00:00:51Z")
            self.assertNotIn("isSelf", result["rows"][0])
            self.assertEqual(self.worker.read(self.account.id, GROUP, cursor), result)
            self.assertEqual(self.worker.read(self.account.id, GROUP, result["cursor"])["rows"], [])
        self.assertEqual(list(self.root.glob("rae-wechat-encrypted-*")), [])

    def test_cursor_limits_pages_and_rejects_wrong_scope(self):
        cursor = self.worker.baseline(self.account.id, GROUP)["cursor"]
        for number in range(2, 25):
            self.insert(self.shard, GROUP, number, HIGH_SEQUENCE + number, number, 50 + number, 1, str(number).encode())
        first = self.worker.read(self.account.id, GROUP, cursor)
        self.assertEqual([row["text"] for row in first["rows"]], [str(value) for value in range(2, 22)])
        second = self.worker.read(self.account.id, GROUP, first["cursor"])
        self.assertEqual([row["text"] for row in second["rows"]], ["22", "23", "24"])
        with self.assertRaisesRegex(ReaderError, "invalid-cursor"):
            self.worker.read(self.account.id, OTHER, cursor)
        self.make(self.second.with_name("message_2.db"), "CREATE TABLE fixture(value TEXT);")
        with self.assertRaisesRegex(ReaderError, "shard-changed"):
            self.worker.read(self.account.id, GROUP, second["cursor"])

    def test_exact_verification_does_not_depend_on_recent_chooser_or_reset_cursor(self):
        cursor = self.worker.baseline(self.account.id, GROUP)["cursor"]
        with closing(self.connect(self.account.session)) as database:
            database.executemany("INSERT INTO SessionTable VALUES (?,?,?,?)",
                                 [(f"wxid_recent_{index}", 0, 1000 + index, 1000 + index) for index in range(500)])
            database.commit()
        listing = self.worker.list()["chats"]
        self.assertEqual(len(listing), 500)
        self.assertNotIn(GROUP, [row["chatId"] for row in listing])
        verified = dispatch(self.worker, {"id": 1, "command": "verify", "args": {"accountId": self.account.id, "chatId": GROUP}})
        self.assertEqual(verified, {"chatTitle": "Fixture remark"})
        self.insert(self.shard, GROUP, 2, HIGH_SEQUENCE + 1, 16, 51, 1, b"retained original cursor")
        result = self.worker.read(self.account.id, GROUP, cursor)
        self.assertEqual([row["text"] for row in result["rows"]], ["retained original cursor"])
        with self.assertRaisesRegex(ReaderError, "chat-unavailable"):
            self.worker.verify(self.account.id, "wxid_missing")
        with patch.object(self.source, "active", return_value=(Account(self.root / "another-account"), (56, 78))):
            with self.assertRaisesRegex(ReaderError, "account-changed"):
                self.worker.verify(self.account.id, GROUP)

    def test_byte_limit_keeps_whole_rows_and_retry_position(self):
        cursor = self.worker.baseline(self.account.id, GROUP)["cursor"]
        full_row = "\u4e00" * 4000
        self.insert(self.shard, GROUP, 2, HIGH_SEQUENCE + 1, 16, 51, 1, full_row.encode())
        self.insert(self.second, GROUP, 1, HIGH_SEQUENCE + 2, 17, 52, 1, full_row.encode())
        self.insert(self.shard, GROUP, 3, HIGH_SEQUENCE + 3, 18, 53, 1, b"a" * 1000)
        first = self.worker.read(self.account.id, GROUP, cursor)
        self.assertEqual([row["text"] for row in first["rows"]], [full_row, full_row])
        second = self.worker.read(self.account.id, GROUP, first["cursor"])
        self.assertEqual([row["text"] for row in second["rows"]], ["a" * 1000])

    def test_utf16_boundaries_match_transport(self):
        emoji = "\U0001f642"
        self.assertEqual(plain_text((emoji * 2000).encode(), None), emoji * 2000)
        self.assertEqual(text_parts(plain_text((emoji * 2001).encode(), None)), [emoji * 2000, emoji])
        self.assertEqual(safe_title("a" + emoji * 100, GROUP), "a" + emoji * 99)

    def test_history_bounds_and_future_rows_with_old_timestamps(self):
        self.insert(self.shard, GROUP, 2, HIGH_SEQUENCE + 1, 16, 60, 1, b"inside requested history")
        self.insert(self.shard, GROUP, 3, HIGH_SEQUENCE + 2, 17, 70, 1, b"outside requested history")
        cursor = self.worker.baseline(self.account.id, GROUP, "1970-01-01T00:00:55Z", "1970-01-01T00:01:05Z")["cursor"]
        self.insert(self.shard, GROUP, 4, HIGH_SEQUENCE + 3, 18, 45, 1, b"newly synced after start")
        result = self.worker.read(self.account.id, GROUP, cursor)
        self.assertEqual([row["text"] for row in result["rows"]], ["inside requested history", "newly synced after start"])
        self.assertEqual(self.worker.read(self.account.id, GROUP, result["cursor"])["rows"], [])

    def test_durable_cursor_and_long_text_are_complete_across_workers(self):
        cursor = self.worker.baseline(self.account.id, GROUP)["cursor"]
        text = "\u4e00" * 33000
        self.insert(self.shard, GROUP, 2, HIGH_SEQUENCE + 1, 16, 60, 1, text.encode())
        first = self.worker.read(self.account.id, GROUP, cursor)
        self.assertEqual(self.worker.read(self.account.id, GROUP, cursor), first)
        collected = first["rows"]
        worker = Reader(self.source, cipher, self.root)
        worker.binding = self.worker.binding
        worker.keys = self.worker.keys.copy()
        position = first["cursor"]
        for _ in range(12):
            batch = worker.read(self.account.id, GROUP, position)
            collected.extend(batch["rows"])
            position = batch["cursor"]
            if not batch["rows"]:
                break
        self.assertEqual("".join(row["text"] for row in collected), text)
        self.assertEqual([row["partIndex"] for row in collected], list(range(9)))
        self.assertEqual({row["partCount"] for row in collected}, {9})
        self.assertEqual(len({row["id"] for row in collected}), 9)

    def test_legacy_cursor_and_explicit_sender_direction(self):
        initial = self.worker.baseline(self.account.id, GROUP)["cursor"]
        state = decode_cursor(initial, self.account.id, GROUP)
        old = [1, self.account.id, fingerprint(GROUP), dict(state)]
        cursor = base64.urlsafe_b64encode(json.dumps(old).encode()).decode().rstrip("=")
        self.run_sql(self.shard, f'ALTER TABLE "{chat_table(GROUP)}" ADD COLUMN is_sender INTEGER', ())
        self.run_sql(self.shard, f'INSERT INTO "{chat_table(GROUP)}" VALUES (?,?,?,?,?,?,?,?)',
                     (2, HIGH_SEQUENCE + 1, 16, 60, 1, b"own message", 1, 1))
        result = self.worker.read(self.account.id, GROUP, cursor)
        self.assertTrue(result["rows"][0]["isSelf"])

    def test_history_requires_explicit_valid_range(self):
        for since, until in ((None, "1970-01-01T00:00:55Z"), ("1970-01-01T00:01:00Z", "1970-01-01T00:00:55Z"), ("not a date", None)):
            with self.assertRaisesRegex(ReaderError, "invalid-request"):
                self.worker.baseline(self.account.id, GROUP, since, until)

    def test_rename_refreshes_even_without_new_messages(self):
        cursor = self.worker.baseline(self.account.id, GROUP)["cursor"]
        first = self.worker.read(self.account.id, GROUP, cursor)
        self.assertEqual(first["chatTitle"], "Fixture remark")
        self.run_sql(self.account.contact, "UPDATE contact SET remark=? WHERE username=?", ("Renamed fixture", GROUP))
        second = self.worker.read(self.account.id, GROUP, first["cursor"])
        self.assertEqual(second["rows"], [])
        self.assertEqual(second["chatTitle"], "Renamed fixture")

    def test_unreadable_text_is_visible_and_whitespace_parts_preserved(self):
        cursor = self.worker.baseline(self.account.id, GROUP)["cursor"]
        original = " " * 4100 + "ending"
        self.insert(self.shard, GROUP, 2, HIGH_SEQUENCE + 1, 16, 60, 1, original.encode())
        self.insert(self.shard, GROUP, 3, HIGH_SEQUENCE + 2, 17, 61, 1, b"\xff\x00")
        result = self.worker.read(self.account.id, GROUP, cursor)
        self.assertEqual("".join(row["text"] for row in result["rows"][:2]), original)
        self.assertEqual(result["rows"][2]["messageType"], "unreadable-text")

    @unittest.skipIf(zstd is None, "standard-library Zstandard requires Python 3.14")
    def test_bounded_zstandard_frames(self):
        frame = zstd.compress(b"valid compressed text")
        self.assertEqual(plain_text(frame, None), "valid compressed text")
        self.assertIsNone(plain_text(frame + b"trailer", None))
        self.assertIsNone(plain_text(zstd.compress(b"a" * (MAX_MESSAGE + 1)), None))


if __name__ == "__main__":
    unittest.main()
