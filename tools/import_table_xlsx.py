#!/usr/bin/env python3
"""Convert the Google Sheet XLSX export into the extension's local data files."""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import posixpath
import re
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_XLSX = ROOT / "Table.xlsx"
DEFAULT_OUT = ROOT / "extension" / "table-library.json"

PROJECT_SHEET_ALIASES = {
    "OldPhotoLive": {"oldphotolive", "oldphotoliveai"},
    "RainbowPetAI": {"rainbowpetai"},
    "RspAi": {"rspai"},
    "TextComparison": {"textcomparison", "comparisontext"},
    "GraffitiName": {"graffitiname", "graffitinameai"},
}
LINK_SHEET_ALIASES = {"linksubmit", "links"}
DEFAULT_PROJECT = "TextComparison"
SYNC_PROFILE_IDS = ("OldPhotoLive", "RainbowPetAI", "RspAi")
LOCAL_LOGOS = {
    "OldPhotoLive": ROOT.parent / "oldphotoliveai" / "public" / "brand-icon.png",
    "RainbowPetAI": ROOT.parent / "rainbowPetAi" / "public" / "logo.png",
    "RspAi": ROOT.parent / "RspAi" / "public" / "logo.png",
}

MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
DOC_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"


def normalize_token(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value or "").strip().lower())


def canonical_project_id(value: str) -> str:
    token = normalize_token(value)
    for project_id, aliases in PROJECT_SHEET_ALIASES.items():
        if token in aliases:
            return project_id
    return ""


def column_index(cell_ref: str) -> int:
    letters = re.match(r"[A-Z]+", cell_ref or "")
    if not letters:
        return 0
    result = 0
    for char in letters.group(0):
        result = result * 26 + ord(char) - ord("A") + 1
    return result - 1


def read_workbook(path: Path) -> dict[str, list[list[str]]]:
    """Read cells by workbook sheet name without third-party spreadsheet packages."""
    with zipfile.ZipFile(path) as zf:
        main_ns = {"m": MAIN_NS}
        shared_strings: list[str] = []
        if "xl/sharedStrings.xml" in zf.namelist():
            root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
            for item in root.findall("m:si", main_ns):
                shared_strings.append(
                    "".join(text.text or "" for text in item.findall(".//m:t", main_ns))
                )

        relationship_root = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
        relationships = {
            item.get("Id", ""): item.get("Target", "")
            for item in relationship_root.findall(f"{{{PKG_REL_NS}}}Relationship")
        }
        workbook_root = ET.fromstring(zf.read("xl/workbook.xml"))

        result: dict[str, list[list[str]]] = {}
        for sheet in workbook_root.findall(f".//{{{MAIN_NS}}}sheet"):
            name = sheet.get("name", "")
            relationship_id = sheet.get(f"{{{DOC_REL_NS}}}id", "")
            target = relationships.get(relationship_id, "")
            if not target:
                continue
            normalized_target = target.lstrip("/")
            sheet_path = posixpath.normpath(
                normalized_target
                if normalized_target.startswith("xl/")
                else posixpath.join("xl", normalized_target)
            )
            if sheet_path not in zf.namelist():
                continue

            sheet_root = ET.fromstring(zf.read(sheet_path))
            rows: list[list[str]] = []
            for row in sheet_root.findall("m:sheetData/m:row", main_ns):
                values: list[str] = []
                for cell in row.findall("m:c", main_ns):
                    index = column_index(cell.get("r", ""))
                    while len(values) <= index:
                        values.append("")
                    cell_type = cell.get("t")
                    if cell_type == "inlineStr":
                        value = "".join(
                            text.text or "" for text in cell.findall(".//m:t", main_ns)
                        )
                    else:
                        node = cell.find("m:v", main_ns)
                        raw = node.text if node is not None and node.text is not None else ""
                        if cell_type == "s" and raw:
                            value = shared_strings[int(raw)]
                        else:
                            value = raw
                    values[index] = value
                rows.append(values)
            result[name] = rows
    return result


def find_sheet(
    sheets: dict[str, list[list[str]]], aliases: set[str]
) -> list[list[str]]:
    for name, rows in sheets.items():
        if normalize_token(name) in aliases:
            return rows
    return []


def parse_project_fields(rows: list[list[str]]) -> dict[str, str]:
    fields: dict[str, str] = {}
    for row in rows[1:]:
        key = (row[0] if len(row) > 0 else "").strip()
        value = (row[1] if len(row) > 1 else "").strip()
        if key and value:
            fields[key] = value
    return fields


