"""
process_transactions.py

Deterministic, rule-based transaction categorizer.

Usage:
    python process_transactions.py uploads/july_statement.csv

Reads a credit card statement (CSV or Excel), categorizes each transaction
using category_rules.json / merchant_overrides.json (no AI, no randomness),
prompts in the terminal for anything ambiguous, and merges the results into
data/transactions.json for the dashboard to read.
"""

import sys
import os
import re
import hashlib
import calendar
from collections import Counter
from datetime import datetime

import pandas as pd

from storage import load_json, save_json

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CATEGORY_RULES_PATH = os.path.join(BASE_DIR, "category_rules.json")
MERCHANT_OVERRIDES_PATH = os.path.join(BASE_DIR, "merchant_overrides.json")
COLUMN_MAPPINGS_PATH = os.path.join(BASE_DIR, "column_mappings.json")
BUDGETS_PATH = os.path.join(BASE_DIR, "budgets.json")
TRANSACTIONS_PATH = os.path.join(BASE_DIR, "data", "transactions.json")
AVERAGING_RULES_PATH = os.path.join(BASE_DIR, "averaging_rules.json")

CATEGORIES = ["Shopping", "Groceries", "Dining", "Transportation", "Travel", "Activities", "Miscellaneous"]

# Candidate source-column header names we look for when auto-mapping.
COLUMN_CANDIDATES = {
    "date": ["date", "transaction date", "posted date", "post date"],
    "merchant": ["merchant", "merchant name", "payee", "name"],
    "description": ["description", "memo", "details"],
    "amount": ["amount", "transaction amount"],
    "debit": ["debit", "debit amount", "withdrawal"],
    "credit": ["credit", "credit amount", "deposit", "payment"],
    "type": ["type", "transaction type"],
}

# Any merchant/description containing one of these is an annual membership
# or card fee - always categorized as Miscellaneous (see categorize() below).
# Whether/how an annual fee gets spread across months is a separate,
# user-editable concern - see averaging_rules.json / DEFAULT_AVERAGING_RULES.
ANNUAL_FEE_KEYWORDS = ["ANNUAL FEE", "ANNUAL MEMBERSHIP FEE"]

# Seeded into averaging_rules.json the first time it's needed. Each rule says
# how to spread a transaction's amount across months: "category" rules match
# on the transaction's resolved category, "keyword" rules match on merchant
# text (case-insensitive substring), and an optional min_amount only applies
# the rule above that dollar amount. Rules are tried in order; the first
# match wins. spread_type "calendar_year" spreads evenly across Jan-Dec of
# the transaction's year; "installments" spreads across `months` months
# starting with the transaction's own month.
DEFAULT_AVERAGING_RULES = [
    {
        "id": "default-travel",
        "trigger_type": "category",
        "trigger_value": "Travel",
        "min_amount": None,
        "spread_type": "calendar_year",
        "months": None,
    },
    {
        "id": "default-annual-fee",
        "trigger_type": "keyword",
        "trigger_value": "ANNUAL FEE",
        "min_amount": None,
        "spread_type": "calendar_year",
        "months": None,
    },
    {
        "id": "default-annual-membership-fee",
        "trigger_type": "keyword",
        "trigger_value": "ANNUAL MEMBERSHIP FEE",
        "min_amount": None,
        "spread_type": "calendar_year",
        "months": None,
    },
    {
        "id": "default-walmart",
        "trigger_type": "keyword",
        "trigger_value": "WALMART",
        "min_amount": 150,
        "spread_type": "installments",
        "months": 3,
    },
    {
        "id": "default-target",
        "trigger_type": "keyword",
        "trigger_value": "TARGET",
        "min_amount": 150,
        "spread_type": "installments",
        "months": 3,
    },
]


# ---------------------------------------------------------------------------
# File loading + column mapping
# ---------------------------------------------------------------------------

def read_transactions_file(path):
    ext = os.path.splitext(path)[1].lower()
    if ext == ".csv":
        df = pd.read_csv(path)
    elif ext in (".xlsx", ".xls"):
        df = read_excel_or_html_table(path)
    else:
        raise ValueError(f"Unsupported file type: {ext} (expected .csv, .xlsx, or .xls)")
    # Drop fully-empty rows/columns which some bank exports include.
    df = df.dropna(how="all")
    return df


