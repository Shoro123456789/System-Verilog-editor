"""SVStudio.exe - starts SV Studio (svstudio.py in the same folder) with the Python runtime that is
built into this exe, so Python doesn't need to be installed. The app's code stays as plain files next
to the exe, which is what lets SV Studio update itself from GitHub.

Built on GitHub Actions with PyInstaller (see .github/workflows/build-exe.yml)."""
import os
import runpy
import sys

# Standard-library modules SV Studio (and slang / the file dialog) use. Importing them here makes
# PyInstaller bundle them, because it only sees this file, not svstudio.py.
import argparse, base64, collections, ctypes, dataclasses, enum, functools, glob, hashlib, html  # noqa
import http.server, importlib, io, json, platform, re, secrets, shlex, shutil, signal, site  # noqa
import socket, ssl, subprocess, tempfile, threading, time, typing, uuid, webbrowser, zipfile  # noqa
import urllib.parse, urllib.request, pathlib, email, mimetypes, queue, traceback, textwrap  # noqa
import tkinter, tkinter.filedialog  # noqa

HERE = os.path.dirname(os.path.abspath(sys.executable if getattr(sys, "frozen", False) else __file__))


def main():
    # "SVStudio.exe -c <code>" runs a snippet (SV Studio uses this for the native file dialog)
    if len(sys.argv) >= 3 and sys.argv[1] == "-c":
        code = sys.argv[2]
        sys.argv = ["-c"] + sys.argv[3:]
        exec(compile(code, "<string>", "exec"), {"__name__": "__main__"})
        return
    app = os.path.join(HERE, "svstudio.py")
    if not os.path.exists(app):
        ctypes.windll.user32.MessageBoxW(None, f"svstudio.py was not found next to SVStudio.exe\n({HERE}).\n\n"
                                         "Keep SVStudio.exe inside the SV Studio folder.", "SV Studio", 0x10)
        return
    sys.path.insert(0, HERE)
    sys.argv = [app] + sys.argv[1:]
    runpy.run_path(app, run_name="__main__")


if __name__ == "__main__":
    main()
