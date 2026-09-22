"""Command line entry point: `syscode map <path>` and `syscode serve <path>`."""

from __future__ import annotations

import argparse
import os
import sys

from .graph import build_graph, write_graph


def _cmd_map(args: argparse.Namespace) -> int:
    root = os.path.abspath(args.path)
    if not os.path.isdir(root):
        print(f"error: not a directory: {args.path}", file=sys.stderr)
        return 2
    graph = build_graph(root)
    out = write_graph(root, graph)
    counts = {level: 0 for level in range(4)}
    for node in graph["nodes"]:
        counts[node["level"]] = counts.get(node["level"], 0) + 1
    print(f"mapped {graph['project']['name']}: {len(graph['nodes'])} nodes, {len(graph['edges'])} edges")
    print(f"  level 0 external : {counts[0]}")
    print(f"  level 1 container: {counts[1]}")
    print(f"  level 2 component: {counts[2]}")
    print(f"  level 3 artifact : {counts[3]}")
    print(f"wrote {out}")
    return 0


def _cmd_serve(args: argparse.Namespace) -> int:
    root = os.path.abspath(args.path)
    if not os.path.isdir(root):
        print(f"error: not a directory: {args.path}", file=sys.stderr)
        return 2
    graph_file = os.path.join(root, "syscode.graph.json")
    if not os.path.exists(graph_file):
        print(f"error: {graph_file} not found; run `syscode map {args.path}` first", file=sys.stderr)
        return 2
    import uvicorn

    from .server import create_app

    app = create_app(root)
    print(f"SysCode serving {root} on http://{args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="syscode", description="Map a project into a four-level graph and view it.")
    sub = parser.add_subparsers(dest="command", required=True)

    map_parser = sub.add_parser("map", help="read a project folder and write syscode.graph.json")
    map_parser.add_argument("path", help="project folder to map")
    map_parser.set_defaults(func=_cmd_map)

    serve_parser = sub.add_parser("serve", help="serve the graph in the browser")
    serve_parser.add_argument("path", help="project folder that contains syscode.graph.json")
    serve_parser.add_argument("--host", default="127.0.0.1")
    serve_parser.add_argument("--port", type=int, default=8765)
    serve_parser.set_defaults(func=_cmd_serve)
    return parser


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