def read_excel_or_html_table(path):
    """Some banks (Discover's "DFS-Search" export, for one) label a file
    '.xls' when it's actually an HTML document with one or more <table>
    elements, not a real binary/OOXML spreadsheet - pandas' Excel reader
    can't open that. Try a real Excel read first; if that fails, fall back
    to parsing it as HTML and pick out the table that actually looks like
    transaction data. A statement export usually has a small
    account/header table (name, address, account number - just one or two
    columns) ahead of the real transactions table, so picking the widest
    (then tallest) table reliably finds the right one."""
    try:
        return pd.read_excel(path)
    except Exception:
        # header=0 forces the first row of each table to be treated as
        # column names - the transaction table's header row is plain <td>
        # text (no <th>), which pandas otherwise won't auto-detect as a
        # header and instead surfaces as a numbered-column data row.
        tables = pd.read_html(path, header=0)
        if not tables:
            raise ValueError(f"Could not find any tables in {path}")
        return max(tables, key=lambda t: (t.shape[1], t.shape[0]))


def source_key_for(df):
    """A key that identifies this 'bank export format' by its header shape."""
    headers = sorted(str(c).strip().lower() for c in df.columns)
    return "|".join(headers)


def auto_guess_column(headers, candidates):
    lower_map = {str(h).strip().lower(): h for h in headers}
    for candidate in candidates:
        if candidate in lower_map:
            return lower_map[candidate]
    return None


def prompt_for_mapping(df, source_file=""):
    headers = list(df.columns)
    print("\nNew statement format detected. Let's map its columns once.")
    print(f"Columns found: {', '.join(str(h) for h in headers)}\n")

    mapping = {}
    for field, candidates in COLUMN_CANDIDATES.items():
        guess = auto_guess_column(headers, candidates)
        required = field in ("date", "merchant")
        prompt = f"  Column for '{field}'"
        if guess:
            prompt += f" [guess: {guess}]"
        elif not required:
            prompt += " (optional, press Enter to skip)"
        prompt += ": "

        answer = input(prompt).strip()
        if not answer and guess:
            mapping[field] = guess
        elif not answer:
            mapping[field] = None
        elif answer in headers:
            mapping[field] = answer
        else:
            # allow case-insensitive typed header
            match = next((h for h in headers if str(h).strip().lower() == answer.lower()), None)
            mapping[field] = match

    if not mapping.get("merchant") and not mapping.get("description"):
        raise ValueError("Need at least a 'merchant' or 'description' column to categorize transactions.")
    if not mapping.get("amount") and not (mapping.get("debit") or mapping.get("credit")):
        raise ValueError("Need either an 'amount' column or 'debit'/'credit' columns.")
    if not mapping.get("date"):
        raise ValueError("Need a 'date' column.")

    mapping["is_p2p"] = prompt_for_is_p2p(source_file)

    if mapping.get("amount"):
        mapping["amount_sign"] = prompt_for_amount_sign(mapping["is_p2p"])

    return mapping


def prompt_for_is_p2p(source_file):
    default_guess = any(word in source_file.lower() for word in ("venmo", "zelle"))
    print("\n  Is this a Venmo or Zelle statement (payments between people, not a")
    print("  bank/credit card statement)?")
    default_label = "Y/n" if default_guess else "y/N"
    answer = input(f"  [{default_label}] > ").strip().lower()
    if not answer:
        return default_guess
    return answer.startswith("y")


def prompt_for_amount_sign(is_p2p=False):
    if is_p2p:
        print("\n  In this file's Amount column, do positive numbers mean money going")
        print("  OUT (you paid someone), or money coming IN (someone paid you back)?")
        print("    [1] Positive = money going out (most common)")
        print("    [2] Negative = money going out")
    else:
        print("\n  In this file's Amount column, do positive numbers mean money you")
        print("  spent (charges), or money credited back to you (payments/refunds)?")
        print("    [1] Positive = money spent (most common)")
        print("    [2] Negative = money spent (e.g. many bank exports list purchases as negative)")
    while True:
        choice = input("  > ").strip()
        if choice == "1":
            return "positive_is_spend"
        if choice == "2":
            return "negative_is_spend"
        print("  Please enter 1 or 2.")


def get_or_create_column_mapping(df, source_file=""):
    mappings = load_json(COLUMN_MAPPINGS_PATH, {})
    key = source_key_for(df)
    if key in mappings:
        print("Recognized statement format, reusing saved column mapping.")
        return mappings[key]

    mapping = prompt_for_mapping(df, source_file)
    mappings[key] = mapping
    save_json(COLUMN_MAPPINGS_PATH, mappings)
    return mapping


