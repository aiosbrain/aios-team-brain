# Third-party licenses

`aios-ingest` is **Apache-2.0** licensed. It imports the following open-source components. All are
permissive (MIT / Apache-2.0 / BSD) and compatible with redistribution under Apache-2.0.

| Component | Purpose | License |
|-----------|---------|---------|
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

This keeps the package cleanly Apache-2.0-redistributable. The `--fail-on` list matters more now
than it did under MIT: this directory is the permissive side of a repository whose default license
is AGPL-3.0-only, and a copyleft dependency arriving here would make its Apache grant
undeliverable. See [`../LICENSING.md`](../LICENSING.md) for the dependency-direction rule.
