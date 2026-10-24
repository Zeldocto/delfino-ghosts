"""Run Moonshine's validate_ghost.py over many files and print one JSON result each.

Usage: python -I oracle.py <path/to/validate_ghost.py> <file>...

The validator is loaded by path rather than copied into this repository (it is
GPL-3.0 and belongs to the Moonshine project). Output per file:
  {"class": "valid"|"invalid"|"unsupported_version"|"unsupported_feature",
   "message": str|None, "result": dict|None}
"""
import importlib.util
import json
import sys


def main() -> int:
    spec = importlib.util.spec_from_file_location("validate_ghost", sys.argv[1])
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    out = {}
    for path in sys.argv[2:]:
        with open(path, "rb") as stream:
            data = stream.read()
        try:
            result = module.validate_ghost(data)
            result["created_unix"] = str(result["created_unix"])
            out[path] = {"class": "valid", "message": None, "result": result}
        except module.UnsupportedVersion as error:
            out[path] = {"class": "unsupported_version", "message": str(error), "result": None}
        except module.UnsupportedFeature as error:
            out[path] = {"class": "unsupported_feature", "message": str(error), "result": None}
        except module.FormatError as error:
            out[path] = {"class": "invalid", "message": str(error), "result": None}
    json.dump(out, sys.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
