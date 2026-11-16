#!/usr/bin/env python3
"""Download and preprocess the official Open Government source into a static site."""
import argparse
import csv
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import gzip
import json
from pathlib import Path
import re
import shutil
import sys
import tempfile
import time
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
MODE = "graveyard"
DELETED = ("https://open.canada.ca/data/dataset/2916fad5-ebcc-4c86-b0f3-4f619b29f412"
           "/resource/d22d2aca-155b-4978-b5c1-1d39837e1993/download/deleted.csv")
SOURCE = DELETED
KEYS = {
    "title": "Title (English) / Titre (anglais)",
    "french": "Title (French) / Titre (français)",
    "org": "Organization / Organisation",
    "id": "Record ID / Identificateur du dossier",
    "date": "Date and Time Deleted/ Date et heure de suppression",
}
ID = re.compile(r"^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$", re.I)
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def clean(value):
    return " ".join(value.split()) if isinstance(value, str) else ""


def date_only(value):
    text = clean(value)[:10]
    if DATE.fullmatch(text):
        try:
            return datetime.fromisoformat(text).date().isoformat()
        except ValueError:
            pass
    return ""


def download(path):
    for attempt in range(3):
        try:
            req = Request(SOURCE, headers={"User-Agent": "CoolCode static catalogue snapshot builder/1.0"})
            with urlopen(req, timeout=90) as response, path.open("wb") as output:
                shutil.copyfileobj(response, output)
                header = response.headers.get("Last-Modified")
            try:
                return parsedate_to_datetime(header).date().isoformat() if header else ""
            except (ValueError, TypeError):
                return ""
        except OSError as exc:
            if attempt == 2:
                raise ValueError(f"Official download failed after three attempts: {exc}") from exc
            print(f"Download retry {attempt + 1}: {exc}", file=sys.stderr)
            time.sleep(2 ** (attempt + 1))


def write_json(path, data):
    body = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode()
    if path.suffix == ".gz":
        with path.open("wb") as stream, gzip.GzipFile(filename="", mode="wb", fileobj=stream, compresslevel=6, mtime=0) as out:
            out.write(body)
    else:
        path.write_bytes(body)


def graveyard(path):
    with path.open(encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        if not set(KEYS.values()).issubset(reader.fieldnames or []):
            raise ValueError(f"Deletion log columns changed: {reader.fieldnames}")
        for line in reader:
            row = {field: clean(line.get(key)) for field, key in KEYS.items()}
            if not ID.fullmatch(row["id"]):
                continue
            title = row["title"] or row["french"]
            if title:
                # Preserve repeated deletions of an ID, including re-removals.
                day = date_only(row["date"])
                yield [row["id"], title, row["french"], row["org"].split("|")[0].strip(),
                       day, [day[5:7]] if day else [], row["date"], "", 0]


def build(path, stage, updated):
    data = stage / "data"
    data.mkdir()
    shards = []
    rows = list(graveyard(path))
    if len(rows) < 100:
        raise ValueError(f"Only {len(rows)} valid source entries; export appears incomplete.")
    rows.sort(key=lambda x: (x[6], x[0]), reverse=True)
    # Year/org/format labels are derived directly from the same rows as search.
    index = []
    for offset in range(0, len(rows), 12000):
        name = f"index-{len(index)}.json.gz"
        write_json(data / name, rows[offset:offset + 12000])
        index.append(name)
    write_json(data / "manifest.json", {
        "mode": MODE, "count": len(rows), "source": SOURCE, "publisherDate": updated,
        "built": datetime.now(timezone.utc).date().isoformat(), "newest": rows[0][4],
        "index": index, "shards": shards,
    })
    initial = sum((data / name).stat().st_size for name in index)
    print(f"{len(rows):,} entries, {initial / 1024 ** 2:.1f} MiB compressed search index, {len(shards)} detail files")


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--input", type=Path, help="Use a locally saved official export")
    p.add_argument("--output", type=Path, default=ROOT / "dist")
    args = p.parse_args()
    output = args.output.resolve()
    if output == ROOT or output in ROOT.parents or output == ROOT / "web" or (ROOT / "web") in output.parents:
        p.error("Choose a dedicated output directory outside the source web directory.")
    if args.input and args.input.resolve().is_relative_to(output):
        p.error("Keep the local export outside the output directory.")
    try:
        output.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="coolcode-data-", dir=output.parent) as tmp:
            temp = Path(tmp)
            src = args.input or (temp / "source")
            updated = "" if args.input else download(src)
            stage = temp / "site"
            shutil.copytree(ROOT / "web", stage)
            build(src, stage, updated)
            if output.exists():
                shutil.rmtree(output)
            stage.replace(output)
    except (OSError, ValueError, KeyError, csv.Error, EOFError) as exc:
        p.exit(1, f"Build failed: {exc}\n")


if __name__ == "__main__":
    main()
