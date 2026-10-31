"""One SIDECAR PROCESS for the two-process test (AIO-1167; accepted spec: separate sidecar processes).

Not a test module (pytest collects only ``test_*``). Run as its own OS process:

    python two_process_sidecar_driver.py '<json config>'

It runs the REAL coordinator (`run_gdrive_stream`) with the REAL `BrainClient` over HTTP against the
brain URL it is given, with its OWN SQLite state file. Only Google is a fake, and it sits behind the
real `GoogleDriveSource` request path, so every provider call passes the brain's real
`authorize_provider` check first. Optionally it PAUSES inside one document's revision-history read —
after that read's authority check — until a resume file appears, so the test can replace its lease
mid-run. Prints one JSON line: the run's summary.
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path

from aios_ingest.config import BrainSettings, Connection
from aios_ingest.gdrive_sync import run_gdrive_stream
from aios_ingest.sources import gdrive as gdrive_source
from aios_ingest.state import StateStore

DOC_MIME = "application/vnd.google-apps.document"


def main(config: dict) -> None:
    docs = list(config["docs"])
    drive_id = config["drive_id"]
    pause_doc = config.get("pause_doc")
    pause_marker = Path(config["pause_marker"]) if config.get("pause_marker") else None
    resume_marker = Path(config["resume_marker"]) if config.get("resume_marker") else None

    class Request:
        def __init__(self, value, before=None):
            self.value, self.before = value, before

        def execute(self, **_kwargs):
            if self.before:
                self.before()
            return self.value

    def wait_for_resume() -> None:
        pause_marker.write_text("paused")
        deadline = time.monotonic() + 60
        while not resume_marker.exists():
            if time.monotonic() > deadline:
                raise RuntimeError("never resumed")
            time.sleep(0.02)

    def metadata(file_id: str) -> dict:
        return {"id": file_id, "name": f"Doc {file_id}", "mimeType": DOC_MIME, "driveId": drive_id,
                "parents": [drive_id], "modifiedTime": "2026-10-30T00:00:00Z"}

    class Files:
        def list(self, **_kwargs):
            return Request({"files": [metadata(doc) for doc in docs]})

        def get(self, **kwargs):
            return Request(metadata(kwargs["fileId"]))

    class Revisions:
        def list(self, **kwargs):
            before = wait_for_resume if pause_doc and kwargs.get("fileId") == pause_doc else None
            return Request({"revisions": []}, before)

    class Changes:
        def getStartPageToken(self, **_kwargs):
            return Request({"startPageToken": f"start:{drive_id}"})

        def list(self, **_kwargs):
            return Request({"changes": [], "newStartPageToken": f"terminal:{drive_id}"})

    class Drive:
        def files(self): return Files()
        def revisions(self): return Revisions()
        def changes(self): return Changes()

    class Documents:
        def get(self, **kwargs):
            return Request({"title": f"Doc {kwargs['documentId']}", "tabs": [{
                "tabProperties": {"tabId": "root", "title": "Root"},
                "documentTab": {"body": {"content": [
                    {"paragraph": {"elements": [{"textRun": {"content": f"body of {kwargs['documentId']}\n"}}]}},
                ]}},
            }]})

    class Docs:
        def documents(self): return Documents()

    class Source(gdrive_source.GoogleDriveSource):
        """The REAL source — gate, token provider, request path, extraction — over fake services."""

        def __init__(self, **kwargs):
            super().__init__(**{**kwargs, "_drive_service": Drive(), "_docs_service": Docs(),
                                "provider_retry_attempts": 1})

    import aios_ingest.gdrive_sync as coordinator

    coordinator.GoogleDriveSource = Source
    state = StateStore(config["state_path"])
    settings = BrainSettings(config["brain_url"], "aios_sidecarkey_testsecret", "team")
    connection = Connection("docs", "gdrive", options={"integration_id": config["integration_id"]}, project="docs")
    summary = asyncio.run(run_gdrive_stream(settings, connection, state))
    state.close()
    print(json.dumps({
        "created": summary.created, "updated": summary.updated, "unchanged": summary.unchanged,
        "failed": summary.failed, "failure_categories": summary.failure_categories,
        "authoritative_complete": summary.authoritative_complete,
    }))


if __name__ == "__main__":
    main(json.loads(sys.argv[1]))
