#!/usr/bin/env python3
"""Convert Table.xlsx into extension/table-library.json with full project fields and task queue."""

import json
import re
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
XLSX = ROOT / "Table.xlsx"
OUT = ROOT / "extension" / "table-library.json"

PROJECT_SHEETS = {
    "TextComparison": 2,
    "OldPhotoLive": 3,
    "GraffitiName": 4,
}

ALL_PROJECTS = list(PROJECT_SHEETS.keys())
DEFAULT_PROJECT = "TextComparison"


def read_workbook(path: Path) -> dict[int, list[list[str]]]:
    with zipfile.ZipFile(path) as zf:
        shared_strings: list[str] = []
        if "xl/sharedStrings.xml" in zf.namelist():
            root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
            ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
            for item in root.findall("m:si", ns):
                parts = []
                for text in item.findall(".//m:t", ns):
                    if text.text:
                        parts.append(text.text)
                shared_strings.append("".join(parts))

        sheets: dict[int, list[list[str]]] = {}
        ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
        for sheet_index in range(1, 7):
            sheet_path = f"xl/worksheets/sheet{sheet_index}.xml"
            if sheet_path not in zf.namelist():
                continue
            sheet = ET.fromstring(zf.read(sheet_path))
            rows: list[list[str]] = []
            for row in sheet.findall("m:sheetData/m:row", ns):
                cells: list[str] = []
                for cell in row.findall("m:c", ns):
                    cell_type = cell.get("t")
                    value = cell.find("m:v", ns)
                    if value is None or value.text is None:
                        cells.append("")
                        continue
                    cells.append(
                        shared_strings[int(value.text)]
                        if cell_type == "s"
                        else value.text
                    )
                rows.append(cells)
            sheets[sheet_index] = rows
    return sheets


def parse_project_fields(rows: list[list[str]]) -> dict[str, str]:
    fields: dict[str, str] = {}
    for row in rows[1:]:
        if not row:
            continue
        key = (row[0] if len(row) > 0 else "").strip()
        value = (row[1] if len(row) > 1 else "").strip()
        if not key or not value:
            continue
        fields[key] = value
    return fields


def first_nonempty(fields: dict[str, str], *keys: str) -> str:
    for key in keys:
        value = fields.get(key, "").strip()
        if value and value.lower() not in {"not specified in the project.", "not specified in the projec"}:
            return value
    return ""


def build_agent_config(project_key: str, fields: dict[str, str]) -> dict:
    name = first_nonempty(fields, "Name")
    url = first_nonempty(fields, "Url", "URL", "Website")
    if url and not url.startswith("http"):
        url = f"https://{url.lstrip('/')}"

    email = first_nonempty(fields, "Business mail", "Feedback mail", "Email")
    title = first_nonempty(fields, "Title", "Name")
    short_desc = first_nonempty(
        fields,
        "Short description(20-30 words)",
        "Short Discription(100-150 words)",
        "Note",
    )
    long_desc = first_nonempty(
        fields,
        "Long description (250-500 words)",
        "Short Discription(150-250 words)",
        "Feature description",
        short_desc,
    )

    return {
        "projectKey": project_key,
        "targetDomain": url,
        "brandName": name,
        "anchorText": title or name,
        "email": email,
        "username": name,
        "commentTemplate": long_desc or short_desc,
        "tags": first_nonempty(fields, "Tags Keywords/Hashtags", "Tags"),
        "pricing": first_nonempty(fields, "Pricing", "Starting Price", "PRICING TYPE"),
        "projectFields": fields,
    }


def normalize_projects(raw: str) -> list[str]:
    aliases = {
        "oldphotolive": "OldPhotoLive",
        "textcomparison": "TextComparison",
        "graffitiname": "GraffitiName",
    }
    projects = []
    for part in raw.split(","):
        token = part.strip()
        if not token:
            continue
        normalized = aliases.get(token.lower(), token)
        if normalized in PROJECT_SHEETS and normalized not in projects:
            projects.append(normalized)
    return projects


def build_tasks(entries: list[dict], projects: dict[str, dict]) -> list[dict]:
    tasks = []
    index = 1
    for entry in entries:
        if entry.get("submitted"):
            continue

        # One visit per URL unless SubmitProject explicitly lists multiple products.
        target_projects = entry.get("projects") or [DEFAULT_PROJECT]
        for project_key in target_projects:
            fields = projects.get(project_key, {})
            if not fields:
                continue

            config = build_agent_config(project_key, fields)
            link = entry.get("indexPage") or entry.get("link")
            if not link:
                continue

            tasks.append(
                {
                    "index": index,
                    "domain": re.sub(r"^www\.", "", link.split("//")[-1].split("/")[0]),
                    "url": link,
                    "platformType": "directory",
                    "projectKey": project_key,
                    "note": entry.get("note", ""),
                    "status": "pending",
                    "config": config,
                }
            )
            index += 1
    return tasks


def main() -> None:
    sheets = read_workbook(XLSX)

    projects = {
        key: parse_project_fields(sheets[sheet_no])
        for key, sheet_no in PROJECT_SHEETS.items()
        if sheet_no in sheets
    }

    entries = []
    for row in sheets.get(1, [])[1:]:
        if not row or not str(row[0]).startswith("http"):
            continue
        entries.append(
            {
                "link": row[0].strip(),
                "projects": normalize_projects(row[1] if len(row) > 1 else ""),
                "submitted": row[2] == "1" if len(row) > 2 else False,
                "note": (row[4] if len(row) > 4 else "").strip(),
                "indexPage": (row[5] if len(row) > 5 else "").strip(),
            }
        )

    tasks = build_tasks(entries, projects)
    payload = {
        "source": "Table.xlsx",
        "projects": projects,
        "entries": entries,
        "tasks": tasks,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    pending_entries = sum(1 for item in entries if not item["submitted"])
    print(
        f"Wrote {len(entries)} entries ({pending_entries} pending), "
        f"{len(tasks)} auto tasks, {len(projects)} project profiles -> {OUT}"
    )


if __name__ == "__main__":
    main()