# ---------------------------------------------------------------------------
# Non-interactive equivalents (used by server.py's web upload flow, where
# there's no terminal to prompt on - the dashboard collects the same answers
# through a form instead).
# ---------------------------------------------------------------------------

def lookup_cached_mapping(df):
    """Returns the saved mapping for this file's header shape, or None if
    this format hasn't been seen before and needs a mapping form."""
    mappings = load_json(COLUMN_MAPPINGS_PATH, {})
    return mappings.get(source_key_for(df))


def guess_mapping_for_ui(df, source_file=""):
    """Column guesses for building a web mapping form - the same guesses
    prompt_for_mapping would show, just returned as data instead of printed."""
    headers = [str(h) for h in df.columns]
    guesses = {field: auto_guess_column(df.columns, candidates) for field, candidates in COLUMN_CANDIDATES.items()}
    is_p2p_guess = any(word in source_file.lower() for word in ("venmo", "zelle"))
    return {"columns": headers, "guesses": guesses, "is_p2p_guess": is_p2p_guess}


def validate_mapping(mapping):
    """Raises ValueError with a user-facing message if the mapping is missing
    a required field - mirrors the checks in prompt_for_mapping."""
    if not mapping.get("merchant") and not mapping.get("description"):
        raise ValueError("Need at least a 'merchant' or 'description' column to categorize transactions.")
    if not mapping.get("amount") and not (mapping.get("debit") or mapping.get("credit")):
        raise ValueError("Need either an 'amount' column or 'debit'/'credit' columns.")
    if not mapping.get("date"):
        raise ValueError("Need a 'date' column.")


def save_column_mapping(df, mapping):
    mappings = load_json(COLUMN_MAPPINGS_PATH, {})
    mappings[source_key_for(df)] = mapping
    save_json(COLUMN_MAPPINGS_PATH, mappings)


def collect_ambiguous_items(ambiguous_rows):
    """Dedupes ambiguous rows by category_key for display in a web form -
    the same de-duplication resolve_ambiguous_transactions does before
    prompting, just returned as data instead of prompted one at a time."""
    seen = set()
    items = []
    for row in ambiguous_rows:
        key = row["category_key"]
        if key in seen:
            continue
        seen.add(key)
        items.append({
            "key": key,
            "merchant": row["merchant"],
            "description": row["description"],
            "amount": row["amount"],
            "date": row["date"],
            "is_p2p": row.get("is_p2p", False),
        })
    return items


def apply_categories_from_ui(rows, categories_by_key, overrides):
    """Assigns categories chosen in the web form back onto their rows and
    persists them as merchant overrides, same as resolve_ambiguous_transactions
    does for terminal answers."""
    for row in rows:
        if row.get("category") is None:
            chosen = categories_by_key.get(row["category_key"])
            if chosen:
                row["category"] = chosen
    for key, category in categories_by_key.items():
        overrides[key] = category
    save_json(MERCHANT_OVERRIDES_PATH, overrides)


def build_summary_dict(new_transactions, manual_count, added, skipped):
    """Same data print_summary prints to the terminal, structured for a JSON
    response instead."""
    by_month = {}
    for txn in new_transactions:
        by_month.setdefault(month_of(txn["date"]), []).append(txn)

    budgets = load_json(BUDGETS_PATH, {})

    months = []
    for month, txns in sorted(by_month.items()):
        totals = {}
        for txn in txns:
            totals[txn["category"]] = totals.get(txn["category"], 0.0) + txn["amount"]
        months.append({
            "month": month,
            "has_budget": month in budgets,
            "totals": totals,
            "total": round(sum(totals.values()), 2),
        })

    return {
        "months": months,
        "added": added,
        "skipped": skipped,
        "manual_count": manual_count,
    }


# ---------------------------------------------------------------------------
# Row normalization
# ---------------------------------------------------------------------------

def parse_amount(value):
    if pd.isna(value):
        return 0.0
    if isinstance(value, str):
        value = value.replace("$", "").replace(",", "").strip()
        if value.startswith("(") and value.endswith(")"):
            value = "-" + value[1:-1]
        # Some exports put a space between the sign and the digits, e.g. "- 97.09".
        value = re.sub(r"^([+-])\s+", r"\1", value)
        if value == "":
            return 0.0
    return float(value)


