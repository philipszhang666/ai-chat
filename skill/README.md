# Local Skill Directory

Put downloaded or local Skills in this directory.

Each Skill should live in its own folder and include a `SKILL.md` file, for example:

```text
skill/
  example-skill/
    SKILL.md
    references/
    scripts/
```

The app scans this directory, adds enabled Skills to the prompt as catalog entries, and reads the full `SKILL.md` only when the model calls `read_skill`.