def usable_value(value: str) -> bool:
    normalized = str(value or "").strip().lower()
    return bool(normalized) and not normalized.startswith("not specified")


def first_nonempty(fields: dict[str, str], *keys: str) -> str:
    for key in keys:
        value = fields.get(key, "").strip()
        if usable_value(value):
            return value
    return ""


def normalize_media_url(value: str, site_url: str) -> str:
    value = str(value or "").strip()
    if not usable_value(value):
        return ""
    value = re.split(r"\s+or\s+", value, maxsplit=1, flags=re.IGNORECASE)[0].strip()
    if value.startswith(("http://", "https://", "data:")):
        return value
    if value.startswith("/") and site_url:
        return urljoin(site_url.rstrip("/") + "/", value)
    return ""


def canonicalize_project_fields(fields: dict[str, str]) -> dict[str, str]:
    result = dict(fields)
    site_url = first_nonempty(result, "Url", "URL", "Website")
    if site_url and not site_url.startswith(("http://", "https://")):
        site_url = f"https://{site_url.lstrip('/')}"
        result["Url"] = site_url

    logo = normalize_media_url(
        first_nonempty(result, "LOGO", "Logo", "logo"), site_url
    )
    featured = normalize_media_url(
        first_nonempty(result, "Featured image", "Featured Image"), site_url
    )
    if logo:
        result["LOGO"] = logo
    if featured:
        result["Featured image"] = featured
    for index in range(1, 5):
        value = normalize_media_url(
            first_nonempty(
                result,
                f"Screenshot {index}",
                f"Screenshot-{index}",
                f"Screenshot_{index}",
            ),
            site_url,
        )
        if value:
            result[f"Screenshot {index}"] = value
            result[f"Screenshot-{index}"] = value
    return result


def build_agent_config(project_key: str, fields: dict[str, str]) -> dict:
    name = first_nonempty(fields, "Name")
    url = first_nonempty(fields, "Url", "URL", "Website")
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
    )
    screenshots = [
        fields.get(f"Screenshot {index}", "") for index in range(1, 5)
    ]
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
        "featuredImage": first_nonempty(fields, "Featured image"),
        "logoUrl": first_nonempty(fields, "LOGO", "Featured image"),
        "screenshots": [value for value in screenshots if value],
        "projectFields": fields,
    }


def normalize_projects(raw: str) -> list[str]:
    projects: list[str] = []
    for part in re.split(r"[,，;；\n]+", str(raw or "")):
        project_id = canonical_project_id(part)
        if project_id and project_id not in projects:
            projects.append(project_id)
    return projects


def valid_url(value: str) -> str:
    value = str(value or "").strip()
    return value if value.startswith(("http://", "https://")) else ""


def destination_key(value: str) -> str:
    parsed = urlparse(value)
    host = parsed.hostname.lower() if parsed.hostname else ""
    if host.startswith("www."):
        host = host[4:]
    path = re.sub(r"/+$", "", parsed.path or "")
    return f"{host}{path}"


def parse_entries(rows: list[list[str]]) -> list[dict]:
    entries = []
    for row in rows[1:]:
        link = valid_url(row[0] if len(row) > 0 else "")
        if not link:
            continue
        entries.append(
            {
                "link": link,
                "projects": normalize_projects(row[1] if len(row) > 1 else ""),
                "submitted": (row[2] if len(row) > 2 else "") == "1",
                "note": (row[4] if len(row) > 4 else "").strip(),
                "indexPage": valid_url(row[5] if len(row) > 5 else ""),
            }
        )
    return entries


def build_tasks(entries: list[dict], projects: dict[str, dict]) -> list[dict]:
    tasks = []
    index = 1
    for entry in entries:
        if entry.get("submitted"):
            continue
        target_projects = entry.get("projects") or [DEFAULT_PROJECT]
        for project_key in target_projects:
            fields = projects.get(project_key, {})
            if not fields:
                continue
            link = entry.get("indexPage") or entry.get("link")
            if not link:
                continue
            tasks.append(
                {
                    "index": index,
                    "domain": re.sub(
                        r"^www\.", "", link.split("//")[-1].split("/")[0]
                    ),
                    "url": link,
                    "platformType": "directory",
                    "projectKey": project_key,
                    "note": entry.get("note", ""),
                    "status": "pending",
                    "config": build_agent_config(project_key, fields),
                }
            )
            index += 1
    return tasks


def file_data_url(path: Path) -> str:
    if not path.is_file():
        return ""
    mime = mimetypes.guess_type(path.name)[0] or "image/png"
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{encoded}"


