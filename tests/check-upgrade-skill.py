"""Check an assembled openclaw-upgrade skill: frontmatter, script syntax, links and anchors.

    check-upgrade-skill.py <skill dir>
"""
import ast
import pathlib
import re
import subprocess
import sys

root = pathlib.Path(sys.argv[1])
problems = []

front = (root / "SKILL.md").read_text(encoding="utf8").split("---")[1]
if not re.search(r"^name: openclaw-upgrade$", front, re.M):
    problems.append("SKILL.md: frontmatter name is not openclaw-upgrade")
if not re.search(r"^description: .+", front, re.M):
    problems.append("SKILL.md: no description")
if not (root / "references/host.md").is_file():
    problems.append("references/host.md is missing")

for script in sorted((root / "scripts").iterdir()):
    if script.suffix == ".py":
        try:
            ast.parse(script.read_text(encoding="utf8"))
        except SyntaxError as error:
            problems.append(f"{script.name}: {error}")
    elif script.suffix in (".sh", ".env"):
        result = subprocess.run(["bash", "-n", str(script)], capture_output=True, text=True)
        if result.returncode:
            problems.append(f"{script.name}: {result.stderr.strip()}")


def slug(heading):
    text = re.sub(r"[^\w\s-]", "", heading.strip().lower())
    return re.sub(r"\s+", "-", text)


def anchors(path):
    return {slug(m.group(1)) for m in re.finditer(r"^#+\s+(.+)$", path.read_text(encoding="utf8"), re.M)}


for doc in sorted(root.rglob("*.md")):
    for target in re.findall(r"\]\(([^)\s]+)\)", doc.read_text(encoding="utf8")):
        if re.match(r"[a-z]+:", target):
            continue
        file, _, anchor = target.partition("#")
        path = (doc.parent / file).resolve() if file else doc
        if not path.exists():
            problems.append(f"{doc.relative_to(root)}: broken link {target}")
        elif anchor and path.suffix == ".md" and anchor not in anchors(path):
            problems.append(f"{doc.relative_to(root)}: no heading for {target}")

for problem in problems:
    print(problem)
print(f"openclaw-upgrade skill: {len(problems)} problems")
sys.exit(1 if problems else 0)
