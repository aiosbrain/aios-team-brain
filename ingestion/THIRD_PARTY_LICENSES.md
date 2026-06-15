# Third-party licenses

`aios-ingest` is MIT-licensed. It imports the following open-source components. All are
permissive (MIT / Apache-2.0 / BSD) and compatible with redistribution under MIT.

| Component | Purpose | License |
|-----------|---------|---------|
| llama-index-readers-github | GitHub reader (optional alternative path) | MIT |
| llama-index-readers-slack | Slack reader | MIT |
| llama-index-readers-google | Google Drive reader | MIT |
| llama-index-readers-notion | Notion reader | MIT |
| llama-index-readers-confluence | Confluence reader | MIT |
| llama-index-core (transitive) | reader runtime | MIT |
| unstructured | binary/document text extraction | Apache-2.0 |
| httpx | HTTP client | BSD-3-Clause |
| pydantic | payload validation | MIT |
| fastapi | webhook receiver | MIT |
| uvicorn | ASGI server | BSD-3-Clause |
| click | CLI | BSD-3-Clause |
| apscheduler | scheduled polling | MIT |
| PyYAML | connections config | MIT |

## License-hygiene policy

Some LlamaHub readers pull transitive dependencies with varied licenses. Before vendoring a
new reader, run the audit and **reject any copyleft (GPL/AGPL/LGPL) or source-available
(ELv2/Elastic/SSPL) dependency** — those must stay behind a network boundary, never imported:

```bash
uv pip install '.[all,dev]'
uv run pip-licenses --format=markdown \
  --fail-on 'GPL;AGPL;LGPL;Server Side Public License;Elastic License'
```

This keeps the package cleanly MIT-redistributable.