def build_site_profile(project_id: str, fields: dict[str, str]) -> dict:
    name = first_nonempty(fields, "Name") or project_id
    url = first_nonempty(fields, "Url", "URL", "Website")
    screenshots = [
        fields.get(f"Screenshot {index}", "")
        for index in range(1, 5)
        if fields.get(f"Screenshot {index}", "")
    ]
    title = first_nonempty(fields, "Title", "Name")
    return {
        "id": project_id,
        "name": name,
        "url": url,
        "promoUrl": url,
        "logoUrl": first_nonempty(fields, "LOGO", "Featured image"),
        "logoDataUrl": file_data_url(LOCAL_LOGOS.get(project_id, Path())),
        "media": {"screenshots": screenshots},
        "language": "auto",
        "fields": fields,
        "anchorRules": {
            "brandKeywords": [name] if name else [],
            "urlKeywords": [url] if url else [],
            "naturalExpressions": [title] if title else [],
            "keywordExpressions": [],
            "avoidWords": [],
            "allowExactMatch": False,
        },
        "blogRules": {
            "tone": "helpful",
            "maxLinksPerDraft": 1,
            "preferredAnchor": "natural",
        },
        "targetAudience": first_nonempty(fields, "Target Audience"),
        "valueProposition": first_nonempty(
            fields, "Short description(20-30 words)", "Note"
        ),
        "useCases": [],
        "sellablePoints": [],
        "avoidContent": [],
        "source": "table-sync",
        "updatedAt": datetime.now(timezone.utc).isoformat(),
    }


def write_sync_backup(path: Path, projects: dict[str, dict], entries: list[dict]) -> None:
    profiles = {
        project_id: build_site_profile(project_id, projects[project_id])
        for project_id in SYNC_PROFILE_IDS
        if project_id in projects
    }
    urls = []
    seen = set()
    for entry in entries:
        url = entry.get("indexPage") or entry.get("link")
        if not url:
            continue
        key = url.rstrip("/").lower()
        if key in seen:
            continue
        seen.add(key)
        urls.append(f"{url}|directory")
    active_id = "RspAi" if "RspAi" in profiles else next(iter(profiles), "")
    submission_records = {}
    submitted_at = datetime.now(timezone.utc).isoformat()
    for entry in entries:
        if not entry.get("submitted"):
            continue
        destination_url = entry.get("indexPage") or entry.get("link")
        key = destination_key(destination_url)
        for profile_id in entry.get("projects") or []:
            record_key = f"{key}::{profile_id}"
            submission_records[record_key] = {
                "status": "success",
                "destinationKey": key,
                "destinationUrl": destination_url,
                "profileId": profile_id,
                "profileName": first_nonempty(
                    projects.get(profile_id, {}), "Name"
                )
                or profile_id,
                "submittedAt": submitted_at,
                "confirmedBy": "migration",
                "evidence": "Table.xlsx submitted seed",
                "schemaVersion": 2,
            }
    payload = {
        "format": "externallink-submission-backup",
        "version": 2,
        "exportedAt": datetime.now(timezone.utc).isoformat(),
        "submissionRecords": submission_records,
        "siteAnnotations": {},
        "siteProfiles": profiles,
        "activeSiteId": active_id,
        "selectedSiteIds": [active_id] if active_id else [],
        "urlList": "\n".join(urls),
    }
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, default=DEFAULT_XLSX)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--backup-output", type=Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    sheets = read_workbook(args.input)
    projects: dict[str, dict[str, str]] = {}
    for project_id, aliases in PROJECT_SHEET_ALIASES.items():
        rows = find_sheet(sheets, aliases)
        if rows:
            projects[project_id] = canonicalize_project_fields(
                parse_project_fields(rows)
            )

    entries = parse_entries(find_sheet(sheets, LINK_SHEET_ALIASES))
    tasks = build_tasks(entries, projects)
    payload = {
        "source": args.input.name,
        "projects": projects,
        "entries": entries,
        "tasks": tasks,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    if args.backup_output:
        args.backup_output.parent.mkdir(parents=True, exist_ok=True)
        write_sync_backup(args.backup_output, projects, entries)

    pending_entries = sum(1 for item in entries if not item["submitted"])
    print(
        f"Wrote {len(entries)} entries ({pending_entries} pending), "
        f"{len(tasks)} auto tasks, {len(projects)} project profiles -> {args.output}"
    )


if __name__ == "__main__":
    main()
