"""Tiny local FastAPI server for the viewer.

Endpoints:
  GET  /             the self-contained viewer page
  GET  /api/graph    the graph json
  POST /api/layout   merge positions into the layout section only
"""

from __future__ import annotations

import json
import os
import threading
from typing import Any, Dict

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse

WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")

_lock = threading.Lock()


def _graph_path(project_root: str) -> str:
    return os.path.join(project_root, "syscode.graph.json")


def _viewer_html() -> str:
    with open(os.path.join(WEB_DIR, "index.html"), "r", encoding="utf-8") as fh:
        return fh.read()


def create_app(project_root: str) -> FastAPI:
    root = os.path.abspath(project_root)
    app = FastAPI(title="SysCode", docs_url=None, redoc_url=None)

    @app.get("/", response_class=HTMLResponse)
    def index() -> HTMLResponse:
        return HTMLResponse(_viewer_html())

    @app.get("/api/graph")
    def get_graph() -> JSONResponse:
        path = _graph_path(root)
        if not os.path.exists(path):
            raise HTTPException(status_code=404, detail="syscode.graph.json not found; run `syscode map` first")
        with open(path, "r", encoding="utf-8") as fh:
            return JSONResponse(json.load(fh))

    @app.post("/api/layout")
    async def post_layout(request: Request) -> JSONResponse:
        try:
            body: Dict[str, Any] = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="invalid json body")
        if not isinstance(body, dict):
            raise HTTPException(status_code=400, detail="body must be an object")

        incoming = body.get("layout", body.get("positions", body))
        if not isinstance(incoming, dict):
            raise HTTPException(status_code=400, detail="layout must be an object")

        path = _graph_path(root)
        with _lock:
            if not os.path.exists(path):
                raise HTTPException(status_code=404, detail="syscode.graph.json not found")
            with open(path, "r", encoding="utf-8") as fh:
                graph = json.load(fh)
            layout = graph.get("layout")
            if not isinstance(layout, dict):
                layout = {}
            for node_id, position in incoming.items():
                if not isinstance(position, dict):
                    continue
                entry = layout.get(node_id)
                if not isinstance(entry, dict):
                    entry = {}
                for key in ("x", "y", "collapsed"):
                    if key in position:
                        entry[key] = position[key]
                layout[node_id] = entry
            graph["layout"] = layout
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(graph, fh, indent=2, ensure_ascii=False)
                fh.write("\n")
        return JSONResponse({"ok": True, "layout": layout})

    return app
