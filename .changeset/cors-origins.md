---
"nid-inbox": minor
---

`--cors` now takes an origin to allow, such as `--cors http://localhost:3000`. Repeat it for more. Before, `--cors` let every website read your mail. Plain `--cors` now stops nid with an error. In code, pass `cors: ['http://localhost:3000']` instead of `cors: true`, and leave `cors` out instead of passing `cors: false`.
