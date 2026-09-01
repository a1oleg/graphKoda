from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build
from mcp.server.fastmcp import FastMCP


ENV_PATH = Path(__file__).resolve().parent.parent / '.env'
SCOPES = [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.readonly',
]


def load_settings() -> dict[str, str]:
    load_dotenv(ENV_PATH)

    values = {
        'type': os.getenv('GOOGLE_TYPE') or 'service_account',
        'project_id': os.getenv('GOOGLE_PROJECT_ID'),
        'private_key_id': os.getenv('GOOGLE_PRIVATE_KEY_ID'),
        'private_key': os.getenv('GOOGLE_PRIVATE_KEY'),
        'client_email': os.getenv('GOOGLE_CLIENT_EMAIL'),
        'client_id': os.getenv('GOOGLE_CLIENT_ID'),
        'token_uri': os.getenv('GOOGLE_TOKEN_URI') or 'https://oauth2.googleapis.com/token',
        'auth_uri': os.getenv('GOOGLE_AUTH_URI') or 'https://accounts.google.com/o/oauth2/auth',
        'auth_provider_x509_cert_url': os.getenv('GOOGLE_AUTH_PROVIDER_X509_CERT_URL') or 'https://www.googleapis.com/oauth2/v1/certs',
        'client_x509_cert_url': os.getenv('GOOGLE_CLIENT_X509_CERT_URL'),
        'universe_domain': os.getenv('GOOGLE_UNIVERSE_DOMAIN') or 'googleapis.com',
    }

    missing = [
        name
        for name in [
            'project_id',
            'private_key_id',
            'private_key',
            'client_email',
            'client_id',
            'token_uri',
        ]
        if not values[name]
    ]
    if missing:
        raise RuntimeError(f"Missing required Google service account settings: {', '.join(missing)}")

    values['private_key'] = values['private_key'].replace('\\n', '\n')
    return values


def build_credentials() -> Credentials:
    settings = load_settings()
    info = {
        'type': settings['type'],
        'project_id': settings['project_id'],
        'private_key_id': settings['private_key_id'],
        'private_key': settings['private_key'],
        'client_email': settings['client_email'],
        'client_id': settings['client_id'],
        'auth_uri': settings['auth_uri'],
        'token_uri': settings['token_uri'],
        'auth_provider_x509_cert_url': settings['auth_provider_x509_cert_url'],
        'universe_domain': settings['universe_domain'],
    }
    if settings['client_x509_cert_url']:
        info['client_x509_cert_url'] = settings['client_x509_cert_url']

    return Credentials.from_service_account_info(info, scopes=SCOPES)


class LazyGoogleService:
    def __init__(self, api_name: str, api_version: str) -> None:
        self.api_name = api_name
        self.api_version = api_version
        self.service: Any | None = None

    def __getattr__(self, name: str) -> Any:
        if self.service is None:
            self.service = build(
                self.api_name,
                self.api_version,
                credentials=build_credentials(),
                cache_discovery=False,
            )
        return getattr(self.service, name)


SHEETS_SERVICE = LazyGoogleService('sheets', 'v4')
DRIVE_SERVICE = LazyGoogleService('drive', 'v3')

app = FastMCP(
    name='google-sheets-mcp',
    instructions='Read and update Google Sheets data through a service-account-backed MCP server.',
)


def parse_json_object(value: str, field_name: str) -> dict[str, Any]:
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as error:
        raise ValueError(f'{field_name} must be valid JSON.') from error

    if not isinstance(parsed, dict):
        raise ValueError(f'{field_name} must decode to an object.')

    return parsed


def parse_json_array(value: str, field_name: str) -> list[Any]:
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as error:
        raise ValueError(f'{field_name} must be valid JSON.') from error

    if not isinstance(parsed, list):
        raise ValueError(f'{field_name} must decode to an array.')

    return parsed


def quote_sheet_title(title: str) -> str:
    return f"'{title.replace("'", "''")}'"


def list_sheet_metadata(spreadsheet_id: str) -> list[dict[str, Any]]:
    response = SHEETS_SERVICE.spreadsheets().get(
        spreadsheetId=spreadsheet_id,
        fields='sheets(properties(sheetId,title,index,gridProperties(rowCount,columnCount)))',
    ).execute()
    sheets = response.get('sheets', [])
    ordered = sorted(sheets, key=lambda item: item.get('properties', {}).get('index', 0))

    return [
        {
            'sheetId': sheet['properties']['sheetId'],
            'title': sheet['properties']['title'],
            'index': sheet['properties'].get('index', 0),
            'rowCount': sheet['properties'].get('gridProperties', {}).get('rowCount'),
            'columnCount': sheet['properties'].get('gridProperties', {}).get('columnCount'),
        }
        for sheet in ordered
    ]


