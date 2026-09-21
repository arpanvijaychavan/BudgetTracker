"""
server.py

Minimal local HTTP server (stdlib only, no Flask required) that:
  - Serves the dashboard/ folder as static files.
  - Exposes POST /update-category to persist manual recategorizations
    from the dashboard back to data/transactions.json and
    merchant_overrides.json.
  - Exposes POST /budgets/update and /budgets/restore so category budgets
    can be adjusted from the Overview tab (this month, this and later
    months, or all months) with Undo.
  - Exposes POST /delete-transactions and /undo-delete to remove (and
    restore) individual transactions or a whole set of averaged
    installments. Deleted transactions are remembered as tombstones so
    re-uploading an overlapping statement doesn't bring them back.
  - Exposes a small upload wizard (POST /upload, /upload/mapping,
    /upload/categories) so statements can be processed directly from the
    dashboard instead of the terminal. It reuses the exact same parsing,
    categorization, and averaging logic from process_transactions.py -
    this is a thin web front end for that script, not a reimplementation.
  - Exposes POST /rules/keyword/add, /rules/keyword/remove,
    /rules/override/add, /rules/override/remove, /rules/averaging/add,
    /rules/averaging/update, /rules/averaging/remove so the dashboard's
    Rules tab can manage category_rules.json, merchant_overrides.json, and
    averaging_rules.json directly - those go through storage.py, which is
    read fresh on every call (no in-memory cache), so changes take effect
    on the very next transaction processed.
  - Reads/writes its JSON data through storage.py, which transparently uses
    real files locally and a Postgres table when DATABASE_URL is set (e.g.
    when deployed somewhere without a persistent disk) - see storage.py.
  - If DASHBOARD_USERNAME/DASHBOARD_PASSWORD are set, every request must
    come from a browser holding a valid session cookie, obtained by logging
    in at GET /login (POST /login checks the credentials and issues the
    cookie; POST /logout clears it). The cookie has no Max-Age, so browsers
    drop it once fully closed - reopening the browser requires logging in
    again. Unset locally by default, so running this on your own machine
    has no login friction; set them before deploying anywhere reachable by
    other people.

Run with:
    python server.py
Then open:
    http://localhost:8000
"""

import os
import re
import copy
import math
import json
import base64
import hmac
import secrets
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

import process_transactions as pt
from storage import load_json, save_json

PORT = int(os.environ.get("PORT", 8000))
HOST = os.environ.get("HOST", "0.0.0.0")
DASHBOARD_USERNAME = os.environ.get("DASHBOARD_USERNAME")
DASHBOARD_PASSWORD = os.environ.get("DASHBOARD_PASSWORD")
# Set to "false" to allow the session cookie over plain HTTP - only useful
# for testing a login locally without HTTPS; leave unset/"true" everywhere else.
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "true").lower() != "false"
SESSION_COOKIE_NAME = "budget_session"
# In-memory session store - fine for a single-process personal tool; a
# restart clears everyone's session, which just means logging in again.
ACTIVE_SESSIONS = set()
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DASHBOARD_DIR = os.path.join(BASE_DIR, "dashboard")
UPLOADS_DIR = os.path.join(BASE_DIR, "uploads")
TRANSACTIONS_PATH = os.path.join(BASE_DIR, "data", "transactions.json")
MERCHANT_OVERRIDES_PATH = os.path.join(BASE_DIR, "merchant_overrides.json")

# GET paths the dashboard fetches as data (via relative "../xxx.json" URLs,
# which resolve to these root-relative paths) - served through storage.py
# instead of a raw file read, so they work the same whether data lives on
# disk or in Postgres. Static assets (HTML/CSS/JS) still come straight off
# disk via _serve_static.
DATA_ENDPOINTS = {
    "/data/transactions.json": (TRANSACTIONS_PATH, {}),
    "/budgets.json": (pt.BUDGETS_PATH, {}),
    "/category_rules.json": (pt.CATEGORY_RULES_PATH, {}),
    "/merchant_overrides.json": (MERCHANT_OVERRIDES_PATH, {}),
    "/averaging_rules.json": (pt.AVERAGING_RULES_PATH, []),
}

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
}

