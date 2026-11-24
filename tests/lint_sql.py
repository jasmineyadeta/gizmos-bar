"""Fail if a function would UPDATE or DELETE without a WHERE clause.
The live site's database requests run with pg_safeupdate, which rejects those
(that's what broke "Reset leaderboard"). Write `where true` to mean every row."""
import re, sys
sql = open(sys.argv[1]).read()
bad = []
for body in re.findall(r"\$\$(.*?)\$\$", sql, re.S):
    for stmt in re.split(r";", body):
        s = re.sub(r"--[^\n]*", "", stmt).strip()
        m = re.search(r"(?is)\b(delete\s+from\s+\S+|update\s+\S+\s+set\b)(.*)", s)
        if m and not re.search(r"(?i)\bwhere\b", m.group(2)):
            bad.append(" ".join((m.group(1) + m.group(2)).split())[:120])
if bad:
    print("UPDATE/DELETE without WHERE inside a function (add `where true`):")
    print("\n".join("  " + b for b in bad))
    sys.exit(1)
print("SQL lint ok")