def resolve_notation_to_range(spreadsheet_id: str, notation: str) -> dict[str, Any]:
    notation_text = notation.strip()
    if not notation_text:
        raise ValueError('notation must not be empty.')

    if not notation_text.startswith('!'):
        return {
            'notation': notation_text,
            'resolvedRange': notation_text,
            'mode': 'explicit',
        }

    bang_count = 0
    for character in notation_text:
        if character != '!':
            break
        bang_count += 1

    sheets = list_sheet_metadata(spreadsheet_id)
    index = bang_count - 1
    if index < 0 or index >= len(sheets):
        raise ValueError(f'No sheet exists at position {bang_count}.')

    selected_sheet = sheets[index]
    suffix = notation_text[bang_count:]
    quoted_title = quote_sheet_title(selected_sheet['title'])
    resolved_range = quoted_title if not suffix else f'{quoted_title}!{suffix}'

    return {
        'notation': notation_text,
        'resolvedRange': resolved_range,
        'sheetTitle': selected_sheet['title'],
        'sheetIndex': selected_sheet['index'],
        'sheetId': selected_sheet['sheetId'],
        'mode': 'bang-notation',
    }


def read_range(spreadsheet_id: str, range_a1: str, major_dimension: str = 'ROWS') -> dict[str, Any]:
    response = SHEETS_SERVICE.spreadsheets().values().get(
        spreadsheetId=spreadsheet_id,
        range=range_a1,
        majorDimension=major_dimension,
    ).execute()

    return {
        'spreadsheetId': spreadsheet_id,
        'range': response.get('range', range_a1),
        'majorDimension': response.get('majorDimension', major_dimension),
        'values': response.get('values', []),
    }


@app.tool(description='Verify Google Sheets and Drive access using the configured service account.', structured_output=False)
def check_connection() -> dict[str, Any]:
    files = DRIVE_SERVICE.files().list(
        q="mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
        pageSize=5,
        fields='files(id,name)',
        supportsAllDrives=True,
        includeItemsFromAllDrives=True,
    ).execute()

    return {
        'status': 'ok',
        'spreadsheetCountSample': len(files.get('files', [])),
        'spreadsheets': files.get('files', []),
    }


@app.tool(description='List spreadsheets visible to the service account. Optional query uses Drive search syntax.', structured_output=False)
def list_spreadsheets(limit: int = 20, query: str = '') -> dict[str, Any]:
    page_size = max(1, min(limit, 100))
    query_text = query.strip() or "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false"
    response = DRIVE_SERVICE.files().list(
        q=query_text,
        pageSize=page_size,
        fields='files(id,name,webViewLink,createdTime,modifiedTime)',
        supportsAllDrives=True,
        includeItemsFromAllDrives=True,
    ).execute()

    return {
        'files': response.get('files', []),
        'count': len(response.get('files', [])),
        'query': query_text,
    }


@app.tool(description='List sheets in a spreadsheet in their current order.', structured_output=False)
def list_sheets(spreadsheet_id: str) -> dict[str, Any]:
    return {
        'spreadsheetId': spreadsheet_id,
        'sheets': list_sheet_metadata(spreadsheet_id),
    }


@app.tool(description='Resolve chat notation like !, !!A1:G5, or explicit A1 notation into a concrete sheet range.', structured_output=False)
def resolve_chat_notation(spreadsheet_id: str, notation: str) -> dict[str, Any]:
    return resolve_notation_to_range(spreadsheet_id, notation)


@app.tool(description='Read values from a spreadsheet using standard A1 notation.', structured_output=False)
def get_sheet_data(spreadsheet_id: str, range_a1: str, major_dimension: str = 'ROWS') -> dict[str, Any]:
    return read_range(spreadsheet_id, range_a1, major_dimension=major_dimension)


@app.tool(description='Read values from a spreadsheet using chat notation like !A1:Z3 or !!13:13.', structured_output=False)
def get_sheet_data_by_notation(spreadsheet_id: str, notation: str, major_dimension: str = 'ROWS') -> dict[str, Any]:
    resolved = resolve_notation_to_range(spreadsheet_id, notation)
    payload = read_range(spreadsheet_id, resolved['resolvedRange'], major_dimension=major_dimension)
    payload['notation'] = notation
    payload['resolvedRange'] = resolved['resolvedRange']
    if 'sheetTitle' in resolved:
        payload['sheetTitle'] = resolved['sheetTitle']
    return payload


