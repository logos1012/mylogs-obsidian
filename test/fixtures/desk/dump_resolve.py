# Produces python-resolve.json. Run against a SCRATCH copy of the vault build script (never the vault):
#   python3 -I dump_resolve.py <scratch>/03 Desk Calendar/_build/build_desk_calendar.py > python-resolve.json
# new_month/*.md were produced with: python3 -I <scratch>/_build/new_month.py --month YYYY-MM --stdout (today 2026-10-24 KST).
import sys, json, importlib.util, datetime as dt
spec = importlib.util.spec_from_file_location("b", sys.argv[1])
b = importlib.util.module_from_spec(spec); spec.loader.exec_module(b)
months = b.load_all()
idx = b.day_index(months)
widx = b.week_alloc_index(months)
out = {}
for key, data in months.items():
    y, m = data["year"], data["month"]
    c = b.count_items(data)
    issues = list(data["issues"])
    week_summ = []
    allocs = []
    for monday in b.week_mondays(y, m):
        w = data["weeks"].get(monday)
        if w and w.get("alloc") is not None and monday.month == m:
            week_summ.append(b.week_alloc_stats(w)[1])
        if w and w.get("alloc"):
            for it in w["alloc"]:
                r = b.resolve_alloc(it, idx)
                for d in r["missing"]:
                    issues.append({"line": it["line"], "why": "missing"})
                allocs.append({"line": it["line"], "text": it["text"], "state": r["state"],
                    "targets": [[d.isoformat(), x["status"] if x else None] for d, x in r["targets"]],
                    "missing": [d.isoformat() for d in r["missing"]]})
    during = []
    for it in data["during"]:
        r = b.resolve_during(it, widx, idx)
        during.append({"line": it["line"], "text": it["text"], "state": r["state"],
            "targets": [[no, x["line"] if x else None] for no, x in r["targets"]], "missing": r["missing"]})
    out[key] = {"counts": {k: c[k] for k in ("scheduled","done","moved","cancelled","total","test")},
        "unassigned": sum(week_summ), "issues": len(issues), "alloc": allocs, "during": during,
        "focus": [{"id": f["id"], "title": f["title"], "note": f["note"]} for f in data["focus"]]}
print(json.dumps(out, ensure_ascii=False, indent=1))