def parse_date(value):
    if pd.isna(value):
        raise ValueError("Missing date value")
    if isinstance(value, (pd.Timestamp, datetime)):
        return value.strftime("%Y-%m-%d")
    parsed = pd.to_datetime(str(value))
    return parsed.strftime("%Y-%m-%d")


def normalize_rows(df, mapping, source_file):
    is_p2p = mapping.get("is_p2p", False)
    rows = []
    for idx, row in df.reset_index(drop=True).iterrows():
        if mapping.get("type") and not is_p2p:
            type_value = str(row[mapping["type"]]).strip().upper()
            if "PAYMENT" in type_value:
                # A payment made toward the card balance, not a purchase — exclude entirely.
                # (Skipped for Venmo/Zelle statements, where "Payment" is a normal
                # person-to-person transaction, not a balance payoff.)
                continue

        date = parse_date(row[mapping["date"]])

        merchant = ""
        description = ""
        if mapping.get("merchant") and pd.notna(row[mapping["merchant"]]):
            merchant = str(row[mapping["merchant"]]).strip()
        if mapping.get("description") and pd.notna(row[mapping["description"]]):
            description = str(row[mapping["description"]]).strip()
        if not merchant:
            merchant = description
        if not description:
            description = merchant

        if mapping.get("amount"):
            amount = parse_amount(row[mapping["amount"]])
            if mapping.get("amount_sign") == "negative_is_spend":
                amount = -amount
        else:
            debit = parse_amount(row[mapping["debit"]]) if mapping.get("debit") else 0.0
            credit = parse_amount(row[mapping["credit"]]) if mapping.get("credit") else 0.0
            amount = debit - credit

        rows.append({
            "date": date,
            "merchant": merchant,
            "description": description,
            "amount": round(amount, 2),
            "source_file": source_file,
            "is_p2p": is_p2p,
            # Venmo/Zelle notes (not the counterparty name) carry the actual
            # spending reason, so categorization keys off description for
            # those; everything else keys off merchant as before.
            "category_key": description if is_p2p else merchant,
        })
    return rows


# ---------------------------------------------------------------------------
# Categorization pipeline (deterministic)
# ---------------------------------------------------------------------------

def find_override_category(merchant, overrides):
    merchant_upper = merchant.upper()
    for key, category in overrides.items():
        if key.upper() in merchant_upper:
            return category
    return None


def find_keyword_matches(merchant, category_rules):
    merchant_upper = merchant.upper()
    matches = []
    for category, keywords in category_rules.items():
        for keyword in keywords:
            if keyword.upper() in merchant_upper:
                matches.append(category)
                break
    return matches


def categorize(merchant, category_rules, overrides):
    """Returns (category_or_None, needs_prompt)."""
    override_category = find_override_category(merchant, overrides)
    if override_category:
        return override_category, False

    merchant_upper = merchant.upper()
    if "WALMART" in merchant_upper or "TARGET" in merchant_upper:
        return "Groceries", False

    if is_annual_fee(merchant):
        return "Miscellaneous", False

    matches = find_keyword_matches(merchant, category_rules)
    unique_matches = list(dict.fromkeys(matches))
    if len(unique_matches) == 1:
        return unique_matches[0], False

    # Zero matches or multiple conflicting matches -> ambiguous, ask the user.
    return None, True


def prompt_for_category(row):
    print(f"\n  Merchant:  {row['merchant']}")
    if row.get("is_p2p"):
        print(f"  Note:      {row['description']}")
        direction = "Money out (you paid someone)" if row["amount"] > 0 else "Money in (repayment/refund to you)"
        print(f"  Direction: {direction}")
    print(f"  Amount:    ${row['amount']:.2f}")
    print(f"  Date:      {row['date']}")
    if row.get("is_p2p"):
        print("  This is a confusing Venmo/Zelle transaction - which category should")
        print("  it count against?")
    else:
        print("  Which category does this belong to?")
    for i, cat in enumerate(CATEGORIES, start=1):
        print(f"    [{i}] {cat}")

    while True:
        choice = input("  > ").strip()
        if choice.isdigit() and 1 <= int(choice) <= len(CATEGORIES):
            return CATEGORIES[int(choice) - 1]
        match = next((c for c in CATEGORIES if c.lower() == choice.lower()), None)
        if match:
            return match
        print(f"  Please enter a number 1-{len(CATEGORIES)} (or a category name).")


