# ADR-011: JSON file formats instead of YAML

Decision: `hub.json`, `toolkit.json`, `hub.lock.json`, registry entries and stages are JSON. DATA-MODEL.md shows the same fields in YAML; field names are unchanged.
Why: no YAML parser dependency (ADR-010); JSON is validated by the platform; SKILL.md front matter needs only `key: value` and folded blocks, handled by a 25-line reader.
Consequence: no comments in config files. If that hurts, add JSONC or a vetted YAML parser as a dependency by a new ADR.