@app.tool(description='Update a target A1 range. values_json must be a JSON 2D array, for example [["A","B"],[1,2]].', structured_output=False)
def update_cells(
    spreadsheet_id: str,
    range_a1: str,
    values_json: str,
    value_input_option: str = 'USER_ENTERED',
) -> dict[str, Any]:
    values = parse_json_array(values_json, 'values_json')
    response = SHEETS_SERVICE.spreadsheets().values().update(
        spreadsheetId=spreadsheet_id,
        range=range_a1,
        valueInputOption=value_input_option,
        body={'values': values},
    ).execute()

    return {
        'spreadsheetId': spreadsheet_id,
        'range': response.get('updatedRange', range_a1),
        'updatedRows': response.get('updatedRows', 0),
        'updatedColumns': response.get('updatedColumns', 0),
        'updatedCells': response.get('updatedCells', 0),
    }


@app.tool(description='Batch update multiple A1 ranges. updates_json must be a JSON array of objects with range and values fields.', structured_output=False)
def batch_update_cells(
    spreadsheet_id: str,
    updates_json: str,
    value_input_option: str = 'USER_ENTERED',
) -> dict[str, Any]:
    updates = parse_json_array(updates_json, 'updates_json')
    normalized_updates: list[dict[str, Any]] = []

    for index, update in enumerate(updates):
        if not isinstance(update, dict):
            raise ValueError(f'updates_json[{index}] must be an object.')
        range_a1 = update.get('range')
        values = update.get('values')
        if not isinstance(range_a1, str) or not range_a1.strip():
            raise ValueError(f'updates_json[{index}].range must be a non-empty string.')
        if not isinstance(values, list):
            raise ValueError(f'updates_json[{index}].values must be an array.')

        normalized_updates.append({
            'range': range_a1,
            'values': values,
        })

    response = SHEETS_SERVICE.spreadsheets().values().batchUpdate(
        spreadsheetId=spreadsheet_id,
        body={
            'valueInputOption': value_input_option,
            'data': normalized_updates,
        },
    ).execute()

    return {
        'spreadsheetId': spreadsheet_id,
        'totalUpdatedSheets': response.get('totalUpdatedSheets', 0),
        'totalUpdatedRows': response.get('totalUpdatedRows', 0),
        'totalUpdatedColumns': response.get('totalUpdatedColumns', 0),
        'totalUpdatedCells': response.get('totalUpdatedCells', 0),
        'responses': response.get('responses', []),
    }


@app.tool(description='Insert empty rows into a sheet before start_index. Indices are zero-based Google Sheets row indices.', structured_output=False)
def insert_rows(spreadsheet_id: str, sheet_id: int, start_index: int, row_count: int = 1) -> dict[str, Any]:
    if row_count < 1:
        raise ValueError('row_count must be at least 1.')

    end_index = start_index + row_count
    SHEETS_SERVICE.spreadsheets().batchUpdate(
        spreadsheetId=spreadsheet_id,
        body={
            'requests': [
                {
                    'insertDimension': {
                        'range': {
                            'sheetId': sheet_id,
                            'dimension': 'ROWS',
                            'startIndex': start_index,
                            'endIndex': end_index,
                        },
                        'inheritFromBefore': start_index > 0,
                    },
                },
            ],
        },
    ).execute()

    return {
        'spreadsheetId': spreadsheet_id,
        'sheetId': sheet_id,
        'startIndex': start_index,
        'rowCount': row_count,
        'status': 'ok',
    }


@app.tool(description='Get lightweight spreadsheet metadata including title and ordered sheet list.', structured_output=False)
def get_spreadsheet_info(spreadsheet_id: str) -> dict[str, Any]:
    response = SHEETS_SERVICE.spreadsheets().get(
        spreadsheetId=spreadsheet_id,
        fields='spreadsheetId,properties(title),sheets(properties(sheetId,title,index,gridProperties(rowCount,columnCount)))',
    ).execute()

    return {
        'spreadsheetId': response['spreadsheetId'],
        'title': response.get('properties', {}).get('title'),
        'sheets': list_sheet_metadata(spreadsheet_id),
    }


def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1] == '--check':
        print(json.dumps(check_connection(), ensure_ascii=True, indent=2))
        return 0

    app.run(transport='stdio')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
