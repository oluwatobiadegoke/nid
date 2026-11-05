---
"nid-inbox": patch
---

Read codes and links from broken or hostile HTML quickly. A body with many unclosed tags, many codes or a long run of dots after a link no longer stalls the server. An entity such as `&#99999999;` no longer makes nid refuse the email. An unclosed `<script>` or `<style>` now hides the rest of the body, as a browser does, and a `<` that does not start a tag, as in "in <10 min", stays in the text.
