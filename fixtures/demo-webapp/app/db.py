import os
import sqlite3

DEFAULT_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "notes.db")
DB_PATH = os.environ.get("DB_PATH", DEFAULT_DB_PATH)


def _connect():
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS notes ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT, "
        "text TEXT NOT NULL, "
        "created_at TEXT NOT NULL DEFAULT (datetime('now')))"
    )
    return conn


def save_note(text):
    with _connect() as conn:
        cursor = conn.execute("INSERT INTO notes (text) VALUES (?)", (text,))
        return cursor.lastrowid


def list_notes():
    with _connect() as conn:
        rows = conn.execute(
            "SELECT id, text, created_at FROM notes ORDER BY id DESC"
        ).fetchall()
    return [{"id": row[0], "text": row[1], "created_at": row[2]} for row in rows]