# In-memory state for uploads that are mid-wizard (waiting on a column
# mapping or category choices from the browser). Fine for a single-user
# local tool - no need for a database or session expiry.
PENDING_UPLOADS = {}


def categorize_rows(rows):
    """Runs every row through the categorization pipeline, returning
    (manual_count, ambiguous_items) - rows that resolved automatically get
    row["category"] set in place; ambiguous ones are left for the caller to
    resolve via the UI."""
    category_rules = load_json(pt.CATEGORY_RULES_PATH, {})
    overrides = load_json(MERCHANT_OVERRIDES_PATH, {})

    ambiguous_rows = []
    for row in rows:
        category, needs_prompt = pt.categorize(row["category_key"], category_rules, overrides)
        if needs_prompt:
            row["category"] = None
            ambiguous_rows.append(row)
        else:
            row["category"] = category

    return len(ambiguous_rows), pt.collect_ambiguous_items(ambiguous_rows)


def finalize_rows(rows):
    """Stage 3: rows all have a category assigned - apply averaging, merge
    into transactions.json, and build the summary payload."""
    new_transactions = [
        {
            "date": row["date"],
            "merchant": row["merchant"],
            "description": row["description"],
            "amount": row["amount"],
            "category": row["category"],
            "source_file": row["source_file"],
        }
        for row in rows
    ]
    new_transactions = pt.apply_averaging_rules(new_transactions)
    added, skipped = pt.merge_transactions(new_transactions)
    return new_transactions, added, skipped


