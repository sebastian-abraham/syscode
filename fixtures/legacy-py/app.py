"""Flask entry point for the reporting service.

Routes authenticate with the session cookie, build a report through
``reporting`` and stream it back via ``exporters``.
"""
import json
import logging
from datetime import date, timedelta

import redis
from flask import Flask, Response, g, jsonify, redirect, render_template_string, request, session

import auth
import db
import exporters
import reporting
from models import Schedule
from settings import settings

app = Flask(__name__)
app.secret_key = settings.secret_key
logging.basicConfig(level=logging.INFO)


@app.route("/health")
def health():
    return jsonify(ok=db.healthcheck(), env=settings.env)


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "GET":
        return render_template_string("<form method=post><input name=email><input name=password type=password><button>Sign in</button></form>")
    user = auth.verify_user(request.form["email"], request.form["password"])
    if user is None:
        return jsonify(error="invalid credentials"), 401
    session["token"] = auth.create_session(user.id)
    return redirect("/reports/top-products")


@app.route("/logout", methods=["POST"])
def logout():
    token = session.pop("token", None)
    if token:
        auth.destroy_session(token)
    return jsonify(ok=True)


@app.route("/reports/top-products")
@auth.login_required
def top_products():
    limit = int(request.args.get("limit", 10))
    report = reporting.top_products(limit=limit)
    return _serve(report, request.args.get("format", "json"))


@app.route("/reports/sales")
@auth.login_required
def sales():
    end = date.fromisoformat(request.args.get("end", date.today().isoformat()))
    start = date.fromisoformat(request.args.get("start", (end - timedelta(days=30)).isoformat()))
    report = reporting.sales_by_day(start, end)
    return _serve(report, request.args.get("format", "json"))


@app.route("/reports/activity")
@auth.login_required
def activity():
    report = reporting.customer_activity(days=int(request.args.get("days", 30)))
    return _serve(report, request.args.get("format", "json"))


@app.route("/reports/<name>/enqueue", methods=["POST"])
@auth.login_required
def enqueue(name: str):
    payload = json.dumps({"name": name, "params": request.get_json(silent=True) or {}})
    client = redis.from_url(settings.redis_url)
    client.rpush(settings.queue_name, payload)
    return jsonify(queued=True, name=name)


@app.route("/schedules")
@auth.login_required
def schedules():
    due = Schedule.due_today()
    return jsonify([{"id": s.id, "report": s.report_name, "cadence": s.cadence} for s in due])


def _serve(report, fmt: str) -> Response:
    body = exporters.export(report, fmt)
    return Response(body, mimetype=exporters.content_type(fmt))


@app.errorhandler(404)
def not_found(_err):
    return jsonify(error="not found"), 404


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000, debug=settings.debug)