def resolve_ambiguous_transactions(ambiguous_rows, overrides):
    """Batch-prompt for every distinct ambiguous categorization key, once each.
    For normal statements the key is the merchant; for Venmo/Zelle statements
    it's the note text, since that's what conveys what the money was for."""
    if not ambiguous_rows:
        return

    print(f"\n{len(ambiguous_rows)} transaction(s) need manual categorization.")
    seen_keys = {}
    for row in ambiguous_rows:
        key = row["category_key"]
        if key not in seen_keys:
            category = prompt_for_category(row)
            seen_keys[key] = category
            overrides[key] = category
        row["category"] = seen_keys[key]

    save_json(MERCHANT_OVERRIDES_PATH, overrides)


# ---------------------------------------------------------------------------
# Averaging rules (user-editable via averaging_rules.json / the dashboard's
# Rules tab - see DEFAULT_AVERAGING_RULES above for the schema)
# ---------------------------------------------------------------------------

def load_averaging_rules():
    """Returns the current averaging rules, seeding the file with the
    defaults the first time it's needed so there's always something on disk
    the dashboard can list/edit."""
    rules = load_json(AVERAGING_RULES_PATH, None)
    if rules is None:
        rules = [dict(r) for r in DEFAULT_AVERAGING_RULES]
        save_json(AVERAGING_RULES_PATH, rules)
    return rules


def find_matching_averaging_rule(row, rules):
    """Returns the first rule (in list order) whose trigger and optional
    min_amount match this row, or None if no rule applies."""
    for rule in rules:
        if rule["trigger_type"] == "category":
            if row["category"] != rule["trigger_value"]:
                continue
        else:
            if rule["trigger_value"].upper() not in row["merchant"].upper():
                continue

        min_amount = rule.get("min_amount")
        if min_amount is not None and not (row["amount"] > min_amount):
            continue

        return rule
    return None


def is_annual_fee(merchant):
    merchant_upper = merchant.upper()
    return any(keyword in merchant_upper for keyword in ANNUAL_FEE_KEYWORDS)


def add_months(date_str, num_months):
    d = datetime.strptime(date_str, "%Y-%m-%d")
    month_index = d.month - 1 + num_months
    year = d.year + month_index // 12
    month = month_index % 12 + 1
    day = min(d.day, calendar.monthrange(year, month)[1])
    return datetime(year, month, day).strftime("%Y-%m-%d")


def split_across_dates(row, target_dates):
    """Spread row['amount'] evenly across target_dates. The final
    installment absorbs any rounding remainder so the installments always
    sum exactly to the original amount."""
    num = len(target_dates)
    base = round(row["amount"] / num, 2)
    amounts = [base] * (num - 1)
    amounts.append(round(row["amount"] - base * (num - 1), 2))

    installments = []
    for i, (date, amt) in enumerate(zip(target_dates, amounts)):
        installment = dict(row)
        installment["date"] = date
        installment["amount"] = amt
        installment["description"] = f"{row['description']} (avg {i + 1}/{num})"
        installments.append(installment)
    return installments


def split_into_installments(row, num_months):
    """Spread row['amount'] evenly across num_months, starting with row's
    own month plus the following (num_months - 1) months."""
    target_dates = [add_months(row["date"], i) for i in range(num_months)]
    return split_across_dates(row, target_dates)


def split_across_calendar_year(row):
    """Spread row['amount'] evenly across all 12 months of the calendar
    year that row's own date falls in (Jan-Dec), not the following 12
    months."""
    d = datetime.strptime(row["date"], "%Y-%m-%d")
    target_dates = []
    for month in range(1, 13):
        day = min(d.day, calendar.monthrange(d.year, month)[1])
        target_dates.append(datetime(d.year, month, day).strftime("%Y-%m-%d"))
    return split_across_dates(row, target_dates)


def apply_averaging_rules(rows, rules=None):
    """Runs every row against the (user-editable) averaging rules and, for
    whichever rule matches first, replaces the original lump-sum transaction
    with installments spread across months so spend isn't double-counted.
    Rows matching no rule are left as a single transaction in the month they
    occurred."""
    if rules is None:
        rules = load_averaging_rules()

    expanded = []
    for row in rows:
        rule = find_matching_averaging_rule(row, rules)
        if rule is None:
            expanded.append(row)
        elif rule["spread_type"] == "calendar_year":
            expanded.extend(split_across_calendar_year(row))
        else:
            expanded.extend(split_into_installments(row, rule.get("months") or 1))
    return expanded


