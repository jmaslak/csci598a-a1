#!/usr/bin/env python3
"""Wrap composer.html as a standalone document in serve/index.html.

composer.html is authored for the Artifact host, which supplies the
<!doctype>/<head>/<body> skeleton. Running locally needs a complete document.
"""
import pathlib

src = pathlib.Path("composer.html")
out = pathlib.Path("serve/index.html")
out.parent.mkdir(exist_ok=True)

head = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width,initial-scale=1">\n')
s = src.read_text(encoding="utf-8")
s = s.replace("<title>", head + "<title>", 1)
s = s.replace("</style>", "</style>\n</head>\n<body>", 1)
out.write_text(s + "\n</body>\n</html>\n", encoding="utf-8")
print(f"built {out} ({out.stat().st_size} bytes)")
