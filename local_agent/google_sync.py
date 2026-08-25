"""Google OAuth and Sheets synchronization helpers for ExternalLink.

The local agent is the only component that handles Google OAuth credentials.
The Chrome extension receives an authorization URL and sync snapshots, but
never receives or stores a refresh token.

The module deliberately imports Google packages lazily.  This keeps the
existing form-agent endpoints usable when the optional Google dependencies
have not been installed yet, and makes the API adapter straightforward to
mock in unit tests.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Optional
from urllib.parse import urlparse


GOOGLE_SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets"
GOOGLE_SCOPES = [GOOGLE_SHEETS_SCOPE]
DEFAULT_GOOGLE_REDIRECT_URI = "http://127.0.0.1:8790/google/auth/callback"
DEFAULT_RECORDS_TAB = "Submission Records"
DEFAULT_LINKS_TAB = "Link Submit"
DEFAULT_META_TAB = "SyncMeta"
SNAPSHOT_FORMAT = "externallink-google-sheet-snapshot"
SUBMISSION_SCHEMA_VERSION = 2
SITE_ANNOTATION_STATUSES = {
    "paid",
    "broken",
    "skip",
    "deleted",
    "needs_login",
    "needs_captcha",
    "can_submit",
}
KNOWN_PROFILE_IDS = {
    "OldPhotoLive",
    "RainbowPetAI",
    "RspAi",
    "TextComparison",
    "GraffitiName",
    "VideoToArticleAI",
}
RECORD_HEADERS = [
    "RecordKey",
    "DestinationKey",
    "DestinationURL",
    "ProfileID",
    "ProfileName",
    "Status",
    "SubmittedAt",
    "ConfirmedBy",
    "Evidence",
    "EvidenceURL",
    "PublicURL",
    "UpdatedAt",
]


class GoogleSyncError(Exception):
    """An actionable Google configuration, OAuth, or Sheets API error."""

    def __init__(self, message: str, *, http_status: int = 503):
        super().__init__(message)
        self.message = message
        self.http_status = http_status


def _env(name: str, default: str = "") -> str:
    return str(os.getenv(name, default) or "").strip()


def configured_sheet_id() -> str:
    """Return the only spreadsheet ID this agent is allowed to access."""
    value = _env("GOOGLE_SHEET_ID")
    if not value:
        raise GoogleSyncError("GOOGLE_SHEET_ID is not configured", http_status=503)
    if not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        raise GoogleSyncError("GOOGLE_SHEET_ID contains invalid characters", http_status=500)
    return value


def validate_sheet_id(requested: Optional[str] = None) -> str:
    """Reject every spreadsheet other than the explicitly configured one."""
    allowed = configured_sheet_id()
    if requested and str(requested).strip() != allowed:
        raise GoogleSyncError("只允许访问配置的 Google Sheet", http_status=403)
    return allowed


def client_secret_path() -> Path:
    """Resolve the OAuth client JSON path and reject repository-local secrets."""
    raw = _env("GOOGLE_OAUTH_CLIENT_FILE")
    if not raw:
        raise GoogleSyncError("GOOGLE_OAUTH_CLIENT_FILE is not configured", http_status=503)
    path = Path(raw).expanduser().resolve()
    if not path.is_file():
        raise GoogleSyncError("Google OAuth client JSON 文件不存在", http_status=503)

    repo_root = Path(__file__).resolve().parents[1]
    try:
        path.relative_to(repo_root)
    except ValueError:
        return path
    raise GoogleSyncError(
        "Google OAuth client JSON 必须放在仓库之外，不能提交到 Git",
        http_status=500,
    )


def token_file_path() -> Path:
    """Resolve the fallback token file path outside the repository."""
    configured = _env("GOOGLE_OAUTH_TOKEN_FILE")
    if configured:
        path = Path(configured).expanduser()
    else:
        app_support = Path.home() / "Library" / "Application Support" / "ExternalLink"
        path = app_support / "google-token.json"
    path = path.resolve()
    repo_root = Path(__file__).resolve().parents[1]
    try:
        path.relative_to(repo_root)
    except ValueError:
        return path
    raise GoogleSyncError(
        "Google OAuth token 文件必须放在仓库之外，不能提交到 Git",
        http_status=500,
    )


def _secure_file_mode(path: Path) -> None:
    """Best-effort restrict a fallback token file to the current user."""
    try:
        path.chmod(stat.S_IRUSR | stat.S_IWUSR)
    except OSError:
        # The keyring remains the preferred store; a platform may reject chmod.
        pass


def _keyring_service() -> str:
    return _env("GOOGLE_TOKEN_KEYRING_SERVICE", "ExternalLink Google OAuth")


def _keyring_account() -> str:
    return _env("GOOGLE_TOKEN_KEYRING_ACCOUNT", "default")


def _load_keyring():
    try:
        import keyring  # type: ignore

        return keyring
    except ImportError:
        return None


class TokenStore:
    """Store authorized-user credentials in keyring, with a secure fallback."""

    def __init__(self, *, keyring_module=None, token_path: Optional[Path] = None):
        self.keyring = keyring_module if keyring_module is not None else _load_keyring()
        self.token_path = token_path or token_file_path()

    def load(self) -> Optional[dict[str, Any]]:
        if self.keyring is not None:
            try:
                raw = self.keyring.get_password(_keyring_service(), _keyring_account())
            except Exception:  # noqa: BLE001 - keyring backend is optional
                raw = None
            if raw:
                try:
                    value = json.loads(raw)
                except (TypeError, ValueError):
                    value = None
                if isinstance(value, dict):
                    return value

        try:
            if self.token_path.is_file():
                value = json.loads(self.token_path.read_text(encoding="utf-8"))
                return value if isinstance(value, dict) else None
        except (OSError, ValueError):
            return None
        return None

    def save(self, value: dict[str, Any]) -> None:
        serialized = json.dumps(value, ensure_ascii=False)
        if self.keyring is not None:
            try:
                self.keyring.set_password(_keyring_service(), _keyring_account(), serialized)
                return
            except Exception:  # noqa: BLE001 - fallback is intentional
                pass

        try:
            self.token_path.parent.mkdir(parents=True, exist_ok=True)
            self.token_path.write_text(serialized + "\n", encoding="utf-8")
            _secure_file_mode(self.token_path)
        except OSError as exc:
            raise GoogleSyncError(f"无法保存 Google OAuth token: {exc}", http_status=500) from exc

    def delete(self) -> None:
        if self.keyring is not None:
            try:
                self.keyring.delete_password(_keyring_service(), _keyring_account())
            except Exception:  # noqa: BLE001 - already disconnected is fine
                pass
        try:
            self.token_path.unlink(missing_ok=True)
        except OSError:
            pass


class OAuthManager:
    """Manage the installed-app OAuth flow and authorized-user credentials."""

    def __init__(self, *, token_store: Optional[TokenStore] = None):
        self.token_store = token_store or TokenStore()
        self.pending: dict[str, Any] = {}

    def status(self) -> dict[str, Any]:
        client_configured = bool(_env("GOOGLE_OAUTH_CLIENT_FILE"))
        sheet_configured = bool(_env("GOOGLE_SHEET_ID"))
        token = self.token_store.load() if (client_configured or sheet_configured) else None
        return {
            "configured": client_configured and sheet_configured,
            "clientConfigured": client_configured,
            "sheetConfigured": sheet_configured,
            "authenticated": bool(token and (token.get("refresh_token") or token.get("token"))),
            "sheetId": _env("GOOGLE_SHEET_ID"),
            "redirectUri": _env("GOOGLE_OAUTH_REDIRECT_URI", DEFAULT_GOOGLE_REDIRECT_URI),
            "scope": GOOGLE_SHEETS_SCOPE,
        }

    def start(self) -> dict[str, str]:
        client_file = client_secret_path()
        redirect_uri = _env("GOOGLE_OAUTH_REDIRECT_URI", DEFAULT_GOOGLE_REDIRECT_URI)
        try:
            from google_auth_oauthlib.flow import Flow  # type: ignore
        except ImportError as exc:
            raise GoogleSyncError(
                "Google OAuth 依赖未安装，请先执行 pip install -r requirements.txt",
                http_status=503,
            ) from exc

        try:
            flow = Flow.from_client_secrets_file(str(client_file), scopes=GOOGLE_SCOPES)
            flow.redirect_uri = redirect_uri
            authorization_url, state = flow.authorization_url(
                access_type="offline",
                prompt="consent",
            )
        except Exception as exc:  # noqa: BLE001 - provider config errors
            raise GoogleSyncError(f"无法启动 Google OAuth: {exc}", http_status=502) from exc

        self.pending[state] = flow
        return {
            "authorizationUrl": authorization_url,
            "authorization_url": authorization_url,
            "authUrl": authorization_url,
            "redirectUri": redirect_uri,
        }

    def complete(self, *, state: str, code: str) -> dict[str, Any]:
        if not state or not code:
            raise GoogleSyncError("Google OAuth callback 缺少 state 或 code", http_status=400)
        flow = self.pending.pop(state, None)
        if flow is None:
            raise GoogleSyncError("Google OAuth state 已失效，请重新连接", http_status=400)
        try:
            flow.fetch_token(code=code)
            credentials = flow.credentials
            serialized = json.loads(credentials.to_json())
            self.token_store.save(serialized)
        except Exception as exc:  # noqa: BLE001 - provider response is user-facing
            raise GoogleSyncError(f"Google OAuth 授权失败: {exc}", http_status=502) from exc
        return {"authenticated": True, "scope": GOOGLE_SHEETS_SCOPE}

    def credentials(self):
        token_data = self.token_store.load()
        if not token_data:
            raise GoogleSyncError("尚未连接 Google，请先完成授权", http_status=401)
        try:
            from google.oauth2.credentials import Credentials  # type: ignore
        except ImportError as exc:
            raise GoogleSyncError(
                "Google OAuth 依赖未安装，请先执行 pip install -r requirements.txt",
                http_status=503,
            ) from exc

        try:
            credentials = Credentials.from_authorized_user_info(token_data, GOOGLE_SCOPES)
            if not credentials.valid:
                if not credentials.expired or not credentials.refresh_token:
                    raise GoogleSyncError("Google OAuth token 已失效，请重新连接", http_status=401)
                from google.auth.transport.requests import Request  # type: ignore

                credentials.refresh(Request())
                self.token_store.save(json.loads(credentials.to_json()))
            return credentials
        except GoogleSyncError:
            raise
        except Exception as exc:  # noqa: BLE001 - auth library details are not safe to expose
            raise GoogleSyncError(f"Google OAuth token 无法使用: {exc}", http_status=401) from exc

    def disconnect(self) -> dict[str, bool]:
        self.pending.clear()
        self.token_store.delete()
        return {"authenticated": False}


def build_sheets_service(oauth: OAuthManager):
    """Build the official Google Sheets API client lazily."""
    try:
        from googleapiclient.discovery import build  # type: ignore
    except ImportError as exc:
        raise GoogleSyncError(
            "Google Sheets 依赖未安装，请先执行 pip install -r requirements.txt",
            http_status=503,
        ) from exc
    try:
        return build("sheets", "v4", credentials=oauth.credentials(), cache_discovery=False)
    except GoogleSyncError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise GoogleSyncError(f"无法初始化 Google Sheets API: {exc}", http_status=502) from exc


def canonical_profile_id(value: Any) -> str:
    raw = str(value or "").strip()
    token = re.sub(r"[^a-z0-9]", "", raw.lower())
    aliases = {
        "oldphotolive": "OldPhotoLive",
        "oldphotoliveai": "OldPhotoLive",
        "rainbowpetai": "RainbowPetAI",
        "rspai": "RspAi",
        "textcomparison": "TextComparison",
        "comparisontext": "TextComparison",
        "graffitiname": "GraffitiName",
        "graffitinameai": "GraffitiName",
        "videotoarticleai": "VideoToArticleAI",
        "videotoarticle": "VideoToArticleAI",
    }
    return aliases.get(token, raw)


def canonical_destination_key(value: Any) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    parsed = urlparse(raw if "://" in raw else f"https://{raw}")
    host = (parsed.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    path = re.sub(r"/+", "/", parsed.path or "").rstrip("/")
    return f"{host}{path}"


def record_key(destination: Any, profile: Any) -> str:
    destination_key = canonical_destination_key(destination)
    profile_id = canonical_profile_id(profile)
    return f"{destination_key}::{profile_id}" if destination_key and profile_id else ""


def _header_map(row: Iterable[Any]) -> dict[str, int]:
    return {
        re.sub(r"[^a-z0-9]", "", str(value or "").strip().lower()): index
        for index, value in enumerate(row)
        if str(value or "").strip()
    }


def _cell(row: list[Any], headers: dict[str, int], *names: str) -> str:
    for name in names:
        index = headers.get(re.sub(r"[^a-z0-9]", "", name.lower()))
        if index is not None and index < len(row):
            return str(row[index] or "").strip()
    return ""


def _quoted_range(title: str, range_name: str) -> str:
    escaped = title.replace("'", "''")
    return f"'{escaped}'!{range_name}"


def _get_values(service, spreadsheet_id: str, title: str, range_name: str = "A:Z") -> list[list[Any]]:
    response = (
        service.spreadsheets()
        .values()
        .get(spreadsheetId=spreadsheet_id, range=_quoted_range(title, range_name))
        .execute()
    )
    values = response.get("values", []) if isinstance(response, dict) else []
    return values if isinstance(values, list) else []


def parse_link_rows(rows: list[list[Any]]) -> list[dict[str, Any]]:
    if not rows:
        return []
    headers = _header_map(rows[0])
    entries: list[dict[str, Any]] = []
    for row in rows[1:]:
        link = _cell(row, headers, "link", "url")
        if not link.startswith(("http://", "https://")):
            continue
        raw_projects = _cell(row, headers, "submitproject", "projects")
        projects = [
            canonical_profile_id(part)
            for part in re.split(r"[,，;；\n]+", raw_projects)
            if str(part).strip()
        ]
        projects = list(dict.fromkeys(project for project in projects if project))
        legacy_submitted = _cell(row, headers, "submit").lower() in {"1", "true", "yes", "是"}
        normalized_status = ""
        for status_field in ("status", "categorystatus"):
            raw_status = _cell(row, headers, status_field)
            candidate_status = re.sub(r"[\s-]+", "_", raw_status.lower())
            if candidate_status in SITE_ANNOTATION_STATUSES:
                normalized_status = candidate_status
                break
        site_annotation = None
        if normalized_status in SITE_ANNOTATION_STATUSES:
            site_annotation = {
                "status": normalized_status,
                "url": link,
                "note": _cell(row, headers, "note"),
                "updatedAt": _cell(row, headers, "updatedat", "updated", "time"),
            }
            # Keep the shape compatible with annotations created by the
            # extension while omitting empty values from the Sheet.
            site_annotation = {
                key: value for key, value in site_annotation.items() if value
            }
        entries.append(
            {
                "link": link,
                "destinationKey": canonical_destination_key(link),
                "projects": projects,
                # Submit is a legacy site-level flag.  It cannot represent
                # per-profile success, so the runtime must use the v2 ledger
                # instead of skipping this destination or seeding new
                # profiles as successful.
                "submitted": False,
                "legacySubmitted": legacy_submitted,
                "time": _cell(row, headers, "time"),
                "note": _cell(row, headers, "note"),
                "indexPage": _cell(row, headers, "indexpage"),
                "siteAnnotation": site_annotation,
            }
        )
    return entries


def parse_profile_rows(rows: list[list[Any]], *, sheet_name: str) -> Optional[dict[str, Any]]:
    if not rows:
        return None
    profile_id = canonical_profile_id(sheet_name)
    headers = _header_map(rows[0])
    has_standard_headers = "field" in headers and "content" in headers
    if not has_standard_headers and profile_id not in KNOWN_PROFILE_IDS:
        return None
    fields: dict[str, str] = {}
    notes: dict[str, str] = {}
    # Some long-lived workbook tabs lost one header cell while retaining the
    # stable three-column Field/Content/Notes layout.  For known project tabs,
    # fall back to columns A/B instead of silently dropping the whole Profile.
    field_index = headers.get("field", 0)
    content_index = headers.get("content", 1)
    notes_index = headers.get("notes")
    for row in rows[1:]:
        if field_index >= len(row):
            continue
        field = str(row[field_index] or "").strip()
        if not field:
            continue
        fields[field] = str(row[content_index] or "").strip() if content_index < len(row) else ""
        if notes_index is not None and notes_index < len(row):
            notes[field] = str(row[notes_index] or "").strip()
    if not fields.get("Name"):
        return None
    return {"id": profile_id or sheet_name.strip(), "name": fields.get("Name") or sheet_name, "fields": fields, "notes": notes}


def parse_record_rows(rows: list[list[Any]]) -> dict[str, dict[str, Any]]:
    if not rows:
        return {}
    headers = _header_map(rows[0])
    records: dict[str, dict[str, Any]] = {}
    for row in rows[1:]:
        key = _cell(row, headers, "recordkey")
        destination_key = _cell(row, headers, "destinationkey")
        destination_url = _cell(row, headers, "destinationurl", "url")
        profile_id = canonical_profile_id(_cell(row, headers, "profileid", "profile"))
        key = key or record_key(destination_key or destination_url, profile_id)
        if not key or not profile_id:
            continue
        records[key] = {
            "recordKey": key,
            "destinationKey": canonical_destination_key(destination_key or destination_url),
            "destinationUrl": destination_url,
            "profileId": profile_id,
            "profileName": _cell(row, headers, "profilename") or profile_id,
            "status": _cell(row, headers, "status") or "queued",
            "submittedAt": _cell(row, headers, "submittedat", "time"),
            "confirmedBy": _cell(row, headers, "confirmedby"),
            "evidence": _cell(row, headers, "evidence"),
            "evidenceUrl": _cell(row, headers, "evidenceurl"),
            "publicUrl": _cell(row, headers, "publicurl", "indexpage"),
            "updatedAt": _cell(row, headers, "updatedat"),
            "schemaVersion": SUBMISSION_SCHEMA_VERSION,
        }
    return records


def snapshot_hash(snapshot: dict[str, Any]) -> str:
    payload = json.dumps(snapshot, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def read_snapshot(service, *, spreadsheet_id: Optional[str] = None) -> dict[str, Any]:
    spreadsheet_id = validate_sheet_id(spreadsheet_id)
    try:
        metadata = (
            service.spreadsheets()
            .get(spreadsheetId=spreadsheet_id, fields="spreadsheetId,properties.title,sheets.properties")
            .execute()
        )
    except Exception as exc:  # noqa: BLE001
        raise GoogleSyncError(f"读取 Google Sheet 失败: {exc}", http_status=502) from exc

    sheets = metadata.get("sheets", []) if isinstance(metadata, dict) else []
    sheet_names = [
        str(item.get("properties", {}).get("title", ""))
        for item in sheets
        if isinstance(item, dict) and item.get("properties", {}).get("title")
    ]
    links_tab = _env("GOOGLE_SHEET_LINKS_TAB", DEFAULT_LINKS_TAB)
    records_tab = _env("GOOGLE_SHEET_RECORDS_TAB", DEFAULT_RECORDS_TAB)
    meta_tab = _env("GOOGLE_SHEET_META_TAB", DEFAULT_META_TAB)
    try:
        links = parse_link_rows(_get_values(service, spreadsheet_id, links_tab)) if links_tab in sheet_names else []
        record_values = _get_values(service, spreadsheet_id, records_tab) if records_tab in sheet_names else []
        records = parse_record_rows(record_values)
        profiles: dict[str, dict[str, Any]] = {}
        ignored = {links_tab, records_tab, meta_tab, "Action Log"}
        for title in sheet_names:
            if title in ignored:
                continue
            profile = parse_profile_rows(_get_values(service, spreadsheet_id, title), sheet_name=title)
            if profile:
                profiles[profile["id"]] = profile
    except Exception as exc:  # noqa: BLE001
        raise GoogleSyncError(f"解析 Google Sheet 数据失败: {exc}", http_status=502) from exc

    projects = {
        profile_id: profile.get("fields", {})
        for profile_id, profile in profiles.items()
        if isinstance(profile, dict)
    }
    entries = []
    site_annotations: dict[str, dict[str, Any]] = {}
    for entry in links:
        destination_key = entry.get("destinationKey", "")
        annotation = entry.get("siteAnnotation")
        if destination_key and isinstance(annotation, dict):
            # If the Sheet contains duplicate rows for a destination, the
            # later row wins just as it does for profile/record tabs.
            site_annotations[destination_key] = annotation
        entries.append(
            {
                "link": entry.get("link", ""),
                "destinationKey": destination_key,
                "projects": entry.get("projects", []),
                "submitted": False,
                "legacySubmitted": bool(entry.get("legacySubmitted")),
                "note": entry.get("note", ""),
                "indexPage": entry.get("indexPage", ""),
            }
        )
    tasks: list[dict[str, Any]] = []
    task_index = 1
    for entry in entries:
        destination_url = entry.get("indexPage") or entry.get("link")
        for profile_id in entry.get("projects", []):
            if profile_id not in projects or not destination_url:
                continue
            parsed = urlparse(destination_url)
            tasks.append(
                {
                    "index": task_index,
                    "domain": (parsed.hostname or "").removeprefix("www."),
                    "url": destination_url,
                    "platformType": "directory",
                    "projectKey": profile_id,
                    "note": entry.get("note", ""),
                    "status": "pending",
                }
            )
            task_index += 1

    table_data = {"entries": entries, "projects": projects, "tasks": tasks}
    revision = snapshot_hash(
        {
            "spreadsheetId": spreadsheet_id,
            "tableData": table_data,
            "submissionRecords": records,
            "siteAnnotations": site_annotations,
        }
    )
    snapshot = {
        "format": SNAPSHOT_FORMAT,
        "schemaVersion": SUBMISSION_SCHEMA_VERSION,
        "submissionSchemaVersion": SUBMISSION_SCHEMA_VERSION,
        "spreadsheetId": spreadsheet_id,
        "spreadsheetTitle": metadata.get("properties", {}).get("title", "") if isinstance(metadata, dict) else "",
        "revision": revision,
        "hash": revision,
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
        "tableData": table_data,
        "submissionRecords": records,
        "siteAnnotations": site_annotations,
        "conflicts": [],
        # Retain these aliases for future agent clients that used the first
        # draft of the local API; the extension consumes tableData above.
        "links": links,
        "profiles": profiles,
        "sheetNames": sheet_names,
    }
    return snapshot


def _record_rank(record: dict[str, Any]) -> tuple[int, int, int]:
    status = str(record.get("status", "")).lower()
    evidence = bool(str(record.get("evidence", "")).strip() or str(record.get("evidenceUrl", "")).strip())
    confirmed = str(record.get("confirmedBy", "")).lower() in {"agent", "manual", "migration"}
    return (1 if status == "success" else 0, 1 if evidence else 0, 1 if confirmed else 0)


def merge_success_records(existing: dict[str, dict[str, Any]], incoming: Iterable[dict[str, Any]]) -> tuple[dict[str, dict[str, Any]], list[str], list[str]]:
    """Merge only explicit success records without downgrading stronger evidence."""
    merged = dict(existing or {})
    applied: list[str] = []
    already: list[str] = []
    for raw in incoming:
        if not isinstance(raw, dict):
            continue
        status = str(raw.get("status", "")).lower()
        if status != "success":
            continue
        destination = raw.get("destinationKey") or raw.get("destinationUrl") or raw.get("url")
        profile = raw.get("profileId") or raw.get("profileName")
        derived_key = record_key(destination, profile)
        key = derived_key or str(raw.get("recordKey") or "").strip()
        candidate_destination_key = canonical_destination_key(destination)
        if not key or not candidate_destination_key or not canonical_profile_id(profile):
            continue
        candidate = {
            "recordKey": key,
            "destinationKey": candidate_destination_key,
            "destinationUrl": str(raw.get("destinationUrl") or raw.get("url") or "").strip(),
            "profileId": canonical_profile_id(profile),
            "profileName": str(raw.get("profileName") or profile or "").strip(),
            "status": "success",
            "submittedAt": str(raw.get("submittedAt") or "").strip(),
            "confirmedBy": str(raw.get("confirmedBy") or "").strip(),
            "evidence": str(raw.get("evidence") or "").strip(),
            "evidenceUrl": str(raw.get("evidenceUrl") or "").strip(),
            "publicUrl": str(raw.get("publicUrl") or "").strip(),
            "updatedAt": str(raw.get("updatedAt") or "").strip(),
            "schemaVersion": SUBMISSION_SCHEMA_VERSION,
        }
        old = merged.get(key)
        if old and _record_rank(old) >= _record_rank(candidate):
            already.append(key)
            continue
        merged[key] = {**(old or {}), **candidate}
        applied.append(key)
    return merged, applied, already


def _records_to_rows(records: dict[str, dict[str, Any]]) -> list[list[str]]:
    rows: list[list[str]] = []
    for key in sorted(records):
        record = records[key]
        rows.append([
            key,
            str(record.get("destinationKey", "")),
            str(record.get("destinationUrl", "")),
            str(record.get("profileId", "")),
            str(record.get("profileName", "")),
            str(record.get("status", "")),
            str(record.get("submittedAt", "")),
            str(record.get("confirmedBy", "")),
            str(record.get("evidence", "")),
            str(record.get("evidenceUrl", "")),
            str(record.get("publicUrl", "")),
            str(record.get("updatedAt", "")),
        ])
    return rows


def _ensure_sheet(service, spreadsheet_id: str, title: str, existing_names: Optional[set[str]] = None) -> None:
    if existing_names is not None and title in existing_names:
        return
    try:
        service.spreadsheets().batchUpdate(
            spreadsheetId=spreadsheet_id,
            body={"requests": [{"addSheet": {"properties": {"title": title}}}]},
        ).execute()
    except Exception as exc:  # noqa: BLE001
        # A concurrent caller may have created the tab; fetch/read will decide
        # whether the subsequent update can proceed.
        if "already exists" not in str(exc).lower():
            raise GoogleSyncError(f"无法创建 Google Sheet 子表: {exc}", http_status=502) from exc


def push_ledger(service, *, records: Iterable[dict[str, Any]], spreadsheet_id: Optional[str] = None, base_hash: str = "") -> dict[str, Any]:
    spreadsheet_id = validate_sheet_id(spreadsheet_id)
    current = read_snapshot(service, spreadsheet_id=spreadsheet_id)
    merged, applied, already = merge_success_records(current.get("submissionRecords", {}), records)
    records_tab = _env("GOOGLE_SHEET_RECORDS_TAB", DEFAULT_RECORDS_TAB)
    names = set(current.get("sheetNames", []))
    _ensure_sheet(service, spreadsheet_id, records_tab, names)
    values = [RECORD_HEADERS, *_records_to_rows(merged)]
    try:
        (
            service.spreadsheets()
            .values()
            .update(
                spreadsheetId=spreadsheet_id,
                range=_quoted_range(records_tab, f"A1:L{max(1, len(values))}"),
                valueInputOption="USER_ENTERED",
                body={"values": values},
            )
            .execute()
        )
    except Exception as exc:  # noqa: BLE001
        raise GoogleSyncError(f"回写 Google Sheet 失败: {exc}", http_status=502) from exc
    return {
        "spreadsheetId": spreadsheet_id,
        "applied": applied,
        "alreadyApplied": already,
        "pushedKeys": [*applied, *already],
        "conflict": bool(base_hash and base_hash != current.get("hash")),
        "remoteHash": current.get("hash", ""),
        "records": merged,
    }


def read_snapshot_for_oauth(oauth: OAuthManager, *, spreadsheet_id: Optional[str] = None) -> dict[str, Any]:
    """Authenticate and read one configured spreadsheet snapshot."""
    service = build_sheets_service(oauth)
    return read_snapshot(service, spreadsheet_id=spreadsheet_id)


def push_ledger_for_oauth(
    oauth: OAuthManager,
    *,
    records: Iterable[dict[str, Any]],
    spreadsheet_id: Optional[str] = None,
    base_hash: str = "",
) -> dict[str, Any]:
    """Authenticate and push explicit success records to the records tab."""
    service = build_sheets_service(oauth)
    return push_ledger(
        service,
        records=records,
        spreadsheet_id=spreadsheet_id,
        base_hash=base_hash,
    )


def build_sync_diff(local_snapshot: Optional[dict[str, Any]], remote_snapshot: dict[str, Any]) -> dict[str, Any]:
    """Build a small, explicit pull preview for the extension UI."""
    local = local_snapshot if isinstance(local_snapshot, dict) else {}
    local_table = local.get("tableData") if isinstance(local.get("tableData"), dict) else local
    remote_table = (
        remote_snapshot.get("tableData")
        if isinstance(remote_snapshot.get("tableData"), dict)
        else remote_snapshot
    )
    local_profiles = (
        local.get("siteProfiles")
        if isinstance(local.get("siteProfiles"), dict)
        else local_table.get("projects")
        if isinstance(local_table.get("projects"), dict)
        else {}
    )
    remote_profiles = (
        remote_table.get("projects")
        if isinstance(remote_table.get("projects"), dict)
        else {}
    )
    local_links = local_table.get("entries") if isinstance(local_table.get("entries"), list) else []
    remote_links = remote_table.get("entries") if isinstance(remote_table.get("entries"), list) else []
    local_records = local.get("submissionRecords") if isinstance(local.get("submissionRecords"), dict) else {}
    remote_records = remote_snapshot.get("submissionRecords") if isinstance(remote_snapshot.get("submissionRecords"), dict) else {}
    profile_changes = [key for key in remote_profiles if local_profiles.get(key) != remote_profiles.get(key)]
    link_by_key = {item.get("destinationKey") or canonical_destination_key(item.get("link")): item for item in local_links if isinstance(item, dict)}
    link_changes = [item.get("destinationKey") for item in remote_links if isinstance(item, dict) and link_by_key.get(item.get("destinationKey")) != item]
    record_changes = [key for key in remote_records if local_records.get(key) != remote_records.get(key)]
    return {
        "profilesChanged": profile_changes,
        "linksChanged": [key for key in link_changes if key],
        "recordsChanged": record_changes,
        "remoteOnlySuccesses": [key for key in remote_records if remote_records[key].get("status") == "success" and local_records.get(key, {}).get("status") != "success"],
    }