class Handler(BaseHTTPRequestHandler):
    def _login_required(self):
        return bool(DASHBOARD_USERNAME and DASHBOARD_PASSWORD)

    def _session_token(self):
        cookie_header = self.headers.get("Cookie", "")
        for part in cookie_header.split(";"):
            part = part.strip()
            if part.startswith(f"{SESSION_COOKIE_NAME}="):
                return part[len(SESSION_COOKIE_NAME) + 1:]
        return None

    def _is_authenticated(self):
        """True if this request may proceed. If DASHBOARD_USERNAME/
        DASHBOARD_PASSWORD aren't set (the local, no-login default), every
        request passes. Otherwise a valid session cookie (issued by POST
        /login) is required."""
        if not self._login_required():
            return True
        token = self._session_token()
        return token is not None and token in ACTIVE_SESSIONS

    def _redirect(self, location):
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def handle_login_page(self):
        full_path = os.path.join(DASHBOARD_DIR, "login.html")
        with open(full_path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_login_submit(self):
        try:
            payload = self._read_json_body()
            username = str(payload.get("username", ""))
            password = str(payload.get("password", ""))
        except (ValueError, json.JSONDecodeError):
            self._send_json(400, {"error": "Expected JSON body {username, password}"})
            return

        if not self._login_required():
            self._send_json(200, {"ok": True})
            return

        if not (hmac.compare_digest(username, DASHBOARD_USERNAME) and hmac.compare_digest(password, DASHBOARD_PASSWORD)):
            self._send_json(401, {"error": "Invalid username or password"})
            return

        token = secrets.token_urlsafe(32)
        ACTIVE_SESSIONS.add(token)
        body = json.dumps({"ok": True}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        # No Max-Age/Expires => a session cookie, which browsers clear when
        # fully closed (not just the tab) - so reopening the browser always
        # requires logging in again.
        secure = "; Secure" if COOKIE_SECURE else ""
        self.send_header("Set-Cookie", f"{SESSION_COOKIE_NAME}={token}; HttpOnly; SameSite=Lax; Path=/{secure}")
        self.end_headers()
        self.wfile.write(body)

    def handle_logout(self):
        token = self._session_token()
        if token:
            ACTIVE_SESSIONS.discard(token)
        body = json.dumps({"ok": True}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Set-Cookie", f"{SESSION_COOKIE_NAME}=; Max-Age=0; Path=/")
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", 0))
        raw_body = self.rfile.read(length)
        return json.loads(raw_body)

    def _serve_static(self):
        path = urlparse(self.path).path
        if path == "/":
            path = "/index.html"
        full_path = os.path.normpath(os.path.join(DASHBOARD_DIR, path.lstrip("/")))

        # Prevent path traversal outside the project directory.
        if not full_path.startswith(os.path.normpath(DASHBOARD_DIR)):
            self.send_error(403, "Forbidden")
            return

        # Data files (transactions.json, budgets.json) live outside dashboard/,
        # one level up in the project root.
        if not os.path.isfile(full_path):
            fallback_path = os.path.normpath(os.path.join(BASE_DIR, path.lstrip("/")))
            if fallback_path.startswith(os.path.normpath(BASE_DIR)) and os.path.isfile(fallback_path):
                full_path = fallback_path

        if not os.path.isfile(full_path):
            self.send_error(404, "Not found")
            return

        ext = os.path.splitext(full_path)[1].lower()
        content_type = CONTENT_TYPES.get(ext, "application/octet-stream")
        with open(full_path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path

        if path == "/login":
            self.handle_login_page()
            return

        # style.css is linked from login.html itself, so it must be
        # reachable before the user has logged in - otherwise the login
        # page renders unstyled.
        if not self._is_authenticated() and path != "/style.css":
            self._redirect("/login")
            return

        if path in DATA_ENDPOINTS:
            data_path, default = DATA_ENDPOINTS[path]
            self._send_json(200, load_json(data_path, default))
            return
        self._serve_static()

    def do_POST(self):
        path = urlparse(self.path).path

        if path == "/login":
            self.handle_login_submit()
            return
        if path == "/logout":
            self.handle_logout()
            return

        if not self._is_authenticated():
            self._send_json(401, {"error": "Not logged in"})
            return

        routes = {
            "/update-category": self.handle_update_category,
            "/undo-category": self.handle_undo_category,
            "/budgets/update": self.handle_update_budget,
            "/budgets/restore": self.handle_restore_budgets,
            "/delete-transactions": self.handle_delete_transactions,
            "/undo-delete": self.handle_undo_delete,
            "/add-expense": self.handle_add_expense,
            "/upload": self.handle_upload,
            "/upload/mapping": self.handle_upload_mapping,
            "/upload/categories": self.handle_upload_categories,
            "/rules/keyword/add": self.handle_add_keyword_rule,
            "/rules/keyword/remove": self.handle_remove_keyword_rule,
            "/rules/override/add": self.handle_add_override_rule,
            "/rules/override/remove": self.handle_remove_override_rule,
            "/rules/averaging/add": self.handle_add_averaging_rule,
            "/rules/averaging/update": self.handle_update_averaging_rule,
            "/rules/averaging/remove": self.handle_remove_averaging_rule,
        }
        handler = routes.get(path)
        if not handler:
            self.send_error(404, "Not found")
            return
        try:
            handler()
        except Exception as exc:
            self._send_json(400, {"error": str(exc)})

    # -- existing manual recategorization from the Transactions tab --------

    def handle_update_category(self):
        try:
            payload = self._read_json_body()
            txn_id = payload["id"]
            new_category = payload["new_category"]
        except (KeyError, ValueError, json.JSONDecodeError):
            self._send_json(400, {"error": "Expected JSON body {id, new_category}"})
            return

        all_transactions = load_json(TRANSACTIONS_PATH, {})
        updated_txn = None
        owning_month = None
        for month, txns in all_transactions.items():
            for txn in txns:
                if txn["id"] == txn_id:
                    updated_txn = txn
                    owning_month = month
                    break
            if updated_txn:
                break

        if not updated_txn:
            self._send_json(404, {"error": f"No transaction with id {txn_id}"})
            return

        previous_category = updated_txn["category"]
        # Snapshot the override as it was before this edit (None if the
        # merchant had no override yet) so an undo can restore it exactly,
        # rather than just guessing it should be deleted.
        overrides = load_json(MERCHANT_OVERRIDES_PATH, {})
        previous_override = overrides.get(updated_txn["merchant"])
        overrides[updated_txn["merchant"]] = new_category
        save_json(MERCHANT_OVERRIDES_PATH, overrides)

        # A manual recategorization that now matches one of the (user-
        # editable) averaging rules should get the same spread a fresh
        # import would - otherwise it sits as a lump sum that silently
        # breaks whatever rule now applies. Skip if it's already one of a
        # split set (its description already carries the "(avg N/M)"
        # marker) so re-editing an installment doesn't get split again on
        # top of itself.
        row = {
            "date": updated_txn["date"],
            "merchant": updated_txn["merchant"],
            "description": updated_txn["description"],
            "amount": updated_txn["amount"],
            "category": new_category,
            "source_file": updated_txn["source_file"],
        }
        matched_rule = pt.find_matching_averaging_rule(row, pt.load_averaging_rules())
        needs_split = matched_rule is not None and "(avg " not in updated_txn["description"]

        if needs_split:
            original_snapshot = dict(updated_txn, category=previous_category)
            all_transactions[owning_month] = [t for t in all_transactions[owning_month] if t["id"] != txn_id]
            save_json(TRANSACTIONS_PATH, all_transactions)

            if matched_rule["spread_type"] == "calendar_year":
                installments = pt.split_across_calendar_year(row)
            else:
                installments = pt.split_into_installments(row, matched_rule.get("months") or 1)
            pt.merge_transactions(installments)
            new_ids = [i["id"] for i in installments if "id" in i]

            self._send_json(200, {
                "ok": True, "id": txn_id, "category": new_category, "split": True,
                "undo": {
                    "type": "split",
                    "new_ids": new_ids,
                    "original": original_snapshot,
                    "merchant": updated_txn["merchant"],
                    "previous_override": previous_override,
                },
            })
            return

        updated_txn["category"] = new_category
        save_json(TRANSACTIONS_PATH, all_transactions)
        self._send_json(200, {
            "ok": True, "id": txn_id, "category": new_category, "split": False,
            "undo": {
                "type": "simple",
                "id": txn_id,
                "previous_category": previous_category,
                "merchant": updated_txn["merchant"],
                "previous_override": previous_override,
            },
        })

    # -- category budgets (budgets.json) ---------------------------------------

    def handle_update_budget(self):
        try:
            payload = self._read_json_body()
            month = str(payload["month"])
            category = payload["category"]
            amount = float(payload["amount"])
            scope = payload.get("scope", "month")
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            self._send_json(400, {"error": "Expected JSON body {month, category, amount, scope?}"})
            return
        if not re.fullmatch(r"\d{4}-\d{2}", month):
            self._send_json(400, {"error": f"Invalid month '{month}'"})
            return
        if category not in pt.CATEGORIES:
            self._send_json(400, {"error": f"Unknown category '{category}'"})
            return
        if not math.isfinite(amount) or amount < 0:
            self._send_json(400, {"error": "Budget must be a number, zero or more"})
            return
        if scope not in ("month", "future", "all"):
            self._send_json(400, {"error": "scope must be 'month', 'future', or 'all'"})
            return

        amount = int(amount) if amount == int(amount) else round(amount, 2)
        budgets = load_json(pt.BUDGETS_PATH, {})
        previous = copy.deepcopy(budgets)

        # A month with no budget yet starts from the closest earlier month's
        # budget (or zeros), so editing one category doesn't zero the rest.
        if month not in budgets:
            earlier = sorted(m for m in budgets if m < month)
            budgets[month] = dict(budgets[earlier[-1]]) if earlier else {c: 0 for c in pt.CATEGORIES}

        if scope == "month":
            targets = [month]
        elif scope == "future":
            targets = [m for m in budgets if m >= month]
        else:
            targets = list(budgets)
        for m in targets:
            budgets[m][category] = amount

        save_json(pt.BUDGETS_PATH, budgets)
        self._send_json(200, {"ok": True, "updated_months": len(targets), "undo": {"budgets": previous}})

    def handle_restore_budgets(self):
        try:
            payload = self._read_json_body()
            budgets = payload["budgets"]
            valid = isinstance(budgets, dict) and all(
                re.fullmatch(r"\d{4}-\d{2}", m)
                and isinstance(cats, dict)
                and all(isinstance(v, (int, float)) for v in cats.values())
                for m, cats in budgets.items()
            )
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            valid = False
        if not valid:
            self._send_json(400, {"error": "Expected JSON body {budgets: {YYYY-MM: {category: amount}}}"})
            return
        save_json(pt.BUDGETS_PATH, budgets)
        self._send_json(200, {"ok": True})

    # -- deleting transactions ------------------------------------------------

    def handle_delete_transactions(self):
        try:
            payload = self._read_json_body()
            txn_id = payload["id"]
            scope = payload.get("scope", "one")
        except (KeyError, ValueError, json.JSONDecodeError):
            self._send_json(400, {"error": "Expected JSON body {id, scope?}"})
            return
        if scope not in ("one", "group"):
            self._send_json(400, {"error": "scope must be 'one' or 'group'"})
            return

        all_transactions = load_json(TRANSACTIONS_PATH, {})
        target = next((t for txns in all_transactions.values() for t in txns if t["id"] == txn_id), None)
        if target is None:
            self._send_json(404, {"error": f"No transaction with id {txn_id}"})
            return

        ids_to_delete = {txn_id}
        if scope == "group":
            all_flat = [t for txns in all_transactions.values() for t in txns]
            ids_to_delete = {t["id"] for t in pt.installment_set(target, all_flat)}

        deleted = []
        for month, txns in all_transactions.items():
            deleted.extend(t for t in txns if t["id"] in ids_to_delete)
            all_transactions[month] = [t for t in txns if t["id"] not in ids_to_delete]
        save_json(TRANSACTIONS_PATH, all_transactions)

        tombstones = load_json(pt.DELETED_TRANSACTIONS_PATH, [])
        tombstones.extend([t["date"], t["merchant"], t["amount"]] for t in deleted)
        save_json(pt.DELETED_TRANSACTIONS_PATH, tombstones)

        self._send_json(200, {"ok": True, "deleted_count": len(deleted), "undo": {"transactions": deleted}})

    def handle_undo_delete(self):
        try:
            payload = self._read_json_body()
            restored = payload["transactions"]
            for t in restored:
                t["id"], t["date"], t["merchant"], t["amount"]
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            self._send_json(400, {"error": "Expected JSON body {transactions: [full transaction objects]}"})
            return

        all_transactions = load_json(TRANSACTIONS_PATH, {})
        for t in restored:
            month_list = all_transactions.setdefault(pt.month_of(t["date"]), [])
            if not any(existing["id"] == t["id"] for existing in month_list):
                month_list.append(t)
        save_json(TRANSACTIONS_PATH, all_transactions)

        # Drop one tombstone per restored transaction so they're no longer
        # treated as deleted.
        tombstones = load_json(pt.DELETED_TRANSACTIONS_PATH, [])
        for t in restored:
            key = [t["date"], t["merchant"], t["amount"]]
            if key in tombstones:
                tombstones.remove(key)
        save_json(pt.DELETED_TRANSACTIONS_PATH, tombstones)

        self._send_json(200, {"ok": True})

    def handle_undo_category(self):
        try:
            payload = self._read_json_body()
            undo = payload["undo"]
        except (KeyError, ValueError, json.JSONDecodeError):
            self._send_json(400, {"error": "Expected JSON body {undo}"})
            return

        merchant = undo.get("merchant")
        overrides = load_json(MERCHANT_OVERRIDES_PATH, {})
        if merchant:
            if undo.get("previous_override") is None:
                overrides.pop(merchant, None)
            else:
                overrides[merchant] = undo["previous_override"]
            save_json(MERCHANT_OVERRIDES_PATH, overrides)

        all_transactions = load_json(TRANSACTIONS_PATH, {})

        if undo.get("type") == "split":
            new_ids = set(undo.get("new_ids", []))
            for month in list(all_transactions.keys()):
                all_transactions[month] = [t for t in all_transactions[month] if t["id"] not in new_ids]
            save_json(TRANSACTIONS_PATH, all_transactions)

            original = undo["original"]
            restored = {
                "date": original["date"],
                "merchant": original["merchant"],
                "description": original["description"],
                "amount": original["amount"],
                "category": original["category"],
                "source_file": original["source_file"],
            }
            pt.merge_transactions([restored])
            self._send_json(200, {"ok": True})
            return

        if undo.get("type") == "simple":
            txn_id = undo["id"]
            for txns in all_transactions.values():
                for txn in txns:
                    if txn["id"] == txn_id:
                        txn["category"] = undo["previous_category"]
                        save_json(TRANSACTIONS_PATH, all_transactions)
                        self._send_json(200, {"ok": True})
                        return
            self._send_json(404, {"error": f"No transaction with id {txn_id}"})
            return

        self._send_json(400, {"error": "Unknown undo type"})

    # -- manual one-off expense (no statement involved) ----------------------

    def handle_add_expense(self):
        try:
            payload = self._read_json_body()
            date = payload["date"]
            description = str(payload["description"]).strip()
            amount = float(payload["amount"])
            category = payload["category"]
        except (KeyError, ValueError, TypeError, json.JSONDecodeError):
            self._send_json(400, {"error": "Expected JSON body {date, description, amount, category}"})
            return

        if not description:
            self._send_json(400, {"error": "Description is required"})
            return
        if category not in pt.CATEGORIES:
            self._send_json(400, {"error": f"Unknown category '{category}'"})
            return
        try:
            parsed_date = pt.parse_date(date)
        except Exception:
            self._send_json(400, {"error": f"Invalid date '{date}'"})
            return

        # Reuses the exact same categorization-adjacent logic as everything
        # else (apply_averaging_rules + merge_transactions) so a manually
        # entered Travel expense or annual fee spreads over the calendar
        # year just like an imported one would, and dedup still applies.
        row = {
            "date": parsed_date,
            "merchant": description,
            "description": description,
            "amount": round(amount, 2),
            "category": category,
            "source_file": "Manual Entry",
        }
        rows = pt.apply_averaging_rules([row])
        added, skipped = pt.merge_transactions(rows)
        self._send_json(200, {"ok": True, "added": added, "skipped": skipped, "split": len(rows) > 1})

    # -- categorization rules (category_rules.json / merchant_overrides.json) -
    # These are read fresh from disk by categorize() on every single
    # categorization call (upload, manual expense, ambiguous-item resolution)
    # rather than being cached anywhere, so a change made here is already in
    # effect for the very next transaction processed - no restart needed.

    def handle_add_keyword_rule(self):
        try:
            payload = self._read_json_body()
            category = payload["category"]
            keyword = str(payload["keyword"]).strip()
        except (KeyError, ValueError, json.JSONDecodeError):
            self._send_json(400, {"error": "Expected JSON body {category, keyword}"})
            return

        if category not in pt.CATEGORIES:
            self._send_json(400, {"error": f"Unknown category '{category}'"})
            return
        if not keyword:
            self._send_json(400, {"error": "Keyword is required"})
            return

        category_rules = load_json(pt.CATEGORY_RULES_PATH, {})
        keywords = category_rules.setdefault(category, [])
        if any(k.upper() == keyword.upper() for k in keywords):
            self._send_json(400, {"error": f"'{keyword}' is already a rule under {category}"})
            return
        keywords.append(keyword)
        save_json(pt.CATEGORY_RULES_PATH, category_rules)
        self._send_json(200, {"ok": True, "category_rules": category_rules})

    def handle_remove_keyword_rule(self):
        try:
            payload = self._read_json_body()
            category = payload["category"]
            keyword = payload["keyword"]
        except (KeyError, ValueError, json.JSONDecodeError):
            self._send_json(400, {"error": "Expected JSON body {category, keyword}"})
            return

        category_rules = load_json(pt.CATEGORY_RULES_PATH, {})
        keywords = category_rules.get(category, [])
        remaining = [k for k in keywords if k != keyword]
        if len(remaining) == len(keywords):
            self._send_json(404, {"error": f"No rule '{keyword}' under {category}"})
            return
        category_rules[category] = remaining
        save_json(pt.CATEGORY_RULES_PATH, category_rules)
        self._send_json(200, {"ok": True, "category_rules": category_rules})

    def handle_add_override_rule(self):
        try:
            payload = self._read_json_body()
            key = str(payload["key"]).strip()
            category = payload["category"]
        except (KeyError, ValueError, json.JSONDecodeError):
            self._send_json(400, {"error": "Expected JSON body {key, category}"})
            return

        if category not in pt.CATEGORIES:
            self._send_json(400, {"error": f"Unknown category '{category}'"})
            return
        if not key:
            self._send_json(400, {"error": "Merchant / note text is required"})
            return

        overrides = load_json(MERCHANT_OVERRIDES_PATH, {})
        overrides[key] = category
        save_json(MERCHANT_OVERRIDES_PATH, overrides)
        self._send_json(200, {"ok": True, "merchant_overrides": overrides})

    def handle_remove_override_rule(self):
        try:
            payload = self._read_json_body()
            key = payload["key"]
        except (KeyError, ValueError, json.JSONDecodeError):
            self._send_json(400, {"error": "Expected JSON body {key}"})
            return

        overrides = load_json(MERCHANT_OVERRIDES_PATH, {})
        if key not in overrides:
            self._send_json(404, {"error": f"No override for '{key}'"})
            return
        del overrides[key]
        save_json(MERCHANT_OVERRIDES_PATH, overrides)
        self._send_json(200, {"ok": True, "merchant_overrides": overrides})

    # -- averaging rules (averaging_rules.json) -------------------------------
    # Same immediacy guarantee as the keyword/override rules above:
    # apply_averaging_rules() calls load_averaging_rules() fresh (no
    # in-memory cache), so an edit here applies to the very next transaction
    # processed - upload, manual expense, or manual recategorization.

    def _parse_averaging_rule_payload(self, payload):
        """Validates and normalizes a rule payload, raising ValueError with a
        user-facing message on anything invalid. Returns the normalized dict
        (without an id - callers attach/preserve that separately)."""
        trigger_type = payload.get("trigger_type")
        if trigger_type not in ("category", "keyword"):
            raise ValueError("trigger_type must be 'category' or 'keyword'")

        trigger_value = str(payload.get("trigger_value", "")).strip()
        if not trigger_value:
            raise ValueError("trigger_value is required")
        if trigger_type == "category" and trigger_value not in pt.CATEGORIES:
            raise ValueError(f"Unknown category '{trigger_value}'")

        min_amount = payload.get("min_amount")
        if min_amount in ("", None):
            min_amount = None
        else:
            try:
                min_amount = float(min_amount)
            except (TypeError, ValueError):
                raise ValueError("min_amount must be a number")

        spread_type = payload.get("spread_type")
        if spread_type not in ("calendar_year", "installments"):
            raise ValueError("spread_type must be 'calendar_year' or 'installments'")

        months = payload.get("months")
        if spread_type == "installments":
            try:
                months = int(months)
            except (TypeError, ValueError):
                raise ValueError("months is required and must be a whole number for installment spreads")
            if months < 1:
                raise ValueError("months must be at least 1")
        else:
            months = None

        return {
            "trigger_type": trigger_type,
            "trigger_value": trigger_value,
            "min_amount": min_amount,
            "spread_type": spread_type,
            "months": months,
        }

    def handle_add_averaging_rule(self):
        try:
            payload = self._read_json_body()
            rule = self._parse_averaging_rule_payload(payload)
        except (ValueError, json.JSONDecodeError) as exc:
            self._send_json(400, {"error": str(exc)})
            return

        rules = pt.load_averaging_rules()
        rule["id"] = uuid.uuid4().hex[:12]
        rules.append(rule)
        save_json(pt.AVERAGING_RULES_PATH, rules)
        self._send_json(200, {"ok": True, "averaging_rules": rules})

    def handle_update_averaging_rule(self):
        try:
            payload = self._read_json_body()
            rule_id = payload["id"]
            rule = self._parse_averaging_rule_payload(payload)
        except (KeyError, ValueError, json.JSONDecodeError) as exc:
            self._send_json(400, {"error": str(exc) or "Expected JSON body with rule fields and an id"})
            return

        rules = pt.load_averaging_rules()
        for i, existing in enumerate(rules):
            if existing["id"] == rule_id:
                rule["id"] = rule_id
                rules[i] = rule
                save_json(pt.AVERAGING_RULES_PATH, rules)
                self._send_json(200, {"ok": True, "averaging_rules": rules})
                return
        self._send_json(404, {"error": f"No averaging rule with id {rule_id}"})

    def handle_remove_averaging_rule(self):
        try:
            payload = self._read_json_body()
            rule_id = payload["id"]
        except (KeyError, ValueError, json.JSONDecodeError):
            self._send_json(400, {"error": "Expected JSON body {id}"})
            return

        rules = pt.load_averaging_rules()
        remaining = [r for r in rules if r["id"] != rule_id]
        if len(remaining) == len(rules):
            self._send_json(404, {"error": f"No averaging rule with id {rule_id}"})
            return
        save_json(pt.AVERAGING_RULES_PATH, remaining)
        self._send_json(200, {"ok": True, "averaging_rules": remaining})

    # -- upload wizard -------------------------------------------------------

    def handle_upload(self):
        """Stage 1: receive the file, save it into uploads/, and either
        proceed straight to categorization (known statement format) or ask
        the browser for a column mapping (new format)."""
        payload = self._read_json_body()
        filename = payload["filename"]
        content = base64.b64decode(payload["content_base64"])

        os.makedirs(UPLOADS_DIR, exist_ok=True)
        saved_path = os.path.join(UPLOADS_DIR, os.path.basename(filename))
        with open(saved_path, "wb") as f:
            f.write(content)

        df = pt.read_transactions_file(saved_path)
        cached_mapping = pt.lookup_cached_mapping(df)

        if cached_mapping is None:
            upload_id = uuid.uuid4().hex
            PENDING_UPLOADS[upload_id] = {"stage": "needs_mapping", "df": df, "source_file": filename}
            ui_guess = pt.guess_mapping_for_ui(df, filename)
            self._send_json(200, {
                "status": "needs_mapping",
                "upload_id": upload_id,
                "columns": ui_guess["columns"],
                "guesses": ui_guess["guesses"],
                "is_p2p_guess": ui_guess["is_p2p_guess"],
            })
            return

        rows = pt.normalize_rows(df, cached_mapping, filename)
        self._respond_with_categorization(rows)

    def handle_upload_mapping(self):
        """Stage 2: browser submitted a column mapping for a new format."""
        payload = self._read_json_body()
        upload_id = payload["upload_id"]
        mapping = payload["mapping"]

        pending = PENDING_UPLOADS.get(upload_id)
        if not pending or pending["stage"] != "needs_mapping":
            self._send_json(404, {"error": "Unknown or already-completed upload."})
            return

        pt.validate_mapping(mapping)

        df = pending["df"]
        pt.save_column_mapping(df, mapping)
        rows = pt.normalize_rows(df, mapping, pending["source_file"])
        del PENDING_UPLOADS[upload_id]
        self._respond_with_categorization(rows)

    def _respond_with_categorization(self, rows):
        """Shared by both upload entry points once a mapping is known:
        categorize every row, and either finish immediately or ask the
        browser to resolve whatever's ambiguous."""
        manual_count, ambiguous_items = categorize_rows(rows)

        if ambiguous_items:
            upload_id = uuid.uuid4().hex
            PENDING_UPLOADS[upload_id] = {"stage": "needs_categories", "rows": rows, "manual_count": manual_count}
            self._send_json(200, {
                "status": "needs_categories",
                "upload_id": upload_id,
                "items": ambiguous_items,
                "categories": pt.CATEGORIES,
            })
            return

        new_transactions, added, skipped = finalize_rows(rows)
        summary = pt.build_summary_dict(new_transactions, manual_count, added, skipped)
        self._send_json(200, {"status": "done", "summary": summary})

    def handle_upload_categories(self):
        """Stage 3: browser submitted a category for every ambiguous item."""
        payload = self._read_json_body()
        upload_id = payload["upload_id"]
        categories_by_key = payload["categories"]

        pending = PENDING_UPLOADS.get(upload_id)
        if not pending or pending["stage"] != "needs_categories":
            self._send_json(404, {"error": "Unknown or already-completed upload."})
            return

        rows = pending["rows"]
        manual_count = pending["manual_count"]
        overrides = load_json(MERCHANT_OVERRIDES_PATH, {})
        pt.apply_categories_from_ui(rows, categories_by_key, overrides)
        del PENDING_UPLOADS[upload_id]

        new_transactions, added, skipped = finalize_rows(rows)
        summary = pt.build_summary_dict(new_transactions, manual_count, added, skipped)
        self._send_json(200, {"status": "done", "summary": summary})

    def log_message(self, format, *args):
        print(f"[server] {self.address_string()} - {format % args}")


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Serving dashboard at http://localhost:{PORT} (listening on {HOST}:{PORT})")
    if DASHBOARD_USERNAME and DASHBOARD_PASSWORD:
        print("Login required (DASHBOARD_USERNAME/DASHBOARD_PASSWORD are set).")
    else:
        print("No login required - set DASHBOARD_USERNAME/DASHBOARD_PASSWORD env vars to require one.")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.shutdown()


if __name__ == "__main__":
    main()
