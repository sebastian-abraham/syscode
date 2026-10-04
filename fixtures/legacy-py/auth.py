"""Authentication for the reporting web app.

Sessions are stored in the ``sessions`` table; passwords are checked with
werkzeug's hashing helpers. The ``login_required`` decorator is what the Flask
routes use.
"""
import functools
import secrets
from datetime import datetime, timedelta
from typing import Callable, Optional

from werkzeug.security import check_password_hash, generate_password_hash

import db
from models import User
from settings import settings


def hash_password(plain: str) -> str:
    return generate_password_hash(plain)


def verify_user(email: str, password: str) -> Optional[User]:
    user = User.find_by_email(email)
    if user is None:
        return None
    if not check_password_hash(user.password_hash, password):
        return None
    return user


def create_session(user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    expires = datetime.utcnow() + timedelta(seconds=settings.session_ttl_seconds)
    db.execute(
        "INSERT INTO sessions (token, user_id, expires_at) VALUES (%s, %s, %s)",
        (token, user_id, expires),
    )
    return token


def resolve_session(token: str) -> Optional[User]:
    row = db.fetch_one(
        "SELECT user_id FROM sessions WHERE token = %s AND expires_at > now()",
        (token,),
    )
    if row is None:
        return None
    return User.find_by_id(row["user_id"])


def destroy_session(token: str) -> None:
    db.execute("DELETE FROM sessions WHERE token = %s", (token,))


def login_required(view: Callable) -> Callable:
    """Decorator for Flask views: attach ``g.user`` or bounce to the login page."""

    @functools.wraps(view)
    def wrapped(*args, **kwargs):
        from flask import g, redirect, request, session

        token = session.get("token")
        user = resolve_session(token) if token else None
        if user is None:
            return redirect("/login")
        g.user = user
        return view(*args, **kwargs)

    return wrapped
