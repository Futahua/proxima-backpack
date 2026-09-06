---
id: task-nested
name: Nested frontmatter
status: running
meta:
  id: task-hijacked
  status: review
---
The nested keys must stay nested. Hoisted, "id" and "status" would replace this
record's own — which is exactly what the previous parser did.