# ---------------------------------------------------------------------------
# Transaction id + merge
# ---------------------------------------------------------------------------

def make_id(date, merchant, amount, occurrence_index):
    raw = f"{date}|{merchant}|{amount}|{occurrence_index}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def month_of(date_str):
    return date_str[:7]  # YYYY-MM


def natural_key(txn):
    """(date, merchant, amount) - identifies "the same transaction" regardless
    of which statement export or row position it came from, so re-uploading
    an overlapping statement (e.g. a full-month export after a partial one)
    doesn't double-count anything already on file."""
    return (txn["date"], txn["merchant"], txn["amount"])


def merge_transactions(new_transactions):
    """Dedupe by content, not by row position. Each month keeps a multiset
    (Counter) of (date, merchant, amount) keys already on file. A new
    transaction is only treated as a duplicate if there's still an
    unmatched existing entry with the same key; once those are used up,
    further transactions with that same key (whether genuinely repeated
    same-day charges, or overlap from a re-uploaded statement) are compared
    against what's actually already stored, so nothing is silently dropped
    or double-added.
    """
    all_transactions = load_json(TRANSACTIONS_PATH, {})
    added, skipped = 0, 0

    by_month = {}
    for txn in new_transactions:
        by_month.setdefault(month_of(txn["date"]), []).append(txn)

    for month, txns in by_month.items():
        month_list = all_transactions.setdefault(month, [])
        unmatched_existing = Counter(natural_key(t) for t in month_list)
        total_seen = Counter(natural_key(t) for t in month_list)

        for txn in txns:
            key = natural_key(txn)
            if unmatched_existing[key] > 0:
                unmatched_existing[key] -= 1
                skipped += 1
                continue

            occurrence_index = total_seen[key]
            total_seen[key] += 1
            txn["id"] = make_id(txn["date"], txn["merchant"], txn["amount"], occurrence_index)
            month_list.append(txn)
            added += 1

    save_json(TRANSACTIONS_PATH, all_transactions)
    return added, skipped


# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

def print_summary(new_transactions, manual_count, added, skipped):
    if not new_transactions:
        print("\nNo new transactions processed.")
        return

    by_month = {}
    for txn in new_transactions:
        by_month.setdefault(month_of(txn["date"]), []).append(txn)

    budgets = load_json(BUDGETS_PATH, {})

    print("\n" + "=" * 50)
    print("SUMMARY")
    print("=" * 50)
    for month, txns in sorted(by_month.items()):
        print(f"\nMonth: {month}")
        if month not in budgets:
            print(f"  WARNING: no budget entry found for {month} in budgets.json")
        totals = {}
        for txn in txns:
            totals[txn["category"]] = totals.get(txn["category"], 0.0) + txn["amount"]
        for cat in CATEGORIES:
            if cat in totals:
                print(f"  {cat:<15} ${totals[cat]:>10.2f}")
        grand_total = sum(totals.values())
        print(f"  {'TOTAL':<15} ${grand_total:>10.2f}")

    print(f"\nNew transactions added: {added}")
    print(f"Duplicate transactions skipped: {skipped}")
    print(f"Transactions requiring manual categorization: {manual_count}")
    print("=" * 50)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def prompt_for_file_path():
    print("Which statement file do you want to process?")
    while True:
        answer = input("Enter the file path (CSV or Excel): ").strip().strip('"')
        if not answer:
            print("Please enter a file path.")
            continue
        if not os.path.exists(answer):
            print(f"File not found: {answer}")
            continue
        return answer


# ---------------------------------------------------------------------------
# Manual expense entry (no statement file - a one-off expense typed/sent in)
# ---------------------------------------------------------------------------

