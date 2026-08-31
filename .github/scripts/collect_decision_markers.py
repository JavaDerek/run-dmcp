"""Find `DECISION(#N):` markers ADDED by a push, as JSON on stdout.

Reads a unified diff on stdin and emits one object per newly added marker:
`{"issue": 21, "file": "src/timeline/schema.ts", "statement": "..."}`.

Lives in its own file rather than inline in the workflow because an earlier
version WAS inline, and its first line sat at column 0 inside a YAML block
scalar -- which silently ended the scalar and made the whole workflow
unparseable. A script that a workflow calls can be run, and was.

Two deliberate omissions:

  * Deleted markers are ignored. `src/__tests__/deferredDecisions.test.ts`
    guards against a marker disappearing, and announcing a deletion here
    would be reporting a decision that no longer exists.
  * Nothing is judged. This reports that a decision was recorded and where.
    Whether it changes an issue's status is for a reader to say -- the same
    record-never-adjudicate rule the engine itself follows.
"""

import json
import re
import sys

# `DECISION(#N):` then the statement, which the test file requires to be
# complete on this one line. A literal match on a token this codebase
# defines, in output this codebase generated -- never an attempt to read
# meaning (root CLAUDE.md hard rule 4).
MARKER = re.compile(r"DECISION\(#(\d+)\):\s*(.+?)\s*$")

# `+++ b/<path>` in a unified diff names the file whose added lines follow.
FILE_HEADER = "+++ b/"


def collect(diff_lines):
    path = None
    found = []
    for raw in diff_lines:
        line = raw.rstrip("\n")
        if line.startswith(FILE_HEADER):
            path = line[len(FILE_HEADER) :]
            continue
        # `+++` is a header, not an addition; checking it before the `+`
        # test would misread every file header as content.
        if line.startswith("+++") or not line.startswith("+"):
            continue
        match = MARKER.search(line)
        if match and path:
            found.append(
                {"issue": int(match.group(1)), "file": path, "statement": match.group(2)}
            )

    # One entry per (issue, file, statement): a marker reformatted across two
    # commits in the same push would otherwise be announced twice.
    seen = set()
    unique = []
    for item in found:
        key = (item["issue"], item["file"], item["statement"])
        if key not in seen:
            seen.add(key)
            unique.append(item)
    return unique


if __name__ == "__main__":
    json.dump(collect(sys.stdin), sys.stdout)
    sys.stdout.write("\n")
