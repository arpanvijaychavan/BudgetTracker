"""
storage.py

A drop-in replacement for the load_json/save_json helpers process_transactions.py
and server.py used to define locally, so the exact same call sites
(load_json(SOME_PATH, default) / save_json(SOME_PATH, data)) work unchanged
whether the app is running:
  - locally (no DATABASE_URL set) - reads/writes real files on disk, exactly
    like before.
  - deployed on a host with ephemeral/no persistent disk (DATABASE_URL set) -
    stores each "file" as one row (key, json blob) in a Postgres table, so
    data survives restarts and redeploys.

Nothing else in the codebase needs to know which mode it's in.
"""

import os
import json

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATABASE_URL = os.environ.get("DATABASE_URL")

_pg_pool = None


def _key_for(path):
    """Turns an absolute file path into a stable, human-readable key, e.g.
    "C:\\...\\data\\transactions.json" -> "data/transactions.json"."""
    rel = os.path.relpath(path, BASE_DIR)
    return rel.replace(os.sep, "/")


def _get_connection():
    global _pg_pool
    if _pg_pool is None:
        import psycopg2
        _pg_pool = psycopg2.connect(DATABASE_URL)
        with _pg_pool.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS kv_store (
                    key TEXT PRIMARY KEY,
                    data JSONB NOT NULL
                )
                """
            )
        _pg_pool.commit()
    return _pg_pool


def load_json(path, default):
    if DATABASE_URL:
        conn = _get_connection()
        with conn.cursor() as cur:
            cur.execute("SELECT data FROM kv_store WHERE key = %s", (_key_for(path),))
            row = cur.fetchone()
        return row[0] if row else default

    if not os.path.exists(path):
        return default
    with open(path, "r", encoding="utf-8") as f:
        content = f.read().strip()
        if not content:
            return default
        return json.loads(content)


def save_json(path, data):
    if DATABASE_URL:
        from psycopg2.extras import Json

        conn = _get_connection()
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO kv_store (key, data) VALUES (%s, %s)
                ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data
                """,
                (_key_for(path), Json(data)),
            )
        conn.commit()
        return

    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, sort_keys=True)
        f.write("\n")