def prompt_for_manual_expense():
    print("\nManually add an expense.")
    while True:
        date_input = input("  Date (YYYY-MM-DD): ").strip()
        try:
            date = parse_date(date_input)
            break
        except Exception:
            print("  Please enter a valid date.")

    description = input("  Description: ").strip()

    while True:
        amount_input = input("  Amount ($): ").strip()
        try:
            amount = float(amount_input.replace("$", "").replace(",", ""))
            break
        except ValueError:
            print("  Please enter a numeric amount.")

    print("  Which category does this belong to?")
    for i, cat in enumerate(CATEGORIES, start=1):
        print(f"    [{i}] {cat}")
    while True:
        choice = input("  > ").strip()
        if choice.isdigit() and 1 <= int(choice) <= len(CATEGORIES):
            category = CATEGORIES[int(choice) - 1]
            break
        match = next((c for c in CATEGORIES if c.lower() == choice.lower()), None)
        if match:
            category = match
            break
        print(f"  Please enter a number 1-{len(CATEGORIES)} (or a category name).")

    return date, description, amount, category


def parse_manual_add_flags(args):
    """Parses --key value pairs (e.g. --date 2026-01-15 --amount 844) into a dict."""
    flags = {}
    i = 0
    while i < len(args):
        token = args[i]
        if token.startswith("--") and i + 1 < len(args):
            flags[token[2:]] = args[i + 1]
            i += 2
        else:
            i += 1
    return flags


def add_manual_expense(date, description, amount, category, source_file="Manual Entry"):
    """Adds a single hand-entered expense, running it through the same
    averaging rules (Travel, large Walmart/Target) as statement imports."""
    row = {
        "date": parse_date(date),
        "merchant": description,
        "description": description,
        "amount": round(float(amount), 2),
        "category": category,
        "source_file": source_file,
    }
    rows = apply_averaging_rules([row])
    added, skipped = merge_transactions(rows)
    print_summary(rows, 0, added, skipped)
    return added, skipped


def handle_manual_add(args):
    flags = parse_manual_add_flags(args)
    if flags:
        missing = [f for f in ("date", "description", "amount", "category") if f not in flags]
        if missing:
            print(f"Missing required flag(s) for --add: {', '.join('--' + m for m in missing)}")
            print('Usage: python process_transactions.py --add --date YYYY-MM-DD --description "..." --amount 123.45 --category Travel')
            sys.exit(1)
        category = next((c for c in CATEGORIES if c.lower() == flags["category"].lower()), None)
        if not category:
            print(f"Unknown category '{flags['category']}'. Valid categories: {', '.join(CATEGORIES)}")
            sys.exit(1)
        try:
            amount = float(flags["amount"].replace("$", "").replace(",", ""))
        except ValueError:
            print(f"Amount '{flags['amount']}' is not a valid number.")
            sys.exit(1)
        date = flags["date"]
        description = flags["description"]
    else:
        date, description, amount, category = prompt_for_manual_expense()

    add_manual_expense(date, description, amount, category)


def main():
    args = sys.argv[1:]

    if args and args[0] == "--add":
        handle_manual_add(args[1:])
        return

    if len(args) == 1:
        file_path = args[0]
        if not os.path.exists(file_path):
            print(f"File not found: {file_path}")
            sys.exit(1)
    elif len(args) == 0:
        file_path = prompt_for_file_path()
    else:
        print("Usage: python process_transactions.py [path-to-statement.csv|.xlsx]")
        print("       python process_transactions.py --add [--date YYYY-MM-DD --description \"...\" --amount 123.45 --category Travel]")
        print("(Run with no argument to be prompted for a file path.)")
        sys.exit(1)

    source_file = os.path.basename(file_path)

    df = read_transactions_file(file_path)
    mapping = get_or_create_column_mapping(df, source_file)
    rows = normalize_rows(df, mapping, source_file)

    category_rules = load_json(CATEGORY_RULES_PATH, {})
    overrides = load_json(MERCHANT_OVERRIDES_PATH, {})

    ambiguous_rows = []
    for row in rows:
        category, needs_prompt = categorize(row["category_key"], category_rules, overrides)
        if needs_prompt:
            ambiguous_rows.append(row)
        else:
            row["category"] = category

    manual_count = len(ambiguous_rows)
    resolve_ambiguous_transactions(ambiguous_rows, overrides)

    new_transactions = []
    for row in rows:
        new_transactions.append({
            "date": row["date"],
            "merchant": row["merchant"],
            "description": row["description"],
            "amount": row["amount"],
            "category": row["category"],
            "source_file": row["source_file"],
        })

    new_transactions = apply_averaging_rules(new_transactions)

    added, skipped = merge_transactions(new_transactions)
    print_summary(new_transactions, manual_count, added, skipped)


if __name__ == "__main__":
    main()
