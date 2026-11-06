"""build_explorer.mjs behind the interface of the former Python builder.

test_build_explorer.py keeps its contracts from the Python builder and checks the Node builder through this module.
"""

import base64
import json
from pathlib import Path
import shutil
import subprocess
import sys

BRIDGE = Path(__file__).with_name("build_explorer_bridge.mjs")
NODE = shutil.which("node")
MAX_RESOURCE_BYTES = 20 * 1024 * 1024
MAX_TOTAL_RESOURCE_BYTES = 100 * 1024 * 1024


class ManifestError(ValueError):
    def __init__(self, problems, message):
        self.problems = problems
        super().__init__(message)


ERRORS = {
    "FileExistsError": FileExistsError, "FileNotFoundError": FileNotFoundError,
    "IsADirectoryError": IsADirectoryError, "NotADirectoryError": NotADirectoryError,
    "PermissionError": PermissionError, "OSError": OSError, "TypeError": TypeError,
}


def _call(name, **arguments):
    # Read the limits at call time so patch.object on this module still applies.
    request = {"call": name, "limits": {"maxResourceBytes": MAX_RESOURCE_BYTES, "maxTotalResourceBytes": MAX_TOTAL_RESOURCE_BYTES}, **arguments}
    run = subprocess.run([NODE, str(BRIDGE)], input=json.dumps(request), capture_output=True, text=True, encoding="utf-8")
    if run.stderr:
        sys.stderr.write(run.stderr)
    if run.returncode:
        raise RuntimeError(f"build_explorer_bridge.mjs exited with {run.returncode}")
    reply = json.loads(run.stdout)
    if "error" not in reply:
        return reply["result"]
    error = reply["error"]
    if error["type"] == "ManifestError":
        raise ManifestError(error["problems"], error["message"])
    raise ERRORS.get(error["type"], ValueError)(error["message"])


_constants = _call("constants")
TEMPLATE = Path(_constants["TEMPLATE"])
MARKER = _constants["MARKER"]
PREVIEW_CSP = _constants["PREVIEW_CSP"]


def build(source, output, *, force=False):
    source = [str(item) for item in source] if isinstance(source, list) else str(source)
    return _call("build", source=source, output=str(output), force=force)


def prepare_html(path, interactive=False, root=None, used=None):
    reply = _call("prepare_html", path=str(path), interactive=interactive, used=[str(item) for item in used] if used is not None else None)
    if used is not None:
        used.update(Path(item) for item in reply["used"])
    return reply["content"]


def read_asset(path, used):
    reply = _call("read_asset", path=str(path), used=[str(item) for item in used])
    used.update(Path(item) for item in reply["used"])
    return base64.b64decode(reply["data"])
